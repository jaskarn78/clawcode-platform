/**
 * 999.116 A3 (G7) — per-turn latency trace unit tests.
 *
 * Pins the record shape `scripts/voice-verify.py` parses: the tag, the
 * first-wins stamp semantics, every delta (null when a leg is missing), the
 * abort-reason → outcome mapping, and the resource-matched AudioPlayer
 * observer that survives a progress cue being replaced mid-playback.
 */
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  VOICE_TURN_TRACE_TAG,
  attachPlayerTrace,
  createVoiceTurnTrace,
  outcomeForAbortReason,
  stampVoiceTurn,
  summarizeVoiceTurnTrace,
  type VoiceTurnTrace,
} from "../turn-trace.js";

const META = {
  agent: "personal",
  sessionId: "sess-1",
  turnId: "turn-1",
  generation: 3,
  engine: "nova3",
  streamingTts: false,
  bargeInEnabled: true,
};

function tracedTurn(): VoiceTurnTrace {
  // A fully-stamped nova-3 + HTTP-TTS turn, times in ms from t0.
  const t = createVoiceTurnTrace({
    sttTiming: { speechEndAt: 1000, decisionAt: 1900, reason: "speech_final" },
    enqueuedAt: 1905,
    dispatchedAt: 2000,
    transcriptChars: 42,
  });
  stampVoiceTurn(t, "firstToken", 4000);
  stampVoiceTurn(t, "ttsRequest", 9000);
  stampVoiceTurn(t, "ttsFirstByte", 9400);
  stampVoiceTurn(t, "firstFrame", 9600);
  stampVoiceTurn(t, "playbackEnd", 14600);
  stampVoiceTurn(t, "end", 14650);
  t.outcome = "spoken";
  t.ttsMode = "http";
  t.responseChars = 300;
  return t;
}

describe("createVoiceTurnTrace / stampVoiceTurn", () => {
  it("seeds the pre-dispatch stamps and the STT reason from the timing handoff", () => {
    const t = createVoiceTurnTrace({
      sttTiming: { speechEndAt: 10, decisionAt: 20, reason: "flux_end_of_turn" },
      enqueuedAt: 21,
      dispatchedAt: 25,
      transcriptChars: 7,
    });
    expect(t.stamps.get("speechEnd")).toBe(10);
    expect(t.stamps.get("sttDecision")).toBe(20);
    expect(t.stamps.get("enqueue")).toBe(21);
    expect(t.stamps.get("dispatch")).toBe(25);
    expect(t.sttReason).toBe("flux_end_of_turn");
    expect(t.transcriptChars).toBe(7);
    expect(t.outcome).toBe("unknown");
    expect(t.ttsMode).toBe("none");
  });

  it("tolerates a timing handoff with no speechEnd (first utterance before any audio frame)", () => {
    const t = createVoiceTurnTrace({ sttTiming: { decisionAt: 20 } });
    expect(t.stamps.has("speechEnd")).toBe(false);
    expect(t.stamps.get("sttDecision")).toBe(20);
  });

  it("stamps are first-wins so hot paths can stamp unconditionally", () => {
    const t = createVoiceTurnTrace();
    expect(stampVoiceTurn(t, "firstToken", 100)).toBe(true);
    expect(stampVoiceTurn(t, "firstToken", 200)).toBe(false);
    expect(t.stamps.get("firstToken")).toBe(100);
  });
});

describe("summarizeVoiceTurnTrace", () => {
  it("carries the grep-stable tag and the flag/meta fields", () => {
    const r = summarizeVoiceTurnTrace(tracedTurn(), META);
    expect(r.tag).toBe(VOICE_TURN_TRACE_TAG);
    expect(VOICE_TURN_TRACE_TAG).toBe("phase999.116-voice-turn");
    expect(r).toMatchObject({
      agent: "personal",
      sessionId: "sess-1",
      turnId: "turn-1",
      generation: 3,
      engine: "nova3",
      streamingTts: false,
      bargeInEnabled: true,
      ttsMode: "http",
      outcome: "spoken",
      sttReason: "speech_final",
      transcriptChars: 42,
      responseChars: 300,
    });
  });

  it("computes every leg of the latency budget", () => {
    const r = summarizeVoiceTurnTrace(tracedTurn(), META);
    expect(r.sttLagMs).toBe(900); // speechEnd 1000 → decision 1900
    expect(r.queueMs).toBe(100); // decision 1900 → dispatch 2000
    expect(r.ttftMs).toBe(2000); // dispatch → firstToken 4000
    expect(r.firstSentenceMs).toBeNull(); // HTTP path: no sentence stamp
    expect(r.ttsFirstByteMs).toBe(400); // ttsRequest 9000 → firstByte 9400
    expect(r.firstFrameMs).toBe(200); // 9400 → 9600
    expect(r.tokenToAudioMs).toBe(5600); // 4000 → 9600
    expect(r.dispatchToAudioMs).toBe(7600);
    expect(r.speechEndToAudioMs).toBe(8600); // the dead air the user hears
    expect(r.playbackMs).toBe(5000);
    expect(r.totalMs).toBe(12650);
    expect(r.cueFired).toBe(false);
    expect(r.cueAtMs).toBeNull();
    expect(r.bargeInResult).toBeNull();
    expect(r.bargeInResolveMs).toBeNull();
    expect(r.stampsAt.firstFrame).toBe(9600);
  });

  it("uses the streaming legs when a sentence was pushed before TTS audio", () => {
    const t = createVoiceTurnTrace({ dispatchedAt: 0 });
    stampVoiceTurn(t, "firstToken", 700);
    stampVoiceTurn(t, "firstSentence", 1500);
    stampVoiceTurn(t, "ttsFirstByte", 1650);
    stampVoiceTurn(t, "firstFrame", 1800);
    t.ttsMode = "ws";
    const r = summarizeVoiceTurnTrace(t, { ...META, streamingTts: true });
    expect(r.firstSentenceMs).toBe(800);
    expect(r.ttsFirstByteMs).toBe(150); // measured from firstSentence, not ttsRequest
    expect(r.tokenToAudioMs).toBe(1100);
  });

  it("falls back to enqueue for the queue leg when STT timing was not handed over", () => {
    const t = createVoiceTurnTrace({ enqueuedAt: 100, dispatchedAt: 350 });
    const r = summarizeVoiceTurnTrace(t, META);
    expect(r.queueMs).toBe(250);
    expect(r.sttLagMs).toBeNull();
    expect(r.speechEndToAudioMs).toBeNull();
  });

  it("reports the barge-in legs and the cue", () => {
    const t = createVoiceTurnTrace({ dispatchedAt: 0 });
    stampVoiceTurn(t, "firstFrame", 3000);
    stampVoiceTurn(t, "cue", 2500);
    t.cueFired = true;
    stampVoiceTurn(t, "bargeInPause", 5000);
    stampVoiceTurn(t, "bargeInResolved", 5400);
    t.bargeInOpenings = 2;
    t.bargeInResult = "confirm";
    t.outcome = "aborted:barge-in";
    t.abortReason = "barge-in";
    const r = summarizeVoiceTurnTrace(t, META);
    expect(r.cueFired).toBe(true);
    expect(r.cueAtMs).toBe(2500);
    expect(r.bargeInOpenings).toBe(2);
    expect(r.bargeInResult).toBe("confirm");
    expect(r.bargeInResolveMs).toBe(400);
    expect(r.bargeInAtMs).toBe(2000);
    expect(r.outcome).toBe("aborted:barge-in");
    expect(r.abortReason).toBe("barge-in");
  });

  it("never carries transcript or response text (lengths only)", () => {
    const r = summarizeVoiceTurnTrace(tracedTurn(), META);
    const keys = Object.keys(r);
    expect(keys).not.toContain("transcript");
    expect(keys).not.toContain("response");
    expect(keys).not.toContain("text");
  });

  it("is pure — summarizing twice yields equal records and leaves the trace untouched", () => {
    const t = tracedTurn();
    const before = new Map(t.stamps);
    const a = summarizeVoiceTurnTrace(t, META);
    const b = summarizeVoiceTurnTrace(t, META);
    expect(a).toEqual(b);
    expect(t.stamps).toEqual(before);
  });
});

describe("outcomeForAbortReason", () => {
  it("maps the two live abort reasons and keeps a generic bucket", () => {
    expect(outcomeForAbortReason("barge-in")).toBe("aborted:barge-in");
    expect(outcomeForAbortReason("session-leave")).toBe("aborted:leave");
    expect(outcomeForAbortReason("something-else")).toBe("aborted");
  });
});

describe("attachPlayerTrace", () => {
  function fakePlayer() {
    const em = new EventEmitter();
    let state: { status: string; resource?: unknown } = { status: "idle" };
    return {
      em,
      set(next: { status: string; resource?: unknown }) {
        const old = state;
        state = next;
        em.emit("stateChange", old, next);
      },
      player: {
        on: (ev: string, cb: (...a: unknown[]) => void) => em.on(ev, cb),
        off: (ev: string, cb: (...a: unknown[]) => void) => em.off(ev, cb),
      },
    };
  }

  it("stamps firstFrame when OUR resource starts playing and playbackEnd when it stops", () => {
    const fp = fakePlayer();
    const ours = { id: "answer" };
    const t = createVoiceTurnTrace();
    attachPlayerTrace(fp.player, ours, t);
    fp.set({ status: "buffering", resource: ours });
    expect(t.stamps.has("firstFrame")).toBe(false);
    fp.set({ status: "playing", resource: ours });
    expect(t.stamps.has("firstFrame")).toBe(true);
    expect(t.stamps.has("playbackEnd")).toBe(false);
    fp.set({ status: "idle" });
    expect(t.stamps.has("playbackEnd")).toBe(true);
  });

  it("ignores a progress cue that is playing when the real answer replaces it", () => {
    const fp = fakePlayer();
    const cue = { id: "cue" };
    const ours = { id: "answer" };
    const t = createVoiceTurnTrace();
    // The cue is already playing before we register (cue's play() came first).
    fp.set({ status: "playing", resource: cue });
    attachPlayerTrace(fp.player, ours, t);
    // Cue keeps playing — no stamp for a foreign resource.
    fp.set({ status: "playing", resource: cue });
    expect(t.stamps.has("firstFrame")).toBe(false);
    // Our resource replaces the cue: Buffering → Playing.
    fp.set({ status: "buffering", resource: ours });
    fp.set({ status: "playing", resource: ours });
    expect(t.stamps.has("firstFrame")).toBe(true);
    // The cue's own end must not be mistaken for ours (already gone).
    expect(t.stamps.has("playbackEnd")).toBe(false);
  });

  it("stamps playbackEnd on a barge-in stop (idle with our resource as the old state)", () => {
    const fp = fakePlayer();
    const ours = { id: "answer" };
    const t = createVoiceTurnTrace();
    attachPlayerTrace(fp.player, ours, t);
    fp.set({ status: "playing", resource: ours });
    fp.set({ status: "idle" }); // player.stop(true)
    expect(t.stamps.has("playbackEnd")).toBe(true);
  });

  it("detaches after playbackEnd and via the returned function; no-ops on event-less fakes", () => {
    const fp = fakePlayer();
    const ours = { id: "answer" };
    const t = createVoiceTurnTrace();
    const detach = attachPlayerTrace(fp.player, ours, t);
    fp.set({ status: "playing", resource: ours });
    fp.set({ status: "idle" });
    expect(fp.em.listenerCount("stateChange")).toBe(0);
    detach(); // idempotent
    // Minimal {play, stop} fake from the bridge tests — must not throw.
    const noop = attachPlayerTrace({ play: () => undefined, stop: () => undefined }, ours, t);
    expect(typeof noop).toBe("function");
    noop();
  });
});
