import { describe, it, expect, afterEach, vi } from "vitest";
import { MemoryStore } from "../store.js";

/**
 * Phase 107 VEC-CLEAN-04 — vitest coverage for `MemoryStore.cleanupOrphans()`.
 *
 * Behaviors covered:
 * - removes-orphans: orphan vec_memories rows (memory_id NOT IN memories) are deleted
 * - idempotent: second invocation removes 0
 * - preserves-cold: cold-archive shape (memory present + vec absent) is the OPPOSITE
 *   of an orphan and MUST be left untouched. This is the directional pitfall test
 *   from RESEARCH.md pitfall 3.
 * - atomic: a mid-transaction throw rolls back the DELETE
 * - no-orphans-clean-state: returns `{ removed: 0, totalAfter: N }` when DB is clean
 */

function createTestStore(): MemoryStore {
  return new MemoryStore(":memory:");
}

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.random() * 2 - 1;
  }
  return arr;
}

function countVecRows(store: MemoryStore): number {
  const row = store
    .getDatabase()
    .prepare("SELECT COUNT(*) AS n FROM vec_memories")
    .get() as { n: number };
  return row.n;
}

function countMemoryRows(store: MemoryStore): number {
  const row = store
    .getDatabase()
    .prepare("SELECT COUNT(*) AS n FROM memories")
    .get() as { n: number };
  return row.n;
}

describe("MemoryStore.cleanupOrphans (Phase 107 VEC-CLEAN-03)", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  it("removes-orphans — deletes vec_memories rows whose memory_id is missing from memories", () => {
    store = createTestStore();
    const a = store.insert(
      { content: "alpha", source: "manual", skipDedup: true },
      randomEmbedding(),
    );
    const b = store.insert(
      { content: "beta", source: "manual", skipDedup: true },
      randomEmbedding(),
    );
    const c = store.insert(
      { content: "gamma", source: "manual", skipDedup: true },
      randomEmbedding(),
    );

    // Sanity: 3 paired rows.
    expect(countMemoryRows(store)).toBe(3);
    expect(countVecRows(store)).toBe(3);

    // Simulate a leaky delete path that bypasses MemoryStore.delete (mimics
    // the historical CHECK-constraint table-recreation migration drop):
    // remove the `memories` row WITHOUT touching `vec_memories`. The vec
    // row for `b.id` is now an orphan.
    store
      .getDatabase()
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(b.id);

    expect(countMemoryRows(store)).toBe(2);
    expect(countVecRows(store)).toBe(3);

    const result = store.cleanupOrphans();

    expect(result).toEqual({ removed: 1, totalAfter: 2 });
    expect(countVecRows(store)).toBe(2);

    // The remaining vec_memories rows are exactly the IDs still in memories.
    const remaining = store
      .getDatabase()
      .prepare("SELECT memory_id FROM vec_memories ORDER BY memory_id")
      .all() as Array<{ memory_id: string }>;
    const remainingIds = remaining.map((r) => r.memory_id).sort();
    expect(remainingIds).toEqual([a.id, c.id].sort());
    expect(remainingIds).not.toContain(b.id);
  });

  it("idempotent — second call after a successful cleanup removes 0", () => {
    store = createTestStore();
    store.insert(
      { content: "alpha", source: "manual", skipDedup: true },
      randomEmbedding(),
    );
    const b = store.insert(
      { content: "beta", source: "manual", skipDedup: true },
      randomEmbedding(),
    );
    store.insert(
      { content: "gamma", source: "manual", skipDedup: true },
      randomEmbedding(),
    );

    store
      .getDatabase()
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(b.id);

    const first = store.cleanupOrphans();
    expect(first).toEqual({ removed: 1, totalAfter: 2 });

    const second = store.cleanupOrphans();
    expect(second).toEqual({ removed: 0, totalAfter: 2 });

    // No drift after the second invocation.
    expect(countVecRows(store)).toBe(2);
  });

  it("preserves-cold — cold-archive shape (memory row present, vec absent) is NOT touched (directional pitfall)", () => {
    store = createTestStore();
    const a = store.insert(
      { content: "alpha", source: "manual", skipDedup: true },
      randomEmbedding(),
    );
    const b = store.insert(
      { content: "beta", source: "manual", skipDedup: true },
      randomEmbedding(),
    );

    // Replicate cold-archival shape (episode-archival.ts:53-66):
    //   - tier set to cold on the memory row
    //   - vec_memories row deleted
    //   - memories row STAYS
    // This is the OPPOSITE of an orphan: memory present + vec absent.
    // cleanupOrphans must NEVER delete from `memories`; otherwise it would
    // erase intentionally cold-archived memories.
    store
      .getDatabase()
      .prepare("UPDATE memories SET tier = 'cold' WHERE id = ?")
      .run(b.id);
    store
      .getDatabase()
      .prepare("DELETE FROM vec_memories WHERE memory_id = ?")
      .run(b.id);

    expect(countMemoryRows(store)).toBe(2);
    expect(countVecRows(store)).toBe(1);

    const result = store.cleanupOrphans();

    // Nothing to clean — there is no orphan vec row. The cold-archived
    // memory must still be present after cleanup.
    expect(result).toEqual({ removed: 0, totalAfter: 1 });
    expect(countMemoryRows(store)).toBe(2);
    expect(countVecRows(store)).toBe(1);

    // Both memory rows still queryable.
    expect(store.getById(a.id)).not.toBeNull();
    expect(store.getById(b.id)).not.toBeNull();
  });

  it("atomic — mid-transaction throw rolls back the DELETE (vec_memories count unchanged)", () => {
    store = createTestStore();
    const a = store.insert(
      { content: "alpha", source: "manual", skipDedup: true },
      randomEmbedding(),
    );
    const b = store.insert(
      { content: "beta", source: "manual", skipDedup: true },
      randomEmbedding(),
    );
    store.insert(
      { content: "gamma", source: "manual", skipDedup: true },
      randomEmbedding(),
    );

    // Setup orphans by bypassing MemoryStore.delete.
    store
      .getDatabase()
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(a.id);
    store
      .getDatabase()
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(b.id);

    expect(countMemoryRows(store)).toBe(1);
    expect(countVecRows(store)).toBe(3);
    const before = countVecRows(store);

    // Spy on db.prepare so the COUNT(*) follow-up call (after the DELETE
    // ran inside the same transaction) throws — better-sqlite3 rolls back
    // the entire transaction synchronously. Note: db.transaction() callbacks
    // run synchronously, so a thrown error from any prepare invocation
    // inside the closure rolls back any DELETE that already succeeded.
    const db = store.getDatabase();
    const realPrepare = db.prepare.bind(db);
    let callCount = 0;
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      callCount++;
      // First call: the DELETE — let it through.
      // Second call: COUNT(*) — throw to force rollback.
      if (callCount >= 2) {
        throw new Error("simulated mid-transaction failure");
      }
      return realPrepare(sql);
    });

    expect(() => store.cleanupOrphans()).toThrow(
      /simulated mid-transaction failure/,
    );

    spy.mockRestore();

    // Rollback invariant: vec_memories row count is unchanged from before
    // the failed cleanup attempt.
    expect(countVecRows(store)).toBe(before);
  });

  it("no-orphans-clean-state — returns { removed: 0, totalAfter: N } when DB is fully paired", () => {
    store = createTestStore();
    store.insert(
      { content: "alpha", source: "manual", skipDedup: true },
      randomEmbedding(),
    );
    store.insert(
      { content: "beta", source: "manual", skipDedup: true },
      randomEmbedding(),
    );
    store.insert(
      { content: "gamma", source: "manual", skipDedup: true },
      randomEmbedding(),
    );

    const result = store.cleanupOrphans();

    expect(result).toEqual({ removed: 0, totalAfter: 3 });
    expect(countMemoryRows(store)).toBe(3);
    expect(countVecRows(store)).toBe(3);
  });
});
