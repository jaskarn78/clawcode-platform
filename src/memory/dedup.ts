import type { Database as DatabaseType } from "better-sqlite3";
import { MemoryError } from "./errors.js";

/**
 * Memory overhaul 2026-10-25 (WP5) - cosine at or above which a new memory
 * is a true duplicate of an existing one and is dropped. Between the
 * configured `similarityThreshold` and this value the new memory is
 * inserted and SUPERSEDES the older one (explicit supersession with a
 * date instead of a destructive merge).
 */
export const DEDUP_DUPLICATE_THRESHOLD = 0.95;

/**
 * Memory overhaul 2026-10-25 (WP5) - tags of machine-written aggregate rows:
 * session summaries, mid-session flushes, raw transcript fallbacks and the
 * weekly / monthly consolidation digests. They are never dedup candidates:
 * a saved fact must not be dropped as a "duplicate" of a summary
 * (summaries are excluded from pre-turn retrieval, so the fact would
 * vanish), and a fact or research note must not retire a summary or a
 * digest. Those rows are themselves always inserted with `skipDedup`.
 */
export const DEDUP_EXCLUDED_TAGS: readonly string[] = Object.freeze([
  "session-summary",
  "mid-session",
  "raw-fallback",
  "weekly-digest",
  "monthly-digest",
]);

/** Configuration for deduplication similarity check. */
export type DedupConfig = {
  /** Floor for any dedup action; the supersede band starts here (default 0.85). */
  readonly similarityThreshold: number;
  /**
   * Floor for the drop-as-duplicate band (default 0.95). The effective
   * floor is never below `similarityThreshold`, so an operator who raises
   * the threshold above 0.95 gets drops only at or above their value and
   * no supersede band at all.
   */
  readonly duplicateThreshold?: number;
};

/**
 * Result of a deduplication check.
 *   insert    - nothing close enough; write a new row.
 *   duplicate - cosine >= duplicate floor; drop the new content and hand
 *               back the existing id.
 *   supersede - similarityThreshold <= cosine < duplicate floor; write the
 *               new row and mark `existingId` superseded by it.
 */
export type DedupResult =
  | { readonly action: "insert" }
  | { readonly action: "duplicate"; readonly existingId: string; readonly similarity: number }
  | { readonly action: "supersede"; readonly existingId: string; readonly similarity: number };

/** Input for merging into an existing memory. */
export type MergeInput = {
  readonly content: string;
  readonly importance: number;
  readonly tags: readonly string[];
  readonly embedding: Float32Array;
};

/** Raw row from KNN similarity query. */
type VecRow = {
  readonly memory_id: string;
  readonly distance: number;
};

/** Raw row from existing memory lookup. */
type ExistingRow = {
  readonly importance: number;
  readonly tags: string;
  readonly access_count: number;
};

/**
 * KNN over-fetch for the dedup probe. Superseded rows keep their vectors
 * and machine-summary rows stay in vec_memories, so the nearest neighbours
 * may all be ineligible; the probe fetches this many and keeps the nearest
 * eligible one. vec0 KNN is a brute-force scan either way, so a larger k
 * only grows the result heap, not the work.
 */
const DEDUP_PROBE_K = 32;

/**
 * Check whether a new embedding is a near-duplicate of an existing memory.
 *
 * Runs a KNN query against vec_memories joined to memories. Only LIVE rows
 * (superseded_by IS NULL) that carry none of `DEDUP_EXCLUDED_TAGS` are
 * eligible. The nearest eligible row decides:
 *   - similarity >= duplicate floor (default 0.95) -> "duplicate"
 *   - similarityThreshold <= similarity < duplicate floor -> "supersede"
 *   - otherwise -> "insert"
 */
export function checkForDuplicate(
  embedding: Float32Array,
  db: DatabaseType,
  config: DedupConfig,
): DedupResult {
  const excludedPlaceholders = DEDUP_EXCLUDED_TAGS.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT v.memory_id AS memory_id, v.distance AS distance
       FROM vec_memories v
       INNER JOIN memories m ON m.id = v.memory_id
       WHERE v.embedding MATCH ? AND k = ?
         AND m.superseded_by IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM json_each(m.tags) t WHERE t.value IN (${excludedPlaceholders})
         )
       ORDER BY v.distance
       LIMIT 1`,
    )
    .get(embedding, DEDUP_PROBE_K, ...DEDUP_EXCLUDED_TAGS) as VecRow | undefined;

  if (!row) {
    return { action: "insert" };
  }

  const similarity = 1 - row.distance;
  const duplicateFloor = Math.max(
    config.duplicateThreshold ?? DEDUP_DUPLICATE_THRESHOLD,
    config.similarityThreshold,
  );

  if (similarity >= duplicateFloor) {
    return Object.freeze({
      action: "duplicate" as const,
      existingId: row.memory_id,
      similarity,
    });
  }

  if (similarity >= config.similarityThreshold) {
    return Object.freeze({
      action: "supersede" as const,
      existingId: row.memory_id,
      similarity,
    });
  }

  return { action: "insert" };
}

/**
 * Merge a new memory into an existing entry.
 *
 * DEPRECATED (memory overhaul 2026-10-25, WP5): `MemoryStore.insert` no
 * longer calls this and nothing in src does. Dedup is non-destructive
 * now: a true duplicate is dropped and a near-duplicate supersedes the
 * older row (see `MemoryStore.insertWithStatus`). This helper overwrites
 * content, unions tags and bumps access_count, which the 2026-10-25 audit
 * flagged as data loss. The export is kept so external importers keep
 * compiling; prefer `MemoryStore.insertWithStatus` with `supersedes`.
 *
 * Updates the existing memory with:
 * - New content (replaces old)
 * - Max of existing and new importance
 * - Union of both tag sets (no duplicates)
 * - Incremented access_count
 * - Updated timestamps
 * - Replaced embedding vector
 *
 * Runs all mutations in a single transaction for atomicity.
 * Throws MemoryError if the existing ID is not found.
 */
export function mergeMemory(
  db: DatabaseType,
  existingId: string,
  input: MergeInput,
): void {
  const existing = db
    .prepare("SELECT importance, tags, access_count FROM memories WHERE id = ?")
    .get(existingId) as ExistingRow | undefined;

  if (!existing) {
    throw new MemoryError(
      `Cannot merge: memory ${existingId} not found`,
      "unknown",
    );
  }

  const existingTags = JSON.parse(existing.tags) as string[];
  const mergedTags = [...new Set([...existingTags, ...input.tags])];
  const maxImportance = Math.max(existing.importance, input.importance);
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(
      "UPDATE memories SET content = ?, importance = ?, tags = ?, access_count = access_count + 1, updated_at = ?, accessed_at = ? WHERE id = ?",
    ).run(
      input.content,
      maxImportance,
      JSON.stringify(mergedTags),
      now,
      now,
      existingId,
    );

    db.prepare("DELETE FROM vec_memories WHERE memory_id = ?").run(existingId);

    db.prepare(
      "INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)",
    ).run(existingId, input.embedding);

    // Phase 999.119 v2 switch — the merged content is new text; drop the
    // stale v2 vector so the migration runner re-embeds it (it fills
    // every missing v2 row while the agent is in a v2 write phase).
    try {
      db.prepare("DELETE FROM vec_memories_v2 WHERE memory_id = ?").run(existingId);
    } catch {
      /* a bare test DB without the v2 table */
    }
  })();

  console.debug("Memory merged:", {
    existingId,
    similarity: "N/A",
    newImportance: maxImportance,
    tagCount: mergedTags.length,
  });
}
