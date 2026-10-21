/**
 * Phase 59 -- raw payload + result storage for tasks.
 *
 * Side-table to the Phase 58 `tasks` schema -- preserves the LIFE-02 15-field
 * row shape unchanged while giving TaskManager.retry / getStatus a way to
 * retrieve the ORIGINAL payload (for digest re-verification per Pitfall 3) and
 * the completed result (for status introspection).
 *
 * Shares the tasks.db Database handle with TaskStore (single-writer invariant
 * preserved). Idempotent CREATE-IF-NOT-EXISTS so reboots are no-ops.
 */

import type Database from "better-sqlite3";

export class PayloadStore {
  private readonly db: Database.Database;
  private readonly stmts: {
    readonly upsertInput: Database.Statement;
    readonly updateResult: Database.Statement;
    readonly getInput: Database.Statement;
    readonly getResult: Database.Statement;
  };

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
    this.stmts = {
      upsertInput: db.prepare(
        `INSERT INTO task_payloads (task_id, input_json, result_json, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET input_json = excluded.input_json, updated_at = excluded.updated_at`,
      ),
      updateResult: db.prepare(
        `UPDATE task_payloads SET result_json = ?, updated_at = ? WHERE task_id = ?`,
      ),
      getInput: db.prepare(`SELECT input_json FROM task_payloads WHERE task_id = ?`),
      getResult: db.prepare(`SELECT result_json FROM task_payloads WHERE task_id = ?`),
    };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_payloads (
        task_id TEXT PRIMARY KEY,
        input_json TEXT NOT NULL,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_payloads_created ON task_payloads(created_at);
    `);
  }

  storePayload(taskId: string, payload: unknown): void {
    const now = Date.now();
    this.stmts.upsertInput.run(taskId, JSON.stringify(payload), now, now);
  }

  storeResult(taskId: string, result: unknown): void {
    const now = Date.now();
    this.stmts.updateResult.run(JSON.stringify(result), now, taskId);
  }

  getPayload(taskId: string): unknown | null {
    const row = this.stmts.getInput.get(taskId) as { input_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.input_json) as unknown;
  }

  getResult(taskId: string): unknown | null {
    const row = this.stmts.getResult.get(taskId) as { result_json: string | null } | undefined;
    if (!row || row.result_json === null) return null;
    return JSON.parse(row.result_json) as unknown;
  }
}
