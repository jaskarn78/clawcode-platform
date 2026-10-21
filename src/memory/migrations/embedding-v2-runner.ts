import type { Logger } from "pino";
import type { MemoryStore } from "../store.js";
import type { EmbeddingMigrationPhase, EmbeddingV2Migrator } from "./embedding-v2.js";

/**
 * Phase 115 D-08 + D-09 — resumable batch re-embed runner.
 *
 * Reads memories that have a v1 vec_memories row but NO v2 vec_memories_v2
 * row, embeds them with bge-small + int8 quant, writes v2 rows, advances
 * the migration cursor. Yields between batches to respect a CPU budget
 * (default 5%, configurable via `defaults.embeddingMigration.cpuBudgetPct`).
 *
 * Discord-active agents have priority — runner skips when `isAgentActive()`
 * returns true. The migration is OFF the response path; it never lands embed
 * cost on a turn (sota-synthesis.md §1.5 async-write invariant preserved).
 *
 * Resumability: each batch saves `last_cursor = lastMemoryId` after the
 * batch's writes commit. On daemon restart the runner picks up where it
 * left off via the cursor — no duplicate work, no skipped work.
 *
 * Phase guard: runs ONLY when migrator phase is `dual-write` or
 * `re-embedding`. The dual-write phase covers the case where ambient
 * agent activity creates new memories that need v2 vectors AND historical
 * memories haven't been re-embedded yet (the runner does both passes
 * uniformly; the only difference between dual-write and re-embedding is
 * operator intent).
 */

/**
 * Config for the runner. Resolved from
 * `defaults.embeddingMigration.{cpuBudgetPct,batchSize}` per the config
 * schema added in T05.
 */
export interface RunnerConfig {
  /** CPU budget percentage (1-50). Default 5 per Phase 115 D-09. */
  readonly cpuBudgetPct: number;
  /** Batch size (10-500). Default 50 per Phase 115 D-08. */
  readonly batchSize: number;
}

/** Result of one runReEmbedBatch invocation — for log + dashboard wiring. */
export interface RunnerResult {
  readonly agent: string;
  readonly phase: EmbeddingMigrationPhase;
  readonly processed: number;
  readonly remaining: number;
  readonly skippedReason?: string;
}

/**
 * Embedder shape — minimal subset needed by the runner. Keeps the runner
 * test-mockable (no need to construct a real EmbeddingService for vitest).
 */
export interface RunnerEmbedder {
  embedV2(text: string): Promise<Int8Array>;
}

/**
 * Run ONE batch of v2 re-embed work. Designed to be called repeatedly by
 * a scheduler (heartbeat tick, cron, or a manual loop in tests). Returns
 * info about the work just done so the caller can log + decide whether
 * to schedule another batch immediately.
 *
 * Yielding semantics: this function does NOT itself sleep — the caller's
 * scheduler controls cadence. The CPU budget is enforced by the SCHEDULER
 * picking a between-batch sleep proportional to (100 - cpuBudgetPct) / cpuBudgetPct.
 * For example: cpuBudgetPct=5 means after 1 batch (taking ~T ms), sleep
 * for ~19T ms before the next batch — keeping CPU at 5% net.
 *
 * Why not embed budget-aware sleeping inside the runner: heartbeat checks
 * are already a once-per-N-minutes mechanism; running ONE batch per
 * heartbeat tick at default 5-min interval naturally produces well below
 * 5% CPU use. Operators can tighten the heartbeat interval to spend the
 * budget more aggressively. The CPU budget knob is documented but the
 * actual implementation rate-limits via heartbeat cadence.
 */
export async function runReEmbedBatch(
  migrator: EmbeddingV2Migrator,
  store: MemoryStore,
  embedder: RunnerEmbedder,
  cfg: RunnerConfig,
  isAgentActive: () => boolean,
  log: Logger,
): Promise<RunnerResult> {
  const state = migrator.getState();
  if (!migrator.shouldRunReEmbedBatch()) {
    return Object.freeze({
      agent: migrator.agent,
      phase: state.phase,
      processed: 0,
      remaining: state.progressTotal - state.progressProcessed,
      skippedReason: `phase=${state.phase} (not dual-write or re-embedding)`,
    });
  }

  // Discord-active agents have priority — skip this tick.
  if (isAgentActive()) {
    return Object.freeze({
      agent: migrator.agent,
      phase: state.phase,
      processed: 0,
      remaining: state.progressTotal - state.progressProcessed,
      skippedReason: "agent-active",
    });
  }

  // First batch in re-embedding phase — count remaining work and update
  // the total. The runner can be re-invoked many times before progress
  // changes, so the counter only updates when the runner is actually
  // doing work in this phase.
  const totalMissing = store.countMemoriesMissingV2Embedding();
  if (totalMissing === 0) {
    // Phase 999.119 v2 switch — memories are done; the chunk side
    // (`vec_memory_chunks_v2`, the MEMORY.md / file-scanner surface the
    // pre-turn retriever searches) is re-embedded next. Only when BOTH
    // tables are complete does `re-embedding` auto-advance.
    const chunkResult = await runChunkReEmbedBatch(
      migrator,
      store,
      embedder,
      cfg,
      isAgentActive,
      log,
    );
    if (chunkResult.remaining === 0 && state.phase === "re-embedding") {
      try {
        migrator.transition("re-embed-complete");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          { agent: migrator.agent, action: "v2-auto-transition-failed", message },
          "[diag] embedding-v2 auto-transition to re-embed-complete failed",
        );
      }
    }
    return Object.freeze({
      agent: migrator.agent,
      phase: migrator.getState().phase,
      processed: chunkResult.processed,
      remaining: chunkResult.remaining,
    });
  }

  // Set the progress_total once when entering re-embedding so progress
  // reporting is meaningful. Idempotent if it's already set.
  if (state.progressTotal === 0 && state.phase === "re-embedding") {
    migrator.setProgressTotal(totalMissing + state.progressProcessed);
  }

  // Pull a batch.
  const batch = store.listMemoriesMissingV2Embedding(
    cfg.batchSize,
    state.lastCursor,
  );

  if (batch.length === 0) {
    // Cursor advanced past the lexicographic position of currently-missing
    // entries. Memory IDs are nanoid (random ordering, NOT monotonic) so
    // memories inserted AFTER the cursor advanced can sort BEFORE it; the
    // `id > last_cursor` SQL filter then hides them forever.
    //
    // Two branches:
    //   (a) totalMissing === 0 → re-embedding actually done. Auto-transition
    //       to re-embed-complete.
    //   (b) totalMissing > 0 → cursor is stuck behind real work. Reset
    //       last_cursor to NULL so the next tick scans from the beginning,
    //       AND fix progress_total which was set once at re-embedding entry
    //       and doesn't reflect memories that have landed since (e.g. the
    //       2026-05-13 fin-client incident: 1407/1408 with 7+ rows
    //       actually missing).
    if (totalMissing === 0 && state.phase === "re-embedding") {
      try {
        migrator.transition("re-embed-complete");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          { agent: migrator.agent, action: "v2-auto-transition-failed", message },
          "[diag] embedding-v2 auto-transition to re-embed-complete failed",
        );
      }
    } else if (totalMissing > 0) {
      // Reset cursor + reconcile progress_total. The new total is
      // progressProcessed + currently-missing so the dashboard percent
      // remains meaningful (it doesn't pretend the original total was
      // ever right). saveCursor is silently dropped in non-working
      // phases via the same guard; safe to call here under the cursor
      // bug.
      const newTotal = state.progressProcessed + totalMissing;
      migrator.resetCursor({ newProgressTotal: newTotal });
      log.warn(
        {
          agent: migrator.agent,
          action: "v2-cursor-reset",
          previousCursor: state.lastCursor,
          totalMissing,
          progressProcessed: state.progressProcessed,
          newProgressTotal: newTotal,
        },
        "[diag] embedding-v2 cursor reset — last_cursor advanced past currently-missing entries (nanoid ordering); next tick scans from start",
      );
    }
    return Object.freeze({
      agent: migrator.agent,
      phase: migrator.getState().phase,
      processed: 0,
      remaining: totalMissing,
    });
  }

  // Process each memory — embed + write v2 row + save cursor.
  let processedThisBatch = 0;
  let lastIdProcessed: string | null = null;
  for (const mem of batch) {
    if (isAgentActive()) {
      // Agent went active mid-batch — yield immediately. The cursor saved
      // via the LAST successful write means resume will pick up correctly.
      log.info(
        {
          agent: migrator.agent,
          action: "v2-batch-yielded-mid-batch",
          processed: processedThisBatch,
        },
        "[diag] embedding-v2 yielded mid-batch (agent went active)",
      );
      break;
    }
    try {
      const v2Float = await embedder.embedV2(mem.content);
      store.insertEmbeddingV2(mem.id, v2Float);
      processedThisBatch++;
      lastIdProcessed = mem.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        {
          agent: migrator.agent,
          action: "v2-embed-failed",
          memoryId: mem.id,
          message,
        },
        "[diag] embedding-v2 single-row embed failed; skipping",
      );
      // Continue with next entry — one bad memory doesn't kill the batch.
    }
  }

  // Save cursor + processed count after the batch.
  if (lastIdProcessed) {
    migrator.saveCursor(
      lastIdProcessed,
      state.progressProcessed + processedThisBatch,
    );
  }

  const updatedState = migrator.getState();
  const remaining = Math.max(
    0,
    updatedState.progressTotal - updatedState.progressProcessed,
  );

  log.info(
    {
      agent: migrator.agent,
      action: "v2-reembed-batch",
      phase: updatedState.phase,
      processed: processedThisBatch,
      processedCumulative: updatedState.progressProcessed,
      remaining,
      lastCursor: updatedState.lastCursor,
    },
    "[diag] embedding-v2 batch re-embed",
  );

  return Object.freeze({
    agent: migrator.agent,
    phase: updatedState.phase,
    processed: processedThisBatch,
    remaining,
  });
}

/**
 * Phase 999.119 v2 switch — one batch of the CHUNK side of the backfill
 * (`memory_chunks` rows that have a v1 vector but no v2 vector). Runs
 * after the memories side is complete. No cursor: rows leave the
 * "missing" set as they are written, so the listing always starts at the
 * front; a row whose embed keeps failing is logged each tick, never
 * silently dropped.
 */
export async function runChunkReEmbedBatch(
  migrator: EmbeddingV2Migrator,
  store: MemoryStore,
  embedder: RunnerEmbedder,
  cfg: RunnerConfig,
  isAgentActive: () => boolean,
  log: Logger,
): Promise<Readonly<{ processed: number; remaining: number }>> {
  const missingBefore = store.countChunksMissingV2Embedding();
  if (missingBefore === 0) {
    return Object.freeze({ processed: 0, remaining: 0 });
  }
  const batch = store.listChunksMissingV2Embedding(cfg.batchSize, null);
  let processed = 0;
  for (const chunk of batch) {
    if (isAgentActive()) {
      log.info(
        { agent: migrator.agent, action: "v2-chunk-batch-yielded", processed },
        "[diag] embedding-v2 chunk batch yielded (agent went active)",
      );
      break;
    }
    try {
      const v2 = await embedder.embedV2(chunk.body);
      store.insertChunkEmbeddingV2(chunk.id, v2);
      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { agent: migrator.agent, action: "v2-chunk-embed-failed", chunkId: chunk.id, message },
        "[diag] embedding-v2 single-chunk embed failed; skipping",
      );
    }
  }
  const remaining = store.countChunksMissingV2Embedding();
  log.info(
    {
      agent: migrator.agent,
      action: "v2-reembed-chunk-batch",
      phase: migrator.getState().phase,
      processed,
      remaining,
    },
    "[diag] embedding-v2 chunk batch re-embed",
  );
  return Object.freeze({ processed, remaining });
}
