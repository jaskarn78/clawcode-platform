/**
 * Phase 103 OBS-06 — daemon list-rate-limit-snapshots IPC handler (pure-DI).
 *
 * Extracted as a pure-DI module (mirroring Phase 96 daemon-fs-ipc + Phase 92
 * cutover-ipc-handlers) so tests can exercise the handler without spawning
 * the full daemon. Production wiring at the daemon edge passes a thin
 * adapter over `manager.getRateLimitTrackerForAgent`; tests stub the
 * accessor directly with seeded snapshots.
 *
 * Pitfall 5 closure — this IPC method is `list-rate-limit-snapshots`, NOT
 * `rate-limit-status` (the latter is the SEPARATE Discord outbound rate-
 * limiter token-bucket IPC at daemon.ts:4077). Both must coexist.
 *
 * Pitfall 7 closure — when the SessionManager has no tracker for the agent
 * (agent not running, or has no UsageTracker DB to share), the handler
 * returns `{agent, snapshots: []}` rather than throwing. The /clawcode-usage
 * embed renders the "No usage data yet" graceful path on empty snapshots.
 *
 * Discord/CLI parity invariant: the same IPC method backs the
 * /clawcode-usage Discord slash command + the /clawcode-status optional
 * 5h+7d bar suffix. Drift between surfaces is impossible — both call
 * through this single handler.
 */
import type { RateLimitSnapshot } from "../usage/rate-limit-tracker.js";
import { effectiveSnapshots } from "../usage/plan-usage-probe.js";

/** Minimal tracker shape consumed by the handler. */
export type RateLimitTrackerLike = Readonly<{
  getAllSnapshots(): readonly RateLimitSnapshot[];
}>;

/** Dependency surface — pure-DI for testability. */
export type ListRateLimitSnapshotsDeps = Readonly<{
  /**
   * Returns the per-agent RateLimitTracker, or `undefined` when the agent
   * is not running OR has no tracker injected yet (Pitfall 7 graceful
   * degradation).
   */
  getRateLimitTrackerForAgent(name: string): RateLimitTrackerLike | undefined;
}>;

/** Wire shape returned by `list-rate-limit-snapshots` IPC. */
export type ListRateLimitSnapshotsResult = Readonly<{
  agent: string;
  snapshots: readonly RateLimitSnapshot[];
  /** "anthropic" when Anthropic's live `/usage` numbers were available. */
  source: "anthropic" | "tracked";
}>;

/** Param shape accepted by the handler. */
export type ListRateLimitSnapshotsParams = Readonly<{
  agent: string;
}>;

/**
 * Handle a `list-rate-limit-snapshots` IPC request.
 *
 * Synchronous — `getAllSnapshots()` is an in-memory map read + frozen-array
 * clone (see RateLimitTracker.getAllSnapshots in src/usage/rate-limit-tracker.ts).
 * No I/O, no awaits.
 *
 * @param params {agent: string} — required agent name (validated upstream
 *               by validateStringParam at the daemon edge)
 * @param deps   pure-DI surface — production wires
 *               sessionManager.getRateLimitTrackerForAgent
 */
export function handleListRateLimitSnapshotsIpc(
  params: ListRateLimitSnapshotsParams,
  deps: ListRateLimitSnapshotsDeps,
  live: readonly RateLimitSnapshot[] | null = null,
  now: number = Date.now(),
): ListRateLimitSnapshotsResult {
  const tracker = deps.getRateLimitTrackerForAgent(params.agent);
  const tracked = tracker ? tracker.getAllSnapshots() : [];
  // 2026-09-26: Anthropic's live `/usage` windows win; tracked rows are kept
  // only if fresh and from the live account (see effectiveSnapshots).
  return {
    agent: params.agent,
    snapshots: effectiveSnapshots(tracked, live, now),
    source: live && live.length > 0 ? "anthropic" : "tracked",
  };
}
