/**
 * Phase 141 — best-effort embedding-v2 dual-write for NEW memory/chunk writes.
 *
 * Background. The embedding-v2 migration (Phase 115 D-08) backfills historical
 * rows with a `bge-small-int8` v2 vector via a forward-cursor batch
 * (`runReEmbedBatch`, scheduled every 30s). But new memories written during the
 * migration were embedded v1-only — and because the backfill cursor is
 * monotonic, any write that lands *behind* the cursor is never revisited. So v1
 * grew ahead of v2 and an operator had to keep "re-syncing" (resetting the
 * cursor). This closes that leak: when an agent's migration is in a phase where
 * v1 is still the primary write format AND v2 is being populated, each new
 * memory/chunk also gets its v2 vector at write time.
 *
 * BEST-EFFORT, NON-BLOCKING. These run fire-and-forget from the MemoryStore
 * insert hooks (NOT awaited, NOT inside the v1 transaction). A v2 embed failure
 * (model warmup hiccup, etc.) is logged and swallowed — it must never fail or
 * roll back the committed v1 write; the re-embed backfill remains the
 * self-healing net for anything missed.
 */

import type { Logger } from "pino";

import {
  EmbeddingV2Migrator,
  type EmbeddingMigrationPhase,
} from "./migrations/embedding-v2.js";
import type { EmbeddingService } from "./embedder.js";
import type { MemoryStore } from "./store.js";
import { V2_WRITE_PHASES } from "./embedding-version.js";

/**
 * Phases where a new write should ALSO populate v2: v1 is still the primary
 * read/write format and v2 is being filled alongside it.
 *
 * Excluded:
 *  - `idle`        — migration not started; no v2 column data expected. NOTE
 *    this fix is a NO-OP in `idle`: if an agent shows v1>v2 drift while idle,
 *    that's a separate diagnosis (the migration was never started for it).
 *  - `cutover` / `v1-dropped` — reads are on v2 and the write format itself
 *    changes; that transition is owned by the migration state machine, not this
 *    forward-leak guard (no agent is there today).
 *
 * FOLLOW-UP: when an agent is first flipped to `cutover`/`v1-dropped`, new writes
 * will NOT dual-write v2 through this path — whoever does that cutover must
 * confirm the write format is handled (today the migration state machine owns it
 * and no agent is there). Minor best-effort residuals, intentionally not fixed:
 *  - a dedup-MERGE returns the existing memory without re-embedding, so a merged
 *    memory's v2 vector reflects the pre-merge content (the backfill re-embeds it);
 *  - the doc-ingest cross-ingest path computes its own chunk embedV2, so the
 *    runtime-store chunk hook may double-embed it (idempotent INSERT-OR-REPLACE).
 */
// Phase 999.119 v2 switch — v1 is ALWAYS written (it is the dedup space
// and the instant-rollback path), and v2 is written from `dual-write`
// through `cutover`, so a v2-reading agent's new memories are searchable
// the moment they land. Single source of truth: embedding-version.ts.
const V2_DUAL_WRITE_PHASES: ReadonlySet<EmbeddingMigrationPhase> = V2_WRITE_PHASES;

export interface DualWriteDeps {
  readonly store: MemoryStore;
  readonly embedder: EmbeddingService;
  readonly agent: string;
  readonly log: Logger;
}

/** Read the agent's current embedding-migration phase. Best-effort: `idle` on any error. */
export function readMigrationPhase(
  deps: Pick<DualWriteDeps, "store" | "agent">,
): EmbeddingMigrationPhase {
  try {
    return new EmbeddingV2Migrator(
      deps.store.getDatabase(),
      deps.agent,
    ).getState().phase;
  } catch {
    return "idle";
  }
}

/** Whether new writes for this agent should also embed + store v2 right now. */
export function shouldDualWriteV2(
  deps: Pick<DualWriteDeps, "store" | "agent">,
): boolean {
  return V2_DUAL_WRITE_PHASES.has(readMigrationPhase(deps));
}

/** Best-effort v2 dual-write for a just-committed memory row. Never throws. */
export async function dualWriteMemoryV2(
  deps: DualWriteDeps,
  memoryId: string,
  content: string,
): Promise<void> {
  try {
    // Skip if a concurrent agent stop/restart already closed the store. This
    // hook is fire-and-forget, so its microtask can run AFTER cleanupMemory
    // closed the connection. Checked BEFORE shouldDualWriteV2 (which itself
    // queries the db) to avoid "The database connection is not open". The
    // backfill re-embeds anything skipped here.
    if (!deps.store.isOpen() || !shouldDualWriteV2(deps)) return;
    const v2 = await deps.embedder.embedV2(content);
    // Re-check: the await above is a yield point — the store may have closed
    // during the embed.
    if (!deps.store.isOpen()) return;
    deps.store.insertEmbeddingV2(memoryId, v2);
  } catch (err) {
    deps.log.warn(
      { agent: deps.agent, memoryId, err: (err as Error)?.message },
      "embedding-v2 dual-write (memory) best-effort failed — backfill will retry",
    );
  }
}

/** Best-effort v2 dual-write for a just-committed memory chunk. Never throws. */
export async function dualWriteChunkV2(
  deps: DualWriteDeps,
  chunkId: string,
  body: string,
): Promise<void> {
  try {
    // See dualWriteMemoryV2 — skip cleanly if a concurrent stop closed the
    // store (before the query AND after the async embed yield point).
    if (!deps.store.isOpen() || !shouldDualWriteV2(deps)) return;
    const v2 = await deps.embedder.embedV2(body);
    if (!deps.store.isOpen()) return;
    deps.store.insertChunkEmbeddingV2(chunkId, v2);
  } catch (err) {
    deps.log.warn(
      { agent: deps.agent, chunkId, err: (err as Error)?.message },
      "embedding-v2 dual-write (chunk) best-effort failed — backfill will retry",
    );
  }
}
