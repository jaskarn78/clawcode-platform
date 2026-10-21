/**
 * Phase 115 Plan 07 sub-scope 15 — daemon-side MCP tool-response cache store.
 *
 * Folds Phase 999.40 (now SUPERSEDED-BY-115). Daemon-side content-keyed cache
 * for repeated MCP tool calls — eliminates the observed 120s `mysql_query` p50
 * on cache misses + the ~14s cache-miss penalty on first_token.
 *
 * # Storage
 *
 * better-sqlite3 in `~/.clawcode/manager/tool-cache.db` (override via
 * constructor `path` option). One row per cache key:
 *
 *   tool_cache(
 *     key TEXT PRIMARY KEY,                -- sha256 hash of (tool, [agent], args)
 *     tool TEXT NOT NULL,                  -- tool name (e.g. "web_search")
 *     agent_or_null TEXT,                  -- per-agent: agentName; cross-agent: NULL
 *     response_json TEXT NOT NULL,         -- JSON.stringify(response)
 *     created_at INTEGER NOT NULL,         -- ms epoch
 *     expires_at INTEGER NOT NULL,         -- ms epoch (TTL bound)
 *     bytes INTEGER NOT NULL,              -- Buffer.byteLength(response_json)
 *     last_accessed_at INTEGER NOT NULL    -- ms epoch (updated on get for LRU)
 *   )
 *
 * # Eviction
 *
 * - Lazy expiration: `get()` on an expired row deletes it and returns null.
 * - LRU eviction: `put()` checks total bytes; if > `maxSizeMb` cap, drops
 *   expired rows first, then evicts oldest-by-`last_accessed_at` until under
 *   the cap. Both phases run inside the SAME transaction as the insert so an
 *   eviction failure rolls back the put.
 *
 * # Per-agent vs cross-agent isolation
 *
 * The store itself is INDIFFERENT to the keying strategy — `agent_or_null`
 * is a column the caller fills in (NULL for cross-agent shared rows like
 * `web_search`, agentName for per-agent rows like `search_documents`). The
 * per-agent vs cross-agent decision is made by `tool-cache-policy.ts` via
 * the `keyStrategy` field. See PLAN.md acceptance criteria for the lock.
 *
 * # Lifetime
 *
 * One singleton per daemon. Disk-backed survives daemon restarts. Operators
 * can clear via `clawcode tool-cache clear`.
 */

import Database from "better-sqlite3";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/** Default disk location — `~/.clawcode/manager/tool-cache.db`. */
export const DEFAULT_TOOL_CACHE_DB_PATH = join(
  homedir(),
  ".clawcode",
  "manager",
  "tool-cache.db",
);

/** Default size cap when caller does not pass an explicit `maxSizeMb`. */
export const DEFAULT_TOOL_CACHE_MAX_SIZE_MB = 100;

/**
 * Row shape returned by `get()` and `inspect()`. `last_accessed_at` reflects
 * the value in storage AFTER any LRU update by `get()`.
 */
export interface CacheRow {
  readonly key: string;
  readonly tool: string;
  readonly agent_or_null: string | null;
  readonly response_json: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly bytes: number;
  readonly last_accessed_at: number;
}

/**
 * Input row for `put()`. `bytes` and `last_accessed_at` are computed inside
 * `put()` — callers do not provide them.
 */
export interface PutRow {
  readonly key: string;
  readonly tool: string;
  readonly agent_or_null: string | null;
  readonly response_json: string;
  readonly created_at: number;
  readonly expires_at: number;
}

interface PreparedStatements {
  readonly getByKey: Statement;
  readonly deleteByKey: Statement;
  readonly updateLru: Statement;
  readonly insertOrReplace: Statement;
  readonly sumBytes: Statement;
  readonly deleteExpired: Statement;
  readonly oldestByLru: Statement;
  readonly clearAll: Statement;
  readonly clearByTool: Statement;
}

interface RawCacheRow {
  readonly key: string;
  readonly tool: string;
  readonly agent_or_null: string | null;
  readonly response_json: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly bytes: number;
  readonly last_accessed_at: number;
}

/**
 * ToolCacheStore — better-sqlite3 wrapper for the daemon-side tool-response
 * cache. Synchronous SQL via prepared statements; eviction inside the same
 * transaction as the insert.
 */
export class ToolCacheStore {
  private readonly db: DatabaseType;
  private readonly stmts: PreparedStatements;
  private readonly path: string;

  constructor(opts?: { path?: string }) {
    this.path = opts?.path ?? DEFAULT_TOOL_CACHE_DB_PATH;
    // Ensure parent directory exists (one-time at startup).
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_cache (
        key TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        agent_or_null TEXT,
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_cache_tool ON tool_cache(tool);
      CREATE INDEX IF NOT EXISTS idx_tool_cache_expires ON tool_cache(expires_at);
      CREATE INDEX IF NOT EXISTS idx_tool_cache_lru ON tool_cache(last_accessed_at);
      CREATE INDEX IF NOT EXISTS idx_tool_cache_agent ON tool_cache(agent_or_null);
    `);
    this.stmts = {
      getByKey: this.db.prepare("SELECT * FROM tool_cache WHERE key = ?"),
      deleteByKey: this.db.prepare("DELETE FROM tool_cache WHERE key = ?"),
      updateLru: this.db.prepare(
        "UPDATE tool_cache SET last_accessed_at = ? WHERE key = ?",
      ),
      insertOrReplace: this.db.prepare(`
        INSERT OR REPLACE INTO tool_cache (
          key, tool, agent_or_null, response_json,
          created_at, expires_at, bytes, last_accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      sumBytes: this.db.prepare(
        "SELECT COALESCE(SUM(bytes), 0) AS total FROM tool_cache",
      ),
      deleteExpired: this.db.prepare(
        "DELETE FROM tool_cache WHERE expires_at <= ?",
      ),
      oldestByLru: this.db.prepare(
        "SELECT key, bytes FROM tool_cache ORDER BY last_accessed_at ASC LIMIT 1",
      ),
      clearAll: this.db.prepare("DELETE FROM tool_cache"),
      clearByTool: this.db.prepare("DELETE FROM tool_cache WHERE tool = ?"),
    };
  }

  /**
   * Look up a cache row by key.
   *
   * - Returns `null` when no row exists.
   * - Returns `null` AND deletes the row when `expires_at <= now` (lazy
   *   expiration — keeps cold-readers from polluting `last_accessed_at`).
   * - On hit, updates `last_accessed_at = now` (LRU promotion) and returns
   *   the fresh-LRU row.
   */
  get(key: string, now: number = Date.now()): CacheRow | null {
    const row = this.stmts.getByKey.get(key) as RawCacheRow | undefined;
    if (!row) return null;
    if (row.expires_at <= now) {
      // Lazy expiration — drop the stale row before returning miss.
      this.stmts.deleteByKey.run(key);
      return null;
    }
    // LRU promotion. Synchronous prepared statement; cheap.
    this.stmts.updateLru.run(now, key);
    return Object.freeze({ ...row, last_accessed_at: now });
  }

  /**
   * Insert or replace a cache row, then enforce the size cap via LRU
   * eviction. Insert + eviction run in ONE transaction so a partial failure
   * leaves the table consistent.
   *
   * `bytes` is computed from `Buffer.byteLength(response_json, "utf8")`.
   * `last_accessed_at` is set to `now` so the just-inserted row is the
   * most-recently-used (won't be evicted in this same call).
   */
  put(row: PutRow, maxSizeMb: number = DEFAULT_TOOL_CACHE_MAX_SIZE_MB): void {
    const bytes = Buffer.byteLength(row.response_json, "utf8");
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.stmts.insertOrReplace.run(
        row.key,
        row.tool,
        row.agent_or_null,
        row.response_json,
        row.created_at,
        row.expires_at,
        bytes,
        now,
      );
      this.evictIfNeededLocked(maxSizeMb, now);
    });
    tx();
  }

  /**
   * LRU eviction. Caller-locked — must run inside the calling transaction.
   *
   * Strategy:
   *   1. Compute total bytes; if under cap, return.
   *   2. Drop expired rows (cheap reclaim).
   *   3. Loop: find oldest by `last_accessed_at`, delete, decrement total;
   *      stop when under cap or table empty.
   */
  private evictIfNeededLocked(maxSizeMb: number, now: number): void {
    const limit = maxSizeMb * 1024 * 1024;
    let total = (this.stmts.sumBytes.get() as { total: number }).total;
    if (total <= limit) return;

    // Phase 1: drop expired rows.
    this.stmts.deleteExpired.run(now);
    total = (this.stmts.sumBytes.get() as { total: number }).total;

    // Phase 2: LRU evict until under cap.
    let safetyCounter = 100_000; // bounded loop — never infinite-spin
    while (total > limit && safetyCounter-- > 0) {
      const oldest = this.stmts.oldestByLru.get() as
        | { key: string; bytes: number }
        | undefined;
      if (!oldest) break;
      this.stmts.deleteByKey.run(oldest.key);
      total -= oldest.bytes;
    }
  }

  /** Total cached bytes / (1024*1024). Used by the size-metric reporter. */
  sizeMb(): number {
    const total = (this.stmts.sumBytes.get() as { total: number }).total;
    return total / (1024 * 1024);
  }

  /** Total row count. Used by `clawcode tool-cache status`. */
  rowCount(): number {
    return (
      (this.db.prepare("SELECT COUNT(*) AS n FROM tool_cache").get() as {
        n: number;
      }).n
    );
  }

  /**
   * Inspect rows for the CLI / dashboard. Filter by tool and/or agent. Most
   * recently accessed first.
   */
  inspect(
    opts: { tool?: string; agent?: string; limit?: number } = {},
  ): readonly CacheRow[] {
    const { tool, agent, limit = 100 } = opts;
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (tool) {
      where.push("tool = ?");
      params.push(tool);
    }
    if (agent) {
      where.push("agent_or_null = ?");
      params.push(agent);
    }
    const sql =
      "SELECT * FROM tool_cache" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY last_accessed_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as RawCacheRow[];
    return Object.freeze(rows.map((r) => Object.freeze({ ...r })));
  }

  /**
   * Aggregate top-N tools by row count. Used by `clawcode tool-cache status`
   * for the summary table.
   */
  topToolsByRows(
    limit: number = 10,
  ): readonly { tool: string; rows: number; bytes: number }[] {
    const rows = this.db
      .prepare(
        `SELECT tool, COUNT(*) AS rows_count, COALESCE(SUM(bytes), 0) AS bytes
         FROM tool_cache GROUP BY tool ORDER BY rows_count DESC LIMIT ?`,
      )
      .all(limit) as Array<{ tool: string; rows_count: number; bytes: number }>;
    return Object.freeze(
      rows.map((r) =>
        Object.freeze({ tool: r.tool, rows: r.rows_count, bytes: r.bytes }),
      ),
    );
  }

  /**
   * Clear all rows, or only rows for the given tool. Returns the row count
   * deleted.
   */
  clear(tool?: string): number {
    const result = tool
      ? this.stmts.clearByTool.run(tool)
      : this.stmts.clearAll.run();
    return Number(result.changes);
  }

  /** Underlying DB path (read-only). Test / CLI introspection. */
  getPath(): string {
    return this.path;
  }

  /** Close the database. Idempotent. */
  close(): void {
    this.db.close();
  }
}
