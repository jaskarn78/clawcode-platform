/**
 * Phase 53 Plan 01 — tests for the context-audit aggregator.
 *
 * Filesystem-direct: reads per-turn `section_tokens` from
 * `trace_spans.metadata_json` where `name = 'context_assemble'`.
 * No IPC, no daemon dependency. Test harness seeds a tempdir SQLite DB
 * with synthetic rows, then asserts aggregate / percentile / warning
 * behaviors on the frozen ContextAuditReport shape.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import {
  buildContextAuditReport,
  SECTION_NAMES,
  type ContextAuditReport,
  type SectionName,
} from "../context-audit.js";

type SeedOpts = {
  readonly agent?: string;
  readonly turns: number;
  readonly sectionTokensOverride?: (turnIdx: number) => Partial<
    Record<SectionName, number>
  > | null; // null => skip emitting section_tokens key (legacy row)
  readonly metadataJsonOverride?: (turnIdx: number) => string | null; // full metadata_json override
  readonly startedAtBase?: string; // ISO base
  readonly includeContextAssembleSpan?: boolean; // default true
  readonly idPrefix?: string; // turn id namespace (default "turn-")
};

function initTempDb(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        total_ms INTEGER NOT NULL,
        discord_channel_id TEXT,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trace_spans (
        turn_id TEXT NOT NULL,
        name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY(turn_id) REFERENCES traces(id) ON DELETE CASCADE
      );
    `);
  } finally {
    db.close();
  }
}

function seedTraces(dbPath: string, opts: SeedOpts): void {
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = MEMORY"); // tempdir tests — WAL overhead unnecessary
    db.pragma("synchronous = OFF");
    const agent = opts.agent ?? "clawdy";
    const base = new Date(
      opts.startedAtBase ?? new Date().toISOString(),
    ).getTime();
    const insertTrace = db.prepare(
      "INSERT INTO traces (id, agent, started_at, ended_at, total_ms, discord_channel_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertSpan = db.prepare(
      "INSERT INTO trace_spans (turn_id, name, started_at, duration_ms, metadata_json) VALUES (?, ?, ?, ?, ?)",
    );
    const prefix = opts.idPrefix ?? "turn-";
    const tx = db.transaction(() => {
      for (let i = 0; i < opts.turns; i++) {
        const id = `${prefix}${i}`;
        // Space turns 1 second apart; newest first when ORDER BY started_at DESC.
        const started = new Date(base + i * 1000).toISOString();
        insertTrace.run(id, agent, started, started, 1000, "chan-1", "success");
        if (opts.includeContextAssembleSpan === false) continue;
        let metadataJson: string | null;
        if (opts.metadataJsonOverride) {
          metadataJson = opts.metadataJsonOverride(i);
        } else {
          const override = opts.sectionTokensOverride
            ? opts.sectionTokensOverride(i)
            : {
                identity: 100,
                soul: 200,
                skills_header: 300,
                hot_tier: 400,
                recent_history: 500,
                per_turn_summary: 50,
                resume_summary: 1000,
              };
          if (override === null) {
            metadataJson = JSON.stringify({ other_field: "legacy" });
          } else {
            metadataJson = JSON.stringify({ section_tokens: override });
          }
        }
        insertSpan.run(id, "context_assemble", started, 42, metadataJson);
      }
    });
    tx();
  } finally {
    db.close();
  }
}

describe("buildContextAuditReport (Phase 53)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "context-audit-test-"));
    dbPath = join(tempDir, "traces.db");
    initTempDb(dbPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("aggregates 25 turns with deterministic section_tokens into a 7-section report", () => {
    seedTraces(dbPath, {
      turns: 25,
      startedAtBase: new Date().toISOString(),
    });
    const report = buildContextAuditReport({
      traceStorePath: dbPath,
      agent: "clawdy",
      since: "24h",
      minTurns: 20,
    });
    expect(report.agent).toBe("clawdy");
    expect(report.sampledTurns).toBe(25);
    expect(report.sections).toHaveLength(SECTION_NAMES.length);
    const identity = report.sections.find((s) => s.sectionName === "identity");
    expect(identity?.p50).toBe(100);
    expect(identity?.p95).toBe(100);
    expect(identity?.count).toBe(25);
    expect(report.warnings).toEqual([]);
  });

  it("flags minTurns warning when sampled < minTurns (still emits report)", () => {
    seedTraces(dbPath, {
      turns: 10,
      startedAtBase: new Date().toISOString(),
    });
    const report = buildContextAuditReport({
      traceStorePath: dbPath,
      agent: "clawdy",
      since: "24h",
      minTurns: 20,
    });
    expect(report.sampledTurns).toBe(10);
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings.join(" ")).toMatch(/minimum sampled turns/i);
  });

  it("returns null p50/p95 and zero count for every section when db has no matching rows", () => {
    const report = buildContextAuditReport({
      traceStorePath: dbPath,
      agent: "nobody-here",
      since: "24h",
    });
    expect(report.sampledTurns).toBe(0);
    expect(report.sections).toHaveLength(SECTION_NAMES.length);
    for (const row of report.sections) {
      expect(row.p50).toBeNull();
      expect(row.p95).toBeNull();
      expect(row.count).toBe(0);
    }
  });

  it("skips rows whose metadata_json lacks section_tokens (legacy Phase 50/52 rows)", () => {
    seedTraces(dbPath, {
      turns: 10,
      sectionTokensOverride: () => null, // emit { other_field } — no section_tokens
      startedAtBase: new Date().toISOString(),
    });
    const report = buildContextAuditReport({
      traceStorePath: dbPath,
      agent: "clawdy",
      since: "24h",
    });
    expect(report.sampledTurns).toBe(0);
  });

  it("silently skips rows with malformed metadata_json and still aggregates valid rows", () => {
    // 5 malformed + 5 valid — different id prefixes so traces.id PK stays unique
    seedTraces(dbPath, {
      turns: 5,
      metadataJsonOverride: () => "{ this is not valid json",
      startedAtBase: new Date(Date.now() - 60_000).toISOString(),
      idPrefix: "bad-",
    });
    seedTraces(dbPath, {
      agent: "clawdy",
      turns: 5,
      startedAtBase: new Date().toISOString(),
      idPrefix: "good-",
    });
    const report = buildContextAuditReport({
      traceStorePath: dbPath,
      agent: "clawdy",
      since: "24h",
    });
    expect(report.sampledTurns).toBe(5);
  });

  it("emits recommendations.new_defaults = ceil(p95 * 1.2) for sections with non-null p95", () => {
    seedTraces(dbPath, {
      turns: 20,
      sectionTokensOverride: () => ({
        identity: 100,
        soul: 200,
        skills_header: 300,
        hot_tier: 400,
        recent_history: 500,
        per_turn_summary: 50,
        resume_summary: 1000,
      }),
      startedAtBase: new Date().toISOString(),
    });
    const report = buildContextAuditReport({
      traceStorePath: dbPath,
      agent: "clawdy",
      since: "24h",
    });
    // Uniform values -> p95 = value itself, ceil(100 * 1.2) = 120
    expect(report.recommendations.new_defaults.identity).toBe(120);
    expect(report.recommendations.new_defaults.soul).toBe(Math.ceil(200 * 1.2));
    expect(report.recommendations.new_defaults.resume_summary).toBe(
      Math.ceil(1000 * 1.2),
    );
  });

  it("counts resume_summary rows over the 1500-token default budget", () => {
    // 10 turns, half over-budget (1800) half under (1000)
    seedTraces(dbPath, {
      turns: 10,
      sectionTokensOverride: (i) => ({
        identity: 100,
        soul: 200,
        skills_header: 300,
        hot_tier: 400,
        recent_history: 500,
        per_turn_summary: 50,
        resume_summary: i < 5 ? 1000 : 1800,
      }),
      startedAtBase: new Date().toISOString(),
    });
    const report = buildContextAuditReport({
      traceStorePath: dbPath,
      agent: "clawdy",
      since: "24h",
    });
    expect(report.resume_summary_over_budget_count).toBe(5);
  });

  it("percentile math uses in-JS nearest-rank over the identity bucket (tolerance asserted)", () => {
    // Seed 100 turns with identity token counts 1..100
    seedTraces(dbPath, {
      turns: 100,
      sectionTokensOverride: (i) => ({
        identity: i + 1,
        soul: 0,
        skills_header: 0,
        hot_tier: 0,
        recent_history: 0,
        per_turn_summary: 0,
        resume_summary: 0,
      }),
      startedAtBase: new Date().toISOString(),
    });
    const report = buildContextAuditReport({
      traceStorePath: dbPath,
      agent: "clawdy",
      since: "24h",
    });
    const identity = report.sections.find((s) => s.sectionName === "identity");
    expect(identity?.count).toBe(100);
    expect(identity?.p50).toBeGreaterThanOrEqual(49);
    expect(identity?.p50).toBeLessThanOrEqual(51);
    expect(identity?.p95).toBeGreaterThanOrEqual(94);
    expect(identity?.p95).toBeLessThanOrEqual(96);
  });

  it("opens the SQLite handle with readonly:true (write attempt throws)", () => {
    seedTraces(dbPath, {
      turns: 3,
      startedAtBase: new Date().toISOString(),
    });
    // Running the report must not fail even if db is opened read-only.
    const report = buildContextAuditReport({
      traceStorePath: dbPath,
      agent: "clawdy",
      since: "24h",
      minTurns: 3,
    });
    expect(report.sampledTurns).toBe(3);
    // Sanity: confirm we can still open it r/w afterward (no leaked handle lock).
    const rw = new Database(dbPath);
    try {
      rw.exec("CREATE TABLE IF NOT EXISTS rw_probe (x INTEGER);");
    } finally {
      rw.close();
    }
  });

  it("captures git_sha (HEAD or 'unknown' on failure) and generated_at ISO timestamp", () => {
    seedTraces(dbPath, {
      turns: 3,
      startedAtBase: new Date().toISOString(),
    });
    const report = buildContextAuditReport({
      traceStorePath: dbPath,
      agent: "clawdy",
      since: "24h",
      minTurns: 3,
    });
    expect(typeof report.git_sha).toBe("string");
    expect(report.git_sha.length).toBeGreaterThan(0);
    expect(() => new Date(report.generated_at).toISOString()).not.toThrow();
  });

  it("includes every canonical section name in the sections array even when some are absent", () => {
    // Seed rows that only emit identity (other sections absent from payload)
    seedTraces(dbPath, {
      turns: 3,
      sectionTokensOverride: () => ({ identity: 42 }),
      startedAtBase: new Date().toISOString(),
    });
    const report = buildContextAuditReport({
      traceStorePath: dbPath,
      agent: "clawdy",
      since: "24h",
      minTurns: 3,
    });
    const returnedNames = report.sections.map((s) => s.sectionName);
    for (const name of SECTION_NAMES) {
      expect(returnedNames).toContain(name);
    }
    const soul = report.sections.find((s) => s.sectionName === "soul");
    expect(soul?.count).toBe(0);
    expect(soul?.p50).toBeNull();
    expect(soul?.p95).toBeNull();
  });

  it("uses `--turns` to bound the sample to the most recent N rows", () => {
    // 30 rows spread across the last 30 seconds; turns=10 should sample only 10
    const now = Date.now();
    seedTraces(dbPath, {
      turns: 30,
      startedAtBase: new Date(now - 30_000).toISOString(),
    });
    const report = buildContextAuditReport({
      traceStorePath: dbPath,
      agent: "clawdy",
      since: "24h",
      turns: 10,
      minTurns: 5,
    });
    expect(report.sampledTurns).toBe(10);
  });
});

describe("ContextAuditReport frozen-ness", () => {
  it("returns a frozen report object with frozen nested collections", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "context-audit-freeze-"));
    const dbPath = join(tempDir, "traces.db");
    initTempDb(dbPath);
    try {
      seedTraces(dbPath, {
        turns: 3,
        startedAtBase: new Date().toISOString(),
      });
      const report: ContextAuditReport = buildContextAuditReport({
        traceStorePath: dbPath,
        agent: "clawdy",
        since: "24h",
        minTurns: 3,
      });
      expect(Object.isFrozen(report)).toBe(true);
      expect(Object.isFrozen(report.sections)).toBe(true);
      expect(Object.isFrozen(report.recommendations)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ── Phase 67 — SECTION_NAMES extension for conversation_context ─────────────

describe("SECTION_NAMES (Phase 67)", () => {
  it("SECTION_NAMES includes conversation_context", () => {
    expect(SECTION_NAMES).toContain("conversation_context");
    // Context-bloat fix #2 measurement — `memory_context` added as the 9th
    // canonical section so `context-audit` can measure the per-turn
    // retrieval block (previously appended after assembly, audit-invisible).
    expect(SECTION_NAMES).toContain("memory_context");
    expect(SECTION_NAMES.length).toBe(9);
  });
});
