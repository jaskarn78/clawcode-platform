import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { TraceStore } from "../trace-store.js";
import type { TurnRecord } from "../types.js";

function buildTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  const base: TurnRecord = {
    id: overrides.id ?? "msg-1",
    agent: overrides.agent ?? "agent-x",
    channelId: overrides.channelId ?? "chan-1",
    startedAt: overrides.startedAt ?? "2026-04-13T12:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-04-13T12:00:01.000Z",
    totalMs: overrides.totalMs ?? 1000,
    status: overrides.status ?? "success",
    spans:
      overrides.spans ??
      ([
        Object.freeze({
          name: "receive",
          startedAt: "2026-04-13T12:00:00.000Z",
          durationMs: 10,
          metadata: Object.freeze({}),
        }),
      ] as const),
  };
  return Object.freeze({ ...base, spans: Object.freeze([...base.spans]) });
}

describe("TraceStore", () => {
  let store: TraceStore;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trace-store-test-"));
    dbPath = join(tempDir, "traces.db");
    store = new TraceStore(dbPath);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // ignore close errors during teardown
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates traces.db with WAL pragma and foreign_keys ON", () => {
    const inspect = new Database(dbPath);
    const journal = inspect.pragma("journal_mode", { simple: true });
    const fk = inspect.pragma("foreign_keys", { simple: true });
    inspect.close();
    expect(String(journal).toLowerCase()).toBe("wal");
    expect(Number(fk)).toBe(1);
  });

  it("initializes traces and trace_spans tables", () => {
    const inspect = new Database(dbPath);
    const rows = inspect
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as ReadonlyArray<{ readonly name: string }>;
    inspect.close();
    const tableNames = rows.map((r) => r.name);
    expect(tableNames).toContain("traces");
    expect(tableNames).toContain("trace_spans");
  });

  it("writeTurn inserts one traces row and N trace_spans rows in one transaction", () => {
    const turn = buildTurn({
      id: "msg-ins-1",
      spans: [
        Object.freeze({ name: "receive", startedAt: "2026-04-13T12:00:00.000Z", durationMs: 5, metadata: Object.freeze({}) }),
        Object.freeze({ name: "context_assemble", startedAt: "2026-04-13T12:00:00.100Z", durationMs: 8, metadata: Object.freeze({}) }),
        Object.freeze({ name: "first_token", startedAt: "2026-04-13T12:00:00.200Z", durationMs: 50, metadata: Object.freeze({}) }),
      ],
    });
    store.writeTurn(turn);

    const inspect = new Database(dbPath);
    const traceCount = (inspect.prepare("SELECT COUNT(*) AS n FROM traces").get() as { n: number }).n;
    const spanCount = (inspect.prepare("SELECT COUNT(*) AS n FROM trace_spans").get() as { n: number }).n;
    inspect.close();

    expect(traceCount).toBe(1);
    expect(spanCount).toBe(3);
  });

  it("writeTurn is idempotent on duplicate turn id (INSERT OR REPLACE)", () => {
    const turn = buildTurn({ id: "duplicate-1" });
    store.writeTurn(turn);
    store.writeTurn(turn);

    const inspect = new Database(dbPath);
    const traceCount = (inspect.prepare("SELECT COUNT(*) AS n FROM traces WHERE id = ?").get("duplicate-1") as { n: number }).n;
    inspect.close();

    expect(traceCount).toBe(1);
  });

  it("pruneOlderThan deletes expired turns", () => {
    const nowIso = new Date("2026-04-13T00:00:00.000Z").toISOString();
    const cutoffIso = new Date("2026-04-06T00:00:00.000Z").toISOString(); // 7 days ago
    const old = buildTurn({
      id: "old-turn",
      startedAt: new Date("2026-04-03T00:00:00.000Z").toISOString(), // older than 7d
      endedAt: new Date("2026-04-03T00:00:01.000Z").toISOString(),
    });
    const recent = buildTurn({
      id: "recent-turn",
      startedAt: new Date("2026-04-12T00:00:00.000Z").toISOString(),
      endedAt: new Date("2026-04-12T00:00:01.000Z").toISOString(),
    });
    store.writeTurn(old);
    store.writeTurn(recent);

    const deleted = store.pruneOlderThan(cutoffIso);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const inspect = new Database(dbPath);
    const ids = inspect.prepare("SELECT id FROM traces").all() as ReadonlyArray<{ readonly id: string }>;
    inspect.close();

    const remaining = ids.map((r) => r.id);
    expect(remaining).toContain("recent-turn");
    expect(remaining).not.toContain("old-turn");
    // sanity: reference both to keep the variable live for future assertions
    expect(nowIso).toBeTruthy();
  });

  it("cascade: pruning a turn deletes its spans", { timeout: 5000 }, () => {
    const old = buildTurn({
      id: "cascade-turn",
      startedAt: new Date("2026-04-03T00:00:00.000Z").toISOString(),
      endedAt: new Date("2026-04-03T00:00:01.000Z").toISOString(),
      spans: [
        Object.freeze({ name: "receive", startedAt: "2026-04-03T00:00:00.000Z", durationMs: 1, metadata: Object.freeze({}) }),
        Object.freeze({ name: "first_token", startedAt: "2026-04-03T00:00:00.100Z", durationMs: 5, metadata: Object.freeze({}) }),
        Object.freeze({ name: "end_to_end", startedAt: "2026-04-03T00:00:00.200Z", durationMs: 900, metadata: Object.freeze({}) }),
      ],
    });
    store.writeTurn(old);

    // Prune with a future cutoff so everything expires
    const futureCutoff = new Date("2099-01-01T00:00:00.000Z").toISOString();
    store.pruneOlderThan(futureCutoff);

    const inspect = new Database(dbPath);
    const spanCount = (inspect.prepare("SELECT COUNT(*) AS n FROM trace_spans").get() as { n: number }).n;
    inspect.close();
    expect(spanCount).toBe(0);
  });

  it("persists across reopen", () => {
    const turn = buildTurn({ id: "persists-1", agent: "agent-p" });
    store.writeTurn(turn);
    store.close();

    const reopened = new TraceStore(dbPath);
    try {
      const inspect = new Database(dbPath);
      const count = (inspect.prepare("SELECT COUNT(*) AS n FROM traces WHERE id = ?").get("persists-1") as { n: number }).n;
      inspect.close();
      expect(count).toBe(1);
    } finally {
      reopened.close();
    }

    // Re-assign `store` so the afterEach close() is a no-op-safe.
    store = new TraceStore(dbPath);
  });

  it("getPercentiles returns p50/p95/p99/count rows for each canonical segment", () => {
    // Insert 100 synthetic turns with known duration_ms distribution in end_to_end spans.
    const nowMs = new Date("2026-04-13T00:00:00.000Z").getTime();
    for (let i = 1; i <= 100; i++) {
      const turn = buildTurn({
        id: `syn-${i}`,
        agent: "agent-perc",
        startedAt: new Date(nowMs + i).toISOString(),
        endedAt: new Date(nowMs + i + 1).toISOString(),
        totalMs: i,
        spans: [
          Object.freeze({
            name: "end_to_end",
            startedAt: new Date(nowMs + i).toISOString(),
            durationMs: i,
            metadata: Object.freeze({}),
          }),
        ],
      });
      store.writeTurn(turn);
    }

    const rows = store.getPercentiles("agent-perc", new Date(nowMs - 1000).toISOString());
    expect(Array.isArray(rows)).toBe(true);
    const endToEnd = rows.find((r) => r.segment === "end_to_end");
    expect(endToEnd).toBeDefined();
    // shape assertions
    expect(typeof endToEnd!.count).toBe("number");
    expect("p50" in endToEnd!).toBe(true);
    expect("p95" in endToEnd!).toBe(true);
    expect("p99" in endToEnd!).toBe(true);
  });

  it("getPercentiles returns 6 rows (one per canonical segment — Phase 54)", () => {
    // No data inserted — every row should be count=0 / null p-values.
    const rows = store.getPercentiles(
      "empty-agent",
      "2026-04-01T00:00:00.000Z",
    );
    expect(rows).toHaveLength(6);
    const segments = rows.map((r) => r.segment);
    expect(segments).toEqual([
      "end_to_end",
      "first_token",
      "first_visible_token",
      "context_assemble",
      "tool_call",
      "typing_indicator",
    ]);
    for (const row of rows) {
      expect(row.count).toBe(0);
      expect(row.p50).toBeNull();
      expect(row.p95).toBeNull();
      expect(row.p99).toBeNull();
    }
  });

  it("getFirstTokenPercentiles returns the first_token row when data exists", () => {
    const nowMs = new Date("2026-04-13T00:00:00.000Z").getTime();
    for (let i = 1; i <= 20; i++) {
      const turn = buildTurn({
        id: `ftp-${i}`,
        agent: "ft-agent",
        startedAt: new Date(nowMs + i).toISOString(),
        endedAt: new Date(nowMs + i + 1).toISOString(),
        totalMs: i,
        spans: [
          Object.freeze({
            name: "first_token",
            startedAt: new Date(nowMs + i).toISOString(),
            durationMs: i * 10,
            metadata: Object.freeze({}),
          }),
        ],
      });
      store.writeTurn(turn);
    }
    const row = store.getFirstTokenPercentiles(
      "ft-agent",
      new Date(nowMs - 1000).toISOString(),
    );
    expect(row.segment).toBe("first_token");
    expect(row.count).toBe(20);
    expect(typeof row.p50).toBe("number");
    expect(typeof row.p95).toBe("number");
    expect(typeof row.p99).toBe("number");
  });

  it("getFirstTokenPercentiles returns a count=0 / null-p-value row when window is empty", () => {
    const row = store.getFirstTokenPercentiles(
      "no-ft-agent",
      "2026-04-01T00:00:00.000Z",
    );
    expect(row).toEqual({
      segment: "first_token",
      p50: null,
      p95: null,
      p99: null,
      count: 0,
    });
    expect(Object.isFrozen(row)).toBe(true);
  });

  it("getToolPercentiles returns [] (empty array, not error) when window is empty", () => {
    const result = store.getToolPercentiles(
      "no-tools-agent",
      "2026-04-01T00:00:00.000Z",
    );
    expect(result).toEqual([]);
    expect(Array.isArray(result)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("getToolPercentiles aggregates tool_call.* spans, sorted by p95 DESC", () => {
    // 3 memory_lookup spans (100ms/200ms/300ms) + 2 search_documents (50/150ms).
    // memory_lookup should rank first (higher p95 ≈ 300), search_documents second.
    const nowMs = new Date("2026-04-13T00:00:00.000Z").getTime();
    const memLookupDurations = [100, 200, 300];
    const searchDurations = [50, 150];

    memLookupDurations.forEach((d, i) => {
      const ts = new Date(nowMs + i).toISOString();
      const turn = buildTurn({
        id: `ml-${i}`,
        agent: "tool-agent",
        startedAt: ts,
        endedAt: ts,
        totalMs: d,
        spans: [
          Object.freeze({
            name: "tool_call.memory_lookup",
            startedAt: ts,
            durationMs: d,
            metadata: Object.freeze({}),
          }),
        ],
      });
      store.writeTurn(turn);
    });
    searchDurations.forEach((d, i) => {
      const ts = new Date(nowMs + 1000 + i).toISOString();
      const turn = buildTurn({
        id: `sd-${i}`,
        agent: "tool-agent",
        startedAt: ts,
        endedAt: ts,
        totalMs: d,
        spans: [
          Object.freeze({
            name: "tool_call.search_documents",
            startedAt: ts,
            durationMs: d,
            metadata: Object.freeze({}),
          }),
        ],
      });
      store.writeTurn(turn);
    });

    const rows = store.getToolPercentiles(
      "tool-agent",
      new Date(nowMs - 1000).toISOString(),
    );
    expect(rows).toHaveLength(2);
    // memory_lookup has p95 of 300 (highest rank); search_documents has p95 of 150.
    // Sorted by p95 DESC means memory_lookup comes first.
    expect(rows[0]!.tool_name).toBe("memory_lookup");
    expect(rows[1]!.tool_name).toBe("search_documents");
    // Counts match insertion.
    expect(rows[0]!.count).toBe(3);
    expect(rows[1]!.count).toBe(2);
  });

  it("getToolPercentiles row shape: tool_name, p50, p95, p99, count — all frozen", () => {
    const nowMs = new Date("2026-04-13T00:00:00.000Z").getTime();
    const ts = new Date(nowMs).toISOString();
    const turn = buildTurn({
      id: "shape-turn",
      agent: "shape-agent",
      startedAt: ts,
      endedAt: ts,
      totalMs: 100,
      spans: [
        Object.freeze({
          name: "tool_call.memory_lookup",
          startedAt: ts,
          durationMs: 100,
          metadata: Object.freeze({}),
        }),
      ],
    });
    store.writeTurn(turn);

    const rows = store.getToolPercentiles(
      "shape-agent",
      new Date(nowMs - 1000).toISOString(),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Shape: required keys present.
    expect(row).toHaveProperty("tool_name");
    expect(row).toHaveProperty("p50");
    expect(row).toHaveProperty("p95");
    expect(row).toHaveProperty("p99");
    expect(row).toHaveProperty("count");
    expect(typeof row.tool_name).toBe("string");
    expect(typeof row.count).toBe("number");
    // Row is frozen.
    expect(Object.isFrozen(row)).toBe(true);
  });

  it("getToolPercentiles excludes spans NOT prefixed with 'tool_call.'", () => {
    // Insert a turn with end_to_end + first_token + tool_call.memory_lookup spans.
    // Only tool_call.* spans should appear in the result — the other segments
    // are the canonical latency segments and belong to getPercentiles.
    const nowMs = new Date("2026-04-13T00:00:00.000Z").getTime();
    const ts = new Date(nowMs).toISOString();
    const turn = buildTurn({
      id: "mix-turn",
      agent: "mix-agent",
      startedAt: ts,
      endedAt: ts,
      totalMs: 500,
      spans: [
        Object.freeze({
          name: "end_to_end",
          startedAt: ts,
          durationMs: 500,
          metadata: Object.freeze({}),
        }),
        Object.freeze({
          name: "first_token",
          startedAt: ts,
          durationMs: 50,
          metadata: Object.freeze({}),
        }),
        Object.freeze({
          name: "context_assemble",
          startedAt: ts,
          durationMs: 20,
          metadata: Object.freeze({}),
        }),
        Object.freeze({
          name: "tool_call.memory_lookup",
          startedAt: ts,
          durationMs: 100,
          metadata: Object.freeze({}),
        }),
      ],
    });
    store.writeTurn(turn);

    const rows = store.getToolPercentiles(
      "mix-agent",
      new Date(nowMs - 1000).toISOString(),
    );
    // Only the memory_lookup tool_call should appear.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_name).toBe("memory_lookup");
    // Explicitly: non-tool_call segments MUST NOT leak into the result.
    const names = rows.map((r) => r.tool_name);
    expect(names).not.toContain("end_to_end");
    expect(names).not.toContain("first_token");
    expect(names).not.toContain("context_assemble");
  });

  it("getToolPercentiles extracts tool_name correctly (SUBSTR strips the 'tool_call.' prefix)", () => {
    // Span name is `tool_call.memory_lookup` — after SUBSTR(name, 11) the
    // result row should have tool_name === "memory_lookup" (NOT the full
    // prefixed span name).
    const nowMs = new Date("2026-04-13T00:00:00.000Z").getTime();
    const ts = new Date(nowMs).toISOString();
    const turn = buildTurn({
      id: "name-turn",
      agent: "name-agent",
      startedAt: ts,
      endedAt: ts,
      totalMs: 100,
      spans: [
        Object.freeze({
          name: "tool_call.memory_lookup",
          startedAt: ts,
          durationMs: 100,
          metadata: Object.freeze({}),
        }),
      ],
    });
    store.writeTurn(turn);

    const rows = store.getToolPercentiles(
      "name-agent",
      new Date(nowMs - 1000).toISOString(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_name).toBe("memory_lookup");
    expect(rows[0]!.tool_name).not.toBe("tool_call.memory_lookup");
  });
});

describe("TraceStore cache telemetry (Phase 52)", () => {
  let store: TraceStore;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trace-store-cache-test-"));
    dbPath = join(tempDir, "traces.db");
    store = new TraceStore(dbPath);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // ignore close errors during teardown
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("ALTER TABLE migration is idempotent across repeated constructions", () => {
    // First construction already happened in beforeEach. Closing and re-opening
    // must not throw on duplicate-column errors.
    store.close();

    // Second construction on the same path — migrateSchema should be idempotent.
    expect(() => {
      store = new TraceStore(dbPath);
    }).not.toThrow();

    // And a third reopens — still no issue.
    store.close();
    expect(() => {
      store = new TraceStore(dbPath);
    }).not.toThrow();
  });

  it("writeTurn persists cache_read_input_tokens, cache_creation_input_tokens, input_tokens, prefix_hash, cache_eviction_expected", () => {
    const turn: TurnRecord = Object.freeze({
      id: "cache-turn-1",
      agent: "agent-cache",
      channelId: "chan-1",
      startedAt: "2026-04-13T12:00:00.000Z",
      endedAt: "2026-04-13T12:00:01.000Z",
      totalMs: 1000,
      status: "success",
      spans: Object.freeze([]),
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 100,
      inputTokens: 50,
      prefixHash: "abc123def",
      cacheEvictionExpected: true,
    });
    store.writeTurn(turn);

    const inspect = new Database(dbPath);
    const row = inspect
      .prepare(
        "SELECT cache_read_input_tokens, cache_creation_input_tokens, input_tokens, prefix_hash, cache_eviction_expected FROM traces WHERE id = ?",
      )
      .get("cache-turn-1") as {
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
        input_tokens: number;
        prefix_hash: string;
        cache_eviction_expected: number;
      };
    inspect.close();

    expect(row.cache_read_input_tokens).toBe(500);
    expect(row.cache_creation_input_tokens).toBe(100);
    expect(row.input_tokens).toBe(50);
    expect(row.prefix_hash).toBe("abc123def");
    expect(row.cache_eviction_expected).toBe(1);
  });

  it("writeTurn persists turns WITHOUT cache fields (backward compat with Phase 50 turns)", () => {
    // TurnRecord without any cache fields — should land NULLs in the new columns.
    const turn = buildTurn({ id: "legacy-turn-1" });
    store.writeTurn(turn);

    const inspect = new Database(dbPath);
    const row = inspect
      .prepare(
        "SELECT cache_read_input_tokens, cache_creation_input_tokens, input_tokens, prefix_hash, cache_eviction_expected FROM traces WHERE id = ?",
      )
      .get("legacy-turn-1") as {
        cache_read_input_tokens: number | null;
        cache_creation_input_tokens: number | null;
        input_tokens: number | null;
        prefix_hash: string | null;
        cache_eviction_expected: number | null;
      };
    inspect.close();

    expect(row.cache_read_input_tokens).toBeNull();
    expect(row.cache_creation_input_tokens).toBeNull();
    expect(row.input_tokens).toBeNull();
    expect(row.prefix_hash).toBeNull();
    expect(row.cache_eviction_expected).toBeNull();
  });

  it("getCacheTelemetry returns totalTurns / avgHitRate / p50HitRate / p95HitRate / trendByDay for the window", () => {
    // Insert 10 turns across 3 days with varying cache ratios.
    // Day 1 (2026-04-10): 3 turns, hit rates ~0.80, 0.85, 0.90
    // Day 2 (2026-04-11): 4 turns, hit rates ~0.50, 0.55, 0.60, 0.65
    // Day 3 (2026-04-12): 3 turns, hit rates ~0.10, 0.20, 0.30
    const turns = [
      // Day 1: high cache hit rate
      { id: "d1-1", day: "2026-04-10T10:00:00.000Z", read: 800, creation: 150, input: 50 }, // 800/1000 = 0.80
      { id: "d1-2", day: "2026-04-10T11:00:00.000Z", read: 850, creation: 100, input: 50 }, // 0.85
      { id: "d1-3", day: "2026-04-10T12:00:00.000Z", read: 900, creation: 60, input: 40 },  // 0.90
      // Day 2: medium
      { id: "d2-1", day: "2026-04-11T10:00:00.000Z", read: 500, creation: 400, input: 100 }, // 0.50
      { id: "d2-2", day: "2026-04-11T11:00:00.000Z", read: 550, creation: 350, input: 100 }, // 0.55
      { id: "d2-3", day: "2026-04-11T12:00:00.000Z", read: 600, creation: 300, input: 100 }, // 0.60
      { id: "d2-4", day: "2026-04-11T13:00:00.000Z", read: 650, creation: 250, input: 100 }, // 0.65
      // Day 3: low
      { id: "d3-1", day: "2026-04-12T10:00:00.000Z", read: 100, creation: 800, input: 100 }, // 0.10
      { id: "d3-2", day: "2026-04-12T11:00:00.000Z", read: 200, creation: 700, input: 100 }, // 0.20
      { id: "d3-3", day: "2026-04-12T12:00:00.000Z", read: 300, creation: 600, input: 100 }, // 0.30
    ];
    for (const t of turns) {
      const turn: TurnRecord = Object.freeze({
        id: t.id,
        agent: "cache-agent",
        channelId: "c1",
        startedAt: t.day,
        endedAt: t.day,
        totalMs: 100,
        status: "success",
        spans: Object.freeze([]),
        cacheReadInputTokens: t.read,
        cacheCreationInputTokens: t.creation,
        inputTokens: t.input,
      });
      store.writeTurn(turn);
    }

    const report = store.getCacheTelemetry("cache-agent", "2026-04-01T00:00:00.000Z");

    expect(report.totalTurns).toBe(10);
    // Expected avg hit rate across all 10:
    // (0.80 + 0.85 + 0.90 + 0.50 + 0.55 + 0.60 + 0.65 + 0.10 + 0.20 + 0.30) / 10 = 0.545
    expect(report.avgHitRate).toBeGreaterThanOrEqual(0.54);
    expect(report.avgHitRate).toBeLessThanOrEqual(0.55);
    expect(typeof report.p50HitRate).toBe("number");
    expect(typeof report.p95HitRate).toBe("number");
    expect(report.trendByDay).toHaveLength(3);
    expect(report.trendByDay[0]).toHaveProperty("date");
    expect(report.trendByDay[0]).toHaveProperty("turns");
    expect(report.trendByDay[0]).toHaveProperty("hitRate");
    // Date format YYYY-MM-DD
    expect(report.trendByDay[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("getCacheTelemetry returns zeros and empty trend when no turns in window", () => {
    const report = store.getCacheTelemetry("no-turns-agent", "2026-04-01T00:00:00.000Z");
    expect(report).toEqual({
      agent: "no-turns-agent",
      since: "2026-04-01T00:00:00.000Z",
      totalTurns: 0,
      avgHitRate: 0,
      p50HitRate: 0,
      p95HitRate: 0,
      totalCacheReads: 0,
      totalCacheWrites: 0,
      totalInputTokens: 0,
      trendByDay: [],
    });
  });

  it("getCacheTelemetry populates totalCacheReads / totalCacheWrites / totalInputTokens aggregates", () => {
    // 3 turns with cache_read=100/200/300, cache_creation=50/50/50, input=10/10/10
    const values = [
      { id: "a-1", read: 100, creation: 50, input: 10 },
      { id: "a-2", read: 200, creation: 50, input: 10 },
      { id: "a-3", read: 300, creation: 50, input: 10 },
    ];
    for (const v of values) {
      const turn: TurnRecord = Object.freeze({
        id: v.id,
        agent: "agg-agent",
        channelId: null,
        startedAt: "2026-04-13T10:00:00.000Z",
        endedAt: "2026-04-13T10:00:01.000Z",
        totalMs: 100,
        status: "success",
        spans: Object.freeze([]),
        cacheReadInputTokens: v.read,
        cacheCreationInputTokens: v.creation,
        inputTokens: v.input,
      });
      store.writeTurn(turn);
    }

    const report = store.getCacheTelemetry("agg-agent", "2026-04-01T00:00:00.000Z");
    expect(report.totalCacheReads).toBe(600);
    expect(report.totalCacheWrites).toBe(150);
    expect(report.totalInputTokens).toBe(30);
  });

  it("getCacheTelemetry skips turns with inputTokens=0 (no cache signal)", () => {
    // 5 turns — 3 with real input_tokens > 0, 2 with 0. Only the 3 with > 0 should count.
    const values = [
      { id: "s-1", read: 100, creation: 50, input: 10 },
      { id: "s-2", read: 200, creation: 50, input: 20 },
      { id: "s-3", read: 300, creation: 50, input: 30 },
      { id: "s-4", read: 0, creation: 0, input: 0 }, // no signal
      { id: "s-5", read: 0, creation: 0, input: 0 }, // no signal
    ];
    for (const v of values) {
      const turn: TurnRecord = Object.freeze({
        id: v.id,
        agent: "skip-agent",
        channelId: null,
        startedAt: "2026-04-13T10:00:00.000Z",
        endedAt: "2026-04-13T10:00:01.000Z",
        totalMs: 100,
        status: "success",
        spans: Object.freeze([]),
        cacheReadInputTokens: v.read,
        cacheCreationInputTokens: v.creation,
        inputTokens: v.input,
      });
      store.writeTurn(turn);
    }

    const report = store.getCacheTelemetry("skip-agent", "2026-04-01T00:00:00.000Z");
    expect(report.totalTurns).toBe(3);
  });
});
