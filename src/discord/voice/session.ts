/**
 * Phase 135 Plan 02 — VoiceSession type + factory.
 *
 * One `VoiceSession` per (agent, guild) join. Owns the discord.js voice
 * connection, an audio player subscribed to that connection, the dedup
 * capture state, a silence timer (Plan 03 wires Haiku fallback), and a
 * monthly minutes counter (Plan 03 wires cap enforcement).
 *
 * Plan 02 changes from Plan 01:
 *   - `voiceCfg` switched from the forward-declared `VoiceConfigShape` to
 *     the real `VoiceConfig` from `../../config/schema.js`. (The Plan 01
 *     shape was a structural stand-in to avoid a circular import while the
 *     schema layer was still being scaffolded.)
 *   - Added `createdAt` timestamp so `VoiceManager.status()` can derive
 *     `durationMs = Date.now() - createdAt`.
 *   - Added `activeReceivers` map keyed by Discord userId → Opus
 *     receiver stream. Plan 02's `attachSpeakingListeners` stores
 *     references here so the `voiceStateUpdate` listener (Pitfall 5)
 *     can clean them up when a user leaves voice.
 *   - Added `deepgramConnection` field with the concrete `V1Socket`
 *     type from `@deepgram/sdk` (replaces the Plan 01 `unknown`).
 */
import type { AudioPlayer, VoiceConnection } from "@discordjs/voice";
import type { Readable } from "node:stream";
import type { VoiceConfig } from "../../config/schema.js";
import { createVoiceCaptureState, type VoiceCaptureState } from "./capture-state.js";
import type { MinutesTracker } from "./minutes-cap.js";
import type { VoiceTurnTrace } from "./turn-trace.js";

/**
 * Plan 01 forward-declared a structural shape because the schema-side
 * `VoiceConfig` was not yet usable from this file (circular-import
 * concerns during scaffolding). Plan 02 imports the real type. The shape
 * is preserved as an alias for any downstream consumer still importing
 * it from this module.
 */
export type VoiceConfigShape = VoiceConfig;

/**
 * Deepgram live-WS connection handle. We import the type lazily via a
 * structural shape (we use `sendMedia`, `close`, and `on` plus an
 * optional `waitForOpen`) so unit tests can substitute a minimal stub
 * without dragging the real SDK type machinery into every test fixture.
 */
export type DeepgramLiveConnection = {
  sendMedia: (data: ArrayBuffer | Blob | ArrayBufferView) => void;
  close: () => void;
  on: (event: string, callback: (...args: unknown[]) => void) => void;
  // Optional — the real SDK exposes this; tests may omit it.
  waitForOpen?: () => Promise<unknown>;
};

/**
 * Phase 135.1 — coarse turn-taking phase for the barge-in state machine.
 * IDLE (no user speech, nothing playing) | LISTENING (user speaking, STT
 * streaming) | THINKING (turn dispatched, no audio yet; abort armed) |
 * SPEAKING (TTS open and/or player Playing) | INTERRUPT_PENDING (tentative
 * barge-in: playback paused, awaiting confirm/rollback). Owned by the
 * TurnController in turn-state.ts; stored on the session so the audio-in
 * path (manager.ts speaking-start) can read it without a back-import.
 */
export type VoiceTurnPhase =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupt_pending";

/**
 * Phase 135.1 — one in-flight assistant turn (LLM dispatch → TTS → playback).
 * The `abort` controller is threaded into the SDK via DispatchOptions.signal
 * (turn-dispatcher.ts:205) so a barge-in (or leave) cancels generation, not
 * just audio. `generation` extends the capture-state.ts supersede primitive
 * to assistant turns: a bumped generation drops any late LLM/TTS output from
 * a cancelled turn as stale. `ttsStream` is the parked ElevenLabs node stream
 * so a hard-stop can destroy it in the same tick as `player.stop(true)`.
 */
export type VoiceTurn = {
  readonly id: string;
  readonly generation: number;
  readonly abort: AbortController;
  ttsStream: import("node:stream").Readable | null;
  readonly startedAt: number;
  /**
   * 999.116 A3 (G7) — per-turn latency stamps, folded into one structured
   * log record when the turn settles (see turn-trace.ts).
   */
  readonly trace: VoiceTurnTrace;
};

export type VoiceSession = {
  readonly id: string;
  readonly agentName: string;
  readonly channelId: string;
  readonly guildId: string;
  /** UTC ms timestamp at construction — used by `status()` for `durationMs`. */
  readonly createdAt: number;
  /** Plan 02 sets this to the live `joinVoiceChannel(...)` result. */
  connection: VoiceConnection | null;
  /** Plan 02 sets this to a `createAudioPlayer()` instance subscribed to `connection`. */
  player: AudioPlayer | null;
  readonly captureState: VoiceCaptureState;
  /** Plan 03 wires the 30s Haiku silence-fallback timer here. */
  silenceTimer: NodeJS.Timeout | null;
  /**
   * Phase 135 REVIEW CR-02 — race guard. Flipped to `true` inside
   * `fireHaikuFallback` BEFORE the Haiku call begins (claim-speaker
   * pattern). The bridge's voice-response path checks this flag before
   * calling `speakResponse` so the agent doesn't speak over Haiku when
   * a slow turn finishes between the 30s timer fire and the user
   * hearing Haiku audio. Reset at the start of every new turn (top of
   * `handleVoiceTranscript`, before `armSilenceTimer`) so subsequent
   * utterances aren't permanently suppressed.
   */
  fallbackSpoken: boolean;
  /** Plan 03 enforces `voiceCfg.monthlyMinutesCap` against this counter. */
  minutesUsedThisMonth: number;
  /**
   * Plan 02 — the Deepgram streaming WS opened in `VoiceManager.join()`.
   * One connection per session (lives for the whole join → leave window,
   * NOT per utterance — RESEARCH Pitfall 4).
   */
  deepgramConnection: DeepgramLiveConnection | null;
  /**
   * Plan 02 — active per-user Opus receiver subscriptions. Keyed by Discord
   * userId. Closed and removed on `voiceStateUpdate` user-leave events to
   * prevent the subscription leak called out in RESEARCH Pitfall 5.
   */
  readonly activeReceivers: Map<string, Readable>;
  /**
   * Plan 02 single-speaker attribution (CONTEXT.md decision: no
   * multi-speaker context tracking until v3.0.1). When Deepgram V1
   * delivers a final transcript without per-user attribution, the
   * manager resolves the speaker via this field: the userId from the
   * most recent `receiver.speaking.on("start", ...)` event becomes
   * the transcript's attributed speaker.
   *
   * `lastSpeakerGeneration` captures the dedup generation at
   * `speaking.start` time; `handleFinalTranscript` compares it against
   * `currentGeneration(captureState, lastSpeakerUserId)` to drop
   * stale finals.
   *
   * Null when no user has spoken yet on this session OR when the
   * most recent speaker's capture was already finished.
   */
  lastSpeakerUserId: string | null;
  lastSpeakerGeneration: number;
  /**
   * Phase 135 Plan 03 Task 3 — per-session monthly minutes tracker.
   * VoiceManager.join() instantiates this against the agent's memoryPath
   * (filesystem JSON at <memoryPath>/voice-minutes.json). Plan 03's
   * stt.ts utterance callback + tts.ts synthesis path call
   * `addUtteranceSeconds` / `addSynthesisSeconds`; the manager-level
   * cap-check happens after each accumulation. Null when the agent has
   * no voice block (impossible if the session was constructed, but
   * preserved as a non-throwing fallback for legacy tests / fixtures).
   */
  minutesTracker: MinutesTracker | null;
  /**
   * Wall-clock ms timestamp of the last `receiver.speaking.on("start")`
   * event per active user — used as fallback by stt.ts when the
   * Deepgram SDK doesn't expose an `audio_duration` field on the final
   * transcript message. Key: Discord userId.
   */
  readonly utteranceStartedAt: Map<string, number>;
  /**
   * 999.116 A3 (G7) — wall-clock ms of the last decoded PCM frame received
   * per user. Discord only delivers audio while a user speaks, so at the STT
   * decision this is "when they stopped talking" — the start of the dead-air
   * clock the turn trace measures. Optional so hand-built test fixtures need
   * not be re-touched.
   */
  readonly lastAudioAt?: Map<string, number>;
  /** 999.116 hotfix — receive-path counters (see {@link VoiceSessionStats}). */
  stats?: VoiceSessionStats;
  readonly voiceCfg: VoiceConfig;
  /**
   * 135.0.5 — per-session turn lock. Promise chain that serialises
   * concurrent handleVoiceTranscript calls so two transcripts arriving
   * close together don't fight for the AudioPlayer. Each new turn awaits
   * the previous one's settlement before dispatching its own agent turn +
   * TTS. Without this, Deepgram's utterance_end_ms boundary firing twice
   * in quick succession causes the second TTS to interrupt the first
   * mid-speech.
   */
  turnLock: Promise<void>;
  /**
   * Phase 135.1 — current turn-taking phase (barge-in state machine).
   * Defaults to "idle"; driven by the TurnController (turn-state.ts).
   */
  phase: VoiceTurnPhase;
  /**
   * Phase 135.1 — the in-flight assistant turn, or null when idle/listening.
   * Set by beginVoiceTurn, cleared by endVoiceTurn/abortVoiceTurn. Carries
   * the per-turn AbortController threaded into the SDK and the parked TTS
   * stream for hard-stop.
   */
  currentTurn: VoiceTurn | null;
  /**
   * Phase 135.1 — monotonic assistant-turn generation counter. Bumped on
   * every beginVoiceTurn and every abortVoiceTurn so late outputs from a
   * superseded/cancelled turn are dropped (same pattern as the per-user
   * capture-state generations, but for assistant turns).
   */
  turnGeneration: number;
  /**
   * Phase 135.1 Phase 3 — barge-in rollback timer, live only while the phase
   * is "interrupt_pending". Optional (undefined = no barge-in pending) so the
   * hand-built VoiceSession fixtures in the test suite need not be re-touched.
   */
  bargeInTimer?: NodeJS.Timeout | null;
  /** Phase 135.1 Phase 3 — phase to restore on a false-interrupt rollback. */
  bargeInPrevPhase?: VoiceTurnPhase | null;
  /**
   * Phase 135.1 Phase 3 — wall-clock ms until which the agent stays quiet
   * after a confirmed interrupt (post-interrupt backoff).
   */
  bargeInBackoffUntil?: number;
  /**
   * Phase 135.1 Phase 4 — lazily-opened ElevenLabs multi-context streaming-TTS
   * socket (one per session, reused across turns). Optional/null until the
   * first streaming turn; closed in leave(). Absent when streamingTts disabled.
   */
  ttsSocket?: import("./tts-ws.js").VoiceTtsSocket | null;
  /**
   * Phase 135.1 Phase 5 — per-user Deepgram Flux STT connections, keyed by
   * Discord userId (only when voice.stt.engine === "flux"). Lazily opened on
   * first speaking-start per user, closed on user-leave / session leave. Absent
   * on the nova-3 path (which uses the single shared `deepgramConnection`).
   */
  fluxConnections?: Map<string, import("./stt-flux.js").FluxLiveConnection>;
};

/**
 * 999.116 hotfix — per-session receive-path counters. Folded into the
 * "voice session closed" log line so a silent call answers, from the
 * journal alone: did Discord deliver packets (speakingStarts / usersHeard /
 * pcmFrames), did the decoder or receiver fail (receiverErrors), did Deepgram
 * hear words (sttInterims / sttFinals), what was filtered (sttDrops*), and
 * did DAVE decrypt fail (daveFailures).
 */
export type VoiceSessionStats = {
  speakingStarts: number;
  readonly usersHeard: Set<string>;
  pcmFrames: number;
  pcmBytes: number;
  receiverErrors: number;
  sttInterims: number;
  sttFinals: number;
  sttDropsLowConfidence: number;
  sttDropsShortUtterance: number;
  turnsDispatched: number;
  connectionDebugLines: number;
  daveFailures: number;
};

export function createVoiceSessionStats(): VoiceSessionStats {
  return {
    speakingStarts: 0,
    usersHeard: new Set(),
    pcmFrames: 0,
    pcmBytes: 0,
    receiverErrors: 0,
    sttInterims: 0,
    sttFinals: 0,
    sttDropsLowConfidence: 0,
    sttDropsShortUtterance: 0,
    turnsDispatched: 0,
    connectionDebugLines: 0,
    daveFailures: 0,
  };
}

/** Lazily attach stats (hand-built test fixtures omit the field). */
export function ensureSessionStats(session: VoiceSession): VoiceSessionStats {
  if (!session.stats) session.stats = createVoiceSessionStats();
  return session.stats;
}

/** Flat, log-friendly view of the stats (the Set becomes a count). */
export function summarizeSessionStats(
  session: VoiceSession,
): Record<string, number> {
  const s = session.stats ?? createVoiceSessionStats();
  return {
    speakingStarts: s.speakingStarts,
    usersHeard: s.usersHeard.size,
    pcmFrames: s.pcmFrames,
    pcmBytes: s.pcmBytes,
    receiverErrors: s.receiverErrors,
    sttInterims: s.sttInterims,
    sttFinals: s.sttFinals,
    sttDropsLowConfidence: s.sttDropsLowConfidence,
    sttDropsShortUtterance: s.sttDropsShortUtterance,
    turnsDispatched: s.turnsDispatched,
    daveFailures: s.daveFailures,
  };
}

/** Arguments for {@link createVoiceSession}. */
export type VoiceSessionInit = {
  readonly id: string;
  readonly agentName: string;
  readonly channelId: string;
  readonly guildId: string;
  readonly voiceCfg: VoiceConfig;
};

/**
 * Allocate a new VoiceSession with null runtime fields and a fresh
 * capture-state. The caller (`VoiceManager.join()`) populates
 * `connection`, `player`, and `deepgramConnection` once the live
 * resources are open.
 */
export function createVoiceSession(init: VoiceSessionInit): VoiceSession {
  return {
    id: init.id,
    agentName: init.agentName,
    channelId: init.channelId,
    guildId: init.guildId,
    createdAt: Date.now(),
    connection: null,
    player: null,
    captureState: createVoiceCaptureState(),
    silenceTimer: null,
    fallbackSpoken: false,
    minutesUsedThisMonth: 0,
    deepgramConnection: null,
    activeReceivers: new Map(),
    lastSpeakerUserId: null,
    lastSpeakerGeneration: 0,
    minutesTracker: null,
    utteranceStartedAt: new Map(),
    lastAudioAt: new Map(),
    stats: createVoiceSessionStats(),
    voiceCfg: init.voiceCfg,
    turnLock: Promise.resolve(),
    phase: "idle",
    currentTurn: null,
    turnGeneration: 0,
    bargeInTimer: null,
    bargeInPrevPhase: null,
    bargeInBackoffUntil: 0,
  };
}
