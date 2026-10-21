import { describe, it, expect, afterEach } from "vitest";
import { MemoryStore } from "../store.js";
import { SemanticSearch } from "../search.js";

function createTestStore(): MemoryStore {
  // Disable dedup for search tests to avoid unintended merges
  return new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
}

/** Create a normalized random vector. */
function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  let norm = 0;
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.random() * 2 - 1;
    norm += arr[i] * arr[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) {
    arr[i] /= norm;
  }
  return arr;
}

/** Create a vector pointing in a specific direction (for predictable similarity). */
function directionalEmbedding(dim: number, value: number): Float32Array {
  const arr = new Float32Array(384);
  arr[dim] = value;
  // Normalize
  const norm = Math.abs(value);
  if (norm > 0) {
    arr[dim] /= norm;
  }
  return arr;
}

describe("SemanticSearch", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  it("search returns results ordered by distance (nearest first)", () => {
    store = createTestStore();
    const db = store.getDatabase();
    const search = new SemanticSearch(db);

    // Create query vector pointing in dimension 0
    const queryVec = directionalEmbedding(0, 1.0);

    // Create similar vector (close to query)
    const similarVec = new Float32Array(384);
    similarVec[0] = 0.9;
    similarVec[1] = 0.1;
    const norm1 = Math.sqrt(0.81 + 0.01);
    similarVec[0] /= norm1;
    similarVec[1] /= norm1;

    // Create dissimilar vector (far from query)
    const dissimilarVec = directionalEmbedding(1, 1.0);

    store.insert({ content: "dissimilar", source: "manual" }, dissimilarVec);
    store.insert({ content: "similar", source: "manual" }, similarVec);

    const results = search.search(queryVec, 10);
    expect(results.length).toBe(2);
    expect(results[0].content).toBe("similar");
    expect(results[1].content).toBe("dissimilar");
    expect(results[0].distance).toBeLessThan(results[1].distance);
  });

  it("search respects topK limit", () => {
    store = createTestStore();
    const db = store.getDatabase();
    const search = new SemanticSearch(db);

    // Insert 5 memories
    for (let i = 0; i < 5; i++) {
      store.insert(
        { content: `memory-${i}`, source: "manual" },
        randomEmbedding(),
      );
    }

    const results = search.search(randomEmbedding(), 2);
    expect(results.length).toBe(2);
  });

  it("search updates access_count for returned results", () => {
    store = createTestStore();
    const db = store.getDatabase();
    const search = new SemanticSearch(db);

    const entry = store.insert(
      { content: "tracked", source: "manual" },
      randomEmbedding(),
    );

    // Initial access_count is 0
    expect(entry.accessCount).toBe(0);

    // Search should increment access_count
    search.search(randomEmbedding(), 10);

    // Verify via direct DB query (bypass getById which also increments)
    const row = db
      .prepare("SELECT access_count FROM memories WHERE id = ?")
      .get(entry.id) as { access_count: number };
    expect(row.access_count).toBe(1);
  });

  it("search updates accessed_at for returned results", () => {
    store = createTestStore();
    const db = store.getDatabase();
    const search = new SemanticSearch(db);

    const entry = store.insert(
      { content: "tracked", source: "manual" },
      randomEmbedding(),
    );

    const results = search.search(randomEmbedding(), 10);
    expect(results.length).toBe(1);
    expect(results[0].accessedAt).toBeTruthy();
    // accessed_at should be >= original
    expect(results[0].accessedAt >= entry.createdAt).toBe(true);
  });

  it("search with no matching embeddings returns empty array", () => {
    store = createTestStore();
    const db = store.getDatabase();
    const search = new SemanticSearch(db);

    // No memories inserted
    const results = search.search(randomEmbedding(), 10);
    expect(results).toEqual([]);
  });

  it("search results are frozen (readonly)", () => {
    store = createTestStore();
    const db = store.getDatabase();
    const search = new SemanticSearch(db);

    store.insert(
      { content: "test", source: "manual" },
      randomEmbedding(),
    );

    const results = search.search(randomEmbedding(), 10);
    expect(Object.isFrozen(results)).toBe(true);
    if (results.length > 0) {
      expect(Object.isFrozen(results[0])).toBe(true);
    }
  });

  describe("cold tier exclusion", () => {
    it("search does NOT return memories that have been deleted (cold-archived)", () => {
      store = createTestStore();
      const db = store.getDatabase();
      const search = new SemanticSearch(db);

      // Insert a memory
      const vec = randomEmbedding();
      const entry = store.insert(
        { content: "will be cold", source: "manual", importance: 0.5 },
        vec,
      );

      // Simulate cold archival: delete from both tables (what TierManager.archiveToCold does)
      store.delete(entry.id);

      // Search should return nothing
      const results = search.search(vec, 10);
      expect(results.length).toBe(0);
    });

    it("search returns warm and hot memories but not deleted ones", () => {
      store = createTestStore();
      const db = store.getDatabase();
      const search = new SemanticSearch(db);

      const vec1 = directionalEmbedding(0, 1.0);
      const vec2 = new Float32Array(384);
      vec2[0] = 0.95;
      vec2[1] = 0.05;
      const norm = Math.sqrt(vec2[0] ** 2 + vec2[1] ** 2);
      vec2[0] /= norm;
      vec2[1] /= norm;

      // Insert warm memory
      store.insert(
        { content: "warm memory", source: "manual" },
        vec1,
      );

      // Insert and delete (cold archival simulation)
      const coldEntry = store.insert(
        { content: "cold memory", source: "manual" },
        vec2,
      );
      store.delete(coldEntry.id);

      const results = search.search(directionalEmbedding(0, 1.0), 10);
      expect(results.length).toBe(1);
      expect(results[0].content).toBe("warm memory");
    });
  });

  describe("relevance-aware search", () => {
    it("recently accessed memory ranks higher than stale memory with similar distance", () => {
      store = createTestStore();
      const db = store.getDatabase();
      const search = new SemanticSearch(db);

      // Create two memories with the same embedding direction
      const vec = directionalEmbedding(0, 1.0);
      // Slightly different vector so both can coexist
      const vec2 = new Float32Array(384);
      vec2[0] = 0.99;
      vec2[1] = 0.01;
      const norm = Math.sqrt(vec2[0] ** 2 + vec2[1] ** 2);
      vec2[0] /= norm;
      vec2[1] /= norm;

      const staleEntry = store.insert(
        { content: "stale memory", source: "manual", importance: 0.8 },
        vec,
      );
      const recentEntry = store.insert(
        { content: "recent memory", source: "manual", importance: 0.8 },
        vec2,
      );

      // Make the stale entry 60 days old via direct SQL
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE memories SET accessed_at = ? WHERE id = ?").run(
        sixtyDaysAgo,
        staleEntry.id,
      );

      const queryVec = directionalEmbedding(0, 1.0);
      const results = search.search(queryVec, 10);

      expect(results.length).toBe(2);
      // Recent memory should rank first due to higher combined score
      expect(results[0].content).toBe("recent memory");
      expect(results[0].combinedScore).toBeGreaterThan(results[1].combinedScore);
    });

    it("returned objects have relevanceScore and combinedScore fields", () => {
      store = createTestStore();
      const db = store.getDatabase();
      const search = new SemanticSearch(db);

      store.insert(
        { content: "test", source: "manual", importance: 0.5 },
        randomEmbedding(),
      );

      const results = search.search(randomEmbedding(), 10);
      expect(results.length).toBeGreaterThan(0);
      expect(typeof results[0].relevanceScore).toBe("number");
      expect(typeof results[0].combinedScore).toBe("number");
      expect(results[0].relevanceScore).toBeGreaterThanOrEqual(0);
      expect(results[0].combinedScore).toBeGreaterThanOrEqual(0);
    });

    it("accessed_at is updated after search for returned results", () => {
      store = createTestStore();
      const db = store.getDatabase();
      const search = new SemanticSearch(db);

      const entry = store.insert(
        { content: "tracked", source: "manual" },
        randomEmbedding(),
      );

      // Set accessed_at to a known old value
      const oldTime = "2020-01-01T00:00:00.000Z";
      db.prepare("UPDATE memories SET accessed_at = ? WHERE id = ?").run(
        oldTime,
        entry.id,
      );

      const results = search.search(randomEmbedding(), 10);
      expect(results.length).toBe(1);
      // accessed_at should be updated to after the old value
      expect(results[0].accessedAt > oldTime).toBe(true);

      // Verify in DB too
      const row = db.prepare("SELECT accessed_at FROM memories WHERE id = ?").get(entry.id) as { accessed_at: string };
      expect(row.accessed_at > oldTime).toBe(true);
    });
  });
});
