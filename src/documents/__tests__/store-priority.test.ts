import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
  DocumentStore,
  CONTENT_PRIORITY_WEIGHTS,
  type DocumentRow,
} from "../store.js";

/**
 * Phase 999.43 Plan 01 Task 2 — documents provenance table + DocumentStore
 * priority CRUD. Tests:
 *   1. Schema — documents table is created on fresh DB
 *   2. upsertDocumentRow inserts + is idempotent (same source → UPDATE)
 *   3. getDocumentRow returns all D-04 provenance fields
 *   4. setDocumentPriority updates override_class + recomputes weight per
 *      D-01 multipliers; auto_classified_class is immutable
 *   5. Backwards-compat: pre-existing document_chunks rows survive the new
 *      migration with auto-backfilled placeholder documents rows
 */
function freshDb(): DatabaseType {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  sqliteVec.load(db);
  return db;
}

describe("DocumentStore — documents provenance table (Phase 999.43 D-04)", () => {
  let db: DatabaseType;
  let store: DocumentStore;

  beforeEach(() => {
    db = freshDb();
    store = new DocumentStore(db);
  });

  it("Test 1: creates `documents` table on fresh DB", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'",
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it("Test 2: upsertDocumentRow inserts then UPDATEs on same source (idempotent)", () => {
    store.upsertDocumentRow({
      source: "discord:msg/abc/client-c-statement.pdf",
      agentName: "fin-client",
      channelId: "1234567890",
      messageId: "9876543210",
      userId: "1112223334",
      ingestedAt: "2026-05-16T10:00:00.000Z",
      sourceKind: "discord_attachment",
      autoClassifiedClass: "high",
      contentWeight: 1.5,
      agentWeightAtIngest: 1.5,
    });

    // First insert — exactly one row exists.
    const after1 = db
      .prepare(
        "SELECT COUNT(*) as c FROM documents WHERE source = ?",
      )
      .get("discord:msg/abc/client-c-statement.pdf") as { c: number };
    expect(after1.c).toBe(1);

    // Re-upsert with different metadata — still one row, fields updated.
    store.upsertDocumentRow({
      source: "discord:msg/abc/client-c-statement.pdf",
      agentName: "fin-client",
      channelId: "1234567890",
      messageId: "9876543210",
      userId: "1112223334",
      ingestedAt: "2026-05-16T11:00:00.000Z", // 1h later
      sourceKind: "discord_attachment",
      autoClassifiedClass: "high",
      overrideClass: "medium",
      contentWeight: 1.0,
      agentWeightAtIngest: 1.5,
    });

    const after2 = db
      .prepare("SELECT * FROM documents WHERE source = ?")
      .all("discord:msg/abc/client-c-statement.pdf") as DocumentRow[];
    expect(after2).toHaveLength(1);
    expect(after2[0].ingested_at).toBe("2026-05-16T11:00:00.000Z");
    expect(after2[0].override_class).toBe("medium");
    expect(after2[0].content_priority_weight).toBeCloseTo(1.0, 5);
  });

  it("Test 3: getDocumentRow returns all D-04 provenance fields", () => {
    store.upsertDocumentRow({
      source: "discord:msg/xyz/report.docx",
      agentName: "research",
      channelId: "ch-1",
      messageId: "mid-2",
      userId: "u-3",
      ingestedAt: "2026-05-16T12:00:00.000Z",
      sourceKind: "discord_attachment",
      autoClassifiedClass: "high",
      overrideClass: null,
      contentWeight: 1.5,
      agentWeightAtIngest: 1.0,
    });
    const row = store.getDocumentRow("discord:msg/xyz/report.docx");
    expect(row).not.toBeNull();
    expect(row!.source).toBe("discord:msg/xyz/report.docx");
    expect(row!.agent_name).toBe("research");
    expect(row!.channel_id).toBe("ch-1");
    expect(row!.message_id).toBe("mid-2");
    expect(row!.user_id).toBe("u-3");
    expect(row!.ingested_at).toBe("2026-05-16T12:00:00.000Z");
    expect(row!.source_kind).toBe("discord_attachment");
    expect(row!.auto_classified_class).toBe("high");
    expect(row!.override_class).toBeNull();
    expect(row!.content_priority_weight).toBeCloseTo(1.5, 5);
    expect(row!.agent_priority_weight_at_ingest).toBeCloseTo(1.0, 5);
  });

  it("Test 3b: getDocumentRow returns null for unknown source", () => {
    expect(store.getDocumentRow("does-not-exist")).toBeNull();
  });

  it("Test 3c: getDocumentRowByMessageId resolves by Discord message id", () => {
    store.upsertDocumentRow({
      source: "discord:msg/m1/file.pdf",
      agentName: "fin-client",
      channelId: "ch-1",
      messageId: "m-payload-id",
      userId: "u-1",
      ingestedAt: "2026-05-16T13:00:00.000Z",
      sourceKind: "discord_attachment",
      autoClassifiedClass: "high",
      contentWeight: 1.5,
      agentWeightAtIngest: 1.5,
    });
    const row = store.getDocumentRowByMessageId("m-payload-id");
    expect(row).not.toBeNull();
    expect(row!.source).toBe("discord:msg/m1/file.pdf");
    expect(store.getDocumentRowByMessageId("nope")).toBeNull();
  });

  it("Test 4: setDocumentPriority updates override_class + recomputes weight per D-01 multipliers; auto_classified_class is immutable", () => {
    store.upsertDocumentRow({
      source: "doc:1",
      agentName: "fin-client",
      ingestedAt: "2026-05-16T14:00:00.000Z",
      sourceKind: "discord_attachment",
      autoClassifiedClass: "high",
      contentWeight: 1.5,
      agentWeightAtIngest: 1.5,
    });

    // Operator demotes from auto-HIGH to MEDIUM.
    store.setDocumentPriority("doc:1", "medium", "operator");
    const afterMedium = store.getDocumentRow("doc:1");
    expect(afterMedium!.override_class).toBe("medium");
    expect(afterMedium!.content_priority_weight).toBeCloseTo(
      CONTENT_PRIORITY_WEIGHTS.medium,
      5,
    );
    // auto_classified_class is preserved (D-04 immutable post-ingest).
    expect(afterMedium!.auto_classified_class).toBe("high");

    // Further drop to LOW — weight follows the multiplier table.
    store.setDocumentPriority("doc:1", "low", "operator");
    const afterLow = store.getDocumentRow("doc:1");
    expect(afterLow!.override_class).toBe("low");
    expect(afterLow!.content_priority_weight).toBeCloseTo(
      CONTENT_PRIORITY_WEIGHTS.low,
      5,
    );
    expect(afterLow!.auto_classified_class).toBe("high");

    // Re-promote to HIGH — weight bumps back.
    store.setDocumentPriority("doc:1", "high", "operator");
    const afterHigh = store.getDocumentRow("doc:1");
    expect(afterHigh!.override_class).toBe("high");
    expect(afterHigh!.content_priority_weight).toBeCloseTo(
      CONTENT_PRIORITY_WEIGHTS.high,
      5,
    );
  });

  it("Test 5: pre-existing document_chunks rows get auto-backfilled placeholders on first DocumentStore open", () => {
    // Simulate a Phase 101 production DB: chunks exist, but the documents
    // table doesn't (pre-999.43 schema). Replicate by hand-rolling the same
    // raw schema DocumentStore.initSchema would create EXCEPT for the
    // documents table.
    const legacyDb = freshDb();
    legacyDb.exec(`
      CREATE TABLE document_chunks (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        start_char INTEGER NOT NULL,
        end_char INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE vec_document_chunks USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding int8[384] distance_metric=cosine
      );
    `);
    // Seed two pre-999.43 manual-ingested chunks under different sources.
    legacyDb
      .prepare(
        "INSERT INTO document_chunks (id, source, chunk_index, content, start_char, end_char, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("c1", "legacy:doc-A.md", 0, "alpha", 0, 5, "2026-04-01T00:00:00.000Z");
    legacyDb
      .prepare(
        "INSERT INTO document_chunks (id, source, chunk_index, content, start_char, end_char, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("c2", "legacy:doc-A.md", 1, "beta", 5, 10, "2026-04-01T00:00:01.000Z");
    legacyDb
      .prepare(
        "INSERT INTO document_chunks (id, source, chunk_index, content, start_char, end_char, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("c3", "legacy:doc-B.txt", 0, "gamma", 0, 5, "2026-04-02T00:00:00.000Z");

    // Open DocumentStore against the legacy DB → migration runs.
    const legacyStore = new DocumentStore(legacyDb);

    // Both legacy chunks are still here.
    const chunkCount = (
      legacyDb
        .prepare("SELECT COUNT(*) as c FROM document_chunks")
        .get() as { c: number }
    ).c;
    expect(chunkCount).toBe(3);

    // Placeholder rows exist for each distinct source.
    const aRow = legacyStore.getDocumentRow("legacy:doc-A.md");
    const bRow = legacyStore.getDocumentRow("legacy:doc-B.txt");
    expect(aRow).not.toBeNull();
    expect(bRow).not.toBeNull();
    expect(aRow!.source_kind).toBe("manual_pre_999_43");
    expect(aRow!.auto_classified_class).toBe("medium");
    expect(aRow!.content_priority_weight).toBeCloseTo(1.0, 5);
    expect(aRow!.agent_priority_weight_at_ingest).toBeCloseTo(1.0, 5);
    expect(aRow!.agent_name).toBe("_unknown");
    // ingested_at backfills from MIN(created_at) of the source's chunks.
    expect(aRow!.ingested_at).toBe("2026-04-01T00:00:00.000Z");
    expect(bRow!.ingested_at).toBe("2026-04-02T00:00:00.000Z");

    // Idempotency: re-opening DocumentStore on the same DB does NOT double-
    // insert placeholders.
    const reopenedStore = new DocumentStore(legacyDb);
    expect(reopenedStore.getDocumentRow("legacy:doc-A.md")).not.toBeNull();
    const totalDocs = (
      legacyDb
        .prepare("SELECT COUNT(*) as c FROM documents")
        .get() as { c: number }
    ).c;
    expect(totalDocs).toBe(2);
  });

  it("Constants: CONTENT_PRIORITY_WEIGHTS matches D-01 multipliers", () => {
    expect(CONTENT_PRIORITY_WEIGHTS.high).toBeCloseTo(1.5, 5);
    expect(CONTENT_PRIORITY_WEIGHTS.medium).toBeCloseTo(1.0, 5);
    expect(CONTENT_PRIORITY_WEIGHTS.low).toBeCloseTo(0.5, 5);
  });
});
