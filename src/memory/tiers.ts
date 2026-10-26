/**
 * Pure tier transition functions for memory storage tiers.
 *
 * Determines when memories should move between hot, warm, and cold tiers
 * based on access patterns and relevance scores. All functions are pure
 * (no side effects, no I/O).
 */

import { differenceInDays } from "date-fns";
import { calculateRelevanceScore } from "./decay.js";

/** Configuration for tier transition thresholds. */
export type TierConfig = {
  readonly hotAccessThreshold: number;
  readonly hotAccessWindowDays: number;
  readonly hotDemotionDays: number;
  readonly coldRelevanceThreshold: number;
  readonly hotBudget: number;
  /**
   * Phase 100-fu — structural-importance promotion. A memory with this
   * many backlinks (or more) is promoted to hot tier even when it is
   * rarely directly accessed. Captures hub nodes in the wikilink graph
   * (e.g. a "fin-client" memory referenced by many turn summaries).
   *
   * Production audit motivating this signal (fin-client agent):
   * 1,161 of 1,182 memories sat at access_count=0 despite 7,338 wikilink
   * edges — heavy-linked hubs were never reachable via the access-based
   * promotion path because their neighbor seeds rarely landed in the
   * KNN top-K, so the graph-walk access bumps (commit 387a6b2) couldn't
   * rescue them.
   */
  readonly centralityPromoteThreshold: number;
};

/**
 * Tags that mark session-derived checkpoint rows: mid-session flushes,
 * final session summaries and their raw-turn fallbacks. These rows are
 * pointers to conversation history, not standing facts. They never enter
 * the hot tier, never seed or receive auto:similar links, and the default
 * retrieval excludeTags already keeps them out of the pre-turn block. On
 * the production host 19 of 20 hot rows were flush rows promoted through
 * centrality, which is what this list exists to stop.
 *
 * Shared by tier-manager.ts, similarity.ts and the promotion SQL in
 * store.ts (which mirrors the list inline, pinned by a store test).
 */
export const SESSION_DERIVED_TAGS: readonly string[] = Object.freeze([
  "mid-session",
  "session-summary",
  "raw-fallback",
]);

/** True when any tag marks the row as session-derived (see SESSION_DERIVED_TAGS). */
export function hasSessionDerivedTag(tags: readonly string[]): boolean {
  for (const tag of tags) {
    if (SESSION_DERIVED_TAGS.includes(tag)) return true;
  }
  return false;
}

/** Default tier configuration matching D-05/D-06/D-07/D-09 design decisions. */
export const DEFAULT_TIER_CONFIG: Readonly<TierConfig> = Object.freeze({
  hotAccessThreshold: 3,
  hotAccessWindowDays: 7,
  hotDemotionDays: 7,
  coldRelevanceThreshold: 0.05,
  hotBudget: 20,
  centralityPromoteThreshold: 5,
});

/**
 * Determine if a memory should be promoted from warm to hot tier.
 *
 * Two independent paths qualify a memory for promotion:
 *
 *   1. Access-based (D-05): sufficient access count AND recent access
 *      within the configured window.
 *   2. Centrality-based (Phase 100-fu): backlink count meets or exceeds
 *      `config.centralityPromoteThreshold`. Skipped when `backlinkCount`
 *      is omitted — preserves pre-fix behavior at every existing
 *      call site.
 *
 * @param accessCount - Number of times the memory has been accessed
 * @param accessedAt - ISO 8601 timestamp of last access
 * @param now - Current reference time
 * @param config - Tier configuration thresholds
 * @param backlinkCount - Optional. When provided, enables the
 *   centrality-based promotion path. Omit to keep callers on the
 *   pre-Phase-100-fu access-only behavior.
 * @returns true if memory qualifies for hot tier promotion
 */
export function shouldPromoteToHot(
  accessCount: number,
  accessedAt: string,
  now: Date,
  config: TierConfig,
  backlinkCount?: number,
): boolean {
  // Path 1: access-based (D-05). Sufficient access count AND recent
  // access within the configured window.
  if (accessCount >= config.hotAccessThreshold) {
    const daysSinceAccess = differenceInDays(now, new Date(accessedAt));
    if (daysSinceAccess <= config.hotAccessWindowDays) {
      return true;
    }
  }

  // Path 2: centrality-based (Phase 100-fu). Heavy-backlink hubs are
  // structurally important and should reach hot tier even when access
  // count is low or accessedAt is stale. Gated on backlinkCount being
  // explicitly supplied so existing call sites stay on the access-only
  // path.
  if (
    backlinkCount !== undefined &&
    backlinkCount >= config.centralityPromoteThreshold
  ) {
    return true;
  }

  return false;
}

/**
 * Determine if a memory should be demoted from hot to warm tier (D-06).
 *
 * A hot memory that hasn't been accessed within the demotion window
 * should be moved back to warm.
 *
 * @param accessedAt - ISO 8601 timestamp of last access
 * @param now - Current reference time
 * @param config - Tier configuration thresholds
 * @returns true if memory should be demoted to warm
 */
export function shouldDemoteToWarm(
  accessedAt: string,
  now: Date,
  config: TierConfig,
): boolean {
  const daysSinceAccess = differenceInDays(now, new Date(accessedAt));
  return daysSinceAccess >= config.hotDemotionDays;
}

/**
 * Determine if a memory should be archived to cold tier (D-07).
 *
 * Uses the relevance decay score (importance * half-life decay) to determine
 * if a memory has become irrelevant enough to archive.
 *
 * @param importance - Base importance score (0-1)
 * @param accessedAt - ISO 8601 timestamp of last access
 * @param now - Current reference time
 * @param config - Tier configuration thresholds
 * @returns true if memory should be archived to cold
 */
export function shouldArchiveToCold(
  importance: number,
  accessedAt: string,
  now: Date,
  config: TierConfig,
): boolean {
  const relevanceScore = calculateRelevanceScore(
    importance,
    accessedAt,
    now,
    { halfLifeDays: 30 },
  );
  return relevanceScore < config.coldRelevanceThreshold;
}
