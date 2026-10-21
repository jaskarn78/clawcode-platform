/**
 * Phase 127 — No-useful-tokens stream-stall supervisor.
 *
 * Closes the 2026-05-14 fin-client 16-min stall pattern where the
 * SDK iteration loop received keepalive bytes / empty deltas but never
 * produced a usable token, yet the dead-stream timeout never fired
 * because the underlying connection had "traffic." The tracker watches
 * the stream of useful tokens (text_delta.text OR
 * input_json_delta.partial_json — anti-pattern definition D-02 in
 * 127-CONTEXT.md) and aborts the in-flight turn when the gap exceeds
 * the configured threshold.
 *
 * Single-chokepoint design (per feedback_silent_path_bifurcation.md):
 * BOTH the production `persistent-session-handle.ts` iteration loop AND
 * the test-only `wrapSdkQuery` path in `session-adapter.ts` construct
 * exactly one tracker per turn and call `markUsefulToken()` from the
 * SAME predicate that already detects text/json deltas. Tests directly
 * exercise this module to assert the trip behavior without needing a
 * full SDK iterator harness.
 *
 * Invariants enforced by tests in
 * `src/manager/__tests__/session-adapter-stream-stall.test.ts`:
 *   - The interval ticks at Math.min(threshold/4, 30_000)ms — frequent
 *     enough to catch a fresh stall within a quarter-threshold window
 *     and bounded so very-long thresholds don't starve the event loop.
 *   - `markUsefulToken()` resets `lastUsefulTokenAt` to the current
 *     `getNow()` so subsequent ticks restart the countdown.
 *   - First trip wins: once the interval callback decides Date.now() -
 *     lastUsefulTokenAt > threshold, it clears the interval, invokes
 *     `onStall(payload)` exactly once, and the tracker becomes inert.
 *     `stop()` is idempotent and safe to call after a trip.
 *   - `stop()` clears the interval if it hasn't already fired — critical
 *     for T-127-04 mitigation (no leaked timers on success/abort paths).
 *
 * The tracker is intentionally injection-friendly: `getNow` defaults to
 * `Date.now` but tests pass a deterministic clock when using
 * `vi.useFakeTimers()`. `intervalSetter` / `intervalClearer` are not
 * configurable — we always use the real timer functions so
 * `vi.useFakeTimers()` controls them at the global level (this matches
 * the existing memory-flush / heartbeat test posture in the codebase).
 *
 * Tool-aware extension (quick task 260521-3or):
 *   - `pause()` / `resume()` let the caller exclude tool-execution time
 *     from the stall countdown. While a tool is running, the model is
 *     legitimately waiting on a tool_result and emits no deltas — that
 *     gap must NOT be counted toward a stall. The iteration loop calls
 *     `pause()` when a top-level tool_use block opens and `resume()`
 *     when the matching tool_result arrives.
 *   - Nesting via an internal `pauseDepth`: only the 0→1 transition
 *     freezes the tick loop and only the 1→0 transition resets
 *     `lastUsefulTokenAt` and re-arms the countdown. Parallel tool
 *     batches balance correctly because each top-level tool contributes
 *     one pause and one resume.
 *   - The dead-stream protection is preserved: when `pauseDepth === 0`
 *     (no tool running) a genuinely silent stream — no text/json/
 *     thinking deltas — still trips at the threshold. The tool-aware
 *     change only suppresses the trip WHILE a tool is executing.
 *   - Both `pause()` and `resume()` are inert after `stop()` or after a
 *     trip, consistent with `markUsefulToken()`. `resume()` with
 *     `pauseDepth === 0` is a defensive no-op so the depth can never go
 *     negative on a duplicate/missing SDK message.
 *
 * Max-pause ceiling (debug session `phase127-stall-abort-miss`, Option 1):
 *   - The tool-aware `pause()` above suppresses the stall trip for the
 *     ENTIRE tool-execution window with no upper bound. Root cause of the
 *     2026-05-21 fin-client wedges: if the SDK generator HANGS while
 *     a tool is in flight — after a `tool_use` block opened `pause()` but
 *     before the matching `tool_result` arrives to `resume()` — the
 *     iteration loop's `driverIter.next()` never resolves, so `resume()`
 *     never runs and `pauseDepth` stays > 0 forever. The interval callback
 *     then returns early on every tick and the stall is NEVER detected.
 *   - The ceiling fixes this without touching the normal-case behaviour:
 *     the 0→1 `pause()` records `pauseStartedAt`; the interval callback,
 *     BEFORE the `pauseDepth > 0` early-return, checks whether the current
 *     pause has lasted longer than `maxPauseDurationMs`. If so it trips the
 *     stall anyway — via the SAME `onStall` path, so the existing clean
 *     abort (`fireInterruptOnce` → 2s deadline race → `AbortError`) still
 *     applies. A legitimate tool that returns inside the ceiling un-pauses
 *     normally via `resume()` and is never tripped.
 *   - The ceiling MUST exceed the p95 legitimate single-tool duration
 *     (heavy fin-client browser/Bash/mysql tools, 5-12 min per quick
 *     task 260521-3or) or it would re-introduce the false-positive that
 *     3or fixed. See {@link DEFAULT_MAX_PAUSE_DURATION_MS}. The 999.64
 *     heartbeat stale-turn sweep (commit aae78650, ~5 min force-release)
 *     remains the FASTER backstop for an in-tool hang — the ceiling is a
 *     clean-abort backstop layered above it, not a replacement.
 *
 * Evidence-anchored pause window (INC-2026-07-26 client-a-personal workflow RCA):
 *   - The original ceiling measured the OUTERMOST continuous pause window:
 *     `pauseStartedAt` was set on the 0→1 pause() and cleared only on the
 *     1→0 resume(). An overlapping tool batch whose members complete one by
 *     one — or a single long tool that streams child-lane activity — never
 *     returns the depth to 0, so the window kept growing from the FIRST
 *     pause and the ceiling killed demonstrably-healthy workers (both
 *     2026-07-26 stall aborts: one batch had 4/5 tools done with the final
 *     two results arriving at the abort instant; the other's single tool
 *     was alive with child result blocks until seconds before the trip).
 *   - The window is now anchored to the LAST EVIDENCE OF TOOL PROGRESS
 *     while paused, not the first pause. Three events re-arm
 *     `pauseStartedAt` to now: (a) every resume() that leaves depth > 0 (a
 *     sibling tool completed), (b) `markUsefulToken()` while paused (child-
 *     lane deltas — native Workflow/Task lanes stream with
 *     `parent_tool_use_id` set), and (c) the new `markToolProgress()` hook
 *     (non-delta evidence: tool_result blocks the caller observes for tools
 *     it did not pause, e.g. child-lane results). The ceiling now means
 *     "`maxPauseDurationMs` with NO evidence of tool progress" — the
 *     genuine-hang signature — instead of "any tool batch longer than the
 *     ceiling".
 *   - A genuinely hung generator still trips: a hang means driverIter.next()
 *     never resolves, so NO events of any kind arrive and nothing re-arms.
 *   - Noisy-wedge backstop ({@link ABSOLUTE_MAX_PAUSE_FACTOR}): a wedged
 *     parent tool that drip-feeds child-lane noise could otherwise re-arm
 *     forever and hold its slot until `maxTurnDurationMs` (4h for workflow
 *     workers). A second, ABSOLUTE ceiling on the continuous pause window —
 *     measured from the 0→1 pause() and NEVER re-armed by evidence — trips
 *     at 3× the evidence ceiling (45 min at the 15-min default). That gives
 *     healthy long batches 3× the old headroom while bounding a noisy wedge
 *     to minutes, not hours.
 */

/**
 * Default max-pause ceiling (ms) — debug session `phase127-stall-abort-miss`
 * Option 1. While a tool is in flight the tool-aware `pause()` suppresses
 * the stall trip; this ceiling caps how long that suppression may last
 * before the tracker trips anyway (treating an impossibly-long "tool" as a
 * hung generator).
 *
 * 15 min (900_000ms) is deliberately ABOVE the p95 legitimate single-tool
 * duration — heavy fin-client browser/Bash/mysql tools run 5-12 min
 * (quick task 260521-3or). A ceiling below that range would re-introduce
 * the exact false-positive 3or fixed. A ceiling well above it bounds the
 * worst-case clean-abort latency for an in-tool generator hang.
 *
 * NOTE on layering: the 999.64 heartbeat stale-turn sweep (commit
 * aae78650) force-releases a wedged turn's queue lock at ~5 min — so for
 * an in-tool hang the sweep fires FIRST (force-release) and this ceiling
 * fires later (~15 min, clean abort). The ceiling is a clean backstop
 * above the sweep, not a faster path; a sub-5-min clean abort for in-tool
 * hangs is incompatible with the p95-tool-duration constraint.
 */
export const DEFAULT_MAX_PAUSE_DURATION_MS = 15 * 60_000;

/**
 * Fast-tool max-pause ceiling (ms) — INC-2026-06-05 fin-client residual
 * phantom-typing wedge. The 15-min {@link DEFAULT_MAX_PAUSE_DURATION_MS} above
 * is deliberately sized for the SLOWEST legitimate tool (heavy Bash / browser,
 * p95 5-12 min). But when the ONLY tool(s) outstanding are known-fast ones
 * (MCP database/content/quote calls, local Read/Grep/Glob, ToolSearch — all of
 * which return in seconds), a pause that outlasts THIS shorter ceiling is an
 * SDK-generator hang, not a legitimately-slow tool. Without the split, a hung
 * mysql_query left the turn paused for the full 15 min — the tracker's
 * `no-useful-tokens` trip is suppressed while paused, so the 15-min ceiling was
 * the only backstop, and the bridge showed phantom "typing…" until its separate
 * 600s cap. 2 min is far above any legitimate fast-tool round-trip (seconds)
 * yet well below both the 600s typing cap and the 15-min slow ceiling, so a
 * fast-tool wedge now settles the turn in ~2 min instead of 15. The ceiling
 * applies ONLY while every outstanding pause is fast — a mixed batch (any slow
 * tool in flight) keeps the full 15-min ceiling. See {@link isFastTool} in
 * persistent-session-handle.ts for the conservative allowlist (unknown tools
 * default to slow, so no existing tool's behaviour regresses).
 */
export const DEFAULT_FAST_MAX_PAUSE_DURATION_MS = 2 * 60_000;

/**
 * INC-2026-07-26 — multiplier for the ABSOLUTE continuous-pause ceiling.
 * The evidence-anchored window above re-arms on every sign of tool progress,
 * which is correct for healthy batches but means a wedged generator that
 * drip-feeds child-lane noise could suppress the trip until the (much larger)
 * `maxTurnDurationMs` wall clock. The absolute ceiling — `maxPauseDurationMs ×
 * this factor`, measured from the OUTERMOST pause start with NO re-arms —
 * bounds that evasion: 45 min at the 15-min default, comfortably above every
 * observed legitimate single-pause window (the longest healthy incident batch
 * paused ~15 min total) and far below a workflow worker's 4h turn budget.
 */
export const ABSOLUTE_MAX_PAUSE_FACTOR = 3;

/**
 * Absolute per-turn wall-clock ceiling (ms). Unlike the two activity-based
 * trips below, this fires regardless of token activity or pause state — the
 * backstop for a turn that hangs while slow-dripping output (which resets
 * `lastUsefulTokenAt` forever) or stays un-paused, defeating both the
 * `no-useful-tokens` threshold AND the heartbeat sweep. Sits ABOVE the 15-min
 * single-tool pause ceiling so a legit multi-tool turn is never cut. Without
 * this there is no guarantee a turn ever settles → the queue slot leaks
 * (QUEUE_FULL). 20 min.
 */
export const DEFAULT_MAX_TURN_DURATION_MS = 20 * 60_000;

/**
 * Why the tracker tripped — carried on {@link StreamStallPayload} so the
 * caller's forensic log distinguishes the two trip modes:
 *   - `"no-useful-tokens"` — the original Phase 127 trip: no useful token
 *     (text/json/thinking delta) for longer than `thresholdMs` while NOT
 *     paused.
 *   - `"max-pause-exceeded"` — the Option 1 ceiling trip: a tool-execution
 *     `pause()` stayed active longer than `maxPauseDurationMs`, indicating
 *     the SDK generator hung mid-tool and `resume()` will never arrive.
 *   - `"max-turn-duration"` — the absolute wall-clock backstop: the turn has
 *     run longer than `maxTurnDurationMs` regardless of activity or pause
 *     state. Catches the slow-drip / never-paused hang that resets the
 *     activity timers forever and defeats both the threshold and the sweep.
 */
export type StreamStallReason =
  | "no-useful-tokens"
  | "max-pause-exceeded"
  | "max-turn-duration";

/**
 * Structured payload handed to the `onStall` callback. Mirrors the
 * `phase127-stream-stall` log key shape locked in 127-CONTEXT.md D-06
 * so the caller can both `console.info(payload)` AND forward it
 * elsewhere (Discord notification, session-log row) without
 * re-serialising. Optional fields are omitted (spread-conditional) by
 * the caller — the tracker itself doesn't know agent/turn metadata.
 */
export type StreamStallPayload = {
  /**
   * Wall-clock ms elapsed since the last useful token. For a
   * `"no-useful-tokens"` trip this is `> thresholdMs` by definition. For a
   * `"max-pause-exceeded"` trip it reflects the age since the last token
   * before the pause began (the tracker does not re-arm while paused), so
   * it is informational only — `pauseDurationMs` is the operative figure.
   */
  readonly lastUsefulTokenAgeMs: number;
  /** The threshold that triggered this stall (carried so the log line is self-describing). */
  readonly thresholdMs: number;
  /**
   * Which trip mode fired — see {@link StreamStallReason}. Added by debug
   * session `phase127-stall-abort-miss` Option 1.
   */
  readonly reason: StreamStallReason;
  /**
   * For a `"max-pause-exceeded"` trip: how long the current pause window had
   * been active with NO evidence of tool progress when the ceiling fired
   * (ms). Since INC-2026-07-26 the window re-arms on every progress event
   * (sibling tool completion, child-lane delta, `markToolProgress()`), so
   * this measures the silent tail, not the whole batch. Omitted for a
   * `"no-useful-tokens"` trip.
   */
  readonly pauseDurationMs?: number;
  /**
   * For a `"max-pause-exceeded"` trip fired by the ABSOLUTE continuous-pause
   * ceiling (INC-2026-07-26 noisy-wedge backstop): total ms since the
   * outermost pause opened, ignoring evidence re-arms. Present only on
   * absolute-ceiling trips — its presence distinguishes "wedged despite
   * periodic noise" from "genuinely silent" in the forensic log.
   */
  readonly continuousPauseDurationMs?: number;
  /**
   * For a `"max-turn-duration"` trip: total wall-clock ms the turn had been
   * running when the absolute ceiling fired. Omitted for other trips.
   */
  readonly turnDurationMs?: number;
};

/**
 * Construction options for the tracker. `thresholdMs` is the only
 * required field — everything else is optional and exists for the
 * test path (deterministic clock, custom interval) or future
 * production extension.
 */
export type StreamStallTrackerOptions = {
  /**
   * Stall threshold in milliseconds. Must be > 0. When `Date.now() -
   * lastUsefulTokenAt > thresholdMs`, the tracker trips.
   */
  readonly thresholdMs: number;
  /**
   * Called exactly once when the tracker trips. The caller is expected
   * to invoke `AbortController.abort()` on the SDK query (or do
   * whatever termination semantics they own) AFTER the callback
   * returns. The tracker does NOT own the abort controller — keeps
   * this module agnostic of SDK plumbing.
   */
  readonly onStall: (payload: StreamStallPayload) => void;
  /**
   * Clock override for tests. Defaults to `Date.now`. Production code
   * must NOT pass this — `vi.useFakeTimers()` is the test-side knob.
   */
  readonly getNow?: () => number;
  /**
   * Optional override for the interval cadence. Defaults to
   * `Math.min(thresholdMs / 4, 30_000)` — production paths should
   * omit this. Test paths pass a smaller value to drive the tick loop
   * faster without scaling threshold up.
   */
  readonly checkIntervalMs?: number;
  /**
   * Max-pause ceiling (ms) — debug session `phase127-stall-abort-miss`
   * Option 1. While `pauseDepth > 0`, if the current pause has been active
   * longer than this, the tracker trips anyway (reason
   * `"max-pause-exceeded"`) instead of suppressing the stall forever.
   * Defaults to {@link DEFAULT_MAX_PAUSE_DURATION_MS} (15 min). Must be
   * > 0; production paths should omit it and take the default. Test paths
   * pass a small value to exercise the ceiling without real-time waits.
   */
  readonly maxPauseDurationMs?: number;
  /**
   * Fast-tool max-pause ceiling (ms) — INC-2026-06-05. Applies the SHORTER
   * pause ceiling while every outstanding pause is a known-fast tool (see
   * `pause({ fast: true })`). If any slow tool is in flight, the full
   * {@link StreamStallTrackerOptions.maxPauseDurationMs} ceiling applies
   * instead. Defaults to {@link DEFAULT_FAST_MAX_PAUSE_DURATION_MS} (2 min).
   * Must be > 0; production paths should omit it. Test paths pass a small
   * value to exercise the split ceiling without real-time waits.
   */
  readonly fastMaxPauseDurationMs?: number;
  /**
   * Absolute per-turn wall-clock ceiling (ms) — fires regardless of activity
   * or pause state once the turn has run this long. The backstop that
   * guarantees every turn settles (so the queue slot always releases).
   * Defaults to {@link DEFAULT_MAX_TURN_DURATION_MS} (20 min). Must be > 0;
   * production paths should omit it. Test paths pass a small value.
   */
  readonly maxTurnDurationMs?: number;
  /**
   * Whether the token-activity-based trips are armed (v3 inert-stream fix,
   * 2026-06-14). Defaults to `true` — every SDK-path caller keeps the original
   * behaviour. When `false`, the interval callback suppresses BOTH the
   * `"no-useful-tokens"` threshold trip AND the `"max-pause-exceeded"` ceiling
   * trip, while keeping the absolute `"max-turn-duration"` wall-clock backstop
   * fully armed.
   *
   * This exists for v3 (claude-code-interactive / PTY) sessions: their
   * in-process SDK token stream is INERT by design (real tokens flow through
   * the PTY), so `markUsefulToken()` is never called and the
   * `no-useful-tokens` threshold false-aborts every long v3 turn (60 observed
   * `phase127-stream-stall` aborts, all `sessionId "v3-research"`, ~210s >
   * 180s). Disabling only the activity trips — rather than skipping the whole
   * tracker — preserves the 20-min `max-turn-duration` ceiling so a genuinely
   * hung v3 turn still settles and releases its queue slot (the PtySupervisor
   * owns process lifecycle, NOT a per-turn wall-clock settle).
   *
   * Known limitation: with the activity trips off, a wedged-but-silent v3 turn
   * is only caught at `maxTurnDurationMs` (20 min) vs `thresholdMs` (180s) on
   * the SDK path — coarser, but the correct tradeoff against false-aborting
   * every long v3 turn. Parity would require feeding PTY liveness into
   * `markUsefulToken()`; deferred.
   */
  readonly tokenActivityTripsEnabled?: boolean;
};

/**
 * The handle returned by `createStreamStallTracker`. The caller
 * `markUsefulToken()` on every text_delta / partial_json event and
 * `stop()` on iteration exit (both success and catch paths — T-127-04).
 */
export type StreamStallTracker = {
  /**
   * Reset the "last useful token" timestamp to the current `getNow()`.
   * No-op after `stop()` or after the tracker has tripped.
   */
  markUsefulToken: () => void;
  /**
   * Clear the interval and make the tracker inert. Idempotent — safe to
   * call after a trip or after a previous stop. MUST be called in the
   * iteration loop's success path AND in its catch-block cleanup
   * (T-127-04 mitigation: no leaked timers).
   */
  stop: () => void;
  /**
   * Read-only view of the current age (Date.now() - lastUsefulTokenAt)
   * in ms. Useful for tests and diagnostics; not used by production
   * call sites.
   */
  getLastUsefulTokenAgeMs: () => number;
  /**
   * Increment the internal `pauseDepth`. Only the 0→1 transition
   * actually freezes the tick loop — the interval callback returns
   * early while `pauseDepth > 0`, so no time spent paused is counted
   * toward a stall. Nestable: a second `pause()` simply deepens the
   * count (used by parallel tool batches). No-op after `stop()` or
   * after a trip. Safe to call repeatedly.
   *
   * `opts.fast` (INC-2026-06-05) marks the pause as a known-fast tool
   * (MCP db/content/quote, local Read/Grep/Glob, ToolSearch). The shorter
   * {@link StreamStallTrackerOptions.fastMaxPauseDurationMs} ceiling applies
   * only while EVERY outstanding pause is fast; a single slow (default) pause
   * reverts the whole window to the full `maxPauseDurationMs` ceiling.
   */
  pause: (opts?: { readonly fast?: boolean }) => void;
  /**
   * Decrement the internal `pauseDepth`. Only the 1→0 transition resets
   * `lastUsefulTokenAt` to the current `getNow()` and re-arms the
   * countdown fresh — so the stall window restarts from the moment the
   * last outstanding tool finished. A resume that leaves `pauseDepth > 0`
   * (a sibling in a parallel batch completed) re-arms the max-pause window
   * to now — a tool completing IS evidence the generator is alive
   * (INC-2026-07-26 evidence-anchored window). `resume()` while
   * `pauseDepth === 0` is a defensive no-op (the depth never goes negative
   * on a duplicate/missing SDK message). No-op after `stop()` or after a
   * trip. Safe to call repeatedly.
   *
   * `opts.fast` MUST mirror the value passed to the matching `pause()` so the
   * fast/slow outstanding-pause accounting stays balanced (INC-2026-06-05).
   */
  resume: (opts?: { readonly fast?: boolean }) => void;
  /**
   * Non-delta evidence of tool progress while paused (INC-2026-07-26).
   * Re-arms the max-pause window to now when `pauseDepth > 0` — the caller
   * invokes this on events that prove the in-flight tool batch is alive but
   * that are neither useful-token deltas nor completions of a tool THIS turn
   * paused: child-lane tool_result blocks (a paused parent tool's sub-lanes
   * settling), or any tool_result id not present in the caller's paused-tool
   * map. No-op while unpaused, after `stop()`, or after a trip — safe to
   * call unconditionally.
   */
  markToolProgress: () => void;
};

/**
 * Pure, LANE-AGNOSTIC useful-token predicate — quick task 260714-mkq.
 *
 * Returns true iff `msg` is an SDK `stream_event`
 * (`SDKPartialAssistantMessage`) whose `event` is a `content_block_delta`
 * carrying a NON-EMPTY useful delta:
 *   - `text_delta.text`
 *   - `input_json_delta.partial_json`
 *   - `thinking_delta.thinking`
 *
 * Crucially it does NOT inspect `parent_tool_use_id`. A native in-session
 * Workflow/Task run streams its output on a CHILD lane — the SAME
 * `stream_event` shape but with `parent_tool_use_id` set to the parent
 * tool's id (SDK type: `SDKPartialAssistantMessage.parent_tool_use_id:
 * string | null`). Counting those child-lane deltas as useful tokens keeps
 * the parent turn's Phase 127 no-useful-tokens countdown alive, so an active
 * Workflow lane is NOT mistaken for a wedged parent (2026-07-14 prod
 * incident: three native Workflow runs killed by the stall watchdog because
 * the old call-site predicate gated on `parent_tool_use_id === null`).
 *
 * Genuine-wedge detection is preserved BY CONSTRUCTION: a stream emitting no
 * delta on ANY lane never satisfies this predicate, so `markUsefulToken()`
 * is never called and the tracker still trips at `thresholdMs`.
 *
 * This predicate governs ONLY the stall countdown. The user-facing editor
 * append (`streamedText`) stays TOP-LEVEL-only at the call site
 * (`parent_tool_use_id === null`), so child-lane output never leaks into the
 * user's stream.
 */
export function streamEventHasUsefulDelta(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  if ((msg as { type?: unknown }).type !== "stream_event") return false;
  const event = (
    msg as {
      event?: {
        type?: string;
        delta?: {
          type?: string;
          text?: string;
          partial_json?: string;
          thinking?: string;
        };
      };
    }
  ).event;
  if (!event || event.type !== "content_block_delta") return false;
  const delta = event.delta;
  if (!delta) return false;
  if (
    delta.type === "text_delta" &&
    typeof delta.text === "string" &&
    delta.text.length > 0
  ) {
    return true;
  }
  if (
    delta.type === "input_json_delta" &&
    typeof delta.partial_json === "string" &&
    delta.partial_json.length > 0
  ) {
    return true;
  }
  if (
    delta.type === "thinking_delta" &&
    typeof delta.thinking === "string" &&
    delta.thinking.length > 0
  ) {
    return true;
  }
  return false;
}

/**
 * Construct a new tracker. The interval starts immediately — the
 * caller does NOT need a separate `start()` call. The first
 * `markUsefulToken()` is implicit (we initialize
 * `lastUsefulTokenAt = getNow()` at construction).
 */
export function createStreamStallTracker(
  opts: StreamStallTrackerOptions,
): StreamStallTracker {
  if (!Number.isFinite(opts.thresholdMs) || opts.thresholdMs <= 0) {
    throw new Error(
      `createStreamStallTracker: thresholdMs must be > 0 (got ${opts.thresholdMs})`,
    );
  }
  // Max-pause ceiling (debug session `phase127-stall-abort-miss` Option 1).
  // Validate the same way as thresholdMs — an invalid ceiling would make
  // the in-tool-hang backstop silently dead.
  const maxPauseDurationMs =
    opts.maxPauseDurationMs ?? DEFAULT_MAX_PAUSE_DURATION_MS;
  if (!Number.isFinite(maxPauseDurationMs) || maxPauseDurationMs <= 0) {
    throw new Error(
      `createStreamStallTracker: maxPauseDurationMs must be > 0 (got ${maxPauseDurationMs})`,
    );
  }
  // Fast-tool pause ceiling (INC-2026-06-05) — the shorter ceiling applied
  // while every outstanding pause is a known-fast tool. Validate like the
  // others so a bad value can't silently disable the fast backstop.
  const fastMaxPauseDurationMs =
    opts.fastMaxPauseDurationMs ?? DEFAULT_FAST_MAX_PAUSE_DURATION_MS;
  if (!Number.isFinite(fastMaxPauseDurationMs) || fastMaxPauseDurationMs <= 0) {
    throw new Error(
      `createStreamStallTracker: fastMaxPauseDurationMs must be > 0 (got ${fastMaxPauseDurationMs})`,
    );
  }
  // Absolute per-turn wall-clock ceiling — the activity-independent backstop.
  const maxTurnDurationMs =
    opts.maxTurnDurationMs ?? DEFAULT_MAX_TURN_DURATION_MS;
  if (!Number.isFinite(maxTurnDurationMs) || maxTurnDurationMs <= 0) {
    throw new Error(
      `createStreamStallTracker: maxTurnDurationMs must be > 0 (got ${maxTurnDurationMs})`,
    );
  }
  // Token-activity trips armed by default (v3 inert-stream fix, 2026-06-14).
  // When false, the interval callback keeps ONLY the max-turn-duration
  // wall-clock backstop and suppresses the no-useful-tokens / max-pause
  // trips that false-fire on v3's inert SDK stream. See the option doc.
  const tokenActivityTripsEnabled = opts.tokenActivityTripsEnabled ?? true;

  const getNow = opts.getNow ?? Date.now;
  // Turn-start reference for the absolute ceiling. The tracker is constructed
  // once per turn, so construction time ≈ turn start.
  const createdAt = getNow();
  const checkIntervalMs =
    opts.checkIntervalMs ?? Math.min(Math.floor(opts.thresholdMs / 4), 30_000);
  // Sanity floor: if threshold < 4, integer floor yields 0 which would
  // make setInterval spin. Clamp to 1ms minimum so tests with
  // microscopic thresholds still behave.
  const safeInterval = Math.max(1, checkIntervalMs);

  let lastUsefulTokenAt = getNow();
  let stopped = false;
  let tripped = false;
  // Tool-aware nesting depth (quick task 260521-3or). While > 0 the
  // interval callback returns early, so tool-execution time is not
  // counted toward the stall. Only 0→1 freezes and 1→0 re-arms.
  let pauseDepth = 0;
  // INC-2026-06-05 — count of outstanding pauses that are NOT fast. The fast
  // (shorter) ceiling applies only when this is 0 (every in-flight tool is a
  // known-fast one). Any slow tool in flight reverts to the full
  // `maxPauseDurationMs` ceiling. Kept in lockstep with `pauseDepth` via the
  // `fast` flag mirrored on pause()/resume().
  let slowPauseDepth = 0;
  // Max-pause ceiling (debug session `phase127-stall-abort-miss` Option 1).
  // Set to getNow() on the 0→1 pause() transition; cleared to null on the
  // matching 1→0 resume(). When non-null the interval callback can detect
  // a pause that has outlasted `maxPauseDurationMs` — the signature of an
  // SDK generator hung mid-tool whose resume() will never arrive.
  // INC-2026-07-26: re-armed to now on every evidence of tool progress
  // (partial resume / paused useful token / markToolProgress), so it
  // measures the SILENT tail of the pause, not the whole batch.
  let pauseStartedAt: number | null = null;
  // INC-2026-07-26 — the OUTERMOST pause start (old semantics): set on 0→1,
  // cleared on 1→0, NEVER re-armed by evidence. Feeds the absolute
  // continuous-pause ceiling (× ABSOLUTE_MAX_PAUSE_FACTOR) that bounds a
  // noisy wedge which would otherwise re-arm the evidence window forever.
  let outerPauseStartedAt: number | null = null;

  // Shared trip path — used by BOTH the no-useful-tokens trip and the
  // max-pause-exceeded ceiling trip so they cannot drift (clear-before-
  // callback ordering, the `tripped` re-entry guard, and the
  // never-let-the-callback-break-cleanup contract are single-sourced).
  const trip = (payload: StreamStallPayload): void => {
    tripped = true;
    // Clear BEFORE the callback so a callback that throws can't leak
    // the interval. The boolean guard in the interval also prevents a
    // re-entry if the callback synchronously triggers another tick.
    clearInterval(intervalHandle);
    try {
      opts.onStall(payload);
    } catch {
      // The tracker MUST NEVER let a misbehaving callback prevent
      // cleanup. The caller will observe the trip via their own
      // AbortController + error handler.
    }
  };

  const intervalHandle = setInterval(() => {
    if (stopped || tripped) return;
    const now = getNow();
    // Absolute per-turn ceiling — checked FIRST and UNCONDITIONALLY (before the
    // pause early-return and independent of token activity). This is the
    // backstop for a turn that hangs while slow-dripping output or never
    // pausing, which resets the activity timers forever and defeats both the
    // `no-useful-tokens` threshold and the heartbeat sweep. Guarantees the turn
    // settles so the queue slot always releases.
    const turnDurationMs = now - createdAt;
    if (turnDurationMs > maxTurnDurationMs) {
      trip({
        lastUsefulTokenAgeMs: now - lastUsefulTokenAt,
        thresholdMs: opts.thresholdMs,
        reason: "max-turn-duration",
        turnDurationMs,
      });
      return;
    }
    // v3 inert-stream fix (2026-06-14): with token-activity trips disabled, the
    // absolute wall-clock backstop above is the ONLY trip. Skip the pause /
    // no-useful-tokens branches that would false-fire on v3's inert SDK stream.
    if (!tokenActivityTripsEnabled) return;
    // Max-pause ceiling check (Option 1) — runs BEFORE the `pauseDepth > 0`
    // early-return so a pause that has outlasted the ceiling still trips.
    // This is the fix for the 2026-05-21 in-tool-hang wedge: without it a
    // hung generator leaves pauseDepth > 0 forever and the stall is never
    // detected. A legitimate tool returning inside the ceiling un-pauses
    // via resume() (clearing pauseStartedAt) and is never tripped here.
    if (pauseDepth > 0 && pauseStartedAt !== null) {
      const pauseDurationMs = now - pauseStartedAt;
      // INC-2026-07-26 — ABSOLUTE continuous-pause ceiling first (the harder
      // bound). Measured from the outermost pause start, immune to evidence
      // re-arms, so a wedged generator drip-feeding child-lane noise cannot
      // suppress the trip until the (hours-scale) turn wall clock.
      const continuousPauseDurationMs =
        outerPauseStartedAt !== null ? now - outerPauseStartedAt : pauseDurationMs;
      if (
        continuousPauseDurationMs >
        maxPauseDurationMs * ABSOLUTE_MAX_PAUSE_FACTOR
      ) {
        trip({
          lastUsefulTokenAgeMs: now - lastUsefulTokenAt,
          thresholdMs: opts.thresholdMs,
          reason: "max-pause-exceeded",
          pauseDurationMs,
          continuousPauseDurationMs,
        });
        return;
      }
      // INC-2026-06-05 — split ceiling. While EVERY outstanding pause is fast
      // (slowPauseDepth === 0) the shorter fast ceiling applies, so a hung
      // seconds-scale tool (e.g. an MCP mysql_query) settles the turn in ~2 min
      // instead of waiting the full 15-min slow ceiling. A single slow tool in
      // flight keeps the 15-min ceiling so a legit heavy Bash/browser is never
      // cut. `pauseStartedAt` is re-armed on evidence of tool progress
      // (INC-2026-07-26), so both ceilings measure the silent tail.
      const effectiveCeiling =
        slowPauseDepth > 0 ? maxPauseDurationMs : fastMaxPauseDurationMs;
      if (pauseDurationMs > effectiveCeiling) {
        trip({
          lastUsefulTokenAgeMs: now - lastUsefulTokenAt,
          thresholdMs: opts.thresholdMs,
          reason: "max-pause-exceeded",
          pauseDurationMs,
        });
      }
      return;
    }
    // Paused but ceiling not yet reached (or pauseStartedAt unset by a
    // defensive edge) — suppress the no-useful-tokens trip as designed.
    if (pauseDepth > 0) return;
    const age = now - lastUsefulTokenAt;
    if (age > opts.thresholdMs) {
      trip({
        lastUsefulTokenAgeMs: age,
        thresholdMs: opts.thresholdMs,
        reason: "no-useful-tokens",
      });
    }
  }, safeInterval);

  // INC-2026-07-26 — single re-arm point for the evidence-anchored max-pause
  // window. Any proof the generator is alive while paused (sibling tool
  // completion, child-lane delta, non-delta tool progress) moves the window
  // anchor to now, so the ceiling measures the SILENT tail of a pause, not
  // the total batch duration. Guarded on pauseStartedAt so the defensive
  // "paused but anchor unset" edge stays inert.
  const rearmPauseWindow = (): void => {
    if (pauseDepth > 0 && pauseStartedAt !== null) {
      pauseStartedAt = getNow();
    }
  };

  return {
    markUsefulToken: () => {
      if (stopped || tripped) return;
      lastUsefulTokenAt = getNow();
      // Child-lane deltas arrive while a parent tool holds the pause (native
      // Workflow/Task lanes stream with parent_tool_use_id set). They prove
      // the paused batch is alive, so they also re-arm the max-pause window
      // (INC-2026-07-26). While unpaused this is a no-op.
      rearmPauseWindow();
    },
    markToolProgress: () => {
      if (stopped || tripped) return;
      rearmPauseWindow();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(intervalHandle);
    },
    getLastUsefulTokenAgeMs: () => getNow() - lastUsefulTokenAt,
    pause: (pauseOpts) => {
      if (stopped || tripped) return;
      pauseDepth += 1;
      // INC-2026-06-05 — track slow (non-fast) outstanding pauses so the
      // interval callback can pick the fast vs slow ceiling. `fast` defaults
      // to false (slow) so any un-annotated caller keeps today's 15-min
      // behaviour.
      if (!pauseOpts?.fast) {
        slowPauseDepth += 1;
      }
      // 0→1 transition: record when this pause window opened so the
      // interval callback's ceilings can measure it. A nested 1→2+ pause()
      // does NOT move either start. `pauseStartedAt` is the evidence-anchored
      // window (re-armed on tool progress); `outerPauseStartedAt` is the
      // absolute continuous window (never re-armed — the noisy-wedge bound).
      if (pauseDepth === 1) {
        const now = getNow();
        pauseStartedAt = now;
        outerPauseStartedAt = now;
      }
    },
    resume: (resumeOpts) => {
      if (stopped || tripped) return;
      // Defensive: never let the depth go negative on a duplicate or
      // missing SDK message — a stray resume() is a harmless no-op.
      if (pauseDepth === 0) return;
      const wasSlow = !resumeOpts?.fast;
      pauseDepth -= 1;
      if (wasSlow && slowPauseDepth > 0) {
        slowPauseDepth -= 1;
      }
      if (pauseDepth === 0) {
        // 1→0 transition: the last outstanding tool finished. Re-arm the
        // countdown fresh so the stall window measures only post-tool
        // silence, and clear the max-pause start so the ceiling is not
        // armed while unpaused (Option 1).
        lastUsefulTokenAt = getNow();
        pauseStartedAt = null;
        outerPauseStartedAt = null;
        // Defensive: keep slow depth consistent if SDK messages were
        // unbalanced (e.g. a missed fast resume left a phantom slow count).
        slowPauseDepth = 0;
      } else {
        // INC-2026-07-26 — a resume that leaves depth > 0 means a sibling in
        // a parallel batch just completed: direct evidence the generator is
        // alive. Re-arm the max-pause window so the ceiling measures the
        // silent tail since the LAST completion, not the whole batch — the
        // old outermost-window accounting killed healthy overlapping batches
        // (2026-07-26 client-a-personal workflow workers). This subsumes the
        // INC-2026-06-05 slow→fast re-arm (which moved the anchor only when
        // the last slow tool finished so the shorter fast ceiling measured
        // the fast-only span): re-arming on EVERY partial resume covers that
        // transition and every other completion. A genuinely hung batch
        // still trips — a hang delivers no resumes, so nothing re-arms.
        rearmPauseWindow();
      }
    },
  };
}
