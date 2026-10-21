/**
 * Phase 72 — UsageTracker schema-migration + image-category tests.
 *
 * The pre-Phase-72 tests live in src/usage/tracker.test.ts and cover
 * token-recording basics. These tests pin the new behavior:
 *  - Idempotent ALTER TABLE migration on construction.
 *  - record() accepts optional category/backend/count.
 *  - Pre-Phase-72 rows roll up correctly into 'tokens' bucket.
 *  - New getCostsByCategory helper aggregates by category.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UsageTracker } from "../tracker.js";

describe("UsageTracker — Phase 72 schema migration + image category", () => {
  let dbPath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "usage-72-"));
    dbPath = join(tempDir, "usage.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("U1: pre-Phase-72 DB auto-migrates on construction (ALTER TABLE adds 3 columns)", () => {
    // Bootstrap a legacy DB without the new columns.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE usage_events (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        session_id TEXT NOT NULL
      )
    `);
    legacy.prepare(
      `INSERT INTO usage_events (id, agent, timestamp, tokens_in, tokens_out, cost_usd, turns, model, duration_ms, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("legacy-1", "agent-x", "2026-04-01T10:00:00Z", 100, 200, 0.05, 1, "sonnet", 3000, "sess-legacy");
    legacy.close();

    // Construct UsageTracker — should auto-migrate.
    const tracker = new UsageTracker(dbPath);

    // New record() with image fields must work without error.
    expect(() =>
      tracker.record({
        agent: "agent-y",
        timestamp: "2026-04-19T10:00:00Z",
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0.04,
        turns: 0,
        model: "openai:gpt-image-1",
        duration_ms: 0,
        session_id: "sess-image",
        category: "image",
        backend: "openai",
        count: 1,
      }),
    ).not.toThrow();

    tracker.close();
  });

  it("U2: image record() round-trips through getCostsByAgentModel with category exposed", () => {
    const tracker = new UsageTracker(dbPath);
    tracker.record({
      agent: "clawdy",
      timestamp: "2026-04-19T10:00:00Z",
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0.08,
      turns: 0,
      model: "openai:gpt-image-1",
      duration_ms: 0,
      session_id: "sess-1",
      category: "image",
      backend: "openai",
      count: 2,
    });
    const rows = tracker.getCostsByAgentModel(
      "2026-04-19T00:00:00Z",
      "2026-04-20T00:00:00Z",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe("clawdy");
    expect(rows[0].model).toBe("openai:gpt-image-1");
    expect(rows[0].category).toBe("image");
    expect(rows[0].cost_usd).toBeCloseTo(0.08);
    tracker.close();
  });

  it("U3: legacy rows (record() without category) appear with category=null in DB", () => {
    const tracker = new UsageTracker(dbPath);
    tracker.record({
      agent: "clawdy",
      timestamp: "2026-04-19T10:00:00Z",
      tokens_in: 100,
      tokens_out: 200,
      cost_usd: 0.05,
      turns: 1,
      model: "sonnet",
      duration_ms: 3000,
      session_id: "sess-tokens",
    });
    const rows = tracker.getCostsByAgentModel(
      "2026-04-19T00:00:00Z",
      "2026-04-20T00:00:00Z",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBeNull();
    tracker.close();
  });

  it("U4: getCostsByCategory aggregates token+image rows separately, NULL → 'tokens'", () => {
    const tracker = new UsageTracker(dbPath);
    tracker.record({
      agent: "a",
      timestamp: "2026-04-19T10:00:00Z",
      tokens_in: 100,
      tokens_out: 200,
      cost_usd: 0.10,
      turns: 1,
      model: "sonnet",
      duration_ms: 1000,
      session_id: "sess-1",
    });
    tracker.record({
      agent: "a",
      timestamp: "2026-04-19T10:05:00Z",
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0.04,
      turns: 0,
      model: "openai:gpt-image-1",
      duration_ms: 0,
      session_id: "sess-2",
      category: "image",
      backend: "openai",
      count: 1,
    });
    tracker.record({
      agent: "a",
      timestamp: "2026-04-19T10:06:00Z",
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0.05,
      turns: 0,
      model: "fal:fal-ai/flux-pro",
      duration_ms: 0,
      session_id: "sess-3",
      category: "image",
      backend: "fal",
      count: 1,
    });

    const rows = tracker.getCostsByCategory(
      "2026-04-19T00:00:00Z",
      "2026-04-20T00:00:00Z",
    );
    expect(rows).toHaveLength(2);
    const byCat: Record<string, number> = {};
    rows.forEach((r) => (byCat[r.category] = r.cost_usd));
    expect(byCat.tokens).toBeCloseTo(0.10);
    expect(byCat.image).toBeCloseTo(0.09); // 0.04 + 0.05
    tracker.close();
  });

  it("U5: ALTER TABLE migration is idempotent — re-constructing on same DB does not throw", () => {
    const t1 = new UsageTracker(dbPath);
    t1.record({
      agent: "a",
      timestamp: "2026-04-19T10:00:00Z",
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0.04,
      turns: 0,
      model: "openai:gpt-image-1",
      duration_ms: 0,
      session_id: "sess-1",
      category: "image",
      backend: "openai",
      count: 1,
    });
    t1.close();
    // Second construction must NOT throw "duplicate column".
    expect(() => {
      const t2 = new UsageTracker(dbPath);
      t2.close();
    }).not.toThrow();
  });

  it("getCostsByCategory returns empty array when no events match", () => {
    const tracker = new UsageTracker(dbPath);
    const rows = tracker.getCostsByCategory(
      "2026-04-19T00:00:00Z",
      "2026-04-20T00:00:00Z",
    );
    expect(rows).toEqual([]);
    tracker.close();
  });

  it("frozen rows on getCostsByCategory", () => {
    const tracker = new UsageTracker(dbPath);
    tracker.record({
      agent: "a",
      timestamp: "2026-04-19T10:00:00Z",
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0.04,
      turns: 0,
      model: "openai:gpt-image-1",
      duration_ms: 0,
      session_id: "sess-1",
      category: "image",
      backend: "openai",
      count: 1,
    });
    const rows = tracker.getCostsByCategory(
      "2026-04-19T00:00:00Z",
      "2026-04-20T00:00:00Z",
    );
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
    tracker.close();
  });
});

describe("UsageTracker.getUsageInRange — Quick 260611-h50", () => {
  let dbPath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "usage-h50-"));
    dbPath = join(tempDir, "usage.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("sums exactly the rows inside the half-open [start, end) Pacific-day window", () => {
    const tracker = new UsageTracker(dbPath);

    // Four events around a Pacific-day boundary (07:00:00Z = PDT midnight).
    // Two are inside the window, two are outside.
    const events: ReadonlyArray<{ timestamp: string; in: number; out: number }> = [
      { timestamp: "2026-06-10T06:59:59Z", in: 100, out: 10 }, // before start → out
      { timestamp: "2026-06-10T07:00:00Z", in: 200, out: 20 }, // == start → IN (inclusive)
      { timestamp: "2026-06-11T06:59:59Z", in: 400, out: 40 }, // before end → IN
      { timestamp: "2026-06-11T07:00:01Z", in: 800, out: 80 }, // after end → out
    ];
    for (const e of events) {
      tracker.record({
        agent: "clawdy",
        timestamp: e.timestamp,
        tokens_in: e.in,
        tokens_out: e.out,
        cost_usd: 0.01,
        turns: 1,
        model: "opus",
        duration_ms: 1000,
        session_id: "sess-range",
      });
    }

    const agg = tracker.getUsageInRange(
      "2026-06-10T07:00:00.000Z",
      "2026-06-11T07:00:00.000Z",
    );

    // Only the two in-window rows (200/20 + 400/40) count.
    expect(agg.tokens_in).toBe(600);
    expect(agg.tokens_out).toBe(40 + 20);
    expect(agg.event_count).toBe(2);
    expect(agg.turns).toBe(2);

    tracker.close();
  });

  it("returns the zero aggregate when no rows fall in range", () => {
    const tracker = new UsageTracker(dbPath);
    tracker.record({
      agent: "clawdy",
      timestamp: "2026-01-01T00:00:00Z",
      tokens_in: 5,
      tokens_out: 5,
      cost_usd: 0,
      turns: 1,
      model: "opus",
      duration_ms: 0,
      session_id: "sess-empty",
    });

    const agg = tracker.getUsageInRange(
      "2026-06-10T07:00:00.000Z",
      "2026-06-11T07:00:00.000Z",
    );
    expect(agg.tokens_in).toBe(0);
    expect(agg.tokens_out).toBe(0);
    expect(agg.event_count).toBe(0);
    expect(Object.isFrozen(agg)).toBe(true);

    tracker.close();
  });
});
