/**
 * Phase 115 post-deploy patch (2026-05-08) — TraceCollector
 * tier1_inject_chars + tier1_budget_pct producer tests.
 *
 * Pin the contract:
 *   - bumpTier1Size sets both columns; ratio = injectChars / capChars
 *   - When NOT called → both columns NULL (legacy compat / untraced turns)
 *   - Last-write-wins on repeat bumpTier1Size within the same turn
 *   - bumpTier1Size after end() is a no-op (post-commit guard)
 *   - capChars=0 short-circuits to NULL (defensive div-by-zero guard)
 *   - recordTier1Size on TraceCollector folds via active-turn registry
 *   - recordTier1Size with no active turn is a debug log + drop (no
 *     rolling counter — Tier 1 is a per-assembly snapshot, not a count)
 *   - Per-agent isolation — agent A's size doesn't bleed to agent B
 *
 * Mirrors the test pattern in trace-collector-lazy-recall.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { TraceStore } from "../trace-store.js";
import { TraceCollector } from "../trace-collector.js";

describe("TraceCollector — Phase 115 post-deploy patch tier1_inject_chars + tier1_budget_pct", () => {
  let store: TraceStore;
  let collector: TraceCollector;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trace-collector-tier1-"));
    dbPath = join(tempDir, "traces.db");
    store = new TraceStore(dbPath);
    const log = pino({ level: "silent" });
    collector = new TraceCollector(store, log);
  });

  afterEach(() => {
    try {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("bumpTier1Size(8000, 16000) → tier1_inject_chars=8000, tier1_budget_pct=0.5", () => {
    const turn = collector.startTurn("msg-1", "atlas", "chan-1");
    turn.bumpTier1Size(8000, 16000);
    turn.end("success");

    const row = store
      .getDatabase()
      .prepare(
        "SELECT tier1_inject_chars, tier1_budget_pct FROM traces WHERE id = 'msg-1'",
      )
      .get() as {
      tier1_inject_chars: number | null;
      tier1_budget_pct: number | null;
    };
    expect(row.tier1_inject_chars).toBe(8000);
    expect(row.tier1_budget_pct).toBeCloseTo(0.5, 5);
  });

  it("bumpTier1Size(15500, 16000) → ratio ≈ 0.97 (near-cap utilization)", () => {
    const turn = collector.startTurn("msg-2", "atlas", null);
    turn.bumpTier1Size(15500, 16000);
    turn.end("success");

    const row = store
      .getDatabase()
      .prepare(
        "SELECT tier1_inject_chars, tier1_budget_pct FROM traces WHERE id = 'msg-2'",
      )
      .get() as {
      tier1_inject_chars: number | null;
      tier1_budget_pct: number | null;
    };
    expect(row.tier1_inject_chars).toBe(15500);
    expect(row.tier1_budget_pct).toBeCloseTo(0.96875, 5);
  });

  it("bumpTier1Size(0, 16000) → tier1_inject_chars=0, tier1_budget_pct=0 (empty identity is valid)", () => {
    const turn = collector.startTurn("msg-3", "atlas", null);
    turn.bumpTier1Size(0, 16000);
    turn.end("success");

    const row = store
      .getDatabase()
      .prepare(
        "SELECT tier1_inject_chars, tier1_budget_pct FROM traces WHERE id = 'msg-3'",
      )
      .get() as {
      tier1_inject_chars: number | null;
      tier1_budget_pct: number | null;
    };
    expect(row.tier1_inject_chars).toBe(0);
    expect(row.tier1_budget_pct).toBe(0);
  });

  it("turn without bumpTier1Size → both columns NULL (legacy compat)", () => {
    const turn = collector.startTurn("msg-4", "atlas", null);
    turn.end("success");

    const row = store
      .getDatabase()
      .prepare(
        "SELECT tier1_inject_chars, tier1_budget_pct FROM traces WHERE id = 'msg-4'",
      )
      .get() as {
      tier1_inject_chars: number | null;
      tier1_budget_pct: number | null;
    };
    expect(row.tier1_inject_chars).toBeNull();
    expect(row.tier1_budget_pct).toBeNull();
  });

  it("repeat bumpTier1Size within same turn → last-write-wins", () => {
    const turn = collector.startTurn("msg-5", "atlas", null);
    turn.bumpTier1Size(8000, 16000);
    turn.bumpTier1Size(12000, 16000);
    turn.bumpTier1Size(15000, 16000);
    turn.end("success");

    const row = store
      .getDatabase()
      .prepare(
        "SELECT tier1_inject_chars, tier1_budget_pct FROM traces WHERE id = 'msg-5'",
      )
      .get() as {
      tier1_inject_chars: number | null;
      tier1_budget_pct: number | null;
    };
    expect(row.tier1_inject_chars).toBe(15000);
    expect(row.tier1_budget_pct).toBeCloseTo(0.9375, 5);
  });

  it("bumpTier1Size after end() is a no-op (post-commit guard)", () => {
    const turn = collector.startTurn("msg-6", "atlas", null);
    turn.bumpTier1Size(8000, 16000);
    turn.end("success");
    // After end — should NOT mutate the persisted row.
    turn.bumpTier1Size(15500, 16000);

    const row = store
      .getDatabase()
      .prepare(
        "SELECT tier1_inject_chars, tier1_budget_pct FROM traces WHERE id = 'msg-6'",
      )
      .get() as {
      tier1_inject_chars: number | null;
      tier1_budget_pct: number | null;
    };
    expect(row.tier1_inject_chars).toBe(8000);
    expect(row.tier1_budget_pct).toBeCloseTo(0.5, 5);
  });

  it("bumpTier1Size with capChars=0 short-circuits to NULL (defensive guard)", () => {
    const turn = collector.startTurn("msg-7", "atlas", null);
    turn.bumpTier1Size(5000, 0);
    turn.end("success");

    const row = store
      .getDatabase()
      .prepare(
        "SELECT tier1_inject_chars, tier1_budget_pct FROM traces WHERE id = 'msg-7'",
      )
      .get() as {
      tier1_inject_chars: number | null;
      tier1_budget_pct: number | null;
    };
    // Both NULL because the guard refused to set them — div-by-zero
    // protection. Production constant INJECTED_MEMORY_MAX_CHARS is 16_000
    // so this branch should never fire in real traffic.
    expect(row.tier1_inject_chars).toBeNull();
    expect(row.tier1_budget_pct).toBeNull();
  });

  it("collector.recordTier1Size folds via active-turn registry", () => {
    const turn = collector.startTurn("msg-8", "atlas", null);
    collector.recordTier1Size("atlas", 9500, 16000);
    turn.end("success");

    const row = store
      .getDatabase()
      .prepare(
        "SELECT tier1_inject_chars, tier1_budget_pct FROM traces WHERE id = 'msg-8'",
      )
      .get() as {
      tier1_inject_chars: number | null;
      tier1_budget_pct: number | null;
    };
    expect(row.tier1_inject_chars).toBe(9500);
    expect(row.tier1_budget_pct).toBeCloseTo(0.59375, 5);
  });

  it("collector.recordTier1Size with no active turn is dropped (no rolling counter)", () => {
    // No active turn — call should be silently dropped at debug level.
    collector.recordTier1Size("atlas", 8000, 16000);
    // Now start + end a turn — the previous out-of-turn call must NOT
    // surface (Tier 1 is a per-assembly snapshot, not a count).
    const turn = collector.startTurn("msg-9", "atlas", null);
    turn.end("success");

    const row = store
      .getDatabase()
      .prepare(
        "SELECT tier1_inject_chars, tier1_budget_pct FROM traces WHERE id = 'msg-9'",
      )
      .get() as {
      tier1_inject_chars: number | null;
      tier1_budget_pct: number | null;
    };
    expect(row.tier1_inject_chars).toBeNull();
    expect(row.tier1_budget_pct).toBeNull();
  });

  it("per-agent isolation — agent A size doesn't leak into agent B", () => {
    const turnA = collector.startTurn("msg-A", "agentA", null);
    const turnB = collector.startTurn("msg-B", "agentB", null);

    collector.recordTier1Size("agentA", 8000, 16000);
    collector.recordTier1Size("agentB", 14000, 16000);

    turnA.end("success");
    turnB.end("success");

    const rowA = store
      .getDatabase()
      .prepare(
        "SELECT tier1_inject_chars, tier1_budget_pct FROM traces WHERE id = 'msg-A'",
      )
      .get() as {
      tier1_inject_chars: number | null;
      tier1_budget_pct: number | null;
    };
    const rowB = store
      .getDatabase()
      .prepare(
        "SELECT tier1_inject_chars, tier1_budget_pct FROM traces WHERE id = 'msg-B'",
      )
      .get() as {
      tier1_inject_chars: number | null;
      tier1_budget_pct: number | null;
    };

    expect(rowA.tier1_inject_chars).toBe(8000);
    expect(rowA.tier1_budget_pct).toBeCloseTo(0.5, 5);
    expect(rowB.tier1_inject_chars).toBe(14000);
    expect(rowB.tier1_budget_pct).toBeCloseTo(0.875, 5);
  });

  it("dashboard read path picks up the most-recent non-NULL tier1_*", () => {
    // First turn — measure tier1
    const turn1 = collector.startTurn("msg-d1", "atlas", null);
    turn1.bumpTier1Size(7000, 16000);
    turn1.end("success");

    // Second turn — measure tier1 with new value (simulates session-restart)
    const turn2 = collector.startTurn("msg-d2", "atlas", null);
    turn2.bumpTier1Size(13000, 16000);
    turn2.end("success");

    // Dashboard read should pick up the most-recent non-NULL row
    const r = store.getPhase115DashboardMetrics(
      "atlas",
      "2020-01-01T00:00:00.000Z",
    );
    expect(r.latestTier1InjectChars).toBe(13000);
    expect(r.latestTier1BudgetPct).toBeCloseTo(0.8125, 5);
  });
});
