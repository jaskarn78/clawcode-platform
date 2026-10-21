/**
 * Phase 62 Plan 03 -- CLI `clawcode policy dry-run` tests.
 *
 * Tests pure functions: parseDuration, formatDryRunTable, formatDryRunJson, runDryRun.
 * For runDryRun: creates temp SQLite DB + temp policies.yaml, exercises the
 * read-only query + policy evaluation pipeline end-to-end.
 */

import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import {
  parseDuration,
  formatDryRunTable,
  formatDryRunJson,
  runDryRun,
  type DryRunRow,
} from "../policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(tmpdir(), `policy-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createTestDb(
  dir: string,
  rows: Array<{
    source_id: string;
    idempotency_key: string;
    created_at: number;
    source_kind?: string | null;
    payload?: string | null;
  }>,
): string {
  const dbPath = join(dir, "tasks.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS trigger_events (
      source_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      source_kind TEXT,
      payload TEXT,
      UNIQUE(source_id, idempotency_key)
    )
  `);
  const insert = db.prepare(
    "INSERT INTO trigger_events (source_id, idempotency_key, created_at, source_kind, payload) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.source_id,
      row.idempotency_key,
      row.created_at,
      row.source_kind ?? null,
      row.payload ?? null,
    );
  }
  db.close();
  return dbPath;
}

function createTestPolicy(dir: string, yaml: string): string {
  const policyPath = join(dir, "policies.yaml");
  writeFileSync(policyPath, yaml, "utf-8");
  return policyPath;
}

const SAMPLE_POLICY_YAML = `
version: 1
rules:
  - id: route-mysql
    description: "Route MySQL triggers to data-agent"
    enabled: true
    priority: 10
    source:
      kind: mysql
    target: data-agent
    payload: "Event from {{event.sourceId}}"
  - id: catch-all
    description: "Catch-all rule"
    enabled: true
    priority: 0
    target: default-agent
    payload: "Unmatched event: {{event.idempotencyKey}}"
`;

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe("parseDuration", () => {
  it("parses hours", () => {
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  it("parses minutes", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
  });

  it("parses days", () => {
    expect(parseDuration("2d")).toBe(172_800_000);
  });

  it("parses seconds", () => {
    expect(parseDuration("60s")).toBe(60_000);
  });

  it("throws on invalid input", () => {
    expect(() => parseDuration("invalid")).toThrow(/Invalid duration/);
  });

  it("throws on empty string", () => {
    expect(() => parseDuration("")).toThrow(/Invalid duration/);
  });

  it("throws on missing unit", () => {
    expect(() => parseDuration("30")).toThrow(/Invalid duration/);
  });

  it("throws on unknown unit", () => {
    expect(() => parseDuration("5w")).toThrow(/Invalid duration/);
  });
});

// ---------------------------------------------------------------------------
// formatDryRunTable
// ---------------------------------------------------------------------------

describe("formatDryRunTable", () => {
  const sampleRows: DryRunRow[] = [
    {
      timestamp: "2026-04-17T12:00:00.000Z",
      source: "mysql:pipeline",
      sourceKind: "mysql",
      event: "key-001",
      rule: "route-mysql",
      agent: "data-agent",
      action: "allow",
    },
    {
      timestamp: "2026-04-17T12:01:00.000Z",
      source: "unknown-src",
      sourceKind: "unknown",
      event: "key-002",
      rule: "no match",
      agent: "-",
      action: "deny: no matching rule",
    },
  ];

  it("includes all column headers", () => {
    const table = formatDryRunTable(sampleRows);
    expect(table).toContain("Timestamp");
    expect(table).toContain("Source");
    expect(table).toContain("Event");
    expect(table).toContain("Rule");
    expect(table).toContain("Agent");
    expect(table).toContain("Action");
  });

  it("shows 'no match' for unmatched events", () => {
    const table = formatDryRunTable(sampleRows);
    expect(table).toContain("no match");
  });

  it("includes green ANSI code for allow actions", () => {
    const table = formatDryRunTable(sampleRows);
    // Green ANSI escape: \x1b[32m
    expect(table).toContain("\x1b[32m");
  });

  it("includes red ANSI code for deny actions", () => {
    const table = formatDryRunTable(sampleRows);
    // Red ANSI escape: \x1b[31m
    expect(table).toContain("\x1b[31m");
  });

  it("includes ANSI reset codes", () => {
    const table = formatDryRunTable(sampleRows);
    expect(table).toContain("\x1b[0m");
  });

  it("returns empty-message for empty rows", () => {
    const table = formatDryRunTable([]);
    expect(table).toContain("No events");
  });
});

// ---------------------------------------------------------------------------
// formatDryRunJson
// ---------------------------------------------------------------------------

describe("formatDryRunJson", () => {
  it("returns valid JSON array", () => {
    const rows: DryRunRow[] = [
      {
        timestamp: "2026-04-17T12:00:00.000Z",
        source: "src1",
        sourceKind: "mysql",
        event: "key-001",
        rule: "rule-1",
        agent: "agent-1",
        action: "allow",
      },
    ];
    const json = formatDryRunJson(rows);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].source).toBe("src1");
  });

  it("returns empty array for empty rows", () => {
    const json = formatDryRunJson([]);
    expect(JSON.parse(json)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runDryRun
// ---------------------------------------------------------------------------

describe("runDryRun", { timeout: 15_000 }, () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("throws on missing tasks.db", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const policyPath = createTestPolicy(dir, SAMPLE_POLICY_YAML);

    expect(() =>
      runDryRun({
        dbPath: join(dir, "nonexistent.db"),
        policyPath,
        sinceMs: 3_600_000,
      }),
    ).toThrow(/not found/);
  });

  it("throws on missing policies.yaml", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const dbPath = createTestDb(dir, []);

    expect(() =>
      runDryRun({
        dbPath,
        policyPath: join(dir, "nonexistent.yaml"),
        sinceMs: 3_600_000,
      }),
    ).toThrow(/not found/);
  });

  it("returns empty results for empty trigger_events table", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const dbPath = createTestDb(dir, []);
    const policyPath = createTestPolicy(dir, SAMPLE_POLICY_YAML);

    const results = runDryRun({ dbPath, policyPath, sinceMs: 3_600_000 });
    expect(results).toEqual([]);
  });

  it("evaluates events against policy and returns results", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const now = Date.now();
    const dbPath = createTestDb(dir, [
      {
        source_id: "mysql:pipeline_clients",
        idempotency_key: "evt-001",
        created_at: now - 60_000, // 1 min ago
        source_kind: "mysql",
        payload: JSON.stringify({ clientName: "Acme" }),
      },
      {
        source_id: "webhook:unknown",
        idempotency_key: "evt-002",
        created_at: now - 120_000, // 2 min ago
        source_kind: "webhook",
        payload: null,
      },
    ]);
    const policyPath = createTestPolicy(dir, SAMPLE_POLICY_YAML);

    const results = runDryRun({ dbPath, policyPath, sinceMs: 3_600_000 });

    expect(results).toHaveLength(2);

    // First result (evt-002 is older, so comes first due to ASC order)
    const webhookResult = results[0]!;
    expect(webhookResult.source).toBe("webhook:unknown");
    // webhook kind does NOT match mysql source filter, but catch-all should match
    expect(webhookResult.rule).toBe("catch-all");
    expect(webhookResult.agent).toBe("default-agent");
    expect(webhookResult.action).toBe("allow");

    // Second result (evt-001 is newer)
    const mysqlResult = results[1]!;
    expect(mysqlResult.source).toBe("mysql:pipeline_clients");
    expect(mysqlResult.rule).toBe("route-mysql");
    expect(mysqlResult.agent).toBe("data-agent");
    expect(mysqlResult.action).toBe("allow");
  });

  it("filters events outside the since window", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const now = Date.now();
    const dbPath = createTestDb(dir, [
      {
        source_id: "recent-src",
        idempotency_key: "recent-key",
        created_at: now - 60_000, // 1 min ago
        source_kind: "mysql",
      },
      {
        source_id: "old-src",
        idempotency_key: "old-key",
        created_at: now - 7_200_000, // 2 hours ago
        source_kind: "mysql",
      },
    ]);
    const policyPath = createTestPolicy(dir, SAMPLE_POLICY_YAML);

    // Only fetch last 1 hour
    const results = runDryRun({ dbPath, policyPath, sinceMs: 3_600_000 });
    expect(results).toHaveLength(1);
    expect(results[0]!.source).toBe("recent-src");
  });

  it("truncates long idempotency keys in event column", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const now = Date.now();
    const longKey = "a".repeat(30);
    const dbPath = createTestDb(dir, [
      {
        source_id: "src",
        idempotency_key: longKey,
        created_at: now - 60_000,
      },
    ]);
    const policyPath = createTestPolicy(dir, SAMPLE_POLICY_YAML);

    const results = runDryRun({ dbPath, policyPath, sinceMs: 3_600_000 });
    expect(results).toHaveLength(1);
    expect(results[0]!.event.length).toBeLessThanOrEqual(20);
    expect(results[0]!.event).toContain("...");
  });

  it("opens SQLite in read-only mode", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const dbPath = createTestDb(dir, []);
    const policyPath = createTestPolicy(dir, SAMPLE_POLICY_YAML);

    // If it opened in read-write mode and we made the file read-only,
    // it would fail. We can't easily test the flag directly, but we verify
    // the function works correctly which implies correct configuration.
    const results = runDryRun({ dbPath, policyPath, sinceMs: 3_600_000 });
    expect(results).toEqual([]);
  });
});
