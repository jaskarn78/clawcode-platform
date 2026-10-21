import Database from "better-sqlite3";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import { nanoid } from "nanoid";
import { addDays } from "date-fns";
import type {
  UsageEvent,
  UsageAggregate,
  CostByAgentModel,
  CostByCategory,
  CostByDay,
} from "./types.js";

/**
 * Zero-value aggregate returned when no events match a query.
 */
const ZERO_AGGREGATE: UsageAggregate = Object.freeze({
  tokens_in: 0,
  tokens_out: 0,
  cost_usd: 0,
  turns: 0,
  duration_ms: 0,
  event_count: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
});

/** Prepared statements for usage operations. */
type PreparedStatements = {
  readonly insert: Statement;
  readonly sessionUsage: Statement;
  readonly dailyUsage: Statement;
  readonly weeklyUsage: Statement;
  // Quick 260611-h50 — half-open [start, end) range aggregate, used by the
  // /clawcode-usage Pacific token totals (caller computes the UTC instants).
  readonly usageInRange: Statement;
  readonly totalUsage: Statement;
  readonly totalUsageByAgent: Statement;
  readonly costsByAgentModel: Statement;
  readonly costsByCategory: Statement;
  // Phase 116-05 F17 — per-day cost trend rows for the cost dashboard.
  readonly costsByDay: Statement;
};

/**
 * UsageTracker — SQLite-backed per-agent usage event storage and aggregation.
 *
 * Stores token consumption, cost, turns, model, and duration for each
 * SDK interaction. Provides aggregation methods for session, daily,
 * weekly, and total usage queries.
 *
 * Follows the same better-sqlite3 patterns as MemoryStore:
 * prepared statements, WAL mode, synchronous API.
 */
export class UsageTracker {
  private readonly db: DatabaseType;
  private readonly stmts: PreparedStatements;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");

    this.initSchema();
    this.stmts = this.prepareStatements();
  }

  /**
   * Phase 56 Plan 01 — expose the underlying database for READ-ONLY warmup
   * queries (AgentMemoryManager.warmSqliteStores). Do not use for writes.
   */
  getDatabase(): DatabaseType {
    return this.db;
  }

  /**
   * Record a usage event.
   *
   * Phase 72: optional `category`, `backend`, `count` fields are
   * appended for image-generation rows. Existing token call sites
   * leave them undefined → stored as NULL → exposed as null on read.
   */
  record(event: Omit<UsageEvent, "id">): void {
    const id = nanoid();
    this.stmts.insert.run(
      id,
      event.agent,
      event.timestamp,
      event.tokens_in,
      event.tokens_out,
      event.cost_usd,
      event.turns,
      event.model,
      event.duration_ms,
      event.session_id,
      event.category ?? null,
      event.backend ?? null,
      event.count ?? null,
      event.cache_read_tokens ?? 0,
      event.cache_creation_tokens ?? 0,
    );
  }

  /**
   * Get aggregated usage for a specific session.
   */
  getSessionUsage(sessionId: string): UsageAggregate {
    const row = this.stmts.sessionUsage.get(sessionId) as AggregateRow | undefined;
    return row ? rowToAggregate(row) : { ...ZERO_AGGREGATE };
  }

  /**
   * Get aggregated usage for a specific date (YYYY-MM-DD).
   */
  getDailyUsage(date: string): UsageAggregate {
    const dayStart = `${date}T00:00:00`;
    const dayEnd = `${date}T23:59:59`;
    const row = this.stmts.dailyUsage.get(dayStart, dayEnd) as AggregateRow | undefined;
    return row ? rowToAggregate(row) : { ...ZERO_AGGREGATE };
  }

  /**
   * Get aggregated usage for a week starting from weekStart (YYYY-MM-DD).
   */
  getWeeklyUsage(weekStart: string): UsageAggregate {
    const start = `${weekStart}T00:00:00`;
    const endDate = addDays(new Date(`${weekStart}T00:00:00Z`), 7);
    const end = endDate.toISOString().replace("Z", "").slice(0, 19);
    const row = this.stmts.weeklyUsage.get(start, end) as AggregateRow | undefined;
    return row ? rowToAggregate(row) : { ...ZERO_AGGREGATE };
  }

  /**
   * Quick 260611-h50 — get aggregated usage over an explicit half-open UTC
   * instant range `[startIso, endIso)`. Same shape as getDailyUsage.
   *
   * Backwards-compatible addition: existing period-based queries (daily =
   * UTC calendar date, weekly = UTC Monday) are untouched. This lets the
   * caller pass arbitrary timezone-correct windows (e.g. Pacific midnight
   * boundaries) without the tracker owning any timezone logic.
   *
   * Half-open semantics mirror `weeklyUsage`: start is inclusive, end is
   * exclusive.
   *
   * @param startIso - UTC ISO timestamp (inclusive)
   * @param endIso - UTC ISO timestamp (exclusive)
   */
  getUsageInRange(startIso: string, endIso: string): UsageAggregate {
    const row = this.stmts.usageInRange.get(startIso, endIso) as
      | AggregateRow
      | undefined;
    return row ? rowToAggregate(row) : { ...ZERO_AGGREGATE };
  }

  /**
   * Get lifetime aggregated usage, optionally filtered by agent name.
   */
  getTotalUsage(agent?: string): UsageAggregate {
    if (agent) {
      const row = this.stmts.totalUsageByAgent.get(agent) as AggregateRow | undefined;
      return row ? rowToAggregate(row) : { ...ZERO_AGGREGATE };
    }
    const row = this.stmts.totalUsage.get() as AggregateRow | undefined;
    return row ? rowToAggregate(row) : { ...ZERO_AGGREGATE };
  }

  /**
   * Get cost data grouped by agent and model for a time range.
   *
   * @param startTime - ISO timestamp (inclusive)
   * @param endTime - ISO timestamp (exclusive)
   * @returns Frozen array of CostByAgentModel rows
   */
  getCostsByAgentModel(startTime: string, endTime: string): readonly CostByAgentModel[] {
    const rows = this.stmts.costsByAgentModel.all(startTime, endTime) as CostByAgentModel[];
    return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
  }

  /**
   * Phase 72 — get cost totals grouped by category (tokens vs image)
   * for a time range. Pre-Phase-72 NULL rows are coalesced into the
   * "tokens" bucket so the historical token spend rolls up correctly.
   *
   * @param startTime - ISO timestamp (inclusive)
   * @param endTime - ISO timestamp (exclusive)
   * @returns Frozen array of `{ category, cost_usd }` rows.
   */
  getCostsByCategory(startTime: string, endTime: string): readonly CostByCategory[] {
    const rows = this.stmts.costsByCategory.all(startTime, endTime) as CostByCategory[];
    return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
  }

  /**
   * Phase 116-05 F17 — get per-day cost rows for a time range, grouped
   * by (date, agent, model). UTC-aligned via SQLite's `date(timestamp)`.
   *
   * One query covers a 30-day window. The `idx_usage_timestamp` index
   * already exists (initSchema) so the WHERE filter is sargable; GROUP
   * BY then sorts by date for stable trend rendering.
   *
   * @param startTime - ISO timestamp (inclusive)
   * @param endTime - ISO timestamp (exclusive)
   * @returns Frozen array of CostByDay rows in date-ascending order.
   */
  getCostsByDay(startTime: string, endTime: string): readonly CostByDay[] {
    const rows = this.stmts.costsByDay.all(startTime, endTime) as CostByDay[];
    return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER NOT NULL DEFAULT 0,
        session_id TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_events(agent);

      -- Phase 103 OBS-04 — per-agent rate-limit snapshots (one row per
      -- rateLimitType: five_hour, seven_day, seven_day_opus,
      -- seven_day_sonnet, overage). Owned + populated by RateLimitTracker
      -- (src/usage/rate-limit-tracker.ts) which shares this DB handle so
      -- there is exactly one SQLite file per agent. Additive — never
      -- destructive to existing usage_events rows.
      CREATE TABLE IF NOT EXISTS rate_limit_snapshots (
        rate_limit_type TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      );
    `);

    // Phase 72 — idempotent column migrations. SQLite throws "duplicate
    // column name" on a re-add; we swallow only that specific error and
    // re-throw anything else (DB locked, schema mismatch, etc).
    this.addColumnIfMissing("category", "TEXT");
    this.addColumnIfMissing("backend", "TEXT");
    this.addColumnIfMissing("count", "INTEGER");

    // Token-accuracy fix (2026-06-11) — cache input token columns. NOT NULL
    // DEFAULT 0 so the additive migration backfills every pre-existing row to
    // 0 (no NULLs to COALESCE around) and SUM() stays exact. tokens_in is
    // unchanged (still fresh/uncached input); these track the cache halves the
    // capture path previously dropped on the floor.
    this.addColumnIfMissing("cache_read_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0");
  }

  /**
   * Add a nullable column to `usage_events` if it doesn't already exist.
   * Idempotent: safe to call on every constructor invocation. Surfaces
   * any non-"duplicate column" error verbatim.
   */
  private addColumnIfMissing(column: string, type: string): void {
    try {
      this.db.exec(`ALTER TABLE usage_events ADD COLUMN ${column} ${type}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column/i.test(msg)) {
        throw err;
      }
    }
  }

  private prepareStatements(): PreparedStatements {
    const aggregateSql = `
      COALESCE(SUM(tokens_in), 0) AS tokens_in,
      COALESCE(SUM(tokens_out), 0) AS tokens_out,
      COALESCE(SUM(cost_usd), 0) AS cost_usd,
      COALESCE(SUM(turns), 0) AS turns,
      COALESCE(SUM(duration_ms), 0) AS duration_ms,
      COUNT(*) AS event_count,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens
    `;

    return {
      insert: this.db.prepare(`
        INSERT INTO usage_events (id, agent, timestamp, tokens_in, tokens_out, cost_usd, turns, model, duration_ms, session_id, category, backend, count, cache_read_tokens, cache_creation_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      sessionUsage: this.db.prepare(`
        SELECT ${aggregateSql} FROM usage_events WHERE session_id = ?
      `),
      dailyUsage: this.db.prepare(`
        SELECT ${aggregateSql} FROM usage_events WHERE timestamp >= ? AND timestamp <= ?
      `),
      weeklyUsage: this.db.prepare(`
        SELECT ${aggregateSql} FROM usage_events WHERE timestamp >= ? AND timestamp < ?
      `),
      // Quick 260611-h50 — half-open [start, end) range aggregate for the
      // /clawcode-usage Pacific token totals. Same half-open pattern as
      // weeklyUsage above; the caller supplies pre-computed UTC instants.
      usageInRange: this.db.prepare(`
        SELECT ${aggregateSql} FROM usage_events WHERE timestamp >= ? AND timestamp < ?
      `),
      totalUsage: this.db.prepare(`
        SELECT ${aggregateSql} FROM usage_events
      `),
      totalUsageByAgent: this.db.prepare(`
        SELECT ${aggregateSql} FROM usage_events WHERE agent = ?
      `),
      costsByAgentModel: this.db.prepare(`
        SELECT agent, model, category,
          COALESCE(SUM(tokens_in), 0) AS tokens_in,
          COALESCE(SUM(tokens_out), 0) AS tokens_out,
          COALESCE(SUM(cost_usd), 0) AS cost_usd
        FROM usage_events
        WHERE timestamp >= ? AND timestamp < ?
        GROUP BY agent, model, category
        ORDER BY cost_usd DESC
      `),
      costsByCategory: this.db.prepare(`
        SELECT COALESCE(category, 'tokens') AS category,
          COALESCE(SUM(cost_usd), 0) AS cost_usd
        FROM usage_events
        WHERE timestamp >= ? AND timestamp < ?
        GROUP BY COALESCE(category, 'tokens')
        ORDER BY cost_usd DESC
      `),
      // Phase 116-05 F17 — per-day trend buckets. `date(timestamp)` uses
      // SQLite's built-in date() which slices the UTC ISO timestamp at the
      // 10-char date prefix (cheap; no timezone math). Sorting by date
      // first guarantees the dashboard receives ascending buckets ready
      // for line/area chart rendering.
      costsByDay: this.db.prepare(`
        SELECT date(timestamp) AS date, agent, model,
          COALESCE(SUM(tokens_in), 0) AS tokens_in,
          COALESCE(SUM(tokens_out), 0) AS tokens_out,
          COALESCE(SUM(cost_usd), 0) AS cost_usd
        FROM usage_events
        WHERE timestamp >= ? AND timestamp < ?
        GROUP BY date(timestamp), agent, model
        ORDER BY date ASC, cost_usd DESC
      `),
    };
  }
}

/** Raw row shape from aggregate queries. */
type AggregateRow = {
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cost_usd: number;
  readonly turns: number;
  readonly duration_ms: number;
  readonly event_count: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
};

/** Convert a raw aggregate row to a UsageAggregate. */
function rowToAggregate(row: AggregateRow): UsageAggregate {
  return Object.freeze({
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    cost_usd: row.cost_usd,
    turns: row.turns,
    duration_ms: row.duration_ms,
    event_count: row.event_count,
    cache_read_tokens: row.cache_read_tokens,
    cache_creation_tokens: row.cache_creation_tokens,
  });
}
