/**
 * 999.116 A3 (G7) — per-turn latency trace for Discord voice.
 *
 * Every previous voice verify (135, 135.1, REBUILD) needed the operator to
 * join a call and grep a handful of log strings that had drifted from the
 * deployed build — "deployed observability is untrustworthy". This module
 * gives each assistant turn ONE structured record with the legs of the
 * voice-to-voice latency budget, emitted by the bridge as a single pino line
 * tagged {@link VOICE_TURN_TRACE_TAG}. `scripts/voice-verify.sh` reads that
 * line off the prod journal and prints a PASS/FAIL table, so the runbook is
 * "join the voice channel, talk, read six lines of output".
 *
 * Stamps (all wall-clock ms; each is first-wins so hot paths can call
 * {@link stampVoiceTurn} unconditionally):
 *
 *   speechEnd      last user audio frame seen before the STT decision
 *   sttDecision    STT emitted the complete turn (speech_final / UtteranceEnd /
 *                  Finalize on nova-3; EndOfTurn on Flux)
 *   enqueue        bridge received the transcript (before the turn lock)
 *   dispatch       turn lock acquired, agent turn begins (== VoiceTurn.startedAt)
 *   firstToken     first non-empty LLM delta
 *   firstSentence  first sentence handed to streaming TTS (WS path only)
 *   ttsRequest     HTTP TTS request started (HTTP path only)
 *   ttsFirstByte   first audio bytes from TTS (WS: first audio message on the
 *                  turn's context; HTTP: response stream received)
 *   firstFrame     the AudioPlayer started playing THIS turn's resource
 *   playbackEnd    the player left this turn's resource (finished or stopped)
 *   bargeInPause   Stage-A pause on a speaking-start during playback
 *   bargeInResolved Stage-B confirm, or rollback (backchannel / timeout)
 *   cue            the silence-window progress cue spoke
 *   end            the turn settled (bridge finally)
 *
 * The trace object itself is mutated in place — it mirrors the VoiceSession /
 * VoiceTurn convention in this directory (session state is mutable by design
 * so deep callbacks can reach it) — but {@link summarizeVoiceTurnTrace} is
 * pure: same trace in, same record out, no side effects.
 *
 * Privacy (Phase 135 REVIEW WR-01): the record carries LENGTHS only, never
 * transcript or response text.
 */

/** The grep-stable tag on every per-turn record. */
export const VOICE_TURN_TRACE_TAG = "phase999.116-voice-turn" as const;

/** The pino message on the per-turn record (paired with the tag). */
export const VOICE_TURN_TRACE_MSG = "voice turn trace" as const;

export type VoiceTurnStamp =
  | "speechEnd"
  | "sttDecision"
  | "enqueue"
  | "dispatch"
  | "firstToken"
  | "firstSentence"
  | "ttsRequest"
  | "ttsFirstByte"
  | "firstFrame"
  | "playbackEnd"
  | "bargeInPause"
  | "bargeInResolved"
  | "cue"
  | "end";

export type VoiceTurnOutcome =
  | "spoken"
  | "aborted:barge-in"
  | "aborted:leave"
  | "aborted"
  | "empty"
  | "tts-error"
  | "error"
  | "unknown";

export type VoiceTtsMode = "ws" | "http" | "none";

export type VoiceBargeInResult = "confirm" | "backchannel" | "timeout";

/**
 * What the STT layer knows at the moment it emits a complete turn. Built by
 * VoiceManager at the decision site and handed to the bridge alongside the
 * transcript (explicit argument — not a session field — so the handoff is
 * visible at every hop: manager → ingress → bridge).
 */
export type VoiceSttTiming = {
  /** Last user audio frame seen for the speaker before the decision. */
  readonly speechEndAt?: number;
  /** When STT emitted the complete turn. */
  readonly decisionAt: number;
  /** speech_final | utterance_end | finalize | flux_end_of_turn */
  readonly reason?: string;
};

export type VoiceTurnTrace = {
  readonly stamps: Map<VoiceTurnStamp, number>;
  outcome: VoiceTurnOutcome;
  ttsMode: VoiceTtsMode;
  sttReason: string | null;
  abortReason: string | null;
  /** Last barge-in resolution on this turn (a turn may see several openings). */
  bargeInResult: VoiceBargeInResult | null;
  /** Stage-A openings on this turn (confirmed or rolled back). */
  bargeInOpenings: number;
  cueFired: boolean;
  transcriptChars: number;
  responseChars: number;
};

export type VoiceTurnTraceSeed = {
  readonly sttTiming?: VoiceSttTiming;
  readonly enqueuedAt?: number;
  readonly dispatchedAt?: number;
  readonly transcriptChars?: number;
};

/** Allocate a fresh trace, seeding the pre-dispatch stamps when known. */
export function createVoiceTurnTrace(seed: VoiceTurnTraceSeed = {}): VoiceTurnTrace {
  const stamps = new Map<VoiceTurnStamp, number>();
  const timing = seed.sttTiming;
  if (typeof timing?.speechEndAt === "number") stamps.set("speechEnd", timing.speechEndAt);
  if (typeof timing?.decisionAt === "number") stamps.set("sttDecision", timing.decisionAt);
  if (typeof seed.enqueuedAt === "number") stamps.set("enqueue", seed.enqueuedAt);
  if (typeof seed.dispatchedAt === "number") stamps.set("dispatch", seed.dispatchedAt);
  return {
    stamps,
    outcome: "unknown",
    ttsMode: "none",
    sttReason: timing?.reason ?? null,
    abortReason: null,
    bargeInResult: null,
    bargeInOpenings: 0,
    cueFired: false,
    transcriptChars: seed.transcriptChars ?? 0,
    responseChars: 0,
  };
}

/**
 * Record a stamp. First-wins: returns true when this call set it, false when
 * it was already present — so `firstToken` can be stamped on every LLM delta
 * and `firstFrame` on every player state change without extra bookkeeping.
 */
export function stampVoiceTurn(
  trace: VoiceTurnTrace,
  key: VoiceTurnStamp,
  at: number = Date.now(),
): boolean {
  if (trace.stamps.has(key)) return false;
  trace.stamps.set(key, at);
  return true;
}

/** Map an abortVoiceTurn reason onto a turn outcome. */
export function outcomeForAbortReason(reason: string): VoiceTurnOutcome {
  if (reason === "barge-in") return "aborted:barge-in";
  if (reason === "session-leave") return "aborted:leave";
  return "aborted";
}

export type VoiceTurnTraceMeta = {
  readonly agent: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly generation: number;
  readonly engine: string;
  readonly streamingTts: boolean;
  readonly bargeInEnabled: boolean;
};

/** The flat, grep/jq-friendly record logged once per turn. */
export type VoiceTurnTraceRecord = {
  readonly tag: typeof VOICE_TURN_TRACE_TAG;
  readonly agent: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly generation: number;
  readonly engine: string;
  readonly streamingTts: boolean;
  readonly bargeInEnabled: boolean;
  readonly ttsMode: VoiceTtsMode;
  readonly outcome: VoiceTurnOutcome;
  readonly sttReason: string | null;
  readonly abortReason: string | null;
  readonly transcriptChars: number;
  readonly responseChars: number;
  /** speechEnd → sttDecision: the STT end-of-turn lag (nova-3 timers vs Flux). */
  readonly sttLagMs: number | null;
  /** sttDecision (or enqueue) → dispatch: time spent waiting on the turn lock. */
  readonly queueMs: number | null;
  /** dispatch → firstToken. */
  readonly ttftMs: number | null;
  /** firstToken → firstSentence (WS path). */
  readonly firstSentenceMs: number | null;
  /** firstSentence (WS) or ttsRequest (HTTP) → ttsFirstByte. */
  readonly ttsFirstByteMs: number | null;
  /** ttsFirstByte → firstFrame. */
  readonly firstFrameMs: number | null;
  /** firstToken → firstFrame: the streaming-TTS lever, model-independent. */
  readonly tokenToAudioMs: number | null;
  /** dispatch → firstFrame. */
  readonly dispatchToAudioMs: number | null;
  /** speechEnd → firstFrame: the dead air the user actually hears. */
  readonly speechEndToAudioMs: number | null;
  /** firstFrame → playbackEnd. */
  readonly playbackMs: number | null;
  /** dispatch → end. */
  readonly totalMs: number | null;
  readonly cueFired: boolean;
  /** dispatch → cue. */
  readonly cueAtMs: number | null;
  readonly bargeInOpenings: number;
  readonly bargeInResult: VoiceBargeInResult | null;
  /** bargeInPause → bargeInResolved (Stage-B decision latency). */
  readonly bargeInResolveMs: number | null;
  /** firstFrame → bargeInPause: how far into playback the interrupt came. */
  readonly bargeInAtMs: number | null;
  /** Absolute epoch-ms stamps, for ad-hoc debugging. */
  readonly stampsAt: Readonly<Partial<Record<VoiceTurnStamp, number>>>;
};

function delta(
  stamps: ReadonlyMap<VoiceTurnStamp, number>,
  from: VoiceTurnStamp,
  to: VoiceTurnStamp,
): number | null {
  const a = stamps.get(from);
  const b = stamps.get(to);
  if (typeof a !== "number" || typeof b !== "number") return null;
  return Math.max(0, Math.round(b - a));
}

/** Pure: fold a trace into the flat record. */
export function summarizeVoiceTurnTrace(
  trace: VoiceTurnTrace,
  meta: VoiceTurnTraceMeta,
): VoiceTurnTraceRecord {
  const s = trace.stamps;
  const queueFrom: VoiceTurnStamp = s.has("sttDecision") ? "sttDecision" : "enqueue";
  const ttsFrom: VoiceTurnStamp = s.has("firstSentence") ? "firstSentence" : "ttsRequest";
  const stampsAt: Partial<Record<VoiceTurnStamp, number>> = {};
  for (const [k, v] of s) stampsAt[k] = v;
  return {
    tag: VOICE_TURN_TRACE_TAG,
    agent: meta.agent,
    sessionId: meta.sessionId,
    turnId: meta.turnId,
    generation: meta.generation,
    engine: meta.engine,
    streamingTts: meta.streamingTts,
    bargeInEnabled: meta.bargeInEnabled,
    ttsMode: trace.ttsMode,
    outcome: trace.outcome,
    sttReason: trace.sttReason,
    abortReason: trace.abortReason,
    transcriptChars: trace.transcriptChars,
    responseChars: trace.responseChars,
    sttLagMs: delta(s, "speechEnd", "sttDecision"),
    queueMs: delta(s, queueFrom, "dispatch"),
    ttftMs: delta(s, "dispatch", "firstToken"),
    firstSentenceMs: delta(s, "firstToken", "firstSentence"),
    ttsFirstByteMs: delta(s, ttsFrom, "ttsFirstByte"),
    firstFrameMs: delta(s, "ttsFirstByte", "firstFrame"),
    tokenToAudioMs: delta(s, "firstToken", "firstFrame"),
    dispatchToAudioMs: delta(s, "dispatch", "firstFrame"),
    speechEndToAudioMs: delta(s, "speechEnd", "firstFrame"),
    playbackMs: delta(s, "firstFrame", "playbackEnd"),
    totalMs: delta(s, "dispatch", "end"),
    cueFired: trace.cueFired,
    cueAtMs: delta(s, "dispatch", "cue"),
    bargeInOpenings: trace.bargeInOpenings,
    bargeInResult: trace.bargeInResult,
    bargeInResolveMs: delta(s, "bargeInPause", "bargeInResolved"),
    bargeInAtMs: delta(s, "firstFrame", "bargeInPause"),
    stampsAt,
  };
}

// ─── AudioPlayer observation ────────────────────────────────────────────────

/**
 * @discordjs/voice AudioPlayerStatus string values. Spelled out here so this
 * module stays free of the voice package (it is imported by the pure
 * turn-state module and its tests).
 */
const PLAYER_STATUS_PLAYING = "playing";
const PLAYER_STATUS_IDLE = "idle";

type PlayerStateLike = { readonly status?: string; readonly resource?: unknown };

type ObservablePlayer = {
  on?: (event: string, cb: (...args: unknown[]) => void) => unknown;
  off?: (event: string, cb: (...args: unknown[]) => void) => unknown;
};

/**
 * Stamp `firstFrame` when the player starts playing THIS turn's resource and
 * `playbackEnd` when it leaves it. Matching on the resource (not just the
 * status) keeps the stamps honest when a progress cue is mid-playback as the
 * real answer's `player.play()` replaces it. Register BEFORE calling
 * `player.play(resource)`. Returns a detach function; tolerates the minimal
 * `{play, stop}` fakes used by the test suite (no-op when the player has no
 * event API).
 */
export function attachPlayerTrace(
  player: unknown,
  resource: unknown,
  trace: VoiceTurnTrace,
): () => void {
  const p = player as ObservablePlayer | null | undefined;
  if (!p || typeof p.on !== "function" || typeof p.off !== "function") {
    return () => undefined;
  }
  const on = p.on.bind(p);
  const off = p.off.bind(p);
  const onStateChange = (...args: unknown[]) => {
    const oldState = (args[0] ?? {}) as PlayerStateLike;
    const newState = (args[1] ?? {}) as PlayerStateLike;
    if (newState.resource === resource && newState.status === PLAYER_STATUS_PLAYING) {
      stampVoiceTurn(trace, "firstFrame");
      return;
    }
    const leftOurs =
      oldState.resource === resource &&
      (newState.resource !== resource || newState.status === PLAYER_STATUS_IDLE);
    if (leftOurs && trace.stamps.has("firstFrame")) {
      stampVoiceTurn(trace, "playbackEnd");
      detach();
    }
  };
  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    try {
      off("stateChange", onStateChange);
    } catch {
      /* non-fatal */
    }
  };
  on("stateChange", onStateChange);
  return detach;
}
