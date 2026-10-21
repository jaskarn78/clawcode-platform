/**
 * Phase 69 Plan 03 Task 1 — ApiKeySessionIndex (OPENAI-05).
 *
 * Per-bearer-key → Claude-session mapping stored in each agent's `memories.db`.
 *
 * Schema (migrated by `src/memory/store.ts` on every agent-memory init):
 *
 *   CREATE TABLE IF NOT EXISTS api_key_sessions (
 *     key_hash      TEXT PRIMARY KEY,   -- 64-char SHA-256 hex (from ApiKeysStore)
 *     agent_name    TEXT NOT NULL,      -- belt-and-suspenders integrity
 *     session_id    TEXT NOT NULL,      -- ConversationStore session id
 *     created_at    INTEGER NOT NULL,   -- epoch ms
 *     last_used_at  INTEGER NOT NULL    -- epoch ms (updated on every turn)
 *   );
 *   CREATE INDEX idx_api_key_sessions_agent ON api_key_sessions(agent_name);
 *
 * Isolation: two different `key_hash` values pointing at the same agent get
 * distinct `session_id` rows — one bearer key, one persistent conversation
 * (CONTEXT.md Auth & Session Mapping).
 *
 * Continuity: `session_id` is recorded on the first `result` event from the
 * Claude SDK and reused on every subsequent request with the same bearer key.
 * The mapping persists across daemon restarts because `memories.db` is on
 * disk (the same guarantee ConversationStore provides).
 *
 * Revoke path: `ApiKeySessionIndex.delete(keyHash)` clears the mapping so a
 * future create-with-same-agent-same-key starts a fresh session (the CLI
 * wires this into `clawcode openai-key revoke`).
 *
 * Zero imports from `src/manager/` — the driver in the same directory can
 * instantiate this against any `better-sqlite3.Database` handle (tests use
 * `:memory:`; production uses `sessionManager.getMemoryStore(agent)
 * .getDatabase()`).
 */

import type { Database } from "better-sqlite3";

/**
 * The canonical v1 migration SQL. Idempotent (CREATE TABLE IF NOT EXISTS +
 * CREATE INDEX IF NOT EXISTS) so it can run on every `MemoryStore` init
 * without conditional guards. Kept as a tombstone — production code reads
 * from v2; v1 table lives on for one release cycle as a safety net.
 */
export const API_KEY_SESSIONS_MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS api_key_sessions (
    key_hash      TEXT PRIMARY KEY,
    agent_name    TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_api_key_sessions_agent ON api_key_sessions(agent_name);
`;

/**
 * Quick task 260419-p51 — v2 migration (P51-SESSION-ISOLATION).
 *
 * Composite PK `(key_hash, agent_name)` — lets one bearer key hold DISTINCT
 * sessions per agent. SQLite doesn't support changing a PK in place, so we
 * created a new table rather than altering v1. `src/memory/store.ts` runs
 * this alongside the v1 create and copies rows over exactly once (guarded
 * by an "is v2 empty?" check).
 *
 * Idempotent: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`.
 */
export const API_KEY_SESSIONS_MIGRATION_V2_SQL = `
  CREATE TABLE IF NOT EXISTS api_key_sessions_v2 (
    key_hash      TEXT NOT NULL,
    agent_name    TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER NOT NULL,
    PRIMARY KEY(key_hash, agent_name)
  );
  CREATE INDEX IF NOT EXISTS idx_api_key_sessions_v2_agent ON api_key_sessions_v2(agent_name);
`;

/**
 * Row shape returned by `lookup` / `listForAgent`. Immutable; callers never
 * mutate these records in place.
 */
export interface ApiKeySessionRow {
  readonly key_hash: string;
  readonly agent_name: string;
  readonly session_id: string;
  readonly last_used_at: number;
}

/**
 * Typed wrapper over the `api_key_sessions` table. Pure synchronous calls
 * (better-sqlite3) — safe to construct on every request because every
 * method opens + closes a prepared statement internally (short-lived, no
 * cached state). Tests construct one per case; the driver constructs one
 * per dispatch.
 */
export class ApiKeySessionIndex {
  constructor(private readonly db: Database) {}

  /**
   * HOT PATH — called on every OpenAI-endpoint request. Looks up the
   * `(key_hash, agent_name)` pair in the v2 table. Returns `null` when
   * this bearer has never talked to THIS agent before (multi-agent keys
   * carry independent sessions per agent per P51-SESSION-ISOLATION).
   */
  lookup(
    keyHash: string,
    agentName: string,
  ): { session_id: string; agent_name: string } | null {
    const row = this.db
      .prepare(
        "SELECT session_id, agent_name FROM api_key_sessions_v2 WHERE key_hash = ? AND agent_name = ?",
      )
      .get(keyHash, agentName) as
      | { session_id: string; agent_name: string }
      | undefined;
    return row ?? null;
  }

  /**
   * Insert-or-update the mapping. Uses `ON CONFLICT(key_hash, agent_name)
   * DO UPDATE` so session rotation (SDK returns a new session_id post-fork /
   * post-compact) quietly overwrites the stored value for THIS agent only —
   * other agents' sessions for the same key remain untouched.
   */
  record(keyHash: string, agentName: string, sessionId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO api_key_sessions_v2
           (key_hash, agent_name, session_id, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key_hash, agent_name) DO UPDATE SET
           session_id = excluded.session_id,
           last_used_at = excluded.last_used_at`,
      )
      .run(keyHash, agentName, sessionId, now, now);
  }

  /**
   * Stamp `last_used_at = Date.now()` for observability. Silent no-op if
   * the row doesn't exist. Scope: the single `(keyHash, agentName)` pair —
   * other agents' rows for the same key are not affected.
   */
  touch(keyHash: string, agentName: string): void {
    this.db
      .prepare(
        "UPDATE api_key_sessions_v2 SET last_used_at = ? WHERE key_hash = ? AND agent_name = ?",
      )
      .run(Date.now(), keyHash, agentName);
  }

  /**
   * Revoke path — removes ALL mappings for `keyHash` across every agent.
   * Called by the CLI revoke flow when a key is disabled: we don't want
   * session residue sticking around on ANY agent after the bearer dies.
   * Returns `true` if one or more rows were deleted.
   */
  delete(keyHash: string): boolean {
    const result = this.db
      .prepare("DELETE FROM api_key_sessions_v2 WHERE key_hash = ?")
      .run(keyHash);
    return result.changes > 0;
  }

  /**
   * Enumerate all mappings for `agentName`, newest-first. Observability
   * helper — used by the CLI `openai-key list` path to report "what sessions
   * live on this agent right now?".
   */
  listForAgent(agentName: string): ReadonlyArray<ApiKeySessionRow> {
    const rows = this.db
      .prepare(
        `SELECT key_hash, agent_name, session_id, last_used_at
         FROM api_key_sessions_v2
         WHERE agent_name = ?
         ORDER BY last_used_at DESC`,
      )
      .all(agentName) as ReadonlyArray<ApiKeySessionRow>;
    return rows;
  }
}

/**
 * Convenience wrapper — one-shot lookup without constructing an index
 * instance. Equivalent to `new ApiKeySessionIndex(db).lookup(keyHash, agentName)`.
 */
export function lookupSessionForKey(
  db: Database,
  keyHash: string,
  agentName: string,
): { session_id: string; agent_name: string } | null {
  return new ApiKeySessionIndex(db).lookup(keyHash, agentName);
}

/**
 * Convenience wrapper — one-shot record without constructing an index
 * instance. Used by the driver when the first SDK `result` event lands and
 * a brand-new `session_id` needs to be persisted.
 */
export function recordSessionForKey(
  db: Database,
  keyHash: string,
  agentName: string,
  sessionId: string,
): void {
  new ApiKeySessionIndex(db).record(keyHash, agentName, sessionId);
}
