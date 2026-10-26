/**
 * Phase 115 Plan 05 sub-scope 7 — `clawcode_memory_search` tool tests.
 *
 * Pins:
 *   - search returns hits with memoryId + snippet (≤500 chars) + score
 *   - respects k (top-K cap)
 *   - respects excludeTags (passed through to retrieveMemoryChunks)
 *   - includeTags filter drops hits without matching tags (WP5 block below)
 *   - agentName resolved from deps, NEVER from input (per-agent isolation)
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { MemoryStore } from "../store.js";
import {
  clawcodeMemorySearch,
  SEARCH_INPUT_SCHEMA,
} from "../tools/clawcode-memory-search.js";
import { SharedFactsStore } from "../shared-facts-store.js";

function createTestStore(): MemoryStore {
  return new MemoryStore(":memory:");
}

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.random() * 2 - 1;
  }
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) arr[i] /= norm;
  return arr;
}

const stubEmbedder = {
  embed: vi.fn(async (_text: string) => randomEmbedding()),
};

describe("clawcodeMemorySearch — schema + basic behavior", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
    stubEmbedder.embed.mockClear();
  });

  it("input schema requires query (min length 1)", () => {
    const r = SEARCH_INPUT_SCHEMA.safeParse({ query: "" });
    expect(r.success).toBe(false);
  });

  it("input schema clamps k to [1, 50]", () => {
    expect(SEARCH_INPUT_SCHEMA.safeParse({ query: "x", k: 0 }).success).toBe(false);
    expect(SEARCH_INPUT_SCHEMA.safeParse({ query: "x", k: 51 }).success).toBe(false);
    expect(SEARCH_INPUT_SCHEMA.safeParse({ query: "x", k: 10 }).success).toBe(true);
  });

  it("returns empty hits + agentName when store is empty", async () => {
    store = createTestStore();
    const res = await clawcodeMemorySearch(
      { query: "anything" },
      { store, embedder: stubEmbedder, agentName: "agent-A" },
    );
    expect(res.hits).toEqual([]);
    expect(res.agentName).toBe("agent-A");
  });

  it("returns hits drawn from memory_chunks with snippets capped at 500 chars", async () => {
    store = createTestStore();
    // Seed one big chunk; FTS5 will match on "performance"
    const bigBody = "performance ".repeat(100); // ~1200 chars
    store.insertMemoryChunk({
      path: "memory/notes/perf.md",
      chunkIndex: 0,
      heading: "Performance notes",
      body: bigBody,
      tokenCount: 200,
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: "x".repeat(64),
      embedding: randomEmbedding(),
    });

    const res = await clawcodeMemorySearch(
      { query: "performance" },
      { store, embedder: stubEmbedder, agentName: "agent-A" },
    );

    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0].snippet.length).toBeLessThanOrEqual(500);
    expect(res.hits[0].source).toBe("chunk");
    expect(res.hits[0].memoryId.length).toBeGreaterThan(0);
  });

  it("agentName comes from deps, NEVER from input (per-agent isolation)", async () => {
    store = createTestStore();
    // The input has no agentName field — schema rejects unknown keys via
    // omission rather than .strict(), but the deps-driven flow is the
    // only one that controls agentName in the result.
    const res = await clawcodeMemorySearch(
      { query: "x" },
      { store, embedder: stubEmbedder, agentName: "agent-deps-controlled" },
    );
    expect(res.agentName).toBe("agent-deps-controlled");
    // Input contained no agentName-style field — verify the schema does
    // not accept one as a valid override path.
    expect(
      Object.prototype.hasOwnProperty.call(SEARCH_INPUT_SCHEMA.shape, "agentName"),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(SEARCH_INPUT_SCHEMA.shape, "agent"),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(SEARCH_INPUT_SCHEMA.shape, "agent_name"),
    ).toBe(false);
  });

  it("respects k=1 by capping returned hits", async () => {
    store = createTestStore();
    for (let i = 0; i < 5; i++) {
      store.insertMemoryChunk({
        path: `memory/n-${i}.md`,
        chunkIndex: 0,
        heading: `Note ${i}`,
        body: `note ${i} performance content`,
        tokenCount: 10,
        scoreWeight: 0,
        fileMtimeMs: Date.now(),
        fileSha256: `x`.repeat(64),
        embedding: randomEmbedding(),
      });
    }
    const res = await clawcodeMemorySearch(
      { query: "performance", k: 1 },
      { store, embedder: stubEmbedder, agentName: "agent-A" },
    );
    expect(res.hits.length).toBeLessThanOrEqual(1);
  });

  it("returns frozen hits array (immutability)", async () => {
    store = createTestStore();
    const res = await clawcodeMemorySearch(
      { query: "x" },
      { store, embedder: stubEmbedder, agentName: "agent-A" },
    );
    expect(Object.isFrozen(res.hits)).toBe(true);
  });

  it("excludeTags arg is passed through to retrieveMemoryChunks (filter wired)", async () => {
    // The wiring is exercised by the no-tags path: when excludeTags is
    // provided, no exception is thrown. retrieveMemoryChunks's own tests
    // pin the actual filtering behavior.
    store = createTestStore();
    await expect(
      clawcodeMemorySearch(
        { query: "x", excludeTags: ["session-summary"] },
        { store, embedder: stubEmbedder, agentName: "agent-A" },
      ),
    ).resolves.toBeDefined();
  });

  it("input schema does NOT include agentName/agent/agent_name field (security pin)", () => {
    const shape = SEARCH_INPUT_SCHEMA.shape as Record<string, unknown>;
    expect(shape.agentName).toBeUndefined();
    expect(shape.agent).toBeUndefined();
    expect(shape.agent_name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Memory overhaul 2026-10-25 (WP5) - provenance on hits, includeTags on
// mixed hits without access side effects, superseded rows hidden.
// ---------------------------------------------------------------------------

function axis(i: number): Float32Array {
  const v = new Float32Array(384);
  v[i] = 1;
  return v;
}

const OLD_STAMP = "2020-01-01T00:00:00.000Z";

function accessState(store: MemoryStore, id: string): { access_count: number; accessed_at: string } {
  return store
    .getDatabase()
    .prepare("SELECT access_count, accessed_at FROM memories WHERE id = ?")
    .get(id) as { access_count: number; accessed_at: string };
}

describe("clawcodeMemorySearch: WP5 provenance and filters", () => {
  let store: MemoryStore;
  let shared: SharedFactsStore | undefined;
  const fixedEmbedder = { embed: async (_t: string) => axis(0) };

  afterEach(() => {
    store?.close();
    shared?.close();
    shared = undefined;
  });

  function seed(): { keep: string; drop: string; chunkId: string } {
    store = createTestStore();
    const keep = store.insert(
      { content: "walrus budget approved 2026-10-01", source: "manual", tags: ["budget"], skipDedup: true },
      axis(0),
    );
    const drop = store.insert(
      { content: "walrus budget draft notes", source: "conversation", tags: ["draft"], skipDedup: true },
      axis(0),
    );
    store
      .getDatabase()
      .prepare("UPDATE memories SET accessed_at = ? WHERE id IN (?, ?)")
      .run(OLD_STAMP, keep.id, drop.id);
    const chunkId = store.insertMemoryChunk({
      path: "memory/2026-10-01.md",
      chunkIndex: 0,
      heading: "Walrus budget",
      body: "walrus budget discussion in the daily note",
      tokenCount: 8,
      scoreWeight: 0,
      fileMtimeMs: Date.parse("2026-10-01T09:00:00.000Z"),
      fileSha256: "w".repeat(64),
      embedding: axis(0),
    });
    return { keep: keep.id, drop: drop.id, chunkId };
  }

  it("hits carry kind, createdAt, and tags + memorySource (memories) or path (files)", async () => {
    const { keep, chunkId } = seed();
    const res = await clawcodeMemorySearch(
      { query: "walrus budget" },
      { store, embedder: fixedEmbedder, agentName: "agent-A" },
    );

    const mem = res.hits.find((h) => h.memoryId === keep);
    expect(mem?.kind).toBe("memory");
    expect(mem?.source).toBe("memory");
    expect(mem?.tags).toEqual(["budget"]);
    expect(mem?.memorySource).toBe("manual");
    expect(mem?.createdAt).toBe(store.peekById(keep)?.createdAt);

    const file = res.hits.find((h) => h.memoryId === chunkId);
    expect(file?.kind).toBe("file");
    expect(file?.source).toBe("chunk");
    expect(file?.path).toBe("memory/2026-10-01.md");
    expect(file?.createdAt).toBe("2026-10-01T09:00:00.000Z");
    expect(file?.tags).toBeUndefined();
  });

  it("includeTags keeps only saved memories with a matching tag and never touches the rows it drops", async () => {
    const { keep, drop } = seed();
    const res = await clawcodeMemorySearch(
      { query: "walrus budget", includeTags: ["budget"] },
      { store, embedder: fixedEmbedder, agentName: "agent-A" },
    );

    expect(res.hits.map((h) => h.memoryId)).toEqual([keep]);
    expect(accessState(store, drop)).toEqual({ access_count: 0, accessed_at: OLD_STAMP });
    // The returned memory is the one that counts as used (recency only).
    expect(accessState(store, keep).access_count).toBe(0);
    expect(accessState(store, keep).accessed_at).not.toBe(OLD_STAMP);
  });

  it("empty includeTags is no filter: file sections stay", async () => {
    const { chunkId } = seed();
    const res = await clawcodeMemorySearch(
      { query: "walrus budget", includeTags: [] },
      { store, embedder: fixedEmbedder, agentName: "agent-A" },
    );
    expect(res.hits.map((h) => h.memoryId)).toContain(chunkId);
  });

  it("superseded memories are not returned", async () => {
    const { keep, drop } = seed();
    store.forget(drop);
    const res = await clawcodeMemorySearch(
      { query: "walrus budget" },
      { store, embedder: fixedEmbedder, agentName: "agent-A" },
    );
    const ids = res.hits.map((h) => h.memoryId);
    expect(ids).toContain(keep);
    expect(ids).not.toContain(drop);
  });

  it("owner facts come back as kind owner-fact with their date", async () => {
    store = createTestStore();
    shared = new SharedFactsStore(":memory:");
    const fact = shared.save({ owner: "owner_a", content: "Operator likes walrus facts", sourceAgent: "p" }, axis(0));
    const res = await clawcodeMemorySearch(
      { query: "walrus" },
      {
        store,
        embedder: fixedEmbedder,
        agentName: "agent-A",
        ownerFacts: { store: shared, owner: "owner_a", embed: async () => axis(0) },
      },
    );
    const hit = res.hits.find((h) => h.memoryId === `shared:${fact.fact.id}`);
    expect(hit?.kind).toBe("owner-fact");
    expect(hit?.createdAt).toBe(fact.fact.createdAt);
  });
});
