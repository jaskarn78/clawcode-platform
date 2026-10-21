/**
 * Phase 58 Plan 03 — startup-only orphan reconciliation.
 *
 * Scans tasks with status IN IN_FLIGHT_STATUSES ('running' | 'awaiting_input')
 * whose heartbeat_at is older than the configured threshold, and marks each
 * 'orphaned' via TaskStore.markOrphaned. Runs ONCE at daemon startup — see
 * .planning/phases/58-task-store-state-machine/58-CONTEXT.md: "reconciler
 * runs at daemon startup, not periodically".
 *
 * LIFE-04: prevents tasks from being stuck in-flight forever across a
 * daemon crash / forced restart. The scan path uses
 * `TaskStore.listStaleRunning` (indexed by idx_tasks_status_heartbeat) and
 * the flip path uses `TaskStore.markOrphaned`, which BYPASSES the
 * state-machine's `assertLegalTransition` on purpose: the reconciler may
 * race with a natural terminal transition but still must record the stale
 * evidence. `orphaned` is terminal in the state machine, so once set no
 * further transitions are permitted.
 *
 * Reconciler is PURE relative to TaskStore + Logger — no filesystem, no IPC,
 * no SessionManager dependency. Can be exercised in unit tests without the
 * full daemon.
 */

import type { Logger } from "pino";
import type { TaskStore } from "./store.js";

/**
 * Default orphan threshold — 5 minutes = 5 missed 60s heartbeats.
 *
 * Justification (locked in 58-03-PLAN.md <locked_shapes>):
 *   - Default daemon heartbeat cadence from src/heartbeat/runner.ts is 60s.
 *   - A running agent's TaskManager (Phase 59) will refresh heartbeat_at at
 *     least every 60s while a turn is active.
 *   - 5 minutes = 5 missed heartbeats — robust threshold for "definitely
 *     crashed vs slow turn". Smaller thresholds (e.g. 2min) risk flapping
 *     during long tool_use sequences. Larger thresholds (e.g. 30min) defeat
 *     LIFE-04's goal of prompt reconciliation.
 */
export const ORPHAN_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Result of a reconciliation pass. `reconciledTaskIds` is frozen so callers
 * (e.g. the daemon's structured warn log) can't mutate the snapshot post-hoc.
 */
export type ReconciliationResult = {
  readonly reconciledCount: number;
  readonly reconciledTaskIds: readonly string[];
};

/**
 * Run a single reconciliation pass. Scans the task store for in-flight rows
 * whose heartbeat is older than `thresholdMs`, flips each to `orphaned`, and
 * returns a frozen summary.
 *
 * Emits structured pino logs (when `log` is supplied):
 *   - one `info` per reconciled row with `{ taskId, callerAgent, targetAgent,
 *     priorStatus, heartbeatAgeMs }`
 *   - one `info` summary with `{ reconciledCount }`
 *
 * Callers without a logger (e.g. unit tests) may omit the third argument.
 */
export function runStartupReconciliation(
  store: TaskStore,
  thresholdMs: number,
  log?: Logger,
): ReconciliationResult {
  const stale = store.listStaleRunning(thresholdMs);
  const reconciled: string[] = [];
  const now = Date.now();

  for (const row of stale) {
    store.markOrphaned(row.task_id);
    reconciled.push(row.task_id);
    log?.info(
      {
        taskId: row.task_id,
        callerAgent: row.caller_agent,
        targetAgent: row.target_agent,
        priorStatus: row.status,
        heartbeatAgeMs: now - row.heartbeat_at,
      },
      "task reconciled to orphaned",
    );
  }

  log?.info(
    { reconciledCount: reconciled.length },
    "startup reconciliation complete",
  );

  return Object.freeze({
    reconciledCount: reconciled.length,
    reconciledTaskIds: Object.freeze([...reconciled]),
  });
}
