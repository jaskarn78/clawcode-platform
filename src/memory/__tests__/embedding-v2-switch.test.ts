/**
 * Phase 999.119 v2 switch — every read path follows the agent's migration
 * phase, v2 distances land on the v1 scale, the runner backfills chunks,
 * and a v2-reading agent's linker / graph walk / retrieval all run in v2.
 *
 * Vectors are synthetic: v1 and v2 spaces are deliberately DIFFERENT for
 * the same memory so a test can tell which table served a query.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { MemoryStore } from "../store.js";
import { SemanticSearch } from "../search.js";
import { GraphSearch } from "../graph-search.js";
import { autoLinkMemory, discoverAutoLinks } from "../similarity.js";
import { retrieveMemoryChunks } from "../memory-retrieval.js";
import { checkForDuplicate, mergeMemory } from "../dedup.js";
import { EmbeddingV2Migrator } from "../migrations/embedding-v2.js";
import { runReEmbedBatch } from "../migrations/embedding-v2-runner.js";
import { shouldDualWriteV2 } from "../embedding-v2-dual-write.js";
import { quantizeInt8 } from "../embedder-quantize.js";
import {
  normalizeDistance,
  normalizeSimilarity,
  readVersionForPhase,
  toQueryVector,
  type QueryVector,
} from "../embedding-version.js";

/** Unit vector along `axis`, optionally blended with a second axis. */
function unit(axis: number, blendAxis?: number, blend = 0): Float32Array {
  const v = new Float32Array(384);
  v[axis] = 1;
  if (blendAxis !== undefined && blend > 0) {
    v[axis] = Math.sqrt(1 - blend * blend);
    v[blendAxis] = blend;
  }
  return v;
}

const v2Query = (float: Float32Array): QueryVector =>
  Object.freeze({ version: "v2" as const, vector: quantizeInt8(float), float });

function advanceTo(m: EmbeddingV2Migrator, phase: "dual-write" | "re-embedding" | "re-embed-complete" | "cutover"): void {
  const order = ["dual-write", "re-embedding", "re-embed-complete", "cutover"] as const;
  for (const p of order) {
    m.transition(p);
    if (p === phase) return;
  }
}

let store: MemoryStore;
const silent = pino({ level: "silent" });

beforeEach(() => {
  store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
});
afterEach(() => store.close());

describe("embedding-version helpers", () => {
  it("maps v2 similarities onto the v1 scale and leaves v1 alone", () => {
    expect(normalizeSimilarity(0.5, "v2")).toBe(0);
    expect(normalizeSimilarity(0.75, "v2")).toBeCloseTo(0.5, 6);
    expect(normalizeSimilarity(1, "v2")).toBe(1);
    expect(normalizeSimilarity(0.2, "v2")).toBe(0); // clamped
    expect(normalizeSimilarity(0.42, "v1")).toBe(0.42);
    expect(normalizeDistance(0.25, "v2")).toBeCloseTo(0.5, 6);
    expect(normalizeDistance(0.25, "v1")).toBe(0.25);
  });

  it("reads v2 only from cutover on", () => {
    expect(readVersionForPhase("idle")).toBe("v1");
    expect(readVersionForPhase("dual-write")).toBe("v1");
    expect(readVersionForPhase("re-embed-complete")).toBe("v1");
    expect(readVersionForPhase("cutover")).toBe("v2");
    expect(readVersionForPhase("v1-dropped")).toBe("v2");
    expect(readVersionForPhase("rolled-back")).toBe("v1");
  });

  it("wraps a bare Float32Array as a v1 query", () => {
    const q = toQueryVector(unit(0));
    expect(q.version).toBe("v1");
    expect(toQueryVector(v2Query(unit(0))).version).toBe("v2");
  });
});

describe("MemoryStore read version + v2 search", () => {
  it("flips getEmbeddingReadVersion at cutover and back on rollback", () => {
    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    expect(store.getEmbeddingReadVersion()).toBe("v1");
    advanceTo(m, "re-embed-complete");
    expect(store.getEmbeddingReadVersion()).toBe("v1");
    m.transition("cutover");
    expect(store.getEmbeddingReadVersion()).toBe("v2");
    m.transition("rolled-back");
    expect(store.getEmbeddingReadVersion()).toBe("v1");
  });

  it("serves a v2 query from vec_memories_v2 with distances on the v1 scale", () => {
    // v1 space: a≈axis0, b≈axis1. v2 space: the OPPOSITE — a≈axis1, b≈axis0.
    const a = store.insert({ content: "alpha", source: "manual" }, unit(0));
    const b = store.insert({ content: "beta", source: "manual" }, unit(1));
    store.insertEmbeddingV2(a.id, quantizeInt8(unit(1)));
    store.insertEmbeddingV2(b.id, quantizeInt8(unit(0)));

    const v1Hits = store.searchMemoriesVec(unit(0), 2);
    expect(v1Hits[0]?.memory_id).toBe(a.id);

    const v2Hits = store.searchMemoriesVec(v2Query(unit(0)), 2);
    expect(v2Hits[0]?.memory_id).toBe(b.id);
    // Exact match: raw v2 distance ≈ 0 → normalized 0; orthogonal: raw 1 → 1 - ((0-0.5)/0.5 → clamped 0) = 1
    expect(v2Hits[0]!.distance).toBeLessThan(0.05);
    expect(v2Hits[1]!.distance).toBeGreaterThan(0.95);
    expect(v2Hits[0]).toMatchObject({ tier: "warm" });
  });

  it("a v2 vector with a 0.75 raw cosine reads as 0.5 on the v1 scale", () => {
    const a = store.insert({ content: "a", source: "manual" }, unit(0));
    store.insertEmbeddingV2(a.id, quantizeInt8(unit(0)));
    // cos(query, a) = 0.75 → normalized similarity 0.5 → distance 0.5
    const hits = store.searchMemoriesVec(v2Query(unit(0, 1, Math.sqrt(1 - 0.75 * 0.75))), 1);
    expect(1 - hits[0]!.distance).toBeCloseTo(0.5, 1);
  });

  it("searchMemoryChunksVec follows the query space", () => {
    const chunkId = store.insertMemoryChunk({
      path: "/ws/memory/x.md",
      chunkIndex: 0,
      heading: "h",
      body: "chunk",
      tokenCount: 1,
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: "sha",
      embedding: unit(0),
    });
    store.insertChunkEmbeddingV2(chunkId, quantizeInt8(unit(2)));
    expect(store.searchMemoryChunksVec(unit(0), 1)[0]?.chunk_id).toBe(chunkId);
    const v2 = store.searchMemoryChunksVec(v2Query(unit(2)), 1);
    expect(v2[0]?.chunk_id).toBe(chunkId);
    expect(v2[0]!.distance).toBeLessThan(0.05);
    // orthogonal in v2 → distance 1 on the v1 scale
    expect(store.searchMemoryChunksVec(v2Query(unit(0)), 1)[0]!.distance).toBeGreaterThan(0.95);
  });

  it("getEmbeddingV2 / getStoredVectorFloat round-trip the stored int8 vector", () => {
    const a = store.insert({ content: "a", source: "manual" }, unit(0));
    expect(store.getEmbeddingV2(a.id)).toBeNull();
    store.insertEmbeddingV2(a.id, quantizeInt8(unit(3)));
    const q = store.getEmbeddingV2(a.id)!;
    expect(q.length).toBe(384);
    const f = store.getStoredVectorFloat(a.id, "v2")!;
    expect(f[3]).toBeGreaterThan(0.99);
    expect(store.getStoredVectorFloat(a.id, "v1")![0]).toBe(1);
  });
});

describe("SemanticSearch + GraphSearch in v2", () => {
  it("SemanticSearch picks the table by query space and scores on the v1 scale", () => {
    const a = store.insert({ content: "alpha", source: "manual", importance: 0.5 }, unit(0));
    const b = store.insert({ content: "beta", source: "manual", importance: 0.5 }, unit(1));
    store.insertEmbeddingV2(a.id, quantizeInt8(unit(1)));
    store.insertEmbeddingV2(b.id, quantizeInt8(unit(0)));
    const search = new SemanticSearch(store.getDatabase());
    expect(search.search(unit(0), 1)[0]?.id).toBe(a.id);
    const v2 = search.search(v2Query(unit(0)), 2);
    expect(v2[0]?.id).toBe(b.id);
    expect(v2[0]!.distance).toBeLessThan(0.05);
  });

  it("GraphSearch walks neighbours with v2 vectors when the query is v2", () => {
    const seed = store.insert({ content: "seed", source: "manual" }, unit(0));
    const neighbor = store.insert({ content: "neighbor", source: "manual" }, unit(5));
    // v2: seed≈axis0, neighbour at raw cos 0.9 to the query (→ 0.8 on v1 scale)
    store.insertEmbeddingV2(seed.id, quantizeInt8(unit(0)));
    store.insertEmbeddingV2(neighbor.id, quantizeInt8(unit(0, 1, Math.sqrt(1 - 0.9 * 0.9))));
    store.getGraphStatements().insertLink.run(seed.id, neighbor.id, neighbor.id, new Date().toISOString());

    const results = new GraphSearch(store).search(v2Query(unit(0)), 1);
    const walked = results.find((r) => r.id === neighbor.id);
    expect(results[0]?.id).toBe(seed.id);
    expect(walked?.source).toBe("graph-neighbor");
    expect(walked!.relevanceScore).toBeGreaterThan(0.7);
    expect(walked!.relevanceScore).toBeLessThan(0.9);
  });
});

describe("auto-linker in v2", () => {
  it("links by v2 similarity once reads are on v2, by v1 before", () => {
    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    const db = store.getDatabase();
    // v1: orthogonal (never link). v2: identical (always link).
    const a = store.insert({ content: "a", source: "manual" }, unit(0));
    const b = store.insert({ content: "b", source: "manual" }, unit(1));
    store.insertEmbeddingV2(a.id, quantizeInt8(unit(7)));
    store.insertEmbeddingV2(b.id, quantizeInt8(unit(7)));
    db.prepare("DELETE FROM memory_links").run();

    expect(autoLinkMemory(store, a.id).linksCreated).toBe(0);

    advanceTo(m, "cutover");
    const r = autoLinkMemory(store, a.id);
    expect(r.linksCreated).toBe(2);
    expect(r.errors).toBe(0);
    const links = db.prepare("SELECT source_id, target_id FROM memory_links ORDER BY source_id").all() as Array<{ source_id: string; target_id: string }>;
    expect(links.map((l) => `${l.source_id}->${l.target_id}`).sort()).toEqual([`${a.id}->${b.id}`, `${b.id}->${a.id}`].sort());
  });

  it("falls back to the v1 vector for a memory whose v2 row is still pending", () => {
    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    const db = store.getDatabase();
    const a = store.insert({ content: "a", source: "manual" }, unit(0));
    const b = store.insert({ content: "b", source: "manual" }, unit(0));
    // b has a v2 row, a does not → a's scan uses v1 and still finds b via v1
    store.insertEmbeddingV2(b.id, quantizeInt8(unit(0)));
    db.prepare("DELETE FROM memory_links").run();
    db.prepare("UPDATE memories SET auto_linked_at = NULL").run();
    advanceTo(m, "cutover");

    const r = discoverAutoLinks(store);
    expect(r.errors).toBe(0);
    expect(r.linksCreated).toBe(2);
  });
});

describe("retrieval + dedup + dual-write under v2", () => {
  it("retrieveMemoryChunks with a v2 embed function searches the v2 tables", async () => {
    const a = store.insert({ content: "alpha memory", source: "manual", skipDedup: true }, unit(0));
    const b = store.insert({ content: "beta memory", source: "manual", skipDedup: true }, unit(1));
    store.insertEmbeddingV2(a.id, quantizeInt8(unit(1)));
    store.insertEmbeddingV2(b.id, quantizeInt8(unit(0)));

    const v1 = await retrieveMemoryChunks({ query: "q", store, embed: async () => unit(0), topK: 1 });
    expect(v1[0]?.chunkId).toBe(a.id);
    const v2 = await retrieveMemoryChunks({ query: "q", store, embed: async () => v2Query(unit(0)), topK: 1 });
    expect(v2[0]?.chunkId).toBe(b.id);
  });

  it("dedup stays on v1 and a merge drops the stale v2 row", () => {
    const a = store.insert({ content: "original", source: "manual", skipDedup: true }, unit(0));
    store.insertEmbeddingV2(a.id, quantizeInt8(unit(0)));
    const db = store.getDatabase();
    const decision = checkForDuplicate(unit(0), db, { similarityThreshold: 0.85 });
    // WP5 - cosine 1.0 is a true duplicate (the drop band), not a merge.
    // The deprecated mergeMemory helper is still exercised below.
    expect(decision.action).toBe("duplicate");
    mergeMemory(db, a.id, { content: "merged content", importance: 0.5, tags: [], embedding: unit(0) });
    expect(store.getEmbeddingV2(a.id)).toBeNull();
    expect(store.countMemoriesMissingV2Embedding()).toBe(1);
  });

  it("dual-write stays on through cutover", () => {
    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    expect(shouldDualWriteV2({ store, agent: "agent" })).toBe(false);
    advanceTo(m, "cutover");
    expect(shouldDualWriteV2({ store, agent: "agent" })).toBe(true);
    m.transition("rolled-back");
    expect(shouldDualWriteV2({ store, agent: "agent" })).toBe(false);
  });
});

describe("runner backfills chunks and only then advances", () => {
  it("memories first, then chunks; re-embed-complete only when both are done; keeps running in cutover", async () => {
    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    const a = store.insert({ content: "a", source: "manual", skipDedup: true }, unit(0));
    store.insert({ content: "b", source: "manual", skipDedup: true }, unit(1));
    for (let i = 0; i < 3; i++) {
      store.insertMemoryChunk({
        path: `/ws/memory/${i}.md`,
        chunkIndex: 0,
        heading: null,
        body: `chunk ${i}`,
        tokenCount: 2,
        scoreWeight: 0,
        fileMtimeMs: Date.now(),
        fileSha256: `sha${i}`,
        embedding: unit(10 + i),
      });
    }
    advanceTo(m, "re-embedding");
    const embedder = { embedV2: async (_t: string) => quantizeInt8(unit(20)) };
    const cfg = { cpuBudgetPct: 5, batchSize: 50 };

    const first = await runReEmbedBatch(m, store, embedder, cfg, () => false, silent);
    expect(first.processed).toBe(2);
    expect(store.countMemoriesMissingV2Embedding()).toBe(0);
    expect(store.countChunksMissingV2Embedding()).toBe(3);
    expect(m.getState().phase).toBe("re-embedding"); // chunks still missing

    const second = await runReEmbedBatch(m, store, embedder, cfg, () => false, silent);
    expect(second.processed).toBe(3);
    expect(second.remaining).toBe(0);
    expect(store.countChunksMissingV2Embedding()).toBe(0);
    expect(m.getState().phase).toBe("re-embed-complete");

    // A miss after cutover heals on the next tick.
    m.transition("cutover");
    store.getDatabase().prepare("DELETE FROM vec_memories_v2 WHERE memory_id = ?").run(a.id);
    expect(m.shouldRunReEmbedBatch()).toBe(true);
    // The saved cursor may sit past the missing id: tick 1 resets it, tick 2 heals.
    let healed = 0;
    for (let tick = 0; tick < 3 && healed === 0; tick++) {
      healed += (await runReEmbedBatch(m, store, embedder, cfg, () => false, silent)).processed;
    }
    expect(healed).toBe(1);
    expect(store.countMemoriesMissingV2Embedding()).toBe(0);
    expect(m.getState().phase).toBe("cutover");
  });
});
