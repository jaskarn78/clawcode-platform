/**
 * Quick task 260521-4sa (999.64) + debug `stale-turn-watchdog-miss`
 * (999.64 RECURRENCE) — shared stale-turn thresholds.
 *
 * Single-sourced here so two consumers stay in lockstep:
 *   - `heartbeat/checks/inbox.ts` — the original 4sa watchdog inside the
 *     heartbeat `inbox` check. Catches a wedged turn for a TOP-LEVEL agent
 *     and falls through to drain a queued inbound message the same tick.
 *   - `heartbeat/runner.ts` `sweepStaleTurns()` — the fleet-wide stale-turn
 *     sweep added by debug session `stale-turn-watchdog-miss`. Runs for
 *     EVERY running session (top-level AND subagent threads) BEFORE the
 *     per-agent `heartbeat.enabled === false` gate.
 *
 * **Why the sweep was needed (the 4sa gap):** Phase 999.57 registers every
 * subagent session's config with `heartbeat.enabled: false`
 * (`subagent-config-overrides.ts`) and upserts it into the runner so the
 * per-agent gate at `runner.ts` skips the WHOLE agent — including the
 * `inbox` check that hosts the 4sa watchdog. So the 4sa watchdog could
 * never fire for a subagent thread. Both production recurrences
 * (2026-05-21, fin-client subagents) were subagent threads. The
 * runner-level sweep restores coverage for that session class without
 * reintroducing the parent-memory leak the 999.57 gate was added to fix
 * (the sweep does NOT execute check modules or read `memoryPath`).
 */

/**
 * Turn-stale WARNING threshold (ms). BACKLOG criterion 2: "~60s with no
 * partial-message activity". A turn in flight with no consumed SDK message
 * for this long surfaces a `turn-stale` warning (inbox-check path only —
 * the runner sweep acts only at the force-release threshold).
 */
export const TURN_STALE_WARNING_THRESHOLD_MS = 60_000;

/**
 * Turn-stale FORCE-RELEASE threshold (ms) — the BASELINE. BACKLOG criterion 3:
 * "> ~5 min with no progress". A turn-in-flight lock with no SDK activity for
 * this long is force-released. Deliberately well above the Phase 127
 * stream-stall abort default (180s) so a turn the abort path can still
 * settle does so on its own — the watchdog only catches turns that path
 * missed.
 *
 * 🚨 Phase 999.114 — do NOT compare against this constant directly. Use
 * `resolveForceReleaseThresholdMs()` below. `streamStallTimeoutMs` is
 * per-agent configurable while this was a fixed 300s, so the "deliberately
 * well above" invariant in the paragraph above held ONLY for agents left on
 * the 180s default. Any agent tuned past 300s had the ordering INVERTED: the
 * blunt force-release fired FIRST and the clean stall abort became
 * unreachable. That is exactly what happened to the fin-research fix — raising
 * its threshold to 600s bought 180s→~300s and swapped a clean abort for a
 * force-release, which is why the incident write-up records the fix as only
 * partially effective.
 */
export const TURN_FORCE_RELEASE_THRESHOLD_MS = 5 * 60_000;

/**
 * Phase 999.114 — margin the force-release sits ABOVE an agent's own
 * stream-stall abort. The abort path is bounded (`INTERRUPT_DEADLINE_MS`, 2s),
 * so 60s is ample room for it to fire, settle, and release the turn on its own
 * before this blunt sweep considers the turn abandoned.
 */
export const FORCE_RELEASE_MARGIN_MS = 60_000;

/**
 * Phase 999.114 — the force-release threshold for ONE agent, given the
 * stream-stall timeout that agent actually resolved to.
 *
 * Restores the invariant this module always claimed: force-release strictly
 * AFTER the stream-stall abort, so the clean path wins and the sweep only ever
 * catches turns that path genuinely missed. Never returns less than the
 * baseline, so an agent tuned BELOW 180s does not get a hair-trigger sweep.
 *
 * Pure. `streamStallTimeoutMs` undefined (unknown config, duck-typed session
 * manager, a session with no resolved config) → the baseline, i.e. exactly the
 * pre-999.114 behavior.
 */
export function resolveForceReleaseThresholdMs(
  streamStallTimeoutMs?: number,
): number {
  if (
    streamStallTimeoutMs === undefined ||
    !Number.isFinite(streamStallTimeoutMs) ||
    streamStallTimeoutMs <= 0
  ) {
    return TURN_FORCE_RELEASE_THRESHOLD_MS;
  }
  return Math.max(
    TURN_FORCE_RELEASE_THRESHOLD_MS,
    streamStallTimeoutMs + FORCE_RELEASE_MARGIN_MS,
  );
}

/**
 * Debug session `in-tool-wedge-recovery` work-stream (C), FORK 8 —
 * per-agent timeout (ms) for the sweep's clean-detach attempt.
 *
 * The FORK 8 recovery calls `SessionManager.backgroundOrReleaseStaleTurn`,
 * which `await`s the SDK's async `Query.backgroundTasks`. That async call
 * runs against a potentially-sick SDK process; the heartbeat tick must
 * never block on it. The sweep races the detach against this timeout — if
 * it does not settle in time, the sweep treats the agent as `"released"`
 * (degrading to the blunt force-release semantics) and moves on so the
 * remaining agents in the tick are still swept.
 *
 * 2s: a control-plane `backgroundTasks` call is a JS state flip + a
 * synthetic tool_result — it completes in milliseconds when the SDK is
 * healthy. 2s is generous headroom; anything slower means the SDK control
 * channel itself is wedged, and the blunt force-release is then the
 * correct fallback anyway.
 */
export const SWEEP_DETACH_TIMEOUT_MS = 2_000;
