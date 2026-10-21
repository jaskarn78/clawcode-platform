import { describe, it, expect, vi } from "vitest";
import {
  registerRatelimitMonitorCron,
  parseAccountReadWriteRow,
  RATELIMIT_MONITOR_CRON_PATTERN,
  RATELIMIT_MONITOR_DEFAULTS,
  type RatelimitMonitorCronDeps,
  type RatelimitMonitorCronFactory,
} from "../ratelimit-monitor-cron.js";

/**
 * INC-2026-08-08 — the 1Password account cap (1,000 reads/24h, shared across
 * every service account) was drained to exhaustion twice in one morning with
 * no alarm. This monitor is the detection half of the fix, so its landmines
 * are pinned here: croner construction/tick guards (INC-2026-06-04) and the
 * dedup/cooldown behaviour copied from MemoryGuard.
 */

// Real `op service-account ratelimit` output, captured from the fleet host.
const REAL_OUTPUT = `TYPE       ACTION        LIMIT    USED    REMAINING    RESET
token      write         100      0       100          N/A
token      read          1000     5       995          38 minutes from now
account    read_write    1000     950     50           23 hours from now`;

interface StubCron {
  pattern: string;
  stopped: boolean;
  trigger: () => Promise<void>;
}

function makeStubCronFactory(): {
  factory: RatelimitMonitorCronFactory;
  crons: StubCron[];
} {
  const crons: StubCron[] = [];
  const factory: RatelimitMonitorCronFactory = (pattern, _opts, callback) => {
    const stub: StubCron = {
      pattern,
      stopped: false,
      trigger: async () => {
        if (!stub.stopped) await callback();
      },
    };
    crons.push(stub);
    return { stop: () => (stub.stopped = true) };
  };
  return { factory, crons };
}

function makeDeps(over: Partial<RatelimitMonitorCronDeps> = {}): {
  deps: RatelimitMonitorCronDeps;
  posted: string[];
  crons: StubCron[];
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
} {
  const { factory, crons } = makeStubCronFactory();
  const posted: string[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: RatelimitMonitorCronDeps = {
    runRatelimitProbe: async () => REAL_OUTPUT,
    postToAdminClawdy: async (m: string) => {
      posted.push(m);
    },
    now: () => 0,
    log,
    cronFactory: factory,
    ...over,
  };
  return { deps, posted, crons, log };
}

describe("parseAccountReadWriteRow", () => {
  it("extracts the account read_write row from real CLI output", () => {
    const row = parseAccountReadWriteRow(REAL_OUTPUT);
    expect(row).not.toBeNull();
    expect(row?.limit).toBe(1000);
    expect(row?.used).toBe(950);
    expect(row?.remaining).toBe(50);
    expect(row?.reset).toContain("23 hours");
  });

  it("ignores the per-token rows (the account row is the binding limit)", () => {
    // The hourly `token read` counter is NOT the cap that took the fleet down;
    // picking the wrong row would report 5/1000 while the account sits at 950.
    const row = parseAccountReadWriteRow(REAL_OUTPUT);
    expect(row?.used).not.toBe(5);
  });

  it("returns null on unparsable input rather than guessing", () => {
    expect(parseAccountReadWriteRow("")).toBeNull();
    expect(parseAccountReadWriteRow("totally unexpected output")).toBeNull();
  });
});

describe("registerRatelimitMonitorCron", () => {
  it("registers with a static cron pattern", () => {
    const { deps, crons } = makeDeps();
    const reg = registerRatelimitMonitorCron(deps);
    expect(reg.registered).toBe(true);
    expect(crons[0]?.pattern).toBe(RATELIMIT_MONITOR_CRON_PATTERN);
  });

  it("returns {registered:false} when the factory throws — never propagates (INC-2026-06-04)", () => {
    // A bad cron pattern must not crash the daemon at boot; that loop is what
    // burned the op quota in the first place.
    const { deps } = makeDeps({
      cronFactory: () => {
        throw new Error("bad pattern");
      },
    });
    const reg = registerRatelimitMonitorCron(deps);
    expect(reg.registered).toBe(false);
    expect(reg.reason).toBeTruthy();
  });

  it("alerts when usage crosses the critical tier", async () => {
    const { deps, posted, crons } = makeDeps();
    registerRatelimitMonitorCron(deps);
    await crons[0]!.trigger();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("950");
  });

  it("stays silent below the warn tier", async () => {
    const low = REAL_OUTPUT.replace("1000     950     50", "1000     100     900");
    const { deps, posted, crons } = makeDeps({ runRatelimitProbe: async () => low });
    registerRatelimitMonitorCron(deps);
    await crons[0]!.trigger();
    expect(posted).toHaveLength(0);
  });

  it("dedups a sustained breach within the cooldown", async () => {
    // A cap that stays exhausted for hours must not post hourly.
    const { deps, posted, crons } = makeDeps();
    registerRatelimitMonitorCron(deps);
    await crons[0]!.trigger();
    await crons[0]!.trigger();
    expect(posted).toHaveLength(1);
  });

  it("re-alerts once the cooldown elapses", async () => {
    let t = 0;
    const { deps, posted, crons } = makeDeps({ now: () => t });
    registerRatelimitMonitorCron(deps);
    await crons[0]!.trigger();
    t = RATELIMIT_MONITOR_DEFAULTS.alertCooldownMs + 1;
    await crons[0]!.trigger();
    expect(posted).toHaveLength(2);
  });

  it("emits NO alert on unparsable probe output — silence beats a false alarm", async () => {
    const { deps, posted, crons, log } = makeDeps({ runRatelimitProbe: async () => "garbage" });
    registerRatelimitMonitorCron(deps);
    await crons[0]!.trigger();
    expect(posted).toHaveLength(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it("catches a throwing tick and still fires on the next one (INC-2026-06-04)", async () => {
    let calls = 0;
    const { deps, posted, crons } = makeDeps({
      runRatelimitProbe: async () => {
        calls += 1;
        if (calls === 1) throw new Error("op exploded");
        return REAL_OUTPUT;
      },
    });
    registerRatelimitMonitorCron(deps);
    await expect(crons[0]!.trigger()).resolves.toBeUndefined();
    await crons[0]!.trigger();
    expect(posted).toHaveLength(1);
  });

  it("never lets a failing alert post escape the tick", async () => {
    const { deps, crons } = makeDeps({
      postToAdminClawdy: async () => {
        throw new Error("discord down");
      },
    });
    registerRatelimitMonitorCron(deps);
    await expect(crons[0]!.trigger()).resolves.toBeUndefined();
  });
});
