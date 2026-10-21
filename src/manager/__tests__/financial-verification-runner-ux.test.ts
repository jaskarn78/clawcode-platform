/**
 * 999.63d — runner tests for the verify-behind pending marker and the
 * ✅ verified-inline badge. Same harness shape as the rule-claims runner
 * test (capturing pino sink, DI mocks). Pins the full marker state
 * machine (edit / restored / verified-clean / aborted / skipped-no-ref),
 * the badge eligibility matrix, and the byte-compat shield (ux off or
 * deps unwired ⇒ zero calls, no new telemetry keys).
 */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  VerificationRunner,
  type VerificationRunnerDeps,
  type ResolvedVerificationConfig,
} from "../financial-verification-runner.js";
import { NO_CORRECTION_NEEDED } from "../financial-verification-gate.js";

/** Verbatim incident rollover claim — rules-class, NO figure shapes. */
const RULES_ONLY =
  "Once you separate from Acme Corp, we open a Schwab Rollover IRA and " +
  "transfer the 401(k) in kind. Nothing is sold, no tax event is " +
  "triggered, and the old account closes itself when the transfer " +
  "completes. Your only step is signing.";

/** Rule pair fully suppressed by an in-segment primary-source citation. */
const CITED_ONLY =
  "You cannot pledge IRA assets as collateral per " +
  "https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-prohibited-transactions.";

// 2026-08-27 — a lone percentage no longer fires; `yield` corroborates it.
const FIGURES_ONLY = "The 10-year Treasury yield is 4.25% right now.";

const PATCH_REPLY =
  '```json\n[{"find":"separate from Acme Corp","replace":"reach 59½",' +
  '"source":"https://www.irs.gov/x"}]\n```';

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

const flush = () => new Promise((r) => setImmediate(r));

const MARKER_CFG: ResolvedVerificationConfig = {
  deferMs: 0,
  ruleClaims: { enabled: true, maxVerifyHops: 1 },
  ux: { pendingMarker: true },
};

function makeRunner(
  sink: Record<string, unknown>[],
  cfg: ResolvedVerificationConfig,
  overrides: Partial<VerificationRunnerDeps> = {},
) {
  const dispatchCorrective = vi.fn(
    async (_a: string, _p: string, _s: AbortSignal) => PATCH_REPLY,
  );
  const postCorrectiveMessage = vi.fn(async () => {});
  const applyCorrectiveEdit = vi.fn(async () => "edit" as const);
  const appendPendingMarker = vi.fn(async () => ({
    messageId: "m1",
    channelId: "c1",
  }));
  const removePendingMarker = vi.fn(async () => {});
  const applyVerifiedBadge = vi.fn(async () => {});
  const deps: VerificationRunnerDeps = {
    dispatchCorrective,
    recentToolCallNames: () => [],
    resolveConfig: () => cfg,
    hasActiveTurn: () => false,
    postCorrectiveMessage,
    applyCorrectiveEdit,
    appendPendingMarker,
    removePendingMarker,
    applyVerifiedBadge,
    sleep: async () => {},
    log: makeCapturingLogger(sink),
    ...overrides,
  };
  return {
    runner: new VerificationRunner(deps),
    dispatchCorrective,
    postCorrectiveMessage,
    applyCorrectiveEdit,
    appendPendingMarker,
    removePendingMarker,
    applyVerifiedBadge,
  };
}

const BASE_ARGS = {
  agentName: "fin-client",
  channelId: "chan_1",
  turnId: "discord:123",
  verifyHopCount: 0,
  turnCostMs: 5_000,
  toolExecutionMs: 1_000,
  effortTier: "high",
};

describe("byte-compat shield — ux off / deps unwired", () => {
  it("ux absent ⇒ marker+badge deps never called, no new telemetry keys", async () => {
    const sink: Record<string, unknown>[] = [];
    const h = makeRunner(sink, {
      deferMs: 0,
      ruleClaims: { enabled: true, maxVerifyHops: 1 },
    });
    await h.runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    await flush();
    expect(h.appendPendingMarker).not.toHaveBeenCalled();
    expect(h.removePendingMarker).not.toHaveBeenCalled();
    expect(h.applyVerifiedBadge).not.toHaveBeenCalled();
    for (const line of verifyLines(sink)) {
      expect(line).not.toHaveProperty("markerOutcome");
      expect(line).not.toHaveProperty("verifiedBadge");
    }
  });

  it("ux on but deps unwired ⇒ nothing fires, hop still runs", async () => {
    const sink: Record<string, unknown>[] = [];
    const h = makeRunner(
      sink,
      { ...MARKER_CFG, ux: { pendingMarker: true, verifiedBadge: true } },
      {
        appendPendingMarker: undefined,
        removePendingMarker: undefined,
        applyVerifiedBadge: undefined,
      },
    );
    await h.runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    await flush();
    expect(h.dispatchCorrective).toHaveBeenCalledTimes(1);
    for (const line of verifyLines(sink)) {
      expect(line).not.toHaveProperty("markerOutcome");
    }
  });
});

describe("pending-marker state machine", () => {
  it("append fires after the skip paths and BEFORE the hop dispatch", async () => {
    const sink: Record<string, unknown>[] = [];
    const h = makeRunner(sink, MARKER_CFG);
    await h.runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    expect(h.appendPendingMarker).toHaveBeenCalledTimes(1);
    const appendOrder = h.appendPendingMarker.mock.invocationCallOrder[0]!;
    const dispatchOrder = h.dispatchCorrective.mock.invocationCallOrder[0]!;
    expect(appendOrder).toBeLessThan(dispatchOrder);
  });

  it("patch → edit: marker consumed by the content replacement (no removal)", async () => {
    const sink: Record<string, unknown>[] = [];
    const h = makeRunner(sink, MARKER_CFG);
    await h.runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    expect(h.applyCorrectiveEdit).toHaveBeenCalledTimes(1);
    expect(h.removePendingMarker).not.toHaveBeenCalled();
    const final = verifyLines(sink).at(-1);
    expect(final).toMatchObject({ markerOutcome: "edit" });
  });

  it("patch → post fallback: marker restored (verified:false)", async () => {
    const sink: Record<string, unknown>[] = [];
    const h = makeRunner(sink, MARKER_CFG, {
      applyCorrectiveEdit: vi.fn(async () => "post" as const),
    });
    await h.runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    await flush();
    expect(h.removePendingMarker).toHaveBeenCalledWith({
      agentName: "fin-client",
      messageId: "m1",
      channelId: "c1",
      verified: false,
    });
    expect(verifyLines(sink).at(-1)).toMatchObject({
      markerOutcome: "restored",
    });
  });

  it("raw-fallback (prose reply): marker restored", async () => {
    const sink: Record<string, unknown>[] = [];
    const h = makeRunner(sink, MARKER_CFG, {
      dispatchCorrective: vi.fn(async () => "Non-conforming prose reply."),
    });
    await h.runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    await flush();
    expect(h.removePendingMarker).toHaveBeenCalledWith(
      expect.objectContaining({ verified: false }),
    );
    expect(verifyLines(sink).at(-1)).toMatchObject({
      markerOutcome: "restored",
      correctionMode: "raw-fallback",
    });
  });

  it("NO_CORRECTION_NEEDED: marker stripped verified:true → ✅", async () => {
    const sink: Record<string, unknown>[] = [];
    const h = makeRunner(sink, MARKER_CFG, {
      dispatchCorrective: vi.fn(async () => NO_CORRECTION_NEEDED),
    });
    await h.runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    await flush();
    expect(h.removePendingMarker).toHaveBeenCalledWith(
      expect.objectContaining({ verified: true }),
    );
    const ack = verifyLines(sink).find((l) => l.falsePositiveAck === true);
    expect(ack).toMatchObject({ markerOutcome: "verified-clean" });
  });

  it("user-traffic abort mid-hop: marker stripped, never lies", async () => {
    const sink: Record<string, unknown>[] = [];
    let runnerRef: VerificationRunner | null = null;
    const h = makeRunner(sink, MARKER_CFG, {
      dispatchCorrective: vi.fn(async () => {
        runnerRef?.notifyIncomingTurn("fin-client");
        throw new Error("aborted by incoming turn");
      }),
      hasActiveTurn: () => false,
    });
    runnerRef = h.runner;
    await h.runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    await flush();
    expect(h.removePendingMarker).toHaveBeenCalledWith(
      expect.objectContaining({ verified: false }),
    );
    const abortLine = verifyLines(sink).find(
      (l) => l.skippedReason === "user-traffic-abort",
    );
    expect(abortLine).toMatchObject({ markerOutcome: "aborted" });
  });

  it("append returns null (chunked/no-ref) → skipped-no-ref, no removal", async () => {
    const sink: Record<string, unknown>[] = [];
    const h = makeRunner(sink, MARKER_CFG, {
      appendPendingMarker: vi.fn(async () => null),
    });
    await h.runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    await flush();
    expect(h.removePendingMarker).not.toHaveBeenCalled();
    expect(verifyLines(sink).at(-1)).toMatchObject({
      markerOutcome: "skipped-no-ref",
    });
  });
});

describe("✅ verified-inline badge", () => {
  const BADGE_CFG: ResolvedVerificationConfig = {
    deferMs: 0,
    ruleClaims: { enabled: true, maxVerifyHops: 0 },
    ux: { verifiedBadge: true },
  };

  it("cited rule claims, nothing flagged → badge fires + rider on main line", async () => {
    const sink: Record<string, unknown>[] = [];
    const h = makeRunner(sink, BADGE_CFG);
    await h.runner.run({ ...BASE_ARGS, response: CITED_ONLY });
    await flush();
    expect(h.applyVerifiedBadge).toHaveBeenCalledWith({
      agentName: "fin-client",
      turnId: "discord:123",
    });
    expect(verifyLines(sink)[0]).toMatchObject({
      verifiedBadge: true,
      citedRuleClaims: true,
    });
  });

  it("figures verified by an in-turn tool → badge fires (second disjunct)", async () => {
    const sink: Record<string, unknown>[] = [];
    const h = makeRunner(sink, BADGE_CFG, {
      recentToolCallNames: () => ["WebSearch"],
    });
    await h.runner.run({ ...BASE_ARGS, response: FIGURES_ONLY });
    await flush();
    expect(h.applyVerifiedBadge).toHaveBeenCalledTimes(1);
  });

  it("uncited rule claims in shadow (hop-exhausted) → NO badge", async () => {
    const sink: Record<string, unknown>[] = [];
    const h = makeRunner(sink, BADGE_CFG);
    await h.runner.run({ ...BASE_ARGS, response: RULES_ONLY });
    await flush();
    expect(h.applyVerifiedBadge).not.toHaveBeenCalled();
  });

  it("flagged figures turn → NO badge", async () => {
    const sink: Record<string, unknown>[] = [];
    const h = makeRunner(
      sink,
      { ...BADGE_CFG, maxVerifyHops: 1 },
      { dispatchCorrective: vi.fn(async () => NO_CORRECTION_NEEDED) },
    );
    await h.runner.run({ ...BASE_ARGS, response: FIGURES_ONLY });
    await flush();
    expect(h.applyVerifiedBadge).not.toHaveBeenCalled();
  });

  it("no turnId → NO badge (nothing to react to)", async () => {
    const sink: Record<string, unknown>[] = [];
    const h = makeRunner(sink, BADGE_CFG);
    await h.runner.run({ ...BASE_ARGS, turnId: null, response: CITED_ONLY });
    await flush();
    expect(h.applyVerifiedBadge).not.toHaveBeenCalled();
  });
});
