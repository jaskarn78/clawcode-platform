/**
 * Phase 999.122 — one memory census, two consumers.
 *
 * `clawcode memory doctor` (IPC `memory-doctor`) and the `memory-census`
 * heartbeat check (what `/api/health` carries for the fleet brief) report
 * the same numbers, so they call the same function. The cutoffs are the
 * ones the daily `session-retention` check acts on, so "stale" here means
 * "will be closed at the next hygiene pass".
 */

import type { MemoryStore, IntegrityReport } from "../memory/store.js";
import type { TierManager } from "../memory/tier-manager.js";
import type { ConversationStore } from "../memory/conversation-store.js";
import {
  EMPTY_SESSION_RETENTION_DAYS,
  ORPHAN_ACTIVE_MAX_AGE_MS,
} from "../heartbeat/checks/session-retention.js";

export type MemoryCensus = Readonly<{
  collectedAt: string;
  /** Memories per tier (`hot` / `warm` / `cold`). */
  tierCounts: Readonly<Record<string, number>>;
  /** Total rows in `memories`. */
  memories: number;
  /** Pre-999.119 cold archive files still on disk (imported by `--repair`). */
  coldFiles: number;
  integrity: IntegrityReport;
  sessions: Readonly<{
    total: number;
    active: number;
    activeEmpty: number;
    staleActive: number;
    emptyTerminated: number;
  }> | null;
  embedding: Readonly<{
    readVersion: string;
    memoriesMissingV2: number;
    chunksMissingV2: number;
    /** Share of memories that have a v2 vector, 0..1. */
    v2Coverage: number;
  }>;
}>;

/** The narrow surface the census needs from the SessionManager. */
export type MemoryCensusSource = {
  getMemoryStore(agentName: string): MemoryStore | undefined;
  getTierManager(agentName: string): TierManager | undefined;
  getConversationStore(agentName: string): ConversationStore | undefined;
};

/** The session cutoffs the census counts against (shared with the repair path). */
export function sessionCutoffs(now: number = Date.now()): Readonly<{
  staleActiveBefore: string;
  emptyTerminatedBefore: string;
}> {
  return Object.freeze({
    staleActiveBefore: new Date(now - ORPHAN_ACTIVE_MAX_AGE_MS).toISOString(),
    emptyTerminatedBefore: new Date(
      now - EMPTY_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString(),
  });
}

/**
 * Collect the census for one agent. Returns null when the agent has no
 * memory store (not running). Read-only; never repairs.
 */
export function collectMemoryCensus(
  source: MemoryCensusSource,
  agentName: string,
  now: number = Date.now(),
): MemoryCensus | null {
  const store = source.getMemoryStore(agentName);
  if (!store) return null;
  const tierManager = source.getTierManager(agentName);
  const conv = source.getConversationStore(agentName);

  const integrity = store.checkIntegrity();
  const tierRows = store
    .getDatabase()
    .prepare("SELECT tier, COUNT(*) AS n FROM memories GROUP BY tier")
    .all() as Array<{ tier: string; n: number }>;
  const tierCounts: Record<string, number> = {};
  let memories = 0;
  for (const row of tierRows) {
    tierCounts[row.tier] = row.n;
    memories += row.n;
  }
  const coldFiles = tierManager ? tierManager.coldArchiveFileCount() : 0;
  const { staleActiveBefore, emptyTerminatedBefore } = sessionCutoffs(now);
  const sessions = conv ? conv.getSessionHealth(staleActiveBefore, emptyTerminatedBefore) : null;
  const memoriesMissingV2 = store.countMemoriesMissingV2Embedding();
  const embedding = Object.freeze({
    readVersion: store.getEmbeddingReadVersion(),
    memoriesMissingV2,
    chunksMissingV2: store.countChunksMissingV2Embedding(),
    v2Coverage: memories === 0 ? 1 : Math.max(0, (memories - memoriesMissingV2) / memories),
  });

  return Object.freeze({
    collectedAt: new Date(now).toISOString(),
    tierCounts: Object.freeze(tierCounts),
    memories,
    coldFiles,
    integrity,
    sessions,
    embedding,
  });
}

/** Stale `active` session rows above this count are worth a warning. */
export const STALE_SESSIONS_WARN_THRESHOLD = 100;

/**
 * What is wrong, in the words the fleet brief should use. Empty when the
 * store is clean.
 */
export function memoryCensusProblems(census: MemoryCensus): readonly string[] {
  const problems: string[] = [];
  const i = census.integrity;
  if (i.fkViolations > 0) problems.push(`${i.fkViolations} foreign-key violation(s)`);
  if (i.total > 0) problems.push(`${i.total} repairable integrity issue(s)`);
  if (i.memoriesWithoutEmbedding > 0) {
    problems.push(`${i.memoriesWithoutEmbedding} memories without any embedding (invisible to search)`);
  }
  if (census.coldFiles > 0) {
    problems.push(`${census.coldFiles} legacy cold archive file(s) on disk`);
  }
  if (census.sessions && census.sessions.staleActive > STALE_SESSIONS_WARN_THRESHOLD) {
    problems.push(`${census.sessions.staleActive} stale active session rows`);
  }
  return problems;
}

/** One-line healthy summary: sizes and the read path. */
export function memoryCensusLine(census: MemoryCensus): string {
  const tiers = ["hot", "warm", "cold"]
    .map((t) => `${t} ${census.tierCounts[t] ?? 0}`)
    .join(" / ");
  const pct = Math.round(census.embedding.v2Coverage * 100);
  const sessions = census.sessions ? ` · sessions ${census.sessions.active} active` : "";
  return `memories ${census.memories} (${tiers}) · FK ${census.integrity.fkViolations} · orphans ${census.integrity.total}${sessions} · reads ${census.embedding.readVersion} (v2 ${pct}% covered)`;
}
