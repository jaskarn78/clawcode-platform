/**
 * Phase 135.1 Phase 2 — TurnController (cancellation spine) unit tests.
 *
 * Verifies the generation-guarded turn lifecycle + abort semantics that
 * barge-in (Phase 3) and leave() rely on: begin bumps generation and arms an
 * AbortController; abort fires the signal, supersedes the turn, and hard-stops
 * the player + parked TTS stream; end is generation-guarded so a superseded
 * turn cannot clobber its successor; and abort errors classify as benign.
 */
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  beginVoiceTurn,
  endVoiceTurn,
  abortVoiceTurn,
  isCurrentVoiceTurn,
  isVoiceAbortError,
  setVoicePhase,
} from "../turn-state.js";
import { createVoiceSession, type VoiceSession } from "../session.js";

function makeSession(): VoiceSession {
  const s = createVoiceSession({
    id: "sess-turnstate-1",
    agentName: "test-agent",
    channelId: "chan-1",
    guildId: "guild-1",
    // Minimal voice cfg — turn-state never reads it.
    voiceCfg: {
      deepgramKey: "dg",
      elevenLabsKey: "el",
      voiceId: "v",
    } as unknown as VoiceSession["voiceCfg"],
  });
  return s;
}

describe("TurnController (Phase 135.1 cancellation spine)", () => {
  it("beginVoiceTurn bumps generation, arms an AbortController, sets THINKING", () => {
    const s = makeSession();
    expect(s.currentTurn).toBeNull();
    expect(s.phase).toBe("idle");

    const t1 = beginVoiceTurn(s, "turn-1");
    expect(t1.generation).toBe(1);
    expect(s.currentTurn).toBe(t1);
    expect(s.phase).toBe("thinking");
    expect(t1.abort.signal.aborted).toBe(false);
    expect(isCurrentVoiceTurn(s, t1)).toBe(true);

    const t2 = beginVoiceTurn(s, "turn-2");
    expect(t2.generation).toBe(2);
    // t1 is now stale — its generation no longer matches the live turn.
    expect(isCurrentVoiceTurn(s, t1)).toBe(false);
    expect(isCurrentVoiceTurn(s, t2)).toBe(true);
  });

  it("abortVoiceTurn fires the signal, supersedes the turn, and stops player + parked stream", () => {
    const s = makeSession();
    const stop = vi.fn();
    // Minimal fake player — only .stop is exercised by abort.
    s.player = { stop } as unknown as VoiceSession["player"];

    const turn = beginVoiceTurn(s, "turn-1");
    const parked = new PassThrough();
    turn.ttsStream = parked;
    const destroySpy = vi.spyOn(parked, "destroy");

    let abortReason: unknown;
    turn.abort.signal.addEventListener("abort", () => {
      abortReason = turn.abort.signal.reason;
    });

    const returned = abortVoiceTurn(s, "barge-in");
    expect(returned).toBe(turn);
    expect(turn.abort.signal.aborted).toBe(true);
    expect((abortReason as { name?: string } | undefined)?.name).toBe("AbortError");
    expect(destroySpy).toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith(true);
    // Turn is superseded: no current turn, and the old turn reads stale.
    expect(s.currentTurn).toBeNull();
    expect(isCurrentVoiceTurn(s, turn)).toBe(false);
  });

  it("abortVoiceTurn is a no-op returning null when idle", () => {
    const s = makeSession();
    expect(abortVoiceTurn(s, "nothing-running")).toBeNull();
  });

  it("999.116: beginVoiceTurn seeds the trace from the STT handoff and stamps dispatch", () => {
    const s = makeSession();
    const t = beginVoiceTurn(s, "turn-1", {
      sttTiming: { speechEndAt: 5, decisionAt: 9, reason: "speech_final" },
      enqueuedAt: 10,
      transcriptChars: 12,
    });
    expect(t.trace.stamps.get("speechEnd")).toBe(5);
    expect(t.trace.stamps.get("sttDecision")).toBe(9);
    expect(t.trace.stamps.get("enqueue")).toBe(10);
    expect(t.trace.stamps.get("dispatch")).toBe(t.startedAt);
    expect(t.trace.sttReason).toBe("speech_final");
    expect(t.trace.transcriptChars).toBe(12);
    // Without a seed the trace still exists (dispatch only).
    const bare = beginVoiceTurn(s, "turn-2");
    expect(bare.trace.stamps.get("dispatch")).toBe(bare.startedAt);
    expect(bare.trace.sttReason).toBeNull();
  });

  it("999.116: abortVoiceTurn records the reason without clobbering a settled outcome", () => {
    const s = makeSession();
    const t1 = beginVoiceTurn(s, "turn-1");
    abortVoiceTurn(s, "session-leave");
    expect(t1.trace.abortReason).toBe("session-leave");
    expect(t1.trace.outcome).toBe("aborted:leave");

    // A turn that already finished speaking, then torn down by leave().
    const t2 = beginVoiceTurn(s, "turn-2");
    t2.trace.outcome = "spoken";
    abortVoiceTurn(s, "session-leave");
    expect(t2.trace.outcome).toBe("spoken");
    expect(t2.trace.abortReason).toBe("session-leave");
  });

  it("endVoiceTurn is generation-guarded — a stale turn cannot clobber its successor", () => {
    const s = makeSession();
    const t1 = beginVoiceTurn(s, "turn-1");
    const t2 = beginVoiceTurn(s, "turn-2");
    // A late finally from the superseded t1 must NOT clear the live t2.
    endVoiceTurn(s, t1);
    expect(s.currentTurn).toBe(t2);
    // Ending the live turn clears it and returns to idle.
    endVoiceTurn(s, t2);
    expect(s.currentTurn).toBeNull();
    expect(s.phase).toBe("idle");
  });

  it("setVoicePhase writes the coarse turn phase", () => {
    const s = makeSession();
    setVoicePhase(s, "speaking");
    expect(s.phase).toBe("speaking");
    setVoicePhase(s, "listening");
    expect(s.phase).toBe("listening");
  });

  it("isVoiceAbortError classifies aborts as benign and real errors as not", () => {
    const abortErr = new Error("voice-turn-abort: barge-in");
    abortErr.name = "AbortError";
    expect(isVoiceAbortError(abortErr)).toBe(true);
    expect(isVoiceAbortError(new Error("The operation was aborted"))).toBe(true);
    expect(isVoiceAbortError(new Error("ElevenLabs 500"))).toBe(false);
    expect(isVoiceAbortError(null)).toBe(false);
    expect(isVoiceAbortError("nope")).toBe(false);
  });
});
