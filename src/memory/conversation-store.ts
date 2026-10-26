/**
 * ConversationStore -- Session lifecycle management and turn recording.
 *
 * Provides CRUD operations for conversation_sessions and conversation_turns
 * tables created by MemoryStore.migrateConversationTables(). Enforces the
 * session state machine: active -> ended/crashed -> summarized.
 *
 * All returned objects and arrays are Object.freeze()d per project immutability
 * convention. Boolean conversion for is_trusted_channel (SQLite INTEGER 0/1
 * to JS boolean) is handled in row conversion helpers.
 *
 * Receives DatabaseType directly (not MemoryStore) since ConversationStore
 * does not use MemoryStore.insert().
 */

import type { Database as DatabaseType, Statement } from "better-sqlite3";
import { nanoid } from "nanoid";
import { SINCE_FLOOR, UNTIL_CEIL } from "./time-window.js";
import type {
  ConversationSession,
  ConversationTurn,
  ConversationTurnSearchResult,
  RecordTurnInput,
  SearchArchiveOptions,
  SearchArchiveResult,
  SearchTurnsOptions,
  SearchTurnsResult,
  SessionArchiveRow,
  SessionArchiveSearchResult,
} from "./conversation-types.js";

/**
 * Escape an agent-provided query for safe use in an FTS5 MATCH expression.
 *
 * Phrase-quotes the trimmed input and doubles any embedded double-quotes.
 * FTS5 MATCH syntax reserves `:` (column filters), `()` (boolean groups),
 * `"` (phrase delimiters), `*`, `-`, `+`, `NEAR`, `AND`/`OR`/`NOT`. Agents
 * write natural language, so naive interpolation crashes the parser with
 * `fts5: syntax error near ...` — see Pitfall 1 in 68-RESEARCH.md.
 *
 * Empty/whitespace input returns `""` which is a valid phrase that
 * matches nothing (never throws). This is the "dumb but safe" strategy
 * the phase explicitly chose; boolean operator support is a future
 * enhancement if dogfooding surfaces a concrete need.
 */
export function escapeFtsQuery(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '""';
  const escaped = trimmed.replace(/"/g, '""');
  return `"${escaped}"`;
}

/** Raw session row shape from SQLite. */
type SessionRow = {
  readonly id: string;
  readonly agent_name: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly turn_count: number;
  readonly total_tokens: number;
  readonly summary_memory_id: string | null;
  readonly status: string;
};

/** Raw turn row shape from SQLite. */
type TurnRow = {
  readonly id: string;
  readonly session_id: string;
  readonly turn_index: number;
  readonly role: string;
  readonly content: string;
  readonly token_count: number | null;
  readonly channel_id: string | null;
  readonly discord_user_id: string | null;
  readonly discord_message_id: string | null;
  readonly is_trusted_channel: number;
  readonly origin: string | null;
  readonly instruction_flags: string | null;
  readonly created_at: string;
};

/** Prepared statements for all conversation operations. */
type ConversationStatements = {
  readonly insertSession: Statement;
  readonly updateSessionEnd: Statement;
  readonly updateSessionCrash: Statement;
  readonly updateSessionSummarized: Statement;
  readonly getSession: Statement;
  readonly listSessions: Statement;
  /**
   * agents-forget-across-sessions debug (2026-04-19): terminated-only listing
   * used by the resume-brief gap check. Excludes status='active' so a
   * just-started session doesn't collapse the gap to zero on every daemon
   * boot (Phase 67 SESS-03 production bug).
   */
  readonly listRecentTerminatedSessions: Statement;
  /**
   * Phase 99-C: backlog drain query — sessions in terminal status
   * ('ended' | 'crashed') that DO carry turn rows but have NEVER been
   * summarized (`summary_memory_id IS NULL`). Ordered by oldest first so
   * the heartbeat drain processes the historical backlog before recent
   * misses.
   */
  readonly listPendingSummarySessions: Statement;
  readonly insertTurn: Statement;
  readonly getTurnsForSession: Statement;
  readonly getTurnsForSessionLimited: Statement;
  readonly getSessionTurnCount: Statement;
  readonly incrementTurnCount: Statement;
  readonly addTokens: Statement;
  // Phase 68 — RETR-02: FTS5 search over conversation_turns.content
  readonly searchTurnsFts: Statement;
  readonly searchTurnsFtsUntrusted: Statement;
  readonly searchTurnsCount: Statement;
  readonly searchTurnsCountUntrusted: Statement;
  // Gap 2 (memory-persistence-gaps): prune raw turns after summarization.
  readonly deleteTurnsForSession: Statement;
  // Phase 999.42 capability A — durable session archive.
  readonly archiveSessionInsert: Statement;
  readonly hasArchiveSelect: Statement;
  // Phase 999.42 capability A (Plan 02) — one-shot summary-only backfill.
  readonly listSummarizedSessions: Statement;
  readonly getMemoryContentById: Statement;
  readonly hasBackfillMigration: Statement;
  readonly insertBackfillMigration: Statement;
  // Phase 999.42 capability A (Plan 03) — FTS5 search over session_archive.
  // Two-statement SEC-01 split mirroring searchTurnsFts / searchTurnsFtsUntrusted.
  readonly searchArchiveFts: Statement;
  readonly searchArchiveFtsUntrusted: Statement;
  readonly searchArchiveCount: Statement;
  readonly searchArchiveCountUntrusted: Statement;
};

/** Convert a raw SQLite session row to an immutable ConversationSession. */
function rowToSession(row: SessionRow): ConversationSession {
  return Object.freeze({
    id: row.id,
    agentName: row.agent_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    turnCount: row.turn_count,
    totalTokens: row.total_tokens,
    summaryMemoryId: row.summary_memory_id,
    status: row.status as ConversationSession["status"],
  });
}

/**
 * Convert a raw SQLite turn row to an immutable ConversationTurn.
 * CRITICAL: is_trusted_channel INTEGER (0/1) is converted to boolean.
 */
function rowToTurn(row: TurnRow): ConversationTurn {
  return Object.freeze({
    id: row.id,
    sessionId: row.session_id,
    turnIndex: row.turn_index,
    role: row.role as ConversationTurn["role"],
    content: row.content,
    tokenCount: row.token_count,
    channelId: row.channel_id,
    discordUserId: row.discord_user_id,
    discordMessageId: row.discord_message_id,
    isTrustedChannel: row.is_trusted_channel === 1,
    origin: row.origin,
    instructionFlags: row.instruction_flags,
    createdAt: row.created_at,
  });
}

/**
 * ConversationStore -- manages conversation session lifecycle and turn recording.
 *
 * Constructor receives a better-sqlite3 Database instance (from store.getDatabase()).
 * Tables must already exist (created by MemoryStore.migrateConversationTables()).
 *
 * Session state machine:
 *   active -> ended   (endSession)
 *   active -> crashed  (crashSession)
 *   ended  -> summarized (markSummarized)
 *   crashed -> summarized (markSummarized)
 *
 * All other transitions throw.
 */
export class ConversationStore {
  private readonly db: DatabaseType;
  /** Phase 999.125 — lazily prepared time-bounded search variants, keyed by shape. */
  private readonly rangeStmts: Map<string, Statement> = new Map();
  private readonly stmts: ConversationStatements;

  constructor(db: DatabaseType) {
    this.db = db;
    this.stmts = this.prepareStatements();
  }

  /**
   * Phase 91 Plan 03 — expose the underlying better-sqlite3 handle for
   * specialized consumers (conversation-turn-translator.ts) that need
   * INSERT OR IGNORE against the UNIQUE(session_id, turn_index, role)
   * index for idempotent historical imports.
   *
   * Parallels the existing MemoryStore.getDatabase() accessor — do NOT
   * use for general CRUD; go through the typed methods above instead.
   */
  getDatabase(): DatabaseType {
    return this.db;
  }

  // ── Phase 999.119 pass 2 — session hygiene ────────────────────────────
  //
  // A row is opened at every agent start and closed only by a clean stop
  // or an observed crash. Daemon restarts, kills and short-lived derived
  // sessions never closed theirs, so the table filled with `active` rows
  // that were nothing of the sort (Admin Clawdy: 263 active, 177 of them
  // with zero turns, on 2026-09-05). These three methods are the only
  // writers that touch rows they did not create; each is narrow on purpose.

  /**
   * Close every OTHER `active` row for `agentName` as `crashed` — called
   * right after `startSession` so a restart never leaves the previous
   * run's row open. Rows with turns become eligible for the summary drain.
   * Returns rows changed.
   */
  closeStaleActiveSessions(agentName: string, keepSessionId: string | null): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE conversation_sessions
         SET status = 'crashed', ended_at = ?
         WHERE agent_name = ? AND status = 'active' AND id != ?`,
      )
      .run(now, agentName, keepSessionId ?? "");
    return result.changes;
  }

  /**
   * Close `active` rows whose agent name is NOT currently running and that
   * started before `startedBefore` (ISO) — forks, subagent threads and
   * pool sessions that were torn down without ending their row. Returns
   * rows changed. An empty `runningAgentNames` closes every qualifying row.
   */
  closeOrphanedActiveSessions(
    runningAgentNames: readonly string[],
    startedBefore: string,
  ): number {
    const now = new Date().toISOString();
    const placeholders = runningAgentNames.map(() => "?").join(", ");
    const notRunning =
      runningAgentNames.length === 0 ? "" : ` AND agent_name NOT IN (${placeholders})`;
    const result = this.db
      .prepare(
        `UPDATE conversation_sessions
         SET status = 'crashed', ended_at = ?
         WHERE status = 'active' AND started_at < ?${notRunning}`,
      )
      .run(now, startedBefore, ...runningAgentNames);
    return result.changes;
  }

  /**
   * Delete terminated rows that carry no turns and no archive entry and
   * started before `startedBefore` (ISO). Nothing downstream can ever use
   * such a row: the summary drain skips zero-turn sessions and the resume
   * brief filters them out. Returns rows deleted.
   */
  pruneEmptyTerminatedSessions(startedBefore: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM conversation_sessions
         WHERE status IN ('ended', 'crashed', 'summarized')
           AND started_at < ?
           AND NOT EXISTS (SELECT 1 FROM conversation_turns t WHERE t.session_id = conversation_sessions.id)
           AND NOT EXISTS (SELECT 1 FROM session_archive a WHERE a.session_id = conversation_sessions.id)`,
      )
      .run(startedBefore);
    return result.changes;
  }

  /** Counts for the memory doctor / fleet brief. `staleActiveBefore` is ISO. */
  getSessionHealth(staleActiveBefore: string, emptyTerminatedBefore: string): Readonly<{
    total: number;
    active: number;
    activeEmpty: number;
    staleActive: number;
    emptyTerminated: number;
  }> {
    const n = (sql: string, ...params: unknown[]): number =>
      (this.db.prepare(sql).get(...params) as { n: number }).n;
    return Object.freeze({
      total: n("SELECT COUNT(*) AS n FROM conversation_sessions"),
      active: n("SELECT COUNT(*) AS n FROM conversation_sessions WHERE status = 'active'"),
      activeEmpty: n(
        `SELECT COUNT(*) AS n FROM conversation_sessions s
         WHERE status = 'active'
           AND NOT EXISTS (SELECT 1 FROM conversation_turns t WHERE t.session_id = s.id)`,
      ),
      staleActive: n(
        "SELECT COUNT(*) AS n FROM conversation_sessions WHERE status = 'active' AND started_at < ?",
        staleActiveBefore,
      ),
      emptyTerminated: n(
        `SELECT COUNT(*) AS n FROM conversation_sessions s
         WHERE status IN ('ended', 'crashed', 'summarized')
           AND started_at < ?
           AND NOT EXISTS (SELECT 1 FROM conversation_turns t WHERE t.session_id = s.id)
           AND NOT EXISTS (SELECT 1 FROM session_archive a WHERE a.session_id = s.id)`,
        emptyTerminatedBefore,
      ),
    });
  }

  /**
   * Create a new conversation session for the given agent.
   * Returns a frozen ConversationSession with status="active".
   */
  startSession(agentName: string): ConversationSession {
    const id = nanoid();
    const now = new Date().toISOString();

    this.stmts.insertSession.run(id, agentName, now);

    return Object.freeze({
      id,
      agentName,
      startedAt: now,
      endedAt: null,
      turnCount: 0,
      totalTokens: 0,
      summaryMemoryId: null,
      status: "active" as const,
    });
  }

  /**
   * End an active session. Sets status="ended" and records ended_at.
   * Throws if the session is not in "active" status.
   */
  endSession(sessionId: string): ConversationSession {
    const now = new Date().toISOString();
    const result = this.stmts.updateSessionEnd.run(now, sessionId);

    if (result.changes === 0) {
      throw new Error(
        `Cannot end session '${sessionId}': not found or not in 'active' status`,
      );
    }

    const row = this.stmts.getSession.get(sessionId) as SessionRow;
    return rowToSession(row);
  }

  /**
   * Crash an active session. Sets status="crashed" and records ended_at.
   * Throws if the session is not in "active" status.
   */
  crashSession(sessionId: string): ConversationSession {
    const now = new Date().toISOString();
    const result = this.stmts.updateSessionCrash.run(now, sessionId);

    if (result.changes === 0) {
      throw new Error(
        `Cannot crash session '${sessionId}': not found or not in 'active' status`,
      );
    }

    const row = this.stmts.getSession.get(sessionId) as SessionRow;
    return rowToSession(row);
  }

  /**
   * Mark an ended or crashed session as summarized with a link to the summary memory.
   *
   * Idempotent: if the session is already in status 'summarized', returns the
   * existing row without error — this handles the benign race where the
   * crash-path fire-and-forget summarizer and the stop-path awaited
   * summarizer both run to completion (each observes status=ended/crashed
   * in its own snapshot, then the winner flips it to summarized; the loser
   * USED to emit a misleading warn). Memory row is still present; the
   * winning caller already persisted the FK.
   *
   * Throws only when the session row does not exist or is still in 'active'
   * status (caller must have forgotten to end/crash it first).
   */
  markSummarized(
    sessionId: string,
    summaryMemoryId: string,
  ): ConversationSession {
    const result = this.stmts.updateSessionSummarized.run(
      summaryMemoryId,
      sessionId,
    );

    if (result.changes === 0) {
      // Distinguish "already summarized" (idempotent no-op) from
      // "not found" / "still active" (real error).
      const row = this.stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (!row) {
        throw new Error(
          `Cannot mark session '${sessionId}' as summarized: session not found`,
        );
      }
      if (row.status === "summarized") {
        return rowToSession(row);
      }
      throw new Error(
        `Cannot mark session '${sessionId}' as summarized: session is in status '${row.status}' (expected 'ended' or 'crashed')`,
      );
    }

    const row = this.stmts.getSession.get(sessionId) as SessionRow;
    return rowToSession(row);
  }

  /**
   * Retrieve a session by ID.
   * Returns null if not found.
   */
  getSession(sessionId: string): ConversationSession | null {
    const row = this.stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!row) return null;
    return rowToSession(row);
  }

  /**
   * List recent sessions for an agent, ordered by started_at DESC.
   * Returns a frozen array of frozen ConversationSession objects.
   */
  listRecentSessions(
    agentName: string,
    limit: number,
  ): readonly ConversationSession[] {
    const rows = this.stmts.listSessions.all(agentName, limit) as SessionRow[];
    return Object.freeze(rows.map(rowToSession));
  }

  /**
   * List recent TERMINATED sessions (status IN 'ended' | 'crashed' |
   * 'summarized'), ordered by started_at DESC. Excludes status='active'.
   *
   * agents-forget-across-sessions debug (2026-04-19): Phase 67 SESS-03's gap
   * check MUST measure gap against the most-recent previously-terminated
   * session. In production, SessionManager.startAgent creates a fresh
   * active session BEFORE buildSessionConfig runs; listRecentSessions(1)
   * would return that just-created row, collapse the gap to ~0ms, and
   * gap-skip the brief on every daemon boot. This variant filters it out.
   *
   * An 'active' row from a prior hard crash (no graceful shutdown, no
   * crash-handler fired) is also excluded — the brief simply falls through
   * to "no prior terminated session" and renders anyway, which is the
   * correct behaviour (we don't know when that orphan truly ended, so we
   * should not silently suppress recall).
   */
  listRecentTerminatedSessions(
    agentName: string,
    limit: number,
  ): readonly ConversationSession[] {
    const rows = this.stmts.listRecentTerminatedSessions.all(
      agentName,
      limit,
    ) as SessionRow[];
    return Object.freeze(rows.map(rowToSession));
  }

  /**
   * Phase 99-C: list sessions in terminal status that have NEVER been
   * summarized (`summary_memory_id IS NULL`) AND carry at least one turn
   * row. Ordered ASC so the heartbeat backlog drain processes the oldest
   * historical miss first. Caller (heartbeat check via SessionManager)
   * runs `summarizeSession` for each returned session.
   *
   * Excludes status='summarized' (already done) and status='active' (the
   * stop/crash trigger sites haven't fired yet — premature summarization
   * would race the in-flight session). Excludes zero-turn sessions because
   * `summarizeSession` skips them with reason='zero-turns' regardless.
   */
  listPendingSummarySessions(
    agentName: string,
    limit: number,
  ): readonly ConversationSession[] {
    const rows = this.stmts.listPendingSummarySessions.all(
      agentName,
      limit,
    ) as SessionRow[];
    return Object.freeze(rows.map(rowToSession));
  }

  /**
   * Record a new turn in a conversation session.
   *
   * Uses a transaction to atomically:
   * 1. Read the current turn_count from the session
   * 2. Insert the turn with turn_index = current turn_count
   * 3. Increment the session's turn_count
   * 4. Add tokenCount to the session's total_tokens
   *
   * Converts isTrustedChannel boolean to SQLite INTEGER (0/1).
   * Returns a frozen ConversationTurn.
   */
  recordTurn(input: RecordTurnInput): ConversationTurn {
    const id = nanoid();
    const now = new Date().toISOString();
    const tokenCount = input.tokenCount ?? null;
    const channelId = input.channelId ?? null;
    const discordUserId = input.discordUserId ?? null;
    const discordMessageId = input.discordMessageId ?? null;
    const isTrustedChannel = input.isTrustedChannel === true ? 1 : 0;
    const origin = input.origin ?? null;
    const instructionFlags = input.instructionFlags ?? null;

    const turnIndex = this.db.transaction(() => {
      // Get current turn_count as the next turn_index
      const sessionRow = this.stmts.getSessionTurnCount.get(
        input.sessionId,
      ) as { turn_count: number } | undefined;

      if (!sessionRow) {
        throw new Error(
          `Cannot record turn: session '${input.sessionId}' not found`,
        );
      }

      const idx = sessionRow.turn_count;

      // Insert the turn
      this.stmts.insertTurn.run(
        id,
        input.sessionId,
        idx,
        input.role,
        input.content,
        tokenCount,
        channelId,
        discordUserId,
        discordMessageId,
        isTrustedChannel,
        origin,
        instructionFlags,
        now,
      );

      // Increment turn_count
      this.stmts.incrementTurnCount.run(input.sessionId);

      // Add tokens
      if (tokenCount !== null) {
        this.stmts.addTokens.run(tokenCount, input.sessionId);
      }

      return idx;
    })();

    return Object.freeze({
      id,
      sessionId: input.sessionId,
      turnIndex,
      role: input.role,
      content: input.content,
      tokenCount,
      channelId,
      discordUserId,
      discordMessageId,
      isTrustedChannel: isTrustedChannel === 1,
      origin,
      instructionFlags,
      createdAt: now,
    });
  }

  /**
   * Get all turns for a session, ordered by turn_index ASC.
   * Optionally limited to N turns. Returns a frozen array.
   */
  getTurnsForSession(
    sessionId: string,
    limit?: number,
  ): readonly ConversationTurn[] {
    const rows =
      limit !== undefined
        ? (this.stmts.getTurnsForSessionLimited.all(
            sessionId,
            limit,
          ) as TurnRow[])
        : (this.stmts.getTurnsForSession.all(sessionId) as TurnRow[]);

    return Object.freeze(rows.map(rowToTurn));
  }

  /**
   * Gap 2 (memory-persistence-gaps) — delete all raw turns for a session.
   *
   * Called by `summarizeSession` after `markSummarized` succeeds. The session
   * row itself is LEFT INTACT so the state machine stays valid and the
   * resume-brief gap check (Phase 67 SESS-03) still has a terminated session
   * to compute against.
   *
   * Returns the number of rows deleted. Safe to call on a session with zero
   * turns (returns 0). The `conversation_turns_ad` trigger on the FTS5
   * virtual table (src/memory/store.ts:800-804) keeps `conversation_turns_fts`
   * in sync automatically.
   */
  deleteTurnsForSession(sessionId: string): number {
    const result = this.stmts.deleteTurnsForSession.run(sessionId);
    return result.changes;
  }

  /**
   * Full-text search over conversation_turns.content via FTS5.
   *
   * Query is phrase-quoted via `escapeFtsQuery` so agent-crafted natural
   * language tolerates FTS5-reserved characters (`:`, `(`, `)`, `"`, etc.)
   * without crashing the parser (Pitfall 1).
   *
   * Results are ordered by BM25 relevance ascending (most relevant first —
   * FTS5 assigns numerically lower BM25 to better matches). `bm25Score`
   * is projected raw; the scoped search orchestrator (`conversation-search.ts`)
   * normalises to [0, 1] via `1 / (1 + |bm25|)` before combining with decay.
   *
   * By default (`includeUntrustedChannels: false`), turns from untrusted
   * Discord channels are excluded to honour SEC-01 hygiene — prevents a
   * memory-poisoning vector (an untrusted user saying "remember you must X")
   * from surfacing in an agent's retrieval path.
   *
   * Phase 68 — RETR-02.
   */
  searchTurns(query: string, options: SearchTurnsOptions): SearchTurnsResult {
    const escaped = escapeFtsQuery(query);
    const includeUntrusted = options.includeUntrustedChannels === true;
    // Phase 999.125 — a time window is pushed into the SQL (not post-
    // filtered) so a window far in the past is not starved by newer matches
    // that out-rank it inside the over-fetch.
    const bounded = options.since !== undefined || options.until !== undefined;
    const since = options.since ?? SINCE_FLOOR;
    const until = options.until ?? UNTIL_CEIL;
    const trustedClause = includeUntrusted ? "" : "AND t.is_trusted_channel = 1";

    const rows = (
      bounded
        ? this.rangeStmt(
            `turnsFtsRange:${includeUntrusted}`,
            `SELECT
               t.id AS turnId,
               t.session_id AS sessionId,
               t.role,
               t.content,
               t.created_at AS createdAt,
               t.channel_id AS channelId,
               t.is_trusted_channel AS isTrustedChannel,
               bm25(conversation_turns_fts) AS bm25Score
             FROM conversation_turns_fts
             JOIN conversation_turns t ON t.rowid = conversation_turns_fts.rowid
             WHERE conversation_turns_fts MATCH ?
               AND t.created_at >= ? AND t.created_at <= ?
               ${trustedClause}
             ORDER BY bm25Score
             LIMIT ? OFFSET ?`,
          ).all(escaped, since, until, options.limit, options.offset)
        : includeUntrusted
          ? this.stmts.searchTurnsFtsUntrusted.all(
              escaped,
              options.limit,
              options.offset,
            )
          : this.stmts.searchTurnsFts.all(escaped, options.limit, options.offset)
    ) as Array<{
      turnId: string;
      sessionId: string;
      role: string;
      content: string;
      bm25Score: number;
      createdAt: string;
      channelId: string | null;
      isTrustedChannel: number;
    }>;

    const countRow = (
      bounded
        ? this.rangeStmt(
            `turnsCountRange:${includeUntrusted}`,
            `SELECT COUNT(*) AS total
             FROM conversation_turns_fts
             JOIN conversation_turns t ON t.rowid = conversation_turns_fts.rowid
             WHERE conversation_turns_fts MATCH ?
               AND t.created_at >= ? AND t.created_at <= ?
               ${trustedClause}`,
          ).get(escaped, since, until)
        : includeUntrusted
          ? this.stmts.searchTurnsCountUntrusted.get(escaped)
          : this.stmts.searchTurnsCount.get(escaped)
    ) as { total: number } | undefined;

    const results: readonly ConversationTurnSearchResult[] = Object.freeze(
      rows.map((r) =>
        Object.freeze({
          turnId: r.turnId,
          sessionId: r.sessionId,
          role: r.role as "user" | "assistant" | "system",
          content: r.content,
          bm25Score: r.bm25Score,
          createdAt: r.createdAt,
          channelId: r.channelId,
          isTrustedChannel: r.isTrustedChannel === 1,
        }),
      ),
    );

    return Object.freeze({
      results,
      totalMatches: countRow?.total ?? 0,
    });
  }

  /** Phase 999.125 — prepare-once cache for the time-bounded statement shapes. */
  private rangeStmt(key: string, sql: string): Statement {
    const cached = this.rangeStmts.get(key);
    if (cached) return cached;
    const stmt = this.db.prepare(sql);
    this.rangeStmts.set(key, stmt);
    return stmt;
  }

  /**
   * Phase 999.125 — chronological browse: every turn whose `created_at`
   * falls inside the window, newest first, no query. Same SEC-01 trusted
   * filter as `searchTurns`. `bm25Score` is 0 (no relevance ranking).
   */
  listTurnsInRange(options: SearchTurnsOptions): SearchTurnsResult {
    const includeUntrusted = options.includeUntrustedChannels === true;
    const since = options.since ?? SINCE_FLOOR;
    const until = options.until ?? UNTIL_CEIL;
    const trustedClause = includeUntrusted ? "" : "AND is_trusted_channel = 1";
    const rows = this.rangeStmt(
      `turnsListRange:${includeUntrusted}`,
      `SELECT id AS turnId, session_id AS sessionId, role, content,
              created_at AS createdAt, channel_id AS channelId,
              is_trusted_channel AS isTrustedChannel
       FROM conversation_turns
       WHERE created_at >= ? AND created_at <= ? ${trustedClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(since, until, options.limit, options.offset) as Array<{
      turnId: string;
      sessionId: string;
      role: string;
      content: string;
      createdAt: string;
      channelId: string | null;
      isTrustedChannel: number;
    }>;
    const countRow = this.rangeStmt(
      `turnsListCountRange:${includeUntrusted}`,
      `SELECT COUNT(*) AS total FROM conversation_turns
       WHERE created_at >= ? AND created_at <= ? ${trustedClause}`,
    ).get(since, until) as { total: number } | undefined;
    return Object.freeze({
      results: Object.freeze(
        rows.map((r) =>
          Object.freeze({
            turnId: r.turnId,
            sessionId: r.sessionId,
            role: r.role as "user" | "assistant" | "system",
            content: r.content,
            bm25Score: 0,
            createdAt: r.createdAt,
            channelId: r.channelId,
            isTrustedChannel: r.isTrustedChannel === 1,
          }),
        ),
      ),
      totalMatches: countRow?.total ?? 0,
    });
  }

  /**
   * Phase 999.125 — chronological browse over `session_archive`: sessions
   * whose span overlaps the window, most recently started first. Same
   * SEC-01 untrusted-row filter as `searchArchive`. `bm25Score` is 0.
   */
  listArchiveInRange(options: SearchArchiveOptions): SearchArchiveResult {
    const includeUntrusted = options.includeUntrustedChannels === true;
    const since = options.since ?? SINCE_FLOOR;
    const until = options.until ?? UNTIL_CEIL;
    const trustedClause = includeUntrusted ? "" : "AND has_untrusted_turn = 0";
    const where = `WHERE COALESCE(started_at, archived_at) <= ?
         AND COALESCE(ended_at, archived_at) >= ? ${trustedClause}`;
    const rows = this.rangeStmt(
      `archiveListRange:${includeUntrusted}`,
      `SELECT session_id AS sessionId, agent_name AS agentName,
              archived_from AS archivedFrom, has_untrusted_turn AS hasUntrustedTurn,
              full_text AS fullText, archived_at AS archivedAt,
              started_at AS startedAt, ended_at AS endedAt
       FROM session_archive
       ${where}
       ORDER BY COALESCE(started_at, archived_at) DESC
       LIMIT ? OFFSET ?`,
    ).all(until, since, options.limit, options.offset) as Array<{
      sessionId: string;
      agentName: string;
      archivedFrom: string;
      hasUntrustedTurn: number;
      fullText: string;
      archivedAt: string;
      startedAt: string;
      endedAt: string | null;
    }>;
    const countRow = this.rangeStmt(
      `archiveListCountRange:${includeUntrusted}`,
      `SELECT COUNT(*) AS total FROM session_archive ${where}`,
    ).get(until, since) as { total: number } | undefined;
    return Object.freeze({
      results: Object.freeze(
        rows.map((r) =>
          Object.freeze({
            sessionId: r.sessionId,
            agentName: r.agentName,
            archivedFrom: r.archivedFrom as SessionArchiveSearchResult["archivedFrom"],
            hasUntrustedTurn: r.hasUntrustedTurn === 1,
            fullText: r.fullText,
            bm25Score: 0,
            archivedAt: r.archivedAt,
            startedAt: r.startedAt,
            endedAt: r.endedAt,
          }),
        ),
      ),
      totalMatches: countRow?.total ?? 0,
    });
  }

  /**
   * Phase 999.42 capability A (Plan 03 / CONTEXT D3) — full-text search over
   * `session_archive.full_text` via the `session_archive_fts` FTS5 index.
   *
   * This is the retrieval side of capability A: content from a session that
   * was CONSOLIDATED (raw turns pruned, `conversation_turns_fts` rows wiped by
   * the `conversation_turns_ad` trigger) is still findable here, because the
   * `session_archive` row survives the prune. `searchByScope` wires this in as
   * a fourth candidate path.
   *
   * Query is phrase-quoted via `escapeFtsQuery` — the SAME hardening as
   * `searchTurns`, so agent-crafted natural language tolerates FTS5-reserved
   * characters (`:`, `(`, `)`, `"`, etc.) without crashing the parser
   * (Pitfall 1). An empty/whitespace query becomes the `""` phrase and
   * matches nothing — never throws.
   *
   * Results are ordered by BM25 ascending (most relevant first — FTS5 assigns
   * numerically lower BM25 to better matches). `bm25Score` is projected raw;
   * the scoped-search orchestrator normalises to [0, 1] via `1 / (1 + |bm25|)`.
   *
   * SEC-01 default-exclude: with `includeUntrustedChannels` false/omitted
   * (the default), archive rows where `has_untrusted_turn=1` are EXCLUDED from
   * both `results` and `totalMatches`. An `archivedFrom='full'` row carries
   * RAW turn text — if any turn came from an untrusted Discord channel it is a
   * stronger prompt-injection vector than the Haiku-paraphrased summary. This
   * mirrors the Phase 68 `searchTurns includeUntrustedChannels:false` posture
   * verbatim via the same two-statement pattern (`searchArchiveFts` excludes
   * untrusted rows; `searchArchiveFtsUntrusted` includes all). Summary-only
   * archive rows always carry `has_untrusted_turn=0`, so they always pass the
   * filter.
   *
   * Phase 999.42 — capability A, A4.
   */
  searchArchive(
    query: string,
    options: SearchArchiveOptions,
  ): SearchArchiveResult {
    const escaped = escapeFtsQuery(query);
    const includeUntrusted = options.includeUntrustedChannels === true;
    // Phase 999.125 — window = overlap with the session's span.
    const bounded = options.since !== undefined || options.until !== undefined;
    const since = options.since ?? SINCE_FLOOR;
    const until = options.until ?? UNTIL_CEIL;
    const trustedClause = includeUntrusted ? "" : "AND s.has_untrusted_turn = 0";

    const rows = (
      bounded
        ? this.rangeStmt(
            `archiveFtsRange:${includeUntrusted}`,
            `SELECT
               s.session_id AS sessionId,
               s.agent_name AS agentName,
               s.archived_from AS archivedFrom,
               s.has_untrusted_turn AS hasUntrustedTurn,
               s.full_text AS fullText,
               bm25(session_archive_fts) AS bm25Score,
               s.archived_at AS archivedAt,
               s.started_at AS startedAt,
               s.ended_at AS endedAt
             FROM session_archive_fts
             JOIN session_archive s ON s.rowid = session_archive_fts.rowid
             WHERE session_archive_fts MATCH ?
               AND COALESCE(s.started_at, s.archived_at) <= ?
               AND COALESCE(s.ended_at, s.archived_at) >= ?
               ${trustedClause}
             ORDER BY bm25Score
             LIMIT ? OFFSET ?`,
          ).all(escaped, until, since, options.limit, options.offset)
        : includeUntrusted
          ? this.stmts.searchArchiveFtsUntrusted.all(
              escaped,
              options.limit,
              options.offset,
            )
          : this.stmts.searchArchiveFts.all(
              escaped,
              options.limit,
              options.offset,
            )
    ) as Array<{
      sessionId: string;
      agentName: string;
      archivedFrom: string;
      hasUntrustedTurn: number;
      fullText: string;
      bm25Score: number;
      archivedAt: string;
      startedAt: string;
      endedAt: string | null;
    }>;

    const countRow = (
      bounded
        ? this.rangeStmt(
            `archiveCountRange:${includeUntrusted}`,
            `SELECT COUNT(*) AS total
             FROM session_archive_fts
             JOIN session_archive s ON s.rowid = session_archive_fts.rowid
             WHERE session_archive_fts MATCH ?
               AND COALESCE(s.started_at, s.archived_at) <= ?
               AND COALESCE(s.ended_at, s.archived_at) >= ?
               ${trustedClause}`,
          ).get(escaped, until, since)
        : includeUntrusted
          ? this.stmts.searchArchiveCountUntrusted.get(escaped)
          : this.stmts.searchArchiveCount.get(escaped)
    ) as { total: number } | undefined;

    const results: readonly SessionArchiveSearchResult[] = Object.freeze(
      rows.map((r) =>
        Object.freeze({
          sessionId: r.sessionId,
          agentName: r.agentName,
          archivedFrom: r.archivedFrom as SessionArchiveSearchResult["archivedFrom"],
          hasUntrustedTurn: r.hasUntrustedTurn === 1,
          fullText: r.fullText,
          bm25Score: r.bm25Score,
          archivedAt: r.archivedAt,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
        }),
      ),
    );

    return Object.freeze({
      results,
      totalMatches: countRow?.total ?? 0,
    });
  }

  /**
   * Phase 999.42 capability A — write a durable `session_archive` row from
   * a session's raw turns.
   *
   * `full_text` is the role-prefixed (`user: ...` / `assistant: ...`),
   * newline-joined turn content in `turn_index` order — a legible
   * transcript that the FTS5 tokenizer sees with clean word boundaries.
   * The row is tagged `archived_from='full'` (raw-fidelity capture).
   *
   * SEC-01 carry-through: `has_untrusted_turn` is 1 iff ANY turn came from
   * an untrusted channel (`isTrustedChannel === false`). Plan 03's
   * `searchArchive` default-excludes those rows, mirroring the Phase 68
   * `searchTurns includeUntrustedChannels:false` hardening.
   *
   * Idempotent — `INSERT ... ON CONFLICT(session_id) DO UPDATE`, so
   * re-archiving the same session overwrites without duplicating or
   * throwing. The session MUST exist (Plan 02 only calls this for real
   * sessions); a missing session throws a clear error.
   *
   * A zero-turn session archives a row with empty `full_text`,
   * `turn_count` 0, `has_untrusted_turn` 0 — it does not throw.
   *
   * Returns the inserted `SessionArchiveRow`.
   */
  archiveSession(sessionId: string): SessionArchiveRow {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`archiveSession: session not found: ${sessionId}`);
    }

    const turns = this.getTurnsForSession(sessionId);
    const fullText = turns.map((t) => `${t.role}: ${t.content}`).join("\n");
    const hasUntrustedTurn = turns.some((t) => t.isTrustedChannel === false);
    const archivedAt = new Date().toISOString();
    const archivedFrom: SessionArchiveRow["archivedFrom"] = "full";

    this.stmts.archiveSessionInsert.run(
      session.id,
      session.agentName,
      session.startedAt,
      session.endedAt,
      session.turnCount,
      session.totalTokens,
      session.summaryMemoryId,
      archivedAt,
      archivedFrom,
      hasUntrustedTurn ? 1 : 0,
      fullText,
    );

    return Object.freeze({
      sessionId: session.id,
      agentName: session.agentName,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      turnCount: session.turnCount,
      totalTokens: session.totalTokens,
      summaryMemoryId: session.summaryMemoryId,
      archivedAt,
      archivedFrom,
      hasUntrustedTurn,
      fullText,
    });
  }

  /**
   * Phase 999.42 capability A — true iff a `session_archive` row exists for
   * the given session. Used by the Plan 02 backfill to skip
   * already-archived sessions.
   */
  hasArchive(sessionId: string): boolean {
    return this.stmts.hasArchiveSelect.get(sessionId) !== undefined;
  }

  /**
   * Phase 999.42 capability A (CONTEXT D2) — one-shot summary-only backfill.
   *
   * Sessions summarized BEFORE this phase shipped have already had their raw
   * turns pruned (Step 13b's `deleteTurnsForSession`). Their raw text is gone
   * and is NOT recoverable — so this backfill archives what *is* still
   * recoverable: the session-summary memory content (a Haiku-paraphrased
   * compression looked up via `summary_memory_id` → `memories.content`).
   *
   * Each backfilled row is tagged `archived_from='summary-only'` and written
   * with `has_untrusted_turn=0`: the summary memory is an agent-produced
   * compression already stored in `memories` and already surfaced today via
   * the Phase 68 session-summary retrieval path — archiving it adds no new
   * SEC-01 disclosure surface (full-fidelity raw-turn rows are the case
   * `has_untrusted_turn` + Plan 03's filter handle).
   *
   * One-shot: guarded by a `session_archive_backfill_v1` row in the
   * `migrations` table. A second invocation short-circuits with
   * `alreadyRun: true` — idempotent across daemon restarts. The whole body
   * (every archive insert + the guard-row insert) commits in one transaction.
   *
   * A summarized session is SKIPPED (counted in `skipped`, logged) when it
   * already has a `session_archive` row (e.g. archived by the Plan 02 T-01
   * live path), or when its `summary_memory_id` is null, or when the
   * referenced memory row is missing. Skips never throw.
   *
   * @returns `{ backfilled, skipped, alreadyRun }`.
   */
  backfillSessionArchive(log?: {
    warn: (obj: object, msg: string) => void;
    info: (obj: object, msg: string) => void;
  }): { backfilled: number; skipped: number; alreadyRun: boolean } {
    // One-shot guard — short-circuit if the migrations row already exists.
    if (this.stmts.hasBackfillMigration.get() !== undefined) {
      return { backfilled: 0, skipped: 0, alreadyRun: true };
    }

    const run = this.db.transaction(
      (): { backfilled: number; skipped: number } => {
        let backfilled = 0;
        let skipped = 0;
        const startedAt = new Date().toISOString();

        const sessions = this.stmts.listSummarizedSessions.all() as SessionRow[];
        for (const session of sessions) {
          // Already archived (live T-01 path or a prior run) — skip.
          if (this.hasArchive(session.id)) {
            skipped++;
            continue;
          }

          // No resolvable summary memory — nothing to archive, skip.
          if (!session.summary_memory_id) {
            skipped++;
            log?.warn(
              { session: session.id },
              "backfillSessionArchive: summarized session has no summary_memory_id — skipped",
            );
            continue;
          }
          const memRow = this.stmts.getMemoryContentById.get(
            session.summary_memory_id,
          ) as { content: string } | undefined;
          if (!memRow) {
            skipped++;
            log?.warn(
              {
                session: session.id,
                summaryMemoryId: session.summary_memory_id,
              },
              "backfillSessionArchive: summary memory row missing — skipped",
            );
            continue;
          }

          // Reuse Plan 01's archiveSessionInsert (11 placeholders, ON
          // CONFLICT DO UPDATE — keeps external-content FTS5 in sync).
          // archived_from='summary-only', has_untrusted_turn=0.
          this.stmts.archiveSessionInsert.run(
            session.id,
            session.agent_name,
            session.started_at,
            session.ended_at,
            session.turn_count,
            session.total_tokens,
            session.summary_memory_id,
            new Date().toISOString(),
            "summary-only",
            0,
            memRow.content,
          );
          backfilled++;
        }

        // One-shot guard row — inserted inside the SAME transaction as the
        // archive inserts so the whole backfill commits atomically (CONTEXT
        // D2). A daemon crash mid-backfill rolls back everything; the next
        // boot re-runs cleanly. `phase` is NOT NULL (store.ts:1559).
        const now = new Date().toISOString();
        this.stmts.insertBackfillMigration.run(
          backfilled,
          backfilled + skipped,
          startedAt,
          now,
        );

        return { backfilled, skipped };
      },
    );

    const { backfilled, skipped } = run();

    log?.info(
      { backfilled, skipped },
      "backfillSessionArchive: one-shot summary-only backfill complete",
    );
    return { backfilled, skipped, alreadyRun: false };
  }

  /** Prepare all SQL statements for conversation operations. */
  private prepareStatements(): ConversationStatements {
    return {
      insertSession: this.db.prepare(
        `INSERT INTO conversation_sessions (id, agent_name, started_at, status)
         VALUES (?, ?, ?, 'active')`,
      ),
      updateSessionEnd: this.db.prepare(
        `UPDATE conversation_sessions
         SET status = 'ended', ended_at = ?
         WHERE id = ? AND status = 'active'`,
      ),
      updateSessionCrash: this.db.prepare(
        `UPDATE conversation_sessions
         SET status = 'crashed', ended_at = ?
         WHERE id = ? AND status = 'active'`,
      ),
      updateSessionSummarized: this.db.prepare(
        `UPDATE conversation_sessions
         SET status = 'summarized', summary_memory_id = ?
         WHERE id = ? AND status IN ('ended', 'crashed')`,
      ),
      getSession: this.db.prepare(
        `SELECT id, agent_name, started_at, ended_at, turn_count,
                total_tokens, summary_memory_id, status
         FROM conversation_sessions WHERE id = ?`,
      ),
      listSessions: this.db.prepare(
        `SELECT id, agent_name, started_at, ended_at, turn_count,
                total_tokens, summary_memory_id, status
         FROM conversation_sessions
         WHERE agent_name = ?
         ORDER BY started_at DESC, rowid DESC
         LIMIT ?`,
      ),
      // agents-forget-across-sessions debug (2026-04-19): exclude 'active'
      // so the brief gap-check doesn't collapse to zero against the
      // just-created current session.
      //
      // 2026-04-25 evening hotfix (Phase 99 sub-scope D): also exclude
      // empty sessions (no actual turn rows) so brief restart cycles don't
      // shadow real prior sessions in the LIMIT 5 default. Use EXISTS
      // (cheap with the session_id index on conversation_turns). turn_count
      // field is unreliable post-cutover-translation — use the actual row
      // count. Phase 89 restart-greeting falls through to "no prior session
      // to recap" minimalEmbed when this list returns only empty sessions;
      // the filter prevents that false-negative.
      //
      // Memory overhaul 2026-10-25 (WP4): summarizeSession deletes a
      // session's turns right after markSummarized, so the EXISTS predicate
      // alone hid every successfully summarized session from the brief gap
      // check, the dream pass, the restart greeting and the brief cache
      // fingerprint. A session counts when it has a summary OR still has
      // turns; only sessions with neither are dropped.
      listRecentTerminatedSessions: this.db.prepare(
        `SELECT id, agent_name, started_at, ended_at, turn_count,
                total_tokens, summary_memory_id, status
         FROM conversation_sessions
         WHERE agent_name = ?
           AND status IN ('ended', 'crashed', 'summarized')
           AND (
             summary_memory_id IS NOT NULL
             OR EXISTS (
               SELECT 1 FROM conversation_turns ct
               WHERE ct.session_id = conversation_sessions.id
               LIMIT 1
             )
           )
         ORDER BY started_at DESC, rowid DESC
         LIMIT ?`,
      ),
      // Phase 99-C: pending-summary backlog drain. Sessions that ended/
      // crashed without summarization — typically (a) translator-imported
      // OpenClaw sessions written directly with status='ended' (see
      // src/sync/conversation-turn-translator.ts:225) and (b) historical
      // hard-crashes that bypassed both stop and crash trigger sites in
      // src/manager/session-manager.ts. EXISTS filter so summarizeSession
      // doesn't burn a Haiku budget on zero-turn rows it would skip with
      // reason='zero-turns' anyway. ASC so oldest backlog drains first.
      listPendingSummarySessions: this.db.prepare(
        `SELECT id, agent_name, started_at, ended_at, turn_count,
                total_tokens, summary_memory_id, status
         FROM conversation_sessions
         WHERE agent_name = ?
           AND status IN ('ended', 'crashed')
           AND summary_memory_id IS NULL
           AND EXISTS (
             SELECT 1 FROM conversation_turns ct
             WHERE ct.session_id = conversation_sessions.id
             LIMIT 1
           )
         ORDER BY started_at ASC, rowid ASC
         LIMIT ?`,
      ),
      insertTurn: this.db.prepare(
        `INSERT INTO conversation_turns
         (id, session_id, turn_index, role, content, token_count,
          channel_id, discord_user_id, discord_message_id,
          is_trusted_channel, origin, instruction_flags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getTurnsForSession: this.db.prepare(
        `SELECT id, session_id, turn_index, role, content, token_count,
                channel_id, discord_user_id, discord_message_id,
                is_trusted_channel, origin, instruction_flags, created_at
         FROM conversation_turns
         WHERE session_id = ?
         ORDER BY turn_index ASC`,
      ),
      getTurnsForSessionLimited: this.db.prepare(
        `SELECT id, session_id, turn_index, role, content, token_count,
                channel_id, discord_user_id, discord_message_id,
                is_trusted_channel, origin, instruction_flags, created_at
         FROM conversation_turns
         WHERE session_id = ?
         ORDER BY turn_index ASC
         LIMIT ?`,
      ),
      getSessionTurnCount: this.db.prepare(
        `SELECT turn_count FROM conversation_sessions WHERE id = ?`,
      ),
      incrementTurnCount: this.db.prepare(
        `UPDATE conversation_sessions
         SET turn_count = turn_count + 1
         WHERE id = ?`,
      ),
      addTokens: this.db.prepare(
        `UPDATE conversation_sessions
         SET total_tokens = total_tokens + ?
         WHERE id = ?`,
      ),
      // Phase 68 — RETR-02. BM25 ordering ascending (lower = more relevant per FTS5).
      // `is_trusted_channel = 1` filter is the default path (SEC-01 hygiene);
      // the *Untrusted variants drop that predicate for power-user call sites.
      searchTurnsFts: this.db.prepare(
        `SELECT
           t.id AS turnId,
           t.session_id AS sessionId,
           t.role,
           t.content,
           t.created_at AS createdAt,
           t.channel_id AS channelId,
           t.is_trusted_channel AS isTrustedChannel,
           bm25(conversation_turns_fts) AS bm25Score
         FROM conversation_turns_fts
         JOIN conversation_turns t ON t.rowid = conversation_turns_fts.rowid
         WHERE conversation_turns_fts MATCH ?
           AND t.is_trusted_channel = 1
         ORDER BY bm25Score
         LIMIT ? OFFSET ?`,
      ),
      searchTurnsFtsUntrusted: this.db.prepare(
        `SELECT
           t.id AS turnId,
           t.session_id AS sessionId,
           t.role,
           t.content,
           t.created_at AS createdAt,
           t.channel_id AS channelId,
           t.is_trusted_channel AS isTrustedChannel,
           bm25(conversation_turns_fts) AS bm25Score
         FROM conversation_turns_fts
         JOIN conversation_turns t ON t.rowid = conversation_turns_fts.rowid
         WHERE conversation_turns_fts MATCH ?
         ORDER BY bm25Score
         LIMIT ? OFFSET ?`,
      ),
      searchTurnsCount: this.db.prepare(
        `SELECT COUNT(*) AS total
         FROM conversation_turns_fts
         JOIN conversation_turns t ON t.rowid = conversation_turns_fts.rowid
         WHERE conversation_turns_fts MATCH ?
           AND t.is_trusted_channel = 1`,
      ),
      searchTurnsCountUntrusted: this.db.prepare(
        `SELECT COUNT(*) AS total
         FROM conversation_turns_fts
         WHERE conversation_turns_fts MATCH ?`,
      ),
      // Gap 2 (memory-persistence-gaps): bulk-delete raw turns after a
      // session has been summarized. The AFTER DELETE trigger on
      // conversation_turns_fts keeps the FTS index in sync automatically.
      deleteTurnsForSession: this.db.prepare(
        `DELETE FROM conversation_turns WHERE session_id = ?`,
      ),
      // Phase 999.42 capability A — UPSERT so re-archiving the same
      // session_id overwrites (never duplicates, never throws).
      //
      // `INSERT ... ON CONFLICT DO UPDATE` (NOT `INSERT OR REPLACE`):
      // OR REPLACE does a DELETE+INSERT that allocates a NEW rowid, which
      // breaks external-content FTS5 sync — the stale tokens stay indexed
      // under the old rowid (verified in isolation 2026-05-20). ON CONFLICT
      // DO UPDATE keeps the rowid stable and fires the `session_archive_au`
      // trigger, which deletes the old full_text + inserts the new one
      // under the same rowid — the correct external-content sync path.
      archiveSessionInsert: this.db.prepare(
        `INSERT INTO session_archive
         (session_id, agent_name, started_at, ended_at, turn_count,
          total_tokens, summary_memory_id, archived_at, archived_from,
          has_untrusted_turn, full_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           agent_name         = excluded.agent_name,
           started_at         = excluded.started_at,
           ended_at           = excluded.ended_at,
           turn_count         = excluded.turn_count,
           total_tokens       = excluded.total_tokens,
           summary_memory_id  = excluded.summary_memory_id,
           archived_at        = excluded.archived_at,
           archived_from      = excluded.archived_from,
           has_untrusted_turn = excluded.has_untrusted_turn,
           full_text          = excluded.full_text`,
      ),
      hasArchiveSelect: this.db.prepare(
        `SELECT 1 FROM session_archive WHERE session_id = ? LIMIT 1`,
      ),
      // Phase 999.42 capability A (Plan 02) — backfill support.
      // All summarized sessions: candidates for the summary-only backfill.
      listSummarizedSessions: this.db.prepare(
        `SELECT id, agent_name, started_at, ended_at, turn_count,
                total_tokens, summary_memory_id, status
         FROM conversation_sessions
         WHERE status = 'summarized'`,
      ),
      // The session-summary memory content, looked up via summary_memory_id.
      getMemoryContentById: this.db.prepare(
        `SELECT content FROM memories WHERE id = ?`,
      ),
      // One-shot guard: presence of the backfill migrations row.
      hasBackfillMigration: this.db.prepare(
        `SELECT 1 FROM migrations WHERE key = 'session_archive_backfill_v1' LIMIT 1`,
      ),
      // Migrations-row insert. `phase` is NOT NULL — the migrations table
      // (store.ts:1559) requires it; started_at/completed_at stamp the
      // one-shot run.
      insertBackfillMigration: this.db.prepare(
        `INSERT INTO migrations
           (key, phase, progress_processed, progress_total,
            last_cursor, started_at, completed_at, metadata)
         VALUES ('session_archive_backfill_v1', '999.42-02', ?, ?, NULL, ?, ?, NULL)`,
      ),
      // Phase 999.42 capability A (Plan 03) — FTS5 search over the durable
      // session archive. BM25 ordering ascending (lower = more relevant per
      // FTS5). Two-statement SEC-01 split mirroring searchTurnsFts /
      // searchTurnsFtsUntrusted: the default (trusted-only) variant adds
      // `s.has_untrusted_turn = 0`; the *Untrusted variant drops that
      // predicate for explicit power-user call sites.
      searchArchiveFts: this.db.prepare(
        `SELECT
           s.session_id AS sessionId,
           s.agent_name AS agentName,
           s.archived_from AS archivedFrom,
           s.has_untrusted_turn AS hasUntrustedTurn,
           s.full_text AS fullText,
           bm25(session_archive_fts) AS bm25Score,
           s.archived_at AS archivedAt,
           s.started_at AS startedAt,
           s.ended_at AS endedAt
         FROM session_archive_fts
         JOIN session_archive s ON s.rowid = session_archive_fts.rowid
         WHERE session_archive_fts MATCH ?
           AND s.has_untrusted_turn = 0
         ORDER BY bm25Score
         LIMIT ? OFFSET ?`,
      ),
      searchArchiveFtsUntrusted: this.db.prepare(
        `SELECT
           s.session_id AS sessionId,
           s.agent_name AS agentName,
           s.archived_from AS archivedFrom,
           s.has_untrusted_turn AS hasUntrustedTurn,
           s.full_text AS fullText,
           bm25(session_archive_fts) AS bm25Score,
           s.archived_at AS archivedAt,
           s.started_at AS startedAt,
           s.ended_at AS endedAt
         FROM session_archive_fts
         JOIN session_archive s ON s.rowid = session_archive_fts.rowid
         WHERE session_archive_fts MATCH ?
         ORDER BY bm25Score
         LIMIT ? OFFSET ?`,
      ),
      searchArchiveCount: this.db.prepare(
        `SELECT COUNT(*) AS total
         FROM session_archive_fts
         JOIN session_archive s ON s.rowid = session_archive_fts.rowid
         WHERE session_archive_fts MATCH ?
           AND s.has_untrusted_turn = 0`,
      ),
      searchArchiveCountUntrusted: this.db.prepare(
        `SELECT COUNT(*) AS total
         FROM session_archive_fts
         WHERE session_archive_fts MATCH ?`,
      ),
    };
  }
}
