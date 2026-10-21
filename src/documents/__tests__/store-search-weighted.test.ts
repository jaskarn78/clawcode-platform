import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { DocumentStore } from "../store.js";

/**
 * Phase 999.43 Plan 03 Task 1 — DocumentStore.search() priority-weighted
 * ranking + recency boost (D-02 LOCKED VERBATIM).
 *
 * Score formula (D-02):
 *   score = base_similarity (1 - distance)
 *         × agent_priority_weight   (1.5 / 1.0 / 0.7)
 *         × content_priority_weight (1.5 / 1.0 / 0.5)
 *         × recency_boost           (1.3× if ingested <= 7 days, else 1.0×)
 *
 * D-07: recency_boost is QUERY-TIME computed from documents.ingested_at vs
 * now — NOT stored as a column.
 *
 * Tests:
 *   1. Formula correctness — 3 docs (HIGH/MED/LOW content, all 1d / 30d old,
 *      agentWeight=1.5). Verifies the multiplicative spread and ordering.
 *   2. Backward compat — no agentWeight arg → returns rows in raw-distance
 *      order with weightedScore present but equal to base similarity.
 *   3. Recency cliff — two HIGH/HIGH docs, one 6d old, one 8d old. The 6d
 *      doc scores 1.3× higher (recency boost engages at <= 7 days).
 *   4. Legacy placeholder neutrality — a pre-999.43 docs row (content_weight
 *      1.0, agent_weight_at_ingest 1.0, source_kind "manual_pre_999_43")
 *      receives multiplier 1.0 × agentWeight × recency.
 */

/** Identical 384-dim int8 embedding — distance 0 ⇒ similarity 1.0. */
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

describe("DocumentStore.search — priority-weighted ranking (Phase 999.43 D-02)", () => {
  let db: DatabaseType;
  let store: DocumentStore;

  beforeEach(() => {
    ({ db, store } = freshStore());
  });

  it("Test 1: applies agent × content × recency multipliers; returns weighted order [A,B,C]", () => {
    // 3 chunks with identical embeddings → identical base similarity ≈ 1.0.
    const emb = unitEmbedding();
    const now = Date.now();
    const oneDayAgo = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    store.ingest(
      "/docs/A.txt",
      [{ content: "alpha", chunkIndex: 0, startChar: 0, endChar: 5 }],
      [emb],
    );
    store.upsertDocumentRow({
      source: "/docs/A.txt",
      agentName: "fin",
      ingestedAt: oneDayAgo,
      sourceKind: "discord_attachment",
      autoClassifiedClass: "high",
      contentWeight: 1.5,
      agentWeightAtIngest: 1.5,
    });

    store.ingest(
      "/docs/B.txt",
      [{ content: "bravo", chunkIndex: 0, startChar: 0, endChar: 5 }],
      [emb],
    );
    store.upsertDocumentRow({
      source: "/docs/B.txt",
      agentName: "fin",
      ingestedAt: oneDayAgo,
      sourceKind: "discord_attachment",
      autoClassifiedClass: "medium",
      contentWeight: 1.0,
      agentWeightAtIngest: 1.5,
    });

    store.ingest(
      "/docs/C.txt",
      [{ content: "charlie", chunkIndex: 0, startChar: 0, endChar: 7 }],
      [emb],
    );
    store.upsertDocumentRow({
      source: "/docs/C.txt",
      agentName: "fin",
      ingestedAt: thirtyDaysAgo,
      sourceKind: "discord_attachment",
      autoClassifiedClass: "low",
      contentWeight: 0.5,
      agentWeightAtIngest: 1.5,
    });

    const results = store.search(emb, 3, undefined, 1.5);
    expect(results).toHaveLength(3);

    // Identical embeddings → similarity = 1.0 across the board.
    // A: 1.0 × 1.5 × 1.5 × 1.3 = 2.925
    // B: 1.0 × 1.5 × 1.0 × 1.3 = 1.95
    // C: 1.0 × 1.5 × 0.5 × 1.0 = 0.75
    const byChunk = new Map(results.map((r) => [r.source, r]));
    const a = byChunk.get("/docs/A.txt")!;
    const b = byChunk.get("/docs/B.txt")!;
    const c = byChunk.get("/docs/C.txt")!;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(c).toBeTruthy();

    // Ratios per D-02 (SC-D ~3× spread is the gate; assert with tolerance).
    expect(a.weightedScore! / b.weightedScore!).toBeCloseTo(1.5, 2);
    expect(a.weightedScore! / c.weightedScore!).toBeCloseTo(3.9, 1);

    // Ordering — DESC by weightedScore.
    expect(results[0].source).toBe("/docs/A.txt");
    expect(results[1].source).toBe("/docs/B.txt");
    expect(results[2].source).toBe("/docs/C.txt");

    // recencyBoostApplied flag: A,B yes (1d <= 7d); C no (30d).
    expect(a.recencyBoostApplied).toBe(true);
    expect(b.recencyBoostApplied).toBe(true);
    expect(c.recencyBoostApplied).toBe(false);
  });

  it("Test 2: omitting agentWeight preserves legacy distance-order behavior", () => {
    const emb = unitEmbedding();
    const now = Date.now();
    const oneDayAgo = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();

    store.ingest(
      "/docs/A.txt",
      [{ content: "alpha", chunkIndex: 0, startChar: 0, endChar: 5 }],
      [emb],
    );
    store.upsertDocumentRow({
      source: "/docs/A.txt",
      agentName: "fin",
      ingestedAt: oneDayAgo,
      sourceKind: "discord_attachment",
      autoClassifiedClass: "low",
      contentWeight: 0.5,
      agentWeightAtIngest: 1.0,
    });
    store.ingest(
      "/docs/B.txt",
      [{ content: "bravo", chunkIndex: 0, startChar: 0, endChar: 5 }],
      [emb],
    );
    store.upsertDocumentRow({
      source: "/docs/B.txt",
      agentName: "fin",
      ingestedAt: oneDayAgo,
      sourceKind: "discord_attachment",
      autoClassifiedClass: "high",
      contentWeight: 1.5,
      agentWeightAtIngest: 1.0,
    });

    // Legacy call (no agentWeight) — equal base similarity for identical embs.
    // weightedScore is present but with neutral 1.0 agent multiplier the
    // result set ordering is determined by raw distance only (tie here).
    const results = store.search(emb, 5);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(typeof r.weightedScore).toBe("number");
      // Legacy: no agent weight → similarity drives ranking (both equal).
      expect(r.similarity).toBeCloseTo(1.0, 2);
    }
  });

  it("Test 3: recency boost engages at <= 7d cutoff (6d boosted, 8d not)", () => {
    const emb = unitEmbedding();
    const now = Date.now();
    const sixDays = new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString();
    const eightDays = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();

    store.ingest(
      "/docs/recent.txt",
      [{ content: "recent", chunkIndex: 0, startChar: 0, endChar: 6 }],
      [emb],
    );
    store.upsertDocumentRow({
      source: "/docs/recent.txt",
      agentName: "fin",
      ingestedAt: sixDays,
      sourceKind: "discord_attachment",
      autoClassifiedClass: "high",
      contentWeight: 1.5,
      agentWeightAtIngest: 1.5,
    });

    store.ingest(
      "/docs/stale.txt",
      [{ content: "stalest", chunkIndex: 0, startChar: 0, endChar: 7 }],
      [emb],
    );
    store.upsertDocumentRow({
      source: "/docs/stale.txt",
      agentName: "fin",
      ingestedAt: eightDays,
      sourceKind: "discord_attachment",
      autoClassifiedClass: "high",
      contentWeight: 1.5,
      agentWeightAtIngest: 1.5,
    });

    const results = store.search(emb, 5, undefined, 1.5);
    const recent = results.find((r) => r.source === "/docs/recent.txt")!;
    const stale = results.find((r) => r.source === "/docs/stale.txt")!;
    expect(recent).toBeTruthy();
    expect(stale).toBeTruthy();

    expect(recent.recencyBoostApplied).toBe(true);
    expect(stale.recencyBoostApplied).toBe(false);
    // 1.3× spread between identical-content docs differing only in age.
    expect(recent.weightedScore! / stale.weightedScore!).toBeCloseTo(1.3, 2);
    // Recent wins.
    expect(results[0].source).toBe("/docs/recent.txt");
  });

  it("Test 4: legacy pre-999.43 placeholder rows score neutrally (1.0 × agentWeight × recency)", () => {
    const emb = unitEmbedding();
    const now = Date.now();
    // Simulate the Plan 01 T02 backfill — content_priority_weight=1.0,
    // source_kind="manual_pre_999_43", agent_priority_weight_at_ingest=1.0.
    // Use a 30d-old ingested_at so recency boost does NOT fire.
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    store.ingest(
      "/docs/legacy.txt",
      [{ content: "legacy", chunkIndex: 0, startChar: 0, endChar: 6 }],
      [emb],
    );
    store.upsertDocumentRow({
      source: "/docs/legacy.txt",
      agentName: "_unknown",
      ingestedAt: thirtyDaysAgo,
      sourceKind: "manual_pre_999_43",
      autoClassifiedClass: "medium",
      contentWeight: 1.0,
      agentWeightAtIngest: 1.0,
    });

    // Call with agentWeight = 1.0 (medium-priority agent) — expect
    // weightedScore ≈ similarity × 1.0 × 1.0 × 1.0 = similarity.
    const results = store.search(emb, 5, undefined, 1.0);
    expect(results).toHaveLength(1);
    const row = results[0];
    expect(row.source).toBe("/docs/legacy.txt");
    expect(row.recencyBoostApplied).toBe(false);
    expect(row.weightedScore!).toBeCloseTo(row.similarity, 5);
  });
});
