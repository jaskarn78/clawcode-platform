import type { Database as DatabaseType } from "better-sqlite3";
import { MemoryError } from "./errors.js";

/** Configuration for deduplication similarity check. */
export type DedupConfig = {
  readonly similarityThreshold: number;
};

/** Result of a deduplication check. */
export type DedupResult =
  | { readonly action: "insert" }
  | { readonly action: "merge"; readonly existingId: string; readonly similarity: number };

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
 * Check whether a new embedding is a near-duplicate of an existing memory.
 *
 * Runs a KNN query with k=1 against vec_memories. If the nearest neighbor
 * has similarity >= threshold, returns a merge directive with the existing ID.
 * Otherwise returns an insert directive.
 */
export function checkForDuplicate(
  embedding: Float32Array,
  db: DatabaseType,
  config: DedupConfig,
): DedupResult {
  const row = db
    .prepare(
      "SELECT memory_id, distance FROM vec_memories WHERE embedding MATCH ? AND k = 1",
    )
    .get(embedding) as VecRow | undefined;

  if (!row) {
    return { action: "insert" };
  }

  const similarity = 1 - row.distance;

  if (similarity >= config.similarityThreshold) {
    return Object.freeze({
      action: "merge" as const,
      existingId: row.memory_id,
      similarity,
    });
  }

  return { action: "insert" };
}

/**
 * Merge a new memory into an existing entry.
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
