import { describe, it, expect, vi } from "vitest";

/**
 * Phase 95 Plan 02 Task 1 — registerDreamCron tests (RED).
 *
 * Pin D-06 contract:
 *   - C1: dream.enabled=false → no Cron created; {registered:false, reason:'disabled', label:'dream'}
 *   - C2: enabled=true, idleMinutes=30 → cron pattern '*\/30 * * * *'
 *   - C3: tick fires; isAgentIdle returns idle=false 'active' → runDreamPass NOT called; skip log
 *   - C4: tick fires; idle=true 'idle-threshold-met' → runDreamPass + applyDreamResult called
 *   - C5: tick fires; idle=true 'idle-ceiling-bypass' → runDreamPass called
 *   - C6: schedule label === 'dream'
 *   - C7: unregister() stops the cron; subsequent ticks no-op
 *
 * Module under test (registerDreamCron) does not exist yet — imports fail (RED).
 */

import {
  registerDreamCron,
  type DreamCronDeps,
} from "../dream-cron.js";
import type { DreamPassOutcome } from "../dream-pass.js";
import type { DreamApplyOutcome } from "../dream-auto-apply.js";

interface StubCron {
  pattern: string;
  name?: string;
  callback: () => Promise<void>;
  stopped: boolean;
  trigger: () => Promise<void>;
}

function makeStubCronFactory(): {
  factory: DreamCronDeps["cronFactory"];
  crons: StubCron[];
} {
  const crons: StubCron[] = [];
  const factory: DreamCronDeps["cronFactory"] = (pattern, opts, callback) => {
    const stub: StubCron = {
      pattern,
      name: opts.name,
      callback: async () => {
        if (!stub.stopped) await callback();
      },
      stopped: false,
      trigger: async () => {
        if (!stub.stopped) await callback();
      },
    };
    crons.push(stub);
    return {
      stop: () => {
        stub.stopped = true;
      },
    };
  };
  return { factory, crons };
}

const noopLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const FIXED_NOW = new Date("2026-04-25T12:00:00.000Z");

function buildDeps(overrides: Partial<DreamCronDeps> = {}): DreamCronDeps {
  const stub = makeStubCronFactory();
  return {
    agentName: overrides.agentName ?? "atlas",
    dreamConfig: overrides.dreamConfig ?? {
      enabled: true,
      idleMinutes: 30,
      model: "haiku",
    },
    getLastTurnAt:
      overrides.getLastTurnAt ?? (() => new Date("2026-04-25T11:00:00.000Z")),
    runDreamPass:
      overrides.runDreamPass ??
      vi.fn(
        async (): Promise<DreamPassOutcome> => ({
          kind: "skipped",
          reason: "disabled",
        }),
      ),
    applyDreamResult:
      overrides.applyDreamResult ??
      vi.fn(
        async (): Promise<DreamApplyOutcome> => ({
          kind: "skipped",
          reason: "no-completed-result",
        }),
      ),
    isAgentIdle:
      overrides.isAgentIdle ??
      ((deps) => {
        const elapsed = deps.now().getTime() - (deps.lastTurnAt?.getTime() ?? 0);
        if (deps.lastTurnAt === null)
          return { idle: false, reason: "no-prior-turn" };
        if (elapsed > deps.idleMinutes * 60_000)
          return { idle: true, reason: "idle-threshold-met" };
        return { idle: false, reason: "active" };
      }),
    now: overrides.now ?? (() => FIXED_NOW),
    log: overrides.log ?? noopLog,
    cronFactory: overrides.cronFactory ?? stub.factory,
  };
}

describe("registerDreamCron — D-06 per-agent cron timer", () => {
  it("C1: dream.enabled=false — no cron created; returns {registered:false, reason:'disabled'}", () => {
    const stub = makeStubCronFactory();
    const deps = buildDeps({
      dreamConfig: { enabled: false, idleMinutes: 30, model: "haiku" },
      cronFactory: stub.factory,
    });
    const result = registerDreamCron(deps);
    expect(result.registered).toBe(false);
    expect(result.reason).toBe("disabled");
    expect(result.label).toBe("dream");
    expect(stub.crons).toHaveLength(0);
  });

  it("C2: enabled=true, idleMinutes=30 — cron pattern '*/30 * * * *'", () => {
    const stub = makeStubCronFactory();
    const deps = buildDeps({ cronFactory: stub.factory });
    const result = registerDreamCron(deps);
    expect(result.registered).toBe(true);
    expect(stub.crons).toHaveLength(1);
    expect(stub.crons[0]!.pattern).toBe("*/30 * * * *");
  });

  it("C3: tick fires; idle=false 'active' → runDreamPass NOT called; skip log emitted", async () => {
    const stub = makeStubCronFactory();
    const runDreamPass = vi.fn(
      async (): Promise<DreamPassOutcome> => ({
        kind: "completed",
        result: {
          newWikilinks: [],
          promotionCandidates: [],
          themedReflection: "x",
          suggestedConsolidations: [],
        },
        durationMs: 1,
        tokensIn: 1,
        tokensOut: 1,
        model: "haiku",
      }),
    );
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deps = buildDeps({
      cronFactory: stub.factory,
      runDreamPass,
      isAgentIdle: () => ({ idle: false, reason: "active" }),
      log,
    });
    registerDreamCron(deps);
    await stub.crons[0]!.trigger();
    expect(runDreamPass).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalled();
    const skipLog = log.info.mock.calls.find((c) =>
      String(c[0]).includes("skip"),
    );
    expect(skipLog).toBeDefined();
  });

  it("C4: tick fires; idle=true 'idle-threshold-met' → runDreamPass + applyDreamResult called", async () => {
    const stub = makeStubCronFactory();
    const completedOutcome: DreamPassOutcome = {
      kind: "completed",
      result: {
        newWikilinks: [],
        promotionCandidates: [],
        themedReflection: "x",
        suggestedConsolidations: [],
      },
      durationMs: 1,
      tokensIn: 1,
      tokensOut: 1,
      model: "haiku",
    };
    const runDreamPass = vi.fn(async () => completedOutcome);
    const applyDreamResult = vi.fn(
      async (): Promise<DreamApplyOutcome> => ({
        kind: "applied",
        appliedWikilinkCount: 0,
        surfacedPromotionCount: 0,
        surfacedConsolidationCount: 0,
        logPath: "/tmp/dreams/x.md",
      }),
    );
    const deps = buildDeps({
      cronFactory: stub.factory,
      runDreamPass,
      applyDreamResult,
      isAgentIdle: () => ({ idle: true, reason: "idle-threshold-met" }),
    });
    registerDreamCron(deps);
    await stub.crons[0]!.trigger();
    expect(runDreamPass).toHaveBeenCalledWith("atlas");
    expect(applyDreamResult).toHaveBeenCalledWith("atlas", completedOutcome);
  });

  it("C5: tick fires; idle=true 'idle-ceiling-bypass' → runDreamPass called", async () => {
    const stub = makeStubCronFactory();
    const runDreamPass = vi.fn(
      async (): Promise<DreamPassOutcome> => ({
        kind: "skipped",
        reason: "disabled",
      }),
    );
    const deps = buildDeps({
      cronFactory: stub.factory,
      runDreamPass,
      isAgentIdle: () => ({ idle: true, reason: "idle-ceiling-bypass" }),
    });
    registerDreamCron(deps);
    await stub.crons[0]!.trigger();
    expect(runDreamPass).toHaveBeenCalledTimes(1);
  });

  it("C6: schedule label is the literal string 'dream'", () => {
    const stub = makeStubCronFactory();
    const deps = buildDeps({ cronFactory: stub.factory });
    const result = registerDreamCron(deps);
    expect(result.label).toBe("dream");
    // The croner job NAME is per-agent (`dream-<agent>`) so the static
    // `Cron.scheduledJobs` registry stays uniquely keyed when multiple
    // agents register dream crons. The D-06 schedule LABEL is still the
    // literal "dream" (asserted above).
    expect(stub.crons[0]!.name).toBe("dream-atlas");
  });

  it("C7: unregister() stops the cron; subsequent ticks no-op", async () => {
    const stub = makeStubCronFactory();
    const runDreamPass = vi.fn(
      async (): Promise<DreamPassOutcome> => ({
        kind: "skipped",
        reason: "disabled",
      }),
    );
    const deps = buildDeps({
      cronFactory: stub.factory,
      runDreamPass,
      isAgentIdle: () => ({ idle: true, reason: "idle-threshold-met" }),
    });
    const result = registerDreamCron(deps);
    expect(result.registered).toBe(true);
    expect(typeof result.unregister).toBe("function");
    result.unregister!();
    expect(stub.crons[0]!.stopped).toBe(true);
    await stub.crons[0]!.trigger();
    expect(runDreamPass).not.toHaveBeenCalled();
  });
});

describe("registerDreamCron — novelty gate and real idle minutes (WP7)", () => {
  const completedOutcome: DreamPassOutcome = {
    kind: "completed",
    result: {
      newWikilinks: [],
      promotionCandidates: [],
      themedReflection: "x",
      suggestedConsolidations: [],
    },
    durationMs: 1,
    tokensIn: 1,
    tokensOut: 1,
    model: "haiku",
  };

  it("skips the tick without running a pass when the gate reports no new memory", async () => {
    const stub = makeStubCronFactory();
    const runDreamPass = vi.fn(async () => completedOutcome);
    const applyDreamResult = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const noveltyGate = vi.fn(async () => ({
      skip: true,
      reason: "no-new-memory",
      lastPassAt: "2026-04-25T09:00:00.000Z",
    }));
    const deps = buildDeps({
      cronFactory: stub.factory,
      runDreamPass,
      applyDreamResult,
      isAgentIdle: () => ({ idle: true, reason: "idle-threshold-met", elapsedMinutes: 60 }),
      noveltyGate,
      log,
    });
    registerDreamCron(deps);
    await stub.crons[0]!.trigger();
    expect(noveltyGate).toHaveBeenCalledWith("atlas");
    expect(runDreamPass).not.toHaveBeenCalled();
    expect(applyDreamResult).not.toHaveBeenCalled();
    const skipLine = log.info.mock.calls.map((c) => String(c[0])).find((l) => l.includes("no-new-memory"));
    expect(skipLine).toContain("2026-04-25T09:00:00.000Z");
  });

  it("runs the pass when the gate reports novelty, and is consulted only after the idle check", async () => {
    const stub = makeStubCronFactory();
    const runDreamPass = vi.fn(async () => completedOutcome);
    const noveltyGate = vi.fn(async () => ({ skip: false, reason: "new-memory" }));
    const deps = buildDeps({
      cronFactory: stub.factory,
      runDreamPass,
      isAgentIdle: () => ({ idle: false, reason: "active" }),
      noveltyGate,
    });
    registerDreamCron(deps);
    await stub.crons[0]!.trigger();
    expect(noveltyGate).not.toHaveBeenCalled();
    expect(runDreamPass).not.toHaveBeenCalled();

    const stub2 = makeStubCronFactory();
    registerDreamCron(
      buildDeps({
        cronFactory: stub2.factory,
        runDreamPass,
        isAgentIdle: () => ({ idle: true, reason: "idle-threshold-met" }),
        noveltyGate,
      }),
    );
    await stub2.crons[0]!.trigger();
    expect(noveltyGate).toHaveBeenCalledTimes(1);
    expect(runDreamPass).toHaveBeenCalledTimes(1);
  });

  it("fails open when the gate throws", async () => {
    const stub = makeStubCronFactory();
    const runDreamPass = vi.fn(async () => completedOutcome);
    const deps = buildDeps({
      cronFactory: stub.factory,
      runDreamPass,
      isAgentIdle: () => ({ idle: true, reason: "idle-threshold-met" }),
      noveltyGate: async () => {
        throw new Error("store closed");
      },
    });
    registerDreamCron(deps);
    await stub.crons[0]!.trigger();
    expect(runDreamPass).toHaveBeenCalledTimes(1);
  });

  it("passes the measured idle minutes to the priority-aware applier", async () => {
    const stub = makeStubCronFactory();
    const applyDreamResultPriority = vi.fn(
      async (): Promise<DreamApplyOutcome> => ({
        kind: "applied",
        appliedWikilinkCount: 0,
        surfacedPromotionCount: 0,
        surfacedConsolidationCount: 0,
        logPath: "/tmp/dreams/x.md",
      }),
    );
    const deps = buildDeps({
      cronFactory: stub.factory,
      runDreamPass: vi.fn(async () => completedOutcome),
      isAgentIdle: () => ({ idle: true, reason: "idle-threshold-met", elapsedMinutes: 47 }),
      applyDreamResultPriority,
    });
    registerDreamCron(deps);
    await stub.crons[0]!.trigger();
    expect(applyDreamResultPriority).toHaveBeenCalledWith("atlas", completedOutcome, false, 47);
  });

  it("keeps the 3-argument applier call when the detector reports no minutes", async () => {
    const stub = makeStubCronFactory();
    const applyDreamResultPriority = vi.fn(
      async (): Promise<DreamApplyOutcome> => ({ kind: "skipped", reason: "no-completed-result" }),
    );
    const deps = buildDeps({
      cronFactory: stub.factory,
      runDreamPass: vi.fn(async () => completedOutcome),
      isAgentIdle: () => ({ idle: true, reason: "idle-threshold-met" }),
      applyDreamResultPriority,
    });
    registerDreamCron(deps);
    await stub.crons[0]!.trigger();
    expect(applyDreamResultPriority).toHaveBeenCalledWith("atlas", completedOutcome, false);
    expect(applyDreamResultPriority.mock.calls[0]).toHaveLength(3);
  });
});

describe("registerDreamCron — INC-2026-06-04 regression (idleMinutes>59 invalid cron)", () => {
  it("clamps the cron check-cadence step to <=59 so idleMinutes>59 yields a VALID pattern", () => {
    const stub = makeStubCronFactory();
    const deps = buildDeps({
      dreamConfig: { enabled: true, idleMinutes: 90, model: "haiku" },
      cronFactory: stub.factory,
    });
    const result = registerDreamCron(deps);
    expect(result.registered).toBe(true);
    // idleMinutes:90 is the IDLE THRESHOLD; it must NOT leak into the cron
    // minute step (croner rejects `*/90`). The check cadence is clamped to 59.
    expect(stub.crons[0]!.pattern).toBe("*/59 * * * *");
  });

  it("leaves a valid step (<=59) unchanged", () => {
    const stub = makeStubCronFactory();
    const deps = buildDeps({
      dreamConfig: { enabled: true, idleMinutes: 45, model: "haiku" },
      cronFactory: stub.factory,
    });
    registerDreamCron(deps);
    expect(stub.crons[0]!.pattern).toBe("*/45 * * * *");
  });

  it("idleMinutes>59 registers with the REAL croner factory WITHOUT throwing (the crash this prevents)", () => {
    // No cronFactory override → exercises DEFAULT_DREAM_CRON_FACTORY (real
    // croner). Pre-fix, idleMinutes:90 built `*/90 * * * *`, which croner
    // rejects synchronously ("steps cannot be greater than ... (60)") and
    // crash-looped the daemon. The clamped pattern must construct cleanly.
    const base = buildDeps({
      agentName: "fin-client",
      dreamConfig: { enabled: true, idleMinutes: 90, model: "haiku" },
    });
    const realDeps = { ...base };
    delete (realDeps as { cronFactory?: unknown }).cronFactory;
    let result: ReturnType<typeof registerDreamCron> | undefined;
    expect(() => {
      result = registerDreamCron(realDeps);
    }).not.toThrow();
    expect(result!.registered).toBe(true);
    result!.unregister?.();
  });

  it("fails open (registered:false, reason:'pattern-error') if the factory throws — never crashes the caller", () => {
    const throwingFactory: DreamCronDeps["cronFactory"] = () => {
      throw new Error(
        "CronPattern: Syntax error, steps cannot be greater than maximum value of part (60)",
      );
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deps = buildDeps({
      dreamConfig: { enabled: true, idleMinutes: 30, model: "haiku" },
      cronFactory: throwingFactory,
      log,
    });
    let result: ReturnType<typeof registerDreamCron> | undefined;
    expect(() => {
      result = registerDreamCron(deps);
    }).not.toThrow();
    expect(result!.registered).toBe(false);
    expect(result!.reason).toBe("pattern-error");
    expect(log.error).toHaveBeenCalled();
  });
});
