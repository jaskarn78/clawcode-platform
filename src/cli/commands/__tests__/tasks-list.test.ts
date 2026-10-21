/**
 * Phase 63 Plan 01 Task 2 -- CLI `clawcode tasks list` tests.
 *
 * Tests queryTaskList and formatTasksTable pure functions. Creates temp
 * SQLite DBs with the full 15-field tasks schema for end-to-end query tests.
 */

import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import {
  queryTaskList,
  formatTasksTable,
  type TaskListRow,
} from "../tasks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(tmpdir(), `tasks-list-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a test DB with the tasks table matching src/tasks/store.ts DDL.
 */
function createTestDb(
  dir: string,
  tasks: Array<{
    task_id: string;
    task_type: string;
    caller_agent: string;
    target_agent: string;
    causation_id: string;
    parent_task_id?: string | null;
    depth: number;
    input_digest: string;
    status: string;
    started_at: number;
    ended_at?: number | null;
    heartbeat_at: number;
    result_digest?: string | null;
    error?: string | null;
    chain_token_cost: number;
  }>,
): string {
  const dbPath = join(dir, "tasks.db");
  const db = new Database(dbPath);
  db.exec(`
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
    )
  `);

  const insertTask = db.prepare(
    `INSERT INTO tasks (task_id, task_type, caller_agent, target_agent, causation_id,
     parent_task_id, depth, input_digest, status, started_at, ended_at, heartbeat_at,
     result_digest, error, chain_token_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const t of tasks) {
    insertTask.run(
      t.task_id,
      t.task_type,
      t.caller_agent,
      t.target_agent,
      t.causation_id,
      t.parent_task_id ?? null,
      t.depth,
      t.input_digest,
      t.status,
      t.started_at,
      t.ended_at ?? null,
      t.heartbeat_at,
      t.result_digest ?? null,
      t.error ?? null,
      t.chain_token_cost,
    );
  }
  db.close();
  return dbPath;
}

// ---------------------------------------------------------------------------
// queryTaskList
// ---------------------------------------------------------------------------

describe("queryTaskList", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("returns all tasks within the since window ordered by started_at DESC", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();

    const dbPath = createTestDb(dir, [
      {
        task_id: "task:001-abcdef-123456",
        task_type: "handoff",
        caller_agent: "admin",
        target_agent: "data-agent",
        causation_id: "caus:001",
        depth: 0,
        input_digest: "sha256:abc",
        status: "complete",
        started_at: now - 60_000,
        ended_at: now - 58_000,
        heartbeat_at: now - 60_000,
        chain_token_cost: 1200,
      },
      {
        task_id: "task:002-defabc-789012",
        task_type: "handoff",
        caller_agent: "sync-agent",
        target_agent: "admin",
        causation_id: "caus:002",
        depth: 1,
        input_digest: "sha256:def",
        status: "running",
        started_at: now - 30_000,
        heartbeat_at: now - 30_000,
        chain_token_cost: 500,
      },
    ]);

    const rows = queryTaskList({ dbPath, sinceMs: 3_600_000 });

    expect(rows.length).toBe(2);
    // Newer task first (DESC order)
    expect(rows[0]!.caller).toBe("sync-agent");
    expect(rows[1]!.caller).toBe("admin");
  });

  it("truncates task IDs longer than 12 characters", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();

    const dbPath = createTestDb(dir, [
      {
        task_id: "task:001-abcdef-123456",
        task_type: "handoff",
        caller_agent: "admin",
        target_agent: "data-agent",
        causation_id: "caus:001",
        depth: 0,
        input_digest: "sha256:abc",
        status: "complete",
        started_at: now - 60_000,
        ended_at: now - 58_000,
        heartbeat_at: now - 60_000,
        chain_token_cost: 0,
      },
    ]);

    const rows = queryTaskList({ dbPath, sinceMs: 3_600_000 });
    expect(rows[0]!.taskId.length).toBeLessThanOrEqual(15); // 12 + "..."
    expect(rows[0]!.taskId).toContain("...");
  });

  it("filters by --agent matching caller_agent OR target_agent", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();

    const dbPath = createTestDb(dir, [
      {
        task_id: "task:001",
        task_type: "handoff",
        caller_agent: "admin",
        target_agent: "data-agent",
        causation_id: "caus:001",
        depth: 0,
        input_digest: "sha256:abc",
        status: "complete",
        started_at: now - 60_000,
        ended_at: now - 58_000,
        heartbeat_at: now - 60_000,
        chain_token_cost: 0,
      },
      {
        task_id: "task:002",
        task_type: "handoff",
        caller_agent: "sync-agent",
        target_agent: "admin",
        causation_id: "caus:002",
        depth: 0,
        input_digest: "sha256:def",
        status: "running",
        started_at: now - 30_000,
        heartbeat_at: now - 30_000,
        chain_token_cost: 0,
      },
      {
        task_id: "task:003",
        task_type: "handoff",
        caller_agent: "sync-agent",
        target_agent: "data-agent",
        causation_id: "caus:003",
        depth: 0,
        input_digest: "sha256:ghi",
        status: "failed",
        started_at: now - 20_000,
        ended_at: now - 19_000,
        heartbeat_at: now - 20_000,
        chain_token_cost: 0,
      },
    ]);

    // "admin" is caller of task:001 and target of task:002
    const rows = queryTaskList({ dbPath, sinceMs: 3_600_000, agent: "admin" });
    expect(rows.length).toBe(2);
    const ids = rows.map((r) => r.taskId);
    expect(ids).not.toContain("task:003");
  });

  it("filters by --state matching task status", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();

    const dbPath = createTestDb(dir, [
      {
        task_id: "task:001",
        task_type: "handoff",
        caller_agent: "admin",
        target_agent: "data-agent",
        causation_id: "caus:001",
        depth: 0,
        input_digest: "sha256:abc",
        status: "complete",
        started_at: now - 60_000,
        ended_at: now - 58_000,
        heartbeat_at: now - 60_000,
        chain_token_cost: 0,
      },
      {
        task_id: "task:002",
        task_type: "handoff",
        caller_agent: "sync-agent",
        target_agent: "admin",
        causation_id: "caus:002",
        depth: 0,
        input_digest: "sha256:def",
        status: "failed",
        started_at: now - 30_000,
        ended_at: now - 29_000,
        heartbeat_at: now - 30_000,
        chain_token_cost: 0,
      },
    ]);

    const rows = queryTaskList({ dbPath, sinceMs: 3_600_000, state: "failed" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.state).toBe("failed");
  });

  it("formats chain_token_cost using formatTokenCount", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();

    const dbPath = createTestDb(dir, [
      {
        task_id: "task:001",
        task_type: "handoff",
        caller_agent: "admin",
        target_agent: "data-agent",
        causation_id: "caus:001",
        depth: 0,
        input_digest: "sha256:abc",
        status: "complete",
        started_at: now - 60_000,
        ended_at: now - 58_000,
        heartbeat_at: now - 60_000,
        chain_token_cost: 45300,
      },
    ]);

    const rows = queryTaskList({ dbPath, sinceMs: 3_600_000 });
    expect(rows[0]!.cost).toBe("45.3K");
  });

  it("formats duration using formatDuration", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();

    const dbPath = createTestDb(dir, [
      {
        task_id: "task:001",
        task_type: "handoff",
        caller_agent: "admin",
        target_agent: "data-agent",
        causation_id: "caus:001",
        depth: 0,
        input_digest: "sha256:abc",
        status: "running",
        started_at: now - 60_000,
        heartbeat_at: now - 60_000,
        chain_token_cost: 0,
      },
    ]);

    const rows = queryTaskList({ dbPath, sinceMs: 3_600_000 });
    expect(rows[0]!.duration).toBe("running");
  });

  it("returns empty array when no tasks match the since window", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();

    const dbPath = createTestDb(dir, [
      {
        task_id: "task:old",
        task_type: "handoff",
        caller_agent: "admin",
        target_agent: "data-agent",
        causation_id: "caus:001",
        depth: 0,
        input_digest: "sha256:abc",
        status: "complete",
        started_at: now - 7_200_000,
        ended_at: now - 7_198_000,
        heartbeat_at: now - 7_200_000,
        chain_token_cost: 0,
      },
    ]);

    const rows = queryTaskList({ dbPath, sinceMs: 3_600_000 });
    expect(rows.length).toBe(0);
  });

  it("throws on missing DB file", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    expect(() =>
      queryTaskList({
        dbPath: join(dir, "nonexistent.db"),
        sinceMs: 3_600_000,
      }),
    ).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// formatTasksTable
// ---------------------------------------------------------------------------

describe("formatTasksTable", () => {
  const sampleRows: TaskListRow[] = [
    {
      taskId: "task:001-ab...",
      caller: "admin",
      target: "data-agent",
      state: "complete",
      duration: "2.0s",
      depth: 0,
      cost: "1.2K",
    },
    {
      taskId: "task:002-cd...",
      caller: "sync-agent",
      target: "admin",
      state: "failed",
      duration: "0.5s",
      depth: 1,
      cost: "500",
    },
    {
      taskId: "task:003-ef...",
      caller: "ops-agent",
      target: "data-agent",
      state: "running",
      duration: "running",
      depth: 0,
      cost: "0",
    },
  ];

  it("includes all column headers", () => {
    const table = formatTasksTable(sampleRows);
    expect(table).toContain("Task ID");
    expect(table).toContain("Caller");
    expect(table).toContain("Target");
    expect(table).toContain("State");
    expect(table).toContain("Duration");
    expect(table).toContain("Depth");
    expect(table).toContain("Cost");
  });

  it("color-codes complete as green", () => {
    const table = formatTasksTable(sampleRows);
    expect(table).toContain("\x1b[32m"); // GREEN
  });

  it("color-codes failed as red", () => {
    const table = formatTasksTable(sampleRows);
    expect(table).toContain("\x1b[31m"); // RED
  });

  it("color-codes running as yellow", () => {
    const table = formatTasksTable(sampleRows);
    expect(table).toContain("\x1b[33m"); // YELLOW
  });

  it("includes ANSI reset codes", () => {
    const table = formatTasksTable(sampleRows);
    expect(table).toContain("\x1b[0m");
  });

  it("returns 'No tasks found' message for empty rows", () => {
    const table = formatTasksTable([]);
    expect(table).toContain("No tasks found");
  });

  it("has separator line after header", () => {
    const table = formatTasksTable(sampleRows);
    const lines = table.split("\n");
    expect(lines[1]).toMatch(/^-+/);
  });

  it("shows depth as a number", () => {
    const table = formatTasksTable(sampleRows);
    // Depth 0 and 1 should appear in the table
    expect(table).toContain("0");
    expect(table).toContain("1");
  });
});
