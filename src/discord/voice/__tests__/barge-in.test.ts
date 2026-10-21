/**
 * Phase 135.1 Phase 3 — barge-in state machine unit tests.
 *
 * Covers the two-stage interrupt: Stage A pause on speech onset while SPEAKING,
 * Stage B classification (command / multi-word confirm vs backchannel vs
 * unknown), commit (abort + backoff + LISTENING), and rollback (false interrupt
 * / backchannel resumes playback). Uses fake timers for the rollback window and
 * a fake AudioPlayer recording pause/unpause/stop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyBargeInText,
  resolveBargeInConfig,
  beginBargeIn,
  evaluateBargeInInterim,
  rollbackBargeIn,
  DEFAULT_BARGEIN_FALSE_INTERRUPT_MS,
  DEFAULT_BARGEIN_MIN_CONFIRM_WORDS,
  beginVoiceTurn,
  type BargeInConfig,
} from "../turn-state.js";
import { createVoiceSession, type VoiceSession } from "../session.js";

function makeSession(bargeIn?: Record<string, unknown>): VoiceSession {
  return createVoiceSession({
    id: "sess-bargein-1",
    agentName: "test-agent",
    channelId: "chan-1",
    guildId: "guild-1",
    voiceCfg: {
      deepgramKey: "dg",
      elevenLabsKey: "el",
      voiceId: "v",
      ...(bargeIn ? { bargeIn } : {}),
    } as unknown as VoiceSession["voiceCfg"],
  });
}

/** Fake AudioPlayer recording the barge-in control calls. */
function attachFakePlayer(s: VoiceSession) {
  const calls = { pause: 0, unpause: 0, stop: 0 };
  s.player = {
    pause: (..._a: unknown[]) => {
      calls.pause++;
      return true;
    },
    unpause: () => {
      calls.unpause++;
      return true;
    },
    stop: (..._a: unknown[]) => {
      calls.stop++;
      return true;
    },
  } as unknown as VoiceSession["player"];
  return calls;
}

const ENABLED: BargeInConfig = {
  enabled: true,
  falseInterruptTimeoutMs: DEFAULT_BARGEIN_FALSE_INTERRUPT_MS,
  minConfirmWords: DEFAULT_BARGEIN_MIN_CONFIRM_WORDS,
  backoffMs: 800,
};

describe("classifyBargeInText", () => {
  const min = DEFAULT_BARGEIN_MIN_CONFIRM_WORDS;
  it("treats a lone command word as a confirm (the 'stop' case)", () => {
    expect(classifyBargeInText("stop", min)).toBe("confirm");
    expect(classifyBargeInText("wait!", min)).toBe("confirm");
    expect(classifyBargeInText("actually", min)).toBe("confirm");
  });
  it("treats short all-backchannel utterances as backchannel (no interrupt)", () => {
    expect(classifyBargeInText("mm-hm", min)).toBe("backchannel");
    expect(classifyBargeInText("yeah", min)).toBe("backchannel");
    expect(classifyBargeInText("got it", min)).toBe("backchannel");
    expect(classifyBargeInText("yeah okay", min)).toBe("backchannel");
  });
  it("confirms once there are >= minConfirmWords of real content", () => {
    expect(classifyBargeInText("what about the", min)).toBe("confirm");
    expect(classifyBargeInText("tell me instead", min)).toBe("confirm");
  });
  it("holds a single ambiguous content word as unknown", () => {
    expect(classifyBargeInText("meeting", min)).toBe("unknown");
    expect(classifyBargeInText("", min)).toBe("unknown");
  });
});

describe("resolveBargeInConfig", () => {
  it("defaults to disabled with the documented tuning", () => {
    const cfg = resolveBargeInConfig(makeSession().voiceCfg);
    expect(cfg.enabled).toBe(false);
    expect(cfg.falseInterruptTimeoutMs).toBe(2000);
    expect(cfg.minConfirmWords).toBe(2);
    expect(cfg.backoffMs).toBe(800);
  });
  it("reads per-agent overrides", () => {
    const cfg = resolveBargeInConfig(
      makeSession({ enabled: true, minConfirmWords: 3, backoffMs: 500 }).voiceCfg,
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.minConfirmWords).toBe(3);
    expect(cfg.backoffMs).toBe(500);
  });
});

describe("barge-in state machine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("beginBargeIn only fires while SPEAKING and pauses the player", () => {
    const s = makeSession();
    const calls = attachFakePlayer(s);

    s.phase = "thinking";
    expect(beginBargeIn(s, ENABLED)).toBe(false); // not speaking → no-op
    s.phase = "speaking";
    expect(beginBargeIn(s, ENABLED)).toBe(true);
    expect(s.phase).toBe("interrupt_pending");
    expect(calls.pause).toBe(1);
  });

  it("does nothing when disabled", () => {
    const s = makeSession();
    attachFakePlayer(s);
    s.phase = "speaking";
    expect(beginBargeIn(s, { ...ENABLED, enabled: false })).toBe(false);
    expect(s.phase).toBe("speaking");
  });

  it("a command word confirms: aborts the live turn, backs off, → LISTENING", () => {
    const s = makeSession();
    const calls = attachFakePlayer(s);
    const turn = beginVoiceTurn(s, "turn-1"); // arms an AbortController
    s.phase = "speaking";
    beginBargeIn(s, ENABLED);

    const cls = evaluateBargeInInterim(s, "stop", ENABLED);
    expect(cls).toBe("confirm");
    expect(turn.abort.signal.aborted).toBe(true);
    expect(calls.stop).toBe(1);
    expect(s.phase).toBe("listening");
    expect(s.currentTurn).toBeNull();
    expect((s.bargeInBackoffUntil ?? 0) > 0).toBe(true);
  });

  it("a backchannel rolls back immediately: resumes playback, nothing aborted", () => {
    const s = makeSession();
    const calls = attachFakePlayer(s);
    const turn = beginVoiceTurn(s, "turn-1");
    s.phase = "speaking";
    beginBargeIn(s, ENABLED);

    const cls = evaluateBargeInInterim(s, "mm-hm", ENABLED);
    expect(cls).toBe("backchannel");
    expect(turn.abort.signal.aborted).toBe(false); // NOT aborted
    expect(calls.unpause).toBe(1);
    expect(s.phase).toBe("speaking"); // restored
    expect(s.currentTurn).toBe(turn);
  });

  it("a cough (no confirming interim) rolls back when the timer fires", () => {
    const s = makeSession();
    const calls = attachFakePlayer(s);
    const turn = beginVoiceTurn(s, "turn-1");
    s.phase = "speaking";
    beginBargeIn(s, ENABLED);
    expect(s.phase).toBe("interrupt_pending");

    // No interim arrives; the false-interrupt timer fires.
    vi.advanceTimersByTime(DEFAULT_BARGEIN_FALSE_INTERRUPT_MS + 10);
    expect(calls.unpause).toBe(1);
    expect(s.phase).toBe("speaking");
    expect(turn.abort.signal.aborted).toBe(false);
  });

  it("an unknown interim holds the pause; a later multi-word interim confirms", () => {
    const s = makeSession();
    attachFakePlayer(s);
    const turn = beginVoiceTurn(s, "turn-1");
    s.phase = "speaking";
    beginBargeIn(s, ENABLED);

    expect(evaluateBargeInInterim(s, "meeting", ENABLED)).toBe("unknown");
    expect(s.phase).toBe("interrupt_pending"); // still paused
    expect(evaluateBargeInInterim(s, "meeting is cancelled", ENABLED)).toBe("confirm");
    expect(turn.abort.signal.aborted).toBe(true);
    expect(s.phase).toBe("listening");
  });

  it("rollbackBargeIn is a no-op unless a barge-in is pending", () => {
    const s = makeSession();
    attachFakePlayer(s);
    s.phase = "speaking";
    rollbackBargeIn(s); // not pending
    expect(s.phase).toBe("speaking");
  });
});

describe("barge-in → turn trace (999.116 A3 / G7)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stamps the pause on opening, 'confirm' on commit, and the abort outcome", () => {
    const s = makeSession();
    attachFakePlayer(s);
    const turn = beginVoiceTurn(s, "turn-1");
    s.phase = "speaking";
    beginBargeIn(s, ENABLED);
    expect(turn.trace.bargeInOpenings).toBe(1);
    expect(turn.trace.stamps.has("bargeInPause")).toBe(true);
    expect(turn.trace.stamps.has("bargeInResolved")).toBe(false);

    evaluateBargeInInterim(s, "stop", ENABLED);
    expect(turn.trace.bargeInResult).toBe("confirm");
    expect(turn.trace.stamps.has("bargeInResolved")).toBe(true);
    // The trace survives currentTurn being nulled by the abort.
    expect(s.currentTurn).toBeNull();
    expect(turn.trace.outcome).toBe("aborted:barge-in");
    expect(turn.trace.abortReason).toBe("barge-in");
  });

  it("records 'backchannel' and 'timeout' rollbacks; each opening re-arms the pause/resolve pair", () => {
    const s = makeSession();
    attachFakePlayer(s);
    const turn = beginVoiceTurn(s, "turn-1");
    s.phase = "speaking";

    beginBargeIn(s, ENABLED);
    evaluateBargeInInterim(s, "mm-hm", ENABLED);
    expect(turn.trace.bargeInResult).toBe("backchannel");
    expect(turn.trace.outcome).toBe("unknown"); // nothing aborted

    // A second opening on the same turn (phase was restored to speaking).
    beginBargeIn(s, ENABLED);
    expect(turn.trace.bargeInOpenings).toBe(2);
    expect(turn.trace.stamps.has("bargeInResolved")).toBe(false); // re-armed
    vi.advanceTimersByTime(DEFAULT_BARGEIN_FALSE_INTERRUPT_MS + 10);
    expect(turn.trace.bargeInResult).toBe("timeout");
    expect(turn.trace.stamps.has("bargeInResolved")).toBe(true);
    expect(turn.trace.outcome).toBe("unknown");
  });
});
