/**
 * Phase 999.63 Plan 03 T-02 — TurnDispatcher financial-verification gate
 * integration tests.
 *
 * Exercises `runVerificationGate` through the public `dispatch`
 * path. Asserts:
 *   - a financial draft with no verification tool triggers exactly ONE
 *     corrective `dispatchTurn(CORRECTIVE_PROMPT, ...)` and posts the
 *     labelled correction;
 *   - a verified financial draft triggers nothing;
 *   - a non-financial draft triggers nothing;
 *   - the corrective turn (verifyHopCount=1) is bounded — no second
 *     re-prompt;
 *   - any gate-internal throw fails open — the parent dispatch returns the
 *     ORIGINAL draft and never rejects;
 *   - every path emits a `phase999.63-verify` line with all four fields.
 *
 * The gate helper is fire-and-forget (`void`-invoked) from the dispatch
 * epilogue, so each test awaits a microtask flush after `dispatch`
 * resolves before asserting on the gate's side effects.
 */

import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { TurnDispatcher } from "../turn-dispatcher.js";
import { makeRootOrigin } from "../turn-origin.js";
import {
  CORRECTIVE_PROMPT,
  PATCH_OUTPUT_CONTRACT,
  CORRECTION_PREFIX,
  NO_CORRECTION_NEEDED,
} from "../financial-verification-gate.js";

/** Drain the microtask queue so the fire-and-forget gate helper settles. */
async function flushGate(): Promise<void> {
  // Multiple awaits — the gate awaits dispatchTurn then postCorrectiveMessage.
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

/**
 * Build a pino logger that captures every structured record into `sink`.
 */
function makeCapturingLogger(sink: Record<string, unknown>[]) {
  return pino(
    { level: "info" },
    {
      write(line: string) {
        try {
          sink.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // ignore non-JSON lines
        }
      },
    },
  );
}

/** All captured phase999.63-verify lines, in order. */
function verifyLines(sink: Record<string, unknown>[]): Record<string, unknown>[] {
  return sink.filter((r) => r.tag === "phase999.63-verify");
}

const FINANCIAL_DRAFT = "The 10-year Treasury yield is 4.25% right now." // 2026-08-27: lone % no longer fires; `yield` corroborates;
const NON_FINANCIAL_DRAFT = "I restarted the service and the deploy is green.";

/** Arg shape of the postCorrectiveMessage DI hook. */
interface CorrectiveArg {
  agentName: string;
  channelId: string | null;
  text: string;
}

/** A typed vi.fn mock for the postCorrectiveMessage hook. */
function makePostCorrectiveMock() {
  return vi.fn<(args: CorrectiveArg) => Promise<void>>(async () => {});
}

describe("TurnDispatcher financial-verification gate — T-02 integration", () => {
  it("financial draft + no verification tool → exactly ONE corrective dispatchTurn + posted correction", async () => {
    const sink: Record<string, unknown>[] = [];
    const log = makeCapturingLogger(sink);
    const dispatchTurn = vi
      .fn()
      .mockResolvedValueOnce(FINANCIAL_DRAFT) // original turn
      .mockResolvedValueOnce("Verified: the 10-year is 4.31%."); // corrective
    const sm = {
      dispatchTurn,
      streamFromAgent: vi.fn(),
      getTraceCollector: vi.fn(() => undefined),
    };
    const postCorrectiveMessage = makePostCorrectiveMock();
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log,
      // no verification tool fired this turn
      recentToolCallNames: () => ["mcp__discord__send"],
      postCorrectiveMessage,
      // 2026-07-31 — zero defer so the microtask flushGate harness works
      // (the runner's real default idle-defers 2 s before the hop).
      resolveVerification: () => ({ deferMs: 0 }),
    });

    const origin = makeRootOrigin("discord", "msg_1");
    const result = await dispatcher.dispatch(origin, "fin-research", "what is the 10y?", {
      channelId: "chan_1",
    });

    // Parent dispatch returns the ORIGINAL draft, unmutated.
    expect(result).toBe(FINANCIAL_DRAFT);

    await flushGate();

    // Exactly ONE corrective dispatchTurn (the 2nd dispatchTurn call).
    expect(dispatchTurn).toHaveBeenCalledTimes(2);
    expect(dispatchTurn.mock.calls[1]?.[0]).toBe("fin-research");
    expect(dispatchTurn.mock.calls[1]?.[1]).toBe(
      `${CORRECTIVE_PROMPT}\n\n${PATCH_OUTPUT_CONTRACT}`,
    );

    // Correction posted as a separate labelled message.
    expect(postCorrectiveMessage).toHaveBeenCalledTimes(1);
    const posted = postCorrectiveMessage.mock.calls[0]?.[0] as unknown as {
      agentName: string;
      channelId: string | null;
      text: string;
    };
    expect(posted.agentName).toBe("fin-research");
    expect(posted.channelId).toBe("chan_1");
    expect(posted.text.startsWith(CORRECTION_PREFIX)).toBe(true);
    // 999.178 R1 — the correction prefix is glyph-free; the search icon is
    // added only when the registry is loaded (not in this test), never as
    // Unicode.
    expect(posted.text).toContain("Correction (verified");
    expect(posted.text).not.toContain("🔎");

    // Two telemetry lines: the flagged original + the corrective turn.
    const lines = verifyLines(sink);
    expect(lines.length).toBe(2);
    expect(lines[0]?.action).toBe("re-prompt");
  });

  it("financial draft + verification tool called → no corrective dispatch, no post, action none", async () => {
    const sink: Record<string, unknown>[] = [];
    const log = makeCapturingLogger(sink);
    const dispatchTurn = vi.fn().mockResolvedValue(FINANCIAL_DRAFT);
    const sm = {
      dispatchTurn,
      streamFromAgent: vi.fn(),
      getTraceCollector: vi.fn(() => undefined),
    };
    const postCorrectiveMessage = makePostCorrectiveMock();
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log,
      recentToolCallNames: () => ["mcp__finnhub__stock_quote"],
      postCorrectiveMessage,
      // 2026-07-31 — zero defer so the microtask flushGate harness works
      // (the runner's real default idle-defers 2 s before the hop).
      resolveVerification: () => ({ deferMs: 0 }),
    });

    const origin = makeRootOrigin("discord", "msg_2");
    await dispatcher.dispatch(origin, "fin-research", "10y?", { channelId: "chan_1" });
    await flushGate();

    // Only the original turn — no corrective.
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    expect(postCorrectiveMessage).not.toHaveBeenCalled();

    const lines = verifyLines(sink);
    expect(lines.length).toBe(1);
    expect(lines[0]?.action).toBe("none");
  });

  it("non-financial draft → no corrective dispatch, action none", async () => {
    const sink: Record<string, unknown>[] = [];
    const log = makeCapturingLogger(sink);
    const dispatchTurn = vi.fn().mockResolvedValue(NON_FINANCIAL_DRAFT);
    const sm = {
      dispatchTurn,
      streamFromAgent: vi.fn(),
      getTraceCollector: vi.fn(() => undefined),
    };
    const postCorrectiveMessage = makePostCorrectiveMock();
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log,
      recentToolCallNames: () => [],
      postCorrectiveMessage,
      // 2026-07-31 — zero defer so the microtask flushGate harness works
      // (the runner's real default idle-defers 2 s before the hop).
      resolveVerification: () => ({ deferMs: 0 }),
    });

    // Phase 999.63 Plan 04 — agent renamed `general` → `fin-research`. After
    // Plan 04's per-agent scoping, a non-fin agent (`general`) short-circuits
    // BEFORE the classifier runs, emitting ZERO telemetry lines. This test's
    // intent is "non-financial draft → classifier returns `none`, no
    // corrective" — preserved verbatim on an ENFORCED (fin-prefix) agent.
    const origin = makeRootOrigin("scheduler", "daily");
    await dispatcher.dispatch(origin, "fin-research", "status?", {});
    await flushGate();

    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    expect(postCorrectiveMessage).not.toHaveBeenCalled();

    const lines = verifyLines(sink);
    expect(lines.length).toBe(1);
    expect(lines[0]?.action).toBe("none");
  });

  it("corrective turn (verifyHopCount=1) that still emits figures → hop-exhausted, no second re-prompt", async () => {
    const sink: Record<string, unknown>[] = [];
    const log = makeCapturingLogger(sink);
    // The dispatch is itself the corrective turn (verifyHopCount=1).
    const dispatchTurn = vi.fn().mockResolvedValue(FINANCIAL_DRAFT);
    const sm = {
      dispatchTurn,
      streamFromAgent: vi.fn(),
      getTraceCollector: vi.fn(() => undefined),
    };
    const postCorrectiveMessage = makePostCorrectiveMock();
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log,
      recentToolCallNames: () => [], // still no verification
      postCorrectiveMessage,
      // 2026-07-31 — zero defer so the microtask flushGate harness works
      // (the runner's real default idle-defers 2 s before the hop).
      resolveVerification: () => ({ deferMs: 0 }),
    });

    const origin = makeRootOrigin("discord", "msg_3");
    await dispatcher.dispatch(origin, "fin-research", "10y?", {
      channelId: "chan_1",
      verifyHopCount: 1,
    });
    await flushGate();

    // No SECOND re-prompt — the hop bound holds.
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    expect(postCorrectiveMessage).not.toHaveBeenCalled();

    const lines = verifyLines(sink);
    expect(lines.length).toBe(1);
    expect(lines[0]?.action).toBe("hop-exhausted");
  });

  it("gate-internal throw (corrective dispatchTurn rejects) → action error, parent dispatch returns original draft and does NOT reject", async () => {
    const sink: Record<string, unknown>[] = [];
    const log = makeCapturingLogger(sink);
    const dispatchTurn = vi
      .fn()
      .mockResolvedValueOnce(FINANCIAL_DRAFT) // original turn succeeds
      .mockRejectedValueOnce(new Error("corrective boom")); // corrective rejects
    const sm = {
      dispatchTurn,
      streamFromAgent: vi.fn(),
      getTraceCollector: vi.fn(() => undefined),
    };
    const postCorrectiveMessage = makePostCorrectiveMock();
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log,
      recentToolCallNames: () => [],
      postCorrectiveMessage,
      // 2026-07-31 — zero defer so the microtask flushGate harness works
      // (the runner's real default idle-defers 2 s before the hop).
      resolveVerification: () => ({ deferMs: 0 }),
    });

    const origin = makeRootOrigin("discord", "msg_4");
    // The parent dispatch must NOT reject even though the gate's corrective
    // dispatch throws.
    const result = await dispatcher.dispatch(origin, "fin-research", "10y?", {
      channelId: "chan_1",
    });
    expect(result).toBe(FINANCIAL_DRAFT);

    await flushGate();

    // Gate trapped the throw: an error telemetry line was emitted, the
    // correction was never posted.
    expect(postCorrectiveMessage).not.toHaveBeenCalled();
    const lines = verifyLines(sink);
    const errorLine = lines.find((l) => l.action === "error");
    expect(errorLine).toBeDefined();
  });

  it("every phase999.63-verify line carries all four required fields", async () => {
    const sink: Record<string, unknown>[] = [];
    const log = makeCapturingLogger(sink);
    const dispatchTurn = vi
      .fn()
      .mockResolvedValueOnce(FINANCIAL_DRAFT)
      .mockResolvedValueOnce("Verified figure: 4.31%.");
    const sm = {
      dispatchTurn,
      streamFromAgent: vi.fn(),
      getTraceCollector: vi.fn(() => undefined),
    };
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log,
      recentToolCallNames: () => [],
      postCorrectiveMessage: makePostCorrectiveMock(),
      resolveVerification: () => ({ deferMs: 0 }),
    });

    const origin = makeRootOrigin("discord", "msg_5");
    await dispatcher.dispatch(origin, "fin-research", "10y?", { channelId: "chan_1" });
    await flushGate();

    const lines = verifyLines(sink);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toHaveProperty("agent");
      expect(line).toHaveProperty("financialTokensDetected");
      expect(line).toHaveProperty("verificationToolsCalled");
      expect(line).toHaveProperty("action");
    }
  });

  it("gate runs even when postCorrectiveMessage is unwired — corrective still dispatched", async () => {
    const sink: Record<string, unknown>[] = [];
    const log = makeCapturingLogger(sink);
    const dispatchTurn = vi
      .fn()
      .mockResolvedValueOnce(FINANCIAL_DRAFT)
      .mockResolvedValueOnce("Verified: 4.31%.");
    const sm = {
      dispatchTurn,
      streamFromAgent: vi.fn(),
      getTraceCollector: vi.fn(() => undefined),
    };
    // postCorrectiveMessage intentionally omitted.
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log,
      recentToolCallNames: () => [],
      resolveVerification: () => ({ deferMs: 0 }),
    });

    const origin = makeRootOrigin("discord", "msg_6");
    const result = await dispatcher.dispatch(origin, "fin-research", "10y?", {
      channelId: "chan_1",
    });
    expect(result).toBe(FINANCIAL_DRAFT);
    await flushGate();

    // Corrective dispatch still happened; telemetry still emitted.
    expect(dispatchTurn).toHaveBeenCalledTimes(2);
    const lines = verifyLines(sink);
    expect(lines.length).toBe(2);
  });

  it("corrective turn replies with NO_CORRECTION_NEEDED → no post, telemetry carries falsePositiveAck", async () => {
    const sink: Record<string, unknown>[] = [];
    const log = makeCapturingLogger(sink);
    const dispatchTurn = vi
      .fn()
      .mockResolvedValueOnce(FINANCIAL_DRAFT) // original turn flags
      .mockResolvedValueOnce(`  ${NO_CORRECTION_NEEDED}\n`); // corrective: false positive (trimmed)
    const sm = {
      dispatchTurn,
      streamFromAgent: vi.fn(),
      getTraceCollector: vi.fn(() => undefined),
    };
    const postCorrectiveMessage = makePostCorrectiveMock();
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log,
      recentToolCallNames: () => [],
      postCorrectiveMessage,
      // 2026-07-31 — zero defer so the microtask flushGate harness works
      // (the runner's real default idle-defers 2 s before the hop).
      resolveVerification: () => ({ deferMs: 0 }),
    });

    const origin = makeRootOrigin("discord", "msg_fp");
    const result = await dispatcher.dispatch(origin, "fin-research", "10y?", {
      channelId: "chan_1",
    });
    expect(result).toBe(FINANCIAL_DRAFT);
    await flushGate();

    // The corrective turn DID run, but the sentinel reply suppressed the post.
    expect(dispatchTurn).toHaveBeenCalledTimes(2);
    expect(postCorrectiveMessage).not.toHaveBeenCalled();

    // Two telemetry lines: the flagged original + the corrective turn. The
    // corrective line carries the false-positive distinguisher.
    const lines = verifyLines(sink);
    expect(lines.length).toBe(2);
    expect(lines[0]?.action).toBe("re-prompt");
    expect(lines[0]?.falsePositiveAck).toBeUndefined();
    expect(lines[1]?.falsePositiveAck).toBe(true);
    // The four required fields still present on the false-positive-ack line.
    expect(lines[1]).toHaveProperty("agent");
    expect(lines[1]).toHaveProperty("financialTokensDetected");
    expect(lines[1]).toHaveProperty("verificationToolsCalled");
    expect(lines[1]).toHaveProperty("action");
  });

  it("corrective turn replies with a real correction → posted with CORRECTION_PREFIX (regression)", async () => {
    const sink: Record<string, unknown>[] = [];
    const log = makeCapturingLogger(sink);
    const REAL_CORRECTION = "Verified: the 10-year is 4.31% per finnhub.";
    const dispatchTurn = vi
      .fn()
      .mockResolvedValueOnce(FINANCIAL_DRAFT) // original turn flags
      .mockResolvedValueOnce(REAL_CORRECTION); // corrective: a genuine correction
    const sm = {
      dispatchTurn,
      streamFromAgent: vi.fn(),
      getTraceCollector: vi.fn(() => undefined),
    };
    const postCorrectiveMessage = makePostCorrectiveMock();
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log,
      recentToolCallNames: () => [],
      postCorrectiveMessage,
      // 2026-07-31 — zero defer so the microtask flushGate harness works
      // (the runner's real default idle-defers 2 s before the hop).
      resolveVerification: () => ({ deferMs: 0 }),
    });

    const origin = makeRootOrigin("discord", "msg_real");
    await dispatcher.dispatch(origin, "fin-research", "10y?", {
      channelId: "chan_1",
    });
    await flushGate();

    // A real correction is still posted with the labelled prefix.
    expect(postCorrectiveMessage).toHaveBeenCalledTimes(1);
    const posted = postCorrectiveMessage.mock.calls[0]?.[0] as unknown as {
      text: string;
    };
    expect(posted.text.startsWith(CORRECTION_PREFIX)).toBe(true);
    expect(posted.text).toContain(REAL_CORRECTION);

    // No false-positive distinguisher on a real-correction telemetry line.
    const lines = verifyLines(sink);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line.falsePositiveAck).toBeUndefined();
    }
  });
});

/**
 * Phase 999.63 Plan 04 T-03 — per-agent enforcement scoping (CONTEXT.md D6).
 *
 * Proves the gate is SURGICAL: it fires only for `fin-*` / `acme-*`
 * agents (or agents an operator explicitly opts in via
 * `resolveVerification` → `{ enforced: true }`), and short-circuits at ZERO cost for
 * every other agent — no classifier run, no `phase999.63-verify` line, no
 * corrective dispatch.
 */
describe("TurnDispatcher financial-verification gate — Plan 04 scoping", () => {
  it("fin-client + financial draft + no verification tool → gate FIRES (enforced path intact post-scoping)", async () => {
    const sink: Record<string, unknown>[] = [];
    const log = makeCapturingLogger(sink);
    const dispatchTurn = vi
      .fn()
      .mockResolvedValueOnce(FINANCIAL_DRAFT) // original turn
      .mockResolvedValueOnce("Verified: 4.31%."); // corrective turn
    const sm = {
      dispatchTurn,
      streamFromAgent: vi.fn(),
      getTraceCollector: vi.fn(() => undefined),
    };
    const postCorrectiveMessage = makePostCorrectiveMock();
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log,
      recentToolCallNames: () => ["mcp__discord__send"],
      postCorrectiveMessage,
      // No enforced key → fin-client is enforced via the prefix rule.
      resolveVerification: () => ({ deferMs: 0 }),
    });

    const origin = makeRootOrigin("discord", "scope_1");
    const result = await dispatcher.dispatch(
      origin,
      "fin-client",
      "10y?",
      { channelId: "chan_1" },
    );
    expect(result).toBe(FINANCIAL_DRAFT);
    await flushGate();

    // The enforced path still works: corrective dispatch + posted
    // correction + a re-prompt telemetry line.
    expect(dispatchTurn).toHaveBeenCalledTimes(2);
    expect(dispatchTurn.mock.calls[1]?.[1]).toBe(
      `${CORRECTIVE_PROMPT}\n\n${PATCH_OUTPUT_CONTRACT}`,
    );
    expect(postCorrectiveMessage).toHaveBeenCalledTimes(1);
    const lines = verifyLines(sink);
    expect(lines.length).toBe(2);
    expect(lines[0]?.action).toBe("re-prompt");
  });

  it("admin-clawdy + the SAME financial draft → gate SHORT-CIRCUITS (byte-identically unaffected — T5)", async () => {
    const sink: Record<string, unknown>[] = [];
    const log = makeCapturingLogger(sink);
    const dispatchTurn = vi.fn().mockResolvedValue(FINANCIAL_DRAFT);
    const sm = {
      dispatchTurn,
      streamFromAgent: vi.fn(),
      getTraceCollector: vi.fn(() => undefined),
    };
    const postCorrectiveMessage = makePostCorrectiveMock();
    const recentToolCallNames = vi.fn<(agentName: string) => readonly string[]>(
      () => [],
    );
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log,
      recentToolCallNames,
      postCorrectiveMessage,
      // No resolved block → admin-clawdy is NOT prefix-matched → not enforced.
      resolveVerification: () => undefined,
    });

    const origin = makeRootOrigin("discord", "scope_2");
    const result = await dispatcher.dispatch(origin, "admin-clawdy", "10y?", {
      channelId: "chan_1",
    });
    // Original draft returned unchanged.
    expect(result).toBe(FINANCIAL_DRAFT);
    await flushGate();

    // ZERO gate activity: only the original turn dispatched, no corrective,
    // no correction posted, NO phase999.63-verify line at all. The
    // classifier never ran — recentToolCallNames was never even read for
    // the gate (zero-cost short-circuit).
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    expect(postCorrectiveMessage).not.toHaveBeenCalled();
    expect(verifyLines(sink).length).toBe(0);
  });

  it("non-fin agent with verificationOverride → true → gate FIRES (explicit opt-in)", async () => {
    const sink: Record<string, unknown>[] = [];
    const log = makeCapturingLogger(sink);
    const dispatchTurn = vi
      .fn()
      .mockResolvedValueOnce(FINANCIAL_DRAFT)
      .mockResolvedValueOnce("Verified: 4.31%.");
    const sm = {
      dispatchTurn,
      streamFromAgent: vi.fn(),
      getTraceCollector: vi.fn(() => undefined),
    };
    const postCorrectiveMessage = makePostCorrectiveMock();
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log,
      recentToolCallNames: () => [],
      postCorrectiveMessage,
      // admin-clawdy is NOT prefix-matched, but the operator opted it in.
      resolveVerification: () => ({ enforced: true, deferMs: 0 }),
    });

    const origin = makeRootOrigin("discord", "scope_3");
    await dispatcher.dispatch(origin, "admin-clawdy", "10y?", {
      channelId: "chan_1",
    });
    await flushGate();

    // Explicit opt-in → the gate fires for a non-fin agent.
    expect(dispatchTurn).toHaveBeenCalledTimes(2);
    expect(postCorrectiveMessage).toHaveBeenCalledTimes(1);
    expect(verifyLines(sink).length).toBe(2);
  });

  it("fin-research with verificationOverride → false → gate SHORT-CIRCUITS (explicit opt-out)", async () => {
    const sink: Record<string, unknown>[] = [];
    const log = makeCapturingLogger(sink);
    const dispatchTurn = vi.fn().mockResolvedValue(FINANCIAL_DRAFT);
    const sm = {
      dispatchTurn,
      streamFromAgent: vi.fn(),
      getTraceCollector: vi.fn(() => undefined),
    };
    const postCorrectiveMessage = makePostCorrectiveMock();
    const dispatcher = new TurnDispatcher({
      sessionManager: sm as never,
      log,
      recentToolCallNames: () => [],
      postCorrectiveMessage,
      // fin-research IS prefix-matched, but the operator opted it OUT.
      resolveVerification: () => ({ enforced: false }),
    });

    const origin = makeRootOrigin("discord", "scope_4");
    const result = await dispatcher.dispatch(origin, "fin-research", "10y?", {
      channelId: "chan_1",
    });
    expect(result).toBe(FINANCIAL_DRAFT);
    await flushGate();

    // Explicit opt-out → the gate short-circuits even for a fin agent.
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    expect(postCorrectiveMessage).not.toHaveBeenCalled();
    expect(verifyLines(sink).length).toBe(0);
  });
});

/**
 * 999.63d effort-clobber fix (INC 2026-08-26) — static pins. The
 * corrective-hop and skill-effort pins/restores must use the TRANSIENT
 * setter: the persisting setEffortForAgent path clobbered a runtime
 * operator override (xhigh → high) when a pin raced the async boot-time
 * override re-apply. A future edit that reverts any pin site to the
 * persisting setter fails here.
 */
import { readFileSync as readSrcFile } from "node:fs";
import { join as joinPath, dirname as dirName } from "node:path";
import { fileURLToPath as toPath } from "node:url";

describe("999.63d effort-clobber static pins", () => {
  const here = dirName(toPath(import.meta.url));

  it("all machinery effort pins use setEffortForAgentTransient", () => {
    const src = readSrcFile(
      joinPath(here, "..", "turn-dispatcher.ts"),
      "utf-8",
    );
    const transientCalls = src.match(/setEffortForAgentTransient\(/g) ?? [];
    // Runner-deps wiring + skill pin + skill restore.
    expect(transientCalls.length).toBeGreaterThanOrEqual(3);
    // The persisting setter survives ONLY in docs/comments, never as a
    // dispatcher call site.
    const persistingCalls =
      src.match(/this\.sessionManager\.setEffortForAgent\(/g) ?? [];
    expect(persistingCalls.length).toBe(0);
  });

  it("the transient setter itself never persists", () => {
    const src = readSrcFile(
      joinPath(here, "..", "session-manager.ts"),
      "utf-8",
    );
    const start = src.indexOf("setEffortForAgentTransient(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  }", start));
    expect(body).not.toContain("writeEffortState");
  });
});
