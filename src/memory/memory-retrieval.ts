/**
 * Phase 90 MEM-03, hybrid RRF memory retrieval.
 *
 * Pre-turn retrieval entry point called by TurnDispatcher's
 * dispatchStream hook. Combines two rankers per surface:
 *   1. vec_memory_chunks cosine top-K (semantic similarity).
 *   2. memory_chunks_fts BM25-ranked top-K (lexical match).
 * plus the same pair over the agent's saved memories (vec_memories and
 * memories_fts).
 *
 * Ranks are fused via Reciprocal Rank Fusion (RRF) with k=60 per D-RRF
 * default. Memory overhaul WP2 (2026-10-25) changed the scoring around the
 * fusion so that relevance decides and the priors only nudge:
 *   - the path-derived score_weight (vault/procedures/archive per D-19) is
 *     MULTIPLICATIVE: fused * (1 + weight), weight clamped to [-0.2, 0.2].
 *     The old additive +0.2 was six times the largest possible RRF score,
 *     so any vault chunk in the candidate set beat every relevant memory;
 *   - each ranker over-fetches RETRIEVAL_FETCH_K (60) candidates instead of
 *     20, and excluded memory tags are dropped BEFORE fusion (with one
 *     larger refetch when the filter consumed most of a full fetch), so
 *     flush rows no longer fill the candidate window;
 *   - the D-24 14-day window is a SOFT recency factor by default
 *     (max(0.35, 0.5 ** (ageDays / windowDays))) on dated chunks, applied on
 *     the RRF rank scale: a dated chunk counts as if it sat at rank / factor
 *     in each ranker (see recencyDemotedRrf). Nothing is dropped; standing
 *     paths (vault, procedures, digests, cue files, documents) are
 *     untouched. `timeWindowMode: "hard"` restores the old drop filter;
 *   - a query-embedding failure logs once and continues with the keyword
 *     rankers only instead of throwing away keyword recall;
 *   - the token-budget loop skips an oversize candidate and keeps filling
 *     instead of stopping at it (the first candidate is always emitted);
 *   - every result carries `sourceKind` and a date (`createdAt` for memories
 *     and shared facts, `fileMtimeMs` for chunks) so the rendered block and
 *     the recall footer can show provenance.
 *
 * Pure module: no side-effects beyond diagnostics, no ambient state. Store +
 * embed are DI'd so the retrieval path is fully testable without a daemon.
 * Callers (SessionManager.getMemoryRetrieverForAgent) curry per-agent
 * store/embed.
 */

import type { MemoryStore } from "./store.js";
import { applyTimeWindowFilter, isStandingMemoryPath } from "./memory-chunks.js";
import { calculateRelevanceScore } from "./decay.js";
import { distanceToSimilarity, type ScoringConfig } from "./relevance.js";
import type { QueryVector } from "./embedding-version.js";
import { rerankTop, type RerankFn, type RerankerLogger } from "./reranker.js";
import { stripChannelEnvelope } from "../shared/channel-envelope.js";

/**
 * Query embedder. A bare Float32Array is a v1 (MiniLM) query; a tagged
 * `QueryVector` selects the space (Phase 999.119 v2 switch, use
 * `store.embedQuery(embedder, text)` to follow the agent's read version).
 */
export type EmbedFn = (text: string) => Promise<Float32Array | QueryVector>;

/**
 * WP2 provenance: where a retrieved item came from.
 *   memory   = the agent's own saved memories (memory_save)
 *   chunk    = a file-scanner chunk (MEMORY.md sections, daily logs, vault)
 *   document = a cross-ingested document or image chunk (`document:<slug>`)
 *   shared   = an owner fact from the fleet shared-facts store
 */
export type MemorySourceKind = "memory" | "chunk" | "document" | "shared";

export type MemoryRetrievalResult = Readonly<{
  chunkId: string;
  path: string;
  heading: string | null;
  body: string;
  /**
   * Ranking score (higher = better): the RRF fused score (with dated chunks'
   * ranks demoted by the soft recency factor) times (1 + scoreWeight).
   */
  fusedScore: number;
  /** Path-derived nudge clamped to [-0.2, 0.2] (vault +0.2, procedures +0.1, archive -0.2, else 0). */
  scoreWeight: number;
  /**
   * Phase 100-fu: coarse surface the result originated from. "chunk" =
   * file-scanner memory_chunks. "memory" = the agent's own saved memories
   * (memory_save). Kept for every pre-existing caller; `sourceKind` is the
   * finer WP2 label.
   */
  source: "chunk" | "memory";
  /**
   * WP2: memory / chunk / document / shared. Optional in the type so
   * pre-existing literal builders (shared facts) keep compiling; every
   * result emitted by retrieveMemoryChunks sets it. Use
   * `retrievalSourceKind` to read it with the path-based fallback.
   */
  sourceKind?: MemorySourceKind;
  /**
   * Phase 999.124: ISO `created_at` of a memory-sourced result (or a shared
   * fact), for the rendered heading and the recall footer's date range.
   */
  createdAt?: string;
  /**
   * WP2: epoch ms mtime of the file behind a chunk-sourced result (the
   * ingest time for a document chunk). `retrievalResultDate` turns either
   * field into one ISO date.
   */
  fileMtimeMs?: number;
}>;

/**
 * Phase 90 D-RRF, RRF fusion constant. 60 is the Cormack/Clarke canonical
 * value used in most RRF implementations; it compresses the score range to
 * roughly [0, 0.033] per ranker, which is why the path weights have to be
 * multiplicative (see MAX_PATH_SCORE_WEIGHT).
 */
export const RRF_K = 60;

/**
 * WP2: candidates fetched from EACH ranker before fusion. Was 20, which the
 * 14-day window then thinned after the fact: the 20 nearest chunks filled
 * up with out-of-window rows and the in-window ones at rank 21+ were never
 * fetched. 60 per ranker keeps hydration cheap (a primary-key read each)
 * while leaving room for the filters that run before ranking.
 */
export const RETRIEVAL_FETCH_K = 60;

/**
 * WP2: when the excluded-tag filter removes more than two thirds of a FULL
 * memories-side fetch, that ranker is fetched once more at this multiple of
 * RETRIEVAL_FETCH_K so a flood of flush rows cannot hide the saved memory
 * behind them. One retry, bounded; the durable fix is a tag predicate in
 * the store's SQL (store.ts is owned by another package).
 */
const MEMORY_REFETCH_MULTIPLIER = 10;

/** WP2: |scoreWeight| never exceeds this; the multiplier stays in [0.8, 1.2]. */
export const MAX_PATH_SCORE_WEIGHT = 0.2;

/**
 * WP2: lowest soft recency factor for a dated chunk. Applied on the rank
 * scale, the floor means an old note ranks as if it sat at most 1 / 0.35
 * (about 2.9) times lower in each ranked list, so an old note that is the
 * best match is still returned.
 */
export const SOFT_WINDOW_FLOOR = 0.35;

/** Clamp a stored path weight to [-MAX_PATH_SCORE_WEIGHT, MAX_PATH_SCORE_WEIGHT]. */
export function clampScoreWeight(weight: number): number {
  if (!Number.isFinite(weight)) return 0;
  return Math.max(-MAX_PATH_SCORE_WEIGHT, Math.min(MAX_PATH_SCORE_WEIGHT, weight));
}

/**
 * WP2 soft time window: 0.5 ** (ageDays / windowDays), floored at
 * SOFT_WINDOW_FLOOR. A chunk exactly one window old scores half; two
 * windows old a quarter; anything older sits at the floor. `windowDays <= 0`
 * disables the factor (returns 1), matching applyTimeWindowFilter's
 * "no window" convention.
 */
export function softRecencyFactor(ageDays: number, windowDays: number): number {
  if (!(windowDays > 0)) return 1;
  const age = Number.isFinite(ageDays) ? Math.max(0, ageDays) : Number.POSITIVE_INFINITY;
  return Math.max(SOFT_WINDOW_FLOOR, Math.pow(0.5, age / windowDays));
}

/**
 * WP2: RRF score of a candidate whose recency factor is `factor`, given its
 * 0-based positions in each ranker that returned it. Each position is
 * demoted to (position + 1) / factor before the usual 1 / (k + rank), so
 * `factor = 1` gives exactly the rrfFuse score.
 *
 * Why on the rank scale and not on the fused score: RRF scores span only
 * about 1/120 to 2/61 (a factor of 4), so multiplying the fused score by
 * the 0.35 floor put a dated note found first by BOTH rankers (2/61 x 0.35
 * = 0.011) below every fresh candidate in the top 27 of EITHER ranker
 * (1/87 = 0.011). Any agent with a few saved memories or recent logs has
 * that many, so the soft window behaved exactly like the hard 14-day drop
 * it replaced. Demoting the rank keeps recency a bounded tie-breaker: a
 * best match that is old loses about 3 percent (rank 1 counts as 2.9), a
 * weak old match at rank 20 loses about a third (it counts as rank 57).
 */
export function recencyDemotedRrf(
  positions: readonly number[],
  factor: number,
  k: number = RRF_K,
): number {
  const f = factor > 0 && Number.isFinite(factor) ? Math.min(1, factor) : SOFT_WINDOW_FLOOR;
  let score = 0;
  for (const p of positions) score += 1 / (k + (p + 1) / f);
  return score;
}

/** `sourceKind` with a path-based fallback for results built elsewhere. */
export function retrievalSourceKind(
  r: Readonly<{ source: "chunk" | "memory"; path: string; chunkId?: string; sourceKind?: MemorySourceKind }>,
): MemorySourceKind {
  if (r.sourceKind) return r.sourceKind;
  if (r.source === "memory") return "memory";
  if (isDocumentChunk(r.path)) return "document";
  if ((r.chunkId ?? "").startsWith("shared:")) return "shared";
  return "chunk";
}

/** ISO date for a result: `createdAt` first, then `fileMtimeMs`; undefined when neither parses. */
export function retrievalResultDate(
  r: Readonly<{ createdAt?: string; fileMtimeMs?: number }>,
): string | undefined {
  if (r.createdAt) {
    const t = Date.parse(r.createdAt);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  if (typeof r.fileMtimeMs === "number" && Number.isFinite(r.fileMtimeMs) && r.fileMtimeMs > 0) {
    return new Date(r.fileMtimeMs).toISOString();
  }
  return undefined;
}

/**
 * Phase 999.43 Plan 03 Task 2 — D-02 score formula applied to memory
 * chunks whose `path` starts with `document:` (cross-ingested via
 * `src/document-ingest/cross-ingest.ts` per Phase 101 Plan 03 CF-1).
 *
 * The post-RRF rank pass calls this helper BEFORE the reranker gate so
 * priority-weighted document chunks influence pre-rerank ordering per
 * Phase 999.43 SC-D. Non-document candidates pass through unchanged.
 *
 * Multipliers (LOCKED VERBATIM):
 *   agentWeight  (D-01 axis 1): 1.5 / 1.0 / 0.7 — caller resolves from
 *     the agent's LIVE `ingestionPriority` config (hot-reload honored).
 *   contentWeight (D-01 axis 2): 1.5 / 1.0 / 0.5 — from
 *     `documents.content_priority_weight`.
 *   recencyBoost (D-07, query-time): 1.3× if `documents.ingested_at` is
 *     within the recency window, else 1.0×. The window is `deps.recencyWindowMs`
 *     when supplied (Quick-260521-437 — operator-tunable, default 2 days);
 *     legacy callers that omit it fall back to the 7-day `SEVEN_DAYS_MS`
 *     constant for back-compat.
 *
 * Missing documents row (e.g. pre-Phase-101 leftover, or a slug that no
 * longer maps to a row) → multipliers all default to 1.0; the candidate
 * is counted in `skippedCount` for telemetry but is NOT dropped.
 *
 * The candidate `T` type is loose so both `Hydrated` (memory-retrieval's
 * internal shape with `path` + `fusedScore`) and other consumers can
 * call this helper without coupling. Output adds a `weightedFused` field
 * to each candidate.
 */
/**
 * Legacy recency-boost window. Quick-260521-437 — this is now only the
 * BACK-COMPAT fallback for callers (and tests) that omit `recencyWindowMs`
 * from `applyDocumentPriorityWeight`'s deps. Production callers thread a
 * shorter, operator-tunable window (default 2 days) so a cross-ingested
 * document dump self-clears from per-turn retrieval in ~48h instead of a
 * full week.
 */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const RECENCY_BOOST = 1.3;
const DOCUMENT_PATH_PREFIX = "document:";

/**
 * Quick-260521-437 — true when a memory chunk's `path` marks it as a
 * cross-ingested document/image chunk (`document:<slug>`). Used both by
 * `applyDocumentPriorityWeight` and by the `retrieveMemoryChunks`
 * document-chunk cap pass.
 */
function isDocumentChunk(path: string | null | undefined): boolean {
  return (path ?? "").startsWith(DOCUMENT_PATH_PREFIX);
}

export function applyDocumentPriorityWeight<
  T extends { path?: string | null; fusedScore?: number },
>(
  candidates: readonly T[],
  deps: {
    /**
     * Resolve a documents row from the doc slug embedded in
     * `path = "document:<slug>"`. Return null when no row is found —
     * the multipliers will fall back to neutral 1.0 each.
     */
    readonly getDocumentRow: (
      docSlug: string,
    ) =>
      | { readonly content_priority_weight: number; readonly ingested_at: string }
      | null;
    /** LIVE per-agent multiplier resolved by caller from config. */
    readonly agentWeight: number;
    /**
     * Quick-260521-437 — recency-boost window in milliseconds. A document
     * chunk whose `documents.ingested_at` age exceeds this window receives
     * recencyBoost 1.0 (no boost); within it, 1.3. When omitted the legacy
     * `SEVEN_DAYS_MS` (7-day) window applies — preserves behavior for
     * pre-quick-437 callers and existing tests.
     */
    readonly recencyWindowMs?: number;
    /** Test hook: override `Date.now()` for deterministic recency math. */
    readonly now?: number;
    /** Optional log sink for the per-call structured diagnostic. */
    readonly logger?: {
      debug?: (obj: Record<string, unknown>, msg?: string) => void;
    };
  },
): readonly (T & { weightedFused: number })[] {
  const now = deps.now ?? Date.now();
  // Quick-260521-437 — operator-tunable recency window; legacy 7-day
  // fallback when the caller does not thread one through.
  const recencyWindowMs = deps.recencyWindowMs ?? SEVEN_DAYS_MS;
  let appliedCount = 0;
  let skippedCount = 0;

  const out = candidates.map((c) => {
    const fused = c.fusedScore ?? 0;
    const path = c.path ?? "";
    if (!isDocumentChunk(path)) {
      // Non-document candidate — pass through unchanged.
      return { ...c, weightedFused: fused };
    }
    const slug = path.slice(DOCUMENT_PATH_PREFIX.length);
    const row = deps.getDocumentRow(slug);
    if (!row) {
      // Missing provenance row → neutral multipliers. Still flagged
      // skipped for diagnostic visibility (filter inactive vs. data race).
      skippedCount += 1;
      return { ...c, weightedFused: fused * deps.agentWeight };
    }
    const contentWeight = row.content_priority_weight ?? 1.0;
    const ingestedTs = row.ingested_at ? Date.parse(row.ingested_at) : 0;
    const ageMs =
      ingestedTs > 0 ? now - ingestedTs : Number.POSITIVE_INFINITY;
    const recencyBoost = ageMs <= recencyWindowMs ? RECENCY_BOOST : 1.0;
    appliedCount += 1;
    return {
      ...c,
      weightedFused: fused * deps.agentWeight * contentWeight * recencyBoost,
    };
  });

  if (appliedCount > 0) {
    const payload = {
      tag: "phase999.43-weight",
      appliedCount,
      skippedCount,
      agentWeight: deps.agentWeight,
    };
    deps.logger?.debug?.(payload, "phase999.43-weight applied");
    // Also fire to stdout (daemon captures via systemd) — mirrors the
    // Phase 115 phase115-tag-filter pattern.
    console.info("phase999.43-weight", JSON.stringify(payload));
  }

  return out;
}

/**
 * Fuse two ranked lists into a single score-sorted result set.
 *
 * RRF formula: score(doc) = sum over rankers of 1/(k + rank(doc)).
 * Missing-from-one-ranker docs only contribute from the ranker(s) they
 * appear in, so presence in both rankers beats presence in one.
 *
 * Rank here is POSITION in the input list (0-based), NOT the store's
 * raw distance/rank value — RRF is position-based by design so distance
 * and BM25 rank (which have incompatible units) combine cleanly.
 */
export function rrfFuse(
  vecRanked: readonly { chunk_id: string; distance: number }[],
  ftsRanked: readonly { chunk_id: string; rank: number }[],
  k: number = RRF_K,
): readonly { chunk_id: string; score: number }[] {
  const scoreMap = new Map<string, number>();
  vecRanked.forEach((r, i) => {
    scoreMap.set(
      r.chunk_id,
      (scoreMap.get(r.chunk_id) ?? 0) + 1 / (k + i + 1),
    );
  });
  ftsRanked.forEach((r, i) => {
    scoreMap.set(
      r.chunk_id,
      (scoreMap.get(r.chunk_id) ?? 0) + 1 / (k + i + 1),
    );
  });
  return Object.freeze(
    [...scoreMap.entries()]
      .map(([chunk_id, score]) => ({ chunk_id, score }))
      .sort((a, b) => b.score - a.score),
  );
}

export type RetrieveArgs = Readonly<{
  query: string;
  store: MemoryStore;
  embed: EmbedFn;
  /** Default 5 per D-RETRIEVAL. */
  topK?: number;
  /** Default 14 per D-24. With the default soft mode this is the half-life of the recency multiplier. */
  timeWindowDays?: number;
  /**
   * WP2: how `timeWindowDays` applies to dated (non-standing) chunks.
   *   "soft" (default): factor = max(0.35, 0.5 ** (ageDays / windowDays)),
   *     applied on the rank scale (recencyDemotedRrf); nothing is dropped.
   *   "hard": the pre-WP2 behavior, applyTimeWindowFilter drops chunks
   *     older than the window.
   */
  timeWindowMode?: "soft" | "hard";
  /**
   * Default 1500 tokens (~6000 chars) per Phase 115 sub-scope 3 (was 2000
   * pre-115 per Phase 90 D-RETRIEVAL; lowered to leave margin for sub-scope
   * 1's tier-1 cap). Caller (SessionManager.getMemoryRetrieverForAgent) reads
   * from ResolvedAgentConfig.memoryRetrievalTokenBudget which loader resolves
   * from agent.X ?? defaults.X. Range enforced upstream by zod (500-8000).
   */
  tokenBudget?: number;
  /**
   * Phase 115 sub-scope 4 — exclude memories whose tags intersect this list
   * from the memories-side candidates. Locked operator default
   * ["session-summary","mid-session","raw-fallback"] removes
   * pollution-feedback memories that pre-115 leaked into the prompt as
   * giant blobs (research codebase-memory-retrieval.md Pain Points #3 +
   * #15). Empty / undefined → filter disabled (legacy behavior). The
   * chunks-side does NOT need this filter — memory_chunks rows don't carry
   * these tags (file-scanner only).
   *
   * WP2: the filter now runs on the raw ranker output BEFORE RRF fusion
   * (hydration happens once per candidate id and is reused), so excluded
   * rows no longer occupy fused rank positions.
   */
  excludeTags?: readonly string[];
  /**
   * Phase 115 sub-scope 4 — optional logger for tag-filter diagnostics.
   * When provided, ALSO emits a structured debug log via the injected
   * sink (used by tests with vi.fn()). Production always fires a
   * `console.info("phase115-tag-filter", ...)` line independently of this
   * sink so the daemon's stdout-captured systemd logs see the event
   * regardless of DI. Mirrors the T01 phase115-quickwin pattern.
   */
  log?: { debug?: (obj: Record<string, unknown>, msg?: string) => void };
  /**
   * Phase 115 sub-scope 4 — agent identifier surfaced in the tag-filter
   * diagnostic so operator can attribute drops to a specific agent.
   * Required for the production console.info diagnostic to be useful.
   */
  agent?: string;
  /** Test hook: override Date.now() for deterministic time-window gating. */
  now?: number;
  /**
   * Phase 101 Plan 04 (D-04, U9, SC-10) — optional local cross-encoder
   * reranker over the post-time-window candidate set. When provided AND
   * `enabled` is true, takes `topNToRerank` candidates (default 20) from
   * the fused+filtered+sorted result, re-scores them with
   * `Xenova/bge-reranker-base` via `rerankTop()`, and returns the top
   * `finalTopK` (default 5) in rerank-order BEFORE the token-budget
   * truncation step. On timeout / runtime error the rerank step falls
   * back to the original RRF order (graceful degradation per T-101-12).
   *
   * Caller (`SessionManager.getMemoryRetrieverForAgent`) reads
   * `defaults.documentIngest.reranker` from `clawcode.yaml` and curries
   * this object in. When omitted entirely (tests, daemon paths that
   * don't wire the resolver, off-switch via `enabled: false`), the
   * legacy non-reranked path runs unchanged — token-budget + topK
   * truncation in fused/RRF order.
   *
   * `rerankFn` is a DI hook for unit tests so they can pass a synthetic
   * scorer without monkey-patching `@huggingface/transformers`. Production
   * callers omit it and the reranker uses the lazy-loaded HF pipeline.
   */
  reranker?: Readonly<{
    enabled: boolean;
    topNToRerank: number;
    finalTopK: number;
    timeoutMs: number;
    rerankFn?: RerankFn;
    logger?: RerankerLogger;
  }>;
  /**
   * Phase 999.43 Plan 03 Task 2 — optional document-priority weighting
   * applied BEFORE the optional reranker gate. When provided, candidates
   * whose `path` starts with `document:` are scaled by the D-02 formula
   * (agentWeight × contentWeight × recencyBoost) and re-sorted; non-doc
   * candidates pass through unchanged. When omitted, the legacy
   * Phase-90-RRF / Phase-101-reranker pipeline runs untouched —
   * back-compat preserved for all callers that don't pass this.
   */
  documentPriority?: Readonly<{
    /**
     * Resolve a documents row from the doc slug embedded in
     * `memory_chunks.path = "document:<slug>"`. Return null when
     * the docs row is absent (e.g. pre-Phase-101 leftover chunk).
     */
    readonly getDocumentRow: (
      docSlug: string,
    ) =>
      | { readonly content_priority_weight: number; readonly ingested_at: string }
      | null;
    /** LIVE per-agent multiplier resolved at call time from agent config. */
    readonly agentWeight: number;
    /**
     * Quick-260521-437 — recency-boost window in milliseconds, threaded
     * down into `applyDocumentPriorityWeight`. When omitted the legacy
     * 7-day window applies (back-compat). Caller (SessionManager) resolves
     * `documentIngest.retrieval.recencyBoostDays` at turn time and converts
     * it to ms so a `clawcode reload` takes effect without a daemon bounce.
     */
    readonly recencyWindowMs?: number;
  }>;
  /**
   * Quick-260521-437 — upper bound on how many `document:`-prefixed
   * (cross-ingested image/document) chunks a single retrieval may emit.
   * When set and > 0, the cap pass runs after the reranker and before the
   * token-budget loop: excess document chunks are dropped so lower-ranked
   * NON-document chunks can reach the topK window (eviction-with-
   * replacement). It is an UPPER BOUND, never a quota — a retrieval whose
   * only candidates are document chunks still returns them up to the cap,
   * so document searchability is preserved. When omitted, the cap pass is
   * skipped entirely (fail-open, legacy behavior).
   */
  documentChunkCap?: number;
  /**
   * Phase 999.119 pass 2 — weights for the memories-side re-rank
   * (semantic similarity vs importance × recency decay). Defaults match
   * SemanticSearch: 0.7 / 0.3, 30-day half-life.
   */
  scoring?: ScoringConfig;
}>;

/** Default memories-side weighting — identical to SemanticSearch's. */
const DEFAULT_MEMORY_SCORING: ScoringConfig = Object.freeze({
  semanticWeight: 0.7,
  decayWeight: 0.3,
  halfLifeDays: 30,
});

/**
 * WP2: vector-side failures (query embedding, vec table MATCH) are logged
 * to stdout once per distinct message per process; the optional `log`
 * sink sees every occurrence. Test hook below resets the set.
 */
const vectorFallbackLogged = new Set<string>();

/** @internal test hook */
export function _resetVectorFallbackLogForTests(): void {
  vectorFallbackLogged.clear();
}

function logVectorFallback(
  args: Pick<RetrieveArgs, "log" | "agent">,
  stage: "embed" | "vec-search",
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  const payload = { action: "wp2-vector-fallback", stage, agent: args.agent, error: message };
  args.log?.debug?.(payload, "memory retrieval: vector side unavailable, keyword rankers only");
  const key = `${stage}:${message}`;
  if (vectorFallbackLogged.has(key)) return;
  vectorFallbackLogged.add(key);
  console.warn("wp2-vector-fallback", JSON.stringify(payload));
}

/**
 * Phase 90 MEM-03, hybrid-RRF pre-turn retrieval.
 *
 * Pipeline (WP2 numbering):
 *   1. Strip the Discord channel envelope from the query.
 *   2. Embed the query (on failure: keyword rankers only, logged once).
 *   3. Fetch RETRIEVAL_FETCH_K candidates from each of the four rankers.
 *   4. Memories side: hydrate once per id, drop excluded tags BEFORE
 *      fusion (one larger refetch when the filter ate a full fetch), rank
 *      by similarity x importance x recency, RRF-fuse with memories_fts.
 *   5. Chunks side: RRF-fuse vec + FTS, hydrate, demote dated chunks'
 *      ranks by the soft recency factor, apply fused * (1 + clampedWeight).
 *   6. Hard window (opt-in) or nothing to drop (soft default).
 *   7. Sort by fusedScore desc; document priority weighting; reranker.
 *   8. Document-chunk cap.
 *   9. Token-budget loop: skip oversize candidates, keep filling to topK,
 *      always emit the first.
 *
 * Returns a frozen readonly array so callers can't accidentally mutate the
 * retrieval set between turns.
 */
export async function retrieveMemoryChunks(
  args: RetrieveArgs,
): Promise<readonly MemoryRetrievalResult[]> {
  const topK = args.topK ?? 5;
  // Phase 115 sub-scope 3, was 2000; lowered to 1500 to align with the
  // wired-through defaults.memoryRetrievalTokenBudget. Operator override via
  // YAML; per-agent override on agentSchema. See SessionManager.getMemoryRetriever
  // ForAgent for the resolution chain.
  const tokenBudget = args.tokenBudget ?? 1500;
  // Phase 999.187, 0 (or negative) disables the window; see applyTimeWindowFilter.
  const windowDays = args.timeWindowDays ?? 14;
  const timeWindowMode = args.timeWindowMode ?? "soft";
  const now = args.now ?? Date.now();

  // WP2 query hygiene: the pre-turn query arrives as the whole Discord
  // `<channel ...>` envelope on every Discord turn. Strip it here as well as
  // in the callers so no entry point (lazy tool, scripts) can leak envelope
  // tokens into the keyword rankers or the query vector. Idempotent.
  const query = stripChannelEnvelope(args.query);
  if (query.trim().length === 0) return Object.freeze([]);

  // WP2 (e): a query-embedding failure (model download, ONNX crash, warmup
  // window after a restart) used to throw here and discard keyword recall
  // with it. Now the vector side is simply empty and FTS carries the turn.
  let qEmb: Float32Array | QueryVector | null = null;
  try {
    qEmb = await args.embed(query);
  } catch (err) {
    logVectorFallback(args, "embed", err);
  }
  const vecSearch = <T>(run: () => T, empty: T): T => {
    try {
      return run();
    } catch (err) {
      logVectorFallback(args, "vec-search", err);
      return empty;
    }
  };

  // Phase 100-fu: fan out chunk-side AND memory-side searches in parallel.
  // The chunks side is the file-scanner content (MEMORY.md). The memories
  // side is the agent's own saved memories (memory_save). Both surface
  // together ranked by RRF so the agent sees relevant content regardless of
  // which store wrote it. Phase 999.187: the memories side gets a keyword
  // ranker too (memories_fts); guarded so older store doubles without it
  // still work. WP2: RETRIEVAL_FETCH_K per ranker instead of 20.
  const fetchK = RETRIEVAL_FETCH_K;
  const memoriesFtsFn = (args.store as { searchMemoriesFts?: MemoryStore["searchMemoriesFts"] })
    .searchMemoriesFts;
  const runMemoriesFts = (k: number): ReadonlyArray<Readonly<{ memory_id: string; rank: number }>> =>
    typeof memoriesFtsFn === "function" ? memoriesFtsFn.call(args.store, query, k) : [];
  const emptyVec: ReadonlyArray<Readonly<{ chunk_id: string; distance: number }>> = [];
  const emptyMemVec: ReturnType<MemoryStore["searchMemoriesVec"]> = [];
  const [vecTop, ftsTop, memoriesVecRaw, memoriesFtsRaw] = await Promise.all([
    Promise.resolve(qEmb ? vecSearch(() => args.store.searchMemoryChunksVec(qEmb!, fetchK), emptyVec) : emptyVec),
    Promise.resolve(args.store.searchMemoryChunksFts(query, fetchK)),
    Promise.resolve(qEmb ? vecSearch(() => args.store.searchMemoriesVec(qEmb!, fetchK), emptyMemVec) : emptyMemVec),
    Promise.resolve(runMemoriesFts(fetchK)),
  ]);

  // Chunks side: RRF-fuse vec + FTS as before. The per-ranker positions are
  // kept so a dated chunk's ranks can be demoted by its recency factor.
  const fusedChunks = rrfFuse(vecTop, ftsTop, RRF_K);
  const chunkPositions = new Map<string, number[]>();
  const notePositions = (rows: readonly { chunk_id: string }[]): void => {
    const seen = new Set<string>();
    rows.forEach((r, i) => {
      if (seen.has(r.chunk_id)) return;
      seen.add(r.chunk_id);
      const list = chunkPositions.get(r.chunk_id);
      if (list) list.push(i);
      else chunkPositions.set(r.chunk_id, [i]);
    });
  };
  notePositions(vecTop);
  notePositions(ftsTop);

  // WP2 (c): memories-side tag exclusion BEFORE fusion. Hydrate each
  // candidate id once (the row read already returns tags, so the filter
  // costs no extra query) and reuse the row at emission time. A memory
  // that vanished between the ranker and hydration is a stale skip, not a
  // tag drop, so the diagnostic below still reflects filter activity.
  const excludeTags = args.excludeTags ?? [];
  const memoryMeta = new Map<string, ReturnType<MemoryStore["getMemoryForRetrieval"]>>();
  const droppedMemoryIds = new Set<string>();
  const hydrateMemory = (id: string): ReturnType<MemoryStore["getMemoryForRetrieval"]> => {
    if (!memoryMeta.has(id)) memoryMeta.set(id, args.store.getMemoryForRetrieval(id));
    return memoryMeta.get(id) ?? null;
  };
  const isAllowedMemory = (id: string): boolean => {
    const meta = hydrateMemory(id);
    if (!meta) return false;
    if (excludeTags.length > 0 && meta.tags.some((t) => excludeTags.includes(t))) {
      droppedMemoryIds.add(id);
      return false;
    }
    return true;
  };
  const keepAllowed = <T extends { memory_id: string }>(rows: readonly T[]): T[] =>
    rows.filter((r) => isAllowedMemory(r.memory_id));
  // A FULL fetch that the filter thinned to under a third means excluded
  // rows (mid-session flush summaries, typically) crowd this ranker: fetch
  // once more, wider, so the saved memory behind them can still surface.
  const refetchNeeded = (rawCount: number, keptCount: number): boolean =>
    excludeTags.length > 0 && rawCount >= fetchK && keptCount * 3 < fetchK;

  let memoriesTop = keepAllowed(memoriesVecRaw);
  if (qEmb && refetchNeeded(memoriesVecRaw.length, memoriesTop.length)) {
    memoriesTop = keepAllowed(
      vecSearch(() => args.store.searchMemoriesVec(qEmb!, fetchK * MEMORY_REFETCH_MULTIPLIER), emptyMemVec),
    );
  }
  let memoriesFtsTop = keepAllowed(memoriesFtsRaw);
  if (refetchNeeded(memoriesFtsRaw.length, memoriesFtsTop.length)) {
    memoriesFtsTop = keepAllowed(runMemoriesFts(fetchK * MEMORY_REFETCH_MULTIPLIER));
  }

  // Memories side: pseudo-RRF score from rank position. 1/(k+rank+1) keeps
  // the score scale identical to chunk-side fused scores so they sort
  // cleanly in a single combined list.
  //
  // Phase 999.119 pass 2: the rank is the COMBINED order, not raw vector
  // order: semantic similarity weighted with the same importance x recency
  // decay that SemanticSearch (the explicit memory_lookup path) has always
  // applied. Two memories at equal distance no longer tie on insertion
  // order; the important, recently-used one leads; a decayed cold row needs
  // a clearly closer match to outrank it.
  const scoring = args.scoring ?? DEFAULT_MEMORY_SCORING;
  const nowDate = new Date(now);
  const memoriesRanked = memoriesTop
    .map((r, vectorRank) => ({
      memory_id: r.memory_id,
      vectorRank,
      combined:
        distanceToSimilarity(r.distance) * scoring.semanticWeight +
        calculateRelevanceScore(
          r.importance ?? 0.5,
          r.accessed_at ?? nowDate.toISOString(),
          nowDate,
          { halfLifeDays: scoring.halfLifeDays },
        ) *
          scoring.decayWeight,
    }))
    .sort((a, b) => b.combined - a.combined || a.vectorRank - b.vectorRank);
  // Phase 999.187: RRF-fuse the combined-ranked vector list with the
  // keyword list, exactly as the chunks side does. A memory found by BOTH
  // rankers scores up to 2/(k+1) and can outrank a chunk found by one; a
  // memory found by keyword alone (an exact ticker, a name) now surfaces at
  // all, which the vector-only side could not guarantee.
  //
  // Keyword ties (equal bm25 rank, e.g. two memories with the same words)
  // are broken by the combined order, so importance x recency still decides
  // between otherwise-identical candidates instead of FTS row order.
  const combinedIndex = new Map(memoriesRanked.map((r, i) => [r.memory_id, i] as const));
  const memoriesFtsOrdered = [...memoriesFtsTop].sort(
    (a, b) =>
      a.rank - b.rank ||
      (combinedIndex.get(a.memory_id) ?? Number.MAX_SAFE_INTEGER) -
        (combinedIndex.get(b.memory_id) ?? Number.MAX_SAFE_INTEGER),
  );
  const memoriesFused = rrfFuse(
    memoriesRanked.map((r) => ({ chunk_id: r.memory_id, distance: 0 })),
    memoriesFtsOrdered.map((r) => ({ chunk_id: r.memory_id, rank: r.rank })),
    RRF_K,
  );

  type Hydrated = {
    chunkId: string;
    path: string;
    heading: string | null;
    body: string;
    file_mtime_ms: number;
    fusedScore: number;
    scoreWeight: number;
    source: "chunk" | "memory";
    sourceKind: MemorySourceKind;
    /** Phase 999.124: memory-sourced rows carry their created_at for the recall footer. */
    createdAt?: string;
  };
  const hydrated: Hydrated[] = [];

  // Hydrate chunk-side. WP2 (b): the path weight multiplies the fused score
  // (clamped to +-0.2, so the multiplier stays within [0.8, 1.2]) instead of
  // being added to it. WP2 (c): dated chunks decay softly with age on the
  // rank scale (recencyDemotedRrf); standing paths (vault, procedures,
  // digests, cue files, documents) keep their plain RRF score.
  for (const f of fusedChunks) {
    const meta = args.store.getMemoryChunk(f.chunk_id);
    if (!meta) continue;
    const weight = clampScoreWeight(meta.score_weight);
    let rrf = f.score;
    if (timeWindowMode === "soft" && windowDays > 0 && !isStandingMemoryPath(meta.path)) {
      const factor = softRecencyFactor((now - meta.file_mtime_ms) / 86_400_000, windowDays);
      if (factor < 1) rrf = recencyDemotedRrf(chunkPositions.get(f.chunk_id) ?? [], factor);
    }
    const score = rrf * (1 + weight);
    hydrated.push({
      chunkId: f.chunk_id,
      path: meta.path,
      heading: meta.heading,
      body: meta.body,
      file_mtime_ms: meta.file_mtime_ms,
      fusedScore: score,
      scoreWeight: weight,
      source: "chunk",
      sourceKind: isDocumentChunk(meta.path) ? "document" : "chunk",
    });
  }

  // Hydrate memory-side. Memories don't have path/heading/file_mtime_ms,
  // so we synthesize values that keep downstream rendering and the
  // time-window filter both happy:
  //   - path: "memory:<id>". Synthetic memory: paths trivially fail the
  //     standing-path check, so the file_mtime_ms gate decides. We pass
  //     `now` as file_mtime_ms (memories are always "fresh"; their own
  //     importance x recency decay already ran in the combined rank) so the
  //     hard cutoff always passes and the soft factor is 1.
  //   - heading: null. The renderer falls back to the path.
  //   - score_weight: 0, no path-derived nudge for memories.
  // The excluded-tag filter already ran before fusion, so every id here is
  // allowed and its row is in the hydration cache.
  for (const f of memoriesFused) {
    const meta = hydrateMemory(f.chunk_id);
    if (!meta) continue;
    hydrated.push({
      chunkId: f.chunk_id,
      path: `memory:${f.chunk_id}`,
      heading: null,
      body: meta.content,
      file_mtime_ms: now,
      fusedScore: f.score,
      scoreWeight: 0,
      source: "memory",
      sourceKind: "memory",
      createdAt: meta.created_at,
    });
  }
  // Phase 115 sub-scope 4: operator-visible diagnostic when the filter
  // drops one or more rows. Helps operators spot when an agent's
  // pollution-feedback memories are being suppressed (good signal: filter
  // is doing work) vs always at zero (filter inactive). Two channels:
  //   1. console.info, fires unconditionally in production. Daemon
  //      captures stdout into structured logs via systemd. Mirrors the
  //      T01 phase115-quickwin pattern (session-adapter.ts).
  //   2. args.log?.debug?.(), optional sink injected by tests via vi.fn()
  //      (and by future operator-facing surfaces that want structured
  //      access without grep on stdout).
  const memTagDroppedCount = droppedMemoryIds.size;
  if (memTagDroppedCount > 0) {
    const payload = {
      action: "phase115-tag-filter",
      agent: args.agent,
      dropped: memTagDroppedCount,
      excludeTags: [...excludeTags],
    };
    console.info("phase115-tag-filter", JSON.stringify(payload));
    args.log?.debug?.(payload, "phase115-tag-filter dropped memories");
  }

  // WP2 (c): the hard window is opt-in; the soft factor already ran at
  // hydration time and drops nothing.
  const windowed: Hydrated[] =
    timeWindowMode === "hard" ? [...applyTimeWindowFilter(hydrated, windowDays, now)] : hydrated;
  windowed.sort((a: Hydrated, b: Hydrated) => b.fusedScore - a.fusedScore);

  // Phase 999.43 Plan 03 Task 2, D-02 priority weighting for
  // `document:` prefix candidates BEFORE the optional reranker gate.
  // When `documentPriority` is omitted (legacy callers, tests) the
  // pipeline runs unchanged. When present, document candidates are
  // scaled by agentWeight x contentWeight x recencyBoost and re-sorted
  // so pre-rerank rank reflects priority. The reranker (next step) then
  // operates on the priority-weighted ordering; reranker logic itself
  // is unchanged (Phase 101 Plan 04 invariant honored).
  let prioritized: Hydrated[] = windowed;
  if (args.documentPriority) {
    const weighted = applyDocumentPriorityWeight<Hydrated>(windowed, {
      getDocumentRow: args.documentPriority.getDocumentRow,
      agentWeight: args.documentPriority.agentWeight,
      // Quick-260521-437: thread the operator-tunable recency window
      // through; undefined falls back to the legacy 7-day window inside
      // applyDocumentPriorityWeight.
      recencyWindowMs: args.documentPriority.recencyWindowMs,
      now,
    });
    // The weighted entries carry an extra `weightedFused` field; sort by
    // it DESC then strip it back to plain Hydrated for the downstream
    // pipeline (Hydrated.fusedScore stays at its RRF value so the
    // returned MemoryRetrievalResult.fusedScore semantics don't shift).
    const sorted = [...weighted].sort(
      (a, b) => (b.weightedFused ?? 0) - (a.weightedFused ?? 0),
    );
    prioritized = sorted.map(({ weightedFused: _drop, ...rest }) => rest);
  }

  // Phase 101 Plan 04 (D-04, U9, SC-10): optional bge-reranker-base
  // cross-encoder pass applied to the RRF-sorted set BEFORE the
  // token-budget loop. Takes `reranker.topNToRerank` candidates,
  // re-scores via `(query, passage)` pairs, returns the top
  // `reranker.finalTopK` in rerank-order. The downstream token-budget +
  // topK cap then runs over this reordered list, so a more-relevant
  // candidate that was rank 6 under raw RRF can surface into the kept
  // set when rerank elevates it to top-5.
  //
  // Graceful degradation: `rerankTop` handles its own timeout + error
  // fallback (returns the original-order slice) so this code path never
  // throws even if the ONNX runtime crashes. The off-switch path
  // (`reranker.enabled === false` or `reranker` omitted) preserves the
  // pre-101-04 behavior exactly.
  let postRerank: Hydrated[] = prioritized;
  if (args.reranker && args.reranker.enabled && prioritized.length > 0) {
    const candidates = prioritized.slice(0, args.reranker.topNToRerank);
    const reranked = await rerankTop<Hydrated>(query, candidates, {
      topK: Math.min(args.reranker.finalTopK, candidates.length),
      timeoutMs: args.reranker.timeoutMs,
      logger: args.reranker.logger,
      rerankFn: args.reranker.rerankFn,
      getText: (h) => h.body,
    });
    postRerank = [...reranked];
  }

  // Quick-260521-437: document-chunk cap. Stops one cross-ingested
  // image/document dump (which can flood `memory_chunks` with dozens of
  // `document:`-prefixed chunks, each priority-weighted ~2.9x) from
  // dominating every subsequent turn's `<memory-context>` block.
  //
  // Runs AFTER the reranker (so it operates on the actually-emitted
  // ordering) and BEFORE the token-budget loop + topK slice (so a dropped
  // high-ranked document chunk frees a slot for a lower-ranked NON-document
  // chunk to reach the topK window: eviction-with-replacement, not bare
  // trimming). The cap is an UPPER BOUND, never a quota: a retrieval whose
  // only candidates are document chunks still returns them up to the cap,
  // so document searchability is preserved. Fail-open: when the cap is
  // undefined or <= 0 the pass is skipped and behavior is unchanged.
  let capped: Hydrated[] = postRerank;
  if (args.documentChunkCap !== undefined && args.documentChunkCap > 0) {
    const cap = args.documentChunkCap;
    let documentKept = 0;
    capped = postRerank.filter((h) => {
      if (!isDocumentChunk(h.path)) return true;
      if (documentKept < cap) {
        documentKept += 1;
        return true;
      }
      return false;
    });
  }

  // Token budget truncation. ~4 chars/token. WP2 (f): a candidate that
  // would push cumulative body chars past budget*4 is SKIPPED and the loop
  // keeps filling from the next candidates until topK results are emitted,
  // instead of breaking at the first oversize one (which let a single large
  // top-ranked chunk evict every smaller relevant chunk behind it). The
  // first candidate is always emitted so the caller never gets an empty
  // block just because the best hit is big. Applied across BOTH surfaces
  // (chunks + memories) so a flood of large memories can't blow the budget.
  const out: MemoryRetrievalResult[] = [];
  let acc = 0;
  const maxChars = tokenBudget * 4;
  for (const h of capped) {
    if (out.length >= topK) break;
    const len = h.body.length;
    if (out.length > 0 && acc + len > maxChars) continue;
    out.push(
      Object.freeze({
        chunkId: h.chunkId,
        path: h.path,
        heading: h.heading,
        body: h.body,
        fusedScore: h.fusedScore,
        scoreWeight: h.scoreWeight,
        source: h.source,
        sourceKind: h.sourceKind,
        ...(h.createdAt ? { createdAt: h.createdAt } : {}),
        ...(h.source === "chunk" ? { fileMtimeMs: h.file_mtime_ms } : {}),
      }),
    );
    acc += len;
  }

  // Phase 999.119: the memories that actually reach the prompt count as
  // USED: touch accessed_at (not access_count, see
  // MemoryStore.touchAccessedAt) so the relevance-decay clock that drives
  // cold-tiering is reset by real use instead of by age alone. Best-effort
  // and guarded: test doubles for `store` do not implement it.
  const usedMemoryIds = out
    .filter((h) => h.source === "memory")
    .map((h) => h.chunkId);
  if (
    usedMemoryIds.length > 0 &&
    typeof (args.store as { touchAccessedAt?: unknown }).touchAccessedAt === "function"
  ) {
    try {
      args.store.touchAccessedAt(usedMemoryIds, new Date(now).toISOString());
    } catch {
      /* never let bookkeeping fail a retrieval */
    }
  }
  return Object.freeze(out);
}
