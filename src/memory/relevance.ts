/**
 * Combined relevance scoring and re-ranking for memory search results.
 *
 * Combines semantic similarity (from vector distance) with time-based relevance
 * decay to produce a final ranking score. This module is a pure-function layer
 * that search integration will wire in.
 */

import { calculateRelevanceScore } from "./decay.js";
import type { SearchResult } from "./types.js";

/** Configuration for the combined scoring function. */
export type ScoringConfig = {
  readonly semanticWeight: number;
  readonly decayWeight: number;
  readonly halfLifeDays: number;
};

/** A search result augmented with relevance and combined scores. */
export type RankedSearchResult = SearchResult & {
  readonly relevanceScore: number;
  readonly combinedScore: number;
};

/**
 * Convert a cosine distance to a similarity score.
 *
 * Cosine distance ranges from 0 (identical) to 2 (opposite).
 * Returns a similarity in [0, 1] via `max(0, 1 - distance)`.
 *
 * @param distance - Cosine distance from vector search
 * @returns Similarity score in [0, 1]
 */
export function distanceToSimilarity(distance: number): number {
  return Math.min(1, Math.max(0, 1 - distance));
}

/**
 * Score and re-rank search results using combined semantic similarity and relevance decay.
 *
 * For each result:
 * - Computes semantic similarity from the vector distance
 * - Computes relevance score using exponential half-life decay
 * - Combines both using weighted sum: `semantic * semanticWeight + relevance * decayWeight`
 *
 * Returns results sorted descending by combined score. All returned objects are frozen
 * per project immutability convention.
 *
 * @param results - Search results from vector search
 * @param config - Scoring weights and decay configuration
 * @param now - Current reference time for decay calculation
 * @returns Frozen array of frozen RankedSearchResult objects, sorted by combinedScore descending
 */
export function scoreAndRank(
  results: readonly SearchResult[],
  config: ScoringConfig,
  now: Date,
): readonly RankedSearchResult[] {
  if (results.length === 0) {
    return Object.freeze([] as RankedSearchResult[]);
  }

  const scored = results.map((result): RankedSearchResult => {
    const semanticSimilarity = distanceToSimilarity(result.distance);
    const relevanceScore = calculateRelevanceScore(
      result.importance,
      result.accessedAt,
      now,
      { halfLifeDays: config.halfLifeDays },
    );
    const combinedScore =
      semanticSimilarity * config.semanticWeight +
      relevanceScore * config.decayWeight;

    return Object.freeze({
      ...result,
      relevanceScore,
      combinedScore,
    });
  });

  const sorted = scored.sort((a, b) => b.combinedScore - a.combinedScore);

  return Object.freeze(sorted);
}
