/**
 * Phase 58 Plan 02 — TaskStore.
 *
 * SQLite persistence layer for the task lifecycle (LIFE-01 + LIFE-02). Wraps
 * a single daemon-scoped `tasks.db` with:
 *
 *   - tasks table (15 LIFE-02 fields + CHECK constraints on status & depth)
 *   - trigger_state table (Phase 60 source watermarks + opaque cursor blobs)
 *   - 4 covering indexes (reconciler scan, causation walk, retention cleanup,
 *     and clawcode-tasks CLI filter per CONTEXT <specifics>)
 *
 * Conventions mirror `src/performance/trace-store.ts` and
 * `src/memory/store.ts`: synchronous better-sqlite3, WAL + foreign_keys
 * PRAGMAs, prepared statements in a readonly struct, and typed wrapping of
 * SQLite failures into `TaskStoreError`. `TaskNotFoundError` /
 * `IllegalTaskTransitionError` remain distinct so callers can branch on
 * them via `instanceof` without parsing error messages.
 *
 * Task 1 lands the skeleton (schema + migration + insert + get + close);
 * Task 2 extends it with transition + markOrphaned + listStaleRunning +
 * trigger_state CRUD.
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType, Statement } from "better-sqlite3";

import {
  TaskRowSchema,
  TriggerStateRowSchema,
  type TaskRow,
  type TriggerStateRow,
} from "./schema.js";
import { IN_FLIGHT_STATUSES, type TaskStatus } from "./types.js";
import { TaskStoreError, TaskNotFoundError } from "./errors.js";
import { assertLegalTransition, isTerminal } from "./state-machine.js";

/**
 * Default reconciler threshold — 5 minutes. Matches the daemon heartbeat
 * cadence; Plan 58-03 passes this to `listStaleRunning()` on each tick.
 */
export const ORPHAN_THRESHOLD_MS_DEFAULT = 5 * 60 * 1000;

/** Constructor options — single daemon-scoped DB path. */
export type TaskStoreOptions = {
  readonly dbPath: string;
};

/**
 * Patch accepted by `transition`. `ended_at` optional: when omitted AND
 * the target status is terminal, the store stamps `Date.now()`. Callers
 * that want to preserve a pre-computed completion time (e.g. reconciler
 * replay) supply the field explicitly.
 */
export type TaskTransitionPatch = {
  readonly ended_at?: number;
  readonly result_digest?: string | null;
  readonly error?: string | null;
  readonly chain_token_cost?: number;
};

/** Prepared statements used by TaskStore. */
type PreparedStatements = {
  readonly insertTask: Statement;
  readonly getTask: Statement;
  readonly updateTaskStatus: Statement;
  readonly markOrphanedStmt: Statement;
  readonly listStaleRunningStmt: Statement;
  readonly upsertTriggerStateStmt: Statement;
  readonly getTriggerStateStmt: Statement;
  readonly purgeCompletedStmt: Statement;
  readonly purgeTriggerEventsStmt: Statement;
};

/**
 * Raw row shape returned by `SELECT * FROM tasks`. Zod re-parses this into
 * a `TaskRow` so the caller never touches raw SQLite output.
 */
type TaskRawRow = {
  readonly task_id: string;
  readonly task_type: string;
  readonly caller_agent: string;
  readonly target_agent: string;
  readonly causation_id: string;
  readonly parent_task_id: string | null;
  readonly depth: number;
  readonly input_digest: string;
  readonly status: string;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly heartbeat_at: number;
  readonly result_digest: string | null;
  readonly error: string | null;
  readonly chain_token_cost: number;
};

/** Raw row shape returned by `SELECT * FROM trigger_state`. */
type TriggerStateRawRow = {
  readonly source_id: string;
  readonly last_watermark: string | null;
  readonly cursor_blob: string | null;
  readonly updated_at: number;
};

export class TaskStore {
  private readonly db: DatabaseType;
  private readonly dbPath: string;
  private readonly stmts: PreparedStatements;

  constructor(options: TaskStoreOptions) {
    this.dbPath = options.dbPath;
    try {
      this.db = new Database(options.dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("synchronous = NORMAL");
      this.db.pragma("foreign_keys = ON");

      this.ensureSchema();
      this.stmts = this.prepareStatements();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TaskStoreError(`open failed: ${msg}`, options.dbPath);
    }
  }

  /**
   * Create tables + indexes idempotently.
   *
   * Uses `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` in a
   * single transaction. Future v1.9+ schema changes will use the
   * PRAGMA table_info migration pattern from `src/performance/trace-store.ts`
   * (see Phase 52 / 57-02 precedent).
   */
  private ensureSchema(): void {
    const ddl = `
      BEGIN;

      CREATE TABLE IF NOT EXISTS tasks (
        task_id          TEXT PRIMARY KEY,
        task_type        TEXT NOT NULL,
        caller_agent     TEXT NOT NULL,
        target_agent     TEXT NOT NULL,
        causation_id     TEXT NOT NULL,
        parent_task_id   TEXT,
        depth            INTEGER NOT NULL CHECK(depth >= 0),
        input_digest     TEXT NOT NULL,
        status           TEXT NOT NULL CHECK(status IN
                          ('pending','running','awaiting_input',
                           'complete','failed','cancelled','timed_out','orphaned')),
        started_at       INTEGER NOT NULL,
        ended_at         INTEGER,
        heartbeat_at     INTEGER NOT NULL,
        result_digest    TEXT,
        error            TEXT,
        chain_token_cost INTEGER NOT NULL DEFAULT 0 CHECK(chain_token_cost >= 0)
      );

      CREATE TABLE IF NOT EXISTS trigger_state (
        source_id      TEXT PRIMARY KEY,
        last_watermark TEXT,
        cursor_blob    TEXT,
        updated_at     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trigger_events (
        source_id        TEXT NOT NULL,
        idempotency_key  TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        UNIQUE(source_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status_heartbeat ON tasks(status, heartbeat_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_causation_id     ON tasks(causation_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_ended_at         ON tasks(ended_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_caller_target    ON tasks(caller_agent, target_agent);
      CREATE INDEX IF NOT EXISTS idx_trigger_events_created_at
        ON trigger_events(created_at);

      COMMIT;
    `;
    this.db.exec(ddl);

    // Phase 62: idempotent ALTER TABLE for trigger_events extension.
    // Adds source_kind + payload columns for dry-run replay. Existing DBs
    // have the 3-column schema; new DBs get the full schema via DedupLayer.
    try { this.db.exec("ALTER TABLE trigger_events ADD COLUMN source_kind TEXT"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE trigger_events ADD COLUMN payload TEXT"); } catch { /* column exists */ }
  }

  /**
   * Insert a new task row. Zod-validates the full 15-field shape before any
   * SQL runs, so invalid statuses / negative depth / empty strings fail fast
   * with the Zod error propagated directly (callers that want `instanceof
   * TaskStoreError` semantics should catch Zod separately).
   *
   * SQLite-level failures (CHECK constraint, UNIQUE violation) are wrapped in
   * `TaskStoreError` with the db path for log debugging.
   */
  insert(row: TaskRow): void {
    const parsed = TaskRowSchema.parse(row);
    try {
      this.stmts.insertTask.run(
        parsed.task_id,
        parsed.task_type,
        parsed.caller_agent,
        parsed.target_agent,
        parsed.causation_id,
        parsed.parent_task_id,
        parsed.depth,
        parsed.input_digest,
        parsed.status,
        parsed.started_at,
        parsed.ended_at,
        parsed.heartbeat_at,
        parsed.result_digest,
        parsed.error,
        parsed.chain_token_cost,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TaskStoreError(`insert failed: ${msg}`, this.dbPath);
    }
  }

  /**
   * Fetch a task by id. Returns `null` (never throws) when the id is absent —
   * callers that need the not-found-as-error semantics use `transition` or
   * `markOrphaned` (both throw `TaskNotFoundError`).
   */
  get(taskId: string): TaskRow | null {
    try {
      const raw = this.stmts.getTask.get(taskId) as TaskRawRow | undefined;
      if (!raw) return null;
      return TaskRowSchema.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TaskStoreError(`get failed: ${msg}`, this.dbPath);
    }
  }

  /**
   * Transition a task to `newStatus` after running the LIFE-01 state-machine
   * check. Semantics (locked in 58-02 <locked_shapes>):
   *
   *   1. Read the row; throw `TaskNotFoundError` if absent.
   *   2. Call `assertLegalTransition(current.status, newStatus)` — throws
   *      `IllegalTaskTransitionError` BEFORE any UPDATE so illegal paths
   *      leave the row untouched (proved by Test 17).
   *   3. Compute `heartbeat_at`: refresh to `Date.now()` iff the target is
   *      in-flight; otherwise preserve the current value.
   *   4. Compute `ended_at`: caller's patch wins; otherwise stamp
   *      `Date.now()` on terminal transitions; otherwise preserve.
   *   5. Merge the remaining patch fields (result_digest, error,
   *      chain_token_cost) onto the current row.
   *   6. UPDATE and re-read. Re-read is Zod-parsed before returning so
   *      callers always receive a validated row.
   */
  transition(
    taskId: string,
    newStatus: TaskStatus,
    patch: TaskTransitionPatch = {},
  ): TaskRow {
    const current = this.get(taskId);
    if (!current) {
      throw new TaskNotFoundError(taskId);
    }

    // LIFE-01 enforcement: reject illegal transitions before any UPDATE.
    assertLegalTransition(current.status, newStatus);

    const now = Date.now();
    const effectiveHeartbeat = IN_FLIGHT_STATUSES.has(newStatus)
      ? now
      : current.heartbeat_at;
    const effectiveEndedAt =
      patch.ended_at !== undefined
        ? patch.ended_at
        : isTerminal(newStatus)
          ? now
          : current.ended_at;
    const effectiveResultDigest =
      patch.result_digest !== undefined
        ? patch.result_digest
        : current.result_digest;
    const effectiveError =
      patch.error !== undefined ? patch.error : current.error;
    const effectiveChainTokenCost =
      patch.chain_token_cost !== undefined
        ? patch.chain_token_cost
        : current.chain_token_cost;

    try {
      this.stmts.updateTaskStatus.run(
        newStatus,
        effectiveHeartbeat,
        effectiveEndedAt,
        effectiveResultDigest,
        effectiveError,
        effectiveChainTokenCost,
        taskId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TaskStoreError(`transition failed: ${msg}`, this.dbPath);
    }

    const updated = this.get(taskId);
    if (!updated) {
      throw new TaskStoreError(
        `transition succeeded but row disappeared: ${taskId}`,
        this.dbPath,
      );
    }
    return updated;
  }

  /**
   * Reconciler-only escape hatch. BYPASSES `assertLegalTransition` because
   * the reconciler may race with natural completion — it still needs to
   * mark a row orphaned even if the row just transitioned to a terminal
   * status. `orphaned` is terminal in the state machine, so once set no
   * further transitions are permitted.
   *
   * `heartbeat_at` is intentionally unchanged — the stale timestamp is
   * the evidence for the reconciler's decision.
   */
  markOrphaned(taskId: string): TaskRow {
    const current = this.get(taskId);
    if (!current) {
      throw new TaskNotFoundError(taskId);
    }
    try {
      this.stmts.markOrphanedStmt.run(Date.now(), taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TaskStoreError(`markOrphaned failed: ${msg}`, this.dbPath);
    }
    const updated = this.get(taskId);
    if (!updated) {
      throw new TaskStoreError(
        `markOrphaned succeeded but row disappeared: ${taskId}`,
        this.dbPath,
      );
    }
    return updated;
  }

  /**
   * Return every in-flight task whose heartbeat is older than
   * `Date.now() - thresholdMs`. Plan 58-03's reconciler iterates the result
   * and flips each row via `markOrphaned`.
   *
   * Returns a frozen array of Zod-parsed rows — callers must not mutate.
   */
  listStaleRunning(thresholdMs: number): readonly TaskRow[] {
    try {
      const cutoff = Date.now() - thresholdMs;
      const raws = this.stmts.listStaleRunningStmt.all(
        cutoff,
      ) as readonly TaskRawRow[];
      return Object.freeze(raws.map((r) => TaskRowSchema.parse(r)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TaskStoreError(`listStaleRunning failed: ${msg}`, this.dbPath);
    }
  }

  /**
   * Upsert a trigger source watermark + opaque cursor blob. Phase 60
   * TriggerEngine calls this on every source tick with the latest
   * observation point; `updated_at` is stamped server-side so callers
   * never need to wall-clock.
   */
  upsertTriggerState(
    sourceId: string,
    lastWatermark: string | null,
    cursorBlob: string | null,
  ): void {
    try {
      this.stmts.upsertTriggerStateStmt.run(
        sourceId,
        lastWatermark,
        cursorBlob,
        Date.now(),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TaskStoreError(`upsertTriggerState failed: ${msg}`, this.dbPath);
    }
  }

  /** Read a trigger source watermark; returns `null` if unseen. */
  getTriggerState(sourceId: string): TriggerStateRow | null {
    try {
      const raw = this.stmts.getTriggerStateStmt.get(sourceId) as
        | TriggerStateRawRow
        | undefined;
      if (!raw) return null;
      return TriggerStateRowSchema.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TaskStoreError(`getTriggerState failed: ${msg}`, this.dbPath);
    }
  }

  /**
   * LIFE-03 -- purge terminal task rows older than cutoffMs (epoch).
   * Called by the task-retention heartbeat check (Phase 60).
   * Returns number of rows deleted.
   */
  purgeCompleted(cutoffMs: number): number {
    try {
      const result = this.stmts.purgeCompletedStmt.run(cutoffMs);
      return result.changes;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TaskStoreError(`purgeCompleted failed: ${msg}`, this.dbPath);
    }
  }

  /**
   * Purge trigger_events rows older than cutoffMs (epoch).
   * Called alongside purgeCompleted on the retention heartbeat.
   * Returns number of rows deleted.
   */
  purgeTriggerEvents(cutoffMs: number): number {
    try {
      const result = this.stmts.purgeTriggerEventsStmt.run(cutoffMs);
      return result.changes;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TaskStoreError(`purgeTriggerEvents failed: ${msg}`, this.dbPath);
    }
  }

  /**
   * Phase 59 -- narrow getter for subsystems that share the tasks.db handle
   * (e.g., PayloadStore). The returned Database MUST NOT be .close()d by
   * consumers -- TaskStore owns the lifecycle via its own close() method.
   */
  public get rawDb(): DatabaseType {
    return this.db;
  }

  /** Release the underlying SQLite handle. Subsequent calls throw. */
  close(): void {
    this.db.close();
  }

  private prepareStatements(): PreparedStatements {
    return {
      insertTask: this.db.prepare(`
        INSERT INTO tasks
          (task_id, task_type, caller_agent, target_agent, causation_id,
           parent_task_id, depth, input_digest, status, started_at,
           ended_at, heartbeat_at, result_digest, error, chain_token_cost)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getTask: this.db.prepare(`SELECT * FROM tasks WHERE task_id = ?`),
      updateTaskStatus: this.db.prepare(`
        UPDATE tasks
        SET status = ?,
            heartbeat_at = ?,
            ended_at = ?,
            result_digest = ?,
            error = ?,
            chain_token_cost = ?
        WHERE task_id = ?
      `),
      markOrphanedStmt: this.db.prepare(`
        UPDATE tasks
        SET status = 'orphaned',
            ended_at = ?
        WHERE task_id = ?
      `),
      listStaleRunningStmt: this.db.prepare(`
        SELECT * FROM tasks
        WHERE status IN ('running', 'awaiting_input')
          AND heartbeat_at < ?
      `),
      upsertTriggerStateStmt: this.db.prepare(`
        INSERT INTO trigger_state (source_id, last_watermark, cursor_blob, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET
          last_watermark = excluded.last_watermark,
          cursor_blob = excluded.cursor_blob,
          updated_at = excluded.updated_at
      `),
      getTriggerStateStmt: this.db.prepare(`
        SELECT * FROM trigger_state WHERE source_id = ?
      `),
      purgeCompletedStmt: this.db.prepare(`
        DELETE FROM tasks
        WHERE status IN ('complete', 'failed', 'cancelled', 'timed_out', 'orphaned')
          AND ended_at < ?
      `),
      purgeTriggerEventsStmt: this.db.prepare(`
        DELETE FROM trigger_events WHERE created_at < ?
      `),
    };
  }
}
