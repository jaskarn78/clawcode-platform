/**
 * C (2026-08-26) — pre-delivery hold mode tests
 * (VerificationRunner.preDeliveryVerify + post-hoc dedupe).
 * Fixture style: verbatim prod strings (2026-08-26 Vallejos incident).
 */

import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import {
  VerificationRunner,
  type VerificationRunnerDeps,
} from "../financial-verification-runner.js";
import {
  NO_CORRECTION_NEEDED,
  RULE_CORRECTION_PREFIX,
} from "../financial-verification-gate.js";

/** Verbatim incident rollover claim — rules-class, NO figure shapes. */
const RULES_ONLY =
  "Once you separate from Acme Corp, we open a Schwab Rollover IRA and " +
  "transfer the 401(k) in kind. Nothing is sold, no tax event is " +
  "triggered, and the old account closes itself when the transfer " +
  "completes. Your only step is signing.";

const CLEAN_DRAFT = "Meeting confirmed for 7 PM tonight. See you there.";

const PATCH_REPLY = [
  "```json",
  JSON.stringify([
    {
      find: "Once you separate from Acme Corp, we open",
      replace: "In-service at 59½ applies — no separation needed. We open",
      source: "https://www.irs.gov/retirement-plans/plan-participant-employee/401k-resource-guide-plan-participants-general-distribution-rules",
    },
  ]),
  "```",
].join("\n");
const PATCHED = RULES_ONLY.replace(
  "Once you separate from Acme Corp, we open",
  "In-service at 59½ applies — no separation needed. We open",
);

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

const verifyLines = (sink: Record<string, unknown>[]) =>
  sink.filter((r) => r.tag === "phase999.63-verify");

/** Hold-enabled agent config: rules class ENFORCED (hop 1), fast knobs. */
const HOLD_CFG = {
  deferMs: 0,
  holdDelivery: true,
  holdTimeoutMs: 5_000,
  ruleClaims: { maxVerifyHops: 1 },
};

function makeRunner(
  sink: Record<string, unknown>[],
  overrides: Partial<VerificationRunnerDeps> = {},
) {
  const dispatchCorrective = vi.fn(
    async (_a: string, _p: string, _s: AbortSignal) => PATCH_REPLY,
  );
  const postCorrectiveMessage = vi.fn(
    async (_args: {
      agentName: string;
      channelId: string | null;
      text: string;
    }) => {},
  );
  const deps: VerificationRunnerDeps = {
    dispatchCorrective,
    recentToolCallNames: () => [],
    resolveConfig: () => HOLD_CFG,
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

const BASE = {
  agentName: "fin-client",
  channelId: "chan_1",
  turnId: "discord:777",
  turnCostMs: 5_000,
  toolExecutionMs: 1_000,
  effortTier: "high",
};

describe("preDeliveryVerify — clean fast path", () => {
  it("unflagged draft → verdict clean, original text, zero hop dispatch", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, dispatchCorrective } = makeRunner(sink);
    const res = await runner.preDeliveryVerify({ ...BASE, response: CLEAN_DRAFT });
    expect(res).toEqual({ finalText: CLEAN_DRAFT, verdict: "clean" });
    expect(dispatchCorrective).not.toHaveBeenCalled();
    const lines = verifyLines(sink);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      deliveryMode: "hold",
      holdVerdict: "clean",
    });
  });

  it("non-hold agent → clean passthrough, NO mark, NO telemetry, post-hoc unaffected", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, dispatchCorrective } = makeRunner(sink, {
      resolveConfig: () => ({ deferMs: 0, ruleClaims: { maxVerifyHops: 1 } }),
    });
    const res = await runner.preDeliveryVerify({ ...BASE, response: RULES_ONLY });
    expect(res.verdict).toBe("clean");
    expect(res.finalText).toBe(RULES_ONLY);
    expect(verifyLines(sink)).toHaveLength(0);
    // Post-hoc run() proceeds normally (no mark was set) — hop dispatches.
    await runner.run({ ...BASE, response: RULES_ONLY, verifyHopCount: 0 });
    expect(dispatchCorrective).toHaveBeenCalledTimes(1);
  });
});

describe("preDeliveryVerify — corrected", () => {
  it("flagged + patch reply → PATCHED finalText, no followUpPost, hop at low effort", async () => {
    const sink: Record<string, unknown>[] = [];
    const effortLog: string[] = [];
    let effort = "high";
    const { runner } = makeRunner(sink, {
      getEffort: () => effort as never,
      setEffort: (_a, level) => {
        effort = level;
        effortLog.push(level);
      },
      dispatchCorrective: vi.fn(async () => {
        effortLog.push(`dispatch@${effort}`);
        return PATCH_REPLY;
      }),
    });
    const res = await runner.preDeliveryVerify({ ...BASE, response: RULES_ONLY });
    expect(res.verdict).toBe("corrected");
    expect(res.finalText).toBe(PATCHED);
    expect(res.followUpPost).toBeUndefined();
    expect(effortLog).toEqual(["low", "dispatch@low", "high"]);
    const lines = verifyLines(sink);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      deliveryMode: "hold",
      holdVerdict: "corrected",
      correctionMode: "patch",
      patchOps: 1,
    });
  });

  it("flagged + prose reply → original finalText + followUpPost prefix+raw", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner } = makeRunner(sink, {
      dispatchCorrective: vi.fn(async () => "Per IRS.gov, corrected."),
    });
    const res = await runner.preDeliveryVerify({ ...BASE, response: RULES_ONLY });
    expect(res.verdict).toBe("corrected");
    expect(res.finalText).toBe(RULES_ONLY);
    expect(res.followUpPost).toBe(
      `${RULE_CORRECTION_PREFIX}Per IRS.gov, corrected.`,
    );
    expect(verifyLines(sink)[0]?.correctionMode).toBe("raw-fallback");
  });

  it("flagged + op-miss patch → original finalText + compact-note followUpPost", async () => {
    const sink: Record<string, unknown>[] = [];
    const missReply =
      "```json\n" +
      JSON.stringify([{ find: "not in the draft", replace: "x", source: "irs.gov" }]) +
      "\n```";
    const { runner } = makeRunner(sink, {
      dispatchCorrective: vi.fn(async () => missReply),
    });
    const res = await runner.preDeliveryVerify({ ...BASE, response: RULES_ONLY });
    expect(res.verdict).toBe("corrected");
    expect(res.finalText).toBe(RULES_ONLY);
    expect(res.followUpPost?.startsWith(RULE_CORRECTION_PREFIX)).toBe(true);
    expect(res.followUpPost).toContain("→");
    expect(verifyLines(sink)[0]?.correctionMode).toBe("note-fallback");
  });

  it("sentinel reply → clean verdict + falsePositiveAck line", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner } = makeRunner(sink, {
      dispatchCorrective: vi.fn(async () => NO_CORRECTION_NEEDED),
    });
    const res = await runner.preDeliveryVerify({ ...BASE, response: RULES_ONLY });
    expect(res).toEqual({ finalText: RULES_ONLY, verdict: "clean" });
    expect(verifyLines(sink)[0]).toMatchObject({
      falsePositiveAck: true,
      holdVerdict: "clean",
    });
  });
});

describe("preDeliveryVerify — timeout + error fail-open", () => {
  it("hop exceeding holdTimeoutMs → verdict timeout, original delivered, backstop re-armed", async () => {
    const sink: Record<string, unknown>[] = [];
    let call = 0;
    const dispatchCorrective = vi.fn(
      (_a: string, _p: string, signal: AbortSignal) => {
        call += 1;
        if (call === 1) {
          // Hold hop: hang until the timeout aborts us.
          return new Promise<string>((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          });
        }
        // Backstop hop: resolve as prose (raw-fallback post).
        return Promise.resolve("Per IRS.gov, corrected.");
      },
    );
    const { runner, postCorrectiveMessage } = makeRunner(sink, {
      resolveConfig: () => ({ ...HOLD_CFG, holdTimeoutMs: 25 }),
      dispatchCorrective,
    });
    const res = await runner.preDeliveryVerify({ ...BASE, response: RULES_ONLY });
    expect(res.verdict).toBe("timeout");
    expect(res.finalText).toBe(RULES_ONLY);
    expect(
      verifyLines(sink).some((l) => l.holdVerdict === "timeout"),
    ).toBe(true);
    // The void backstop run() re-dispatches and posts the correction.
    await vi.waitFor(() => {
      expect(postCorrectiveMessage).toHaveBeenCalledTimes(1);
    });
    expect(dispatchCorrective).toHaveBeenCalledTimes(2);
  });

  it("internal throw → verdict error, original delivered (fail-open)", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner } = makeRunner(sink, {
      recentToolCallNames: () => {
        throw new Error("trace boom");
      },
    });
    const res = await runner.preDeliveryVerify({ ...BASE, response: RULES_ONLY });
    expect(res.verdict).toBe("error");
    expect(res.finalText).toBe(RULES_ONLY);
  });
});

describe("post-hoc dedupe (pre-delivery-handled)", () => {
  it("after a hold handled the turn, run() with the same turnId skips without dispatching", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, dispatchCorrective } = makeRunner(sink);
    const res = await runner.preDeliveryVerify({ ...BASE, response: RULES_ONLY });
    expect(res.verdict).toBe("corrected");
    expect(dispatchCorrective).toHaveBeenCalledTimes(1);
    await runner.run({ ...BASE, response: RULES_ONLY, verifyHopCount: 0 });
    // No SECOND hop — the epilogue-fired post-hoc run saw the mark.
    expect(dispatchCorrective).toHaveBeenCalledTimes(1);
    expect(
      verifyLines(sink).some((l) => l.skippedReason === "pre-delivery-handled"),
    ).toBe(true);
  });

  it("marks are single-shot: a LATER turn with the same id is not suppressed", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, dispatchCorrective } = makeRunner(sink);
    await runner.preDeliveryVerify({ ...BASE, response: RULES_ONLY });
    await runner.run({ ...BASE, response: RULES_ONLY, verifyHopCount: 0 }); // consumes mark
    await runner.run({ ...BASE, response: RULES_ONLY, verifyHopCount: 0 }); // fresh run
    // hold hop (1) + second post-hoc run's hop (2).
    expect(dispatchCorrective).toHaveBeenCalledTimes(2);
  });
});
