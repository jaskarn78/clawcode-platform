/**
 * Phase 58 — Zod schemas for task lifecycle persistence.
 *
 * TaskRowSchema is the LIFE-02 15-field row shape that Plan 58-02 TaskStore
 * validates on insert and parses on read. TriggerStateRowSchema is the
 * Phase 60 watermark/cursor table — defined here (alongside the task row)
 * because both live in tasks.db.
 *
 * Convention: `.nullable()` on optional persisted fields, never `.optional()`,
 * so the SQLite NULL ↔ TS `null` round-trip is exact (no `undefined` leaks).
 *
 * The 15-field LIFE-02 contract — every field is required at the schema layer:
 *   task_id, task_type, caller_agent, target_agent, causation_id,
 *   parent_task_id (nullable), depth, input_digest, status,
 *   started_at, ended_at (nullable), heartbeat_at,
 *   result_digest (nullable), error (nullable), chain_token_cost (default 0).
 */

import { z } from "zod/v4";
import { TASK_STATUSES } from "./types.js";

/** TaskStatus enum — derived from the locked TASK_STATUSES tuple. */
export const TaskStatusSchema = z.enum(TASK_STATUSES);

/**
 * 15-field TaskRow schema (LIFE-02). Every field validated on insert.
 * Nullable fields use `.nullable()` for SQLite NULL fidelity.
 * `chain_token_cost` defaults to 0 so callers with no cost telemetry can omit it.
 */
export const TaskRowSchema = z.object({
  task_id: z.string().min(1),
  task_type: z.string().min(1),
  caller_agent: z.string().min(1),
  target_agent: z.string().min(1),
  causation_id: z.string().min(1),
  parent_task_id: z.string().min(1).nullable(),
  depth: z.number().int().min(0),
  input_digest: z.string().min(1),
  status: TaskStatusSchema,
  started_at: z.number().int().min(0),
  ended_at: z.number().int().min(0).nullable(),
  heartbeat_at: z.number().int().min(0),
  result_digest: z.string().min(1).nullable(),
  error: z.string().nullable(),
  chain_token_cost: z.number().int().min(0).default(0),
});

/** Inferred TaskRow type — consumed by TaskStore (Plan 58-02), TaskManager (Phase 59). */
export type TaskRow = z.infer<typeof TaskRowSchema>;

/**
 * trigger_state row — Phase 60 TriggerEngine writes/reads watermarks and
 * source-specific cursor blobs here. cursor_blob is opaque (each source
 * serializes its own JSON shape — webhook seq, MySQL last_seen_id, calendar
 * syncToken, etc).
 */
export const TriggerStateRowSchema = z.object({
  source_id: z.string().min(1),
  last_watermark: z.string().nullable(),
  cursor_blob: z.string().nullable(),
  updated_at: z.number().int().min(0),
});

/** Inferred TriggerStateRow type — consumed by Phase 60 TriggerEngine. */
export type TriggerStateRow = z.infer<typeof TriggerStateRowSchema>;
