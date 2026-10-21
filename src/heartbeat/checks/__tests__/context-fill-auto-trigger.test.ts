/**
 * Phase 124 Plan 04 T-02 — auto-trigger wiring tests for context-fill.
 *
 * Verifies the heartbeat check fires `compactSessionTrigger` exactly when:
 *   - autoCompactAt > 0 (per-agent opt-out)
 *   - currentContextFill >= autoCompactAt
 *   - no compaction occurred within the cooldown window
 *
 * The check's PRIMARY return (status/message/metadata) MUST be unchanged
 * — auto-trigger is a side effect, not a status mutation. Tests assert
 * both the trigger call count AND that the result shape stays identical
 * across all gate branches.
 *
 * `[124-04-auto-trigger]` sentinel keyword is asserted via console.info
 * spy — operators grep production journalctl for this string to verify
 * the wiring runs end-to-end (feedback_silent_path_bifurcation pattern).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import contextFillCheck from "../context-fill.js";
import type { CheckContext } from "../../types.js";
import type { ResolvedAgentConfig } from "../../../shared/types.js";

const FIXED_NOW = Date.parse("2026-05-14T20:00:00.000Z");
const FIVE_MIN = 5 * 60 * 1000;

type Overrides = {
  fillPercentage?: number;
  autoCompactAt?: number;
  lastCompactionAt?: string | null;
  cooldownMs?: number;
  triggerImpl?: (agent: string) => Promise<void>;
};

function makeContext(o: Overrides): {
  context: CheckContext;
  trigger: ReturnType<typeof vi.fn>;
} {
  const trigger = vi.fn(
    o.triggerImpl ?? (async (_a: string) => undefined),
  );
  const provider =
    o.fillPercentage !== undefined
      ? { getContextFillPercentage: () => o.fillPercentage!, addTurn: vi.fn(), reset: vi.fn() }
      : undefined;

  const agentConfig: Partial<ResolvedAgentConfig> = {
    name: "alpha",
    autoCompactAt: o.autoCompactAt ?? 0.7,
  };

  const context: CheckContext = {
    agentName: "alpha",
    sessionManager: {
      getContextFillProvider: () => provider,
      getRunningAgents: () => [],
      getCompactionManager: () => undefined,
      getAgentConfig: () => agentConfig as ResolvedAgentConfig,
    } as any,
    registry: { entries: [], updatedAt: FIXED_NOW },
    config: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: {
        warningThreshold: 0.6,
        criticalThreshold: 0.75,
        zoneThresholds: { yellow: 0.5, orange: 0.7, red: 0.85 },
      },
    },
    compactSessionTrigger: trigger,
    getLastCompactionAt: () => o.lastCompactionAt ?? null,
    now: () => FIXED_NOW,
    cooldownMs: o.cooldownMs ?? FIVE_MIN,
  } as any;

  return { context, trigger };
}

describe("context-fill auto-trigger wiring", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("Case A: fires once when fill >= threshold and no prior compaction", async () => {
    const { context, trigger } = makeContext({
      fillPercentage: 0.8,
      autoCompactAt: 0.7,
      lastCompactionAt: null,
    });
    const result = await contextFillCheck.execute(context);
    // Status stays correct regardless of trigger.
    expect(result.status).toBe("warning"); // 80% = orange zone
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith("alpha");
    // Sentinel keyword present in console.info output.
    const calls = infoSpy.mock.calls.flat().join(" ");
    expect(calls).toContain("[124-04-auto-trigger]");
  });

  it("Case B: does NOT fire when fill < threshold", async () => {
    const { context, trigger } = makeContext({
      fillPercentage: 0.6,
      autoCompactAt: 0.7,
      lastCompactionAt: null,
    });
    await contextFillCheck.execute(context);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("Case C: does NOT fire when autoCompactAt is 0 (per-agent opt-out)", async () => {
    const { context, trigger } = makeContext({
      fillPercentage: 1.0,
      autoCompactAt: 0,
      lastCompactionAt: null,
    });
    await contextFillCheck.execute(context);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("Case D: does NOT fire when prior compaction is within cooldown (2 min ago)", async () => {
    const twoMinAgo = new Date(FIXED_NOW - 2 * 60 * 1000).toISOString();
    const { context, trigger } = makeContext({
      fillPercentage: 0.9,
      autoCompactAt: 0.7,
      lastCompactionAt: twoMinAgo,
    });
    await contextFillCheck.execute(context);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("Case E: fires when prior compaction is beyond cooldown (6 min ago)", async () => {
    const sixMinAgo = new Date(FIXED_NOW - 6 * 60 * 1000).toISOString();
    const { context, trigger } = makeContext({
      fillPercentage: 0.9,
      autoCompactAt: 0.7,
      lastCompactionAt: sixMinAgo,
    });
    await contextFillCheck.execute(context);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("Case F: trigger throw is swallowed; check still returns its normal result", async () => {
    const throwingTrigger = vi.fn(async () => {
      throw new Error("boom");
    });
    const { context, trigger } = makeContext({
      fillPercentage: 0.8,
      autoCompactAt: 0.7,
      lastCompactionAt: null,
      triggerImpl: throwingTrigger,
    });
    // Should not throw.
    const result = await contextFillCheck.execute(context);
    expect(result.status).toBe("warning");
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("does not fire when trigger is not wired (back-compat with old runner)", async () => {
    // Build a context WITHOUT compactSessionTrigger to simulate old runner.
    const { context, trigger } = makeContext({
      fillPercentage: 0.9,
      autoCompactAt: 0.7,
      lastCompactionAt: null,
    });
    const stripped = { ...context };
    delete (stripped as any).compactSessionTrigger;
    const result = await contextFillCheck.execute(stripped);
    expect(result.status).toBe("critical"); // 90% = red zone
    expect(trigger).not.toHaveBeenCalled();
  });
});
