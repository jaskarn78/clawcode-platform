/**
 * Phase 115 Plan 08 T02 — sub-scope 6-A measurement gate test.
 *
 * The gate value: per-agent rolling `tool_use_rate_per_turn` over a
 * configurable window (24h default), used by plan 115-09 to decide
 * whether to SHIP sub-scope 6-B (1h-TTL direct-SDK fast-path) or DEFER.
 *
 * Threshold per CONTEXT D-12: <30% across non-fin-client agents → SHIP.
 *
 * This test pins the math against a real on-disk SQLite traces.db so
 * the SQL query semantics + window-bound + per-agent isolation are all
 * exercised.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TraceStore } from "../trace-store.js";
import type { ToolUseRateSnapshot } from "../trace-store.js";

const HOUR_MS = 3_600_000;

/**
 * Helper: directly insert a turn row with the parallel_tool_call_count
 * column set, bypassing the writeTurn path (which requires assembling a
 * full TurnRecord). This is the test-fixture path.
 *
 * Caller passes an open Database connection so a batch of inserts in
 * one test only pays the SQLite open cost once. Each test owns the
 * connection lifecycle (open in arrange, close before reading via the
 * TraceStore re-open).
 */
function insertTurnInto(
  db: Database.Database,
  agent: string,
  startedAtMs: number,
  parallelToolCallCount: number | null,
  uniqueSuffix: string = "",
): void {
  const startedAtIso = new Date(startedAtMs).toISOString();
  const endedAtIso = new Date(startedAtMs + 100).toISOString();
  db.prepare(
    `INSERT INTO traces
      (id, agent, started_at, ended_at, total_ms, status, parallel_tool_call_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `t-${agent}-${startedAtMs}-${uniqueSuffix}`,
    agent,
    startedAtIso,
    endedAtIso,
    100,
    "success",
    parallelToolCallCount,
  );
}

// Per-test timeout: SQLite open / migration is ~150-300ms each, and the
// test creates 2-3 separate connections per test (TraceStore bootstrap +
// writer + read-back). Default 5s vitest timeout is tight when CI is
// running parallel test files; bump to 30s to absorb worst-case load.
describe("Phase 115 Plan 08 T02 — computeToolUseRatePerTurn", { timeout: 30_000 }, () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tool-use-rate-test-"));
    dbPath = join(tempDir, "traces.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns rate=0 on empty traces.db (no signal)", () => {
    const store = new TraceStore(dbPath);
    try {
      const sinceIso = new Date(Date.now() - 24 * HOUR_MS).toISOString();
      const snap = store.computeToolUseRatePerTurn("alpha", sinceIso, 24);
      expect(snap.turnsTotal).toBe(0);
      expect(snap.turnsWithTools).toBe(0);
      expect(snap.rate).toBe(0);
      expect(snap.agent).toBe("alpha");
      expect(snap.windowHours).toBe(24);
    } finally {
      store.close();
    }
  });

  it("computes rate = 0.3 when 3 of 10 turns had ≥1 tool", () => {
    // Bootstrap schema via TraceStore, then close so the helper can
    // re-open in write mode for the batch inserts.
    new TraceStore(dbPath).close();
    const baseMs = Date.now() - 12 * HOUR_MS;
    const writer = new Database(dbPath);
    try {
      // 7 turns with no tools (parallel_tool_call_count = NULL)
      for (let i = 0; i < 7; i++) {
        insertTurnInto(writer, "alpha", baseMs + i * 1000, null, String(i));
      }
      // 3 turns with tools (parallel_tool_call_count > 0)
      insertTurnInto(writer, "alpha", baseMs + 7000, 1, "t1");
      insertTurnInto(writer, "alpha", baseMs + 8000, 2, "t2");
      insertTurnInto(writer, "alpha", baseMs + 9000, 3, "t3");
    } finally {
      writer.close();
    }

    const store2 = new TraceStore(dbPath);
    try {
      const sinceIso = new Date(Date.now() - 24 * HOUR_MS).toISOString();
      const snap = store2.computeToolUseRatePerTurn("alpha", sinceIso, 24);
      expect(snap.turnsTotal).toBe(10);
      expect(snap.turnsWithTools).toBe(3);
      expect(snap.rate).toBeCloseTo(0.3, 5);
    } finally {
      store2.close();
    }
  });

  it("respects the window boundary — turns older than `since` excluded", () => {
    new TraceStore(dbPath).close();
    const writer = new Database(dbPath);
    try {
      // 5 in-window turns, all with tools
      const inWindowBase = Date.now() - 6 * HOUR_MS;
      for (let i = 0; i < 5; i++) {
        insertTurnInto(writer, "alpha", inWindowBase + i * 1000, 1, `in-${i}`);
      }
      // 5 OUT-of-window turns (older than 24h) — must NOT contribute
      const outOfWindowBase = Date.now() - 30 * HOUR_MS;
      for (let i = 0; i < 5; i++) {
        insertTurnInto(writer, "alpha", outOfWindowBase + i * 1000, 2, `out-${i}`);
      }
    } finally {
      writer.close();
    }

    const store2 = new TraceStore(dbPath);
    try {
      const sinceIso = new Date(Date.now() - 24 * HOUR_MS).toISOString();
      const snap = store2.computeToolUseRatePerTurn("alpha", sinceIso, 24);
      expect(snap.turnsTotal).toBe(5); // ONLY in-window
      expect(snap.turnsWithTools).toBe(5);
      expect(snap.rate).toBeCloseTo(1.0, 5);
    } finally {
      store2.close();
    }
  });

  it("isolates by agent — alpha's turns don't count toward beta's rate", () => {
    new TraceStore(dbPath).close();
    const baseMs = Date.now() - 12 * HOUR_MS;
    const writer = new Database(dbPath);
    try {
      // alpha has 4 in-window turns, all with tools
      for (let i = 0; i < 4; i++) {
        insertTurnInto(writer, "alpha", baseMs + i * 1000, 1, `a-${i}`);
      }
      // beta has 6 in-window turns, none with tools
      for (let i = 0; i < 6; i++) {
        insertTurnInto(writer, "beta", baseMs + (i + 100) * 1000, null, `b-${i}`);
      }
    } finally {
      writer.close();
    }

    const store2 = new TraceStore(dbPath);
    try {
      const sinceIso = new Date(Date.now() - 24 * HOUR_MS).toISOString();
      const alpha = store2.computeToolUseRatePerTurn("alpha", sinceIso, 24);
      const beta = store2.computeToolUseRatePerTurn("beta", sinceIso, 24);
      expect(alpha.turnsTotal).toBe(4);
      expect(alpha.turnsWithTools).toBe(4);
      expect(alpha.rate).toBeCloseTo(1.0, 5);
      expect(beta.turnsTotal).toBe(6);
      expect(beta.turnsWithTools).toBe(0);
      expect(beta.rate).toBe(0);
    } finally {
      store2.close();
    }
  });

  it("parallel_tool_call_count = 0 is treated as no-tool (per T01 conditional spread)", () => {
    // T01's conditional spread in Turn.end() persists NULL on the column
    // when no batches fired. A direct SQL insert with 0 (not NULL) tests
    // the SQL `> 0` filter — 0 must NOT count as "had tools."
    new TraceStore(dbPath).close();
    const baseMs = Date.now() - 6 * HOUR_MS;
    const writer = new Database(dbPath);
    try {
      insertTurnInto(writer, "alpha", baseMs + 1000, 0, "z"); // explicit 0
      insertTurnInto(writer, "alpha", baseMs + 2000, null, "n"); // explicit NULL
      insertTurnInto(writer, "alpha", baseMs + 3000, 1, "p"); // tools
    } finally {
      writer.close();
    }

    const store2 = new TraceStore(dbPath);
    try {
      const sinceIso = new Date(Date.now() - 24 * HOUR_MS).toISOString();
      const snap = store2.computeToolUseRatePerTurn("alpha", sinceIso, 24);
      expect(snap.turnsTotal).toBe(3); // all 3 in-window turns
      expect(snap.turnsWithTools).toBe(1); // only the count=1 turn
      expect(snap.rate).toBeCloseTo(1 / 3, 5);
    } finally {
      store2.close();
    }
  });
});

describe("Phase 115 Plan 08 T02 — write/read snapshot round-trip", { timeout: 30_000 }, () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tool-use-rate-snap-test-"));
    dbPath = join(tempDir, "traces.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writeToolUseRateSnapshot persists and getLatestToolUseRateSnapshot reads it back", () => {
    const store = new TraceStore(dbPath);
    try {
      const snap: ToolUseRateSnapshot = {
        agent: "alpha",
        computedAt: 1_700_000_000_000,
        windowHours: 24,
        turnsTotal: 100,
        turnsWithTools: 27,
        rate: 0.27,
      };
      store.writeToolUseRateSnapshot(snap);
      const latest = store.getLatestToolUseRateSnapshot("alpha");
      expect(latest).toBeDefined();
      expect(latest!.agent).toBe("alpha");
      expect(latest!.computedAt).toBe(1_700_000_000_000);
      expect(latest!.windowHours).toBe(24);
      expect(latest!.turnsTotal).toBe(100);
      expect(latest!.turnsWithTools).toBe(27);
      expect(latest!.rate).toBeCloseTo(0.27, 5);
    } finally {
      store.close();
    }
  });

  it("getLatestToolUseRateSnapshot returns the highest computed_at, not the most recently inserted", () => {
    const store = new TraceStore(dbPath);
    try {
      // Insert older snapshot LAST to verify ORDER BY computed_at DESC.
      store.writeToolUseRateSnapshot({
        agent: "alpha",
        computedAt: 2000,
        windowHours: 24,
        turnsTotal: 10,
        turnsWithTools: 3,
        rate: 0.3,
      });
      store.writeToolUseRateSnapshot({
        agent: "alpha",
        computedAt: 1000, // older
        windowHours: 24,
        turnsTotal: 5,
        turnsWithTools: 1,
        rate: 0.2,
      });
      const latest = store.getLatestToolUseRateSnapshot("alpha");
      expect(latest!.computedAt).toBe(2000);
      expect(latest!.rate).toBeCloseTo(0.3, 5);
    } finally {
      store.close();
    }
  });

  it("getLatestToolUseRateSnapshot returns undefined for unknown agent", () => {
    const store = new TraceStore(dbPath);
    try {
      const latest = store.getLatestToolUseRateSnapshot("never-existed");
      expect(latest).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("snapshot table is per-agent isolated", () => {
    const store = new TraceStore(dbPath);
    try {
      store.writeToolUseRateSnapshot({
        agent: "alpha",
        computedAt: 1000,
        windowHours: 24,
        turnsTotal: 100,
        turnsWithTools: 50,
        rate: 0.5,
      });
      store.writeToolUseRateSnapshot({
        agent: "beta",
        computedAt: 1000,
        windowHours: 24,
        turnsTotal: 10,
        turnsWithTools: 1,
        rate: 0.1,
      });
      const a = store.getLatestToolUseRateSnapshot("alpha");
      const b = store.getLatestToolUseRateSnapshot("beta");
      expect(a!.rate).toBeCloseTo(0.5, 5);
      expect(b!.rate).toBeCloseTo(0.1, 5);
    } finally {
      store.close();
    }
  });
});

describe("Phase 115 Plan 08 T02 — PARALLEL-TOOL-01 directive (sub-scope 17c)", () => {
  it("DEFAULT_SYSTEM_PROMPT_DIRECTIVES contains parallel-tool-calls entry with PARALLEL-TOOL-01 marker", async () => {
    const mod = await import("../../config/schema.js");
    const directive = mod.DEFAULT_SYSTEM_PROMPT_DIRECTIVES["parallel-tool-calls"];
    expect(directive).toBeDefined();
    expect(directive!.enabled).toBe(true);
    // Static-grep tokens pinned by T02 acceptance:
    expect(directive!.text).toContain("PARALLEL-TOOL-01");
    expect(directive!.text).toContain("parallel tool_use blocks");
    // The "mutually-orthogonal" scope guard prevents regression on
    // dependent calls — pinned because the threat model (line 373)
    // calls this out explicitly.
    expect(directive!.text).toContain("mutually-orthogonal");
  });

  it("operator override schema supports `enabled: false` without re-stating text (Phase 94 D-09/D-10 pattern)", async () => {
    // Pin the override-schema shape that lets operators disable
    // PARALLEL-TOOL-01 per-agent without copying its full text. The
    // FULL merge-semantics flow is exercised by
    // src/config/__tests__/loader.test.ts > LR-RESOLVE-DEFAULT-CONST-MATCHES
    // (extended in this same plan to assert PARALLEL-TOOL-01 lands in
    // the resolved enabled-defaults output).
    const mod = await import("../../config/schema.js");
    expect(mod.systemPromptDirectiveOverrideSchema).toBeDefined();
    const parsed = mod.systemPromptDirectiveOverrideSchema.parse({
      enabled: false,
    });
    expect(parsed.enabled).toBe(false);
    // text omitted is supported — text falls back to default at resolution.
    expect(parsed.text).toBeUndefined();
  });

  it("operator override actually disables PARALLEL-TOOL-01 — resolveSystemPromptDirectives merges per-key", async () => {
    // The end-to-end check that the SUMMARY's claim ("operator override
    // wins") is true at the resolver layer for THIS specific directive.
    // Without this test, a future refactor of the resolver could silently
    // break the override semantics for parallel-tool-calls only.
    const schema = await import("../../config/schema.js");
    const loader = await import("../../config/loader.js");
    const out = loader.resolveSystemPromptDirectives(
      { "parallel-tool-calls": { enabled: false } },
      schema.DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
    );
    const keys = out.map((d) => d.key);
    // Override flips enabled → false, so the key should be DROPPED from
    // the rendered output. All OTHER defaults remain enabled.
    expect(keys).not.toContain("parallel-tool-calls");
    expect(keys).toContain("file-sharing");
    expect(keys).toContain("cross-agent-routing");
  });
});
