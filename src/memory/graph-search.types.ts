/**
 * Types for graph-enriched memory search.
 *
 * GraphSearch augments KNN vector results with 1-hop graph neighbors
 * from the memory_links adjacency table.
 */

/** Configuration for graph-enriched search behavior. */
export type GraphSearchConfig = {
  readonly neighborSimilarityThreshold: number; // minimum cosine similarity for neighbor inclusion
  readonly maxNeighbors: number; // max graph neighbors to include
  readonly maxTotalResults: number; // hard cap on total results (KNN + neighbors)
};

/** A single result from graph-enriched search. */
export type GraphSearchResult = {
  readonly id: string;
  readonly content: string;
  readonly relevanceScore: number;
  readonly combinedScore: number;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly source: "knn" | "graph-neighbor";
  readonly linkedFrom?: readonly string[];
};

/** Default configuration for GraphSearch. */
export const DEFAULT_GRAPH_SEARCH_CONFIG: GraphSearchConfig = Object.freeze({
  neighborSimilarityThreshold: 0.3,
  maxNeighbors: 5,
  maxTotalResults: 15,
});
