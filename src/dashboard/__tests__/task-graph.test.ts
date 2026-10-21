/**
 * Phase 63 Plan 02 — Task graph tests.
 *
 * Tests for:
 * 1. IPC_METHODS includes "list-tasks"
 * 2. TaskGraphEdge type shape (compile-time check via satisfies)
 * 3. SQL query pattern: in-memory SQLite DB, verify in-flight + recent tasks returned,
 *    old completed tasks excluded
 * 4. Empty tasks table returns empty array
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

import { IPC_METHODS } from "../../ipc/protocol.js";
import type { TaskGraphEdge, TaskGraphData } from "../types.js";

describe("Phase 63 — Task Graph", () => {
  // ── Test 1: IPC method registered ──
  it("IPC_METHODS includes list-tasks", () => {
    expect(IPC_METHODS).toContain("list-tasks");
  });

  // ── Test 2: TaskGraphEdge shape (compile-time satisfies + runtime property check) ──
  it("TaskGraphEdge type shape matches expected fields", () => {
    const edge: TaskGraphEdge = {
      task_id: "t-001",
      caller_agent: "atlas",
      target_agent: "scout",
      status: "running",
      started_at: Date.now(),
      ended_at: null,
      chain_token_cost: 150,
    };

    // Runtime property presence check
    expect(edge).toHaveProperty("task_id");
    expect(edge).toHaveProperty("caller_agent");
    expect(edge).toHaveProperty("target_agent");
    expect(edge).toHaveProperty("status");
    expect(edge).toHaveProperty("started_at");
    expect(edge).toHaveProperty("ended_at");
    expect(edge).toHaveProperty("chain_token_cost");

    // Compile-time check: TaskGraphData wraps TaskGraphEdge[]
    const data: TaskGraphData = { tasks: [edge] };
    expect(data.tasks).toHaveLength(1);
  });

  // ── Test 3: SQL query returns in-flight + recently completed, excludes old completed ──
  it("list-tasks SQL returns in-flight and recently completed tasks, excludes old", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        task_id          TEXT PRIMARY KEY,
        task_type        TEXT NOT NULL,
        caller_agent     TEXT NOT NULL,
        target_agent     TEXT NOT NULL,
        causation_id     TEXT NOT NULL,
        parent_task_id   TEXT,
        depth            INTEGER NOT NULL,
        input_digest     TEXT NOT NULL,
        status           TEXT NOT NULL,
        started_at       INTEGER NOT NULL,
        ended_at         INTEGER,
        heartbeat_at     INTEGER NOT NULL,
        result_digest    TEXT,
        error            TEXT,
        chain_token_cost INTEGER NOT NULL DEFAULT 0
      );
    `);

    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO tasks (task_id, task_type, caller_agent, target_agent, causation_id,
        parent_task_id, depth, input_digest, status, started_at, ended_at,
        heartbeat_at, result_digest, error, chain_token_cost)
      VALUES (?, 'rpc', ?, ?, 'c-001', NULL, 0, 'digest', ?, ?, ?, ?, NULL, NULL, 100)
    `);

    // 1. In-flight running task — SHOULD be returned
    insert.run("t-running", "atlas", "scout", "running", now - 5000, null, now);

    // 2. In-flight awaiting_input task — SHOULD be returned
    insert.run("t-awaiting", "scout", "atlas", "awaiting_input", now - 3000, null, now);

    // 3. Pending task — SHOULD be returned
    insert.run("t-pending", "atlas", "dex", "pending", now - 1000, null, now);

    // 4. Recently completed task (5s ago) — SHOULD be returned (within 30s window)
    insert.run("t-recent-complete", "dex", "atlas", "complete", now - 10000, now - 5000, now);

    // 5. Old completed task (60s ago) — SHOULD NOT be returned (outside 30s window)
    insert.run("t-old-complete", "dex", "scout", "complete", now - 120000, now - 60000, now);

    // 6. Recently failed task (10s ago) — SHOULD be returned
    insert.run("t-recent-failed", "atlas", "dex", "failed", now - 15000, now - 10000, now);

    // 7. Old orphaned task (45s ago) — SHOULD NOT be returned
    insert.run("t-old-orphaned", "scout", "dex", "orphaned", now - 90000, now - 45000, now);

    const recentWindowMs = 30_000;
    const rows = db.prepare(
      `SELECT task_id, caller_agent, target_agent, status, started_at, ended_at, chain_token_cost
       FROM tasks
       WHERE status IN ('pending','running','awaiting_input')
          OR (ended_at > ? AND status IN ('complete','failed','cancelled','timed_out','orphaned'))
       ORDER BY started_at DESC`
    ).all(now - recentWindowMs) as TaskGraphEdge[];

    const ids = rows.map((r) => r.task_id);

    // In-flight tasks always returned
    expect(ids).toContain("t-running");
    expect(ids).toContain("t-awaiting");
    expect(ids).toContain("t-pending");

    // Recently completed/failed returned
    expect(ids).toContain("t-recent-complete");
    expect(ids).toContain("t-recent-failed");

    // Old completed/orphaned excluded
    expect(ids).not.toContain("t-old-complete");
    expect(ids).not.toContain("t-old-orphaned");

    // Total expected: 5
    expect(rows).toHaveLength(5);

    // Verify shape of returned rows
    for (const row of rows) {
      expect(row).toHaveProperty("task_id");
      expect(row).toHaveProperty("caller_agent");
      expect(row).toHaveProperty("target_agent");
      expect(row).toHaveProperty("status");
      expect(row).toHaveProperty("started_at");
      expect(row).toHaveProperty("chain_token_cost");
    }

    db.close();
  });

  // ── Test 4: Empty tasks table returns empty array ──
  it("empty tasks table returns empty array", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        task_id          TEXT PRIMARY KEY,
        task_type        TEXT NOT NULL,
        caller_agent     TEXT NOT NULL,
        target_agent     TEXT NOT NULL,
        causation_id     TEXT NOT NULL,
        parent_task_id   TEXT,
        depth            INTEGER NOT NULL,
        input_digest     TEXT NOT NULL,
        status           TEXT NOT NULL,
        started_at       INTEGER NOT NULL,
        ended_at         INTEGER,
        heartbeat_at     INTEGER NOT NULL,
        result_digest    TEXT,
        error            TEXT,
        chain_token_cost INTEGER NOT NULL DEFAULT 0
      );
    `);

    const now = Date.now();
    const recentWindowMs = 30_000;
    const rows = db.prepare(
      `SELECT task_id, caller_agent, target_agent, status, started_at, ended_at, chain_token_cost
       FROM tasks
       WHERE status IN ('pending','running','awaiting_input')
          OR (ended_at > ? AND status IN ('complete','failed','cancelled','timed_out','orphaned'))
       ORDER BY started_at DESC`
    ).all(now - recentWindowMs);

    expect(rows).toHaveLength(0);
    expect(rows).toEqual([]);

    db.close();
  });
});
