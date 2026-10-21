/**
 * 999.147 WS-3 — Unraid memory watch.
 *
 * Fixtures are the real readings from 10.0.0.1 on 2026-09-16: 32GB
 * total, 5.1GB available (84% used), zero swap, /var/log a 128MB tmpfs at 7%.
 * That baseline is the whole difficulty — the box LIVES at 84%, so a level
 * threshold anywhere near the working range rebuilds the flood this phase
 * exists to remove.
 */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  evaluateUnraid,
  parseUnraidContainers,
  parseUnraidSnapshot,
  recordUnraidPoint,
  UNRAID_WATCH_DEFAULTS,
  type UnraidSnapshot,
} from "../unraid-memory-watch.js";
import {
  isValidContainerName,
  restartUnraidContainer,
  UnraidWatch,
  type UnraidPage,
} from "../unraid-watch-service.js";
import type { TrajectoryPoint } from "../../manager/memory-imminence.js";

const MIN = 60_000;
const silent = () => pino({ level: "silent" });

/** Exactly what the box returned when probed. */
const LIVE_SNAPSHOT = [
  "mem\t31985\t5173",
  "swap\t0\t0",
  "log\t128\t9",
  "oom\t0",
].join("\n");

const snap = (over: Partial<UnraidSnapshot> = {}): UnraidSnapshot => ({
  memTotalMb: 31_985,
  memAvailableMb: 5173,
  swapTotalMb: 0,
  swapUsedMb: 0,
  logTotalMb: 128,
  logUsedMb: 9,
  oomCount: 0,
  ...over,
});

const series = (endMb: number, perMin: number, n = 6): readonly TrajectoryPoint[] =>
  Array.from({ length: n }, (_, i) => ({
    atMs: (i - n + 1) * MIN,
    mb: endMb + (i - n + 1) * perMin,
  }));

describe("parsing", () => {
  it("reads the live snapshot exactly", () => {
    expect(parseUnraidSnapshot(LIVE_SNAPSHOT)).toEqual({
      memTotalMb: 31_985,
      memAvailableMb: 5173,
      swapTotalMb: 0,
      swapUsedMb: 0,
      logTotalMb: 128,
      logUsedMb: 9,
      oomCount: 0,
    });
  });

  it("returns null rather than inventing zeros from a broken response", () => {
    // A truncated or error-laden SSH reply read as "0MB available" would page
    // the operator at 3am about a healthy box.
    expect(parseUnraidSnapshot("")).toBeNull();
    expect(parseUnraidSnapshot("ssh: connect to host ... refused")).toBeNull();
    expect(parseUnraidSnapshot("log\t128\t9")).toBeNull(); // no mem line
  });

  it("tolerates a missing optional line", () => {
    const s = parseUnraidSnapshot("mem\t31985\t5173");
    expect(s?.memAvailableMb).toBe(5173);
    expect(s?.oomCount).toBe(0);
  });

  it("parses docker MemUsage units and sorts fattest-first", () => {
    const parsed = parseUnraidContainers(
      [
        "tesla-bot\t147.2MiB / 31.24GiB",
        "state-contract-transcribe\t1.628GiB / 31.24GiB",
        "tiny\t512KiB / 31.24GiB",
      ].join("\n"),
    );
    expect(parsed[0]).toEqual({ name: "state-contract-transcribe", memMb: 1667 });
    expect(parsed[1].name).toBe("tesla-bot");
    expect(parsed[2].memMb).toBe(1);
  });
});

describe("evaluateUnraid — the live baseline must stay silent", () => {
  const base = { previousOomCount: 0, cfg: UNRAID_WATCH_DEFAULTS };

  it("84% used, flat, zero swap — pages NOTHING", () => {
    expect(
      evaluateUnraid({ ...base, snap: snap(), points: series(5173, 0) }),
    ).toHaveLength(0);
  });

  it("a dip that recovers is not a trend", () => {
    const points = [...series(5173, 0, 5), { atMs: 0, mb: 4200 }];
    expect(evaluateUnraid({ ...base, snap: snap({ memAvailableMb: 4200 }), points }))
      .toHaveLength(0);
  });

  it("first tick after a restart cannot page an OOM (no baseline yet)", () => {
    const out = evaluateUnraid({
      ...base,
      previousOomCount: null,
      snap: snap({ oomCount: 12 }),
      points: series(5173, 0),
    });
    expect(out).toHaveLength(0);
  });
});

describe("evaluateUnraid — the dangerous cases", () => {
  const base = { previousOomCount: 0, cfg: UNRAID_WATCH_DEFAULTS };

  it("falling availability pages, and says there is no swap", () => {
    const out = evaluateUnraid({
      ...base,
      snap: snap({ memAvailableMb: 4000 }),
      points: series(4000, -250),
    });
    expect(out.map((b) => b.key)).toContain("unraid:mem-exhaustion");
    expect(out[0].message).toContain("NO SWAP");
    expect(out[0].requiresSustain).toBe(true);
    expect(out[0].wantsOffender).toBe(true);
  });

  it("already under the floor pages critically, no sustain, no projection", () => {
    const out = evaluateUnraid({
      ...base,
      snap: snap({ memAvailableMb: 1500 }),
      points: series(1500, 0),
    });
    const b = out.find((x) => x.key === "unraid:mem-exhaustion");
    expect(b?.severity).toBe("critical");
    expect(b?.requiresSustain).toBe(false);
  });

  it("/var/log filling pages on LEVEL — a tmpfs never self-clears", () => {
    const out = evaluateUnraid({
      ...base,
      snap: snap({ logUsedMb: 120 }), // 94% of 128MB
      points: series(5173, 0),
    });
    const b = out.find((x) => x.key === "unraid:log-tmpfs");
    expect(b).toBeDefined();
    expect(b?.message).toContain("webGUI");
    // No docker-stats round trip: a full log disk is not a container's RSS.
    expect(b?.wantsOffender).toBe(false);
  });

  it("an OOM delta pages; a syslog RESET does not", () => {
    // /var/log is tmpfs, so the counter drops to zero on reboot or rotation.
    // An unclamped delta would read that as a phantom, or go permanently
    // blind afterwards.
    expect(
      evaluateUnraid({
        ...base,
        previousOomCount: 3,
        snap: snap({ oomCount: 5 }),
        points: series(5173, 0),
      }).map((b) => b.key),
    ).toContain("unraid:oom-kill");

    expect(
      evaluateUnraid({
        ...base,
        previousOomCount: 9,
        snap: snap({ oomCount: 0 }), // rotated
        points: series(5173, 0),
      }),
    ).toHaveLength(0);
  });
});

describe("UnraidWatch — the poller", () => {
  const makeWatch = (opts: {
    responses: string[] | (() => Promise<string>);
    now: () => number;
    config?: () => Record<string, unknown>;
  }) => {
    const pages: UnraidPage[] = [];
    const sshCalls: string[] = [];
    let i = 0;
    const ssh = async (cmd: string) => {
      sshCalls.push(cmd);
      if (typeof opts.responses === "function") return opts.responses();
      if (cmd.includes("docker stats")) {
        return "state-contract-transcribe\t1.628GiB / 31.24GiB";
      }
      const r = opts.responses[Math.min(i, opts.responses.length - 1)];
      i += 1;
      return r;
    };
    const watch = new UnraidWatch({
      log: silent(),
      ssh,
      postPage: async (p) => {
        pages.push(p);
      },
      resolveConfig: () => (opts.config?.() ?? {}) as never,
      now: opts.now,
    });
    return { watch, pages, sshCalls };
  };

  it("a healthy box never pages, and never pays for docker stats", async () => {
    let t = 1_000_000;
    const { watch, pages, sshCalls } = makeWatch({
      responses: [LIVE_SNAPSHOT],
      now: () => t,
    });
    for (let i = 0; i < 10; i++) {
      await watch.tick();
      t += 5 * MIN;
    }
    expect(pages).toEqual([]);
    // 4.9s per call — it must not be on the healthy path.
    expect(sshCalls.some((c) => c.includes("docker stats"))).toBe(false);
  });

  it("pages once on a sustained fall and names the top container", async () => {
    let t = 1_000_000;
    let avail = 4200;
    const { watch, pages, sshCalls } = makeWatch({
      responses: () =>
        Promise.resolve(
          [`mem\t31985\t${avail}`, "swap\t0\t0", "log\t128\t9", "oom\t0"].join(
            "\n",
          ),
        ),
      now: () => t,
    });
    // The generated responder also serves the docker-stats call, so assert on
    // the page rather than on that text.
    for (let i = 0; i < 6; i++) {
      await watch.tick();
      t += MIN;
      avail -= 300;
    }
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0].key).toBe("unraid:mem-exhaustion");
    expect(sshCalls.some((c) => c.includes("docker stats"))).toBe(true);
  });

  it("an SSH failure is silent, non-fatal, and never pages", async () => {
    // A box that is powered off, or a Tailscale hiccup, must not become a
    // second flood on top of the one being fixed.
    let t = 1_000_000;
    const { watch, pages } = makeWatch({
      responses: () => Promise.reject(new Error("ssh: connect timed out")),
      now: () => t,
    });
    for (let i = 0; i < 5; i++) {
      await expect(watch.tick()).resolves.toBeUndefined();
      t += 5 * MIN;
    }
    expect(pages).toEqual([]);
  });

  it("respects the cooldown between pages of the same key", async () => {
    let t = 1_000_000;
    const { watch, pages } = makeWatch({
      responses: [
        ["mem\t31985\t1000", "swap\t0\t0", "log\t128\t9", "oom\t0"].join("\n"),
      ],
      now: () => t,
    });
    await watch.tick();
    expect(pages).toHaveLength(1);
    t += 10 * MIN; // well inside the 1h default
    await watch.tick();
    expect(pages).toHaveLength(1);
    t += 60 * MIN;
    await watch.tick();
    expect(pages).toHaveLength(2);
  });

  it("warn -> critical ESCALATION is never swallowed by the cooldown", async () => {
    // The INC-2026-08-14 shape, on the Unraid side: the trajectory warn and
    // the at-the-floor critical share one key, so a plain per-key cooldown
    // means the operator gets the projection and then SILENCE straight
    // through the OOM — on the box that has no swap to slow it down.
    let t = 1_000_000;
    let avail = 4200;
    const { watch, pages } = makeWatch({
      responses: () =>
        Promise.resolve(
          [`mem\t31985\t${avail}`, "swap\t0\t0", "log\t128\t9", "oom\t0"].join(
            "\n",
          ),
        ),
      now: () => t,
    });
    // Falling 300MB/min: warn once the projection is inside the window…
    for (let i = 0; i < 6; i++) {
      await watch.tick();
      t += MIN;
      avail -= 300;
    }
    const warns = pages.filter((p) => p.severity === "warn").length;
    expect(warns).toBeGreaterThan(0);

    // …then it crosses the 2048MB floor a few minutes later, well inside the
    // 1h cooldown the warn just opened.
    avail = 1500;
    await watch.tick();
    expect(pages.some((p) => p.severity === "critical")).toBe(true);
  });

  it("but a repeated CRITICAL still respects the cooldown", async () => {
    // Escalation must be a one-way door, not a hole in the cooldown.
    let t = 1_000_000;
    const { watch, pages } = makeWatch({
      responses: [
        ["mem\t31985\t1000", "swap\t0\t0", "log\t128\t9", "oom\t0"].join("\n"),
      ],
      now: () => t,
    });
    await watch.tick();
    t += 10 * MIN;
    await watch.tick();
    expect(pages).toHaveLength(1);
  });

  it("enabled:false is genuinely inert", async () => {
    const { watch, pages, sshCalls } = makeWatch({
      responses: [LIVE_SNAPSHOT],
      now: () => 1_000_000,
      config: () => ({ enabled: false }),
    });
    await watch.tick();
    expect(sshCalls).toEqual([]);
    expect(pages).toEqual([]);
  });
});

describe("restartUnraidContainer", () => {
  it("refuses a name that could reach the shell", async () => {
    // This string arrives from a Discord customId and is interpolated into an
    // SSH command: a metacharacter here is injection, not a typo.
    for (const bad of [
      "frigate; rm -rf /",
      "$(whoami)",
      "a`id`",
      "../etc",
      "frigate && reboot",
      "",
    ]) {
      expect(isValidContainerName(bad)).toBe(false);
    }
    const ssh = vi.fn();
    const out = await restartUnraidContainer("frigate; rm -rf /", "discord:1", {
      ssh: ssh as never,
      log: silent(),
      audit: async () => {},
    });
    expect(out.ok).toBe(false);
    expect(ssh).not.toHaveBeenCalled();
  });

  it("accepts the real container names on that box", () => {
    for (const good of [
      "frigate",
      "teslamate-db",
      "state-contract-transcribe",
      "clawdy-whisper",
      "novnc-win11",
    ]) {
      expect(isValidContainerName(good)).toBe(true);
    }
  });

  it("restarts exactly one container and audits it", async () => {
    const cmds: string[] = [];
    const rows: unknown[] = [];
    const out = await restartUnraidContainer("frigate", "discord:42", {
      ssh: async (c: string) => {
        cmds.push(c);
        return "";
      },
      log: silent(),
      audit: async (row) => {
        rows.push(row);
      },
    });
    expect(out.ok).toBe(true);
    expect(cmds).toEqual(["docker restart frigate"]);
    expect(rows[0]).toMatchObject({
      container: "frigate",
      actor: "discord:42",
      outcome: "restarted",
    });
  });

  it("reports a failed restart instead of claiming success", async () => {
    const out = await restartUnraidContainer("frigate", "cli:owner_a", {
      ssh: async () => {
        throw new Error("No such container");
      },
      log: silent(),
      audit: async () => {},
    });
    expect(out.ok).toBe(false);
    expect(out.message).toContain("No such container");
  });
});
