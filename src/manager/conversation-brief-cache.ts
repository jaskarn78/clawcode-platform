/**
 * Phase 73 Plan 02 — Per-agent conversation-brief cache.
 *
 * Caches the output of `assembleConversationBrief` per agent, keyed by a
 * fingerprint over the sorted list of terminated-session IDs the brief
 * considered. Invalidated when the fingerprint changes (new terminated
 * session appears) or when the agent stops / crashes.
 *
 * Rationale: the persistent-subprocess change in Plan 01 makes a per-turn
 * brief refresh a future possibility; this cache gives that refresh path an
 * O(1) hit path without re-running assembleConversationBrief. Scope: in-
 * memory, per-daemon-boot. No persistence.
 *
 * See 73-RESEARCH.md Pattern 3 + Example 2.
 */

import { createHash } from "node:crypto";

export type BriefCacheEntry = Readonly<{
  fingerprint: string;
  briefBlock: string;
}>;

/**
 * sha256 over sorted-and-|-joined session IDs, sliced to 16 hex chars.
 *
 * Mirrors src/manager/context-assembler.ts:computePrefixHash style so a
 * reader skimming both feels a single convention. Sort-invariant: the same
 * set of IDs yields the same fingerprint regardless of input order. Empty
 * input returns the sha256 of the empty string sliced to 16 chars — stable
 * and deterministic, NOT the empty string itself.
 */
export function computeBriefFingerprint(
  terminatedSessionIds: readonly string[],
): string {
  const sorted = [...terminatedSessionIds].sort();
  return createHash("sha256")
    .update(sorted.join("|"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Per-agent conversation-brief cache. Not thread-safe; owned by a single
 * SessionManager instance. Entries are frozen on write so downstream
 * consumers cannot mutate the cached block in place.
 */
export class ConversationBriefCache {
  private readonly entries = new Map<string, BriefCacheEntry>();

  get(agent: string): BriefCacheEntry | undefined {
    return this.entries.get(agent);
  }

  set(
    agent: string,
    entry: { fingerprint: string; briefBlock: string },
  ): void {
    this.entries.set(
      agent,
      Object.freeze({
        fingerprint: entry.fingerprint,
        briefBlock: entry.briefBlock,
      }),
    );
  }

  invalidate(agent: string): void {
    this.entries.delete(agent);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Test-only visibility — NOT part of the production API contract. */
  size(): number {
    return this.entries.size;
  }
}
