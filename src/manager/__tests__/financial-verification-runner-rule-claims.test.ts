/**
 * 999.63b — VerificationRunner tests for the RULES class.
 *
 * Mirrors the existing runner test's fixture style (capturing pino sink,
 * verifyLines helper). Pins: shadow emits telemetry without dispatch;
 * enforced rules-only dispatches ONE hop with RULE_CORRECTIVE_PROMPT and
 * posts with RULE_CORRECTION_PREFIX; combined uses the merged prompt +
 * combined prefix; the sentinel suppresses the post; yield abort still
 * fails open; legacy telemetry keys survive unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  VerificationRunner,
  type VerificationRunnerDeps,
} from "../financial-verification-runner.js";
import {
  CORRECTIVE_PROMPT,
  RULE_CORRECTIVE_PROMPT,
  RULE_CORRECTION_PREFIX,
  COMBINED_CORRECTION_PREFIX,
  NO_CORRECTION_NEEDED,
  PATCH_OUTPUT_CONTRACT,
  RULE_CORRECTION_EDIT_FOOTER,
} from "../financial-verification-gate.js";

/** Verbatim incident rollover claim — rules-class, NO figure shapes. */
const RULES_ONLY =
  "Once you separate from Acme Corp, we open a Schwab Rollover IRA and " +
  "transfer the 401(k) in kind. Nothing is sold, no tax event is " +
  "triggered, and the old account closes itself when the transfer " +
  "completes. Your only step is signing.";

// 2026-08-27 — a lone percentage no longer fires; `yield` corroborates it.
const FIGURES_ONLY = "The 10-year Treasury yield is 4.25% right now.";

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
    async (_a: string, _p: string, _s: AbortSignal) =>
      "Per IRS.gov, verified and corrected.",
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
  agentName: "fin-client",
  channelId: "chan_1",
  verifyHopCount: 0,
  turnCostMs: 5_000,
  toolExecutionMs: 1_000,
  effortTier: "high",
};

describe("fleet-default shadow (ruleClaims.maxVerifyHops 0)", () => {
  it("rules-only draft → one telemetry line, ruleAction hop-exhausted, no dispatch", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, dispatchCorrective, postCorrectiveMessage } =
      makeRunner(sink);
    await runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    expect(dispatchCorrective).not.toHaveBeenCalled();
    expect(postCorrectiveMessage).not.toHaveBeenCalled();
    const lines = verifyLines(sink);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({
      action: "none",
      ruleAction: "hop-exhausted",
      claimClasses: ["rules"],
    });
    expect(
      (lines[0]?.ruleTokensDetected as unknown[]).length,
    ).toBeGreaterThan(0);
  });
});

describe("enforced rules class (ruleClaims.maxVerifyHops 1)", () => {
  const enforced = () => ({
    deferMs: 0,
    ruleClaims: { maxVerifyHops: 1 },
  });

  it("rules-only draft → ONE hop with RULE_CORRECTIVE_PROMPT, posted with RULE_CORRECTION_PREFIX", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, dispatchCorrective, postCorrectiveMessage } = makeRunner(
      sink,
      { resolveConfig: enforced },
    );
    await runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    expect(dispatchCorrective).toHaveBeenCalledTimes(1);
    // 999.63c — the hop prompt now carries the replacement output contract.
    expect(dispatchCorrective.mock.calls[0]?.[1]).toBe(
      `${RULE_CORRECTIVE_PROMPT}\n\n${PATCH_OUTPUT_CONTRACT}`,
    );
    expect(postCorrectiveMessage).toHaveBeenCalledTimes(1);
    const posted = postCorrectiveMessage.mock.calls[0]![0];
    expect(posted.text.startsWith(RULE_CORRECTION_PREFIX)).toBe(true);
  });

  it("unrelated WebSearch in the turn does NOT satisfy the rules class (incident pin)", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, dispatchCorrective } = makeRunner(sink, {
      resolveConfig: enforced,
      recentToolCallNames: () => ["WebSearch", "WebSearch"],
    });
    await runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    expect(dispatchCorrective).toHaveBeenCalledTimes(1);
    const lines = verifyLines(sink);
    expect(lines[0]).toMatchObject({ action: "none", ruleAction: "re-prompt" });
  });

  it("combined draft → ONE hop with the merged prompt + combined prefix", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, dispatchCorrective, postCorrectiveMessage } = makeRunner(
      sink,
      { resolveConfig: enforced },
    );
    await runner.run({
      ...BASE_ARGS,
      response: `${RULES_ONLY}\n\n${FIGURES_ONLY}`,
    });
    expect(dispatchCorrective).toHaveBeenCalledTimes(1);
    const prompt = dispatchCorrective.mock.calls[0]?.[1] as string;
    expect(prompt).toContain(CORRECTIVE_PROMPT);
    expect(prompt).toContain(RULE_CORRECTIVE_PROMPT);
    const posted = postCorrectiveMessage.mock.calls[0]![0];
    expect(posted.text.startsWith(COMBINED_CORRECTION_PREFIX)).toBe(true);
  });

  it("NO_CORRECTION_NEEDED sentinel → no post, falsePositiveAck line", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, postCorrectiveMessage } = makeRunner(sink, {
      resolveConfig: enforced,
      dispatchCorrective: vi.fn(async () => NO_CORRECTION_NEEDED),
    });
    await runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    expect(postCorrectiveMessage).not.toHaveBeenCalled();
    expect(
      verifyLines(sink).some((l) => l.falsePositiveAck === true),
    ).toBe(true);
  });

  it("notifyIncomingTurn mid-rules-hop → user-traffic-abort, no post", async () => {
    const sink: Record<string, unknown>[] = [];
    let runnerRef: VerificationRunner | undefined;
    const { runner, postCorrectiveMessage } = makeRunner(sink, {
      resolveConfig: enforced,
      dispatchCorrective: vi.fn(async (_a, _p, signal: AbortSignal) => {
        runnerRef?.notifyIncomingTurn("fin-client");
        expect(signal.aborted).toBe(true);
        throw new Error("Aborted: interrupt deadline exceeded");
      }),
    });
    runnerRef = runner;
    await runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    expect(postCorrectiveMessage).not.toHaveBeenCalled();
    const lines = verifyLines(sink);
    expect(lines[1]).toMatchObject({ skippedReason: "user-traffic-abort" });
    expect(lines.every((l) => l.action !== "error")).toBe(true);
  });

  it("corrective reply containing rule claims is re-evaluated at hop 1 — never loops", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, dispatchCorrective } = makeRunner(sink, {
      resolveConfig: enforced,
      // The reply itself asserts a rule — the hop-1 evaluation must land
      // hop-exhausted, not another re-prompt.
      dispatchCorrective: vi.fn(
        async () => "You must take the RMD from the IRA by April 1.",
      ),
    });
    await runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    expect(dispatchCorrective).toHaveBeenCalledTimes(1);
    const lines = verifyLines(sink);
    expect(lines.length).toBe(2);
    expect(lines[1]).toMatchObject({ ruleAction: "hop-exhausted" });
  });
});

describe("telemetry compat", () => {
  it("legacy keys unchanged + 999.63b keys present on every line", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner } = makeRunner(sink, {
      resolveConfig: () => ({ deferMs: 0, ruleClaims: { maxVerifyHops: 1 } }),
    });
    await runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    const lines = verifyLines(sink);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // Legacy contract (ops grep-gates depend on these).
      expect(line).toHaveProperty("agent");
      expect(line).toHaveProperty("financialTokensDetected");
      expect(line).toHaveProperty("verificationToolsCalled");
      expect(line).toHaveProperty("action");
      expect(line).toHaveProperty("turnCostMs");
      expect(line).toHaveProperty("toolExecutionMs");
      expect(line).toHaveProperty("effortTier");
      // 999.63b additive riders.
      expect(line).toHaveProperty("ruleTokensDetected");
      expect(line).toHaveProperty("ruleAction");
      expect(line).toHaveProperty("claimClasses");
    }
  });

  it("figures-only behavior is unchanged with rules in fleet-default shadow", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, dispatchCorrective, postCorrectiveMessage } =
      makeRunner(sink);
    await runner.run({ ...BASE_ARGS, response: FIGURES_ONLY });
    // Figures class still enforces at its default maxVerifyHops 1.
    expect(dispatchCorrective).toHaveBeenCalledTimes(1);
    expect(postCorrectiveMessage).toHaveBeenCalledTimes(1);
    const lines = verifyLines(sink);
    expect(lines[0]).toMatchObject({ action: "re-prompt", ruleAction: "none" });
  });
});

// ---------------------------------------------------------------------------
// 999.63c — correction delivery matrix (edit-in-place vs fallback post).
// ---------------------------------------------------------------------------
describe("999.63c correction delivery", () => {
  const enforced = () => ({
    deferMs: 0,
    ruleClaims: { maxVerifyHops: 1 },
  });

  type ApplyEditArgs = {
    agentName: string;
    channelId: string | null;
    turnId: string | null;
    originalResponse: string;
    correctedText: string;
    fallbackText: string;
    footer: string;
  };

  /** B — patch-contract hop reply whose single op applies to RULES_ONLY. */
  const PATCH_REPLY = [
    "```json",
    JSON.stringify([
      {
        find: "Once you separate from Acme Corp, we open",
        replace: "You do not have to separate — in-service at 59½ applies. We open",
        source: "https://www.irs.gov/retirement-plans/plan-participant-employee/401k-resource-guide-plan-participants-general-distribution-rules",
      },
    ]),
    "```",
  ].join("\n");
  const PATCHED_RULES_ONLY = RULES_ONLY.replace(
    "Once you separate from Acme Corp, we open",
    "You do not have to separate — in-service at 59½ applies. We open",
  );

  it("patch reply + applyCorrectiveEdit wired → edit path with PATCHED text; legacy post NOT called", async () => {
    const sink: Record<string, unknown>[] = [];
    const applyCorrectiveEdit = vi.fn(
      async (_args: ApplyEditArgs) => "edit" as const,
    );
    const { runner, postCorrectiveMessage } = makeRunner(sink, {
      resolveConfig: enforced,
      applyCorrectiveEdit,
      dispatchCorrective: vi.fn(async () => PATCH_REPLY),
    });
    await runner.run({ ...BASE_ARGS, response: RULES_ONLY, turnId: "discord:111" });
    expect(applyCorrectiveEdit).toHaveBeenCalledTimes(1);
    const call = applyCorrectiveEdit.mock.calls[0]![0]!;
    expect(call).toMatchObject({
      agentName: "fin-client",
      channelId: "chan_1",
      turnId: "discord:111",
      originalResponse: RULES_ONLY,
      // B — the edit shows the locally PATCHED draft, not the hop reply.
      correctedText: PATCHED_RULES_ONLY,
      footer: RULE_CORRECTION_EDIT_FOOTER,
    });
    // B — the fallback text is the COMPACT note, not the full text.
    expect(call.fallbackText.startsWith(RULE_CORRECTION_PREFIX)).toBe(true);
    expect(call.fallbackText).toContain("→");
    expect(postCorrectiveMessage).not.toHaveBeenCalled();
    const withDelivery = verifyLines(sink).filter(
      (l) => l.correctionDelivery !== undefined,
    );
    expect(withDelivery.length).toBe(1);
    expect(withDelivery[0]?.correctionDelivery).toBe("edit");
    expect(withDelivery[0]?.correctionMode).toBe("patch");
    expect(withDelivery[0]?.patchOps).toBe(1);
  });

  it("patch reply + internal edit fallback → correctionDelivery 'post-fallback'", async () => {
    const sink: Record<string, unknown>[] = [];
    const applyCorrectiveEdit = vi.fn(
      async (_args: ApplyEditArgs) => "post" as const,
    );
    const { runner } = makeRunner(sink, {
      resolveConfig: enforced,
      applyCorrectiveEdit,
      dispatchCorrective: vi.fn(async () => PATCH_REPLY),
    });
    await runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    // turnId omitted → null reaches the closure (no ref can ever match).
    expect(applyCorrectiveEdit.mock.calls[0]![0]!.turnId).toBeNull();
    const withDelivery = verifyLines(sink).filter(
      (l) => l.correctionDelivery !== undefined,
    );
    expect(withDelivery[0]?.correctionDelivery).toBe("post-fallback");
    expect(withDelivery[0]?.correctionMode).toBe("patch");
  });

  it("B: patch parses but an op misses the draft → note-fallback posts compact note, edit NEVER invoked", async () => {
    const sink: Record<string, unknown>[] = [];
    const applyCorrectiveEdit = vi.fn(
      async (_args: ApplyEditArgs) => "edit" as const,
    );
    const missReply =
      "```json\n" +
      JSON.stringify([
        { find: "text that is not in the draft", replace: "x", source: "irs.gov" },
      ]) +
      "\n```";
    const { runner, postCorrectiveMessage } = makeRunner(sink, {
      resolveConfig: enforced,
      applyCorrectiveEdit,
      dispatchCorrective: vi.fn(async () => missReply),
    });
    await runner.run({ ...BASE_ARGS, response: RULES_ONLY, turnId: "discord:111" });
    expect(applyCorrectiveEdit).not.toHaveBeenCalled();
    expect(postCorrectiveMessage).toHaveBeenCalledTimes(1);
    const posted = postCorrectiveMessage.mock.calls[0]![0];
    expect(posted.text.startsWith(RULE_CORRECTION_PREFIX)).toBe(true);
    expect(posted.text).toContain("→");
    const withDelivery = verifyLines(sink).filter(
      (l) => l.correctionDelivery !== undefined,
    );
    expect(withDelivery[0]?.correctionMode).toBe("note-fallback");
    expect(withDelivery[0]?.correctionDelivery).toBe("post-fallback");
  });

  it("B: prose reply (contract ignored) → raw-fallback posts prefix + raw, edit NEVER invoked", async () => {
    const sink: Record<string, unknown>[] = [];
    const applyCorrectiveEdit = vi.fn(
      async (_args: ApplyEditArgs) => "edit" as const,
    );
    const { runner, postCorrectiveMessage } = makeRunner(sink, {
      resolveConfig: enforced,
      applyCorrectiveEdit,
    });
    await runner.run({ ...BASE_ARGS, response: RULES_ONLY, turnId: "discord:111" });
    expect(applyCorrectiveEdit).not.toHaveBeenCalled();
    expect(postCorrectiveMessage).toHaveBeenCalledTimes(1);
    const posted = postCorrectiveMessage.mock.calls[0]![0];
    expect(posted.text).toBe(
      `${RULE_CORRECTION_PREFIX}Per IRS.gov, verified and corrected.`,
    );
    const withDelivery = verifyLines(sink).filter(
      (l) => l.correctionDelivery !== undefined,
    );
    expect(withDelivery[0]?.correctionMode).toBe("raw-fallback");
  });

  it("applyCorrectiveEdit UNWIRED → legacy post path byte-identical, correctionDelivery 'post-unwired'", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner, postCorrectiveMessage } = makeRunner(sink, {
      resolveConfig: enforced,
    });
    await runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    expect(postCorrectiveMessage).toHaveBeenCalledTimes(1);
    const posted = postCorrectiveMessage.mock.calls[0]![0];
    expect(posted.text.startsWith(RULE_CORRECTION_PREFIX)).toBe(true);
    const withDelivery = verifyLines(sink).filter(
      (l) => l.correctionDelivery !== undefined,
    );
    expect(withDelivery[0]?.correctionDelivery).toBe("post-unwired");
  });

  it("sentinel reply → applyCorrectiveEdit never invoked, no correctionDelivery rider", async () => {
    const sink: Record<string, unknown>[] = [];
    const applyCorrectiveEdit = vi.fn(async () => "edit" as const);
    const { runner } = makeRunner(sink, {
      resolveConfig: enforced,
      applyCorrectiveEdit,
      dispatchCorrective: vi.fn(async () => NO_CORRECTION_NEEDED),
    });
    await runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    expect(applyCorrectiveEdit).not.toHaveBeenCalled();
    expect(
      verifyLines(sink).every((l) => l.correctionDelivery === undefined),
    ).toBe(true);
  });

  it("throwing delivery closure never suppresses the hop-1 telemetry line", async () => {
    const sink: Record<string, unknown>[] = [];
    const { runner } = makeRunner(sink, {
      resolveConfig: enforced,
      applyCorrectiveEdit: vi.fn(async () => {
        throw new Error("bridge exploded");
      }),
    });
    await runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    const lines = verifyLines(sink);
    // Line 0: epilogue evaluation; line 1: hop-1 evaluation (still emitted).
    expect(lines.length).toBe(2);
    expect(lines.every((l) => l.action !== "error")).toBe(true);
  });
});
