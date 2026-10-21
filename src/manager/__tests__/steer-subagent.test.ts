import { describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import {
  STEER_MARKER_EMOJI,
  frameSteeringGuidance,
  hasLeadingSteerMarker,
  prepareSubagentSteer,
  shouldAutoSteer,
  type PrepareSteerDeps,
} from "../steer-subagent.js";
import type { ThreadBinding } from "../../discord/thread-types.js";

function captureLogger() {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const log = pino({ level: "debug" }, sink);
  return { log, chunks };
}

const NOW = 1_700_000_000_000;
const SUB_SESSION = "fin-client-sub-AbC123";
const OPERATOR_SESSION = "fin-client";
const THREAD_ID = "thread-1";

function binding(overrides: Partial<ThreadBinding> = {}): ThreadBinding {
  return {
    threadId: THREAD_ID,
    parentChannelId: "channel-1",
    agentName: "fin-client",
    sessionName: SUB_SESSION,
    createdAt: NOW - 60_000,
    lastActivity: NOW - 5_000,
    ...overrides,
  };
}

function depsForBinding(
  b: ThreadBinding | undefined,
  opts: {
    interruptResult?: { interrupted: boolean; hadActiveTurn: boolean };
    interruptThrows?: Error;
    gateResetResult?: { ok: true } | { ok: false; reason: string };
    /**
     * Sequence of `hasActiveTurn` return values consumed by the poll
     * loop. Default: [true, false] — turn is active when checked
     * immediately after interrupt, then clears on the next poll.
     * Tests can override to simulate immediate-clear (`[false]`),
     * deadline-exhausted (`[true, true, true, ...]`), or
     * never-active (any value, won't be called when hadActiveTurn is
     * false).
     */
    hasActiveTurnSequence?: readonly boolean[];
  } = {},
): {
  deps: PrepareSteerDeps;
  interruptCall: ReturnType<typeof vi.fn>;
  resetCall: ReturnType<typeof vi.fn>;
  hasActiveTurnCall: ReturnType<typeof vi.fn>;
  sleepCall: ReturnType<typeof vi.fn>;
} {
  const log = captureLogger().log;
  const interruptCall = vi
    .fn()
    .mockImplementation(async () => {
      if (opts.interruptThrows) throw opts.interruptThrows;
      return opts.interruptResult ?? { interrupted: true, hadActiveTurn: true };
    });
  const resetCall = vi
    .fn()
    .mockResolvedValue(opts.gateResetResult ?? { ok: true });
  // Default sequence: [true, false] — first poll sees turn still
  // active, second sees it cleared. Drains the queue; last value
  // sticks for any further reads (matches a real subagent that aborts
  // within one poll cycle).
  const sequence = [...(opts.hasActiveTurnSequence ?? [true, false])];
  const hasActiveTurnCall = vi.fn().mockImplementation((): boolean => {
    if (sequence.length === 0) return false;
    if (sequence.length === 1) return sequence[0]!;
    return sequence.shift()!;
  });
  // No-op sleep so the poll loop runs instantly in tests.
  const sleepCall = vi.fn().mockResolvedValue(undefined);
  const deps: PrepareSteerDeps = {
    getBinding: async () => b,
    interruptAgent: interruptCall,
    hasActiveTurn: hasActiveTurnCall,
    sleep: sleepCall,
    resetSteerGates: resetCall,
    log,
  };
  return { deps, interruptCall, resetCall, hasActiveTurnCall, sleepCall };
}

describe("prepareSubagentSteer", () => {
  it("returns ok with metadata when binding exists, has active turn, and gates reset cleanly", async () => {
    const { deps, interruptCall, resetCall } = depsForBinding(binding());
    const out = await prepareSubagentSteer({ threadId: THREAD_ID, deps });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sessionName).toBe(SUB_SESSION);
      expect(out.parentChannelId).toBe("channel-1");
      expect(out.parentAgentName).toBe("fin-client");
      expect(out.interrupted).toBe(true);
      expect(out.hadActiveTurn).toBe(true);
    }
    expect(interruptCall).toHaveBeenCalledWith(SUB_SESSION);
    expect(resetCall).toHaveBeenCalledWith(THREAD_ID);
  });

  it("returns no-binding when threadId is unknown", async () => {
    const { deps, interruptCall, resetCall } = depsForBinding(undefined);
    const out = await prepareSubagentSteer({ threadId: THREAD_ID, deps });
    expect(out).toEqual({ ok: false, reason: "no-binding" });
    expect(interruptCall).not.toHaveBeenCalled();
    expect(resetCall).not.toHaveBeenCalled();
  });

  it("returns terminal when binding has completedAt set (subagent already done)", async () => {
    const { deps, interruptCall, resetCall } = depsForBinding(
      binding({ completedAt: NOW - 1000 }),
    );
    const out = await prepareSubagentSteer({ threadId: THREAD_ID, deps });
    expect(out).toEqual({ ok: false, reason: "terminal" });
    expect(interruptCall).not.toHaveBeenCalled();
    expect(resetCall).not.toHaveBeenCalled();
  });

  it("returns not-subagent when binding is operator-defined (steer is a subagent concept only)", async () => {
    const { deps, interruptCall, resetCall } = depsForBinding(
      binding({ sessionName: OPERATOR_SESSION, agentName: OPERATOR_SESSION }),
    );
    const out = await prepareSubagentSteer({ threadId: THREAD_ID, deps });
    expect(out).toEqual({ ok: false, reason: "not-subagent" });
    expect(interruptCall).not.toHaveBeenCalled();
    expect(resetCall).not.toHaveBeenCalled();
  });

  it("returns ok with hadActiveTurn=false when subagent is idle (interrupt was a no-op)", async () => {
    const { deps } = depsForBinding(binding(), {
      interruptResult: { interrupted: false, hadActiveTurn: false },
    });
    const out = await prepareSubagentSteer({ threadId: THREAD_ID, deps });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.interrupted).toBe(false);
      expect(out.hadActiveTurn).toBe(false);
    }
  });

  it("returns interrupt-failed and skips gate reset when interruptAgent throws", async () => {
    const { deps, resetCall } = depsForBinding(binding(), {
      interruptThrows: new Error("session-handle gone"),
    });
    const out = await prepareSubagentSteer({ threadId: THREAD_ID, deps });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("interrupt-failed");
      expect(out.detail).toContain("session-handle gone");
    }
    expect(resetCall).not.toHaveBeenCalled();
  });

  it("returns gate-reset-failed when resetSteerGates returns ok:false", async () => {
    const { deps } = depsForBinding(binding(), {
      gateResetResult: { ok: false, reason: "registry write failed" },
    });
    const out = await prepareSubagentSteer({ threadId: THREAD_ID, deps });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("gate-reset-failed");
      expect(out.detail).toBe("registry write failed");
    }
  });

  it("never throws — folds binding-read errors into no-binding", async () => {
    const log = captureLogger().log;
    const deps: PrepareSteerDeps = {
      getBinding: async () => {
        throw new Error("registry read failed");
      },
      interruptAgent: vi.fn(),
      hasActiveTurn: vi.fn(),
      sleep: vi.fn(),
      resetSteerGates: vi.fn(),
      log,
    };
    const out = await prepareSubagentSteer({ threadId: THREAD_ID, deps });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("no-binding");
      expect(out.detail).toContain("registry read failed");
    }
  });

  it("treats completedAt === null as not-completed (back-compat with pre-Phase-999.25 bindings)", async () => {
    const { deps } = depsForBinding(binding({ completedAt: null }));
    const out = await prepareSubagentSteer({ threadId: THREAD_ID, deps });
    expect(out.ok).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────
  // Poll-until-clear (2026-05-24) — close the post-interrupt
  // dispatch race. Operator symptom: "I have to reprint it for the
  // typing indicator to appear / for the subagent to accept the
  // steering". Cause: interrupt() returns immediately but the SDK
  // is still aborting; dispatch races ahead and queues silently
  // behind the abort. Fix: poll hasActiveTurn after interrupt up
  // to STEER_CLEAR_MAX_WAIT_MS.
  // ──────────────────────────────────────────────────────────────

  it("polls hasActiveTurn after interrupt and proceeds once the turn clears", async () => {
    // Default sequence [true, false] — first poll sees active, second sees clear.
    const { deps, hasActiveTurnCall, sleepCall, resetCall } = depsForBinding(
      binding(),
    );
    const out = await prepareSubagentSteer({ threadId: THREAD_ID, deps });
    expect(out.ok).toBe(true);
    // Initial check + 1 cleared check = at least 2 hasActiveTurn calls.
    expect(hasActiveTurnCall.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sleepCall).toHaveBeenCalled();
    // Gate reset only fires AFTER the poll clears — verify ordering.
    expect(resetCall).toHaveBeenCalled();
  });

  it("skips the poll entirely when interrupt reported no active turn (idle subagent)", async () => {
    const { deps, hasActiveTurnCall, sleepCall } = depsForBinding(binding(), {
      interruptResult: { interrupted: false, hadActiveTurn: false },
    });
    const out = await prepareSubagentSteer({ threadId: THREAD_ID, deps });
    expect(out.ok).toBe(true);
    // Idle subagent → no poll, no sleep. (The 2s wait would be pure
    // wasted latency for the operator's steer.)
    expect(hasActiveTurnCall).not.toHaveBeenCalled();
    expect(sleepCall).not.toHaveBeenCalled();
  });

  it("short-circuits when hasActiveTurn returns false on the very first read", async () => {
    // Sequence [false] — turn already cleared by the time the poll
    // starts (interrupt was effectively synchronous). No sleeps needed.
    const { deps, hasActiveTurnCall, sleepCall } = depsForBinding(binding(), {
      hasActiveTurnSequence: [false],
    });
    const out = await prepareSubagentSteer({ threadId: THREAD_ID, deps });
    expect(out.ok).toBe(true);
    expect(hasActiveTurnCall).toHaveBeenCalledTimes(1);
    expect(sleepCall).not.toHaveBeenCalled();
  });

  it("proceeds anyway when the poll deadline is exhausted (logs warn, caller still dispatches)", async () => {
    // Sequence stuck on `true` — subagent never clears within the
    // 2s deadline (wedged SDK abort). The orchestrator logs a warn
    // and returns ok so the caller can dispatch anyway; the SDK
    // queues the new turn behind the abort, which is the best
    // available behavior short of forever-blocking the operator.
    const stuckSequence: boolean[] = Array(100).fill(true);
    const { deps, sleepCall } = depsForBinding(binding(), {
      hasActiveTurnSequence: stuckSequence,
    });
    const out = await prepareSubagentSteer({ threadId: THREAD_ID, deps });
    expect(out.ok).toBe(true);
    // The poll DID run (sleeps fired); we just gave up after the deadline.
    expect(sleepCall.mock.calls.length).toBeGreaterThan(0);
  });

  it("never invokes hasActiveTurn or sleep when binding is missing (short-circuits BEFORE the poll)", async () => {
    const { deps, hasActiveTurnCall, sleepCall, interruptCall } =
      depsForBinding(undefined);
    const out = await prepareSubagentSteer({ threadId: THREAD_ID, deps });
    expect(out).toEqual({ ok: false, reason: "no-binding" });
    expect(interruptCall).not.toHaveBeenCalled();
    expect(hasActiveTurnCall).not.toHaveBeenCalled();
    expect(sleepCall).not.toHaveBeenCalled();
  });

  it("never invokes hasActiveTurn or sleep when binding is terminal (short-circuits BEFORE interrupt)", async () => {
    const { deps, hasActiveTurnCall, sleepCall, interruptCall } =
      depsForBinding(binding({ completedAt: NOW - 1000 }));
    const out = await prepareSubagentSteer({ threadId: THREAD_ID, deps });
    expect(out).toEqual({ ok: false, reason: "terminal" });
    expect(interruptCall).not.toHaveBeenCalled();
    expect(hasActiveTurnCall).not.toHaveBeenCalled();
    expect(sleepCall).not.toHaveBeenCalled();
  });
});

describe("shouldAutoSteer (bridge auto-trigger predicate)", () => {
  // The bridge auto-trigger is an AND of four gates. A typo in any
  // gate silently degrades to "no steer ever fires" — or worse,
  // "every casual check-in fires" (the 2026-05-24 regression
  // captured by the marker gate). These tests pin the AND-clause so
  // the trigger condition stays observably correct across refactors.

  it("returns true when all four gates pass", () => {
    expect(
      shouldAutoSteer({
        isSubagentThread: true,
        isAcceptedAuthor: true,
        hasActiveTurn: true,
        hasSteerMarker: true,
      }),
    ).toBe(true);
  });

  it("returns false when not a subagent thread (steer is subagent-only)", () => {
    expect(
      shouldAutoSteer({
        isSubagentThread: false,
        isAcceptedAuthor: true,
        hasActiveTurn: true,
        hasSteerMarker: true,
      }),
    ).toBe(false);
  });

  it("returns false when author is rejected (bot post — Path B body is already framed, must not re-wrap)", () => {
    expect(
      shouldAutoSteer({
        isSubagentThread: true,
        isAcceptedAuthor: false,
        hasActiveTurn: true,
        hasSteerMarker: true,
      }),
    ).toBe(false);
  });

  it("returns false when subagent is idle (interrupt would be a no-op; normal dispatch fine)", () => {
    expect(
      shouldAutoSteer({
        isSubagentThread: true,
        isAcceptedAuthor: true,
        hasActiveTurn: false,
        hasSteerMarker: true,
      }),
    ).toBe(false);
  });

  it("returns false when marker is missing (THE 2026-05-24 fix — casual operator messages no longer kill in-flight tool work)", () => {
    // This is the exact regression captured by the screenshot of
    // admin-clawdy's sdd-uia-v3 thread: "What happened? Still going?"
    // is a human message in a subagent thread with an active turn,
    // but has no 🧭 marker — must NOT auto-steer.
    expect(
      shouldAutoSteer({
        isSubagentThread: true,
        isAcceptedAuthor: true,
        hasActiveTurn: true,
        hasSteerMarker: false,
      }),
    ).toBe(false);
  });

  it("returns false when ALL gates fail (defensive — confirms no accidental short-circuit)", () => {
    expect(
      shouldAutoSteer({
        isSubagentThread: false,
        isAcceptedAuthor: false,
        hasActiveTurn: false,
        hasSteerMarker: false,
      }),
    ).toBe(false);
  });
});

describe("hasLeadingSteerMarker (2026-05-24 marker detection)", () => {
  it("returns true for a message starting with 🧭", () => {
    expect(hasLeadingSteerMarker("🧭 use Chrome instead")).toBe(true);
  });

  it("returns true with leading whitespace before 🧭 (Discord may auto-trim, but be tolerant)", () => {
    expect(hasLeadingSteerMarker("   🧭 stop using WeasyPrint")).toBe(true);
    expect(hasLeadingSteerMarker("\n🧭 redirect")).toBe(true);
    expect(hasLeadingSteerMarker("\t🧭 redirect")).toBe(true);
  });

  it("returns true when 🧭 is the entire content (no trailing text)", () => {
    // Pure marker with no directive — should still register the
    // operator's intent. Caller decides whether an empty steer is
    // useful (it isn't, but that's the caller's gate to add).
    expect(hasLeadingSteerMarker("🧭")).toBe(true);
  });

  it("returns false when 🧭 appears in the middle (only LEADING marker counts)", () => {
    expect(
      hasLeadingSteerMarker("Now switch direction 🧭 to Chrome"),
    ).toBe(false);
  });

  it("returns false for a plain question (the regression class)", () => {
    expect(hasLeadingSteerMarker("What happened? Still going?")).toBe(false);
    expect(hasLeadingSteerMarker("still working?")).toBe(false);
    expect(hasLeadingSteerMarker("nice")).toBe(false);
  });

  it("returns false for empty / whitespace / null / undefined input", () => {
    expect(hasLeadingSteerMarker("")).toBe(false);
    expect(hasLeadingSteerMarker("   ")).toBe(false);
    expect(hasLeadingSteerMarker(null)).toBe(false);
    expect(hasLeadingSteerMarker(undefined)).toBe(false);
  });

  it("returns false for messages starting with similar-looking emoji (NOT the compass)", () => {
    // 🧲 (magnet, U+1F9F2), 🎯 (target, U+1F3AF), 🚀 (rocket) — none
    // should match. Single source of truth = STEER_MARKER_EMOJI.
    expect(hasLeadingSteerMarker("🧲 use magnetic Chrome")).toBe(false);
    expect(hasLeadingSteerMarker("🎯 hit the target")).toBe(false);
    expect(hasLeadingSteerMarker("🚀 ship it")).toBe(false);
  });

  it("STEER_MARKER_EMOJI is the compass needle U+1F9ED (regression pin against accidental codepoint changes)", () => {
    expect(STEER_MARKER_EMOJI).toBe("🧭");
    expect(STEER_MARKER_EMOJI.codePointAt(0)).toBe(0x1f9ed);
  });
});

describe("frameSteeringGuidance", () => {
  it("wraps guidance in <operator-steering> tags with the integration instruction", () => {
    const framed = frameSteeringGuidance("use Chrome instead of WeasyPrint");
    expect(framed).toMatch(/^<operator-steering>/);
    expect(framed).toMatch(/<\/operator-steering>$/);
    expect(framed).toContain("use Chrome instead of WeasyPrint");
    expect(framed).toContain("Do NOT restart from scratch");
    expect(framed).toContain("integrate this with what you've already done");
  });

  it("trims surrounding whitespace from the guidance content", () => {
    const framed = frameSteeringGuidance("   \n  redirect to plan B  \n  ");
    expect(framed).toContain("redirect to plan B");
    // The trimmed content shouldn't include the leading/trailing whitespace.
    expect(framed).not.toContain("   \n  redirect");
  });

  it("produces deterministic output for the same input (byte-identical Path A vs Path B framing)", () => {
    const a = frameSteeringGuidance("use Chrome");
    const b = frameSteeringGuidance("use Chrome");
    expect(a).toBe(b);
  });
});
