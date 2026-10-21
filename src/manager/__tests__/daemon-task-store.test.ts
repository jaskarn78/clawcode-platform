/**
 * Phase 58 Plan 03 — daemon TaskStore wiring (LIFE-01 + LIFE-04).
 *
 * Verifies that `startDaemon` wires `TaskStore` correctly:
 *
 *   1. LIFE-01 criterion 1 — fresh-host boot creates `~/.clawcode/manager/tasks.db`
 *      with the full Phase 58 schema (tasks + trigger_state + 4 indexes).
 *   2. LIFE-04 — the startup reconciliation path is invoked BEFORE any
 *      Phase 59 delegate_task / `SessionManager.startAll` runs.
 *   3. Shutdown closes the SQLite handle.
 *   4. Plan 59 can import `taskStore` from `startDaemon`'s return value.
 *
 * The codebase pattern (see `daemon-warmup-probe.test.ts`) is to combine:
 *   (a) source-level grep on `daemon.ts` to assert the wiring is in the
 *       documented position (AFTER TurnDispatcher, BEFORE escalationBudget;
 *       reconciliation BEFORE the auto-startAll block; close BEFORE unlink),
 *   (b) a runtime assertion against a fresh TaskStore on a tmp path — this
 *       is the exact construction call `daemon.ts` runs, so the schema it
 *       produces IS the schema the daemon produces.
 *
 * The full `startDaemon` integration surface (Discord, webhooks, dashboard,
 * skills scanner, memory embedder) is not booted here — it requires a real
 * Discord token, network access, and ~30s warmup. The two approaches
 * together prove the contract without that cost.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { TaskStore } from "../../tasks/store.js";
import {
  runStartupReconciliation,
  ORPHAN_THRESHOLD_MS,
} from "../../tasks/reconciler.js";
import type { TaskRow } from "../../tasks/schema.js";

const DAEMON_SRC = readFileSync(
  new URL("../daemon.ts", import.meta.url),
  "utf-8",
);

describe("daemon.ts TaskStore wiring (source-level assertions)", () => {
  it("imports TaskStore from ../tasks/store.js", () => {
    expect(DAEMON_SRC).toMatch(
      /import\s*\{\s*TaskStore\s*\}\s*from\s*"\.\.\/tasks\/store\.js"/,
    );
  });

  it("imports runStartupReconciliation + ORPHAN_THRESHOLD_MS from ../tasks/reconciler.js", () => {
    expect(DAEMON_SRC).toMatch(
      /import\s*\{\s*[\s\S]*?runStartupReconciliation[\s\S]*?ORPHAN_THRESHOLD_MS[\s\S]*?\}\s*from\s*"\.\.\/tasks\/reconciler\.js"/,
    );
  });

  it("instantiates TaskStore once, scoped to MANAGER_DIR/tasks.db", () => {
    const matches = DAEMON_SRC.match(/new\s+TaskStore\s*\(/g) ?? [];
    expect(matches.length).toBe(1);
    expect(DAEMON_SRC).toMatch(
      /new\s+TaskStore\s*\(\s*\{\s*dbPath:\s*join\(MANAGER_DIR,\s*"tasks\.db"\)\s*,?\s*\}\s*\)/,
    );
  });

  it("places TaskStore instantiation AFTER TurnDispatcher and BEFORE escalationBudget", () => {
    const turnDispatcherIdx = DAEMON_SRC.indexOf("new TurnDispatcher(");
    const taskStoreIdx = DAEMON_SRC.indexOf("new TaskStore(");
    const escalationBudgetIdx = DAEMON_SRC.indexOf("new EscalationBudget(");
    expect(turnDispatcherIdx).toBeGreaterThan(-1);
    expect(taskStoreIdx).toBeGreaterThan(turnDispatcherIdx);
    expect(escalationBudgetIdx).toBeGreaterThan(taskStoreIdx);
  });

  it("calls runStartupReconciliation after construction and BEFORE manager.startAll", () => {
    const taskStoreIdx = DAEMON_SRC.indexOf("new TaskStore(");
    const reconcileIdx = DAEMON_SRC.indexOf("runStartupReconciliation(");
    const startAllIdx = DAEMON_SRC.indexOf("manager.startAll(");
    expect(taskStoreIdx).toBeGreaterThan(-1);
    expect(reconcileIdx).toBeGreaterThan(taskStoreIdx);
    expect(startAllIdx).toBeGreaterThan(reconcileIdx);
  });

  it("passes ORPHAN_THRESHOLD_MS + log to runStartupReconciliation", () => {
    expect(DAEMON_SRC).toMatch(
      /runStartupReconciliation\(\s*taskStore,\s*ORPHAN_THRESHOLD_MS,\s*log,?\s*\)/,
    );
  });

  it("logs a structured warn when reconciledCount > 0", () => {
    expect(DAEMON_SRC).toMatch(/reconciliation\.reconciledCount\s*>\s*0/);
    expect(DAEMON_SRC).toMatch(
      /"startup reconciliation marked stale tasks orphaned"/,
    );
  });

  it("closes TaskStore in the shutdown async function AFTER manager.stopAll AND BEFORE unlink(SOCKET_PATH)", () => {
    // Use `indexOf` to find the FIRST `await manager.stopAll();` — that one
    // lives in the shutdown async function. A later occurrence exists inside
    // `routeMethod`'s "stop-all" IPC handler and is unrelated here.
    const stopAllIdx = DAEMON_SRC.indexOf("await manager.stopAll();");
    const closeIdx = DAEMON_SRC.indexOf("taskStore.close()");
    const unlinkIdx = DAEMON_SRC.indexOf("unlink(SOCKET_PATH)");
    expect(stopAllIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(stopAllIdx);
    expect(unlinkIdx).toBeGreaterThan(closeIdx);
  });

  it("wraps taskStore.close in try/catch so shutdown keeps running on error", () => {
    // Extract a window around the close call and assert try/catch context.
    const closeIdx = DAEMON_SRC.indexOf("taskStore.close()");
    const window = DAEMON_SRC.slice(Math.max(0, closeIdx - 120), closeIdx + 200);
    expect(window).toMatch(/try\s*\{/);
    expect(window).toMatch(/catch\s*\(/);
    expect(window).toMatch(/taskStore close failed/);
  });

  it("exposes taskStore in the startDaemon Promise return type signature", () => {
    expect(DAEMON_SRC).toMatch(/taskStore:\s*TaskStore\s*;/);
  });

  it("exposes taskStore in the startDaemon return object", () => {
    expect(DAEMON_SRC).toMatch(/return\s*\{[\s\S]*?\btaskStore\b[\s\S]*?\}/);
  });
});

describe("daemon.ts TaskStore wiring (runtime schema — LIFE-01 criterion 1)", () => {
  let dir: string;
  let dbPath: string;
  let store: TaskStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "daemon-task-store-"));
    dbPath = join(dir, "tasks.db");
    // Exactly the construction call daemon.ts makes — so the schema
    // produced HERE is byte-for-byte the schema produced on daemon boot.
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

  it("creates the tasks.db file on construction (LIFE-01 criterion 1 — fresh-host boot creates the DB)", () => {
    expect(existsSync(dbPath)).toBe(true);
  });

  it("tasks table has all 15 LIFE-02 columns in order", () => {
    const inspect = new Database(dbPath, { readonly: true });
    const cols = inspect
      .prepare("PRAGMA table_info(tasks)")
      .all() as ReadonlyArray<{ readonly name: string }>;
    inspect.close();

    expect(cols.map((c) => c.name)).toEqual([
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

  it("trigger_state table has 4 columns (Phase 60 consumer)", () => {
    const inspect = new Database(dbPath, { readonly: true });
    const cols = inspect
      .prepare("PRAGMA table_info(trigger_state)")
      .all() as ReadonlyArray<{ readonly name: string }>;
    inspect.close();

    expect(cols.map((c) => c.name)).toEqual([
      "source_id",
      "last_watermark",
      "cursor_blob",
      "updated_at",
    ]);
  });

  it("has all 4 covering indexes on tasks", () => {
    const inspect = new Database(dbPath, { readonly: true });
    const rows = inspect
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_tasks_%' ORDER BY name",
      )
      .all() as ReadonlyArray<{ readonly name: string }>;
    inspect.close();

    expect(rows.map((r) => r.name)).toEqual([
      "idx_tasks_caller_target",
      "idx_tasks_causation_id",
      "idx_tasks_ended_at",
      "idx_tasks_status_heartbeat",
    ]);
  });

  it("returned TaskStore exposes the Phase 59-consumable API surface", () => {
    // Spot-check the methods Phase 59 TaskManager + Phase 60 TriggerEngine
    // consume from startDaemon's return value.
    expect(typeof store.insert).toBe("function");
    expect(typeof store.get).toBe("function");
    expect(typeof store.transition).toBe("function");
    expect(typeof store.markOrphaned).toBe("function");
    expect(typeof store.listStaleRunning).toBe("function");
    expect(typeof store.upsertTriggerState).toBe("function");
    expect(typeof store.getTriggerState).toBe("function");
    expect(typeof store.close).toBe("function");
  });
});

describe("daemon.ts TaskStore wiring (runtime reconciliation — LIFE-04)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "daemon-task-store-reboot-"));
    dbPath = join(dir, "tasks.db");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("planting a stale running row BEFORE daemon boot causes the reconciliation path to transition it to orphaned (LIFE-04)", () => {
    // First boot: create DB, plant a stale in-flight row, close.
    {
      const first = new TaskStore({ dbPath });
      const now = Date.now();
      const staleRow: TaskRow = {
        task_id: "t-stale",
        task_type: "research.brief",
        caller_agent: "fin-client",
        target_agent: "fin-res",
        causation_id: "discord:abc",
        parent_task_id: null,
        depth: 0,
        input_digest: "sha256:x",
        status: "running",
        started_at: now - 20 * 60_000,
        ended_at: null,
        heartbeat_at: now - 10 * 60_000, // 10 min old — past default threshold
        result_digest: null,
        error: null,
        chain_token_cost: 0,
      };
      first.insert(staleRow);
      first.close();
    }

    // Second boot: exact daemon.ts call pattern — construct + reconcile.
    const second = new TaskStore({ dbPath });
    const result = runStartupReconciliation(second, ORPHAN_THRESHOLD_MS);

    expect(result.reconciledCount).toBe(1);
    expect([...result.reconciledTaskIds]).toEqual(["t-stale"]);
    expect(second.get("t-stale")?.status).toBe("orphaned");
    expect(second.get("t-stale")?.ended_at).not.toBeNull();

    second.close();
  });
});
