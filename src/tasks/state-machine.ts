/**
 * Phase 58 — task state machine.
 *
 * Pure functions over the LEGAL_TRANSITIONS table in src/tasks/types.ts.
 * NO SQLite / no I/O — Plan 58-02 TaskStore calls assertLegalTransition
 * before issuing an UPDATE statement.
 *
 * The `orphaned` terminal status is entered via a SPECIAL reconciler path
 * (TaskStore.markOrphaned in Plan 58-02) that bypasses assertLegalTransition.
 * Every other path (Phase 59 TaskManager, Phase 60 TriggerEngine) MUST go
 * through assertLegalTransition.
 */

import {
  LEGAL_TRANSITIONS,
  TERMINAL_STATUSES,
  IN_FLIGHT_STATUSES,
  type TaskStatus,
} from "./types.js";
import { IllegalTaskTransitionError } from "./errors.js";

/**
 * Throws IllegalTaskTransitionError if `from → to` is not present in
 * LEGAL_TRANSITIONS. Returns void on success.
 *
 * Never returns boolean — callers MUST use try/catch (or let the error
 * propagate to the IPC / MCP layer where Phase 59 / 60 translate it into
 * typed error responses).
 */
export function assertLegalTransition(from: TaskStatus, to: TaskStatus): void {
  const allowed = LEGAL_TRANSITIONS.get(from);
  if (!allowed || !allowed.includes(to)) {
    throw new IllegalTaskTransitionError(from, to);
  }
}

/** True when `status` is one of the 5 terminal statuses (no outbound transitions). */
export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** True when `status` is `running` or `awaiting_input` (reconciler target set). */
export function isInFlight(status: TaskStatus): boolean {
  return IN_FLIGHT_STATUSES.has(status);
}
