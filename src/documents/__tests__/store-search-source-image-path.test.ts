/**
 * Phase 999.43-fu2 Path A T03 — DocumentStore.search() surfaces
 * `sourceImagePath` in results.
 *
 * Two test cases (per brief):
 *   1. Result includes sourceImagePath for image-source docs.
 *   2. PDF-source docs return null sourceImagePath.
 *
 * Identical to store-search-weighted.test.ts fixture pattern — embeddings
 * are unit int8 vectors so distance=0 ⇒ similarity=1.0 ⇒ deterministic
 * top-K ordering by source ingest order.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { DocumentStore } from "../store.js";

function unitEmbedding(): Int8Array {
  const arr = new Int8Array(384);
  for (let i = 0; i < 384; i++) arr[i] = 100;
  return arr;
}

function freshStore(): { db: DatabaseType; store: DocumentStore } {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  sqliteVec.load(db);
  const store = new DocumentStore(db);
  return { db, store };
}

describe("DocumentStore.search — sourceImagePath surface (Phase 999.43-fu2 T03)", () => {
  let store: DocumentStore;
  beforeEach(() => {
    ({ store } = freshStore());
  });

  it("Test 1: result includes sourceImagePath for image-source docs", () => {
    const imgPath =
      "/tmp/fin-client/inbox/attachments/aapl-candle.png";
    store.ingest(
      "/docs/aapl-candle.png",
      [{ content: "aapl candle chart", chunkIndex: 0, startChar: 0, endChar: 17 }],
      [unitEmbedding()],
    );
    store.upsertDocumentRow({
      source: "/docs/aapl-candle.png",
      agentName: "fin-client",
      ingestedAt: new Date().toISOString(),
      sourceKind: "discord_attachment",
      autoClassifiedClass: "high",
      contentWeight: 1.5,
      agentWeightAtIngest: 1.5,
      sourceImagePath: imgPath,
    });

    const results = store.search(unitEmbedding(), 5);
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("/docs/aapl-candle.png");
    expect(results[0].sourceImagePath).toBe(imgPath);
  });

  it("Test 2: PDF-source docs return null sourceImagePath", () => {
    store.ingest(
      "/docs/client-c-2024-return.pdf",
      [{ content: "pon return text", chunkIndex: 0, startChar: 0, endChar: 15 }],
      [unitEmbedding()],
    );
    store.upsertDocumentRow({
      source: "/docs/client-c-2024-return.pdf",
      agentName: "fin-client",
      ingestedAt: new Date().toISOString(),
      sourceKind: "discord_attachment",
      autoClassifiedClass: "high",
      contentWeight: 1.5,
      agentWeightAtIngest: 1.5,
      // sourceImagePath omitted (PDF ingest path)
    });

    const results = store.search(unitEmbedding(), 5);
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("/docs/client-c-2024-return.pdf");
    expect(results[0].sourceImagePath).toBeNull();
  });
});
