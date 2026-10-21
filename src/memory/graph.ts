/**
 * Knowledge graph utilities for memory wikilinks.
 *
 * Extracts [[wikilink]] references from memory content and provides
 * graph traversal over the resulting directed edges.
 * Also provides backlink/forward-link query functions.
 */

import type { MemoryEntry, MemoryTier } from "./types.js";
import type { BacklinkResult, ForwardLinkResult } from "./graph.types.js";
import type { MemoryStore } from "./store.js";

/** Regex pattern matching [[wikilink]] syntax. */
const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

/**
 * Extract unique wikilink targets from memory content.
 *
 * Parses `[[target-id]]` syntax, trims whitespace, filters empties,
 * and deduplicates. Uses `String.matchAll` to avoid stateful regex issues.
 *
 * @returns Frozen array of unique target IDs.
 */
export function extractWikilinks(content: string): readonly string[] {
  const matches = content.matchAll(WIKILINK_PATTERN);
  const seen = new Set<string>();

  for (const match of matches) {
    const target = match[1].trim();
    if (target.length > 0) {
      seen.add(target);
    }
  }

  return Object.freeze([...seen]);
}

/**
 * BFS graph traversal from a starting node.
 *
 * Traverses up to `maxDepth` hops, tracking visited nodes to handle cycles.
 * The starting node is excluded from the result set.
 *
 * @param startId - Node to start traversal from.
 * @param getNeighbors - Function returning neighbors for a given node.
 * @param maxDepth - Maximum number of hops from start.
 * @returns Frozen set of reachable node IDs (excluding startId).
 */
export function traverseGraph(
  startId: string,
  getNeighbors: (id: string) => readonly string[],
  maxDepth: number,
): ReadonlySet<string> {
  const visited = new Set<string>();
  visited.add(startId);

  let frontier: string[] = [startId];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];
    for (const nodeId of frontier) {
      const neighbors = getNeighbors(nodeId);
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          nextFrontier.push(neighbor);
        }
      }
    }
    frontier = nextFrontier;
  }

  // Remove startId from result
  visited.delete(startId);

  return Object.freeze(visited);
}

/** Raw row shape from backlink/forward-link SQL queries. */
type BacklinkRow = {
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
  readonly link_text: string;
};

/** Convert a SQL row to an immutable MemoryEntry (no embedding loaded). */
function rowToMemoryEntry(row: BacklinkRow): MemoryEntry {
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
    tier: (row.tier ?? "warm") as MemoryTier,
    sourceTurnIds,
  });
}

/**
 * Get all memories that link TO a given target (backlinks).
 *
 * Returns frozen array of results ordered by created_at DESC.
 */
export function getBacklinks(store: MemoryStore, targetId: string): readonly BacklinkResult[] {
  const stmts = store.getGraphStatements();
  const rows = stmts.getBacklinks.all(targetId) as BacklinkRow[];
  return Object.freeze(rows.map((row) => Object.freeze({
    memory: rowToMemoryEntry(row),
    linkText: row.link_text,
  })));
}

/**
 * Get all memories that a given source links TO (forward links).
 *
 * Returns frozen array of results ordered by created_at DESC.
 */
export function getForwardLinks(store: MemoryStore, sourceId: string): readonly ForwardLinkResult[] {
  const stmts = store.getGraphStatements();
  const rows = stmts.getForwardLinks.all(sourceId) as BacklinkRow[];
  return Object.freeze(rows.map((row) => Object.freeze({
    memory: rowToMemoryEntry(row),
    linkText: row.link_text,
  })));
}
