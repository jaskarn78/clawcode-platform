/**
 * Episode archival pipeline.
 *
 * Archives episodes older than archivalAgeDays by moving them to cold tier
 * and removing their embeddings from vec_memories (excludes from semantic search).
 * Follows the same error-tolerant pattern as archiveDailyLogs in consolidation.ts.
 */

import { logger } from "../shared/logger.js";
import type { MemoryStore } from "./store.js";

/** Result of an episode archival run. */
export type EpisodeArchivalResult = {
  readonly archived: number;
  readonly errors: readonly string[];
};

/** Row shape from the archival query. */
type EpisodeRow = {
  readonly id: string;
  readonly created_at: string;
};

/**
 * Archive episodes older than archivalAgeDays.
 *
 * For each qualifying episode:
 * 1. Moves tier to "cold" via store.updateTier()
 * 2. Deletes embedding from vec_memories (removes from vector search)
 *
 * Errors on individual episodes are captured but do not stop the pipeline.
 * Returns a frozen EpisodeArchivalResult with archived count and any errors.
 */
export async function archiveOldEpisodes(
  store: MemoryStore,
  archivalAgeDays: number,
): Promise<EpisodeArchivalResult> {
  const cutoffDate = new Date(
    Date.now() - archivalAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const db = store.getDatabase();
  const rows = db
    .prepare(
      `SELECT id, created_at FROM memories
       WHERE source = 'episode' AND tier != 'cold' AND created_at < ?`,
    )
    .all(cutoffDate) as EpisodeRow[];

  let archived = 0;
  const errors: string[] = [];

  for (const row of rows) {
    try {
      store.updateTier(row.id, "cold");
      db.prepare("DELETE FROM vec_memories WHERE memory_id = ?").run(row.id);
      archived += 1;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      logger.error(
        { episodeId: row.id, error: msg },
        "failed to archive episode",
      );
      errors.push(`Failed to archive episode ${row.id}: ${msg}`);
    }
  }

  return Object.freeze({
    archived,
    errors: Object.freeze([...errors]),
  });
}
