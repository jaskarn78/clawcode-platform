/**
 * Phase 115 Plan 05 T03 — D-05 priority dream-pass trigger tests.
 *
 * Pin the contract:
 *   - 0 truncation events    → not priority; uses normal idle window
 *   - 1 event in 24h         → not priority
 *   - 2 events in 24h        → priority; uses 5-min idle window
 *   - 2 events > 24h apart   → not priority (only counts last 24h)
 *   - When priority fires, [diag] priority-dream-pass-trigger warn emitted
 *   - applyDreamResultPriority called with isPriorityPass=true when wired
 */

import { describe, it, expect, vi } from "vitest";
import {
  registerDreamCron,
  shouldFirePriorityPass,
  PRIORITY_THRESHOLD,
  PRIORITY_IDLE_MINUTES,
  PRIORITY_WINDOW_MS,
  type DreamCronDeps,
  type TruncationEventCounter,
} from "../dream-cron.js";
import type { DreamPassOutcome } from "../dream-pass.js";
import type { DreamApplyOutcome } from "../dream-auto-apply.js";

interface StubCron {
  pattern: string;
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

const FIXED_NOW = new Date("2026-05-08T12:00:00.000Z");

const COMPLETED_OUTCOME: DreamPassOutcome = {
  kind: "completed",
  result: {
    newWikilinks: [],
    promotionCandidates: [],
    themedReflection: "test",
    suggestedConsolidations: [],
  },
  durationMs: 1000,
  tokensIn: 100,
  tokensOut: 50,
  model: "haiku",
};

const APPLIED_OUTCOME: DreamApplyOutcome = {
  kind: "applied",
  appliedWikilinkCount: 0,
  surfacedPromotionCount: 0,
  surfacedConsolidationCount: 0,
  logPath: "/tmp/dream.md",
};

function buildDeps(
  overrides: Partial<DreamCronDeps> = {},
): { deps: DreamCronDeps; crons: StubCron[]; logs: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } } {
  const stub = makeStubCronFactory();
  const logs = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const deps: DreamCronDeps = {
    agentName: overrides.agentName ?? "atlas",
    dreamConfig: overrides.dreamConfig ?? {
      enabled: true,
      idleMinutes: 30,
      model: "haiku",
    },
    getLastTurnAt:
      overrides.getLastTurnAt ?? (() => new Date("2026-05-08T11:00:00.000Z")),
    runDreamPass:
      overrides.runDreamPass ?? vi.fn().mockResolvedValue(COMPLETED_OUTCOME),
    applyDreamResult:
      overrides.applyDreamResult ?? vi.fn().mockResolvedValue(APPLIED_OUTCOME),
    isAgentIdle:
      overrides.isAgentIdle ??
      ((d) => ({ idle: true, reason: "idle-threshold-met" })),
    now: overrides.now ?? (() => FIXED_NOW),
    log: overrides.log ?? logs,
    cronFactory: overrides.cronFactory ?? stub.factory,
    truncationEventCounter: overrides.truncationEventCounter,
    applyDreamResultPriority: overrides.applyDreamResultPriority,
  };
  return { deps, crons: stub.crons, logs };
}

describe("shouldFirePriorityPass — D-05 trigger gate", () => {
  it("0 truncation events → not priority", () => {
    const counter: TruncationEventCounter = {
      countTruncationEventsSince: vi.fn().mockReturnValue(0),
    };
    const log = { warn: vi.fn() };
    const result = shouldFirePriorityPass("atlas", counter, log, () => FIXED_NOW);
    expect(result).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("1 event in 24h → not priority", () => {
    const counter: TruncationEventCounter = {
      countTruncationEventsSince: vi.fn().mockReturnValue(1),
    };
    const log = { warn: vi.fn() };
    const result = shouldFirePriorityPass("atlas", counter, log, () => FIXED_NOW);
    expect(result).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("2 events in 24h → priority + warn line emitted", () => {
    const counter: TruncationEventCounter = {
      countTruncationEventsSince: vi.fn().mockReturnValue(2),
    };
    const log = { warn: vi.fn() };
    const result = shouldFirePriorityPass("atlas", counter, log, () => FIXED_NOW);
    expect(result).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain("priority-dream-pass-trigger");
    expect(log.warn.mock.calls[0][0]).toContain("agent=atlas");
    expect(log.warn.mock.calls[0][0]).toContain("events=2");
    expect(log.warn.mock.calls[0][0]).toContain("threshold=2");
  });

  it("3+ events in 24h → still priority", () => {
    const counter: TruncationEventCounter = {
      countTruncationEventsSince: vi.fn().mockReturnValue(7),
    };
    const log = { warn: vi.fn() };
    const result = shouldFirePriorityPass("atlas", counter, log, () => FIXED_NOW);
    expect(result).toBe(true);
  });

  it("counts only the last 24h window (since param)", () => {
    const counter: TruncationEventCounter = {
      countTruncationEventsSince: vi.fn().mockReturnValue(2),
    };
    const log = { warn: vi.fn() };
    shouldFirePriorityPass("atlas", counter, log, () => FIXED_NOW);

    // since = now - 24h
    const expectedSince = FIXED_NOW.getTime() - PRIORITY_WINDOW_MS;
    expect(counter.countTruncationEventsSince).toHaveBeenCalledWith(
      "atlas",
      expectedSince,
    );
  });

  it("counter throw → returns false (fail-safe)", () => {
    const counter: TruncationEventCounter = {
      countTruncationEventsSince: vi.fn().mockImplementation(() => {
        throw new Error("db locked");
      }),
    };
    const log = { warn: vi.fn() };
    const result = shouldFirePriorityPass("atlas", counter, log, () => FIXED_NOW);
    expect(result).toBe(false);
  });
});

describe("registerDreamCron — D-05 priority pass integration", () => {
  it("no truncationEventCounter → behaves like Phase 95 D-04 (no priority logic)", async () => {
    const { deps, crons, logs } = buildDeps({});
    registerDreamCron(deps);
    expect(crons).toHaveLength(1);
    await crons[0].trigger();
    // No priority-trigger warn line. Idle threshold = configured 30 min.
    expect(logs.warn).not.toHaveBeenCalled();
    expect(deps.applyDreamResult).toHaveBeenCalledTimes(1);
  });

  it("truncationEventCounter returns 0 → uses normal idle window (30 min)", async () => {
    const counter: TruncationEventCounter = {
      countTruncationEventsSince: vi.fn().mockReturnValue(0),
    };
    const isAgentIdle = vi
      .fn()
      .mockReturnValue({ idle: true, reason: "idle-threshold-met" });
    const { deps, crons } = buildDeps({
      truncationEventCounter: counter,
      isAgentIdle,
    });
    registerDreamCron(deps);
    await crons[0].trigger();

    expect(isAgentIdle).toHaveBeenCalledTimes(1);
    // First arg passed: idleMinutes is the configured 30, NOT 5.
    expect(isAgentIdle.mock.calls[0][0].idleMinutes).toBe(30);
  });

  it("truncationEventCounter returns 2 → uses 5-min priority idle window", async () => {
    const counter: TruncationEventCounter = {
      countTruncationEventsSince: vi.fn().mockReturnValue(2),
    };
    const isAgentIdle = vi
      .fn()
      .mockReturnValue({ idle: true, reason: "idle-threshold-met" });
    const { deps, crons, logs } = buildDeps({
      truncationEventCounter: counter,
      isAgentIdle,
    });
    registerDreamCron(deps);
    await crons[0].trigger();

    expect(isAgentIdle).toHaveBeenCalledTimes(1);
    expect(isAgentIdle.mock.calls[0][0].idleMinutes).toBe(PRIORITY_IDLE_MINUTES);
    // Warn line emitted.
    expect(logs.warn).toHaveBeenCalledWith(
      expect.stringContaining("priority-dream-pass-trigger"),
    );
  });

  it("priority pass → applyDreamResultPriority called with isPriorityPass=true", async () => {
    const counter: TruncationEventCounter = {
      countTruncationEventsSince: vi.fn().mockReturnValue(2),
    };
    const applyDreamResultPriority = vi
      .fn()
      .mockResolvedValue(APPLIED_OUTCOME);
    const { deps, crons } = buildDeps({
      truncationEventCounter: counter,
      applyDreamResultPriority,
    });
    registerDreamCron(deps);
    await crons[0].trigger();

    expect(applyDreamResultPriority).toHaveBeenCalledTimes(1);
    expect(applyDreamResultPriority).toHaveBeenCalledWith(
      "atlas",
      COMPLETED_OUTCOME,
      true, // isPriorityPass
    );
    // Legacy applier NOT called when priority applier is wired.
    expect(deps.applyDreamResult).not.toHaveBeenCalled();
  });

  it("non-priority pass → applyDreamResultPriority called with isPriorityPass=false", async () => {
    const counter: TruncationEventCounter = {
      countTruncationEventsSince: vi.fn().mockReturnValue(0),
    };
    const applyDreamResultPriority = vi
      .fn()
      .mockResolvedValue(APPLIED_OUTCOME);
    const { deps, crons } = buildDeps({
      truncationEventCounter: counter,
      applyDreamResultPriority,
    });
    registerDreamCron(deps);
    await crons[0].trigger();

    expect(applyDreamResultPriority).toHaveBeenCalledWith(
      "atlas",
      COMPLETED_OUTCOME,
      false, // isPriorityPass
    );
  });

  it("priority threshold constant = 2 (CONTEXT.md D-05 verbatim)", () => {
    expect(PRIORITY_THRESHOLD).toBe(2);
  });

  it("priority idle minutes = 5 (CONTEXT.md D-05 verbatim)", () => {
    expect(PRIORITY_IDLE_MINUTES).toBe(5);
  });

  it("priority window = 24 hours (CONTEXT.md D-05 verbatim)", () => {
    expect(PRIORITY_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});
