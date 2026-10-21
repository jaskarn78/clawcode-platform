/**
 * TraceStore — SQLite-backed per-agent trace store.
 *
 * Mirrors the `src/usage/tracker.ts` structure: synchronous better-sqlite3,
 * prepared statements, WAL mode, Object.freeze on returned records.
 *
 * Two tables are maintained:
 *   - `traces`      — one row per turn (id, agent, started_at, ended_at,
 *                     total_ms, discord_channel_id, status)
 *   - `trace_spans` — many rows per turn (turn_id, name, started_at,
 *                     duration_ms, metadata_json); linked to `traces.id`
 *                     via ON DELETE CASCADE so retention deletes at the
 *                     parent level alone (see 50-RESEARCH.md pitfall 4).
 *
 * SECURITY: `metadata_json` stores small payloads only (tool name, content
 * length, model). NEVER prompt bodies or message contents. The serialized
 * JSON is capped at 1000 characters per span; longer payloads are
 * truncated with a trailing `...` sentinel (see 50-RESEARCH.md pitfall 5).
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType, Statement } from "better-sqlite3";

import {
  CANONICAL_SEGMENTS,
  TraceStoreError,
  type CacheTelemetryReport,
  type CacheTrendPoint,
  type CanonicalSegment,
  type PercentileRow,
  type ToolPercentileRow,
  type ToolCallSpanRow,
  type TurnRecord,
} from "./types.js";
// Phase 57 Plan 02: the `turn_origin` column stores a serialized TurnOrigin
// as JSON text. TurnOrigin is defined on TurnRecord (see types.ts) and flows
// through writeTurn's JSON.stringify. Consumers of the raw row revalidate via
// TurnOriginSchema in src/manager/turn-origin.ts (Phase 63 trace walker).
import type { TurnOrigin } from "../manager/turn-origin.js";
import { PERCENTILE_SQL } from "./percentiles.js";

/** Maximum length of the serialized metadata JSON per span. */
const METADATA_JSON_MAX_LEN = 1000;

/** Prepared statements used by the TraceStore. */
type PreparedStatements = {
  readonly insertTrace: Statement;
  readonly insertSpan: Statement;
  readonly deleteOlderThan: Statement;
  readonly percentiles: Statement;
  readonly perToolPercentiles: Statement;
  readonly cacheTelemetryRows: Statement;
  readonly cacheTelemetryAggregates: Statement;
  readonly cacheTelemetryTrend: Statement;
  readonly cacheEffectStats: Statement;
  // Phase 115 Plan 05 T03 — D-05 priority dream-pass trigger.
  readonly insertTier1TruncationEvent: Statement;
  readonly countTier1TruncationEventsSince: Statement;
  // Phase 115 Plan 08 T02 — sub-scope 6-A measurement gate.
  readonly countTotalTurnsInWindow: Statement;
  readonly countTurnsWithToolsInWindow: Statement;
  readonly insertToolUseRateSnapshot: Statement;
  readonly latestToolUseRateSnapshot: Statement;
  // Phase 116-06 T01 — F18/F22 activity heatmap. One row per
  // (date, agent) bucket within [since, now], turn count per bucket.
  readonly activityByDay: Statement;
  // Phase 116-postdeploy 2026-05-12 — F03 tile 24h sparkline. One row
  // per (hour-of-day) bucket within [since, now] for a single agent.
  // The Skeleton placeholder on the tile (shipped with Phase 116-01,
  // commented "lands with the drawer in 116-04") is finally being
  // replaced — the drawer landed without an hourly endpoint, so this
  // ships standalone.
  readonly activityByHour: Statement;
  // Phase 116-postdeploy 2026-05-12 — main-dashboard tile sort. Single-row
  // summary of turn count + last-turn timestamp for a single agent within
  // a sliding window. The handler iterates every running agent and asks
  // the per-agent traces.db for one summary row, so the query needs to be
  // a single COUNT() + MAX() round-trip (no row materialisation).
  readonly turnSummarySince: Statement;
  // Phase 132-fu T01 — per-turn tool-call trajectory reader.
  // Single-turn scope: returns ordered `tool_call.<name>` rows for one
  // `traces.id`. Strips the prefix at the SQL layer (SUBSTR(name, 11))
  // so consumers see just the tool name.
  readonly toolCallSpansForTurn: Statement;
  // Phase 132-fu T02 — single-turn total_ms lookup. Used together with
  // toolCallSpansForTurn to assemble the {trajectory, durationMs} shape
  // emitted to the Phase 132 skill distiller's eligibility filter.
  readonly traceTotalMsForTurn: Statement;
  // Phase 132-fu T06 — agent-window tool-call aggregation across many
  // turns. Used by SessionManager.getTrajectoryForSubagent for the
  // multi-turn subagent-session case where a single binding spans
  // multiple Discord message-reply turns.
  readonly toolCallSpansForAgentWindow: Statement;
};

/**
 * Phase 52 Plan 03: raw row shape for the cache-effect first-token query.
 *
 * AVG returns NULL when the CASE WHEN filter yields no matching rows — we
 * surface that as a `null` field so the caller can decide whether the window
 * has enough signal (eligibleTurns >= 20) to compute a delta.
 */
type CacheEffectRawRow = {
  readonly hit_avg_ms: number | null;
  readonly miss_avg_ms: number | null;
  readonly eligible_turns: number | null;
};

/**
 * Phase 52 Plan 03: cache-effect first-token stats for the `cache_effect_ms`
 * metric surfaced on the `clawcode cache` CLI and dashboard Prompt Cache
 * panel. Both averages are `null` when the window has no eligible turns on
 * that side (e.g. no cache-hit turns yet). `eligibleTurns` is the count of
 * turns that had a `first_token` span AND non-NULL `cache_read_input_tokens`.
 *
 * Callers (daemon.ts computeCacheEffectMs) MUST gate on `eligibleTurns >= 20`
 * before computing `hitAvgMs - missAvgMs` — 20 is the noise floor per
 * CONTEXT D-05.
 */
export type CacheEffectStats = {
  readonly hitAvgMs: number | null;
  readonly missAvgMs: number | null;
  readonly eligibleTurns: number;
};

/** Raw row shape from the PERCENTILE_SQL query. */
type PercentileRawRow = {
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly count: number | null;
};

/**
 * Phase 115 Plan 00 — row shape exposing the six new column slots opened on
 * the `traces` table by `migrateSchema()`. Each field is OPTIONAL because
 * Plan 115-00 does not yet wire writes — Plans 115-02, 115-05, and 115-07
 * land the producers. Today every row in production reads NULL on all six.
 *
 * Exported so that downstream Phase 115 plans (and their tests) can declare
 * row-shape expectations without re-deriving the column list.
 *
 * Field ↔ producer mapping:
 *   - tier1_inject_chars            → Plan 115-02 (sub-scope 1 Tier 1 cap)
 *   - tier1_budget_pct              → Plan 115-02 (sub-scope 1 utilization)
 *   - tool_cache_hit_rate           → Plan 115-07 (sub-scope 15 tool cache)
 *   - tool_cache_size_mb            → Plan 115-07 (sub-scope 15 size telemetry)
 *   - lazy_recall_call_count        → Plan 115-05 (sub-scope 7 lazy recall)
 *   - prompt_bloat_warnings_24h     → Plan 115-02 (sub-scope 13 observability)
 *
 * The TypeScript camelCase form is mirrored on `TurnRecord` in
 * `src/performance/types.ts` so writers compose a turn record with these
 * fields named consistently with the rest of the schema.
 */
export type Phase115TurnColumns = {
  readonly tier1_inject_chars?: number | null;
  readonly tier1_budget_pct?: number | null;
  readonly tool_cache_hit_rate?: number | null;
  readonly tool_cache_size_mb?: number | null;
  readonly lazy_recall_call_count?: number | null;
  readonly prompt_bloat_warnings_24h?: number | null;
  // Phase 115 Plan 08 T01 — tool-latency methodology audit (sub-scope 17a/b).
  readonly tool_execution_ms?: number | null;
  readonly tool_roundtrip_ms?: number | null;
  readonly parallel_tool_call_count?: number | null;
};

/**
 * Phase 115 Plan 08 T02 — sub-scope 6-A measurement gate row.
 *
 * One snapshot per agent per computation window. The gate decision in
 * plan 115-09 reads the fleet non-fin-client average of `rate` over a 24h
 * window and SHIPs sub-scope 6-B (1h-TTL direct-SDK fast-path) when
 * the average is below the 0.30 starting threshold (CONTEXT D-12).
 *
 * Snapshots accumulate in a separate table — they are NOT back-written
 * to a turn row — so the metric is independent of turn cadence. Old
 * snapshots are unread by gate queries using `computed_at >= now - 24h`
 * and pruned at the same retention cadence as the parent traces.db
 * (operator-runnable cleanup; never auto-deleted on the dispatch path).
 */
export type ToolUseRateSnapshot = {
  readonly agent: string;
  readonly computedAt: number;       // epoch ms
  readonly windowHours: number;      // e.g., 24
  readonly turnsTotal: number;
  readonly turnsWithTools: number;
  readonly rate: number;             // turnsWithTools / max(turnsTotal, 1)
};

/** Raw row shape for cache-telemetry per-turn query. */
type CacheTelemetryRow = {
  readonly cache_read_input_tokens: number | null;
  readonly cache_creation_input_tokens: number | null;
  readonly input_tokens: number | null;
};

/** Raw row shape for cache-telemetry aggregate sums. */
type CacheTelemetryAggregateRow = {
  readonly total_cache_reads: number | null;
  readonly total_cache_writes: number | null;
  readonly total_input_tokens: number | null;
  readonly total_turns: number | null;
};

/** Raw row shape for cache-telemetry per-day trend query. */
type CacheTelemetryTrendRow = {
  readonly date: string;
  readonly turns: number;
  readonly sum_read: number;
  readonly sum_creation: number;
  readonly sum_input: number;
};

/**
 * TraceStore wraps a single per-agent `traces.db` SQLite file.
 *
 * Write volume is high-frequency but not high-throughput: one transaction
 * per turn (not per span). See 50-RESEARCH.md pitfall 5 for rationale.
 */
export class TraceStore {
  private readonly db: DatabaseType;
  private readonly stmts: PreparedStatements;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    try {
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("synchronous = NORMAL");
      this.db.pragma("foreign_keys = ON");

      this.initSchema();
      this.migrateSchema();
      this.stmts = this.prepareStatements();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(`open failed: ${msg}`, dbPath);
    }
  }

  /**
   * Phase 56 Plan 01 — expose the underlying database for READ-ONLY warmup
   * queries (AgentMemoryManager.warmSqliteStores). Do not use for writes —
   * go through writeTurn/pruneOlderThan instead.
   */
  getDatabase(): DatabaseType {
    return this.db;
  }

  /**
   * Persist a complete turn record: one row in `traces` + N rows in
   * `trace_spans`, all inside a single transaction.
   *
   * Uses INSERT OR REPLACE on `traces` to handle Discord message redelivery
   * (see 50-RESEARCH.md pitfall 1) — the latter write wins, and CASCADE
   * drops stale spans before the new ones are inserted.
   */
  writeTurn(turn: TurnRecord): void {
    try {
      const tx = this.db.transaction((t: TurnRecord) => {
        // Phase 52 Plan 01: cache telemetry columns are OPTIONAL on TurnRecord.
        // Pass `?? null` so older callers (Phase 50 turns) land NULL in those
        // columns and remain queryable. `cache_eviction_expected` is a boolean
        // stored as 0/1 INTEGER (SQLite convention).
        //
        // Phase 57 Plan 02: `turn_origin` is an OPTIONAL JSON blob. When present,
        // it round-trips through TurnOriginSchema.parse. When absent, column is
        // NULL — legacy Phase 50/51/52 callers that do not go through
        // TurnDispatcher remain queryable.
        this.stmts.insertTrace.run(
          t.id,
          t.agent,
          t.startedAt,
          t.endedAt,
          t.totalMs,
          t.channelId,
          t.status,
          t.cacheReadInputTokens ?? null,
          t.cacheCreationInputTokens ?? null,
          t.inputTokens ?? null,
          t.prefixHash ?? null,
          t.cacheEvictionExpected === undefined
            ? null
            : t.cacheEvictionExpected
              ? 1
              : 0,
          t.turnOrigin ? JSON.stringify(t.turnOrigin) : null, // Phase 57 Plan 02
          // Phase 115 Plan 05 T04: lazy_recall_call_count. Producer optional
          // — turns that never invoked a clawcode_memory_* tool land NULL.
          t.lazyRecallCallCount ?? null,
          // Phase 115 Plan 07 T03: tool_cache_hit_rate + tool_cache_size_mb.
          // Producer optional — turns with zero cache-eligible tool calls
          // land NULL on hit_rate. Size_mb is sampled by the periodic
          // dashboard reporter (T04) and may be NULL on most turns.
          t.toolCacheHitRate ?? null,
          t.toolCacheSizeMb ?? null,
          // Phase 115 Plan 08 T01: tool_execution_ms + tool_roundtrip_ms +
          // parallel_tool_call_count. Producer optional — turns with no
          // tool_use blocks land NULL on all three.
          t.toolExecutionMs ?? null,
          t.toolRoundtripMs ?? null,
          t.parallelToolCallCount ?? null,
          // Phase 115 post-deploy patch (2026-05-08): tier1_inject_chars +
          // tier1_budget_pct + prompt_bloat_warnings_24h. Bootstrap-turn
          // producer (assembleContextTraced) records tier1 size after the
          // bounded-tier identity assembly fires; classifier sink records
          // prompt-bloat warnings after each `[diag] likely-prompt-bloat`.
          // Producer optional — non-bootstrap turns and turns with no
          // bloat warnings land NULL on all three (the dashboard treats
          // NULL as "no signal this turn").
          t.tier1InjectChars ?? null,
          t.tier1BudgetPct ?? null,
          t.promptBloatWarnings24h ?? null,
        );
        for (const span of t.spans) {
          this.stmts.insertSpan.run(
            t.id,
            span.name,
            span.startedAt,
            span.durationMs,
            serializeMetadata(span.metadata),
          );
        }
      });
      tx(turn);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(`writeTurn failed: ${msg}`, this.dbPath);
    }
  }

  /**
   * Delete all turns with `started_at < cutoffIso`. Child spans are removed
   * automatically via ON DELETE CASCADE — no secondary cleanup query.
   *
   * @returns Number of trace rows deleted (spans cascade).
   */
  pruneOlderThan(cutoffIso: string): number {
    try {
      const result = this.stmts.deleteOlderThan.run({ cutoff: cutoffIso });
      return Number(result.changes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(`pruneOlderThan failed: ${msg}`, this.dbPath);
    }
  }

  /**
   * Compute p50/p95/p99/count for each canonical segment within the window.
   *
   * Returns one frozen row per entry in `CANONICAL_SEGMENTS` (6 rows as of
   * Phase 54 — was 4 pre-Phase-54). When a segment has no matching spans in
   * the window, its p-values are `null` and `count` is `0`.
   */
  getPercentiles(agent: string, sinceIso: string): readonly PercentileRow[] {
    try {
      const rows: PercentileRow[] = CANONICAL_SEGMENTS.map((segment: CanonicalSegment) => {
        const raw = this.stmts.percentiles.get({
          agent,
          since: sinceIso,
          span_name: segment,
        }) as PercentileRawRow | undefined;
        const count = raw && typeof raw.count === "number" ? raw.count : 0;
        return Object.freeze({
          segment,
          p50: count > 0 ? (raw?.p50 ?? null) : null,
          p95: count > 0 ? (raw?.p95 ?? null) : null,
          p99: count > 0 ? (raw?.p99 ?? null) : null,
          count,
        });
      });
      return Object.freeze(rows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(`getPercentiles failed: ${msg}`, this.dbPath);
    }
  }

  /**
   * Phase 54 — convenience wrapper over `getPercentiles` filtered to just the
   * `first_token` row. Powers the CLI / dashboard First Token headline card
   * (Plan 54-04) without forcing every caller to find-and-filter the full
   * 6-row percentile array.
   *
   * Returns exactly one frozen `PercentileRow`. When the window contains no
   * `first_token` spans, returns a count=0 / null-p-value row so the caller
   * can render "no_data" without a null-check ladder.
   */
  getFirstTokenPercentiles(
    agent: string,
    sinceIso: string,
  ): PercentileRow {
    const rows = this.getPercentiles(agent, sinceIso);
    const row = rows.find((r) => r.segment === "first_token");
    if (row) return row;
    return Object.freeze<PercentileRow>({
      segment: "first_token",
      p50: null,
      p95: null,
      p99: null,
      count: 0,
    });
  }

  /**
   * Phase 55 — per-tool percentile aggregation.
   *
   * Groups `trace_spans` rows by span name, filtered to `name LIKE 'tool_call.%'`,
   * extracts the tool name via `SUBSTR(name, 11)` (strips the canonical
   * `tool_call.` prefix — 11 characters including the trailing dot), and
   * computes p50/p95/p99/count per tool using the same nearest-rank approach
   * as `PERCENTILE_SQL`.
   *
   * Returns one frozen `ToolPercentileRow` per distinct tool observed in the
   * window, sorted by p95 DESC (nulls last) at the SQL layer. CLI + dashboard
   * consumers render the resulting list verbatim to highlight the slowest
   * tool at the top without a client-side re-sort.
   *
   * Empty window returns `[]` (not an error, not a sentinel row).
   */
  getToolPercentiles(
    agent: string,
    sinceIso: string,
  ): readonly ToolPercentileRow[] {
    try {
      const rows = this.stmts.perToolPercentiles.all({
        agent,
        since: sinceIso,
      }) as ReadonlyArray<{
        readonly tool_name: string;
        readonly p50: number | null;
        readonly p95: number | null;
        readonly p99: number | null;
        readonly count: number;
      }>;
      return Object.freeze(
        rows.map((r) =>
          Object.freeze<ToolPercentileRow>({
            tool_name: r.tool_name,
            p50: r.p50,
            p95: r.p95,
            p99: r.p99,
            count: r.count,
          }),
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `getToolPercentiles failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 132-fu T01 — return the ordered tool-call trajectory for a single
   * turn (`traces.id`).
   *
   * Used by `SessionManager.getTrajectoryForTurnId` to feed the
   * `TaskCompletedEvent.trajectory` field consumed by the Phase 132 skill
   * distiller. Replaces the empty-trajectory stub at the two daemon emit
   * sites (subagent-complete + delegate-task) — TraceStore is the only
   * production-side source-of-truth for per-turn tool-call names.
   *
   * Returns frozen `[]` when the turn id has no trace row (e.g. turn not yet
   * flushed, or the agent has no TraceStore writes for this turn id). Empty
   * is also returned when the turn ran zero tool calls — both cases collapse
   * to the same eligibility-filter outcome (too-few-tool-calls) which is
   * correct.
   *
   * Timestamp conversion: `started_at` is an ISO 8601 string in the schema;
   * we parse via `Date.parse` and fall back to `0` on parse failure. The
   * downstream consumer (skill distiller fingerprinter + eligibility filter)
   * only cares about tool ORDER + COUNT — never wall-clock — so a `0` fallback
   * is safe.
   */
  getToolCallSpansForTurn(turnId: string): readonly ToolCallSpanRow[] {
    try {
      const rows = this.stmts.toolCallSpansForTurn.all(turnId) as ReadonlyArray<{
        readonly tool: string;
        readonly started_at: string;
      }>;
      return Object.freeze(
        rows.map((r) => {
          const parsed = Date.parse(r.started_at);
          return Object.freeze<ToolCallSpanRow>({
            tool: r.tool,
            ts: Number.isFinite(parsed) ? parsed : 0,
          });
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `getToolCallSpansForTurn failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 132-fu T02 — return the `total_ms` value stored on the `traces`
   * row for a single turn.
   *
   * `total_ms` is computed by `trace-collector.ts` at `Turn.end()` as
   * `endedAt - startedAt` (in milliseconds) — verbatim wall-clock for the
   * agent turn. Used by `SessionManager.getTrajectoryForTurnId` to populate
   * `TaskCompletedEvent.durationMs`, which the Phase 132 eligibility filter
   * compares against `minDurationMs` (D-03 default 180_000ms = 3 min).
   *
   * Returns `undefined` when the trace row is missing (turn not yet flushed,
   * or never recorded). Callers translate `undefined` to the safe default
   * (`durationMs: 0`), which surfaces as a `too-short-duration` rejection
   * at the eligibility filter — correct behavior for the no-data case.
   */
  getTraceTotalMsForTurn(turnId: string): number | undefined {
    try {
      const row = this.stmts.traceTotalMsForTurn.get(turnId) as
        | { readonly total_ms: number }
        | undefined;
      return row?.total_ms;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `getTraceTotalMsForTurn failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 132-fu T06 — return the ordered tool-call trajectory for an
   * AGENT over a `(sinceIso, untilIso)` time window.
   *
   * Multi-turn case: a single subagent session (binding) spans multiple
   * Discord message-reply turns inside the thread. Each message is its
   * own `traces` row keyed by `discord:<snowflake>`. Per-turn lookup
   * (`getToolCallSpansForTurn`) misses cross-turn sequences.
   *
   * Filters by `t.agent = agent` AND `t.started_at` ∈ [since, until],
   * then projects all `tool_call.*` spans inside the matched traces.
   * Order: trace started_at ASC, span started_at ASC, rowid ASC tie-break
   * — preserves invocation order across multiple turns and same-ms inserts.
   *
   * Used by `SessionManager.getTrajectoryForSubagent` to assemble the
   * trajectory for a subagent at relay-completion time. `since` is the
   * binding's `createdAt`; `until` is the binding's `completedAt`
   * (both ms-epoch from ThreadBinding). The accessor converts to ISO
   * via `new Date(ms).toISOString()` before passing in — the schema
   * stores `started_at` as ISO 8601 strings, and string comparison
   * is chronologically valid for that format.
   *
   * Empty window or unknown agent returns frozen `[]`.
   */
  getToolCallSpansForAgentWindow(
    agent: string,
    sinceIso: string,
    untilIso: string,
  ): readonly ToolCallSpanRow[] {
    try {
      const rows = this.stmts.toolCallSpansForAgentWindow.all({
        agent,
        since: sinceIso,
        until: untilIso,
      }) as ReadonlyArray<{
        readonly tool: string;
        readonly started_at: string;
      }>;
      return Object.freeze(
        rows.map((r) => {
          const parsed = Date.parse(r.started_at);
          return Object.freeze<ToolCallSpanRow>({
            tool: r.tool,
            ts: Number.isFinite(parsed) ? parsed : 0,
          });
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `getToolCallSpansForAgentWindow failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /**
   * Compute the cache-telemetry report for `agent` over the `sinceIso` window.
   *
   * Hit-rate formula (Phase 52 D-01):
   *   hit_rate = cache_read / (cache_read + cache_creation + input)
   *
   * Skip rules:
   *   - WHERE `input_tokens IS NOT NULL AND input_tokens > 0` — excludes both
   *     Phase 50 legacy turns (NULL) and warm-up turns (0). This is what
   *     separates cache-aware turns from pre-Phase-52 rows.
   *   - Empty result window returns a zero-filled report with no exceptions.
   *
   * Percentile math mirrors `PERCENTILE_SQL`'s nearest-rank approach, but is
   * computed in JS here because the per-turn hit rate is a derived float and
   * SQLite cannot index-order expressions across windowed aggregates cleanly.
   * N at agent scale is small (tens of thousands across retention), so a
   * single ORDER-BY pass + sort is cheaper than a ROW_NUMBER subquery.
   */
  getCacheTelemetry(agent: string, sinceIso: string): CacheTelemetryReport {
    try {
      const rows = this.stmts.cacheTelemetryRows.all({
        agent,
        since: sinceIso,
      }) as readonly CacheTelemetryRow[];

      if (rows.length === 0) {
        return Object.freeze<CacheTelemetryReport>({
          agent,
          since: sinceIso,
          totalTurns: 0,
          avgHitRate: 0,
          p50HitRate: 0,
          p95HitRate: 0,
          totalCacheReads: 0,
          totalCacheWrites: 0,
          totalInputTokens: 0,
          trendByDay: Object.freeze([]),
        });
      }

      // Compute per-turn hit rates (guarded by the SQL WHERE input_tokens > 0).
      const hitRates = rows
        .map((r) => {
          const read = r.cache_read_input_tokens ?? 0;
          const creation = r.cache_creation_input_tokens ?? 0;
          const input = r.input_tokens ?? 0;
          const denominator = read + creation + input;
          return denominator > 0 ? read / denominator : 0;
        })
        .sort((a, b) => a - b);

      const totalTurns = hitRates.length;
      const sum = hitRates.reduce((acc, v) => acc + v, 0);
      const avgHitRate = sum / totalTurns;

      // Nearest-rank: index = floor(N * p), clamped to [0, N-1].
      const p50Idx = Math.min(Math.floor(totalTurns * 0.5), totalTurns - 1);
      const p95Idx = Math.min(Math.floor(totalTurns * 0.95), totalTurns - 1);
      const p50HitRate = hitRates[p50Idx] ?? 0;
      const p95HitRate = hitRates[p95Idx] ?? 0;

      // Aggregate sums over the same WHERE window.
      const agg = this.stmts.cacheTelemetryAggregates.get({
        agent,
        since: sinceIso,
      }) as CacheTelemetryAggregateRow | undefined;

      const totalCacheReads = agg?.total_cache_reads ?? 0;
      const totalCacheWrites = agg?.total_cache_writes ?? 0;
      const totalInputTokens = agg?.total_input_tokens ?? 0;

      // Per-day trend: SUM tokens per YYYY-MM-DD bucket, compute hitRate per day.
      const trendRows = this.stmts.cacheTelemetryTrend.all({
        agent,
        since: sinceIso,
      }) as readonly CacheTelemetryTrendRow[];

      const trendByDay: readonly CacheTrendPoint[] = Object.freeze(
        trendRows.map((t) => {
          const denominator = t.sum_read + t.sum_creation + t.sum_input;
          const hitRate = denominator > 0 ? t.sum_read / denominator : 0;
          return Object.freeze<CacheTrendPoint>({
            date: t.date,
            turns: t.turns,
            hitRate,
          });
        }),
      );

      return Object.freeze<CacheTelemetryReport>({
        agent,
        since: sinceIso,
        totalTurns,
        avgHitRate,
        p50HitRate,
        p95HitRate,
        totalCacheReads,
        totalCacheWrites,
        totalInputTokens,
        trendByDay,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `getCacheTelemetry failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 115 Plan 07 T04 — aggregate tool-cache telemetry over the
   * agent + since window. Returns:
   *   - avgToolCacheHitRate — average of `tool_cache_hit_rate` across turns
   *     that wrote a non-null value (turns with cache events).
   *   - avgToolCacheSizeMb — average of the `tool_cache_size_mb` samples.
   *   - turnsWithCacheEvents — count of turns that had ≥1 cache event.
   *
   * NULL avgToolCacheHitRate bubbles up when no turns had cache events
   * (e.g., the cache hasn't been exercised yet, or the agent's tools are
   * all no-cache/zero-TTL types). Dashboard renders "—" in that case.
   */
  getToolCacheTelemetry(
    agent: string,
    sinceIso: string,
  ): {
    readonly avgToolCacheHitRate: number | null;
    readonly avgToolCacheSizeMb: number | null;
    readonly turnsWithCacheEvents: number;
  } {
    try {
      const row = this.db
        .prepare(
          `SELECT
             AVG(tool_cache_hit_rate) AS avg_hit_rate,
             AVG(tool_cache_size_mb)  AS avg_size_mb,
             COUNT(tool_cache_hit_rate) AS turns_with_events
           FROM traces
           WHERE agent = @agent
             AND started_at >= @since
             AND tool_cache_hit_rate IS NOT NULL`,
        )
        .get({ agent, since: sinceIso }) as
        | {
            avg_hit_rate: number | null;
            avg_size_mb: number | null;
            turns_with_events: number;
          }
        | undefined;
      return Object.freeze({
        avgToolCacheHitRate: row?.avg_hit_rate ?? null,
        avgToolCacheSizeMb: row?.avg_size_mb ?? null,
        turnsWithCacheEvents: row?.turns_with_events ?? 0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `getToolCacheTelemetry failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 52 Plan 03: compute the cache-effect first-token stats for the
   * `cache_effect_ms` metric surfaced on the `clawcode cache` CLI and
   * dashboard Prompt Cache panel.
   *
   * Cross-joins `traces` (cache columns) with `trace_spans` (first_token
   * duration) over the same agent + since window. Splits the average
   * `first_token` duration by whether `cache_read_input_tokens > 0` (hit) or
   * `= 0` (miss). Returns both averages plus the total eligible-turn count.
   *
   * NULL averages bubble up when one side has no rows (e.g., a freshly
   * started agent with no cache-hit turns yet). The caller is responsible
   * for gating on `eligibleTurns >= 20` (CONTEXT D-05 noise floor) before
   * computing the `hitAvgMs - missAvgMs` delta.
   *
   * A negative delta (hit average < miss average) means the cache is
   * delivering first-token latency improvement — the expected signal.
   */
  getCacheEffectStats(agent: string, sinceIso: string): CacheEffectStats {
    try {
      const raw = this.stmts.cacheEffectStats.get({
        agent,
        since: sinceIso,
      }) as CacheEffectRawRow | undefined;

      if (!raw) {
        return Object.freeze<CacheEffectStats>({
          hitAvgMs: null,
          missAvgMs: null,
          eligibleTurns: 0,
        });
      }

      return Object.freeze<CacheEffectStats>({
        hitAvgMs:
          typeof raw.hit_avg_ms === "number" ? raw.hit_avg_ms : null,
        missAvgMs:
          typeof raw.miss_avg_ms === "number" ? raw.miss_avg_ms : null,
        eligibleTurns:
          typeof raw.eligible_turns === "number" ? raw.eligible_turns : 0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `getCacheEffectStats failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 115 Plan 09 T04 — sub-scope 16(c) dashboard surface aggregation.
   *
   * Aggregates the four Phase 115 metrics that the dashboard renders
   * alongside `tool_cache_hit_rate` (115-07) and the split-latency
   * fields (115-08):
   *   - latestTier1InjectChars      → most-recent value (NULL if no rows)
   *   - latestTier1BudgetPct        → most-recent value (NULL if no rows)
   *   - lazyRecallCalls24h          → SUM over the window (0 if no rows)
   *   - promptBloatWarnings24h      → SUM over the window (0 if no rows)
   *
   * "Most recent" semantics for tier1_*: the dashboard shows the live
   * state of the cap (was the LAST turn under or over budget?). A 24h
   * average obscures fresh problems. SUM semantics for lazy_recall +
   * prompt_bloat: those are event counts; aggregating them as a sum
   * over the window is the natural display (e.g., "12 lazy recall
   * tool calls in 24h").
   *
   * NULL bubble-up: tier1_* fields return NULL when no rows in the
   * window have non-NULL writes (e.g., agent newly started; 115-02
   * writes not yet wired in production). The dashboard renders "—".
   * Sum fields return 0 in the same situation — counts default to 0.
   *
   * @param agent agent label
   * @param sinceIso ISO 8601 lower bound (inclusive)
   * @returns frozen aggregate object
   */
  getPhase115DashboardMetrics(
    agent: string,
    sinceIso: string,
  ): {
    readonly latestTier1InjectChars: number | null;
    readonly latestTier1BudgetPct: number | null;
    readonly lazyRecallCalls24h: number;
    readonly promptBloatWarnings24h: number;
  } {
    try {
      // Single SELECT computes all four — cheaper than 4 round trips.
      // tier1_* via "ORDER BY started_at DESC LIMIT 1" semantics expressed
      // as a sub-select on the same window. lazy_recall + prompt_bloat
      // via SUM with COALESCE→0 so empty windows return 0 instead of NULL.
      const row = this.db
        .prepare(
          `SELECT
             (SELECT tier1_inject_chars
                FROM traces
                WHERE agent = @agent
                  AND started_at >= @since
                  AND tier1_inject_chars IS NOT NULL
                ORDER BY started_at DESC
                LIMIT 1)                                            AS latest_tier1_inject_chars,
             (SELECT tier1_budget_pct
                FROM traces
                WHERE agent = @agent
                  AND started_at >= @since
                  AND tier1_budget_pct IS NOT NULL
                ORDER BY started_at DESC
                LIMIT 1)                                            AS latest_tier1_budget_pct,
             COALESCE(SUM(lazy_recall_call_count), 0)               AS lazy_recall_calls,
             COALESCE(SUM(prompt_bloat_warnings_24h), 0)            AS prompt_bloat_warnings
           FROM traces
           WHERE agent = @agent
             AND started_at >= @since`,
        )
        .get({ agent, since: sinceIso }) as
        | {
            latest_tier1_inject_chars: number | null;
            latest_tier1_budget_pct: number | null;
            lazy_recall_calls: number;
            prompt_bloat_warnings: number;
          }
        | undefined;

      return Object.freeze({
        latestTier1InjectChars:
          typeof row?.latest_tier1_inject_chars === "number"
            ? row.latest_tier1_inject_chars
            : null,
        latestTier1BudgetPct:
          typeof row?.latest_tier1_budget_pct === "number"
            ? row.latest_tier1_budget_pct
            : null,
        lazyRecallCalls24h:
          typeof row?.lazy_recall_calls === "number"
            ? row.lazy_recall_calls
            : 0,
        promptBloatWarnings24h:
          typeof row?.prompt_bloat_warnings === "number"
            ? row.prompt_bloat_warnings
            : 0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `getPhase115DashboardMetrics failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }

  /**
   * Phase 52 Plan 01 + Phase 57 Plan 02 + Phase 115 Plan 00: idempotent ALTER TABLE
   * migration.
   *
   * Reads the existing `traces` columns via `PRAGMA table_info(traces)`, then
   * issues `ALTER TABLE ... ADD COLUMN` only for columns not already present.
   * This means repeated daemon restarts on an already-upgraded traces.db do
   * NOT throw "duplicate column" errors. Columns added in order:
   *   - cache_read_input_tokens       INTEGER (nullable)
   *   - cache_creation_input_tokens   INTEGER (nullable)
   *   - input_tokens                  INTEGER (nullable)
   *   - prefix_hash                   TEXT    (nullable — set by Plan 52-02)
   *   - cache_eviction_expected       INTEGER (nullable 0/1 — set by Plan 52-02)
   *   - turn_origin                   TEXT    (nullable JSON blob — Phase 57 Plan 02,
   *                                            populated by TurnDispatcher in Plan 57-03)
   *   - tier1_inject_chars            INTEGER (Phase 115 Plan 00 — column slot;
   *                                            writes wired by Plan 115-02)
   *   - tier1_budget_pct              REAL    (Phase 115 Plan 00 — column slot;
   *                                            writes wired by Plan 115-02)
   *   - tool_cache_hit_rate           REAL    (Phase 115 Plan 00 — column slot;
   *                                            writes wired by Plan 115-07)
   *   - tool_cache_size_mb            REAL    (Phase 115 Plan 00 — column slot;
   *                                            writes wired by Plan 115-07)
   *   - lazy_recall_call_count        INTEGER (Phase 115 Plan 00 — column slot;
   *                                            writes wired by Plan 115-05)
   *   - prompt_bloat_warnings_24h     INTEGER (Phase 115 Plan 00 — column slot;
   *                                            writes wired by Plan 115-02)
   *   - tool_execution_ms             INTEGER (Phase 115 Plan 08 T01 — sum of
   *                                            tool_call.<name> span durations;
   *                                            execution side of the split)
   *   - tool_roundtrip_ms             INTEGER (Phase 115 Plan 08 T01 — sum of
   *                                            per-batch wall-clock durations
   *                                            from tool_use emit to next
   *                                            parent-assistant message; the
   *                                            prompt-bloat-tax side)
   *   - parallel_tool_call_count      INTEGER (Phase 115 Plan 08 T01 — MAX
   *                                            parallel batch size across the
   *                                            turn; sub-scope 17(b))
   *
   * Phase 115 Plan 00 only opens the column slots — `writeTurn` is NOT extended
   * to write to them yet. This means existing daemons can re-run the migration
   * without producer changes, and 115-02 / 115-05 / 115-07 can ship their write
   * logic without shipping a migration of their own.
   *
   * SQLite's `ALTER TABLE ADD COLUMN` preserves existing row values (they land
   * NULL in the new columns) so Phase 50/51 turns remain queryable.
   */
  private migrateSchema(): void {
    const existing = new Set<string>(
      (
        this.db.prepare("PRAGMA table_info(traces)").all() as ReadonlyArray<{
          readonly name: string;
        }>
      ).map((r) => r.name),
    );
    const additions: ReadonlyArray<readonly [string, string]> = [
      ["cache_read_input_tokens", "INTEGER"],
      ["cache_creation_input_tokens", "INTEGER"],
      ["input_tokens", "INTEGER"],
      ["prefix_hash", "TEXT"],
      ["cache_eviction_expected", "INTEGER"],
      ["turn_origin", "TEXT"], // Phase 57 Plan 02 — nullable JSON blob
      // Phase 115 Plan 00 — column slots opened here so 115-02/05/07 can ship
      // their write paths without re-shipping migration code. All NULL on
      // legacy turns; readers MUST treat them as nullable.
      ["tier1_inject_chars", "INTEGER"],
      ["tier1_budget_pct", "REAL"],
      ["tool_cache_hit_rate", "REAL"],
      ["tool_cache_size_mb", "REAL"],
      ["lazy_recall_call_count", "INTEGER"],
      ["prompt_bloat_warnings_24h", "INTEGER"],
      // Phase 115 Plan 08 T01 — sub-scope 17(a)/(b) tool-latency methodology
      // audit. tool_execution_ms (sum of per-tool execution durations,
      // already captured by tool_call.<name> spans) and tool_roundtrip_ms
      // (full wall-clock between LLM emit-tool_use → next parent-assistant
      // message arrival; new measurement). Difference =
      // prompt-bloat-tax / LLM-resume cost. parallel_tool_call_count =
      // MAX parallel batch size across the turn (1 sequential, N parallel).
      // All NULL on legacy turns + turns with no tool_use blocks.
      // Idempotent — `PRAGMA table_info` guard above (line ~685) skips
      // any column already present, so this is the 3rd additive ALTER
      // landing (after 115-00 and 115-04 / 115-05 / 115-07). Re-runs of
      // `PRAGMA table_info` on re-opens never fire the ALTER because
      // the existing-set check above filters them out.
      ["tool_execution_ms", "INTEGER"],
      ["tool_roundtrip_ms", "INTEGER"],
      ["parallel_tool_call_count", "INTEGER"],
    ];
    for (const [col, type] of additions) {
      if (!existing.has(col)) {
        this.db.exec(`ALTER TABLE traces ADD COLUMN ${col} ${type}`);
      }
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        total_ms INTEGER NOT NULL,
        discord_channel_id TEXT,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trace_spans (
        turn_id TEXT NOT NULL,
        name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY(turn_id) REFERENCES traces(id) ON DELETE CASCADE
      );

      -- Phase 115 Plan 05 T03 — D-05 priority dream-pass trigger.
      -- Records each tier-1 truncation event (when MEMORY.md exceeded
      -- INJECTED_MEMORY_MAX_CHARS at session-config.ts assembly time and
      -- the 70/20 head-tail truncation fired). Indexed by (agent, event_at)
      -- so dream-cron can query the 24h count in O(log n).
      CREATE TABLE IF NOT EXISTS tier1_truncation_events (
        agent TEXT NOT NULL,
        event_at INTEGER NOT NULL,
        dropped_chars INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tier1_truncation_events_agent_time
        ON tier1_truncation_events(agent, event_at);

      -- Phase 115 Plan 08 T02 — sub-scope 6-A measurement gate.
      -- Per-agent rolling tool_use_rate_per_turn snapshot. The gate value
      -- for sub-scope 6-B (1h-TTL direct-SDK fast-path SHIP/DEFER decision
      -- in plan 115-09) is the fleet non-fin-client average of rate over a
      -- 24h window. Held in its own table rather than back-written to a
      -- random turn's row so the metric is independent of turn cadence.
      -- Cleanup is implicit — old rows are unread by gate queries using
      -- computed_at >= since-window. PRIMARY KEY ensures idempotent
      -- writes across multiple snapshots in the same millisecond.
      CREATE TABLE IF NOT EXISTS tool_use_rate_snapshots (
        agent TEXT NOT NULL,
        computed_at INTEGER NOT NULL,
        window_hours INTEGER NOT NULL,
        turns_total INTEGER NOT NULL,
        turns_with_tools INTEGER NOT NULL,
        rate REAL NOT NULL,
        PRIMARY KEY (agent, computed_at)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_use_rate_snapshots_agent_time
        ON tool_use_rate_snapshots(agent, computed_at);

      CREATE INDEX IF NOT EXISTS idx_traces_agent_started ON traces(agent, started_at);
      CREATE INDEX IF NOT EXISTS idx_spans_turn_name ON trace_spans(turn_id, name);
    `);
  }

  private prepareStatements(): PreparedStatements {
    return {
      // Phase 57 Plan 02: 13-arg positional insert (was 12-arg in Phase 52 Plan 01).
      // Last 6 columns are nullable — Phase 50 callers pass NULL for all of them,
      // Phase 52 callers pass NULL for turn_origin. Phase 57 Plan 03 migrates
      // DiscordBridge + TaskScheduler to provide the turn_origin JSON blob.
      // Phase 115 Plan 05 T04: lazy_recall_call_count column slot opened in
      // Plan 115-00 migrateSchema(); writes wired here. Legacy callers pass
      // NULL via the `lazyRecallCallCount ?? null` fallback in writeTurn().
      // Phase 115 Plan 07 T03: tool_cache_hit_rate + tool_cache_size_mb
      // column slots wired here. Per-turn rate computed from hit/(hit+miss);
      // turns with zero cache-eligible tool calls land NULL.
      // Phase 115 Plan 08 T01: tool_execution_ms + tool_roundtrip_ms +
      // parallel_tool_call_count column slots. Producers in
      // session-adapter.ts iterateWithTracing aggregate execution + roundtrip
      // durations and track MAX parallel batch size across the turn. Turns
      // with no tool_use blocks land NULL on all three.
      // Phase 115 post-deploy patch (2026-05-08): tier1_inject_chars +
      // tier1_budget_pct + prompt_bloat_warnings_24h column slots — slots were
      // opened by 115-00 migrateSchema() but NO producer wrote them in the
      // original wave (schema-without-writer gap caught post-deploy). Writes
      // wired here. Producers: bootstrap-turn assembly path (tier1_*) and
      // classifyPromptBloat sink (prompt_bloat).
      insertTrace: this.db.prepare(`
        INSERT OR REPLACE INTO traces
          (id, agent, started_at, ended_at, total_ms, discord_channel_id, status,
           cache_read_input_tokens, cache_creation_input_tokens, input_tokens,
           prefix_hash, cache_eviction_expected, turn_origin,
           lazy_recall_call_count, tool_cache_hit_rate, tool_cache_size_mb,
           tool_execution_ms, tool_roundtrip_ms, parallel_tool_call_count,
           tier1_inject_chars, tier1_budget_pct, prompt_bloat_warnings_24h)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertSpan: this.db.prepare(`
        INSERT INTO trace_spans
          (turn_id, name, started_at, duration_ms, metadata_json)
        VALUES (?, ?, ?, ?, ?)
      `),
      deleteOlderThan: this.db.prepare(`
        DELETE FROM traces WHERE started_at < @cutoff
      `),
      percentiles: this.db.prepare(PERCENTILE_SQL),
      // Phase 55 Plan 01: per-tool percentile aggregation. Groups spans whose
      // name starts with `tool_call.` by the extracted tool name (SUBSTR
      // strips the 10-char prefix + period = 11 chars). Nearest-rank p50/p95/p99
      // mirrors PERCENTILE_SQL. Sorted by p95 DESC at the SQL layer so CLI /
      // dashboard consumers render slowest-first without client-side sort.
      // NULLS LAST — SQLite places NULLs first on ASC and last on DESC by
      // default, but we spell it explicitly so intent is clear.
      perToolPercentiles: this.db.prepare(`
        WITH tool_spans AS (
          SELECT
            SUBSTR(s.name, 11) AS tool_name,
            s.duration_ms
          FROM trace_spans s
          JOIN traces t ON t.id = s.turn_id
          WHERE t.agent = @agent
            AND t.started_at >= @since
            AND s.name LIKE 'tool_call.%'
        ),
        ranked AS (
          SELECT
            tool_name,
            duration_ms,
            ROW_NUMBER() OVER (PARTITION BY tool_name ORDER BY duration_ms) AS rn,
            COUNT(*) OVER (PARTITION BY tool_name) AS cnt
          FROM tool_spans
        )
        SELECT
          tool_name,
          CAST(MIN(CASE WHEN rn >= CAST(cnt * 0.50 AS INTEGER) + 1 THEN duration_ms END) AS INTEGER) AS p50,
          CAST(MIN(CASE WHEN rn >= CAST(cnt * 0.95 AS INTEGER) + 1 THEN duration_ms END) AS INTEGER) AS p95,
          CAST(MIN(CASE WHEN rn >= CAST(cnt * 0.99 AS INTEGER) + 1 THEN duration_ms END) AS INTEGER) AS p99,
          cnt AS count
        FROM ranked
        GROUP BY tool_name
        ORDER BY p95 DESC NULLS LAST
      `),
      // Phase 52 Plan 01: per-turn rows for in-JS percentile math.
      // WHERE input_tokens IS NOT NULL AND input_tokens > 0 excludes both
      // Phase 50 legacy turns (NULL) and warm-up turns (0).
      cacheTelemetryRows: this.db.prepare(`
        SELECT cache_read_input_tokens, cache_creation_input_tokens, input_tokens
        FROM traces
        WHERE agent = @agent
          AND started_at >= @since
          AND input_tokens IS NOT NULL
          AND input_tokens > 0
        ORDER BY started_at
      `),
      // Phase 52 Plan 01: single-row aggregate sums over the same window.
      cacheTelemetryAggregates: this.db.prepare(`
        SELECT
          COALESCE(SUM(cache_read_input_tokens), 0) AS total_cache_reads,
          COALESCE(SUM(cache_creation_input_tokens), 0) AS total_cache_writes,
          COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
          COUNT(*) AS total_turns
        FROM traces
        WHERE agent = @agent
          AND started_at >= @since
          AND input_tokens IS NOT NULL
          AND input_tokens > 0
      `),
      // Phase 52 Plan 01: per-day trend bucket. substr(started_at, 1, 10)
      // yields YYYY-MM-DD from the ISO 8601 started_at column.
      cacheTelemetryTrend: this.db.prepare(`
        SELECT
          substr(started_at, 1, 10) AS date,
          COUNT(*) AS turns,
          COALESCE(SUM(cache_read_input_tokens), 0) AS sum_read,
          COALESCE(SUM(cache_creation_input_tokens), 0) AS sum_creation,
          COALESCE(SUM(input_tokens), 0) AS sum_input
        FROM traces
        WHERE agent = @agent
          AND started_at >= @since
          AND input_tokens IS NOT NULL
          AND input_tokens > 0
        GROUP BY substr(started_at, 1, 10)
        ORDER BY date
      `),
      // Phase 52 Plan 03: cache-effect first-token stats.
      // Split AVG(first_token.duration_ms) by whether the parent turn was a
      // cache hit (cache_read_input_tokens > 0) vs miss (= 0). Both filters
      // require cache_read_input_tokens IS NOT NULL so Phase 50 legacy turns
      // are excluded from both sides. COUNT(*) returns the overall eligible
      // count (any turn with cache_read_input_tokens IS NOT NULL AND a
      // first_token span) so the caller can gate on the 20-turn noise floor.
      cacheEffectStats: this.db.prepare(`
        SELECT
          AVG(CASE WHEN t.cache_read_input_tokens > 0 THEN s.duration_ms END) AS hit_avg_ms,
          AVG(CASE WHEN t.cache_read_input_tokens = 0 THEN s.duration_ms END) AS miss_avg_ms,
          COUNT(*) AS eligible_turns
        FROM traces t
        JOIN trace_spans s ON s.turn_id = t.id
        WHERE s.name = 'first_token'
          AND t.agent = @agent
          AND t.started_at >= @since
          AND t.cache_read_input_tokens IS NOT NULL
      `),
      // Phase 115 Plan 05 T03 — D-05 priority dream-pass trigger.
      // Per-event row insert for tier-1 truncation count tracking.
      insertTier1TruncationEvent: this.db.prepare(`
        INSERT INTO tier1_truncation_events (agent, event_at, dropped_chars)
        VALUES (?, ?, ?)
      `),
      // Phase 115 Plan 05 T03 — counts events for one agent in a [since, now]
      // window. dream-cron consumes this to decide priority-pass scheduling.
      countTier1TruncationEventsSince: this.db.prepare(`
        SELECT COUNT(*) AS n
        FROM tier1_truncation_events
        WHERE agent = @agent
          AND event_at >= @since
      `),
      // Phase 115 Plan 08 T02 — sub-scope 6-A measurement gate.
      // started_at is ISO 8601 (TEXT) per traces table schema; the @since
      // bind is also ISO 8601 so lexicographic comparison is correct.
      countTotalTurnsInWindow: this.db.prepare(`
        SELECT COUNT(*) AS n
        FROM traces
        WHERE agent = @agent
          AND started_at >= @since
      `),
      // Phase 115 Plan 08 T02 — count turns where parallel_tool_call_count
      // (the producer wired in T01) recorded ≥1 tool_use block.
      // parallel_tool_call_count > 0 is the "had any tool" flag — see
      // T01 Turn.end conditional spread (gate is parallelToolCallCount > 0).
      countTurnsWithToolsInWindow: this.db.prepare(`
        SELECT COUNT(*) AS n
        FROM traces
        WHERE agent = @agent
          AND started_at >= @since
          AND parallel_tool_call_count IS NOT NULL
          AND parallel_tool_call_count > 0
      `),
      // Phase 115 Plan 08 T02 — write snapshot. PRIMARY KEY (agent,
      // computed_at) makes repeat writes within the same millisecond
      // idempotent without REPLACE — caller advances computed_at by
      // window cadence in production.
      insertToolUseRateSnapshot: this.db.prepare(`
        INSERT OR REPLACE INTO tool_use_rate_snapshots
          (agent, computed_at, window_hours, turns_total, turns_with_tools, rate)
        VALUES (@agent, @computedAt, @windowHours, @turnsTotal, @turnsWithTools, @rate)
      `),
      // Phase 115 Plan 08 T02 — read latest snapshot for an agent. Powers
      // the CLI tool-latency-audit (T03) and the plan 115-09 gate query.
      latestToolUseRateSnapshot: this.db.prepare(`
        SELECT agent, computed_at, window_hours, turns_total, turns_with_tools, rate
        FROM tool_use_rate_snapshots
        WHERE agent = @agent
        ORDER BY computed_at DESC
        LIMIT 1
      `),
      // Phase 116-06 T01 — F18/F22 activity heatmap. One row per
      // (date, agent) bucket within [@since, now]. `substr(started_at,1,10)`
      // pulls YYYY-MM-DD from the ISO 8601 column. Lexicographic @since
      // bind (also ISO 8601) compares correctly with no cast. Plain
      // turn count — does NOT filter by input_tokens, cache state, or
      // status, so every recorded turn surfaces in the heatmap (including
      // errored turns — that's a SIGNAL, not noise, for the heatmap
      // operator question "did this agent do anything today?").
      activityByDay: this.db.prepare(`
        SELECT
          substr(started_at, 1, 10) AS date,
          agent,
          COUNT(*) AS turn_count
        FROM traces
        WHERE started_at >= @since
        GROUP BY date, agent
        ORDER BY date, agent
      `),
      // Phase 116-postdeploy 2026-05-12 — F03 tile 24h sparkline.
      // strftime('%Y-%m-%dT%H', ...) yields "2026-05-12T13" (hour mark)
      // — naturally ordered lexicographically. Plain turn count per
      // hour, no input_tokens / cache / status filter (same convention
      // as activityByDay — every recorded turn surfaces). The @agent
      // bind is defensive: in ClawCode every agent owns its own
      // traces.db so all rows already belong to one agent, but the
      // bind survives any future cross-agent traces.db restructure.
      activityByHour: this.db.prepare(`
        SELECT
          strftime('%Y-%m-%dT%H', started_at) AS bucket,
          COUNT(*) AS turn_count
        FROM traces
        WHERE agent = @agent AND started_at >= @since
        GROUP BY bucket
        ORDER BY bucket ASC
      `),
      // Phase 116-postdeploy 2026-05-12 — fleet-activity-summary tile sort.
      // ONE round-trip per agent for both count and recency. MAX over a
      // TEXT-typed ISO 8601 column is correct (lexicographic ordering
      // matches chronological). idx_traces_agent_started (line ~906)
      // covers the WHERE clause and the MAX scan tail, so this is
      // O(log n) for the WHERE seek and bounded by the matched-row count
      // for MAX. An agent with zero turns in window returns `{n:0, last_at:null}`.
      turnSummarySince: this.db.prepare(`
        SELECT
          COUNT(*) AS n,
          MAX(started_at) AS last_at
        FROM traces
        WHERE agent = @agent AND started_at >= @since
      `),
      // Phase 132-fu T06 — agent-window tool-call aggregation.
      //
      // Multi-turn trajectory for an agent across a (since, until)
      // time window. Used by SessionManager.getTrajectoryForSubagent
      // to assemble the trajectory for a subagent session that ran
      // across multiple turns inside a Discord thread — each
      // message-reply is its own traces row, so per-turn lookup
      // (toolCallSpansForTurn) wouldn't capture cross-turn tool
      // sequences.
      //
      // JOIN traces ON id = turn_id so we can filter by agent + window.
      // ORDER BY trace started_at ASC THEN span started_at ASC,
      // rowid ASC — preserves invocation order across multiple turns
      // and ties.
      toolCallSpansForAgentWindow: this.db.prepare(`
        SELECT
          SUBSTR(s.name, 11) AS tool,
          s.started_at AS started_at
        FROM trace_spans s
        JOIN traces t ON t.id = s.turn_id
        WHERE t.agent = @agent
          AND t.started_at >= @since
          AND t.started_at <= @until
          AND s.name LIKE 'tool_call.%'
        ORDER BY t.started_at ASC, s.started_at ASC, s.rowid ASC
      `),
      // Phase 132-fu T02 — single-turn total_ms lookup. The traces row is
      // the canonical source for per-turn wall-clock (writer in
      // trace-collector.ts:end()). Returns undefined when the turn row is
      // missing (turn not yet flushed, or never recorded).
      traceTotalMsForTurn: this.db.prepare(`
        SELECT total_ms FROM traces WHERE id = ?
      `),
      // Phase 132-fu T01 — per-turn tool-call trajectory.
      // Strips the canonical `tool_call.` prefix (11 chars including the
      // trailing dot) via SUBSTR; mirrors the convention used by
      // `perToolPercentiles`. ORDER BY started_at preserves invocation
      // order; rowid tie-break covers same-millisecond inserts so the
      // returned sequence is stable across reruns.
      //
      // Single-turn scope (no agent filter) — caller (SessionManager.
      // getTrajectoryForTurnId) has already verified the agent owns the
      // TraceStore, so adding `t.agent = @agent` would be redundant.
      // The idx_spans_turn_name index covers the lookup.
      toolCallSpansForTurn: this.db.prepare(`
        SELECT
          SUBSTR(name, 11) AS tool,
          started_at AS started_at
        FROM trace_spans
        WHERE turn_id = ?
          AND name LIKE 'tool_call.%'
        ORDER BY started_at ASC, rowid ASC
      `),
    };
  }

  /**
   * Phase 116-06 T01 — F18 (per-agent) + F22 (fleet) activity heatmap.
   *
   * Returns one row per (date, agent) bucket within [sinceIso, now]:
   *   - F18 mount: filter to one agent client-side and render the 30×7
   *     calendar grid with intensity = turn_count.
   *   - F22 mount: aggregate across all agents (sum per-date) for the
   *     fleet-wide rollup.
   *
   * Why not aggregate fleet-wide on the daemon side? Two reasons:
   *   1) Both F18 and F22 need the same per-agent breakdown — F22 just
   *      sums client-side. One IPC, two consumers.
   *   2) Per-agent rows let the heatmap surface "which agent drove
   *      today's spike?" on hover.
   *
   * Empty windows return `[]` — never throws. ISO 8601 lexicographic
   * comparison with `started_at` matches the convention every other
   * trace-store window query uses.
   */
  getActivityByDay(sinceIso: string): ReadonlyArray<{
    readonly date: string;
    readonly agent: string;
    readonly turn_count: number;
  }> {
    try {
      const rows = this.stmts.activityByDay.all({ since: sinceIso }) as Array<{
        date: string;
        agent: string;
        turn_count: number;
      }>;
      return Object.freeze(rows.map((r) => Object.freeze(r)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `getActivityByDay failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 116-postdeploy 2026-05-12 — F03 tile 24h sparkline.
   *
   * Returns one row per hour bucket within [sinceIso, now] for a single
   * agent, ordered ascending so the sparkline draws left-to-right
   * chronological. Sparse: an hour with zero turns is OMITTED (no
   * zero-fill — the client interpolates / treats absent hours as 0
   * since Recharts handles gaps in time-series gracefully and an
   * idle agent should render a flat area, not bogus rows).
   *
   * Empty windows return `[]` — never throws (matches getActivityByDay).
   * ISO 8601 lexicographic comparison with `started_at` is the same
   * convention every trace-store window query uses.
   */
  getActivityByHour(
    agent: string,
    sinceIso: string,
  ): ReadonlyArray<{
    readonly bucket: string;
    readonly turn_count: number;
  }> {
    try {
      const rows = this.stmts.activityByHour.all({
        agent,
        since: sinceIso,
      }) as Array<{
        bucket: string;
        turn_count: number;
      }>;
      return Object.freeze(rows.map((r) => Object.freeze(r)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `getActivityByHour failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 116-postdeploy 2026-05-12 — fleet-activity-summary tile sort.
   *
   * Returns a single-row summary for an agent within [sinceIso, now]:
   *   - `n`        : turn count
   *   - `last_at`  : MAX(started_at) ISO 8601 string, or `null` if no rows
   *
   * Used by the `fleet-activity-summary` IPC handler to sort the main
   * dashboard tile grid by recent usage. ONE round-trip per agent — the
   * handler runs N of these in a tight loop (one per running agent), so
   * the single-statement form matters at fleet scale (14 agents today,
   * room for ~hundreds without strain).
   *
   * Empty windows return `{ n: 0, last_at: null }` — never throws on
   * empty rows. ISO 8601 lexicographic comparison with `started_at`
   * matches the convention every other trace-store window query uses.
   */
  getTurnSummarySince(
    agent: string,
    sinceIso: string,
  ): { readonly n: number; readonly last_at: string | null } {
    try {
      const row = this.stmts.turnSummarySince.get({
        agent,
        since: sinceIso,
      }) as { readonly n: number; readonly last_at: string | null } | undefined;
      return Object.freeze({
        n: row?.n ?? 0,
        last_at: row?.last_at ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `getTurnSummarySince failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 115 Plan 05 T03 — record a tier-1 truncation event (D-05 trigger
   * counter). Called from session-config.ts when MEMORY.md exceeded
   * INJECTED_MEMORY_MAX_CHARS at assembly time. The dream-cron tick
   * queries `countTier1TruncationEventsSince` and fires a priority pass
   * when 2+ events fired in 24h for the same agent.
   *
   * Per-agent isolation: agent is treated as opaque — the per-agent
   * traces.db invariant (Phase 90) ensures cross-agent collision is
   * impossible. The column is indexed so 24h count queries are O(log n).
   */
  recordTier1TruncationEvent(agent: string, droppedChars = 0): void {
    try {
      this.stmts.insertTier1TruncationEvent.run(
        agent,
        Date.now(),
        droppedChars,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `recordTier1TruncationEvent failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 115 Plan 05 T03 — count tier-1 truncation events for an agent
   * since `sinceMs` (epoch ms). Used by dream-cron's
   * `shouldFirePriorityPass` to compute the 2-in-24h trigger.
   *
   * Returns 0 when no events recorded — never throws on missing rows.
   */
  countTier1TruncationEventsSince(agent: string, sinceMs: number): number {
    try {
      const row = this.stmts.countTier1TruncationEventsSince.get({
        agent,
        since: sinceMs,
      }) as { readonly n: number } | undefined;
      return row?.n ?? 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `countTier1TruncationEventsSince failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 115 Plan 08 T02 — compute `tool_use_rate_per_turn` for one agent
   * over a rolling window (sub-scope 6-A measurement gate).
   *
   * `rate = turns_with_tools / max(turns_total, 1)` — empty windows
   * return rate=0 rather than NaN so plan 115-09 gate query treats them
   * as "no signal" (which they are).
   *
   * `since` is ISO 8601 — the same format `traces.started_at` uses, so
   * the prepared statement compares text lexicographically without a
   * cast. Caller derives from `new Date(Date.now() - windowHours * 3600000).toISOString()`.
   *
   * NEVER throws on a fresh / empty traces.db — count queries return 0
   * naturally and the rate is well-defined at 0.
   */
  computeToolUseRatePerTurn(
    agent: string,
    sinceIso: string,
    windowHours: number,
  ): ToolUseRateSnapshot {
    try {
      const totalRow = this.stmts.countTotalTurnsInWindow.get({
        agent,
        since: sinceIso,
      }) as { readonly n: number } | undefined;
      const toolRow = this.stmts.countTurnsWithToolsInWindow.get({
        agent,
        since: sinceIso,
      }) as { readonly n: number } | undefined;
      const turnsTotal = totalRow?.n ?? 0;
      const turnsWithTools = toolRow?.n ?? 0;
      const rate = turnsTotal > 0 ? turnsWithTools / turnsTotal : 0;
      return Object.freeze<ToolUseRateSnapshot>({
        agent,
        computedAt: Date.now(),
        windowHours,
        turnsTotal,
        turnsWithTools,
        rate,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `computeToolUseRatePerTurn failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 115 Plan 08 T02 — persist a snapshot row produced by
   * `computeToolUseRatePerTurn`. Composes with the periodic computation
   * in daemon.ts (heartbeat-driven sub-scope 6-A scheduler in T03).
   */
  writeToolUseRateSnapshot(snapshot: ToolUseRateSnapshot): void {
    try {
      this.stmts.insertToolUseRateSnapshot.run({
        agent: snapshot.agent,
        computedAt: snapshot.computedAt,
        windowHours: snapshot.windowHours,
        turnsTotal: snapshot.turnsTotal,
        turnsWithTools: snapshot.turnsWithTools,
        rate: snapshot.rate,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `writeToolUseRateSnapshot failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 115 Plan 08 T03 — split-latency percentile aggregate for the
   * tool-latency-audit CLI / dashboard.
   *
   * Computes p50 of the per-turn `tool_execution_ms` and `tool_roundtrip_ms`
   * columns (sub-scope 17a producers from T01) plus the fraction of in-window
   * tool-bearing turns whose `parallel_tool_call_count >= 2` (sub-scope 17b
   * parallel rate). Both p50s are NULL when no in-window turn has data.
   *
   * Unlike `getToolPercentiles` (which slices by tool_name across spans),
   * this aggregates the per-turn SUM columns from T01 — the right semantics
   * for "did this turn spend 14s in tools" not "is the Read tool slow."
   *
   * Method scoped to one agent (callers loop). Returns frozen so the
   * audit CLI can pass it directly into the JSON response without copy.
   */
  getSplitLatencyAggregate(
    agent: string,
    sinceIso: string,
  ): {
    readonly toolExecutionMsP50: number | null;
    readonly toolRoundtripMsP50: number | null;
    readonly parallelToolCallRate: number | null;
    readonly turnsWithToolsInWindow: number;
  } {
    try {
      // Per-turn columns; ranked nearest-rank percentile, same shape as
      // PERCENTILE_SQL but inlined here because we want both columns at once.
      // p50 nearest-rank: position = floor(N * 0.50), 0-indexed; index into
      // sorted-asc duration list. SQLite's ORDER BY + LIMIT/OFFSET works.
      const execValues = this.db
        .prepare(
          `SELECT tool_execution_ms FROM traces
             WHERE agent = @agent
               AND started_at >= @since
               AND tool_execution_ms IS NOT NULL
             ORDER BY tool_execution_ms`,
        )
        .all({ agent, since: sinceIso }) as ReadonlyArray<{
        readonly tool_execution_ms: number;
      }>;
      const rtValues = this.db
        .prepare(
          `SELECT tool_roundtrip_ms FROM traces
             WHERE agent = @agent
               AND started_at >= @since
               AND tool_roundtrip_ms IS NOT NULL
             ORDER BY tool_roundtrip_ms`,
        )
        .all({ agent, since: sinceIso }) as ReadonlyArray<{
        readonly tool_roundtrip_ms: number;
      }>;
      // Parallel-rate denominator = turns that had ≥1 tool. Numerator =
      // turns with ≥2 in a single batch. Both filtered to in-window.
      const parallelRow = this.db
        .prepare(
          `SELECT
             COUNT(*) AS denom,
             SUM(CASE WHEN parallel_tool_call_count >= 2 THEN 1 ELSE 0 END) AS num
           FROM traces
           WHERE agent = @agent
             AND started_at >= @since
             AND parallel_tool_call_count IS NOT NULL
             AND parallel_tool_call_count > 0`,
        )
        .get({ agent, since: sinceIso }) as
        | { denom: number; num: number | null }
        | undefined;

      const execP50 =
        execValues.length > 0
          ? execValues[Math.min(Math.floor(execValues.length * 0.5), execValues.length - 1)]!
              .tool_execution_ms
          : null;
      const rtP50 =
        rtValues.length > 0
          ? rtValues[Math.min(Math.floor(rtValues.length * 0.5), rtValues.length - 1)]!
              .tool_roundtrip_ms
          : null;
      const denom = parallelRow?.denom ?? 0;
      const num = parallelRow?.num ?? 0;
      const parallelRate = denom > 0 ? num / denom : null;

      return Object.freeze({
        toolExecutionMsP50: execP50,
        toolRoundtripMsP50: rtP50,
        parallelToolCallRate: parallelRate,
        turnsWithToolsInWindow: denom,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `getSplitLatencyAggregate failed: ${msg}`,
        this.dbPath,
      );
    }
  }

  /**
   * Phase 115 Plan 08 T02 — fetch the latest snapshot for an agent,
   * or `undefined` if no snapshot has been computed yet (e.g., a fresh
   * agent that hasn't tripped the heartbeat scheduler). Powers the
   * CLI `clawcode tool-latency-audit` (T03) operator surface.
   */
  getLatestToolUseRateSnapshot(agent: string): ToolUseRateSnapshot | undefined {
    try {
      const row = this.stmts.latestToolUseRateSnapshot.get({ agent }) as
        | {
            readonly agent: string;
            readonly computed_at: number;
            readonly window_hours: number;
            readonly turns_total: number;
            readonly turns_with_tools: number;
            readonly rate: number;
          }
        | undefined;
      if (!row) return undefined;
      return Object.freeze<ToolUseRateSnapshot>({
        agent: row.agent,
        computedAt: row.computed_at,
        windowHours: row.window_hours,
        turnsTotal: row.turns_total,
        turnsWithTools: row.turns_with_tools,
        rate: row.rate,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      throw new TraceStoreError(
        `getLatestToolUseRateSnapshot failed: ${msg}`,
        this.dbPath,
      );
    }
  }
}

/**
 * Serialize span metadata with a hard length cap (see pitfall 5).
 *
 * Empty/null metadata becomes `{}`. Oversized JSON is truncated at
 * METADATA_JSON_MAX_LEN - 3 characters and a literal `...` sentinel is
 * appended so operators can tell the payload was clipped during inspection.
 */
function serializeMetadata(metadata: Readonly<Record<string, unknown>> | undefined): string {
  const source = metadata ?? {};
  const json = JSON.stringify(source);
  if (json === undefined) {
    return "{}";
  }
  if (json.length <= METADATA_JSON_MAX_LEN) {
    return json;
  }
  return `${json.slice(0, METADATA_JSON_MAX_LEN - 3)}...`;
}
