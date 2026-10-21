/**
 * Phase 115 Plan 09 T04 — sub-scope 16(c) `getPhase115DashboardMetrics` tests.
 *
 * Verifies the trace-store aggregator that surfaces tier1_*, lazy_recall,
 * and prompt_bloat metrics for the dashboard panel. Asserts:
 *   - empty window → tier1_* NULL, sums = 0
 *   - latest tier1_* selects MOST-RECENT non-NULL row (not OLDEST)
 *   - SUM aggregates across multiple turns
 *   - rows OUTSIDE the agent or window are excluded
 *   - NULL-only rows in the window → tier1_* NULL, sums = 0
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { TraceStore } from "../trace-store.js";
import type { TurnRecord } from "../types.js";

let tempDir: string;
let dbPath: string;
let store: TraceStore;

function turn(overrides: Partial<TurnRecord>): TurnRecord {
  return {
    id: "turn-default",
    agent: "alpha",
    startedAt: "2026-05-08T10:00:00.000Z",
    endedAt: "2026-05-08T10:00:01.000Z",
    totalMs: 1000,
    channelId: "ch-1",
    status: "success",
    spans: [],
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "trace-store-dash-"));
  dbPath = join(tempDir, "traces.db");
  store = new TraceStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("getPhase115DashboardMetrics", () => {
  it("empty window → tier1_* NULL, sums = 0", () => {
    const r = store.getPhase115DashboardMetrics(
      "alpha",
      "2026-01-01T00:00:00.000Z",
    );
    expect(r.latestTier1InjectChars).toBeNull();
    expect(r.latestTier1BudgetPct).toBeNull();
    expect(r.lazyRecallCalls24h).toBe(0);
    expect(r.promptBloatWarnings24h).toBe(0);
  });

  it("latest tier1_* selects most-recent non-NULL row (not oldest)", () => {
    store.writeTurn(
      turn({
        id: "t-old",
        agent: "alpha",
        startedAt: "2026-05-08T08:00:00.000Z",
      }),
    );
    // Patch tier1_inject_chars/budget_pct directly via raw SQL — writeTurn
    // doesn't accept these as parameters today (the test mirrors the
    // production path where 115-02's writer issues an UPDATE on the row).
    const raw = new Database(dbPath);
    raw
      .prepare(
        `UPDATE traces SET tier1_inject_chars = ?, tier1_budget_pct = ? WHERE id = ?`,
      )
      .run(8000, 0.5, "t-old");
    raw.close();

    store.writeTurn(
      turn({
        id: "t-new",
        agent: "alpha",
        startedAt: "2026-05-08T11:00:00.000Z",
      }),
    );
    const raw2 = new Database(dbPath);
    raw2
      .prepare(
        `UPDATE traces SET tier1_inject_chars = ?, tier1_budget_pct = ? WHERE id = ?`,
      )
      .run(15500, 0.97, "t-new");
    raw2.close();

    const r = store.getPhase115DashboardMetrics(
      "alpha",
      "2026-05-08T00:00:00.000Z",
    );
    // Most-recent row is t-new (started_at later). Aggregator returns its values.
    expect(r.latestTier1InjectChars).toBe(15500);
    expect(r.latestTier1BudgetPct).toBeCloseTo(0.97, 5);
  });

  it("SUM aggregates lazy_recall + prompt_bloat across turns", () => {
    // writeTurn supports lazyRecallCallCount (camelCase) directly.
    store.writeTurn(turn({ id: "t1", lazyRecallCallCount: 3 }));
    store.writeTurn(
      turn({ id: "t2", startedAt: "2026-05-08T11:00:00.000Z", lazyRecallCallCount: 2 }),
    );
    store.writeTurn(
      turn({ id: "t3", startedAt: "2026-05-08T12:00:00.000Z", lazyRecallCallCount: 5 }),
    );

    // prompt_bloat_warnings_24h is patched via raw SQL since writeTurn
    // doesn't expose it directly today.
    const raw = new Database(dbPath);
    raw
      .prepare(`UPDATE traces SET prompt_bloat_warnings_24h = ? WHERE id = ?`)
      .run(1, "t1");
    raw
      .prepare(`UPDATE traces SET prompt_bloat_warnings_24h = ? WHERE id = ?`)
      .run(2, "t3");
    raw.close();

    const r = store.getPhase115DashboardMetrics(
      "alpha",
      "2026-05-08T00:00:00.000Z",
    );
    expect(r.lazyRecallCalls24h).toBe(10);
    expect(r.promptBloatWarnings24h).toBe(3);
  });

  it("excludes rows for OTHER agents", () => {
    store.writeTurn(
      turn({ id: "t-alpha", agent: "alpha", lazyRecallCallCount: 7 }),
    );
    store.writeTurn(
      turn({ id: "t-beta", agent: "beta", lazyRecallCallCount: 99 }),
    );

    const r = store.getPhase115DashboardMetrics(
      "alpha",
      "2026-05-08T00:00:00.000Z",
    );
    expect(r.lazyRecallCalls24h).toBe(7); // beta's 99 is excluded
  });

  it("excludes rows OUTSIDE the window (started_at < since)", () => {
    store.writeTurn(
      turn({
        id: "t-outside",
        agent: "alpha",
        startedAt: "2026-05-01T10:00:00.000Z", // before window
        lazyRecallCallCount: 100,
      }),
    );
    store.writeTurn(
      turn({
        id: "t-inside",
        agent: "alpha",
        startedAt: "2026-05-08T10:00:00.000Z",
        lazyRecallCallCount: 4,
      }),
    );
    const r = store.getPhase115DashboardMetrics(
      "alpha",
      "2026-05-08T00:00:00.000Z",
    );
    expect(r.lazyRecallCalls24h).toBe(4);
  });

  it("NULL-only rows in window → tier1_* NULL, sums = 0", () => {
    // writeTurn with no lazy_recall / prompt_bloat / tier1 fields → all NULL
    store.writeTurn(turn({ id: "t-null", agent: "alpha" }));
    const r = store.getPhase115DashboardMetrics(
      "alpha",
      "2026-05-08T00:00:00.000Z",
    );
    expect(r.latestTier1InjectChars).toBeNull();
    expect(r.latestTier1BudgetPct).toBeNull();
    expect(r.lazyRecallCalls24h).toBe(0);
    expect(r.promptBloatWarnings24h).toBe(0);
  });

  it("returns frozen object (immutability invariant)", () => {
    store.writeTurn(turn({ id: "t-freeze" }));
    const r = store.getPhase115DashboardMetrics(
      "alpha",
      "2026-05-08T00:00:00.000Z",
    );
    expect(Object.isFrozen(r)).toBe(true);
  });
});
