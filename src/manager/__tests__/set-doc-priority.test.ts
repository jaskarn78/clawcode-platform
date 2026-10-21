/**
 * Phase 999.43 Plan 04 T01 — IPC handler tests for `set-doc-priority`
 * and `reclassify-docs` with D-08 sandbox enforcement + Phase 90
 * isolation + audit-log writes.
 *
 * Mirrors the auto-ingest-dispatcher.test.ts pattern from Plan 02 T03:
 *   - `:memory:` DocumentStore (Plan 01 T02) seeded with test rows
 *   - Captured pino logger via Writable sink
 *   - Tmp dir + JSONL read-back for the audit log (no mocking the writer)
 *
 * Tests:
 *   1. Operator HIGH allowed (writes override_class="high",
 *      content_priority_weight=1.5, audit JSONL line).
 *   2. Agent HIGH refused — D-08 sandbox. No DB change; audit JSONL
 *      records the refusal.
 *   3. Agent MEDIUM on own doc allowed.
 *   4. Agent on someone else's doc refused — Phase 90 isolation.
 *   5. reclassify-docs glob — 4 docs, 2 match Screenshot*=low, 2 untouched;
 *      returns { updated: 2 }, audit JSONL has 2 entries.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import {
  handleSetDocPriority,
  handleReclassifyDocs,
  type SetDocPriorityDeps,
} from "../set-doc-priority-handler.js";
import { DocumentStore } from "../../documents/store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function freshDb(): DatabaseType {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  sqliteVec.load(db);
  return db;
}

function captureLogger(): {
  log: pino.Logger;
  records: () => Array<Record<string, unknown>>;
} {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const log = pino({ level: "debug" }, sink);
  const records = () =>
    chunks
      .join("")
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  return { log, records };
}

function seedDoc(
  docStore: DocumentStore,
  source: string,
  agentName: string,
  autoClass: "high" | "medium" | "low" = "medium",
  messageId: string | null = null,
): void {
  docStore.upsertDocumentRow({
    source,
    agentName,
    channelId: "ch1",
    messageId,
    userId: "u1",
    ingestedAt: "2026-05-16T12:00:00.000Z",
    sourceKind: "discord_attachment",
    autoClassifiedClass: autoClass,
    overrideClass: null,
    contentWeight: autoClass === "high" ? 1.5 : autoClass === "low" ? 0.5 : 1.0,
    agentWeightAtIngest: 1.0,
  });
}

async function readAuditLines(
  dir: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const content = await readFile(
      join(dir, "audit-priority-changes.jsonl"),
      "utf8",
    );
    return content
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function makeDeps(opts: {
  docStore: DocumentStore;
  agentName: string;
  log: pino.Logger;
  memoryPath: string;
}): SetDocPriorityDeps {
  return {
    getDocumentStore: (a: string) =>
      a === opts.agentName ? opts.docStore : undefined,
    getAgentMemoryPath: (a: string) =>
      a === opts.agentName ? opts.memoryPath : undefined,
    logger: opts.log,
    nowIso: () => "2026-05-16T20:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("set-doc-priority handler — Phase 999.43 Plan 04 T01", () => {
  let db: DatabaseType;
  let docStore: DocumentStore;
  let tmpDir: string;

  beforeEach(async () => {
    db = freshDb();
    docStore = new DocumentStore(db);
    tmpDir = await mkdtemp(join(tmpdir(), "set-doc-priority-test-"));
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("Test 1 (operator HIGH allowed): writes override_class=high, weight=1.5, audit line", async () => {
    const { log } = captureLogger();
    const source = "/tmp/fin-client/inbox/x.pdf";
    seedDoc(docStore, source, "fin-client", "medium");

    const deps = makeDeps({
      docStore,
      agentName: "fin-client",
      log,
      memoryPath: tmpDir,
    });

    const result = await handleSetDocPriority(
      {
        agent: "fin-client",
        source,
        level: "high",
        who: "operator",
        reason: "operator escalation via CLI",
      },
      deps,
    );

    expect(result).toMatchObject({ ok: true, source, new_level: "high" });

    const row = docStore.getDocumentRow(source);
    expect(row).not.toBeNull();
    expect(row?.override_class).toBe("high");
    expect(row?.content_priority_weight).toBeCloseTo(1.5);
    // auto_classified_class must remain UNCHANGED (D-04 immutable post-ingest).
    expect(row?.auto_classified_class).toBe("medium");

    const audit = await readAuditLines(tmpDir);
    expect(audit.length).toBe(1);
    expect(audit[0]).toMatchObject({
      outcome: "applied",
      who: "operator",
      source,
      newLevel: "high",
      oldLevel: "medium",
    });
  });

  it("Test 2 (agent HIGH refused — D-08 sandbox): no DB change, refusal audit line", async () => {
    const { log } = captureLogger();
    const source = "/tmp/fin-client/inbox/x.pdf";
    seedDoc(docStore, source, "fin-client", "medium");

    const deps = makeDeps({
      docStore,
      agentName: "fin-client",
      log,
      memoryPath: tmpDir,
    });

    const result = await handleSetDocPriority(
      {
        agent: "fin-client",
        source,
        level: "high",
        who: "agent",
        callerAgent: "fin-client",
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error("expected refusal");
    expect(result.error).toMatch(/cannot escalate.*MEDIUM/i);

    const row = docStore.getDocumentRow(source);
    // Nothing changed — override_class still null, weight still 1.0.
    expect(row?.override_class).toBeNull();
    expect(row?.content_priority_weight).toBeCloseTo(1.0);

    const audit = await readAuditLines(tmpDir);
    expect(audit.length).toBe(1);
    expect(audit[0]).toMatchObject({
      outcome: "refused-escalation",
      who: "agent",
      callerAgent: "fin-client",
      attemptedLevel: "high",
    });
  });

  it("Test 3 (agent MEDIUM on own doc allowed): writes override_class=medium", async () => {
    const { log } = captureLogger();
    const source = "/tmp/fin-client/inbox/x.pdf";
    seedDoc(docStore, source, "fin-client", "low");

    const deps = makeDeps({
      docStore,
      agentName: "fin-client",
      log,
      memoryPath: tmpDir,
    });

    const result = await handleSetDocPriority(
      {
        agent: "fin-client",
        source,
        level: "medium",
        who: "agent",
        callerAgent: "fin-client",
        reason: "auto-bump",
      },
      deps,
    );

    expect(result).toMatchObject({ ok: true, new_level: "medium" });

    const row = docStore.getDocumentRow(source);
    expect(row?.override_class).toBe("medium");
    expect(row?.content_priority_weight).toBeCloseTo(1.0);

    const audit = await readAuditLines(tmpDir);
    expect(audit[0]).toMatchObject({
      outcome: "applied",
      who: "agent",
      callerAgent: "fin-client",
      newLevel: "medium",
      reason: "auto-bump",
    });
  });

  it("Test 4 (agent on someone else's doc refused — Phase 90 isolation)", async () => {
    const { log } = captureLogger();
    const source = "/tmp/research/inbox/x.pdf";
    // Doc owned by "research"; caller is "fin-client".
    seedDoc(docStore, source, "research", "medium");

    const deps = makeDeps({
      docStore,
      agentName: "fin-client",
      log,
      memoryPath: tmpDir,
    });

    const result = await handleSetDocPriority(
      {
        agent: "fin-client",
        source,
        level: "low",
        who: "agent",
        callerAgent: "fin-client",
      },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error("expected refusal");
    expect(result.error).toMatch(/isolation|not your document|cannot modify doc/i);

    const row = docStore.getDocumentRow(source);
    expect(row?.override_class).toBeNull();

    const audit = await readAuditLines(tmpDir);
    expect(audit[0]).toMatchObject({
      outcome: "refused-isolation",
      who: "agent",
      callerAgent: "fin-client",
    });
  });

  it("Test 5 (reclassify-docs glob): 4 docs, 2 match Screenshot*=low → updated:2", async () => {
    const { log } = captureLogger();
    seedDoc(docStore, "Screenshot 2026-05-01.png", "fin-client", "medium");
    seedDoc(docStore, "Screenshot-form.png", "fin-client", "medium");
    seedDoc(docStore, "tax-return.pdf", "fin-client", "high");
    seedDoc(docStore, "client-data.xlsx", "fin-client", "high");

    const deps = makeDeps({
      docStore,
      agentName: "fin-client",
      log,
      memoryPath: tmpDir,
    });

    const result = await handleReclassifyDocs(
      {
        agent: "fin-client",
        rule: "Screenshot*=low",
        who: "operator",
      },
      deps,
    );

    expect(result).toMatchObject({ ok: true, updated: 2 });

    expect(
      docStore.getDocumentRow("Screenshot 2026-05-01.png")?.override_class,
    ).toBe("low");
    expect(docStore.getDocumentRow("Screenshot-form.png")?.override_class).toBe(
      "low",
    );
    expect(docStore.getDocumentRow("tax-return.pdf")?.override_class).toBeNull();
    expect(
      docStore.getDocumentRow("client-data.xlsx")?.override_class,
    ).toBeNull();

    const audit = await readAuditLines(tmpDir);
    expect(audit.length).toBe(2);
    expect(audit.every((a) => a.outcome === "applied-bulk")).toBe(true);
    expect(audit.every((a) => a.newLevel === "low")).toBe(true);
    expect(audit.every((a) => a.rule === "Screenshot*=low")).toBe(true);
  });
});
