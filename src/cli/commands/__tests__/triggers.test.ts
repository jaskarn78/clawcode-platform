/**
 * Phase 63 Plan 01 Task 1 -- CLI `clawcode triggers` tests.
 *
 * Tests pure functions: formatTokenCount, formatDuration, queryTriggerFires,
 * formatTriggersTable. Creates temp SQLite DBs with trigger_events + tasks
 * tables for end-to-end query tests.
 */

import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import {
  formatTokenCount,
  formatDuration,
  queryTriggerFires,
  formatTriggersTable,
  type TriggerFireRow,
} from "../triggers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(tmpdir(), `triggers-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a test DB with both trigger_events and tasks tables matching
 * the schema from src/tasks/store.ts.
 */
function createTestDb(
  dir: string,
  events: Array<{
    source_id: string;
    idempotency_key: string;
    created_at: number;
    source_kind?: string | null;
    payload?: string | null;
  }>,
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
    CREATE TABLE IF NOT EXISTS trigger_events (
      source_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      source_kind TEXT,
      payload TEXT,
      UNIQUE(source_id, idempotency_key)
    );

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

    CREATE INDEX IF NOT EXISTS idx_trigger_events_created_at
      ON trigger_events(created_at);
  `);

  const insertEvent = db.prepare(
    "INSERT INTO trigger_events (source_id, idempotency_key, created_at, source_kind, payload) VALUES (?, ?, ?, ?, ?)",
  );
  for (const e of events) {
    insertEvent.run(
      e.source_id,
      e.idempotency_key,
      e.created_at,
      e.source_kind ?? null,
      e.payload ?? null,
    );
  }

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
// formatTokenCount
// ---------------------------------------------------------------------------

describe("formatTokenCount", () => {
  it("returns raw number for values under 1000", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(500)).toBe("500");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("returns K suffix for values 1000-999999", () => {
    expect(formatTokenCount(1200)).toBe("1.2K");
    expect(formatTokenCount(45300)).toBe("45.3K");
    expect(formatTokenCount(1000)).toBe("1.0K");
  });

  it("returns M suffix for values >= 1000000", () => {
    expect(formatTokenCount(1200000)).toBe("1.2M");
    expect(formatTokenCount(5000000)).toBe("5.0M");
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("returns 'running' when endedAt is null", () => {
    expect(formatDuration(Date.now(), null)).toBe("running");
  });

  it("returns milliseconds for durations under 1 second", () => {
    const start = 1000000;
    expect(formatDuration(start, start + 500)).toBe("500ms");
  });

  it("returns seconds for durations under 1 minute", () => {
    const start = 1000000;
    expect(formatDuration(start, start + 1200)).toBe("1.2s");
  });

  it("returns minutes for durations >= 1 minute", () => {
    const start = 1000000;
    expect(formatDuration(start, start + 90000)).toBe("1.5m");
  });

  it("handles exact boundaries", () => {
    const start = 1000000;
    expect(formatDuration(start, start + 1000)).toBe("1.0s");
    expect(formatDuration(start, start + 60000)).toBe("1.0m");
  });
});

// ---------------------------------------------------------------------------
// queryTriggerFires
// ---------------------------------------------------------------------------

describe("queryTriggerFires", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("returns all trigger events within the since window", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();

    const dbPath = createTestDb(
      dir,
      [
        {
          source_id: "mysql:clients",
          idempotency_key: "evt-001",
          created_at: now - 60_000,
          source_kind: "mysql",
        },
        {
          source_id: "webhook:deploy",
          idempotency_key: "evt-002",
          created_at: now - 120_000,
          source_kind: "webhook",
        },
      ],
      [
        {
          task_id: "task:001",
          task_type: "handoff",
          caller_agent: "admin",
          target_agent: "data-agent",
          causation_id: "caus:001",
          depth: 0,
          input_digest: "sha256:abc",
          status: "complete",
          started_at: now - 59_500,
          ended_at: now - 58_000,
          heartbeat_at: now - 59_500,
          chain_token_cost: 1200,
        },
      ],
      );

    const rows = queryTriggerFires({
      dbPath,
      sinceMs: 3_600_000,
    });

    expect(rows.length).toBe(2);
    // Ordered by created_at DESC
    expect(rows[0]!.source).toBe("mysql:clients");
    expect(rows[1]!.source).toBe("webhook:deploy");
  });

  it("filters by --source", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();

    const dbPath = createTestDb(
      dir,
      [
        {
          source_id: "mysql:clients",
          idempotency_key: "evt-001",
          created_at: now - 60_000,
          source_kind: "mysql",
        },
        {
          source_id: "webhook:deploy",
          idempotency_key: "evt-002",
          created_at: now - 120_000,
          source_kind: "webhook",
        },
      ],
      [],
    );

    const rows = queryTriggerFires({
      dbPath,
      sinceMs: 3_600_000,
      source: "mysql:clients",
    });

    expect(rows.length).toBe(1);
    expect(rows[0]!.source).toBe("mysql:clients");
  });

  it("filters by --agent on joined task target_agent", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();

    const dbPath = createTestDb(
      dir,
      [
        {
          source_id: "mysql:clients",
          idempotency_key: "evt-001",
          created_at: now - 60_000,
          source_kind: "mysql",
        },
        {
          source_id: "webhook:deploy",
          idempotency_key: "evt-002",
          created_at: now - 120_000,
          source_kind: "webhook",
        },
      ],
      [
        {
          task_id: "task:001",
          task_type: "handoff",
          caller_agent: "admin",
          target_agent: "data-agent",
          causation_id: "caus:001",
          depth: 0,
          input_digest: "sha256:abc",
          status: "complete",
          started_at: now - 59_500,
          ended_at: now - 58_000,
          heartbeat_at: now - 59_500,
          chain_token_cost: 1200,
        },
      ],
    );

    const rows = queryTriggerFires({
      dbPath,
      sinceMs: 3_600_000,
      agent: "data-agent",
    });

    expect(rows.length).toBe(1);
    expect(rows[0]!.source).toBe("mysql:clients");
  });

  it("shows '--' for result and duration when no matching task exists", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();

    const dbPath = createTestDb(
      dir,
      [
        {
          source_id: "webhook:deploy",
          idempotency_key: "evt-001",
          created_at: now - 60_000,
          source_kind: "webhook",
        },
      ],
      [],
    );

    const rows = queryTriggerFires({
      dbPath,
      sinceMs: 3_600_000,
    });

    expect(rows.length).toBe(1);
    expect(rows[0]!.result).toBe("--");
    expect(rows[0]!.duration).toBe("--");
    expect(rows[0]!.target).toBe("--");
  });

  it("shows task status and duration when matching task exists", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();

    const dbPath = createTestDb(
      dir,
      [
        {
          source_id: "mysql:clients",
          idempotency_key: "evt-001",
          created_at: now - 60_000,
          source_kind: "mysql",
        },
      ],
      [
        {
          task_id: "task:001",
          task_type: "handoff",
          caller_agent: "admin",
          target_agent: "data-agent",
          causation_id: "caus:001",
          depth: 0,
          input_digest: "sha256:abc",
          status: "complete",
          started_at: now - 59_500,
          ended_at: now - 58_000,
          heartbeat_at: now - 59_500,
          chain_token_cost: 1200,
        },
      ],
    );

    const rows = queryTriggerFires({
      dbPath,
      sinceMs: 3_600_000,
    });

    expect(rows.length).toBe(1);
    expect(rows[0]!.result).toBe("complete");
    expect(rows[0]!.target).toBe("data-agent");
    // Duration should be human-readable (1.5s)
    expect(rows[0]!.duration).toMatch(/^\d+(\.\d+)?(ms|s|m)$/);
  });

  it("returns empty array when no events match the since window", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();

    const dbPath = createTestDb(
      dir,
      [
        {
          source_id: "old-src",
          idempotency_key: "old-evt",
          created_at: now - 7_200_000,
          source_kind: "mysql",
        },
      ],
      [],
    );

    const rows = queryTriggerFires({
      dbPath,
      sinceMs: 3_600_000,
    });

    expect(rows.length).toBe(0);
  });

  it("throws on missing DB file", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    expect(() =>
      queryTriggerFires({
        dbPath: join(dir, "nonexistent.db"),
        sinceMs: 3_600_000,
      }),
    ).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// formatTriggersTable
// ---------------------------------------------------------------------------

describe("formatTriggersTable", () => {
  const sampleRows: TriggerFireRow[] = [
    {
      timestamp: "2026-04-17T12:00:00.000Z",
      source: "mysql:clients",
      kind: "mysql",
      target: "data-agent",
      result: "complete",
      duration: "1.5s",
    },
    {
      timestamp: "2026-04-17T12:01:00.000Z",
      source: "webhook:deploy",
      kind: "webhook",
      target: "--",
      result: "failed",
      duration: "3.2s",
    },
    {
      timestamp: "2026-04-17T12:02:00.000Z",
      source: "cron:daily",
      kind: "scheduler",
      target: "sync-agent",
      result: "running",
      duration: "running",
    },
  ];

  it("includes all column headers", () => {
    const table = formatTriggersTable(sampleRows);
    expect(table).toContain("Timestamp");
    expect(table).toContain("Source");
    expect(table).toContain("Kind");
    expect(table).toContain("Target");
    expect(table).toContain("Result");
    expect(table).toContain("Duration");
  });

  it("color-codes complete as green", () => {
    const table = formatTriggersTable(sampleRows);
    expect(table).toContain("\x1b[32m"); // GREEN
  });

  it("color-codes failed as red", () => {
    const table = formatTriggersTable(sampleRows);
    expect(table).toContain("\x1b[31m"); // RED
  });

  it("color-codes running as yellow", () => {
    const table = formatTriggersTable(sampleRows);
    expect(table).toContain("\x1b[33m"); // YELLOW
  });

  it("includes ANSI reset codes", () => {
    const table = formatTriggersTable(sampleRows);
    expect(table).toContain("\x1b[0m");
  });

  it("returns empty message for no rows", () => {
    const table = formatTriggersTable([]);
    expect(table).toContain("No trigger events found");
  });

  it("has separator line after header", () => {
    const table = formatTriggersTable(sampleRows);
    const lines = table.split("\n");
    // Second line should be dashes
    expect(lines[1]).toMatch(/^-+/);
  });
});
