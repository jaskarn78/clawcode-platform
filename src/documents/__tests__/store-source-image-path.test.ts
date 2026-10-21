/**
 * Phase 999.43-fu2 Path A T01 — DocumentStore `source_image_path` migration
 * + CRUD test.
 *
 * Covers the four required scenarios from the fu2 brief:
 *   1. Insert with `sourceImagePath` set → column persists in row + survives
 *      round-trip via getDocumentRow.
 *   2. Insert without `sourceImagePath` (omitted from input) → column is NULL.
 *   3. Query (getDocumentRow) returns `source_image_path` field for image-
 *      source docs and `null` for PDF-source docs (omitted input branch).
 *   4. Backfill safe — running `migrateAddSourceImagePath` against a DB that
 *      already has rows from pre-fu2 (no `source_image_path` column) adds the
 *      column with NULL for every existing row. Re-running the migration is
 *      a no-op (returns false).
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
  DocumentStore,
  migrateAddSourceImagePath,
  type DocumentRow,
} from "../store.js";

function freshDb(): DatabaseType {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  sqliteVec.load(db);
  return db;
}

describe("DocumentStore — source_image_path migration (Phase 999.43-fu2 Path A T01)", () => {
  let db: DatabaseType;
  let store: DocumentStore;

  beforeEach(() => {
    db = freshDb();
    store = new DocumentStore(db);
  });

  it("Test 1: insert with sourceImagePath set → column persists and round-trips", () => {
    const imagePath =
      "/tmp/fin-client/inbox/attachments/aapl-candle-2026-05-17.png";
    store.upsertDocumentRow({
      source: "discord:msg/aapl/aapl-candle-2026-05-17.png",
      agentName: "fin-client",
      channelId: "ch-1",
      messageId: "mid-1",
      userId: "u-1",
      ingestedAt: "2026-05-17T10:00:00.000Z",
      sourceKind: "discord_attachment",
      autoClassifiedClass: "high",
      contentWeight: 1.5,
      agentWeightAtIngest: 1.5,
      sourceImagePath: imagePath,
    });

    const row = store.getDocumentRow(
      "discord:msg/aapl/aapl-candle-2026-05-17.png",
    ) as DocumentRow | null;
    expect(row).not.toBeNull();
    expect(row!.source_image_path).toBe(imagePath);
  });

  it("Test 2: insert WITHOUT sourceImagePath (PDF-like ingest) → column is NULL", () => {
    store.upsertDocumentRow({
      source: "discord:msg/pon/client-c-2024-return.pdf",
      agentName: "fin-client",
      channelId: "ch-2",
      messageId: "mid-2",
      userId: "u-2",
      ingestedAt: "2026-05-17T11:00:00.000Z",
      sourceKind: "discord_attachment",
      autoClassifiedClass: "high",
      contentWeight: 1.5,
      agentWeightAtIngest: 1.5,
      // Note: sourceImagePath intentionally omitted (PDF ingest path).
    });

    const row = store.getDocumentRow(
      "discord:msg/pon/client-c-2024-return.pdf",
    ) as DocumentRow | null;
    expect(row).not.toBeNull();
    expect(row!.source_image_path).toBeNull();
  });

  it("Test 3: query returns source_image_path for image-source docs and NULL for non-image docs (side-by-side)", () => {
    // Image attachment row.
    store.upsertDocumentRow({
      source: "discord:msg/chart/aapl-chart.png",
      agentName: "fin-client",
      ingestedAt: "2026-05-17T12:00:00.000Z",
      sourceKind: "discord_attachment",
      autoClassifiedClass: "high",
      contentWeight: 1.5,
      agentWeightAtIngest: 1.5,
      sourceImagePath:
        "/tmp/fin-client/inbox/attachments/aapl-chart.png",
    });
    // PDF attachment row — sourceImagePath omitted.
    store.upsertDocumentRow({
      source: "discord:msg/statement/q4-2025.pdf",
      agentName: "fin-client",
      ingestedAt: "2026-05-17T12:01:00.000Z",
      sourceKind: "discord_attachment",
      autoClassifiedClass: "high",
      contentWeight: 1.5,
      agentWeightAtIngest: 1.5,
    });

    const imageRow = store.getDocumentRow(
      "discord:msg/chart/aapl-chart.png",
    ) as DocumentRow | null;
    const pdfRow = store.getDocumentRow(
      "discord:msg/statement/q4-2025.pdf",
    ) as DocumentRow | null;
    expect(imageRow).not.toBeNull();
    expect(pdfRow).not.toBeNull();
    expect(imageRow!.source_image_path).toBe(
      "/tmp/fin-client/inbox/attachments/aapl-chart.png",
    );
    expect(pdfRow!.source_image_path).toBeNull();
  });

  it("Test 4: migration is idempotent — runs twice on a pre-fu2-shape DB, only adds the column once; backfills NULL for existing rows", () => {
    // Construct a pre-fu2 documents table by hand (NO source_image_path column).
    const legacyDb = freshDb();
    legacyDb.exec(`
      CREATE TABLE documents (
        source TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        channel_id TEXT,
        message_id TEXT,
        user_id TEXT,
        ingested_at TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        auto_classified_class TEXT NOT NULL,
        override_class TEXT,
        content_priority_weight REAL NOT NULL DEFAULT 1.0,
        agent_priority_weight_at_ingest REAL NOT NULL DEFAULT 1.0
      );
    `);
    // Seed a pre-fu2 row (legacy shape — no source_image_path column).
    legacyDb
      .prepare(
        `INSERT INTO documents
          (source, agent_name, ingested_at, source_kind, auto_classified_class,
           content_priority_weight, agent_priority_weight_at_ingest)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy:img.png",
        "fin-client",
        "2026-04-01T00:00:00.000Z",
        "discord_attachment",
        "medium",
        1.0,
        1.0,
      );

    // First migration call adds the column and returns true.
    expect(migrateAddSourceImagePath(legacyDb)).toBe(true);

    // Column now exists and the existing row has NULL backfilled.
    const cols = legacyDb
      .prepare("PRAGMA table_info(documents)")
      .all() as ReadonlyArray<{ name: string }>;
    expect(cols.some((c) => c.name === "source_image_path")).toBe(true);
    const backfilled = legacyDb
      .prepare("SELECT source_image_path FROM documents WHERE source = ?")
      .get("legacy:img.png") as { source_image_path: string | null };
    expect(backfilled.source_image_path).toBeNull();

    // Second migration call is a no-op (returns false; column not duplicated).
    expect(migrateAddSourceImagePath(legacyDb)).toBe(false);
    const colsAfter = legacyDb
      .prepare("PRAGMA table_info(documents)")
      .all() as ReadonlyArray<{ name: string }>;
    const sourceImagePathCount = colsAfter.filter(
      (c) => c.name === "source_image_path",
    ).length;
    expect(sourceImagePathCount).toBe(1);

    // Third migration call (running directly through the DocumentStore
    // constructor on the migrated DB) is also a no-op — DocumentStore opens
    // cleanly without errors.
    const reopenedStore = new DocumentStore(legacyDb);
    expect(reopenedStore.getDocumentRow("legacy:img.png")).not.toBeNull();
  });
});
