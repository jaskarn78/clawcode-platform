/**
 * Phase 116-postdeploy 2026-05-12 — regression test for auto-firing orphan
 * cleanup on the `re-embedding → re-embed-complete` transition.
 *
 * THE BUG THIS GUARDS:
 *   Operator observed "v2: 982 / 1664 (59%)" on a fully-migrated agent.
 *   Of the 1664, 682 were ORPHAN `vec_memories_v2` rows whose memory_id
 *   no longer exists in the `memories` table — pre-cascade residue from
 *   Phase 107's window. The percentage display never moves toward 100%
 *   because the orphan denominator is fixed. Manual cleanup via
 *   `clawcode memory cleanup-orphans` worked, but operators shouldn't have
 *   to remember to run it; the natural moment is the auto-transition to
 *   `re-embed-complete` when the runner finishes.
 *
 * THE INVARIANT:
 *   `runBatchForAgent` from `src/manager/migration-cron.ts` MUST fire
 *   `store.cleanupOrphansSplit()` exactly when the phase advances from a
 *   non-complete phase to `re-embed-complete` during this batch — and
 *   MUST NOT fire it on subsequent ticks (idempotency check: when phase
 *   was already `re-embed-complete` before AND after, the cleanup must
 *   NOT run because the cron pre-check skips on non-working phases).
 */

import { describe, it, expect, afterEach } from "vitest";
import pino from "pino";
import { MemoryStore } from "../../memory/store.js";
import { EmbeddingV2Migrator } from "../../memory/migrations/embedding-v2.js";
import { quantizeInt8 } from "../../memory/embedder-quantize.js";
import type { RunnerEmbedder } from "../../memory/migrations/embedding-v2-runner.js";
import { runBatchForAgent, type MigrationCronManager } from "../migration-cron.js";
import type { Config } from "../../config/schema.js";

const SILENT_LOG = pino({ level: "silent" });

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) arr[i] = (Math.random() * 2 - 1) * 0.1;
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) arr[i] /= norm;
  return arr;
}

class MockEmbedder implements RunnerEmbedder {
  async embedV2(_text: string): Promise<Int8Array> {
    return quantizeInt8(randomEmbedding());
  }
}

function makeManager(
  store: MemoryStore,
  embedder: RunnerEmbedder,
): MigrationCronManager {
  // MigrationCronManager is Pick<SessionManager, "getRunningAgents" |
  // "getMemoryStore" | "getEmbedder" | "hasActiveTurn">. Cast the mock
  // embedder to EmbeddingService at the boundary — runBatchForAgent only
  // calls embedder.embedV2.
  return {
    getRunningAgents: () => ["agent"],
    getMemoryStore: (_name: string) => store,
    getEmbedder: () => embedder as unknown as ReturnType<MigrationCronManager["getEmbedder"]>,
    hasActiveTurn: (_name: string) => false,
  } as unknown as MigrationCronManager;
}

const MIN_CONFIG = {
  defaults: { embeddingMigration: { batchSize: 50, cpuBudgetPct: 5 } },
} as unknown as Config;

/**
 * Plant ONE orphan in vec_memories + ONE orphan in vec_memories_v2. We do
 * this by inserting a memory + its vec rows, then deleting JUST the
 * `memories` row via raw SQL (bypassing store.delete which would cascade).
 * This mimics the historical pre-cascade leak shape.
 */
function plantOrphan(store: MemoryStore, content: string): void {
  const result = store.insertWithDualWrite(
    { content, source: "manual", skipDedup: true },
    randomEmbedding(),
    quantizeInt8(randomEmbedding()),
  );
  // Strip just the memories row — leaves vec_memories + vec_memories_v2
  // rows as orphans.
  store
    .getDatabase()
    .prepare("DELETE FROM memories WHERE id = ?")
    .run(result.id);
}

describe("migration-cron auto-fires orphan cleanup on re-embed-complete transition", () => {
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
  });

  it("fires cleanupOrphansSplit when batch finishes re-embed and transitions to re-embed-complete", async () => {
    store = new MemoryStore(":memory:");

    // Plant: 1 real memory in v1-only (needs re-embed).
    store.insert(
      { content: "real-memory", source: "manual", skipDedup: true },
      randomEmbedding(),
    );

    // Plant: 3 orphans (v1+v2 vec rows with no memory row).
    plantOrphan(store, "orphan-1");
    plantOrphan(store, "orphan-2");
    plantOrphan(store, "orphan-3");

    // Sanity — orphans exist BEFORE the cron tick.
    const dbBefore = store.getDatabase();
    expect(
      (dbBefore.prepare("SELECT COUNT(*) AS n FROM vec_memories").get() as { n: number }).n,
    ).toBe(4); // 1 real + 3 orphans
    expect(
      (dbBefore.prepare("SELECT COUNT(*) AS n FROM vec_memories_v2").get() as { n: number }).n,
    ).toBe(3); // 3 orphans (real memory has no v2 yet)

    // Drive the migrator into re-embedding so the cron runs the batch.
    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    m.transition("dual-write");
    m.transition("re-embedding", 1);

    const embedder = new MockEmbedder();
    // First tick: runner embeds the 1 real memory + advances cursor. The
    // runner's auto-transition checks `totalMissing === 0` at START of
    // batch; first tick sees totalMissing=1 so it processes, then leaves
    // the phase at `re-embedding`.
    await runBatchForAgent({
      agent: "agent",
      manager: makeManager(store, embedder),
      config: MIN_CONFIG,
      log: SILENT_LOG,
    });
    // Second tick: runner sees totalMissing === 0 → auto-transitions to
    // `re-embed-complete`. Our cron's phase-before/after observer catches
    // this edge and fires cleanupOrphansSplit.
    await runBatchForAgent({
      agent: "agent",
      manager: makeManager(store, embedder),
      config: MIN_CONFIG,
      log: SILENT_LOG,
    });

    // Phase advanced.
    const afterPhase = new EmbeddingV2Migrator(
      store.getDatabase(),
      "agent",
    ).getState().phase;
    expect(afterPhase).toBe("re-embed-complete");

    // Orphans cleaned — vec_memories now has 1 row (the real memory),
    // vec_memories_v2 has 1 row (the real memory's freshly written v2
    // embedding). All 3 orphan pairs gone.
    const dbAfter = store.getDatabase();
    expect(
      (dbAfter.prepare("SELECT COUNT(*) AS n FROM vec_memories").get() as { n: number }).n,
    ).toBe(1);
    expect(
      (dbAfter.prepare("SELECT COUNT(*) AS n FROM vec_memories_v2").get() as { n: number }).n,
    ).toBe(1);
  });

  it("does NOT re-fire cleanup once phase is already re-embed-complete (idempotency)", async () => {
    store = new MemoryStore(":memory:");

    // Set phase straight to re-embed-complete + plant orphans.
    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    m.transition("dual-write");
    m.transition("re-embedding");
    m.transition("re-embed-complete");

    plantOrphan(store, "orphan-1");
    plantOrphan(store, "orphan-2");

    const beforeOrphanCount = (
      store
        .getDatabase()
        .prepare("SELECT COUNT(*) AS n FROM vec_memories_v2")
        .get() as { n: number }
    ).n;
    expect(beforeOrphanCount).toBe(2);

    const embedder = new MockEmbedder();
    await runBatchForAgent({
      agent: "agent",
      manager: makeManager(store, embedder),
      config: MIN_CONFIG,
      log: SILENT_LOG,
    });

    // The cron's WORKING_PHASES pre-check (`dual-write | re-embedding`)
    // means re-embed-complete is skipped entirely — runBatch returns
    // early, no cleanup runs. Orphans remain (operator can still trigger
    // the manual `clawcode memory cleanup-orphans` / dashboard button).
    // This guards against accidentally turning the cron into a
    // continuously-firing cleanup loop.
    const afterOrphanCount = (
      store
        .getDatabase()
        .prepare("SELECT COUNT(*) AS n FROM vec_memories_v2")
        .get() as { n: number }
    ).n;
    expect(afterOrphanCount).toBe(2);
  });

  it("does NOT fire cleanup mid-re-embedding when phase stays re-embedding", async () => {
    store = new MemoryStore(":memory:");

    // Plant: 5 real memories needing re-embed.
    for (let i = 0; i < 5; i++) {
      store.insert(
        { content: `mem-${i}`, source: "manual", skipDedup: true },
        randomEmbedding(),
      );
    }

    // Plant: 2 orphans.
    plantOrphan(store, "orphan-1");
    plantOrphan(store, "orphan-2");

    const m = new EmbeddingV2Migrator(store.getDatabase(), "agent");
    m.transition("dual-write");
    m.transition("re-embedding", 5);

    const embedder = new MockEmbedder();
    // batchSize=2 — runner processes 2 of 5, stays in re-embedding.
    await runBatchForAgent({
      agent: "agent",
      manager: makeManager(store, embedder),
      config: {
        defaults: { embeddingMigration: { batchSize: 2, cpuBudgetPct: 5 } },
      } as unknown as Config,
      log: SILENT_LOG,
    });

    // Phase stays re-embedding — cleanup must NOT have fired.
    const afterPhase = new EmbeddingV2Migrator(
      store.getDatabase(),
      "agent",
    ).getState().phase;
    expect(afterPhase).toBe("re-embedding");

    // Orphans still present (only the auto-transition fires cleanup).
    const orphanCount = (
      store
        .getDatabase()
        .prepare("SELECT COUNT(*) AS n FROM vec_memories_v2")
        .get() as { n: number }
    ).n;
    // 2 freshly-written v2 rows (for the 2 processed real memories) +
    // 2 orphans = 4. The exact assertion: orphans (vec_memories_v2 rows
    // whose memory_id isn't in `memories`) is still 2.
    expect(orphanCount).toBe(4);
    const orphansRemaining = (
      store
        .getDatabase()
        .prepare(
          "SELECT COUNT(*) AS n FROM vec_memories_v2 WHERE memory_id NOT IN (SELECT id FROM memories)",
        )
        .get() as { n: number }
    ).n;
    expect(orphansRemaining).toBe(2);
  });
});
