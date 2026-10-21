/**
 * Phase 115 Plan 00 — additive ALTER TABLE migration test.
 *
 * Asserts:
 *   1. Opening a fresh TraceStore on an empty path produces all 6 new
 *      columns visible to `PRAGMA table_info(traces)`.
 *   2. Re-opening the same path (simulating a daemon restart) is a no-op:
 *      no `duplicate column` error, column count unchanged.
 *   3. The `Phase115TurnColumns` type alias is exported.
 *
 * Why this matters: subsequent Phase 115 plans (02, 05, 07) ship producers
 * for these columns without ever re-running migration code. If this test
 * regresses, those plans break silently because the columns won't exist
 * on already-deployed traces.db files.
 *
 * Mirrors the in-memory pattern from `trace-store.test.ts` so the suite
 * runs in <100ms with no filesystem clean-up surprises.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TraceStore } from "../trace-store.js";
import type { Phase115TurnColumns } from "../trace-store.js";

const PHASE_115_COLUMNS = [
  "tier1_inject_chars",
  "tier1_budget_pct",
  "tool_cache_hit_rate",
  "tool_cache_size_mb",
  "lazy_recall_call_count",
  "prompt_bloat_warnings_24h",
  // Phase 115 Plan 08 T01 — sub-scope 17(a/b) split-latency columns.
  "tool_execution_ms",
  "tool_roundtrip_ms",
  "parallel_tool_call_count",
] as const;

describe("trace-store 115 column migration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trace-store-115-test-"));
    dbPath = join(tempDir, "traces.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("opens 6 Phase 115 column slots on a fresh traces.db", () => {
    const store = new TraceStore(dbPath);
    try {
      const inspect = new Database(dbPath, { readonly: true });
      const cols = inspect
        .prepare("PRAGMA table_info(traces)")
        .all() as ReadonlyArray<{ readonly name: string; readonly type: string }>;
      inspect.close();
      const colNames = new Set(cols.map((c) => c.name));
      for (const expected of PHASE_115_COLUMNS) {
        expect(colNames.has(expected)).toBe(true);
      }
    } finally {
      store.close();
    }
  });

  it("is idempotent — re-opening the same path does not error or duplicate columns", () => {
    // Open #1, close.
    const store1 = new TraceStore(dbPath);
    store1.close();

    // Open #2 — must NOT throw "duplicate column".
    const store2 = new TraceStore(dbPath);
    try {
      const inspect = new Database(dbPath, { readonly: true });
      const cols = inspect
        .prepare("PRAGMA table_info(traces)")
        .all() as ReadonlyArray<{ readonly name: string }>;
      inspect.close();
      // Count occurrences of each Phase 115 column. Each must appear exactly once.
      for (const expected of PHASE_115_COLUMNS) {
        const count = cols.filter((c) => c.name === expected).length;
        expect(count).toBe(1);
      }
    } finally {
      store2.close();
    }
  });

  it("uses INTEGER for the count/char columns and REAL for the rate columns", () => {
    const store = new TraceStore(dbPath);
    try {
      const inspect = new Database(dbPath, { readonly: true });
      const cols = inspect
        .prepare("PRAGMA table_info(traces)")
        .all() as ReadonlyArray<{ readonly name: string; readonly type: string }>;
      inspect.close();
      const byName = new Map(cols.map((c) => [c.name, c.type.toUpperCase()]));
      expect(byName.get("tier1_inject_chars")).toBe("INTEGER");
      expect(byName.get("tier1_budget_pct")).toBe("REAL");
      expect(byName.get("tool_cache_hit_rate")).toBe("REAL");
      expect(byName.get("tool_cache_size_mb")).toBe("REAL");
      expect(byName.get("lazy_recall_call_count")).toBe("INTEGER");
      expect(byName.get("prompt_bloat_warnings_24h")).toBe("INTEGER");
      // Phase 115 Plan 08 T01 — sub-scope 17(a/b) columns.
      expect(byName.get("tool_execution_ms")).toBe("INTEGER");
      expect(byName.get("tool_roundtrip_ms")).toBe("INTEGER");
      expect(byName.get("parallel_tool_call_count")).toBe("INTEGER");
    } finally {
      store.close();
    }
  });

  it("exports Phase115TurnColumns type alias with optional nullable fields", () => {
    // Compile-time check via type assignment. The test passes if tsc accepts
    // this assignment — runtime is just a sanity expect on the empty object.
    const allFields: Phase115TurnColumns = {
      tier1_inject_chars: 1234,
      tier1_budget_pct: 0.42,
      tool_cache_hit_rate: 0.55,
      tool_cache_size_mb: 7.5,
      lazy_recall_call_count: 3,
      prompt_bloat_warnings_24h: 0,
      // Phase 115 Plan 08 T01 — sub-scope 17(a/b) split-latency columns.
      tool_execution_ms: 150,
      tool_roundtrip_ms: 12_700,
      parallel_tool_call_count: 3,
    };
    const noFields: Phase115TurnColumns = {};
    const nullFields: Phase115TurnColumns = {
      tier1_inject_chars: null,
      tier1_budget_pct: null,
      tool_cache_hit_rate: null,
      tool_cache_size_mb: null,
      lazy_recall_call_count: null,
      prompt_bloat_warnings_24h: null,
      // Phase 115 Plan 08 T01 — sub-scope 17(a/b) split-latency columns.
      tool_execution_ms: null,
      tool_roundtrip_ms: null,
      parallel_tool_call_count: null,
    };
    expect(allFields).toBeDefined();
    expect(noFields).toBeDefined();
    expect(nullFields).toBeDefined();
  });
});
