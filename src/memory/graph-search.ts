/**
 * Graph-enriched memory search.
 *
 * Augments KNN vector search results with 1-hop graph neighbors from
 * the memory_links adjacency table. Neighbors are relevance-gated
 * (must exceed similarity threshold) and capped to prevent unbounded fan-out.
 */

import { SemanticSearch } from "./search.js";
import { getForwardLinks, getBacklinks } from "./graph.js";
import type { MemoryStore } from "./store.js";
import type { GraphSearchConfig, GraphSearchResult } from "./graph-search.types.js";
import { DEFAULT_GRAPH_SEARCH_CONFIG } from "./graph-search.types.js";
import {
  normalizeSimilarity,
  toQueryVector,
  type QueryVector,
} from "./embedding-version.js";

/**
 * Compute cosine similarity between two L2-normalized vectors.
 * For normalized vectors, cosine similarity equals the dot product.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * GraphSearch composes SemanticSearch with 1-hop graph neighbor expansion.
 *
 * Algorithm:
 * 1. Run KNN via SemanticSearch to get top-K results
 * 2. For each KNN hit, fetch forward links and backlinks
 * 3. For neighbors not already in KNN results, compute cosine similarity to query
 * 4. Include neighbors exceeding the similarity threshold
 * 5. Cap total results at maxTotalResults
 */
export class GraphSearch {
  private readonly store: MemoryStore;
  private readonly config: GraphSearchConfig;

  constructor(store: MemoryStore, config?: Partial<GraphSearchConfig>) {
    this.store = store;
    this.config = Object.freeze({
      ...DEFAULT_GRAPH_SEARCH_CONFIG,
      ...config,
    });
  }

  search(
    queryEmbedding: Float32Array | QueryVector,
    topK: number,
  ): readonly GraphSearchResult[] {
    // Phase 999.119 v2 switch — the KNN seed and the neighbour test both
    // run in the query's space; v2 similarities are mapped onto the v1
    // scale so `neighborSimilarityThreshold` keeps its meaning.
    const query = toQueryVector(queryEmbedding);
    const queryFloat = query.version === "v2" ? query.float : query.vector;
    const semanticSearch = new SemanticSearch(this.store.getDatabase());
    const knnResults = semanticSearch.search(query, topK);

    // Collect KNN result IDs
    const knnIds = new Set<string>(knnResults.map((r) => r.id));

    // Track neighbors: neighborId -> { similarity, linkedFrom set }
    const neighborMap = new Map<string, { similarity: number; linkedFrom: Set<string> }>();

    // Expand 1-hop neighbors for each KNN result
    for (const knnResult of knnResults) {
      const forwardLinks = getForwardLinks(this.store, knnResult.id);
      const backlinks = getBacklinks(this.store, knnResult.id);

      const allNeighborIds: string[] = [
        ...forwardLinks.map((l) => l.memory.id),
        ...backlinks.map((l) => l.memory.id),
      ];

      for (const neighborId of allNeighborIds) {
        // Skip if already in KNN results
        if (knnIds.has(neighborId)) continue;

        if (neighborMap.has(neighborId)) {
          // Already seen from another KNN result - add to linkedFrom
          neighborMap.get(neighborId)!.linkedFrom.add(knnResult.id);
        } else {
          // New neighbor - compute similarity
          const neighborEmbedding = this.store.getStoredVectorFloat(neighborId, query.version);
          if (!neighborEmbedding) continue;

          const similarity = normalizeSimilarity(
            cosineSimilarity(queryFloat, neighborEmbedding),
            query.version,
          );

          if (similarity >= this.config.neighborSimilarityThreshold) {
            neighborMap.set(neighborId, {
              similarity,
              linkedFrom: new Set([knnResult.id]),
            });
          }
        }
      }
    }

    // Sort neighbors by similarity descending, take top maxNeighbors
    const sortedNeighbors = [...neighborMap.entries()]
      .sort((a, b) => b[1].similarity - a[1].similarity)
      .slice(0, this.config.maxNeighbors);

    // Phase 100-fu — bump access_count + accessed_at for graph-walked
    // neighbors so heavily-linked nodes can qualify for hot-tier promotion.
    // Without this, nodes that are only ever reached via wikilink traversal
    // (never as direct KNN hits) sit at access_count=0 forever and never
    // cross the 7-day promotion threshold. KNN seeds were already bumped
    // by SemanticSearch.search() at line 51 — DO NOT double-bump them.
    // Bump runs after the maxNeighbors slice so dropped neighbors stay at 0,
    // and `neighborMap` already deduplicates linkedFrom.size > 1 cases to a
    // single entry, so each neighbor is bumped exactly once per search call.
    const accessedAt = new Date().toISOString();
    for (const [neighborId] of sortedNeighbors) {
      this.store.bumpAccess(neighborId, accessedAt);
    }

    // Map KNN results to GraphSearchResult
    const knnGraphResults: readonly GraphSearchResult[] = knnResults.map((r) =>
      Object.freeze({
        id: r.id,
        content: r.content,
        relevanceScore: r.relevanceScore,
        combinedScore: r.combinedScore,
        tags: r.tags,
        createdAt: r.createdAt,
        source: "knn" as const,
      }),
    );

    // Map neighbor results to GraphSearchResult
    const neighborGraphResults: readonly GraphSearchResult[] = sortedNeighbors.map(
      ([neighborId, info]) => {
        // Fetch neighbor memory data from forward/backlinks results
        // We need content and metadata - re-query from DB
        const db = this.store.getDatabase();
        const row = db
          .prepare(
            "SELECT id, content, tags, created_at FROM memories WHERE id = ?",
          )
          .get(neighborId) as { id: string; content: string; tags: string; created_at: string } | undefined;

        return Object.freeze({
          id: neighborId,
          content: row?.content ?? "",
          relevanceScore: info.similarity,
          combinedScore: info.similarity,
          tags: Object.freeze(row ? (JSON.parse(row.tags) as string[]) : []),
          createdAt: row?.created_at ?? "",
          source: "graph-neighbor" as const,
          linkedFrom: Object.freeze([...info.linkedFrom]),
        });
      },
    );

    // Concatenate and cap at maxTotalResults
    const combined = [...knnGraphResults, ...neighborGraphResults].slice(
      0,
      this.config.maxTotalResults,
    );

    return Object.freeze(combined.map((r) => Object.freeze(r)));
  }
}
