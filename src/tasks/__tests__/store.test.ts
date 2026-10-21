/**
 * Phase 58 Plan 02 — TaskStore tests.
 *
 * Covers LIFE-01 (state-machine enforcement — transition + markOrphaned +
 * listStaleRunning) and LIFE-02 (15-field row shape round-trips through Zod
 * + SQLite). Tests are organized by the task they exercise; tmp-file db is
 * created in beforeEach and cleaned up in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

import { TaskStore, ORPHAN_THRESHOLD_MS_DEFAULT } from "../store.js";
import type { TaskRow } from "../schema.js";
import {
  TaskStoreError,
  TaskNotFoundError,
  IllegalTaskTransitionError,
} from "../errors.js";

/**
 * Build a minimal valid TaskRow with every one of the 15 LIFE-02 fields
 * populated. Tests call with overrides to exercise specific scenarios.
 */
function validRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    task_id: "t-1",
    task_type: "research.brief",
    caller_agent: "fin-client",
    target_agent: "fin-research",
    causation_id: "discord:1234567890",
    parent_task_id: null,
    depth: 0,
    input_digest: "sha256:abc",
    status: "pending",
    started_at: 1700000000000,
    ended_at: null,
    heartbeat_at: 1700000000000,
    result_digest: null,
    error: null,
    chain_token_cost: 0,
    ...overrides,
  };
}

describe("TaskStore", () => {
  let dir: string;
  let dbPath: string;
  let store: TaskStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "taskstore-"));
    dbPath = join(dir, "tasks.db");
    store = new TaskStore({ dbPath });
  });

  afterEach(async () => {
    try {
      store.close();
    } catch {
      // already closed — ignore
    }
    await rm(dir, { recursive: true, force: true });
  });

  describe("Task 1: skeleton — schema + migration + CRUD", () => {
    it("Test 1: construction creates the db file with all 15 tasks columns", () => {
      expect(existsSync(dbPath)).toBe(true);
      // Verify via PRAGMA table_info(tasks) — exact column names per LIFE-02.
      const inspect = new Database(dbPath, { readonly: true });
      const cols = inspect
        .prepare("PRAGMA table_info(tasks)")
        .all() as ReadonlyArray<{ readonly name: string; readonly type: string }>;
      inspect.close();

      const names = cols.map((c) => c.name);
      expect(names).toEqual([
        "task_id",
        "task_type",
        "caller_agent",
        "target_agent",
        "causation_id",
        "parent_task_id",
        "depth",
        "input_digest",
        "status",
        "started_at",
        "ended_at",
        "heartbeat_at",
        "result_digest",
        "error",
        "chain_token_cost",
      ]);
    });

    it("Test 2: trigger_state table has 4 columns (source_id PK, last_watermark, cursor_blob, updated_at)", () => {
      const inspect = new Database(dbPath, { readonly: true });
      const cols = inspect
        .prepare("PRAGMA table_info(trigger_state)")
        .all() as ReadonlyArray<{
        readonly name: string;
        readonly pk: number;
      }>;
      inspect.close();

      const names = cols.map((c) => c.name);
      expect(names).toEqual([
        "source_id",
        "last_watermark",
        "cursor_blob",
        "updated_at",
      ]);
      const pkCol = cols.find((c) => c.pk === 1);
      expect(pkCol?.name).toBe("source_id");
    });

    it("Test 3: all 4 required indexes exist on tasks", () => {
      const inspect = new Database(dbPath, { readonly: true });
      const indexRows = inspect
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'",
        )
        .all() as ReadonlyArray<{ readonly name: string }>;
      inspect.close();

      const names = indexRows.map((r) => r.name);
      expect(names).toContain("idx_tasks_status_heartbeat");
      expect(names).toContain("idx_tasks_causation_id");
      expect(names).toContain("idx_tasks_ended_at");
      expect(names).toContain("idx_tasks_caller_target");
    });

    it("Test 4: reopening an existing TaskStore db is idempotent (no duplicate table/index errors)", () => {
      store.close();
      // Second open against the same path must not throw on re-creation.
      expect(() => {
        const second = new TaskStore({ dbPath });
        second.close();
      }).not.toThrow();
      // Third open — still fine.
      store = new TaskStore({ dbPath });
      expect(existsSync(dbPath)).toBe(true);
    });

    it("Test 5: insert + get round-trip all 15 fields (basic)", () => {
      const row = validRow();
      store.insert(row);
      const read = store.get(row.task_id);
      expect(read).toEqual(row);
    });

    it("Test 6: insert with invalid status rejected by Zod before any SQL runs", () => {
      const bad = { ...validRow(), status: "bogus" as unknown as TaskRow["status"] };
      // Zod error propagates (not wrapped in TaskStoreError).
      expect(() => store.insert(bad)).toThrow();
      // Verify NOT a TaskStoreError — the rejection happened at the Zod layer.
      let caught: unknown;
      try {
        store.insert(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught).not.toBeInstanceOf(TaskStoreError);
    });

    it("Test 7: insert with depth=-1 rejected by Zod validation", () => {
      // TaskRowSchema requires depth.min(0); Zod catches this before SQL.
      const bad = { ...validRow(), depth: -1 };
      expect(() => store.insert(bad)).toThrow();
    });

    it("Test 8: get on missing task_id returns null (not throw)", () => {
      expect(store.get("does-not-exist")).toBeNull();
    });

    it("Test 9: nullable fields round-trip as null (not undefined)", () => {
      const row = validRow({
        parent_task_id: null,
        ended_at: null,
        result_digest: null,
        error: null,
      });
      store.insert(row);
      const read = store.get(row.task_id);
      expect(read).not.toBeNull();
      expect(read?.parent_task_id).toBeNull();
      expect(read?.ended_at).toBeNull();
      expect(read?.result_digest).toBeNull();
      expect(read?.error).toBeNull();
    });

    it("Test 10: PRAGMA journal_mode = wal and foreign_keys = 1", () => {
      const inspect = new Database(dbPath);
      const jm = inspect.pragma("journal_mode", { simple: true }) as string;
      const fk = inspect.pragma("foreign_keys", { simple: true }) as number;
      inspect.close();
      expect(jm).toBe("wal");
      expect(fk).toBe(1);
    });

    it("Test 11: close() — subsequent operations throw (handle released)", () => {
      store.close();
      // After close, better-sqlite3 raises "The database connection is not open".
      expect(() => store.get("t-1")).toThrow();
    });

    it("ORPHAN_THRESHOLD_MS_DEFAULT is 5 minutes", () => {
      expect(ORPHAN_THRESHOLD_MS_DEFAULT).toBe(5 * 60 * 1000);
    });
  });

  describe("Task 2: transition + markOrphaned + listStaleRunning + trigger_state", () => {
    it("Test 12: legal pending→running refreshes heartbeat, ended_at stays null", () => {
      const row = validRow({
        status: "pending",
        heartbeat_at: 1700000000000,
      });
      store.insert(row);
      const before = Date.now();
      const after1 = store.transition(row.task_id, "running");
      const after = Date.now();

      expect(after1.status).toBe("running");
      expect(after1.heartbeat_at).toBeGreaterThanOrEqual(before);
      expect(after1.heartbeat_at).toBeLessThanOrEqual(after + 10);
      expect(after1.ended_at).toBeNull();
    });

    it("Test 13: running→complete stamps ended_at when caller omits it", () => {
      const row = validRow({
        status: "running",
        heartbeat_at: 1700000000000,
      });
      store.insert(row);

      const before = Date.now();
      const out = store.transition(row.task_id, "complete");
      const after = Date.now();

      expect(out.status).toBe("complete");
      expect(out.ended_at).not.toBeNull();
      expect(out.ended_at!).toBeGreaterThanOrEqual(before);
      expect(out.ended_at!).toBeLessThanOrEqual(after + 10);
      // heartbeat_at is NOT refreshed when leaving in-flight state.
      expect(out.heartbeat_at).toBe(1700000000000);
    });

    it("Test 14: running→complete with caller-supplied ended_at uses caller value", () => {
      const row = validRow({ status: "running" });
      store.insert(row);
      const out = store.transition(row.task_id, "complete", {
        ended_at: 1699999999999,
      });
      expect(out.ended_at).toBe(1699999999999);
    });

    it("Test 15: running→failed with error patch sets error + ended_at", () => {
      const row = validRow({ status: "running" });
      store.insert(row);
      const out = store.transition(row.task_id, "failed", { error: "timeout" });
      expect(out.status).toBe("failed");
      expect(out.error).toBe("timeout");
      expect(out.ended_at).not.toBeNull();
    });

    it("Test 16: running→complete with result_digest + chain_token_cost patches", () => {
      const row = validRow({ status: "running" });
      store.insert(row);
      const out = store.transition(row.task_id, "complete", {
        result_digest: "sha256:res",
        chain_token_cost: 4242,
      });
      expect(out.result_digest).toBe("sha256:res");
      expect(out.chain_token_cost).toBe(4242);
    });

    it("Test 17: illegal complete→running throws and leaves the row UNCHANGED", () => {
      const row = validRow({ status: "complete", ended_at: 1700000005000 });
      store.insert(row);

      expect(() => store.transition(row.task_id, "running")).toThrow(
        IllegalTaskTransitionError,
      );
      // Proof: no partial write.
      const after = store.get(row.task_id);
      expect(after?.status).toBe("complete");
      expect(after?.ended_at).toBe(1700000005000);
    });

    it("Test 18: awaiting_input→running refreshes heartbeat_at", () => {
      const row = validRow({
        status: "awaiting_input",
        heartbeat_at: 1600000000000, // very stale
      });
      store.insert(row);
      const before = Date.now();
      const out = store.transition(row.task_id, "running");
      const after = Date.now();
      expect(out.heartbeat_at).toBeGreaterThanOrEqual(before);
      expect(out.heartbeat_at).toBeLessThanOrEqual(after + 10);
    });

    it("Test 19: transition on missing id throws TaskNotFoundError", () => {
      let caught: unknown;
      try {
        store.transition("nonexistent", "running");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(TaskNotFoundError);
      expect((caught as TaskNotFoundError).taskId).toBe("nonexistent");
    });

    it("Test 20: markOrphaned bypasses assertLegalTransition on a complete row", () => {
      const row = validRow({ status: "complete", ended_at: 1700000005000 });
      store.insert(row);
      const before = Date.now();
      const out = store.markOrphaned(row.task_id);
      const after = Date.now();

      expect(out.status).toBe("orphaned");
      expect(out.ended_at!).toBeGreaterThanOrEqual(before);
      expect(out.ended_at!).toBeLessThanOrEqual(after + 10);
    });

    it("Test 21: markOrphaned on in-flight row keeps heartbeat unchanged, sets ended_at", () => {
      const oldHeartbeat = 1700000000000;
      const row = validRow({
        status: "running",
        heartbeat_at: oldHeartbeat,
      });
      store.insert(row);
      const before = Date.now();
      const out = store.markOrphaned(row.task_id);
      const after = Date.now();

      expect(out.status).toBe("orphaned");
      expect(out.heartbeat_at).toBe(oldHeartbeat);
      expect(out.ended_at!).toBeGreaterThanOrEqual(before);
      expect(out.ended_at!).toBeLessThanOrEqual(after + 10);
    });

    it("Test 22: markOrphaned on missing id throws TaskNotFoundError", () => {
      expect(() => store.markOrphaned("ghost")).toThrow(TaskNotFoundError);
    });

    it("Test 23: listStaleRunning filters by status IN (running, awaiting_input) AND heartbeat threshold", () => {
      const now = Date.now();
      const fresh = validRow({
        task_id: "t-fresh",
        status: "running",
        heartbeat_at: now - 60 * 1000, // 1 min old
      });
      const stale = validRow({
        task_id: "t-stale",
        status: "running",
        heartbeat_at: now - 10 * 60 * 1000, // 10 min old
      });
      const staleButComplete = validRow({
        task_id: "t-complete-stale",
        status: "complete",
        ended_at: now - 9 * 60 * 1000,
        heartbeat_at: now - 10 * 60 * 1000,
      });
      store.insert(fresh);
      store.insert(stale);
      store.insert(staleButComplete);

      const results = store.listStaleRunning(5 * 60 * 1000);
      expect(results).toHaveLength(1);
      expect(results[0]?.task_id).toBe("t-stale");
    });

    it("Test 24: listStaleRunning includes awaiting_input rows", () => {
      const now = Date.now();
      const row = validRow({
        task_id: "t-ai-stale",
        status: "awaiting_input",
        heartbeat_at: now - 10 * 60 * 1000,
      });
      store.insert(row);

      const results = store.listStaleRunning(5 * 60 * 1000);
      expect(results.map((r) => r.task_id)).toContain("t-ai-stale");
    });

    it("Test 25: listStaleRunning returns a frozen array of Zod-parsed rows", () => {
      const now = Date.now();
      store.insert(
        validRow({
          task_id: "t-freeze",
          status: "running",
          heartbeat_at: now - 10 * 60 * 1000,
        }),
      );
      const results = store.listStaleRunning(5 * 60 * 1000);
      expect(Object.isFrozen(results)).toBe(true);
      // Every returned row has the full TaskRow shape (Zod-parsed).
      for (const r of results) {
        expect(typeof r.task_id).toBe("string");
        expect(typeof r.status).toBe("string");
        expect(typeof r.heartbeat_at).toBe("number");
      }
    });

    it("Test 26: trigger_state upsert insert + getTriggerState round-trip", () => {
      const before = Date.now();
      store.upsertTriggerState("scheduler", "2026-04-15T00:00:00Z", null);
      const after = Date.now();

      const row = store.getTriggerState("scheduler");
      expect(row).not.toBeNull();
      expect(row?.source_id).toBe("scheduler");
      expect(row?.last_watermark).toBe("2026-04-15T00:00:00Z");
      expect(row?.cursor_blob).toBeNull();
      expect(row?.updated_at).toBeGreaterThanOrEqual(before);
      expect(row?.updated_at).toBeLessThanOrEqual(after + 10);
    });

    it("Test 27: trigger_state upsert update replaces watermark on conflict", () => {
      store.upsertTriggerState("scheduler", "2026-04-15T00:00:00Z", null);
      store.upsertTriggerState("scheduler", "2026-04-15T12:00:00Z", null);
      const row = store.getTriggerState("scheduler");
      expect(row?.last_watermark).toBe("2026-04-15T12:00:00Z");
    });

    it("Test 28: trigger_state cursor_blob round-trips opaque JSON strings", () => {
      const blob = JSON.stringify({ lastId: 42, syncToken: "abc/def" });
      store.upsertTriggerState("mysql:foo", null, blob);
      const row = store.getTriggerState("mysql:foo");
      expect(row?.cursor_blob).toBe(blob);
    });

    it("Test 29: getTriggerState on missing source_id returns null", () => {
      expect(store.getTriggerState("never-inserted")).toBeNull();
    });

    it("Test 30: LIFE-02 FULL 15-field round-trip with every field non-null / non-default", () => {
      const row: TaskRow = {
        task_id: "t-life02",
        task_type: "research.brief",
        caller_agent: "fin-client",
        target_agent: "fin-research",
        causation_id: "discord:1234567890",
        parent_task_id: "t-parent",
        depth: 3,
        input_digest: "sha256:input",
        status: "running",
        started_at: 1700000000000,
        ended_at: 1700000001000,
        heartbeat_at: 1700000000500,
        result_digest: "sha256:result",
        error: "intermediate",
        chain_token_cost: 9999,
      };
      store.insert(row);
      const read = store.get(row.task_id);
      expect(read).toEqual(row);
    });
  });
});
