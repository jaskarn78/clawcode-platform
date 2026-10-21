/**
 * Phase 135 Plan 01 — voice-capture generation-counter dedup state.
 *
 * Each call to `beginVoiceCapture(state, userId)` mints a new monotonically-
 * increasing generation token for that userId. Downstream handlers capture
 * the token at speech-start and later compare it against
 * `currentGeneration(state, userId)`; if they mismatch, the utterance was
 * superseded (another speaking-start fired, or `finishVoiceCapture` was
 * called) and the handler must drop its result.
 *
 * Per-userId counters are independent — one speaker's increment does NOT
 * invalidate another's in-flight capture token. This isolates dedup to a
 * single user's audio stream and matches the OpenClaw `capture-state.ts`
 * pattern referenced in 135-RESEARCH § Pattern 4.
 *
 * Pure data + pure functions: no I/O, no logging, no side effects beyond
 * mutating the passed state Map. Safe to run in unit tests, safe to
 * compose into VoiceSession lifecycle (sessions own their own state
 * instance; cross-session contamination is impossible).
 *
 * Plan 02 will wire this into `connection.receiver.speaking.on("start", ...)`
 * inside `VoiceManager.attachSpeakingListeners`. Plan 01 ships the data
 * layer ONLY — no consumers yet.
 */

/**
 * Mutable per-session dedup state. One instance per `VoiceSession`.
 *
 * The Map's value is the latest issued generation for a given userId.
 * Lookup misses (unseen userId) return 0 from `currentGeneration` — this
 * matches the convention that no token has ever been captured for that
 * user, so any post-hoc `currentGeneration === captured` comparison fails
 * cleanly without throwing.
 */
export type VoiceCaptureState = {
  readonly generations: Map<string, number>;
};

/**
 * Allocate a fresh, empty capture state. Call once per VoiceSession
 * construction.
 */
export function createVoiceCaptureState(): VoiceCaptureState {
  return { generations: new Map<string, number>() };
}

/**
 * Mint a new generation for `userId` and return it. The returned value is
 * the token the caller should capture at speech-start and compare against
 * `currentGeneration` when a downstream result (e.g., final transcript)
 * arrives.
 *
 * Generations are 1-indexed — 0 is reserved as the "never captured" sentinel
 * so a `=== 0` comparison cleanly distinguishes unseen users from any real
 * in-flight capture.
 */
export function beginVoiceCapture(state: VoiceCaptureState, userId: string): number {
  const next = (state.generations.get(userId) ?? 0) + 1;
  state.generations.set(userId, next);
  return next;
}

/**
 * Read the current (latest-minted) generation for `userId`. Returns 0 if
 * the userId has never been seen.
 *
 * Handlers use this for the dedup predicate:
 *   `currentGeneration(state, userId) === capturedAtBegin`
 * If false, drop the result silently — the capture was superseded.
 */
export function currentGeneration(state: VoiceCaptureState, userId: string): number {
  return state.generations.get(userId) ?? 0;
}

/**
 * Invalidate the current generation by minting a new one without exposing
 * the token to a caller. After this call, any handler that captured a
 * token from a previous `beginVoiceCapture` will see a mismatch on its
 * next `currentGeneration` check.
 *
 * Use case (Plan 02): a Deepgram `is_final` transcript arrives for an
 * utterance; the session calls `finishVoiceCapture` to invalidate any
 * still-streaming interim transcripts so they don't fire a duplicate
 * agent turn.
 */
export function finishVoiceCapture(state: VoiceCaptureState, userId: string): void {
  // Same monotonic increment as `beginVoiceCapture` — the side effect is
  // identical (advance the counter); only the return-value discipline
  // differs (finish does not surface the new token).
  beginVoiceCapture(state, userId);
}
