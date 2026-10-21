/**
 * 2026-07-31 — VerificationRunner unit tests.
 *
 * Drives the runner directly (not through TurnDispatcher) to pin the two
 * new mechanisms:
 *   - adaptive budget: heavy turns skip (`turn-cost`), moderate turns
 *     shrink to low effort (and restore), `maxVerifyHops: 0` disables;
 *   - yield: traffic during the defer window skips (`user-traffic`);
 *     `notifyIncomingTurn` mid-hop aborts (`user-traffic-abort`) and no
 *     correction posts.
 * Telemetry shape: legacy fields byte-identical, new fields additive.
 */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  VerificationRunner,
  type VerificationRunnerDeps,
} from "../financial-verification-runner.js";
import {
  CORRECTIVE_PROMPT,
  PATCH_OUTPUT_CONTRACT,
} from "../financial-verification-gate.js";

// 2026-08-27 — corroborated (lone percentage no longer fires).
const FINANCIAL = "The 10-year Treasury is yielding 4.25% right now on a 4.1% yield.";

function makeCapturingLogger(sink: Record<string, unknown>[]) {
  return pino(
    { level: "info" },
    {
      write(line: string) {
        try {
          sink.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // ignore
        }
      },
    },
  );
}

function verifyLines(sink: Record<string, unknown>[]) {
  return sink.filter((r) => r.tag === "phase999.63-verify");
}

function makeRunner(
  sink: Record<string, unknown>[],
  overrides: Partial<VerificationRunnerDeps> = {},
) {
  const dispatchCorrective = vi.fn(
    async (_a: string, _p: string, _s: AbortSignal) => "Verified: 4.31%.",
  );
  const postCorrectiveMessage = vi.fn(async () => {});
  const deps: VerificationRunnerDeps = {
    dispatchCorrective,
    recentToolCallNames: () => [],
    resolveConfig: () => ({ deferMs: 0 }),
    hasActiveTurn: () => false,
    postCorrectiveMessage,
    log: makeCapturingLogger(sink),
    ...overrides,
  };
  return {
    runner: new VerificationRunner(deps),
    dispatchCorrective:
      (overrides.dispatchCorrective as typeof dispatchCorrective) ??
      dispatchCorrective,
    postCorrectiveMessage,
  };
}

const BASE_ARGS = {
  agentName: "fin-research",
  channelId: "chan_1",
  response: FINANCIAL,
  verifyHopCount: 0,
  toolExecutionMs: 1_000,
  effortTier: "high",
};

describe("adaptive budget", () => {
  it("heavy turn (turnCostMs ≥ skip threshold) → telemetry skippedReason turn-cost, no dispatch", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, dispatchCorrective, postCorrectiveMessage } =
      makeRunner(sink);
    await runner.run({ ...BASE_ARGS, turnCostMs: 150_000 });
    expect(dispatchCorrective).not.toHaveBeenCalled();
    expect(postCorrectiveMessage).not.toHaveBeenCalled();
    const lines = verifyLines(sink);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({
      action: "re-prompt",
      skippedReason: "turn-cost",
      turnCostMs: 150_000,
      toolExecutionMs: 1_000,
      effortTier: "high",
    });
  });

  it("light turn → corrective dispatched with CORRECTIVE_PROMPT + correction posted", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, dispatchCorrective, postCorrectiveMessage } =
      makeRunner(sink);
    await runner.run({ ...BASE_ARGS, turnCostMs: 5_000 });
    expect(dispatchCorrective).toHaveBeenCalledTimes(1);
    // 999.63c — the hop prompt carries the replacement output contract.
    expect(dispatchCorrective.mock.calls[0]?.[1]).toBe(
      `${CORRECTIVE_PROMPT}\n\n${PATCH_OUTPUT_CONTRACT}`,
    );
    expect(postCorrectiveMessage).toHaveBeenCalledTimes(1);
    // Two lines: flagged original + corrective evaluation. No skippedReason.
    const lines = verifyLines(sink);
    expect(lines.length).toBe(2);
    expect(lines[0]?.skippedReason).toBeUndefined();
  });

  it("moderate turn → shrink: effort dropped to low for the hop, restored after", async () => {
    const sink: Record<string, unknown>[] = [];
    const effortLog: string[] = [];
    let effort = "high";
    const { runner, dispatchCorrective } = makeRunner(sink, {
      getEffort: () => effort as never,
      setEffort: (_a, level) => {
        effort = level;
        effortLog.push(level);
      },
      dispatchCorrective: vi.fn(async () => {
        effortLog.push(`dispatch@${effort}`);
        return "Verified: 4.31%.";
      }),
    });
    await runner.run({ ...BASE_ARGS, turnCostMs: 60_000 });
    expect(dispatchCorrective).toHaveBeenCalledTimes(1);
    // Set low → dispatched at low → restored to high.
    expect(effortLog).toEqual(["low", "dispatch@low", "high"]);
  });

  it("shrink restores effort even when the corrective dispatch throws", async () => {
    const sink: Record<string, unknown>[] = [];
    let effort = "high";
    const { runner } = makeRunner(sink, {
      getEffort: () => effort as never,
      setEffort: (_a, level) => {
        effort = level;
      },
      dispatchCorrective: vi.fn(async () => {
        throw new Error("corrective boom");
      }),
    });
    await runner.run({ ...BASE_ARGS, turnCostMs: 60_000 });
    expect(effort).toBe("high");
    // Fail-open: error line emitted.
    expect(verifyLines(sink).some((l) => l.action === "error")).toBe(true);
  });

  it("maxVerifyHops 0 → skippedReason hops-disabled and action hop-exhausted", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, dispatchCorrective } = makeRunner(sink, {
      resolveConfig: () => ({ maxVerifyHops: 0, deferMs: 0 }),
    });
    await runner.run({ ...BASE_ARGS, turnCostMs: 5_000 });
    expect(dispatchCorrective).not.toHaveBeenCalled();
    const lines = verifyLines(sink);
    expect(lines.length).toBe(1);
    // With hops 0 the gate itself classifies hop-exhausted (telemetry-only
    // mode) — the budget's hops-disabled skip never surfaces because the
    // action is not re-prompt.
    expect(lines[0]?.action).toBe("hop-exhausted");
  });
});

describe("yield mechanism", () => {
  it("traffic during the defer window → skippedReason user-traffic, no dispatch", async () => {
    const sink: Record<string, unknown>[] = [];
    let runnerRef: VerificationRunner | undefined;
    const { runner, dispatchCorrective } = makeRunner(sink, {
      resolveConfig: () => ({ deferMs: 5 }),
      sleep: async () => {
        // A user message lands while the hop is deferred.
        runnerRef?.notifyIncomingTurn("fin-research");
      },
    });
    runnerRef = runner;
    await runner.run({ ...BASE_ARGS, turnCostMs: 5_000 });
    expect(dispatchCorrective).not.toHaveBeenCalled();
    const lines = verifyLines(sink);
    expect(lines.length).toBe(2);
    expect(lines[1]).toMatchObject({
      action: "re-prompt",
      skippedReason: "user-traffic",
    });
  });

  it("agent already has an active turn after the defer → user-traffic skip", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, dispatchCorrective } = makeRunner(sink, {
      hasActiveTurn: () => true,
    });
    await runner.run({ ...BASE_ARGS, turnCostMs: 5_000 });
    expect(dispatchCorrective).not.toHaveBeenCalled();
    expect(
      verifyLines(sink).some((l) => l.skippedReason === "user-traffic"),
    ).toBe(true);
  });

  it("notifyIncomingTurn mid-hop → abort → user-traffic-abort, no correction post", async () => {
    const sink: Record<string, unknown>[] = [];
    let runnerRef: VerificationRunner | undefined;
    const { runner, postCorrectiveMessage } = makeRunner(sink, {
      dispatchCorrective: vi.fn(async (_a, _p, signal: AbortSignal) => {
        // Simulate a user message arriving while the hop is in flight:
        // the entry hook aborts, and the session layer rejects like
        // iterateUntilResult does on an interrupt.
        runnerRef?.notifyIncomingTurn("fin-research");
        expect(signal.aborted).toBe(true);
        throw new Error("Aborted: interrupt deadline exceeded");
      }),
    });
    runnerRef = runner;
    await runner.run({ ...BASE_ARGS, turnCostMs: 5_000 });
    expect(postCorrectiveMessage).not.toHaveBeenCalled();
    const lines = verifyLines(sink);
    expect(lines[1]).toMatchObject({ skippedReason: "user-traffic-abort" });
    // Fail-open — no error line for an intentional abort.
    expect(lines.every((l) => l.action !== "error")).toBe(true);
  });
});

describe("telemetry shape", () => {
  it("legacy fields byte-identical + additive fields present on every line", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner } = makeRunner(sink);
    await runner.run({ ...BASE_ARGS, turnCostMs: 5_000 });
    const lines = verifyLines(sink);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // Legacy contract (ops grep-gates depend on these).
      expect(line).toHaveProperty("agent");
      expect(line).toHaveProperty("financialTokensDetected");
      expect(line).toHaveProperty("verificationToolsCalled");
      expect(line).toHaveProperty("action");
      // Additive riders.
      expect(line).toHaveProperty("turnCostMs");
      expect(line).toHaveProperty("toolExecutionMs");
      expect(line).toHaveProperty("effortTier");
    }
  });

  it("non-enforced agent → zero lines, zero work", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, dispatchCorrective } = makeRunner(sink);
    await runner.run({ ...BASE_ARGS, agentName: "admin-clawdy", turnCostMs: 5 });
    expect(dispatchCorrective).not.toHaveBeenCalled();
    expect(verifyLines(sink).length).toBe(0);
  });
});
