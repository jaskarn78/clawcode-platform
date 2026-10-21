import type { Database as DatabaseType, Statement } from "better-sqlite3";
import type { SearchResult, MemoryEntry } from "./types.js";
import { scoreAndRank, type ScoringConfig, type RankedSearchResult } from "./relevance.js";
import { int8ToBuffer } from "./embedder-quantize.js";
import {
  normalizeDistance,
  toQueryVector,
  type QueryVector,
} from "./embedding-version.js";

/** Raw row shape from the KNN search query. */
type SearchRow = {
  readonly id: string;
  readonly content: string;
  readonly source: string;
  readonly importance: number;
  readonly access_count: number;
  readonly tags: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly accessed_at: string;
  readonly tier: string;
  readonly source_turn_ids: string | null;
  readonly distance: number;
};

/** Default scoring configuration. */
const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  semanticWeight: 0.7,
  decayWeight: 0.3,
  halfLifeDays: 30,
};

const SELECT_COLUMNS = `m.id, m.content, m.source, m.importance, m.access_count,
        m.tags, m.created_at, m.updated_at, m.accessed_at, m.tier,
        m.source_turn_ids, v.distance`;

/**
 * SemanticSearch performs KNN vector queries via sqlite-vec's vec0 MATCH.
 *
 * Uses the vec_memories virtual table with cosine distance for ranked
 * similarity search. Re-ranks results using combined semantic similarity
 * and relevance decay scoring. Updates access_count and accessed_at for
 * final top-K results only.
 *
 * Phase 999.119 v2 switch — accepts a tagged `QueryVector`; a v2 query
 * runs against `vec_memories_v2` and its distances are mapped onto the v1
 * scale before scoring, so the 0.7 / 0.3 blend means the same thing in
 * both spaces. A bare Float32Array is treated as a v1 query (legacy callers).
 */
export class SemanticSearch {
  private readonly searchStmtV1: Statement;
  private readonly searchStmtV2: Statement;
  private readonly updateAccessStmt: Statement;
  private readonly scoringConfig: ScoringConfig;

  constructor(db: DatabaseType, scoringConfig?: ScoringConfig) {
    this.scoringConfig = scoringConfig ?? DEFAULT_SCORING_CONFIG;

    this.searchStmtV1 = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM vec_memories v
      INNER JOIN memories m ON m.id = v.memory_id
      WHERE v.embedding MATCH ?
        AND k = ?
      ORDER BY v.distance
    `);

    this.searchStmtV2 = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM vec_memories_v2 v
      INNER JOIN memories m ON m.id = v.memory_id
      WHERE v.embedding MATCH vec_int8(?)
        AND k = ?
      ORDER BY v.distance
    `);

    this.updateAccessStmt = db.prepare(`
      UPDATE memories SET access_count = access_count + 1, accessed_at = ? WHERE id = ?
    `);
  }

  /**
   * Search for memories most similar to the query embedding.
   *
   * Over-fetches by 2x from KNN, scores using combined semantic + relevance
   * decay, then trims to topK. Updates access_count and accessed_at ONLY
   * for the final top-K results (after scoring, not during).
   *
   * NOTE: Cold-tier memories stay in the store (Phase 999.119) and remain
   * searchable; the decay term ranks them below fresh rows.
   */
  search(
    queryEmbedding: Float32Array | QueryVector,
    topK: number,
  ): readonly RankedSearchResult[] {
    const q = toQueryVector(queryEmbedding);
    // Over-fetch by 2x for re-ranking headroom
    const fetchK = topK * 2;
    const rawRows =
      q.version === "v2"
        ? (this.searchStmtV2.all(int8ToBuffer(q.vector), fetchK) as SearchRow[])
        : (this.searchStmtV1.all(q.vector, fetchK) as SearchRow[]);
    const rows =
      q.version === "v2"
        ? rawRows.map((r) => ({ ...r, distance: normalizeDistance(r.distance, "v2") }))
        : rawRows;

    // Convert to SearchResult objects (before access update)
    const searchResults: readonly SearchResult[] = Object.freeze(
      rows.map((row) => rowToSearchResult(row)),
    );

    // Score and re-rank using combined semantic + decay scoring
    // IMPORTANT: Score BEFORE updating accessed_at (Pitfall 6)
    const ranked = scoreAndRank(searchResults, this.scoringConfig, new Date());

    // Apply importance weighting: multiplicative boost that rewards high-importance
    // memories without overriding strong semantic matches
    const importanceWeighted = ranked
      .map((result) => {
        const boostedScore = result.combinedScore * (0.7 + 0.3 * result.importance);
        return Object.freeze({ ...result, combinedScore: boostedScore });
      })
      .sort((a, b) => b.combinedScore - a.combinedScore);

    // Trim to requested topK
    const topResults = importanceWeighted.slice(0, topK);

    // Update access_count and accessed_at ONLY for final top-K results
    const now = new Date().toISOString();
    for (const result of topResults) {
      this.updateAccessStmt.run(now, result.id);
    }

    // Return results with updated accessedAt
    return Object.freeze(
      topResults.map((result) =>
        Object.freeze({
          ...result,
          accessedAt: now,
          accessCount: result.accessCount + 1,
        }),
      ),
    );
  }
}

/** Convert a raw SQLite row to an immutable SearchResult. */
function rowToSearchResult(row: SearchRow): SearchResult {
  const rawTurnIds = row.source_turn_ids;
  const sourceTurnIds = rawTurnIds
    ? Object.freeze(JSON.parse(rawTurnIds) as string[])
    : null;

  return Object.freeze({
    id: row.id,
    content: row.content,
    source: row.source as MemoryEntry["source"],
    importance: row.importance,
    accessCount: row.access_count,
    tags: Object.freeze(JSON.parse(row.tags) as string[]),
    embedding: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessedAt: row.accessed_at,
    tier: (row.tier ?? "warm") as import("./types.js").MemoryTier,
    sourceTurnIds,
    distance: row.distance,
  });
}
