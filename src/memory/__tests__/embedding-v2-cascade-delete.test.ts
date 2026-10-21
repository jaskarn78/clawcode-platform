import { describe, it, expect, afterEach, vi } from "vitest";
import { MemoryStore } from "../store.js";
import { quantizeInt8 } from "../embedder-quantize.js";

/**
 * Phase 115 D-08 — regression tests for the embedding-v2 cascade-delete +
 * dual-write storage primitives in `MemoryStore`.
 *
 * Behaviors covered (Phase 107 VEC-CLEAN-* invariant extended to v2):
 *
 *   1. `delete(id)` cascades to BOTH `vec_memories` AND `vec_memories_v2`
 *      atomically (one transaction). Pre-115 invariant for v1 is
 *      preserved; v2 row is removed even when no v2 row was ever written.
 *   2. `deleteMemoryChunksByPath(path)` cascades to BOTH
 *      `vec_memory_chunks` AND `vec_memory_chunks_v2`.
 *   3. `cleanupOrphans()` removes orphans from BOTH v1 and v2 vec tables
 *      atomically. Phase 107 directional invariant preserved (only
 *      deletes from vec tables, never from `memories`).
 *   4. `cleanupOrphansSplit()` returns per-version counts.
 *   5. Atomicity: a mid-transaction throw rolls back BOTH v1 + v2 deletes
 *      (Phase 107 atomic invariant extended to v2).
 *   6. `insertEmbeddingV2` rejects non-384-dim input.
 *   7. `insertWithDualWrite` writes all three rows (memories, vec_memories,
 *      vec_memories_v2) and KNN over v2 returns the inserted ids.
 */

function createTestStore(): MemoryStore {
  return new MemoryStore(":memory:");
}

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = (Math.random() * 2 - 1) * 0.1;
  }
  // L2 normalize so the [-1, +1] quantization range fits.
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) arr[i] /= norm;
  return arr;
}

function countV1(store: MemoryStore): number {
  return (
    store
      .getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM vec_memories")
      .get() as { n: number }
  ).n;
}

function countV2(store: MemoryStore): number {
  return (
    store
      .getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM vec_memories_v2")
      .get() as { n: number }
  ).n;
}

function countMemories(store: MemoryStore): number {
  return (
    store
      .getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM memories")
      .get() as { n: number }
  ).n;
}

describe("embedding-v2 cascade-delete (Phase 115 D-08)", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  it("creates vec_memories_v2 + vec_memory_chunks_v2 + migrations tables on construction", () => {
    store = createTestStore();
    const db = store.getDatabase();

    // vec_memories_v2 — virtual table queryable.
    const v2Count = db
      .prepare("SELECT COUNT(*) AS n FROM vec_memories_v2")
      .get() as { n: number };
    expect(v2Count.n).toBe(0);

    // vec_memory_chunks_v2 — virtual table queryable.
    const v2ChunkCount = db
      .prepare("SELECT COUNT(*) AS n FROM vec_memory_chunks_v2")
      .get() as { n: number };
    expect(v2ChunkCount.n).toBe(0);

    // migrations table — regular table with the right shape.
    const cols = db
      .prepare("PRAGMA table_info(migrations)")
      .all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("key");
    expect(colNames).toContain("phase");
    expect(colNames).toContain("progress_processed");
    expect(colNames).toContain("progress_total");
    expect(colNames).toContain("last_cursor");
  });

  it("delete(id) cascades to vec_memories_v2 inside one atomic transaction", () => {
    store = createTestStore();
    const v1 = randomEmbedding();
    const v2 = quantizeInt8(randomEmbedding());

    // insertWithDualWrite plants all three rows.
    const entry = store.insertWithDualWrite(
      { content: "alpha", source: "manual", skipDedup: true },
      v1,
      v2,
    );

    expect(countMemories(store)).toBe(1);
    expect(countV1(store)).toBe(1);
    expect(countV2(store)).toBe(1);

    // Delete the memory — all three rows must vanish atomically.
    const deleted = store.delete(entry.id);
    expect(deleted).toBe(true);
    expect(countMemories(store)).toBe(0);
    expect(countV1(store)).toBe(0);
    expect(countV2(store)).toBe(0);
  });

  it("delete(id) is idempotent on v2 even when no v2 row exists (pre-dual-write entries)", () => {
    store = createTestStore();
    // Insert via the legacy path — only memories + vec_memories rows.
    const entry = store.insert(
      { content: "legacy", source: "manual", skipDedup: true },
      randomEmbedding(),
    );

    expect(countMemories(store)).toBe(1);
    expect(countV1(store)).toBe(1);
    expect(countV2(store)).toBe(0);

    // Delete cascades — v2 DELETE is a 0-row no-op, no error.
    const deleted = store.delete(entry.id);
    expect(deleted).toBe(true);
    expect(countMemories(store)).toBe(0);
    expect(countV1(store)).toBe(0);
    expect(countV2(store)).toBe(0);
  });

  it("cleanupOrphans removes orphans from BOTH vec_memories AND vec_memories_v2", () => {
    store = createTestStore();
    const v1 = randomEmbedding();
    const v2 = quantizeInt8(randomEmbedding());

    // Plant 3 dual-write rows.
    const a = store.insertWithDualWrite(
      { content: "alpha", source: "manual", skipDedup: true },
      v1,
      v2,
    );
    const b = store.insertWithDualWrite(
      { content: "beta", source: "manual", skipDedup: true },
      v1,
      v2,
    );
    store.insertWithDualWrite(
      { content: "gamma", source: "manual", skipDedup: true },
      v1,
      v2,
    );

    expect(countV1(store)).toBe(3);
    expect(countV2(store)).toBe(3);

    // Simulate leaky deletes — bypass MemoryStore.delete to remove
    // memories row only, leaving orphan v1 + v2 rows. This mimics the
    // pre-Phase-107 leak path being extended to v2.
    store
      .getDatabase()
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(a.id);
    store
      .getDatabase()
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(b.id);

    expect(countMemories(store)).toBe(1);
    expect(countV1(store)).toBe(3);
    expect(countV2(store)).toBe(3);

    const result = store.cleanupOrphans();
    // 2 v1 + 2 v2 orphans removed = 4 combined.
    expect(result.removed).toBe(4);
    // totalAfter is the v1 count (pre-115 contract preserved).
    expect(result.totalAfter).toBe(1);

    // Both v1 and v2 vec tables now hold only the surviving row.
    expect(countV1(store)).toBe(1);
    expect(countV2(store)).toBe(1);
  });

  it("cleanupOrphansSplit returns per-version counts", () => {
    store = createTestStore();
    const v1 = randomEmbedding();
    const v2 = quantizeInt8(randomEmbedding());

    const a = store.insertWithDualWrite(
      { content: "alpha", source: "manual", skipDedup: true },
      v1,
      v2,
    );
    const b = store.insertWithDualWrite(
      { content: "beta", source: "manual", skipDedup: true },
      v1,
      v2,
    );
    store.insertWithDualWrite(
      { content: "gamma", source: "manual", skipDedup: true },
      v1,
      v2,
    );

    // Leaky-delete two memories.
    store
      .getDatabase()
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(a.id);
    store
      .getDatabase()
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(b.id);

    const split = store.cleanupOrphansSplit();
    expect(split.v1Removed).toBe(2);
    expect(split.v2Removed).toBe(2);
    expect(split.v1Total).toBe(1);
    expect(split.v2Total).toBe(1);
  });

  it("cleanupOrphans atomicity — mid-transaction throw rolls back BOTH v1 + v2 deletes", () => {
    store = createTestStore();
    const v1 = randomEmbedding();
    const v2 = quantizeInt8(randomEmbedding());

    const a = store.insertWithDualWrite(
      { content: "alpha", source: "manual", skipDedup: true },
      v1,
      v2,
    );
    const b = store.insertWithDualWrite(
      { content: "beta", source: "manual", skipDedup: true },
      v1,
      v2,
    );
    store.insertWithDualWrite(
      { content: "gamma", source: "manual", skipDedup: true },
      v1,
      v2,
    );

    // Leaky-delete two memories so cleanupOrphans has work to do.
    store
      .getDatabase()
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(a.id);
    store
      .getDatabase()
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(b.id);

    const beforeV1 = countV1(store);
    const beforeV2 = countV2(store);
    expect(beforeV1).toBe(3);
    expect(beforeV2).toBe(3);

    // Spy on db.prepare so the second SQL call (the v2 DELETE) throws.
    // The first call is the v1 DELETE inside the transaction; throwing on
    // the second triggers a rollback of the first.
    const db = store.getDatabase();
    const realPrepare = db.prepare.bind(db);
    let callCount = 0;
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      callCount++;
      // Pass the v1 DELETE through (call 1). Throw on call 2 (v2 DELETE).
      if (callCount === 2) {
        throw new Error("simulated mid-transaction failure on v2 DELETE");
      }
      return realPrepare(sql);
    });

    expect(() => store.cleanupOrphans()).toThrow(
      /simulated mid-transaction failure/,
    );

    spy.mockRestore();

    // Atomicity: BOTH v1 + v2 row counts must be unchanged.
    expect(countV1(store)).toBe(beforeV1);
    expect(countV2(store)).toBe(beforeV2);
  });

  it("Phase 107 directional invariant — cleanupOrphans does NOT delete from `memories`", () => {
    store = createTestStore();
    const v1 = randomEmbedding();
    const v2 = quantizeInt8(randomEmbedding());

    const a = store.insertWithDualWrite(
      { content: "alpha", source: "manual", skipDedup: true },
      v1,
      v2,
    );
    const b = store.insertWithDualWrite(
      { content: "beta", source: "manual", skipDedup: true },
      v1,
      v2,
    );

    // Replicate cold-archive shape: memory present, v1 + v2 vec rows
    // both deleted (the inverse of an orphan). cleanupOrphans must NOT
    // erase the cold-archived memory.
    store
      .getDatabase()
      .prepare("UPDATE memories SET tier = 'cold' WHERE id = ?")
      .run(b.id);
    store
      .getDatabase()
      .prepare("DELETE FROM vec_memories WHERE memory_id = ?")
      .run(b.id);
    store
      .getDatabase()
      .prepare("DELETE FROM vec_memories_v2 WHERE memory_id = ?")
      .run(b.id);

    const result = store.cleanupOrphans();
    expect(result.removed).toBe(0); // no orphans, both directions clean
    // Both memories (the live one + the cold-archived one) must still exist.
    expect(countMemories(store)).toBe(2);
    expect(store.getById(a.id)).not.toBeNull();
    expect(store.getById(b.id)).not.toBeNull();
  });

  it("insertEmbeddingV2 rejects non-384-dim input", () => {
    store = createTestStore();
    const entry = store.insert(
      { content: "alpha", source: "manual", skipDedup: true },
      randomEmbedding(),
    );

    expect(() =>
      store.insertEmbeddingV2(entry.id, new Int8Array(256)),
    ).toThrow(/384/);
  });

  it("insert(input, embedding, {embeddingV2}) caller-side length validation — bad v2 length rejected before txn opens", () => {
    store = createTestStore();
    expect(countMemories(store)).toBe(0);
    expect(countV1(store)).toBe(0);
    expect(countV2(store)).toBe(0);

    const v1 = randomEmbedding();
    expect(() =>
      store.insert(
        { content: "alpha", source: "manual", skipDedup: true },
        v1,
        { embeddingV2: new Int8Array(256) },
      ),
    ).toThrow(/384/);
    // Length-rejection happens BEFORE the transaction opens, so no rows
    // anywhere — neither memories nor vec_memories nor vec_memories_v2.
    expect(countMemories(store)).toBe(0);
    expect(countV1(store)).toBe(0);
    expect(countV2(store)).toBe(0);
  });

  it("insert atomicity — v2 INSERT throw INSIDE txn rolls back v1 + memories (Phase 107 invariant on insert side)", () => {
    store = createTestStore();
    const v1 = randomEmbedding();
    const v2 = quantizeInt8(randomEmbedding());

    // Inject a SQL function that throws when invoked. We override the
    // existing `vec_int8` function with a no-op that throws — this is
    // the function the insertVecV2 prepared statement calls inline.
    // better-sqlite3's `function()` API replaces the existing function
    // for this connection only. The throw happens INSIDE the
    // db.transaction() block, after v1 + memories rows have already
    // been written — better-sqlite3 must roll all three back.
    const db = store.getDatabase();
    db.function("vec_int8_test_failure", () => {
      throw new Error("simulated mid-transaction v2 INSERT failure");
    });
    // We can't easily swap the existing `vec_int8` SQL function (it's
    // built into sqlite-vec). But we CAN spy on the prepared statement
    // we WRITE TO — the insertVecV2 statement is a private member of
    // MemoryStore. The cleanest path: spy on the underlying db object's
    // exec / prepare and detect the v2 INSERT path.
    //
    // Observable approach: monkey-patch the v2 column. We DROP the v2
    // virtual table immediately before the dual-write call so the v2
    // INSERT INSIDE the transaction throws "no such table". Better-
    // sqlite3 rolls back the v1 + memories writes on the thrown error.
    db.exec("DROP TABLE vec_memories_v2");

    expect(() =>
      store.insert(
        { content: "alpha", source: "manual", skipDedup: true },
        v1,
        { embeddingV2: v2 },
      ),
    ).toThrow();

    // Atomicity: NONE of the three rows persisted. The v1 + memories
    // INSERT (which would have succeeded on its own) was rolled back
    // by the same db.transaction() that wraps the v2 write.
    expect(countMemories(store)).toBe(0);
    expect(countV1(store)).toBe(0);
    // vec_memories_v2 table is dropped, so we don't count it. The
    // important assertion is that memories + vec_memories rolled back.

    // Recreate the table so the rest of the suite (including afterEach
    // close) doesn't trip.
    db.exec(
      "CREATE VIRTUAL TABLE vec_memories_v2 USING vec0(memory_id TEXT PRIMARY KEY, embedding int8[384] distance_metric=cosine)",
    );
  });

  it("insert(input, embedding, {embeddingV2}) writes all three rows atomically — happy path", () => {
    store = createTestStore();
    const v1 = randomEmbedding();
    const v2 = quantizeInt8(randomEmbedding());

    const entry = store.insert(
      { content: "alpha", source: "manual", skipDedup: true },
      v1,
      { embeddingV2: v2 },
    );

    expect(entry.id).toBeDefined();
    expect(countMemories(store)).toBe(1);
    expect(countV1(store)).toBe(1);
    expect(countV2(store)).toBe(1);
  });

  it("insert without {embeddingV2} option — Phase 1-114 contract preserved (only memories + vec_memories rows)", () => {
    store = createTestStore();
    const entry = store.insert(
      { content: "legacy", source: "manual", skipDedup: true },
      randomEmbedding(),
    );

    expect(entry.id).toBeDefined();
    expect(countMemories(store)).toBe(1);
    expect(countV1(store)).toBe(1);
    // No v2 row written — pre-115 callers see no behavior change.
    expect(countV2(store)).toBe(0);
  });

  it("insertWithDualWrite writes all three rows; v2 KNN returns the inserted id", () => {
    store = createTestStore();
    const v1 = randomEmbedding();
    const v2Float = randomEmbedding();
    const v2 = quantizeInt8(v2Float);

    const entry = store.insertWithDualWrite(
      { content: "alpha", source: "manual", skipDedup: true },
      v1,
      v2,
    );

    expect(countMemories(store)).toBe(1);
    expect(countV1(store)).toBe(1);
    expect(countV2(store)).toBe(1);

    // Direct vec_memories_v2 KNN — query with the same int8 vector should
    // return the inserted memory_id at distance ~0.
    const queryBuf = Buffer.from(v2.buffer, v2.byteOffset, v2.byteLength);
    const rows = store
      .getDatabase()
      .prepare(
        "SELECT memory_id, distance FROM vec_memories_v2 WHERE embedding MATCH vec_int8(?) AND k = 1 ORDER BY distance",
      )
      .all(queryBuf) as Array<{ memory_id: string; distance: number }>;

    expect(rows.length).toBe(1);
    expect(rows[0].memory_id).toBe(entry.id);
    // Self-match against the same int8 bytes — distance should be ~0
    // (cosine of v with itself).
    expect(rows[0].distance).toBeLessThan(0.01);
  });

  it("listMemoriesMissingV2Embedding pages via cursor and excludes already-migrated entries", () => {
    store = createTestStore();
    const v1 = randomEmbedding();
    const v2 = quantizeInt8(randomEmbedding());

    // Plant 3 entries via legacy insert (no v2 row).
    const a = store.insert(
      { content: "alpha", source: "manual", skipDedup: true },
      v1,
    );
    const b = store.insert(
      { content: "beta", source: "manual", skipDedup: true },
      v1,
    );
    const c = store.insert(
      { content: "gamma", source: "manual", skipDedup: true },
      v1,
    );

    // Plant 1 dual-write entry (already has v2).
    store.insertWithDualWrite(
      { content: "delta", source: "manual", skipDedup: true },
      v1,
      v2,
    );

    expect(store.countMemoriesMissingV2Embedding()).toBe(3);

    const all = store.listMemoriesMissingV2Embedding(10, null);
    const allIds = all.map((m) => m.id).sort();
    expect(allIds).toEqual([a.id, b.id, c.id].sort());

    // Cursor-based paging — limit 2, then resume after the first batch.
    const sortedIds = [a.id, b.id, c.id].sort();
    const first = store.listMemoriesMissingV2Embedding(2, null);
    expect(first.length).toBe(2);
    expect(first[0].id).toBe(sortedIds[0]);
    expect(first[1].id).toBe(sortedIds[1]);

    const second = store.listMemoriesMissingV2Embedding(10, sortedIds[1]);
    expect(second.length).toBe(1);
    expect(second[0].id).toBe(sortedIds[2]);
  });

  it("countVecMemoriesV2 returns the v2 row count", () => {
    store = createTestStore();
    expect(store.countVecMemoriesV2()).toBe(0);
    const v1 = randomEmbedding();
    const v2 = quantizeInt8(randomEmbedding());
    store.insertWithDualWrite(
      { content: "alpha", source: "manual", skipDedup: true },
      v1,
      v2,
    );
    expect(store.countVecMemoriesV2()).toBe(1);
  });

  it("deleteMemoryChunksByPath cascades to vec_memory_chunks_v2", () => {
    store = createTestStore();
    const v2 = quantizeInt8(randomEmbedding());

    // Insert a chunk via the existing path (writes vec_memory_chunks float32).
    const chunkId = store.insertMemoryChunk({
      path: "/tmp/test.md",
      chunkIndex: 0,
      heading: "Test",
      body: "Hello world",
      tokenCount: 2,
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: "abc",
      embedding: randomEmbedding(),
    });

    // Plant a v2 chunk vector for this chunk.
    store.insertChunkEmbeddingV2(chunkId, v2);

    const v2ChunkCount = (
      store
        .getDatabase()
        .prepare("SELECT COUNT(*) AS n FROM vec_memory_chunks_v2")
        .get() as { n: number }
    ).n;
    expect(v2ChunkCount).toBe(1);

    // Delete by path — both v1 chunk vec + v2 chunk vec MUST vanish.
    store.deleteMemoryChunksByPath("/tmp/test.md");

    const afterV1 = (
      store
        .getDatabase()
        .prepare("SELECT COUNT(*) AS n FROM vec_memory_chunks")
        .get() as { n: number }
    ).n;
    const afterV2 = (
      store
        .getDatabase()
        .prepare("SELECT COUNT(*) AS n FROM vec_memory_chunks_v2")
        .get() as { n: number }
    ).n;
    expect(afterV1).toBe(0);
    expect(afterV2).toBe(0);
  });
});
