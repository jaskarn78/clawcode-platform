/**
 * Phase 135.1 — per-session voice TurnController (the cancellation spine).
 *
 * Owns the lifecycle of one in-flight assistant turn (LLM dispatch → TTS →
 * playback) and the turn-taking phase used by the barge-in state machine.
 * Deliberately a set of pure functions over the VoiceSession (not a class)
 * so it stays free of bridge/manager imports and testable in isolation —
 * the same convention the rest of src/discord/voice/ follows.
 *
 * The cancellation mechanism reuses the plumbing already present in-tree:
 *   - each turn carries an AbortController whose signal is threaded into the
 *     SDK via DispatchOptions.signal (turn-dispatcher.ts:205 → the SDK's
 *     native Options.abortController), so aborting cancels *generation*, not
 *     just audio; and
 *   - a monotonic per-session generation counter (mirroring the per-user
 *     capture-state.ts supersede primitive) so late LLM/TTS output from a
 *     cancelled turn is dropped as stale via {@link isCurrentVoiceTurn}.
 *
 * Phase 2 wires the ability to cancel; nothing user-facing triggers it yet.
 * Phase 3 (barge-in) calls {@link abortVoiceTurn} from the speaking-start tap.
 */
import type { VoiceSession, VoiceTurn, VoiceTurnPhase } from "./session.js";
import {
  createVoiceTurnTrace,
  outcomeForAbortReason,
  stampVoiceTurn,
  type VoiceBargeInResult,
  type VoiceTurnTraceSeed,
} from "./turn-trace.js";

/** Transition the session's coarse turn-taking phase. Pure state write. */
export function setVoicePhase(
  session: VoiceSession,
  phase: VoiceTurnPhase,
): void {
  session.phase = phase;
}

/**
 * Open a new assistant turn: bump the generation, mint a fresh
 * AbortController, and record it as the session's current turn. Transitions
 * the phase to "thinking" (audio not yet flowing). Any previously-current
 * turn is simply overwritten — callers that need to cancel the incumbent
 * first (barge-in) call {@link abortVoiceTurn} before this.
 */
export function beginVoiceTurn(
  session: VoiceSession,
  id: string,
  seed: VoiceTurnTraceSeed = {},
): VoiceTurn {
  session.turnGeneration += 1;
  const startedAt = Date.now();
  const turn: VoiceTurn = {
    id,
    generation: session.turnGeneration,
    abort: new AbortController(),
    ttsStream: null,
    startedAt,
    // 999.116 A3 (G7) — the dispatch stamp IS the turn start; the STT and
    // enqueue stamps arrive via the seed from the bridge.
    trace: createVoiceTurnTrace({ ...seed, dispatchedAt: startedAt }),
  };
  session.currentTurn = turn;
  session.phase = "thinking";
  return turn;
}

/**
 * True when `turn` is still the session's live turn (generation matches).
 * TTS-chunk writers and post-turn side-effects gate on this so output from
 * a superseded/aborted turn is dropped rather than played over a new turn.
 */
export function isCurrentVoiceTurn(
  session: VoiceSession,
  turn: VoiceTurn,
): boolean {
  return session.currentTurn?.generation === turn.generation;
}

/**
 * Hard-cancel the in-flight assistant turn:
 *   1. bump the generation so any late LLM/TTS output is stale,
 *   2. abort the SDK turn via its AbortController (stops generation),
 *   3. destroy the parked TTS node stream, and
 *   4. stop the audio player (`stop(true)` forces the Idle transition, which
 *      resolves the `waitForPlayerIdle` promise the awaiting speakResponse is
 *      blocked on — so the turn's finally chain runs and releases turnLock).
 *
 * Idempotent: a no-op returning null when there is no current turn. Returns
 * the cancelled turn so callers can inspect it (e.g., played-prefix bookkeeping).
 */
export function abortVoiceTurn(
  session: VoiceSession,
  reason: string,
): VoiceTurn | null {
  const turn = session.currentTurn;
  if (!turn) return null;
  // 999.116 A3 (G7) — record why the turn ended (a completed turn aborted by
  // a later leave() keeps its "spoken" outcome).
  turn.trace.abortReason = reason;
  if (turn.trace.outcome === "unknown") {
    turn.trace.outcome = outcomeForAbortReason(reason);
  }
  // Supersede first so any in-flight callback that checks isCurrentVoiceTurn
  // between here and the awaits below already sees itself as stale.
  session.turnGeneration += 1;
  session.currentTurn = null;
  try {
    if (!turn.abort.signal.aborted) {
      turn.abort.abort(new DOMExceptionLike(`voice-turn-abort: ${reason}`));
    }
  } catch {
    /* non-fatal — best-effort cancellation */
  }
  try {
    turn.ttsStream?.destroy();
  } catch {
    /* non-fatal */
  }
  try {
    session.player?.stop(true);
  } catch {
    /* non-fatal */
  }
  turn.ttsStream = null;
  // Clear any pending barge-in so a rollback timer can't fire against a
  // torn-down session and leave the phase stuck in "interrupt_pending".
  if (session.bargeInTimer) {
    clearTimeout(session.bargeInTimer);
    session.bargeInTimer = null;
  }
  session.bargeInPrevPhase = null;
  return turn;
}

/**
 * Clear the current turn on normal completion, generation-guarded so a turn
 * that was already superseded (barge-in) does not clobber its successor.
 * Resets the phase to "idle" only when the cleared turn was the live one.
 */
export function endVoiceTurn(session: VoiceSession, turn: VoiceTurn): void {
  if (session.currentTurn?.generation === turn.generation) {
    session.currentTurn = null;
    session.phase = "idle";
  }
}

/**
 * Classify an error thrown out of the dispatch/TTS path as a benign
 * voice-turn abort (barge-in / leave) rather than a real failure, so the
 * bridge's error boundary logs it at info and traces it as "aborted" instead
 * of spamming error logs and red turn dashboards on every interruption.
 */
export function isVoiceAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  if (name === "AbortError") return true;
  const msg = (err as { message?: unknown }).message;
  if (typeof msg === "string") {
    return (
      msg.includes("voice-turn-abort") ||
      msg.includes("The operation was aborted") ||
      msg.includes("aborted")
    );
  }
  return false;
}

// ─── Phase 135.1 Phase 3 — barge-in (two-stage interrupt) ──────────────────

/** Resolved barge-in tuning for a session (voice.bargeIn.* with defaults). */
export type BargeInConfig = {
  readonly enabled: boolean;
  readonly falseInterruptTimeoutMs: number;
  readonly minConfirmWords: number;
  readonly backoffMs: number;
};

export const DEFAULT_BARGEIN_FALSE_INTERRUPT_MS = 2000;
export const DEFAULT_BARGEIN_MIN_CONFIRM_WORDS = 2;
export const DEFAULT_BARGEIN_BACKOFF_MS = 800;

/**
 * Short affirmations / continuers that should NOT interrupt the agent
 * (LiveKit/Vapi "acknowledgement phrases"). A pending barge-in whose interim
 * is entirely these words rolls back instead of committing, so the agent keeps
 * talking through a listener's "mm-hm".
 */
const BACKCHANNEL_WORDS = new Set([
  "mm", "mhm", "mmhm", "uh", "uhhuh", "um", "huh", "yeah", "yep", "yup", "yes",
  "ya", "right", "ok", "okay", "k", "sure", "gotcha", "got", "it", "i", "see",
  "cool", "nice", "wow", "oh", "ah", "hmm", "totally", "exactly", "true",
  "agreed", "makes", "sense", "mmkay",
]);

/**
 * Single words that DO immediately confirm an interrupt even alone — notably
 * "stop", the one word a barge-in system must always hear, which today's
 * minWordCount filter would otherwise drop (Vapi "interruption phrases").
 */
const INTERRUPT_COMMANDS = new Set([
  "stop", "wait", "no", "nope", "hold", "pause", "actually", "hang", "cancel",
  "enough", "quiet", "sorry",
]);

export type BargeInClassification = "confirm" | "backchannel" | "unknown";

/**
 * Classify an interim transcript captured while the agent is speaking:
 *   - contains an explicit command word ("stop", "wait") → confirm now;
 *   - entirely backchannel and ≤3 words ("yeah", "got it") → backchannel;
 *   - ≥ minConfirmWords of real content → confirm;
 *   - otherwise → unknown (hold the tentative pause; wait for more interims).
 */
export function classifyBargeInText(
  text: string,
  minConfirmWords: number,
): BargeInClassification {
  const words = text
    .trim()
    .toLowerCase()
    // Join hyphenated backchannel spellings ("mm-hm"→"mmhm", "uh-huh"→"uhhuh")
    // so they match the lexicon, then drop remaining punctuation.
    .replace(/-/g, "")
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "unknown";
  if (words.some((w) => INTERRUPT_COMMANDS.has(w))) return "confirm";
  const contentWords = words.filter((w) => !BACKCHANNEL_WORDS.has(w));
  if (contentWords.length === 0 && words.length <= 3) return "backchannel";
  if (contentWords.length >= minConfirmWords) return "confirm";
  return "unknown";
}

/** Resolve the effective barge-in config from a session's voice block. */
export function resolveBargeInConfig(
  voiceCfg: VoiceSession["voiceCfg"],
): BargeInConfig {
  const b = (voiceCfg as { bargeIn?: Partial<BargeInConfig> }).bargeIn;
  return {
    enabled: b?.enabled ?? false,
    falseInterruptTimeoutMs:
      b?.falseInterruptTimeoutMs ?? DEFAULT_BARGEIN_FALSE_INTERRUPT_MS,
    minConfirmWords: b?.minConfirmWords ?? DEFAULT_BARGEIN_MIN_CONFIRM_WORDS,
    backoffMs: b?.backoffMs ?? DEFAULT_BARGEIN_BACKOFF_MS,
  };
}

type PlayerPauseControls = {
  pause?: (interpolateSilence?: boolean) => unknown;
  unpause?: () => unknown;
};

function clearBargeInTimer(session: VoiceSession): void {
  if (session.bargeInTimer) clearTimeout(session.bargeInTimer);
  session.bargeInTimer = null;
}

/**
 * 999.116 A3 (G7) — Stage-A opening on the live turn's trace. A turn can be
 * interrupted more than once (pause → rollback → pause …); the pause/resolve
 * pair always describes the LATEST opening, the counter keeps the total.
 */
function traceBargeInOpening(session: VoiceSession): void {
  const trace = session.currentTurn?.trace;
  if (!trace) return;
  trace.bargeInOpenings += 1;
  trace.stamps.delete("bargeInPause");
  trace.stamps.delete("bargeInResolved");
  stampVoiceTurn(trace, "bargeInPause");
}

/** 999.116 A3 (G7) — Stage-B resolution on the live turn's trace. */
function traceBargeInResolved(
  session: VoiceSession,
  result: VoiceBargeInResult,
): void {
  const trace = session.currentTurn?.trace;
  if (!trace) return;
  trace.bargeInResult = result;
  stampVoiceTurn(trace, "bargeInResolved");
}

/**
 * Stage A — the user started speaking while the agent is SPEAKING. Pause
 * playback immediately (~1 Opus frame to silence) and enter INTERRUPT_PENDING,
 * arming a rollback timer so a cough / stray noise that never confirms resumes
 * the agent. The generation is NOT bumped yet — the paused turn is still live.
 * Returns true when a tentative barge-in was opened. Only fires from SPEAKING
 * (v1 scope: interrupting audio; a THINKING-phase interrupt is a follow-up).
 */
export function beginBargeIn(session: VoiceSession, cfg: BargeInConfig): boolean {
  if (!cfg.enabled) return false;
  if (session.phase !== "speaking") return false;
  session.bargeInPrevPhase = session.phase;
  session.phase = "interrupt_pending";
  try {
    (session.player as PlayerPauseControls | null)?.pause?.(true);
  } catch {
    /* non-fatal */
  }
  traceBargeInOpening(session);
  clearBargeInTimer(session);
  session.bargeInTimer = setTimeout(() => {
    rollbackBargeIn(session, "timeout");
  }, cfg.falseInterruptTimeoutMs);
  return true;
}

/**
 * Stage B — an interim transcript arrived while a barge-in is pending.
 * Classify it: confirm → commit the interrupt; backchannel → roll back
 * immediately (resume playback fast, so a "mm-hm" barely dents the agent);
 * unknown → hold the pause and wait. No-op unless INTERRUPT_PENDING.
 */
export function evaluateBargeInInterim(
  session: VoiceSession,
  text: string,
  cfg: BargeInConfig,
): BargeInClassification {
  if (session.phase !== "interrupt_pending") return "unknown";
  const cls = classifyBargeInText(text, cfg.minConfirmWords);
  if (cls === "confirm") {
    commitBargeIn(session, cfg);
  } else if (cls === "backchannel") {
    rollbackBargeIn(session, "backchannel");
  }
  return cls;
}

/**
 * Commit a confirmed interrupt: cancel the rollback timer, hard-abort the
 * in-flight turn (generation bump + SDK abort + destroy TTS stream + stop
 * player, via abortVoiceTurn), set the post-interrupt backoff, and move to
 * LISTENING. The user's continuing utterance finalises through the normal STT
 * path and dispatches as the next turn.
 */
export function commitBargeIn(
  session: VoiceSession,
  cfg: BargeInConfig,
): VoiceTurn | null {
  clearBargeInTimer(session);
  session.bargeInPrevPhase = null;
  traceBargeInResolved(session, "confirm");
  const turn = abortVoiceTurn(session, "barge-in");
  session.phase = "listening";
  session.bargeInBackoffUntil = Date.now() + cfg.backoffMs;
  return turn;
}

/**
 * Roll back a tentative barge-in (false interrupt: cough, backchannel, or the
 * rollback timer firing with no confirm): resume playback and restore the
 * pre-interrupt phase. Nothing was aborted. No-op unless INTERRUPT_PENDING.
 * `reason` feeds the turn trace: "backchannel" = the listener said "mm-hm",
 * "timeout" = nothing confirming arrived inside the false-interrupt window.
 */
export function rollbackBargeIn(
  session: VoiceSession,
  reason: Exclude<VoiceBargeInResult, "confirm"> = "timeout",
): void {
  if (session.phase !== "interrupt_pending") return;
  traceBargeInResolved(session, reason);
  clearBargeInTimer(session);
  try {
    (session.player as PlayerPauseControls | null)?.unpause?.();
  } catch {
    /* non-fatal */
  }
  session.phase = session.bargeInPrevPhase ?? "speaking";
  session.bargeInPrevPhase = null;
}

/**
 * A minimal DOMException-shaped Error carrying `name: "AbortError"` so the
 * abort reason is recognisable both by the SDK abort path and by
 * {@link isVoiceAbortError}, without depending on the runtime's DOMException
 * global being present under every build/test target.
 */
class DOMExceptionLike extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortError";
  }
}
