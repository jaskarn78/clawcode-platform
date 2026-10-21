/**
 * Phase 58 — task lifecycle data types.
 *
 * LOCKED shapes — see .planning/phases/58-task-store-state-machine/58-CONTEXT.md.
 * Downstream plans (58-02 TaskStore, 58-03 reconciler, Phase 59 TaskManager, Phase 60
 * TriggerEngine, Phase 63 CLIs) pattern-match on TaskStatus values and LEGAL_TRANSITIONS
 * keys — do NOT add / reorder without a roadmap update.
 *
 * Chain metadata fields on the row (causation_id, parent_task_id, depth) are sourced
 * from `TurnOrigin` (src/manager/turn-origin.ts) at insert time by Phase 59 callers:
 *   - causation_id := TurnOrigin.rootTurnId
 *   - parent_task_id := caller's in-flight task_id (or null for root tasks)
 *   - depth := TurnOrigin.chain.length - 1 (caller-enforced invariant)
 *
 * Reference-only — no import from this file to avoid a tasks → manager dep cycle.
 */

export const TASK_STATUSES = [
  "pending",
  "running",
  "awaiting_input",
  "complete",
  "failed",
  "cancelled",
  "timed_out",
  "orphaned",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * LEGAL_TRANSITIONS: `from → allowed[to]` map. Empty array = terminal.
 * Any (from, to) pair not covered here is ILLEGAL and throws IllegalTaskTransitionError
 * from assertLegalTransition (src/tasks/state-machine.ts).
 *
 * `orphaned` has a SPECIAL entry path: reconciler bypasses assertLegalTransition via
 * TaskStore.markOrphaned (Plan 58-02) — the map still lists `orphaned` as terminal.
 */
export const LEGAL_TRANSITIONS: ReadonlyMap<TaskStatus, readonly TaskStatus[]> = new Map<
  TaskStatus,
  readonly TaskStatus[]
>([
  ["pending", ["running", "cancelled"] as const],
  ["running", ["awaiting_input", "complete", "failed", "cancelled", "timed_out"] as const],
  ["awaiting_input", ["running", "cancelled", "timed_out"] as const],
  ["complete", [] as const],
  ["failed", [] as const],
  ["cancelled", [] as const],
  ["timed_out", [] as const],
  ["orphaned", [] as const],
]);

/**
 * The 5 terminal statuses. Exported explicitly (rather than derived at call
 * sites from LEGAL_TRANSITIONS) so Phase 60 retention queries and Phase 63
 * CLI filters can use a fast `Set.has()` lookup without rebuilding the set.
 */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "complete",
  "failed",
  "cancelled",
  "timed_out",
  "orphaned",
]);

/**
 * The 2 in-flight statuses — Phase 58-03 reconciler scans for these AND
 * stale heartbeat_at to flip rows into `orphaned`.
 */
export const IN_FLIGHT_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "running",
  "awaiting_input",
]);
