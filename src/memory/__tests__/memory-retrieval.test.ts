import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../store.js";
import {
  rrfFuse,
  retrieveMemoryChunks,
} from "../memory-retrieval.js";

function deterministicEmbedding(seed: number): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.sin(seed * 0.1 + i * 0.01);
  }
  // L2-normalize for cosine stability
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) arr[i] = arr[i] / norm;
  return arr;
}

async function testEmbed(text: string): Promise<Float32Array> {
  // Stable per-text embedding: hash string to seed.
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return deterministicEmbedding(Math.abs(h));
}

describe("memory-retrieval RRF (Phase 90 MEM-03)", () => {
  describe("rrfFuse", () => {
    it("MEM-03-R1: sorts fused scores by 1/(k+r1)+1/(k+r2)", () => {
      const fused = rrfFuse(
        [
          { chunk_id: "a", distance: 0.1 },
          { chunk_id: "b", distance: 0.2 },
        ],
        [
          { chunk_id: "b", rank: -1 },
          { chunk_id: "c", rank: -2 },
        ],
        60,
      );
      const ids = fused.map((f) => f.chunk_id);
      expect(ids[0]).toBe("b"); // shared top → best fused
      expect(ids).toContain("a");
      expect(ids).toContain("c");
    });

    it("MEM-03-R1b: empty inputs → empty output", () => {
      expect(rrfFuse([], [], 60)).toEqual([]);
    });
  });

  describe("retrieveMemoryChunks", () => {
    let store: MemoryStore;

    beforeEach(() => {
      store = new MemoryStore(":memory:");
    });

    afterEach(() => {
      store.close();
    });

    it("MEM-03-R2: semantic query surfaces matching chunk (Zaid investment)", async () => {
      // Seed 5 chunks; the target chunk shares its embedding with the query.
      const targetBody = "Zaid wants 40% in SGOV for safety allocation";
      const queryEmbedding = await testEmbed("Zaid investment proportion");
      // Target chunk embedded with same text as query for guaranteed top-1
      store.insertMemoryChunk({
        path: "/ws/memory/2026-04-24-zaid.md",
        chunkIndex: 0,
        heading: "Investment",
        body: targetBody,
        tokenCount: 20,
        scoreWeight: 0,
        fileMtimeMs: Date.now(),
        fileSha256: "zaid",
        embedding: queryEmbedding, // Simulate strong semantic match
      });
      for (let i = 0; i < 4; i++) {
        store.insertMemoryChunk({
          path: `/ws/memory/2026-04-24-other-${i}.md`,
          chunkIndex: 0,
          heading: `Other ${i}`,
          body: `Unrelated content about weather ${i}`,
          tokenCount: 10,
          scoreWeight: 0,
          fileMtimeMs: Date.now(),
          fileSha256: `other-${i}`,
          embedding: deterministicEmbedding(i + 1000),
        });
      }

      const results = await retrieveMemoryChunks({
        query: "Zaid investment proportion",
        store,
        embed: testEmbed,
        topK: 5,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].body).toContain("Zaid");
      expect(results[0].body).toContain("SGOV");
    });

    it("MEM-03-R3: time window excludes old dated files, keeps vault all-time", async () => {
      const now = Date.now();
      const oldMtime = now - 30 * 86_400_000;

      // Old dated file — should be filtered out
      store.insertMemoryChunk({
        path: "/ws/memory/2026-03-01-old.md",
        chunkIndex: 0,
        heading: "Old",
        body: "ancient dated note",
        tokenCount: 10,
        scoreWeight: 0,
        fileMtimeMs: oldMtime,
        fileSha256: "old",
        embedding: deterministicEmbedding(100),
      });
      // Old vault file — should be kept
      store.insertMemoryChunk({
        path: "/ws/memory/vault/rules.md",
        chunkIndex: 0,
        heading: "Rules",
        body: "standing rules",
        tokenCount: 10,
        scoreWeight: 0.2,
        fileMtimeMs: oldMtime,
        fileSha256: "vault",
        embedding: deterministicEmbedding(200),
      });

      const qEmb = await testEmbed("anything");
      const results = await retrieveMemoryChunks({
        query: "anything",
        store,
        embed: async () => qEmb, // same embedding → both semantic-match
        topK: 10,
        timeWindowDays: 14,
      });
      const paths = results.map((r) => r.path);
      expect(paths).toContain("/ws/memory/vault/rules.md");
      expect(paths).not.toContain("/ws/memory/2026-03-01-old.md");
    });

    it("MEM-03-R5: topK truncates results", async () => {
      for (let i = 0; i < 10; i++) {
        store.insertMemoryChunk({
          path: `/ws/memory/2026-04-24-n${i}.md`,
          chunkIndex: 0,
          heading: `N${i}`,
          body: `content ${i}`,
          tokenCount: 5,
          scoreWeight: 0,
          fileMtimeMs: Date.now(),
          fileSha256: `n${i}`,
          embedding: deterministicEmbedding(i),
        });
      }
      const results = await retrieveMemoryChunks({
        query: "content",
        store,
        embed: testEmbed,
        topK: 3,
      });
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("MEM-03-R6: score_weight nudges vault above archive for equal-distance chunks", async () => {
      const sharedEmb = await testEmbed("shared");
      store.insertMemoryChunk({
        path: "/ws/memory/vault/good.md",
        chunkIndex: 0,
        heading: "Good",
        body: "vault content",
        tokenCount: 5,
        scoreWeight: 0.2,
        fileMtimeMs: Date.now(),
        fileSha256: "g",
        embedding: sharedEmb,
      });
      store.insertMemoryChunk({
        path: "/ws/memory/archive/bad.md",
        chunkIndex: 0,
        heading: "Bad",
        body: "archive content",
        tokenCount: 5,
        scoreWeight: -0.2,
        fileMtimeMs: Date.now(),
        fileSha256: "b",
        embedding: sharedEmb,
      });
      const results = await retrieveMemoryChunks({
        query: "shared",
        store,
        embed: async () => sharedEmb,
        topK: 5,
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].path).toBe("/ws/memory/vault/good.md");
    });

    it("MEM-03-R7: empty store returns empty array (no throw)", async () => {
      const results = await retrieveMemoryChunks({
        query: "whatever",
        store,
        embed: testEmbed,
        topK: 5,
      });
      expect(results).toEqual([]);
    });
  });

  /**
   * Phase 100-fu — Option A: include `memories` table in pre-turn retrieval.
   *
   * Bug: retrieveMemoryChunks only searched memory_chunks (file-scanner table
   * for MEMORY.md content). It did NOT search `memories` (where the agent
   * saves things via memory_save). Conversational memory was invisible in
   * the pre-turn <memory-context> block. Silent-recall problem.
   *
   * Fix: add searchMemoriesVec sibling helper on MemoryStore, fan out both
   * searches in parallel via Promise.all, RRF-fuse results, tag each result
   * with `source: "chunk" | "memory"`.
   */
  describe("retrieveMemoryChunks — memories table fan-out (Phase 100-fu)", () => {
    let store: MemoryStore;

    beforeEach(() => {
      store = new MemoryStore(":memory:");
    });

    afterEach(() => {
      store.close();
    });

    it("PMR-A1: chunks-only search yields results all tagged source='chunk'", async () => {
      const qEmb = await testEmbed("alpha");
      store.insertMemoryChunk({
        path: "/ws/memory/note.md",
        chunkIndex: 0,
        heading: "N",
        body: "alpha content",
        tokenCount: 5,
        scoreWeight: 0,
        fileMtimeMs: Date.now(),
        fileSha256: "n",
        embedding: qEmb,
      });

      const results = await retrieveMemoryChunks({
        query: "alpha",
        store,
        embed: async () => qEmb,
        topK: 5,
      });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.source).toBe("chunk");
      }
    });

    it("PMR-A2: memories-only search yields results all tagged source='memory'", async () => {
      const qEmb = await testEmbed("delegation pattern");
      // Empty memory_chunks; insert into memories table only.
      store.insert(
        {
          content: "Use spawn_subagent_thread for delegation patterns.",
          source: "manual",
          importance: 0.7,
          tags: ["pattern", "delegation"],
          skipDedup: true,
        },
        qEmb,
      );

      const results = await retrieveMemoryChunks({
        query: "delegation pattern",
        store,
        embed: async () => qEmb,
        topK: 5,
      });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.source).toBe("memory");
      }
      // Memory results carry the saved content as body
      expect(results[0]!.body).toContain("spawn_subagent_thread");
    });

    it("PMR-A3: mixed results include both surfaces, RRF-fused", async () => {
      const qEmb = await testEmbed("hybrid query");
      // Chunk-side
      store.insertMemoryChunk({
        path: "/ws/memory/file.md",
        chunkIndex: 0,
        heading: "F",
        body: "chunk body for hybrid",
        tokenCount: 5,
        scoreWeight: 0,
        fileMtimeMs: Date.now(),
        fileSha256: "f",
        embedding: qEmb,
      });
      // Memory-side
      store.insert(
        {
          content: "memory body for hybrid",
          source: "manual",
          importance: 0.5,
          tags: ["t"],
          skipDedup: true,
        },
        qEmb,
      );

      const results = await retrieveMemoryChunks({
        query: "hybrid query",
        store,
        embed: async () => qEmb,
        topK: 10,
      });
      const sources = new Set(results.map((r) => r.source));
      expect(sources.has("chunk")).toBe(true);
      expect(sources.has("memory")).toBe(true);
      // Sorted by fusedScore desc
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.fusedScore).toBeGreaterThanOrEqual(
          results[i]!.fusedScore,
        );
      }
    });

    it("PMR-A4: token-budget cap applies across combined chunk+memory set", async () => {
      const qEmb = await testEmbed("budget");
      // Insert several large chunks AND several large memories.
      const big = "x".repeat(500);
      for (let i = 0; i < 4; i++) {
        store.insertMemoryChunk({
          path: `/ws/memory/c${i}.md`,
          chunkIndex: 0,
          heading: `C${i}`,
          body: big,
          tokenCount: 125,
          scoreWeight: 0,
          fileMtimeMs: Date.now(),
          fileSha256: `c${i}`,
          embedding: qEmb,
        });
      }
      for (let i = 0; i < 4; i++) {
        store.insert(
          {
            content: big,
            source: "manual",
            importance: 0.5,
            tags: [],
            skipDedup: true,
          },
          qEmb,
        );
      }

      // tokenBudget=200 -> budget*4 = 800 chars total.
      const results = await retrieveMemoryChunks({
        query: "budget",
        store,
        embed: async () => qEmb,
        topK: 20,
        tokenBudget: 200,
      });
      // We must always emit at least the first; subsequent should be cut by budget
      expect(results.length).toBeGreaterThanOrEqual(1);
      const totalChars = results.reduce((acc, r) => acc + r.body.length, 0);
      // First chunk is allowed even if it exceeds; further chunks are not added
      // once the cumulative length crosses tokenBudget*4. So we expect at most 2.
      expect(results.length).toBeLessThanOrEqual(2);
      // Sanity: across both surfaces, not >> budget*4 (allow first to be over)
      expect(totalChars).toBeLessThanOrEqual(big.length * 2 + 10);
    });

    it("PMR-A5: empty query and empty store both return [] without throwing", async () => {
      // Empty query
      const r1 = await retrieveMemoryChunks({
        query: "   ",
        store,
        embed: testEmbed,
        topK: 5,
      });
      expect(r1).toEqual([]);

      // Empty store, non-empty query
      const r2 = await retrieveMemoryChunks({
        query: "anything",
        store,
        embed: testEmbed,
        topK: 5,
      });
      expect(r2).toEqual([]);
    });
  });
});

describe("retrieveMemoryChunks — Phase 999.119 recency touch", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("touches accessed_at (not access_count) for the memories that reach the prompt", async () => {
    const query = "what did Zaid want";
    const qEmb = await testEmbed(query);
    const used = store.insert({ content: "Zaid wants 40% in SGOV", source: "manual", skipDedup: true }, qEmb);
    const unused = store.insert({ content: "unrelated weather", source: "manual", skipDedup: true }, deterministicEmbedding(5000));
    const db = store.getDatabase();
    db.prepare("UPDATE memories SET accessed_at = '2026-01-01T00:00:00.000Z' WHERE id IN (?, ?)").run(used.id, unused.id);

    const now = Date.parse("2026-09-05T12:00:00.000Z");
    const results = await retrieveMemoryChunks({ query, store, embed: testEmbed, topK: 1, now });

    expect(results.map((r) => r.chunkId)).toEqual([used.id]);
    const rows = db.prepare("SELECT id, accessed_at, access_count FROM memories").all() as Array<{ id: string; accessed_at: string; access_count: number }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(used.id)?.accessed_at).toBe("2026-09-05T12:00:00.000Z");
    expect(byId.get(used.id)?.access_count).toBe(0);
    expect(byId.get(unused.id)?.accessed_at).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("retrieveMemoryChunks — Phase 999.119 pass 2 decay-weighted memories side", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("at equal distance, the important + recently-used memory outranks the decayed one", async () => {
    const query = "quarterly planning";
    const qEmb = await testEmbed(query);
    const decayed = store.insert(
      { content: "decayed planning note", source: "manual", importance: 0.1, skipDedup: true },
      qEmb,
    );
    const fresh = store.insert(
      { content: "fresh planning note", source: "manual", importance: 0.9, skipDedup: true },
      qEmb,
    );
    const db = store.getDatabase();
    db.prepare("UPDATE memories SET accessed_at = '2026-01-01T00:00:00.000Z', tier = 'cold' WHERE id = ?").run(decayed.id);
    db.prepare("UPDATE memories SET accessed_at = '2026-09-04T00:00:00.000Z' WHERE id = ?").run(fresh.id);

    const results = await retrieveMemoryChunks({
      query,
      store,
      embed: async () => qEmb,
      topK: 5,
      now: Date.parse("2026-09-05T00:00:00.000Z"),
    });

    expect(results.map((r) => r.chunkId)).toEqual([fresh.id, decayed.id]);
    expect(results[0]!.fusedScore).toBeGreaterThan(results[1]!.fusedScore);
  });

  it("a clearly closer match still wins over a fresher but weaker one (semantic weight dominates)", async () => {
    // Orthogonal unit vectors: the sin-based helper embeddings are all
    // mutually similar, which would not exercise the semantic term.
    const qEmb = new Float32Array(384);
    qEmb[0] = 1;
    const farEmb = new Float32Array(384);
    farEmb[1] = 1;
    const near = store.insert(
      { content: "near match", source: "manual", importance: 0.3, skipDedup: true },
      qEmb,
    );
    const far = store.insert(
      { content: "far match", source: "manual", importance: 0.9, skipDedup: true },
      farEmb,
    );
    const db = store.getDatabase();
    db.prepare("UPDATE memories SET accessed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(near.id);
    db.prepare("UPDATE memories SET accessed_at = '2026-09-04T00:00:00.000Z' WHERE id = ?").run(far.id);

    const results = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed: async () => qEmb,
      topK: 5,
      now: Date.parse("2026-09-05T00:00:00.000Z"),
    });

    expect(results[0]!.chunkId).toBe(near.id);
  });

  it("searchMemoriesVec carries importance, accessed_at and tier for the re-rank", async () => {
    const qEmb = deterministicEmbedding(3);
    const entry = store.insert({ content: "carried", source: "manual", importance: 0.42, skipDedup: true }, qEmb);
    const hits = store.searchMemoriesVec(qEmb, 1);
    expect(hits[0]).toMatchObject({ memory_id: entry.id, importance: 0.42, tier: "warm" });
    expect(typeof hits[0]!.accessed_at).toBe("string");
  });
});
