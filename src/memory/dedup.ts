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

/** Configuration for deduplication similarity check. */
export type DedupConfig = {
  /** Floor for the supersede band (default 0.85). */
  readonly similarityThreshold: number;
  /** Floor for the drop-as-duplicate band (default 0.95). */
  readonly duplicateThreshold?: number;
};

/**
 * Result of a deduplication check.
 *   insert    - nothing close enough; write a new row.
 *   duplicate - cosine >= duplicateThreshold; drop the new content and
 *               hand back the existing id.
 *   supersede - similarityThreshold <= cosine < duplicateThreshold; write
 *               the new row and mark `existingId` superseded by it.
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
 * KNN over-fetch for the dedup probe. Superseded rows keep their vectors,
 * so the single nearest neighbour may be a retired memory; fetching a few
 * and taking the nearest LIVE one keeps the probe correct without a
 * second query.
 */
const DEDUP_PROBE_K = 8;

/**
 * Check whether a new embedding is a near-duplicate of an existing memory.
 *
 * Runs a KNN query against vec_memories joined to memories so superseded
 * rows (superseded_by IS NOT NULL) never count as the nearest neighbour.
 * The nearest live row decides:
 *   - similarity >= duplicateThreshold (default 0.95) -> "duplicate"
 *   - similarityThreshold <= similarity < duplicateThreshold -> "supersede"
 *   - otherwise -> "insert"
 */
export function checkForDuplicate(
  embedding: Float32Array,
  db: DatabaseType,
  config: DedupConfig,
): DedupResult {
  const row = db
    .prepare(
      `SELECT v.memory_id AS memory_id, v.distance AS distance
       FROM vec_memories v
       INNER JOIN memories m ON m.id = v.memory_id
       WHERE v.embedding MATCH ? AND k = ? AND m.superseded_by IS NULL
       ORDER BY v.distance
       LIMIT 1`,
    )
    .get(embedding, DEDUP_PROBE_K) as VecRow | undefined;

  if (!row) {
    return { action: "insert" };
  }

  const similarity = 1 - row.distance;
  const duplicateThreshold = config.duplicateThreshold ?? DEDUP_DUPLICATE_THRESHOLD;
  // The supersede band must sit below the duplicate band; a misconfigured
  // pair (similarity floor above the duplicate floor) collapses to "drop
  // at the lower of the two", which is the safer reading.
  const supersedeFloor = Math.min(config.similarityThreshold, duplicateThreshold);

  if (similarity >= duplicateThreshold) {
    return Object.freeze({
      action: "duplicate" as const,
      existingId: row.memory_id,
      similarity,
    });
  }

  if (similarity >= supersedeFloor) {
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
 * longer calls this. Dedup is non-destructive now: a true duplicate is
 * dropped and a near-duplicate supersedes the older row (see
 * `MemoryStore.insertWithStatus`). This helper overwrites content, unions
 * tags and bumps access_count, all of which the audit flagged as data
 * loss; it is kept only so existing importers keep compiling. Prefer
 * `MemoryStore.insertWithStatus` with `supersedes`.
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
