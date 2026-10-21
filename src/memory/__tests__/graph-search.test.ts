import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../store.js";
import { GraphSearch, cosineSimilarity } from "../graph-search.js";
import type { GraphSearchResult } from "../graph-search.types.js";

/**
 * Create a deterministic L2-normalized embedding of dimension 384.
 * Uses a simple seeded approach: sets element at index `seed % 384` to a high value,
 * then normalizes. Different seeds produce embeddings with predictable similarity.
 */
function makeEmbedding(seed: number): Float32Array {
  const vec = new Float32Array(384);
  // Set a few dimensions based on seed to create distinctive embeddings
  for (let i = 0; i < 384; i++) {
    // Deterministic pseudo-random using seed
    vec[i] = Math.sin(seed * 1000 + i * 0.1) * 0.1;
  }
  // Normalize to unit length
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) vec[i] /= norm;
  return vec;
}

/**
 * Create an embedding similar to a base embedding with a controlled similarity.
 * Mixes the base embedding with a random one to achieve approximate target similarity.
 */
function makeSimilarEmbedding(base: Float32Array, mixFactor: number): Float32Array {
  const noise = makeEmbedding(999); // fixed "noise" embedding
  const vec = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    vec[i] = base[i] * mixFactor + noise[i] * (1 - mixFactor);
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) vec[i] /= norm;
  return vec;
}

describe("GraphSearch", () => {
  let store: MemoryStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `graph-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    store = new MemoryStore(join(tempDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper to insert a memory with a specific ID and embedding, and optionally wikilinks.
   */
  function insertMemory(id: string, content: string, embedding: Float32Array): void {
    const db = store.getDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO memories (id, content, source, importance, tags, created_at, updated_at, accessed_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, content, "manual", 0.5, "[]", now, now, now, "warm");
    db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run(id, embedding);
  }

  /**
   * Helper to insert a graph link between two memory IDs.
   */
  function insertLink(sourceId: string, targetId: string): void {
    const db = store.getDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT OR IGNORE INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, ?, ?)"
    ).run(sourceId, targetId, targetId, now);
  }

  it("returns identical results to SemanticSearch when no graph edges exist", () => {
    const emb1 = makeEmbedding(1);
    const emb2 = makeEmbedding(2);
    const emb3 = makeEmbedding(3);

    insertMemory("m1", "memory one", emb1);
    insertMemory("m2", "memory two", emb2);
    insertMemory("m3", "memory three", emb3);

    const graphSearch = new GraphSearch(store);
    const results = graphSearch.search(emb1, 3);

    // Should get KNN results only, all with source "knn"
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.source === "knn")).toBe(true);
    expect(results.every((r) => r.linkedFrom === undefined)).toBe(true);
  });

  it("includes forward-linked neighbors in results with source graph-neighbor", () => {
    const queryEmb = makeEmbedding(1);
    const emb1 = makeSimilarEmbedding(queryEmb, 0.95); // very similar to query
    const emb2 = makeEmbedding(50); // different from query
    const neighborEmb = makeSimilarEmbedding(queryEmb, 0.7); // moderately similar

    insertMemory("knn-hit", "knn hit", emb1);
    insertMemory("unrelated", "unrelated", emb2);
    insertMemory("neighbor", "neighbor linked from knn-hit", neighborEmb);

    // knn-hit -> neighbor (forward link)
    insertLink("knn-hit", "neighbor");

    const graphSearch = new GraphSearch(store);
    // Use topK=1 so only the closest match (knn-hit) is a KNN result
    const results = graphSearch.search(queryEmb, 1);

    const neighborResult = results.find((r) => r.id === "neighbor");
    expect(neighborResult).toBeDefined();
    expect(neighborResult!.source).toBe("graph-neighbor");
  });

  it("includes backlinked neighbors in results", () => {
    const queryEmb = makeEmbedding(1);
    const emb1 = makeSimilarEmbedding(queryEmb, 0.95);
    const neighborEmb = makeSimilarEmbedding(queryEmb, 0.7);

    insertMemory("knn-hit", "knn hit", emb1);
    insertMemory("backlinker", "backlinker to knn-hit", neighborEmb);

    // backlinker -> knn-hit (backlink from knn-hit perspective)
    insertLink("backlinker", "knn-hit");

    const graphSearch = new GraphSearch(store);
    const results = graphSearch.search(queryEmb, 1);

    const neighborResult = results.find((r) => r.id === "backlinker");
    expect(neighborResult).toBeDefined();
    expect(neighborResult!.source).toBe("graph-neighbor");
  });

  it("excludes neighbors below neighborSimilarityThreshold", () => {
    const queryEmb = makeEmbedding(1);
    const emb1 = makeSimilarEmbedding(queryEmb, 0.95);
    // Create a neighbor that is very dissimilar to query
    const dissimilarEmb = makeEmbedding(500);

    insertMemory("knn-hit", "knn hit", emb1);
    insertMemory("dissimilar-neighbor", "very different", dissimilarEmb);

    insertLink("knn-hit", "dissimilar-neighbor");

    // Use high threshold to ensure exclusion
    const graphSearch = new GraphSearch(store, { neighborSimilarityThreshold: 0.9 });
    const results = graphSearch.search(queryEmb, 1);

    const neighborResult = results.find((r) => r.id === "dissimilar-neighbor");
    expect(neighborResult).toBeUndefined();
  });

  it("does not duplicate neighbors already in KNN results", () => {
    const queryEmb = makeEmbedding(1);
    const emb1 = makeSimilarEmbedding(queryEmb, 0.95);
    const emb2 = makeSimilarEmbedding(queryEmb, 0.9);

    insertMemory("m1", "memory one", emb1);
    insertMemory("m2", "memory two", emb2);

    // m1 links to m2, but m2 is already a KNN result
    insertLink("m1", "m2");

    const graphSearch = new GraphSearch(store);
    const results = graphSearch.search(queryEmb, 5);

    // m2 should appear only once
    const m2Results = results.filter((r) => r.id === "m2");
    expect(m2Results.length).toBe(1);
    expect(m2Results[0].source).toBe("knn");
  });

  it("includes a neighbor only once even when linked from multiple KNN results", () => {
    const queryEmb = makeEmbedding(1);
    const emb1 = makeSimilarEmbedding(queryEmb, 0.95);
    const emb2 = makeSimilarEmbedding(queryEmb, 0.9);
    const neighborEmb = makeSimilarEmbedding(queryEmb, 0.7);

    insertMemory("knn1", "knn hit 1", emb1);
    insertMemory("knn2", "knn hit 2", emb2);
    insertMemory("shared-neighbor", "shared neighbor", neighborEmb);

    // Both KNN hits link to the same neighbor
    insertLink("knn1", "shared-neighbor");
    insertLink("knn2", "shared-neighbor");

    const graphSearch = new GraphSearch(store);
    const results = graphSearch.search(queryEmb, 2);

    const neighborResults = results.filter((r) => r.id === "shared-neighbor");
    expect(neighborResults.length).toBe(1);
    // linkedFrom should contain both KNN sources
    expect(neighborResults[0].linkedFrom).toBeDefined();
    expect(neighborResults[0].linkedFrom!.length).toBe(2);
    expect(neighborResults[0].linkedFrom).toContain("knn1");
    expect(neighborResults[0].linkedFrom).toContain("knn2");
  });

  it("caps total results at maxTotalResults", () => {
    const queryEmb = makeEmbedding(1);

    // Insert many memories and link them
    for (let i = 0; i < 10; i++) {
      const emb = makeSimilarEmbedding(queryEmb, 0.95 - i * 0.02);
      insertMemory(`m${i}`, `memory ${i}`, emb);
    }
    // Insert many neighbors
    for (let i = 0; i < 10; i++) {
      const emb = makeSimilarEmbedding(queryEmb, 0.7 - i * 0.01);
      insertMemory(`n${i}`, `neighbor ${i}`, emb);
      insertLink(`m0`, `n${i}`);
    }

    const graphSearch = new GraphSearch(store, { maxTotalResults: 8, maxNeighbors: 10 });
    const results = graphSearch.search(queryEmb, 5);

    expect(results.length).toBeLessThanOrEqual(8);
  });

  it("graph-neighbor results have linkedFrom array listing KNN source IDs", () => {
    const queryEmb = makeEmbedding(1);
    const emb1 = makeSimilarEmbedding(queryEmb, 0.95);
    const neighborEmb = makeSimilarEmbedding(queryEmb, 0.7);

    insertMemory("source-knn", "knn hit", emb1);
    insertMemory("linked-neighbor", "neighbor", neighborEmb);

    insertLink("source-knn", "linked-neighbor");

    const graphSearch = new GraphSearch(store);
    const results = graphSearch.search(queryEmb, 1);

    const neighbor = results.find((r) => r.id === "linked-neighbor");
    expect(neighbor).toBeDefined();
    expect(neighbor!.linkedFrom).toEqual(["source-knn"]);
  });

  it("KNN results retain source knn", () => {
    const queryEmb = makeEmbedding(1);
    const emb1 = makeSimilarEmbedding(queryEmb, 0.95);

    insertMemory("knn-only", "knn result", emb1);

    const graphSearch = new GraphSearch(store);
    const results = graphSearch.search(queryEmb, 3);

    const knnResult = results.find((r) => r.id === "knn-only");
    expect(knnResult).toBeDefined();
    expect(knnResult!.source).toBe("knn");
    expect(knnResult!.linkedFrom).toBeUndefined();
  });
});

describe("GraphSearch — graph-walked neighbor access_count bumping (Phase 100-fu)", () => {
  let store: MemoryStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `graph-search-bump-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    store = new MemoryStore(join(tempDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Insert a memory directly with a known id, embedding, and access_count=0. */
  function insertMemory(id: string, content: string, embedding: Float32Array): void {
    const db = store.getDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO memories (id, content, source, importance, tags, created_at, updated_at, accessed_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, content, "manual", 0.5, "[]", now, now, now, "warm");
    db.prepare(
      "INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)",
    ).run(id, embedding);
  }

  function insertLink(sourceId: string, targetId: string): void {
    const db = store.getDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT OR IGNORE INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, ?, ?)",
    ).run(sourceId, targetId, targetId, now);
  }

  function getAccessCount(id: string): number {
    const row = store.getDatabase()
      .prepare("SELECT access_count FROM memories WHERE id = ?")
      .get(id) as { access_count: number } | undefined;
    return row?.access_count ?? -1;
  }

  // GS-A1: After GraphSearch returns N graph-neighbor results, each neighbor's
  // access_count is incremented by exactly 1.
  it("GS-A1: bumps access_count by exactly 1 for each graph-walked neighbor returned", () => {
    const queryEmb = makeEmbedding(1);
    const knnEmb = makeSimilarEmbedding(queryEmb, 0.95);
    const neighborEmbA = makeSimilarEmbedding(queryEmb, 0.7);
    const neighborEmbB = makeSimilarEmbedding(queryEmb, 0.65);

    insertMemory("knn-hit", "knn", knnEmb);
    insertMemory("neighbor-a", "neighbor a", neighborEmbA);
    insertMemory("neighbor-b", "neighbor b", neighborEmbB);

    insertLink("knn-hit", "neighbor-a");
    insertLink("neighbor-b", "knn-hit"); // backlink

    const graphSearch = new GraphSearch(store);
    const results = graphSearch.search(queryEmb, 1);

    const neighborIds = results
      .filter((r) => r.source === "graph-neighbor")
      .map((r) => r.id);
    expect(neighborIds).toContain("neighbor-a");
    expect(neighborIds).toContain("neighbor-b");

    expect(getAccessCount("neighbor-a")).toBe(1);
    expect(getAccessCount("neighbor-b")).toBe(1);
  });

  // GS-A2: KNN seed nodes are NOT double-bumped — SemanticSearch.search()
  // already bumps them once at line 102; GraphSearch must not bump them again.
  it("GS-A2: does NOT double-bump KNN seed nodes (semantic-search bumps once)", () => {
    const queryEmb = makeEmbedding(1);
    const knnEmb = makeSimilarEmbedding(queryEmb, 0.95);
    const neighborEmb = makeSimilarEmbedding(queryEmb, 0.7);

    insertMemory("knn-seed", "knn seed", knnEmb);
    insertMemory("graph-neighbor", "neighbor", neighborEmb);
    insertLink("knn-seed", "graph-neighbor");

    const graphSearch = new GraphSearch(store);
    graphSearch.search(queryEmb, 1);

    // KNN hit was bumped exactly once by SemanticSearch — not twice.
    expect(getAccessCount("knn-seed")).toBe(1);
    // Neighbor was bumped once by the new GraphSearch logic.
    expect(getAccessCount("graph-neighbor")).toBe(1);
  });

  // GS-A3: Neighbors below the similarity threshold are excluded from the
  // result set — and must NOT be bumped (they were never returned to the caller).
  it("GS-A3: does NOT bump neighbors below similarity threshold (excluded from results)", () => {
    const queryEmb = makeEmbedding(1);
    const knnEmb = makeSimilarEmbedding(queryEmb, 0.95);
    const dissimilarEmb = makeEmbedding(500); // very dissimilar to query

    insertMemory("knn-hit", "knn", knnEmb);
    insertMemory("dissimilar", "dissimilar neighbor", dissimilarEmb);
    insertLink("knn-hit", "dissimilar");

    // High threshold guarantees exclusion of "dissimilar".
    const graphSearch = new GraphSearch(store, {
      neighborSimilarityThreshold: 0.9,
    });
    const results = graphSearch.search(queryEmb, 1);

    expect(results.find((r) => r.id === "dissimilar")).toBeUndefined();
    // Excluded neighbor's access_count must remain at 0.
    expect(getAccessCount("dissimilar")).toBe(0);
  });

  // GS-A4: Neighbor linked from multiple KNN seeds is bumped only ONCE per
  // search call (deduped by neighborMap, not bumped per linkedFrom edge).
  it("GS-A4: bumps neighbor only once even when linkedFrom.size > 1", () => {
    const queryEmb = makeEmbedding(1);
    const knn1Emb = makeSimilarEmbedding(queryEmb, 0.95);
    const knn2Emb = makeSimilarEmbedding(queryEmb, 0.9);
    const sharedEmb = makeSimilarEmbedding(queryEmb, 0.7);

    insertMemory("knn-1", "knn 1", knn1Emb);
    insertMemory("knn-2", "knn 2", knn2Emb);
    insertMemory("shared", "shared neighbor", sharedEmb);

    insertLink("knn-1", "shared");
    insertLink("knn-2", "shared");

    const graphSearch = new GraphSearch(store);
    const results = graphSearch.search(queryEmb, 2);

    const sharedResult = results.find((r) => r.id === "shared");
    expect(sharedResult).toBeDefined();
    expect(sharedResult!.linkedFrom).toBeDefined();
    expect(sharedResult!.linkedFrom!.length).toBe(2); // confirm multi-link

    // Despite being linked from BOTH knn-1 and knn-2, access_count must be
    // bumped exactly once (not twice).
    expect(getAccessCount("shared")).toBe(1);
  });

  // GS-A5: Neighbors that survive similarity gating but get dropped by the
  // maxNeighbors cap (sortedNeighbors.slice) MUST NOT be bumped — they are
  // not returned to the caller and have not contributed to any heat signal.
  it("GS-A5: does NOT bump neighbors dropped by maxNeighbors cap", () => {
    const queryEmb = makeEmbedding(1);
    const knnEmb = makeSimilarEmbedding(queryEmb, 0.95);

    insertMemory("knn-hit", "knn", knnEmb);

    // Insert 5 neighbors with descending similarity to the query.
    // mixFactor 0.85, 0.83, 0.81, 0.79, 0.77 — all above default threshold (0.5)
    // but ranked by similarity descending.
    const mixFactors = [0.85, 0.83, 0.81, 0.79, 0.77];
    const neighborIds: string[] = [];
    for (let i = 0; i < mixFactors.length; i++) {
      const id = `neighbor-${i}`;
      neighborIds.push(id);
      insertMemory(id, `neighbor ${i}`, makeSimilarEmbedding(queryEmb, mixFactors[i]));
      insertLink("knn-hit", id);
    }

    // Cap maxNeighbors at 2 — only the top-2 should be returned & bumped.
    const graphSearch = new GraphSearch(store, { maxNeighbors: 2, maxTotalResults: 100 });
    const results = graphSearch.search(queryEmb, 1);

    const returnedNeighborIds = new Set(
      results.filter((r) => r.source === "graph-neighbor").map((r) => r.id),
    );
    expect(returnedNeighborIds.size).toBe(2);

    // Returned neighbors: bumped to 1.
    // Dropped neighbors: still at 0.
    let bumpedCount = 0;
    let unbumpedCount = 0;
    for (const id of neighborIds) {
      const ac = getAccessCount(id);
      if (returnedNeighborIds.has(id)) {
        expect(ac).toBe(1);
        bumpedCount++;
      } else {
        expect(ac).toBe(0);
        unbumpedCount++;
      }
    }
    expect(bumpedCount).toBe(2);
    expect(unbumpedCount).toBe(3);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical normalized vectors", () => {
    const vec = makeEmbedding(42);
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
  });

  it("returns value between -1 and 1", () => {
    const a = makeEmbedding(1);
    const b = makeEmbedding(2);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThanOrEqual(-1);
    expect(sim).toBeLessThanOrEqual(1);
  });
});
