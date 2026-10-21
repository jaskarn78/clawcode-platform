/**
 * Cosine similarity utility and auto-link discovery for the knowledge graph.
 *
 * The auto-linker scans for semantically similar unlinked memories and
 * creates bidirectional edges between them, enriching the knowledge graph
 * without relying on manual wikilinks.
 *
 * Phase 999.119 (2026-09-05) — hardened after the `projects` agent's
 * heartbeat linker had failed 437 times in a row since 2026-06-14:
 *
 *   - Neighbours come from `MemoryStore.searchMemoriesVec`, which JOINs
 *     `memories`, so a vec row whose memory row is gone (an orphan left
 *     by a delete that bypassed `MemoryStore.delete`) can never reach the
 *     link INSERT — that was the FK trap (`INSERT OR IGNORE` does NOT
 *     ignore FK violations). `repairIntegrity()` removes the ghosts.
 *   - Each candidate is its own transaction, so one bad row can no longer
 *     discard every other candidate's links.
 *   - Candidates come from the `auto_linked_at` scan cursor instead of
 *     "has no outbound auto:similar edge": a memory with no neighbour above
 *     threshold used to remain a candidate forever, so the batch was the
 *     same newest-N rows every run and the backlog behind them was never
 *     reached.
 *
 * Phase 999.119 v2 switch — the scan runs in whichever space the agent
 * reads from (`getEmbeddingReadVersion`). Distances come back on the v1
 * scale, so the 0.6 threshold means the same thing under bge-small.
 */

import type { Database as DatabaseType, Statement } from "better-sqlite3";
import type { MemoryStore } from "./store.js";
import type { EmbeddingReadVersion, QueryVector } from "./embedding-version.js";

/**
 * Compute cosine similarity between two L2-normalized vectors.
 * Since embeddings from EmbeddingService are pre-normalized, dot product = cosine similarity.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/** Configuration for the auto-link discovery process. */
export type AutoLinkConfig = {
  readonly similarityThreshold: number; // default 0.6 (v1 scale)
  readonly batchSize: number; // default 100 candidates per heartbeat pass
  /**
   * Phase 999.119 — a memory scanned longer ago than this is eligible for
   * a re-scan. Eager linking at insert time already links a new memory to
   * its older neighbours bidirectionally, so re-scans only recover from
   * past failures; a long interval keeps the background cost near zero.
   */
  readonly rescanAfterDays: number; // default 90
};

/** Result of an auto-link discovery run. */
export type AutoLinkResult = {
  readonly linksCreated: number;
  /**
   * `discoverAutoLinks`: number of candidate memories scanned this pass.
   * `autoLinkMemory`: number of non-self neighbours examined.
   */
  readonly pairsScanned: number;
  readonly skippedExisting: number;
  /**
   * Phase 999.119 — KNN neighbours whose memory row no longer exists.
   * Always 0 since the v2 switch (the JOIN filters ghosts before they are
   * seen); kept for result-shape stability.
   */
  readonly orphansSkipped: number;
  /** Phase 999.119 — candidates whose scan threw (each is isolated). */
  readonly errors: number;
  readonly firstError: string | null;
};

const DEFAULT_CONFIG: AutoLinkConfig = {
  similarityThreshold: 0.6,
  batchSize: 100,
  rescanAfterDays: 90,
};

/** KNN width: five neighbours plus the self match. */
const KNN_K = 6;

type LinkStatements = Readonly<{
  checkEdge: Statement;
  insertLink: Statement;
}>;

type NeighborCounts = Readonly<{
  neighborsExamined: number;
  linksCreated: number;
  skippedExisting: number;
}>;

const ZERO_RESULT: AutoLinkResult = Object.freeze({
  linksCreated: 0,
  pairsScanned: 0,
  skippedExisting: 0,
  orphansSkipped: 0,
  errors: 0,
  firstError: null,
});

function prepareLinkStatements(db: DatabaseType): LinkStatements {
  return Object.freeze({
    checkEdge: db.prepare(
      `SELECT 1 FROM memory_links
       WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`,
    ),
    insertLink: db.prepare(
      "INSERT OR IGNORE INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, ?, ?)",
    ),
  });
}

/**
 * The stored vector to seed a memory's neighbour scan with, in the space
 * the store reads from. A v2-reading store whose v2 row for this memory
 * has not been written yet (dual-write still pending) falls back to the
 * v1 vector so eager linking keeps working during a backfill.
 */
function storedQueryVector(
  store: MemoryStore,
  memoryId: string,
  version: EmbeddingReadVersion,
): QueryVector | null {
  if (version === "v2") {
    const v2 = store.getEmbeddingV2(memoryId);
    if (v2) {
      return { version: "v2", vector: v2, float: new Float32Array(0) };
    }
  }
  const v1 = store.getEmbedding(memoryId);
  return v1 ? { version: "v1", vector: v1 } : null;
}

/**
 * Link one memory to every qualifying KNN neighbour. Must run inside the
 * caller's transaction. Shared by the eager (insert-time) and heartbeat
 * paths so the two can never drift apart again.
 */
function linkNeighbors(
  store: MemoryStore,
  stmts: LinkStatements,
  memoryId: string,
  query: QueryVector,
  similarityThreshold: number,
): NeighborCounts {
  // searchMemoriesVec JOINs memories: ghosts never surface, and the tier
  // rides on the row. Distances are already on the v1 scale.
  const neighbors = store.searchMemoriesVec(query, KNN_K);

  let neighborsExamined = 0;
  let linksCreated = 0;
  let skippedExisting = 0;

  for (const neighbor of neighbors) {
    if (neighbor.memory_id === memoryId) continue;
    neighborsExamined++;

    if (neighbor.tier === "cold") continue;

    const similarity = 1 - neighbor.distance;
    if (similarity < similarityThreshold) continue;

    const existingEdge = stmts.checkEdge.get(
      memoryId,
      neighbor.memory_id,
      neighbor.memory_id,
      memoryId,
    );
    if (existingEdge) {
      skippedExisting++;
      continue;
    }

    const now = new Date().toISOString();
    stmts.insertLink.run(memoryId, neighbor.memory_id, "auto:similar", now);
    stmts.insertLink.run(neighbor.memory_id, memoryId, "auto:similar", now);
    linksCreated += 2;
  }

  return Object.freeze({ neighborsExamined, linksCreated, skippedExisting });
}

/**
 * Auto-link a single memory to its semantically similar neighbors.
 *
 * Finds KNN neighbors for the given memory, filters by tier and threshold,
 * and creates bidirectional 'auto:similar' edges for qualifying pairs.
 * Returns a frozen AutoLinkResult.
 *
 * Designed to be called eagerly after insert/merge so new memories
 * get graph edges immediately instead of waiting for the 6h heartbeat.
 */
export function autoLinkMemory(
  store: MemoryStore,
  memoryId: string,
  config?: Partial<AutoLinkConfig>,
): AutoLinkResult {
  const merged: AutoLinkConfig = { ...DEFAULT_CONFIG, ...config };
  const query = storedQueryVector(store, memoryId, store.getEmbeddingReadVersion());
  if (!query) return ZERO_RESULT;

  const db = store.getDatabase();
  const stmts = prepareLinkStatements(db);

  const counts = db.transaction((): NeighborCounts => {
    const c = linkNeighbors(store, stmts, memoryId, query, merged.similarityThreshold);
    store.markAutoLinked(memoryId);
    return c;
  })();

  return Object.freeze({
    linksCreated: counts.linksCreated,
    pairsScanned: counts.neighborsExamined,
    skippedExisting: counts.skippedExisting,
    orphansSkipped: 0,
    errors: 0,
    firstError: null,
  });
}

/**
 * Discover and create bidirectional edges between semantically similar unlinked memories.
 *
 * Algorithm:
 * 1. Take the next `batchSize` non-cold memories from the scan cursor
 *    (never scanned first, then those scanned more than `rescanAfterDays` ago)
 * 2. For each candidate, find top-5 KNN neighbors via sqlite-vec
 * 3. For each similar pair above threshold, create bidirectional edges
 * 4. Skip already-linked pairs, cold neighbours and memories without
 *    embeddings; stamp the candidate as scanned
 *
 * Each candidate is its own transaction: a failure is counted and the
 * pass continues with the next candidate.
 */
export function discoverAutoLinks(
  store: MemoryStore,
  config?: Partial<AutoLinkConfig>,
): AutoLinkResult {
  const merged: AutoLinkConfig = { ...DEFAULT_CONFIG, ...config };
  const db = store.getDatabase();
  const version = store.getEmbeddingReadVersion();
  const rescanBefore = new Date(
    Date.now() - merged.rescanAfterDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const candidates = store.listAutoLinkCandidates(merged.batchSize, rescanBefore);
  const stmts = prepareLinkStatements(db);

  let linksCreated = 0;
  let skippedExisting = 0;
  let errors = 0;
  let firstError: string | null = null;

  const scanOne = db.transaction((memoryId: string): void => {
    const query = storedQueryVector(store, memoryId, version);
    if (query) {
      const c = linkNeighbors(store, stmts, memoryId, query, merged.similarityThreshold);
      linksCreated += c.linksCreated;
      skippedExisting += c.skippedExisting;
    }
    // Stamp even when there is nothing to link (no embedding / no neighbour
    // above threshold) — that is the whole point of the cursor. The
    // rescan interval revisits it later.
    store.markAutoLinked(memoryId);
  });

  for (const memoryId of candidates) {
    try {
      scanOne(memoryId);
    } catch (err) {
      errors++;
      if (firstError === null) {
        firstError = `${memoryId}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  return Object.freeze({
    linksCreated,
    pairsScanned: candidates.length,
    skippedExisting,
    orphansSkipped: 0,
    errors,
    firstError,
  });
}
