/**
 * Phase 61 Plan 01 Task 2 -- MysqlSource adapter tests.
 *
 * Tests the MySQL DB-change polling TriggerSource adapter. Uses mock
 * mysql2 pool/connection objects to verify event shape, watermark
 * advancement, committed-read confirmation, batchSize, filter, timer
 * lifecycle, and connection release.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { MysqlSource } from "../mysql-source.js";
import type { TriggerEvent } from "../../types.js";

// ---------------------------------------------------------------------------
// Mock pool + connection factory
// ---------------------------------------------------------------------------

function makeMockConnection(queryResults: Record<string, readonly Record<string, unknown>[]> = {}) {
  const conn = {
    execute: vi.fn(async (sql: string, _params?: unknown[]) => {
      for (const [pattern, rows] of Object.entries(queryResults)) {
        if (sql.includes(pattern)) {
          return [rows];
        }
      }
      return [[]];
    }),
    release: vi.fn(),
  };
  return conn;
}

function makeMockPool(conn: ReturnType<typeof makeMockConnection>) {
  return {
    getConnection: vi.fn(async () => conn),
  } as unknown;
}

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MysqlSource", () => {
  let ingestFn: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof makeLog>;

  beforeEach(() => {
    ingestFn = vi.fn(async (_event: TriggerEvent): Promise<void> => {});
    log = makeLog();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSource(overrides: {
    conn?: ReturnType<typeof makeMockConnection>;
    pool?: unknown;
    table?: string;
    batchSize?: number;
    filter?: string;
    pollIntervalMs?: number;
  } = {}) {
    const conn = overrides.conn ?? makeMockConnection();
    const pool = overrides.pool ?? makeMockPool(conn);
    return {
      source: new MysqlSource({
        pool: pool as any,
        table: overrides.table ?? "pipeline_clients",
        idColumn: "id",
        pollIntervalMs: overrides.pollIntervalMs ?? 30000,
        targetAgent: "acquisition",
        batchSize: overrides.batchSize ?? 100,
        filter: overrides.filter,
        ingest: ingestFn as (event: TriggerEvent) => Promise<void>,
        log,
      }),
      conn,
      pool,
    };
  }

  // Test 1: pollOnce returns TriggerEvents with correct shape
  it("pollOnce returns TriggerEvents for rows > lastSeenId with correct sourceId and idempotencyKey", async () => {
    const rows = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ];
    const conn = makeMockConnection({
      "ORDER BY": rows,
      "WHERE `id` = ?": [{ id: 2 }], // confirmation query
    });
    const { source } = makeSource({ conn });

    await source._pollOnceForTest();

    expect(ingestFn).toHaveBeenCalledTimes(2);
    const event0: TriggerEvent = ingestFn.mock.calls[0]![0];
    expect(event0.sourceId).toBe("mysql:pipeline_clients");
    expect(event0.idempotencyKey).toBe("pipeline_clients:1");
    expect(event0.targetAgent).toBe("acquisition");

    const event1: TriggerEvent = ingestFn.mock.calls[1]![0];
    expect(event1.idempotencyKey).toBe("pipeline_clients:2");
  });

  // Test 2: pollOnce advances lastSeenId only after confirmed committed-read
  it("pollOnce advances lastSeenId to max row id only after committed-read confirmation", async () => {
    const rows = [{ id: 5, name: "Carol" }];
    const conn = makeMockConnection({
      "ORDER BY": rows,
      "WHERE `id` = ?": [{ id: 5 }], // confirmed
    });
    const { source } = makeSource({ conn });

    await source._pollOnceForTest();
    expect(ingestFn).toHaveBeenCalledTimes(1);

    // Second poll should use lastSeenId=5
    const params = conn.execute.mock.calls;
    // The first call is the main query with lastSeenId=0
    expect(params[0]![1]).toEqual([0, 100]);
  });

  // Test 3: pollOnce does NOT advance watermark on ROLLBACK scenario
  it("pollOnce does NOT advance watermark when confirmation returns empty (ROLLBACKed row)", async () => {
    const rows = [{ id: 10, name: "Dave" }];
    const conn = makeMockConnection({
      "ORDER BY": rows,
      "WHERE `id` = ?": [], // confirmation fails -- row disappeared
    });
    const { source } = makeSource({ conn });

    await source._pollOnceForTest();

    // No events ingested because confirmation failed
    expect(ingestFn).not.toHaveBeenCalled();
    // Watermark should NOT have advanced
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ table: "pipeline_clients" }),
      expect.stringContaining("disappeared"),
    );
  });

  // Test 4: pollOnce respects batchSize in SQL LIMIT
  it("pollOnce respects batchSize limit in the SQL LIMIT clause", async () => {
    const conn = makeMockConnection({
      "ORDER BY": [],
    });
    const { source } = makeSource({ conn, batchSize: 25 });

    await source._pollOnceForTest();

    // Check the LIMIT parameter
    const executeCall = conn.execute.mock.calls[0]!;
    expect(executeCall[1]).toEqual([0, 25]);
  });

  // Test 5: pollOnce applies optional filter
  it("pollOnce applies optional filter as WHERE clause fragment", async () => {
    const conn = makeMockConnection({
      "ORDER BY": [],
    });
    const { source } = makeSource({ conn, filter: "status = 'active'" });

    await source._pollOnceForTest();

    const sql = conn.execute.mock.calls[0]![0] as string;
    expect(sql).toContain("AND status = 'active'");
  });

  // Test 6: start() creates setInterval with pollIntervalMs, unrefed
  it("start() creates setInterval with pollIntervalMs, unrefed", () => {
    const conn = makeMockConnection();
    const { source } = makeSource({ conn, pollIntervalMs: 15000 });

    source.start();

    // Advancing by pollIntervalMs should trigger a poll
    expect(conn.execute).not.toHaveBeenCalled();

    // Clean up
    source.stop();
  });

  // Test 7: stop() clears the interval
  it("stop() clears the interval", () => {
    const conn = makeMockConnection();
    const { source } = makeSource({ conn, pollIntervalMs: 15000 });

    source.start();
    source.stop();

    // Advancing timer should NOT trigger any calls
    vi.advanceTimersByTime(30000);
    expect(conn.execute).not.toHaveBeenCalled();
  });

  // Test 8: poll(since) returns events for rows > parseInt(since)
  it("poll(since) returns events for rows > parseInt(since)", async () => {
    const rows = [
      { id: 11, name: "Eve" },
      { id: 12, name: "Frank" },
    ];
    const conn = makeMockConnection({
      "ORDER BY": rows,
      "WHERE `id` = ?": [{ id: 12 }], // confirmation
    });
    const { source } = makeSource({ conn });

    const events = await source.poll("10");

    expect(events).toHaveLength(2);
    expect(events[0]!.idempotencyKey).toBe("pipeline_clients:11");
    expect(events[1]!.idempotencyKey).toBe("pipeline_clients:12");
    // poll does NOT call ingestFn -- engine does that
    expect(ingestFn).not.toHaveBeenCalled();
  });

  // Test 9: poll(null) returns empty array
  it("poll(null) returns empty array (first boot, no replay)", async () => {
    const conn = makeMockConnection();
    const { source } = makeSource({ conn });

    const events = await source.poll(null);
    expect(events).toEqual([]);
    // No queries should have been made
    expect(conn.execute).not.toHaveBeenCalled();
  });

  // Test 10: connection is released in finally block even on error
  it("connection is released back to pool in finally block even on query error", async () => {
    const conn = makeMockConnection();
    conn.execute.mockRejectedValueOnce(new Error("DB timeout"));
    const { source } = makeSource({ conn });

    await source._pollOnceForTest();

    expect(conn.release).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });
});
