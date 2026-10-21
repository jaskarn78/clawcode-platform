/**
 * Quick-260521-437 — verify `retrieveMemoryChunks` honors the
 * `documentChunkCap` argument: a cross-ingested image/document dump cannot
 * dominate a single pre-turn `<memory-context>` retrieval.
 *
 * Locked invariants:
 *   - With `documentChunkCap` set, the emitted result contains at most
 *     `documentChunkCap` chunks whose `path` starts with `document:`.
 *   - Excess document chunks are EVICTED so lower-ranked NON-document
 *     chunks can reach the topK window (eviction-with-replacement — the
 *     cap pass runs before the topK slice).
 *   - The cap is an UPPER BOUND, never a quota: a retrieval whose only
 *     candidates are document chunks still returns them up to the cap, so
 *     document searchability is preserved.
 *   - With `documentChunkCap` omitted, retrieval behavior is unchanged
 *     (no eviction — legacy topK truncation in rank order).
 *
 * Strategy: build an in-memory MemoryStore, insert chunks with `path`
 * values that are either `document:<slug>` (cross-ingested) or plain
 * `/ws/memory/...` (file-scanner). A fixed-vector embedder makes vec-search
 * return every chunk at uniform distance. The cap is path-prefix based and
 * does NOT need a `documents` provenance row, so `documentPriority` is
 * omitted here — these tests exercise the cap pass in isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../store.js";
import { retrieveMemoryChunks } from "../memory-retrieval.js";

let store: MemoryStore;

// Deterministic 384-dim embedder — every chunk and the query share the
// SAME embedding so vec-search returns them all at uniform distance.
const FIXED_VEC = new Float32Array(384).fill(0.1);
const embed = async (_text: string): Promise<Float32Array> => FIXED_VEC;

beforeEach(() => {
  store = new MemoryStore(":memory:");
});

afterEach(() => {
  store.close();
});

/** Insert N `document:`-prefixed chunks (cross-ingested artifacts). */
function seedDocumentChunks(n: number) {
  for (let i = 0; i < n; i++) {
    store.insertMemoryChunk({
      path: `document:doc-slug-${i}`,
      chunkIndex: 0,
      heading: `Document ${i}`,
      body: `document body ${i}`,
      tokenCount: 8,
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: `doc-sha-${i}`,
      embedding: FIXED_VEC,
    });
  }
}

/** Insert M plain file-scanner (non-document) chunks. */
function seedNonDocumentChunks(m: number) {
  for (let i = 0; i < m; i++) {
    store.insertMemoryChunk({
      path: `/ws/memory/note-${i}.md`,
      chunkIndex: 0,
      heading: `Note ${i}`,
      body: `note body ${i}`,
      tokenCount: 8,
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: `note-sha-${i}`,
      embedding: FIXED_VEC,
    });
  }
}

describe("Quick-260521-437 — retrieveMemoryChunks documentChunkCap", () => {
  it("documentChunkCap evicts excess document chunks while keeping non-document chunks", async () => {
    // 5 document chunks + 3 non-document chunks, all retrievable. With
    // documentChunkCap=2 and topK=5 the emitted set must keep at most 2
    // document chunks; the freed slots admit non-document chunks.
    seedDocumentChunks(5);
    seedNonDocumentChunks(3);

    const out = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 5,
      timeWindowDays: 14,
      documentChunkCap: 2,
    });

    const docCount = out.filter((r) => r.path.startsWith("document:")).length;
    const nonDocCount = out.filter(
      (r) => !r.path.startsWith("document:"),
    ).length;

    // At most 2 document chunks survive the cap.
    expect(docCount).toBeLessThanOrEqual(2);
    // Eviction-with-replacement: non-document chunks reach the topK window.
    expect(nonDocCount).toBeGreaterThanOrEqual(1);
    // topK=5 — the cap freed slots, so the result fills toward topK with
    // a mix of both surfaces (3 non-doc + 2 doc = 5 available).
    expect(out.length).toBe(5);
  });

  it("searchability preserved — document chunks still returned when no non-document competition exists", async () => {
    // Store contains ONLY document chunks. The cap is an upper bound, not
    // a floor — document chunks are still returned, up to the cap.
    seedDocumentChunks(5);

    const out = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 5,
      timeWindowDays: 14,
      documentChunkCap: 2,
    });

    expect(out.length).toBeGreaterThan(0);
    // Every returned chunk is a document chunk (nothing else to return).
    expect(out.every((r) => r.path.startsWith("document:"))).toBe(true);
    // But never more than the cap.
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it("documentChunkCap omitted → no eviction (back-compat)", async () => {
    // 5 document chunks, 0 non-document. With the cap omitted the legacy
    // topK truncation runs unchanged — up to topK document chunks return.
    seedDocumentChunks(5);

    const out = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 5,
      timeWindowDays: 14,
      // documentChunkCap intentionally OMITTED — no cap pass.
    });

    const docCount = out.filter((r) => r.path.startsWith("document:")).length;
    // Legacy behavior: topK document chunks returned, NOT capped at 2.
    expect(docCount).toBe(5);
    expect(out.length).toBe(5);
  });
});
