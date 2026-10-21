import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { TraceStore } from "../trace-store.js";
import type { TurnRecord } from "../types.js";

/**
 * Daemon-restart persistence tests for TraceStore.
 *
 * These tests close PERF-01 success criterion #4:
 *   "Traces survive daemon restart"
 *
 * The key distinction from the sibling `persists across reopen` test in
 * trace-store.test.ts is that here we open a BRAND-NEW TraceStore instance
 * on the same path, simulating the daemon boot sequence: fresh Database
 * handle, fresh prepared statement cache, fresh schema init (idempotent
 * CREATE TABLE IF NOT EXISTS).
 */

function buildTurn(overrides: Partial<TurnRecord>): TurnRecord {
  const base: TurnRecord = {
    id: overrides.id ?? "msg-1",
    agent: overrides.agent ?? "agent-x",
    channelId: overrides.channelId ?? "chan-1",
    startedAt: overrides.startedAt ?? "2026-04-13T12:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-04-13T12:00:01.000Z",
    totalMs: overrides.totalMs ?? 1000,
    status: overrides.status ?? "success",
    spans: overrides.spans ?? [],
  };
  return Object.freeze({ ...base, spans: Object.freeze([...base.spans]) });
}

describe("TraceStore daemon-restart persistence", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trace-persist-test-"));
    dbPath = join(tempDir, "traces.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists across daemon restart: writes survive when a fresh TraceStore is opened on the same path", () => {
    // 1. Open store1, write two turns (2 spans + 1 span), close.
    const store1 = new TraceStore(dbPath);
    try {
      const turnA = buildTurn({
        id: "daemon-restart-A",
        agent: "agent-x",
        spans: [
          Object.freeze({ name: "receive", startedAt: "2026-04-13T12:00:00.000Z", durationMs: 5, metadata: Object.freeze({}) }),
          Object.freeze({ name: "end_to_end", startedAt: "2026-04-13T12:00:00.010Z", durationMs: 500, metadata: Object.freeze({}) }),
        ],
      });
      const turnB = buildTurn({
        id: "daemon-restart-B",
        agent: "agent-x",
        spans: [
          Object.freeze({ name: "end_to_end", startedAt: "2026-04-13T12:01:00.000Z", durationMs: 300, metadata: Object.freeze({}) }),
        ],
      });
      store1.writeTurn(turnA);
      store1.writeTurn(turnB);
    } finally {
      store1.close();
    }

    // 2. Open store2 — SIMULATES DAEMON RESTART.
    const store2 = new TraceStore(dbPath);
    try {
      const rows = store2.getPercentiles("agent-x", new Date("2020-01-01T00:00:00.000Z").toISOString());
      const endToEnd = rows.find((r) => r.segment === "end_to_end");
      expect(endToEnd).toBeDefined();
      expect(endToEnd!.count).toBe(2);

      // 3. Raw sanity check: query the SAME file directly.
      const inspect = new Database(dbPath);
      const tracesCount = (inspect.prepare("SELECT COUNT(*) AS n FROM traces").get() as { n: number }).n;
      const spansCount = (inspect.prepare("SELECT COUNT(*) AS n FROM trace_spans").get() as { n: number }).n;
      inspect.close();
      expect(tracesCount).toBe(2);
      expect(spansCount).toBe(3); // 2 + 1
    } finally {
      store2.close();
    }
  });

  it("schema is idempotent across reopen (CREATE TABLE IF NOT EXISTS does not error)", () => {
    const store1 = new TraceStore(dbPath);
    store1.close();

    // Reopen — should NOT throw because CREATE TABLE IF NOT EXISTS is used.
    expect(() => {
      const store2 = new TraceStore(dbPath);
      store2.close();
    }).not.toThrow();

    // Third reopen for good measure.
    expect(() => {
      const store3 = new TraceStore(dbPath);
      store3.close();
    }).not.toThrow();
  });

  it("WAL checkpoint persists after close", () => {
    const store1 = new TraceStore(dbPath);
    const turn = buildTurn({
      id: "wal-persist-1",
      agent: "agent-wal",
      spans: [
        Object.freeze({ name: "end_to_end", startedAt: "2026-04-13T12:00:00.000Z", durationMs: 100, metadata: Object.freeze({}) }),
      ],
    });
    store1.writeTurn(turn);
    store1.close();

    // Directly inspect the file — data must be visible even without the WAL.
    const inspect = new Database(dbPath);
    const row = inspect.prepare("SELECT id FROM traces WHERE id = ?").get("wal-persist-1") as { readonly id: string } | undefined;
    inspect.close();
    expect(row).toBeDefined();
    expect(row!.id).toBe("wal-persist-1");
  });
});
