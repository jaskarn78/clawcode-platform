import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { MemoryStore } from "../store.js";
import { autoLinkMemory, discoverAutoLinks, cosineSimilarity } from "../similarity.js";

/** Row shape from memory_links table. */
type LinkRow = {
  readonly source_id: string;
  readonly target_id: string;
  readonly link_text: string;
  readonly created_at: string;
};

/**
 * Create a normalized embedding with a dominant direction.
 * Uses dimension `dim` as the dominant axis with `strength` magnitude,
 * then L2-normalizes the result. Two embeddings with the same dominant
 * dimension will have high cosine similarity; different dimensions = low.
 */
function makeEmbedding(dim: number, strength = 10): Float32Array {
  const vec = new Float32Array(384);
  vec[dim] = strength;
  // Normalize to unit length (required for cosine distance in sqlite-vec)
  const mag = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  for (let i = 0; i < vec.length; i++) {
    vec[i] = vec[i] / mag;
  }
  return vec;
}

/** Insert a memory with a known ID directly into SQLite (bypasses store.insert to avoid dedup). */
function insertWithKnownId(
  db: DatabaseType,
  id: string,
  content: string,
  embedding: Float32Array,
  tier: string = "warm",
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (id, content, source, importance, access_count, tags, created_at, updated_at, accessed_at, tier)
     VALUES (?, ?, 'manual', 0.5, 0, '[]', ?, ?, ?, ?)`,
  ).run(id, content, now, now, now, tier);
  db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run(
    id,
    embedding,
  );
}

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical normalized vectors", () => {
    const v = makeEmbedding(0);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns ~0 for orthogonal vectors", () => {
    const a = makeEmbedding(0);
    const b = makeEmbedding(1);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });
});

describe("autoLinkMemory", () => {
  let store: MemoryStore;
  let db: DatabaseType;

  beforeEach(() => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
  });

  it("creates bidirectional edges between similar memories", () => {
    // Two memories with same dominant dimension = high similarity
    const embA = makeEmbedding(0);
    const embB = makeEmbedding(0);
    insertWithKnownId(db, "mem-a", "Content about topic A", embA);
    insertWithKnownId(db, "mem-b", "Content about topic A similar", embB);

    const result = autoLinkMemory(store, "mem-a");

    expect(result.linksCreated).toBe(2); // bidirectional
    expect(result.pairsScanned).toBeGreaterThanOrEqual(1);
    expect(result.skippedExisting).toBe(0);

    // Verify both directions exist
    const links = db.prepare("SELECT * FROM memory_links ORDER BY source_id").all() as LinkRow[];
    expect(links).toHaveLength(2);
    const directions = links.map((l) => `${l.source_id}->${l.target_id}`).sort();
    expect(directions).toEqual(["mem-a->mem-b", "mem-b->mem-a"]);
    expect(links[0].link_text).toBe("auto:similar");
  });

  it("skips cold-tier neighbors", () => {
    const emb = makeEmbedding(0);
    insertWithKnownId(db, "mem-warm", "Warm topic content", emb);
    insertWithKnownId(db, "mem-cold", "Cold topic content", emb, "cold");

    const result = autoLinkMemory(store, "mem-warm");

    expect(result.linksCreated).toBe(0);
    const links = db.prepare("SELECT * FROM memory_links").all();
    expect(links).toHaveLength(0);
  });

  it("skips already-linked pairs", () => {
    const emb = makeEmbedding(0);
    insertWithKnownId(db, "mem-1", "Topic content one", emb);
    insertWithKnownId(db, "mem-2", "Topic content two", emb);

    // Pre-create edge in one direction
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, ?, ?)",
    ).run("mem-1", "mem-2", "auto:similar", now);
    db.prepare(
      "INSERT INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, ?, ?)",
    ).run("mem-2", "mem-1", "auto:similar", now);

    const result = autoLinkMemory(store, "mem-1");

    expect(result.skippedExisting).toBeGreaterThanOrEqual(1);
    expect(result.linksCreated).toBe(0);
  });

  it("returns zero-result when memory has no embedding", () => {
    // Insert a memory with no embedding entry in vec_memories
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO memories (id, content, source, importance, access_count, tags, created_at, updated_at, accessed_at, tier)
       VALUES (?, ?, 'manual', 0.5, 0, '[]', ?, ?, ?, 'warm')`,
    ).run("no-emb", "No embedding content", now, now, now);

    const result = autoLinkMemory(store, "no-emb");

    expect(result.linksCreated).toBe(0);
    expect(result.pairsScanned).toBe(0);
    expect(result.skippedExisting).toBe(0);
  });

  it("does not link dissimilar memories (below threshold)", () => {
    // Orthogonal embeddings = cosine similarity ~0
    const embA = makeEmbedding(0);
    const embB = makeEmbedding(1);
    insertWithKnownId(db, "mem-x", "Topic X", embA);
    insertWithKnownId(db, "mem-y", "Topic Y", embB);

    const result = autoLinkMemory(store, "mem-x");

    expect(result.linksCreated).toBe(0);
  });

  it("accepts optional threshold override", () => {
    const emb = makeEmbedding(0);
    insertWithKnownId(db, "mem-p", "Topic P", emb);
    insertWithKnownId(db, "mem-q", "Topic Q", emb);

    // With very high threshold, identical vectors should still link
    const result = autoLinkMemory(store, "mem-p", { similarityThreshold: 0.99 });
    expect(result.linksCreated).toBe(2);
  });

  it("returns frozen result", () => {
    const emb = makeEmbedding(0);
    insertWithKnownId(db, "mem-f", "Frozen test", emb);

    const result = autoLinkMemory(store, "mem-f");
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe("discoverAutoLinks (existing)", () => {
  let store: MemoryStore;
  let db: DatabaseType;

  beforeEach(() => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
  });

  it("still works independently after autoLinkMemory addition", () => {
    const emb = makeEmbedding(0);
    insertWithKnownId(db, "disc-a", "Discover A", emb);
    insertWithKnownId(db, "disc-b", "Discover B", emb);

    const result = discoverAutoLinks(store);

    expect(result.linksCreated).toBe(2); // bidirectional
    expect(result.pairsScanned).toBeGreaterThanOrEqual(1);
  });
});

describe("Phase 999.119 — linker hardening", () => {
  let store: MemoryStore;
  let db: DatabaseType;

  beforeEach(() => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
  });

  /** Leave a vec_memories row behind with no memories row (the prod shape). */
  function insertOrphanVec(id: string, embedding: Float32Array): void {
    db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run(id, embedding);
  }

  it("skips a KNN neighbour whose memory row is gone instead of failing the FK", () => {
    const emb = makeEmbedding(0);
    insertWithKnownId(db, "live-a", "Live A", emb);
    insertWithKnownId(db, "live-b", "Live B", emb);
    insertOrphanVec("ghost-1", emb); // identical vector → top KNN hit

    const result = discoverAutoLinks(store);

    // The JOIN in searchMemoriesVec means the ghost is never even seen.
    expect(result.errors).toBe(0);
    expect(result.orphansSkipped).toBe(0);
    expect(result.linksCreated).toBe(2);
    const links = db.prepare("SELECT source_id, target_id FROM memory_links ORDER BY source_id").all() as LinkRow[];
    expect(links.map((l) => `${l.source_id}->${l.target_id}`)).toEqual(["live-a->live-b", "live-b->live-a"]);
  });

  it("eager autoLinkMemory also skips ghost neighbours", () => {
    const emb = makeEmbedding(0);
    insertWithKnownId(db, "eager-a", "Eager A", emb);
    insertOrphanVec("ghost-2", emb);

    const result = autoLinkMemory(store, "eager-a");

    expect(result.errors).toBe(0);
    expect(result.linksCreated).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_links").get()).toEqual({ n: 0 });
  });

  it("isolates one failing candidate — the others still get their links", () => {
    const emb = makeEmbedding(0);
    insertWithKnownId(db, "iso-a", "Iso A", emb);
    insertWithKnownId(db, "iso-b", "Iso B", emb);
    const other = makeEmbedding(1);
    insertWithKnownId(db, "iso-c", "Iso C", other);
    insertWithKnownId(db, "iso-d", "Iso D", other);

    const realGet = store.getEmbedding.bind(store);
    const spy = vi.spyOn(store, "getEmbedding").mockImplementation((id: string) => {
      if (id === "iso-c") throw new Error("simulated read failure");
      return realGet(id);
    });
    const result = discoverAutoLinks(store);
    spy.mockRestore();

    expect(result.errors).toBe(1);
    expect(result.firstError).toContain("iso-c");
    expect(result.firstError).toContain("simulated read failure");
    // a<->b linked; d scanned after c's failure and linked to c
    expect(result.linksCreated).toBe(4);
  });

  it("advances through the backlog via the auto_linked_at cursor instead of re-scanning the same rows", () => {
    // Four memories with no similar neighbour (each in its own direction):
    // pre-999.119 they stayed candidates forever and every pass re-scanned
    // the same newest rows.
    for (let i = 0; i < 4; i++) {
      insertWithKnownId(db, `lonely-${i}`, `Lonely ${i}`, makeEmbedding(i));
    }

    const first = discoverAutoLinks(store, { batchSize: 2 });
    const second = discoverAutoLinks(store, { batchSize: 2 });
    const third = discoverAutoLinks(store, { batchSize: 2 });

    expect(first.pairsScanned).toBe(2);
    expect(second.pairsScanned).toBe(2);
    expect(third.pairsScanned).toBe(0); // backlog drained
    const stamped = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE auto_linked_at IS NOT NULL").get() as { n: number };
    expect(stamped.n).toBe(4);
  });

  it("re-scans a memory once its stamp is older than rescanAfterDays", () => {
    insertWithKnownId(db, "stale-scan", "Stale", makeEmbedding(0));
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE memories SET auto_linked_at = ? WHERE id = 'stale-scan'").run(longAgo);

    expect(discoverAutoLinks(store, { rescanAfterDays: 365 }).pairsScanned).toBe(0);
    expect(discoverAutoLinks(store, { rescanAfterDays: 90 }).pairsScanned).toBe(1);
  });

  it("eager insert stamps the new memory as scanned", () => {
    const entry = store.insert({ content: "fresh", source: "manual" }, makeEmbedding(3));
    const row = db.prepare("SELECT auto_linked_at FROM memories WHERE id = ?").get(entry.id) as { auto_linked_at: string | null };
    expect(row.auto_linked_at).not.toBeNull();
  });
});
