import { describe, it, expect, afterEach } from "vitest";
import pino from "pino";
import { MemoryStore } from "../store.js";
import { EmbeddingV2Migrator } from "../migrations/embedding-v2.js";
import {
  runReEmbedBatch,
  type RunnerEmbedder,
} from "../migrations/embedding-v2-runner.js";
import { quantizeInt8 } from "../embedder-quantize.js";

/**
 * Phase 115 D-08 — embedding-v2 migration state-machine + runner tests.
 *
 * Behaviors covered:
 *   1. State machine — initial state is `idle` even with no row in DB.
 *   2. Legal phase transitions — full happy path: idle → dual-write →
 *      re-embedding → re-embed-complete → cutover → v1-dropped.
 *   3. Illegal phase transitions throw.
 *   4. Rollback path — any non-terminal phase can transition to `rolled-back`.
 *   5. `currentReadVersion` and `currentWriteVersions` reflect phase.
 *   6. Cursor save/resume — `saveCursor` updates `last_cursor` and
 *      `progress_processed`; `getState()` returns the saved values.
 *   7. Cursor save is silently dropped if migrator phase is not
 *      dual-write / re-embedding.
 *   8. Runner skips when phase is `idle` (no work expected).
 *   9. Runner skips when `isAgentActive()` returns true.
 *  10. Runner processes a batch end-to-end: embeds via v2 mock, writes
 *      vec_memories_v2 rows, advances cursor + progress_processed.
 *  11. Runner is resumable across calls — second call picks up where
 *      first left off.
 *  12. Runner auto-transitions to `re-embed-complete` when no work
 *      remains.
 *  13. Mid-batch agent-active flip yields (cursor saved at last
 *      successful write).
 *  14. Runner gracefully handles per-entry embed failures (continues
 *      with the rest of the batch).
 */

function createTestStore(): MemoryStore {
  return new MemoryStore(":memory:");
}

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = (Math.random() * 2 - 1) * 0.1;
  }
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) arr[i] /= norm;
  return arr;
}

class MockEmbedder implements RunnerEmbedder {
  embedCallCount = 0;
  shouldFailFor: Set<string> = new Set();

  async embedV2(text: string): Promise<Int8Array> {
    this.embedCallCount++;
    if (this.shouldFailFor.has(text)) {
      throw new Error(`mock failure for text "${text.slice(0, 32)}"`);
    }
    return quantizeInt8(randomEmbedding());
  }
}

const SILENT_LOG = pino({ level: "silent" });

describe("EmbeddingV2Migrator state machine (Phase 115 D-08)", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  it("initial state is `idle` with empty progress (synthetic — no row in DB)", () => {
    store = createTestStore();
    const m = new EmbeddingV2Migrator(store.getDatabase(), "test-agent");
    const state = m.getState();
    expect(state.phase).toBe("idle");
    expect(state.progressProcessed).toBe(0);
    expect(state.progressTotal).toBe(0);
    expect(state.lastCursor).toBeNull();
    expect(state.startedAt).toBeNull();
  });

  it("happy path transitions: idle -> dual-write -> re-embedding -> re-embed-complete -> cutover -> v1-dropped", () => {
    store = createTestStore();
    const m = new EmbeddingV2Migrator(store.getDatabase(), "test-agent");

    m.transition("dual-write");
    expect(m.getState().phase).toBe("dual-write");
    expect(m.getState().startedAt).not.toBeNull();

    m.transition("re-embedding", 100);
    const reEmbed = m.getState();
    expect(reEmbed.phase).toBe("re-embedding");
    expect(reEmbed.progressTotal).toBe(100);

    m.transition("re-embed-complete");
    expect(m.getState().phase).toBe("re-embed-complete");

    m.transition("cutover");
    expect(m.getState().phase).toBe("cutover");

    m.transition("v1-dropped");
    expect(m.getState().phase).toBe("v1-dropped");
    expect(m.getState().completedAt).not.toBeNull();
  });

  it("illegal transition throws", () => {
    store = createTestStore();
    const m = new EmbeddingV2Migrator(store.getDatabase(), "test-agent");

    // idle -> cutover is illegal (must go through dual-write first).
    expect(() => m.transition("cutover")).toThrow(
      /Illegal embedding-v2 migration transition: idle -> cutover/,
    );

    // dual-write -> v1-dropped is illegal.
    m.transition("dual-write");
    expect(() => m.transition("v1-dropped")).toThrow(
      /Illegal embedding-v2 migration transition: dual-write -> v1-dropped/,
    );
  });

  it("rollback path is legal from any non-terminal phase", () => {
    store = createTestStore();

    // idle -> rolled-back
    {
      const m = new EmbeddingV2Migrator(store.getDatabase(), "agent-a");
      m.transition("rolled-back");
      expect(m.getState().phase).toBe("rolled-back");
      m.transition("dual-write");
      expect(m.getState().phase).toBe("dual-write");
    }

    // re-embedding -> rolled-back
    const m2 = new EmbeddingV2Migrator(store.getDatabase(), "agent-b");
    // Lazy migrations table — agents share the same DB here so re-init
    // means we need a fresh key. Manually reset between agents.
    store.getDatabase().exec("DELETE FROM migrations WHERE key = 'embeddingV2'");
    m2.transition("dual-write");
    m2.transition("re-embedding");
    m2.transition("rolled-back");
    expect(m2.getState().phase).toBe("rolled-back");

    // cutover -> rolled-back
    store.getDatabase().exec("DELETE FROM migrations WHERE key = 'embeddingV2'");
    const m3 = new EmbeddingV2Migrator(store.getDatabase(), "agent-c");
    m3.transition("dual-write");
    m3.transition("re-embedding");
    m3.transition("re-embed-complete");
    m3.transition("cutover");
    m3.transition("rolled-back");
    expect(m3.getState().phase).toBe("rolled-back");
  });

  it("v1-dropped allows ONLY rollback (Phase 999.119 pass 2), and only while v1 vectors exist", () => {
    store = createTestStore();
    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");

    m.transition("dual-write");
    m.transition("re-embedding");
    m.transition("re-embed-complete");
    m.transition("cutover");
    m.transition("v1-dropped");

    expect(() => m.transition("dual-write")).toThrow(/Illegal/);
    // No v1 rows at all → the phase name is true → rollback refused.
    expect(() => m.transition("rolled-back")).toThrow(/vec_memories is empty/);
    expect(m.getState().phase).toBe("v1-dropped");

    // Production shape: "v1-dropped" with a fully populated v1 table.
    const vec = new Float32Array(384);
    vec[0] = 1;
    store.insert({ content: "still here", source: "manual", skipDedup: true }, vec);
    m.transition("rolled-back");
    expect(m.getState().phase).toBe("rolled-back");
    expect(m.currentReadVersion()).toBe("v1");
    expect(m.currentWriteVersions()).toEqual(["v1"]);
    expect(m.getState().completedAt).not.toBeNull();
  });

  it("currentReadVersion is v1 until cutover", () => {
    store = createTestStore();
    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");

    expect(m.currentReadVersion()).toBe("v1");
    m.transition("dual-write");
    expect(m.currentReadVersion()).toBe("v1");
    m.transition("re-embedding");
    expect(m.currentReadVersion()).toBe("v1");
    m.transition("re-embed-complete");
    expect(m.currentReadVersion()).toBe("v1");
    m.transition("cutover");
    expect(m.currentReadVersion()).toBe("v2");
    m.transition("v1-dropped");
    expect(m.currentReadVersion()).toBe("v2");
  });

  it("currentWriteVersions covers all phases per Phase 115 D-08", () => {
    store = createTestStore();
    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");

    // idle: v1 only
    expect(m.currentWriteVersions()).toEqual(["v1"]);

    // dual-write: v1 + v2
    m.transition("dual-write");
    expect(m.currentWriteVersions()).toEqual(["v1", "v2"]);

    // re-embedding: v1 + v2 (dual-write continues)
    m.transition("re-embedding");
    expect(m.currentWriteVersions()).toEqual(["v1", "v2"]);

    // re-embed-complete: v1 + v2 (still dual-write until cutover)
    m.transition("re-embed-complete");
    expect(m.currentWriteVersions()).toEqual(["v1", "v2"]);

    // cutover: v2 only
    m.transition("cutover");
    expect(m.currentWriteVersions()).toEqual(["v2"]);

    // v1-dropped: v2 only
    m.transition("v1-dropped");
    expect(m.currentWriteVersions()).toEqual(["v2"]);

    // rolled-back: v1 only
    store.getDatabase().exec("DELETE FROM migrations WHERE key = 'embeddingV2'");
    const m2 = new EmbeddingV2Migrator(store.getDatabase(), "agent2");
    m2.transition("rolled-back");
    expect(m2.currentWriteVersions()).toEqual(["v1"]);
  });

  it("saveCursor updates last_cursor + progress_processed (resumable)", () => {
    store = createTestStore();
    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");

    m.transition("dual-write");
    m.transition("re-embedding", 100);

    m.saveCursor("memory-id-1", 1);
    let s = m.getState();
    expect(s.lastCursor).toBe("memory-id-1");
    expect(s.progressProcessed).toBe(1);

    m.saveCursor("memory-id-50", 50);
    s = m.getState();
    expect(s.lastCursor).toBe("memory-id-50");
    expect(s.progressProcessed).toBe(50);
  });

  it("saveCursor silently no-ops once the migration is rolled back (Phase 999.119: writing phases keep it)", () => {
    store = createTestStore();
    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");

    m.transition("dual-write");
    m.saveCursor("memory-id-x", 5);
    m.transition("re-embedding");
    m.transition("re-embed-complete");
    m.saveCursor("memory-id-y", 6); // still a v2-writing phase — kept
    expect(m.getState().lastCursor).toBe("memory-id-y");
    m.transition("rolled-back");
    m.saveCursor("memory-id-z", 999); // rolled back — silently dropped
    const s = m.getState();
    expect(s.lastCursor).toBe("memory-id-y");
    expect(s.progressProcessed).toBe(6);
  });

  it("shouldRunReEmbedBatch is true in every v2-writing phase (Phase 999.119 v2 switch)", () => {
    store = createTestStore();
    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");

    expect(m.shouldRunReEmbedBatch()).toBe(false); // idle
    m.transition("dual-write");
    expect(m.shouldRunReEmbedBatch()).toBe(true);
    m.transition("re-embedding");
    expect(m.shouldRunReEmbedBatch()).toBe(true);
    m.transition("re-embed-complete");
    expect(m.shouldRunReEmbedBatch()).toBe(true); // chunks may still be filling
    m.transition("cutover");
    expect(m.shouldRunReEmbedBatch()).toBe(true); // self-heals dual-write misses
    m.transition("rolled-back");
    expect(m.shouldRunReEmbedBatch()).toBe(false);
  });
});

describe("runReEmbedBatch (Phase 115 D-08 + D-09)", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  it("skips when migrator phase is idle", async () => {
    store = createTestStore();
    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    const e = new MockEmbedder();
    const result = await runReEmbedBatch(
      m,
      store,
      e,
      { cpuBudgetPct: 5, batchSize: 50 },
      () => false,
      SILENT_LOG,
    );
    expect(result.processed).toBe(0);
    expect(result.skippedReason).toMatch(/phase=idle/);
    expect(e.embedCallCount).toBe(0);
  });

  it("skips when isAgentActive() returns true", async () => {
    store = createTestStore();
    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    m.transition("dual-write");
    const e = new MockEmbedder();
    const result = await runReEmbedBatch(
      m,
      store,
      e,
      { cpuBudgetPct: 5, batchSize: 50 },
      () => true, // agent active
      SILENT_LOG,
    );
    expect(result.processed).toBe(0);
    expect(result.skippedReason).toBe("agent-active");
    expect(e.embedCallCount).toBe(0);
  });

  it("processes a batch end-to-end (embed + write v2 row + advance cursor)", async () => {
    store = createTestStore();
    // Plant 3 entries via legacy insert (no v2 row yet).
    const inputs = ["alpha", "beta", "gamma"];
    const ids = inputs.map((c) =>
      store.insert(
        { content: c, source: "manual", skipDedup: true },
        randomEmbedding(),
      ).id,
    );

    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    m.transition("dual-write");
    m.transition("re-embedding", 3);

    const e = new MockEmbedder();
    const result = await runReEmbedBatch(
      m,
      store,
      e,
      { cpuBudgetPct: 5, batchSize: 10 },
      () => false,
      SILENT_LOG,
    );

    expect(result.processed).toBe(3);
    expect(result.remaining).toBe(0);
    expect(e.embedCallCount).toBe(3);

    // All 3 entries should now have v2 rows.
    expect(store.countMemoriesMissingV2Embedding()).toBe(0);
    expect(store.countVecMemoriesV2()).toBe(3);

    // Cursor advanced.
    const state = m.getState();
    expect(state.lastCursor).toBe(ids.sort()[2]); // last id processed (sorted ASC)
    expect(state.progressProcessed).toBe(3);
  });

  it("is resumable across calls — second call picks up after first", async () => {
    store = createTestStore();
    const inputs = ["a", "b", "c", "d", "e"];
    inputs.forEach((c) =>
      store.insert(
        { content: c, source: "manual", skipDedup: true },
        randomEmbedding(),
      ),
    );

    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    m.transition("dual-write");
    m.transition("re-embedding", 5);

    const e = new MockEmbedder();

    // First call — batch size 2, processes 2 entries.
    const r1 = await runReEmbedBatch(
      m,
      store,
      e,
      { cpuBudgetPct: 5, batchSize: 2 },
      () => false,
      SILENT_LOG,
    );
    expect(r1.processed).toBe(2);

    // Second call — batch size 2, processes next 2.
    const r2 = await runReEmbedBatch(
      m,
      store,
      e,
      { cpuBudgetPct: 5, batchSize: 2 },
      () => false,
      SILENT_LOG,
    );
    expect(r2.processed).toBe(2);

    // Third call — batch size 2, processes last 1.
    const r3 = await runReEmbedBatch(
      m,
      store,
      e,
      { cpuBudgetPct: 5, batchSize: 2 },
      () => false,
      SILENT_LOG,
    );
    expect(r3.processed).toBe(1);

    expect(store.countMemoriesMissingV2Embedding()).toBe(0);
    expect(m.getState().progressProcessed).toBe(5);
  });

  it("auto-transitions to re-embed-complete when no work remains", async () => {
    store = createTestStore();
    // Plant + dual-write 1 entry so it already has v2 (no work).
    const v1 = randomEmbedding();
    const v2 = quantizeInt8(randomEmbedding());
    store.insertWithDualWrite(
      { content: "alpha", source: "manual", skipDedup: true },
      v1,
      v2,
    );

    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    m.transition("dual-write");
    m.transition("re-embedding", 0);

    const e = new MockEmbedder();
    const result = await runReEmbedBatch(
      m,
      store,
      e,
      { cpuBudgetPct: 5, batchSize: 50 },
      () => false,
      SILENT_LOG,
    );

    expect(result.processed).toBe(0);
    expect(result.remaining).toBe(0);
    expect(m.getState().phase).toBe("re-embed-complete");
  });

  it("yields mid-batch when isAgentActive flips true", async () => {
    store = createTestStore();
    const inputs = ["a", "b", "c", "d", "e"];
    inputs.forEach((c) =>
      store.insert(
        { content: c, source: "manual", skipDedup: true },
        randomEmbedding(),
      ),
    );

    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    m.transition("dual-write");
    m.transition("re-embedding", 5);

    const e = new MockEmbedder();

    // isAgentActive returns false for first 2 calls then true.
    let activeCheckCount = 0;
    const isActive = (): boolean => {
      activeCheckCount++;
      return activeCheckCount > 2; // active starting at the 3rd check
    };

    const result = await runReEmbedBatch(
      m,
      store,
      e,
      { cpuBudgetPct: 5, batchSize: 5 },
      isActive,
      SILENT_LOG,
    );

    // First check (top of function) returns false. 2nd check (start of
    // first loop iteration) returns false. 3rd check (start of 2nd
    // iteration) returns true → yield. So 1 entry processed.
    expect(result.processed).toBe(1);
    expect(store.countVecMemoriesV2()).toBe(1);
  });

  it("resets last_cursor when cursor advances past nanoid-shuffled missing rows (116-postdeploy 2026-05-13 fin-client fix)", async () => {
    // Production bug: fin-client stuck at 1407/1408 (later 1407/1415).
    // Root cause: nanoid IDs sort randomly, so a memory inserted AFTER the
    // cursor advanced past a high-sorting id can have a LOWER id. The
    // runner's `id > last_cursor` filter then makes that memory invisible
    // — countMemoriesMissingV2Embedding() reports it (no cursor filter),
    // but listMemoriesMissingV2Embedding(cursor) returns []. The runner
    // returned `processed: 0, remaining: N` forever.
    //
    // Fix: when batch is empty AND totalMissing > 0, reset last_cursor to
    // NULL and reconcile progress_total. Next tick scans from the start
    // and finds the row.
    store = createTestStore();

    // Plant 3 rows, dual-write 2 of them so only ONE is missing v2. Then
    // force last_cursor to a SUPER high value so the missing row sorts
    // before it. Mirrors what production looked like (cursor past valid
    // work).
    const v1A = randomEmbedding();
    const v1B = randomEmbedding();
    const v1C = randomEmbedding();
    const idA = store.insertWithDualWrite(
      { content: "alpha (already v2)", source: "manual", skipDedup: true },
      v1A,
      quantizeInt8(randomEmbedding()),
    ).id;
    const idB = store.insertWithDualWrite(
      { content: "beta (already v2)", source: "manual", skipDedup: true },
      v1B,
      quantizeInt8(randomEmbedding()),
    ).id;
    // gamma is v1-only — the "stuck" row.
    const idGamma = store.insert(
      { content: "gamma (missing v2)", source: "manual", skipDedup: true },
      v1C,
    ).id;

    // Sanity — gamma should be the ONLY missing-v2 entry.
    expect(store.countMemoriesMissingV2Embedding()).toBe(1);

    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    m.transition("dual-write");
    m.transition("re-embedding", 1);

    // Force the cursor PAST gamma's id by saving a synthetic high id.
    // Use ASCII 0x7E (~) repeated — sorts after every nanoid character.
    const stuckCursor = "~~~~~~~~~~~~~~~~~~~~~";
    expect(idA < stuckCursor).toBe(true);
    expect(idB < stuckCursor).toBe(true);
    expect(idGamma < stuckCursor).toBe(true);
    m.saveCursor(stuckCursor, 5); // pretend 5 already processed

    const e = new MockEmbedder();

    // FIRST tick — cursor is past gamma's id. Runner sees batch.length=0
    // AND totalMissing=1. Pre-fix: returned without resetting → stuck
    // forever. Post-fix: resets last_cursor to NULL + reconciles total.
    const r1 = await runReEmbedBatch(
      m,
      store,
      e,
      { cpuBudgetPct: 5, batchSize: 10 },
      () => false,
      SILENT_LOG,
    );
    expect(r1.processed).toBe(0);
    // The runner reports `remaining: totalMissing` on this branch (1
    // before the reset succeeded — the count is computed pre-reset).
    expect(r1.remaining).toBe(1);

    const stateAfterReset = m.getState();
    expect(stateAfterReset.lastCursor).toBeNull();
    // progress_total reconciled to processed + missing.
    expect(stateAfterReset.progressTotal).toBe(6);

    // SECOND tick — cursor is null, scan from start finds gamma.
    const r2 = await runReEmbedBatch(
      m,
      store,
      e,
      { cpuBudgetPct: 5, batchSize: 10 },
      () => false,
      SILENT_LOG,
    );
    expect(r2.processed).toBe(1);
    expect(store.countMemoriesMissingV2Embedding()).toBe(0);

    // THIRD tick — count is now 0, runner auto-transitions to complete.
    const r3 = await runReEmbedBatch(
      m,
      store,
      e,
      { cpuBudgetPct: 5, batchSize: 10 },
      () => false,
      SILENT_LOG,
    );
    expect(r3.processed).toBe(0);
    expect(m.getState().phase).toBe("re-embed-complete");
  });

  it("continues batch on per-entry embed failure", async () => {
    store = createTestStore();
    const inputs = ["good-1", "BAD-MEMORY", "good-2"];
    inputs.forEach((c) =>
      store.insert(
        { content: c, source: "manual", skipDedup: true },
        randomEmbedding(),
      ),
    );

    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    m.transition("dual-write");
    m.transition("re-embedding", 3);

    const e = new MockEmbedder();
    e.shouldFailFor.add("BAD-MEMORY");

    const result = await runReEmbedBatch(
      m,
      store,
      e,
      { cpuBudgetPct: 5, batchSize: 10 },
      () => false,
      SILENT_LOG,
    );

    // 2 of 3 succeed (the bad one is skipped, batch continues).
    expect(result.processed).toBe(2);
    expect(store.countVecMemoriesV2()).toBe(2);
  });
});
