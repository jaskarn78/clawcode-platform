/**
 * Phase 58 — task subsystem typed errors.
 *
 * Follows the src/shared/errors.ts convention: extend Error, set this.name to
 * the class name, expose readonly context fields, format messages with structured
 * suffixes for grep-ability in pino logs.
 *
 * Kept feature-local (matches src/memory/errors.ts pattern) since these are
 * only thrown by the tasks subsystem and Phase 59/60 typed catches.
 */

import type { TaskStatus } from "./types.js";

/**
 * Thrown when a TaskStore SQLite operation fails. dbPath surfaces the daemon
 * tasks.db location for pino log debugging.
 */
export class TaskStoreError extends Error {
  readonly dbPath: string;

  constructor(message: string, dbPath: string) {
    super(`TaskStore: ${message} (${dbPath})`);
    this.name = "TaskStoreError";
    this.dbPath = dbPath;
  }
}

/**
 * Thrown by assertLegalTransition (src/tasks/state-machine.ts) when a caller
 * attempts a (from, to) transition not present in LEGAL_TRANSITIONS. Phase 59
 * TaskManager + Phase 60 TriggerEngine catch this to translate into MCP / IPC
 * typed responses.
 */
export class IllegalTaskTransitionError extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Illegal task transition: ${from} → ${to}`);
    this.name = "IllegalTaskTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Thrown by TaskStore.get / TaskStore.transition (Plan 58-02) when the
 * referenced task_id is not in the tasks table. Distinct from TaskStoreError
 * so callers can `instanceof` the not-found path separately from generic
 * SQLite failures.
 */
export class TaskNotFoundError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
  }
}

// =====================================================================
// Phase 59 handoff errors — TaskManager throws these; MCP / IPC layers
// translate instanceof branches to typed wire responses.
// =====================================================================

/**
 * Thrown by schema validation / payload size checks. `reason` discriminates
 * the four failure modes; `details` carries structured context for logs.
 */
export class ValidationError extends Error {
  readonly reason: "payload_too_large" | "schema_mismatch" | "unknown_schema" | "output_invalid";
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    reason: ValidationError["reason"],
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(`Validation failed (${reason}): ${message}`);
    this.name = "ValidationError";
    this.reason = reason;
    this.details = Object.freeze({ ...details });
  }
}

/** Thrown when caller is not in the target's acceptsTasks[schema] allowlist (HAND-04). */
export class UnauthorizedError extends Error {
  readonly caller: string;
  readonly target: string;
  readonly schema: string;

  constructor(caller: string, target: string, schema: string) {
    super(`Agent '${caller}' is not authorized to delegate schema '${schema}' to '${target}'`);
    this.name = "UnauthorizedError";
    this.caller = caller;
    this.target = target;
    this.schema = schema;
  }
}

/** Thrown when target_agent already appears in the causation chain (HAND-05). */
export class CycleDetectedError extends Error {
  readonly target: string;
  readonly foundAtTaskId: string;

  constructor(target: string, foundAtTaskId: string) {
    super(
      `Handoff cycle detected: '${target}' already appears in the causation chain at task '${foundAtTaskId}'`,
    );
    this.name = "CycleDetectedError";
    this.target = target;
    this.foundAtTaskId = foundAtTaskId;
  }
}

/** Thrown when depth > MAX_HANDOFF_DEPTH (HAND-05). */
export class DepthExceededError extends Error {
  readonly depth: number;
  readonly max: number;

  constructor(depth: number, max: number) {
    super(`Handoff depth ${depth} exceeds MAX_HANDOFF_DEPTH=${max}`);
    this.name = "DepthExceededError";
    this.depth = depth;
    this.max = max;
  }
}

/** Thrown when caller === target (HAND-07). */
export class SelfHandoffBlockedError extends Error {
  readonly agent: string;

  constructor(agent: string) {
    super(`Agent '${agent}' cannot delegate to itself`);
    this.name = "SelfHandoffBlockedError";
    this.agent = agent;
  }
}

/** Thrown when the chain deadline elapses mid-task (HAND-03). */
export class DeadlineExceededError extends Error {
  readonly taskId: string;
  readonly deadlineMs: number;

  constructor(taskId: string, deadlineMs: number) {
    super(`Task '${taskId}' exceeded deadline (${deadlineMs}ms)`);
    this.name = "DeadlineExceededError";
    this.taskId = taskId;
    this.deadlineMs = deadlineMs;
  }
}
