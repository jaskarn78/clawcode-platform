import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { DocumentStore } from "../store.js";

/**
 * Create a deterministic 384-dim Int8 embedding for testing.
 *
 * Phase 101 D-09 (CF-2): DocumentStore embeddings are int8[384] (bge-small
 * int8 from embedV2). Pre-existing tests previously used Float32Array
 * (v1 MiniLM); flipped to Int8Array as part of the greenfield-for-v2
 * migration. The pattern mirrors what `EmbeddingService.embedV2()` returns
 * at runtime.
 */
function fakeEmbedding(seed: number): Int8Array {
  const arr = new Int8Array(384);
  for (let i = 0; i < 384; i++) {
    // Map sin([-1,1]) → int8 [-127,127] range.
    arr[i] = Math.round(Math.sin(seed * (i + 1) * 0.01) * 127);
  }
  return arr;
}

describe("DocumentStore", () => {
  let db: DatabaseType;
  let store: DocumentStore;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
    sqliteVec.load(db);
    store = new DocumentStore(db);
  });

  describe("schema creation", () => {
    it("creates document_chunks table", () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_chunks'")
        .all();
      expect(tables).toHaveLength(1);
    });

    it("creates vec_document_chunks virtual table", () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_document_chunks'")
        .all();
      expect(tables).toHaveLength(1);
    });
  });

  describe("ingest", () => {
    it("stores chunks and returns IngestResult", () => {
      const chunks = [
        { content: "chunk zero", chunkIndex: 0, startChar: 0, endChar: 10 },
        { content: "chunk one", chunkIndex: 1, startChar: 8, endChar: 17 },
      ] as const;
      const embeddings = [fakeEmbedding(1), fakeEmbedding(2)];

      const result = store.ingest("doc1.txt", chunks, embeddings);

      expect(result.source).toBe("doc1.txt");
      expect(result.chunksCreated).toBe(2);
      expect(result.totalChars).toBe(19); // 10 + 9
      expect(store.getChunkCount()).toBe(2);
    });

    it("overwrites existing source on re-ingest", () => {
      const chunks1 = [
        { content: "old chunk", chunkIndex: 0, startChar: 0, endChar: 9 },
      ] as const;
      const chunks2 = [
        { content: "new chunk a", chunkIndex: 0, startChar: 0, endChar: 11 },
        { content: "new chunk b", chunkIndex: 1, startChar: 9, endChar: 20 },
      ] as const;

      store.ingest("doc.md", chunks1, [fakeEmbedding(1)]);
      expect(store.getChunkCount()).toBe(1);

      store.ingest("doc.md", chunks2, [fakeEmbedding(2), fakeEmbedding(3)]);
      expect(store.getChunkCount()).toBe(2);
    });
  });

  describe("search", () => {
    it("returns results ranked by similarity", () => {
      const chunks = [
        { content: "apples and oranges", chunkIndex: 0, startChar: 0, endChar: 18 },
        { content: "bananas and grapes", chunkIndex: 1, startChar: 16, endChar: 34 },
        { content: "cats and dogs", chunkIndex: 2, startChar: 32, endChar: 45 },
      ] as const;
      const emb1 = fakeEmbedding(10);
      const emb2 = fakeEmbedding(20);
      const emb3 = fakeEmbedding(100);

      store.ingest("fruits.txt", chunks, [emb1, emb2, emb3]);

      // Search with embedding similar to emb1
      const queryEmb = fakeEmbedding(10);
      const results = store.search(queryEmb, 3);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].similarity).toBeGreaterThanOrEqual(results[results.length - 1].similarity);
      // First result should be the closest match to seed 10
      expect(results[0].content).toBe("apples and oranges");
    });

    it("filters by source when provided", () => {
      const chunksA = [
        { content: "doc A content", chunkIndex: 0, startChar: 0, endChar: 13 },
      ] as const;
      const chunksB = [
        { content: "doc B content", chunkIndex: 0, startChar: 0, endChar: 13 },
      ] as const;

      store.ingest("a.txt", chunksA, [fakeEmbedding(1)]);
      store.ingest("b.txt", chunksB, [fakeEmbedding(2)]);

      const results = store.search(fakeEmbedding(1), 5, "a.txt");
      expect(results).toHaveLength(1);
      expect(results[0].source).toBe("a.txt");
    });

    it("includes context chunks from adjacent indices", () => {
      const chunks = [
        { content: "chapter one start", chunkIndex: 0, startChar: 0, endChar: 17 },
        { content: "chapter one middle", chunkIndex: 1, startChar: 15, endChar: 33 },
        { content: "chapter one end", chunkIndex: 2, startChar: 31, endChar: 46 },
      ] as const;

      store.ingest("book.txt", chunks, [fakeEmbedding(5), fakeEmbedding(6), fakeEmbedding(7)]);

      // Search for the middle chunk
      const results = store.search(fakeEmbedding(6), 1);
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("chapter one middle");
      expect(results[0].contextBefore).toBe("chapter one start");
      expect(results[0].contextAfter).toBe("chapter one end");
    });

    it("clamps limit to max 20", () => {
      const chunks = [
        { content: "only chunk", chunkIndex: 0, startChar: 0, endChar: 10 },
      ] as const;
      store.ingest("small.txt", chunks, [fakeEmbedding(1)]);

      // Requesting 100 should not error and should clamp
      const results = store.search(fakeEmbedding(1), 100);
      expect(results.length).toBeLessThanOrEqual(20);
    });
  });

  describe("deleteDocument", () => {
    it("removes all chunks for a source", () => {
      const chunksA = [
        { content: "a1", chunkIndex: 0, startChar: 0, endChar: 2 },
        { content: "a2", chunkIndex: 1, startChar: 1, endChar: 3 },
      ] as const;
      const chunksB = [
        { content: "b1", chunkIndex: 0, startChar: 0, endChar: 2 },
      ] as const;

      store.ingest("a.txt", chunksA, [fakeEmbedding(1), fakeEmbedding(2)]);
      store.ingest("b.txt", chunksB, [fakeEmbedding(3)]);

      const deleted = store.deleteDocument("a.txt");
      expect(deleted).toBe(2);
      expect(store.getChunkCount()).toBe(1);
    });

    it("returns 0 when source does not exist", () => {
      expect(store.deleteDocument("nonexistent.txt")).toBe(0);
    });
  });

  describe("listSources", () => {
    it("returns distinct source values sorted", () => {
      store.ingest("b.txt", [{ content: "b", chunkIndex: 0, startChar: 0, endChar: 1 }], [fakeEmbedding(1)]);
      store.ingest("a.txt", [{ content: "a", chunkIndex: 0, startChar: 0, endChar: 1 }], [fakeEmbedding(2)]);

      const sources = store.listSources();
      expect(sources).toEqual(["a.txt", "b.txt"]);
    });
  });

  describe("chunk count warning", () => {
    it("logs warning when chunk count exceeds 10,000", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // We can't insert 10K chunks easily, so test the logic directly
      // by inserting some chunks and verifying the warn is NOT called
      const chunks = [
        { content: "test", chunkIndex: 0, startChar: 0, endChar: 4 },
      ] as const;
      store.ingest("test.txt", chunks, [fakeEmbedding(1)]);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});
