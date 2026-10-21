/**
 * Conversation memory types.
 *
 * Defines the data contracts for persistent conversation sessions and turns.
 * All types are readonly per project immutability convention.
 *
 * Used by ConversationStore (Phase 64 Plan 02) and downstream consumers.
 */

/** Status of a conversation session lifecycle. */
export type SessionStatus = "active" | "ended" | "crashed" | "summarized";

/**
 * A conversation session — one continuous agent interaction.
 *
 * Sessions track aggregate metrics (turn count, token usage) and link
 * to an optional summary memory entry created during consolidation.
 */
export type ConversationSession = {
  readonly id: string;
  readonly agentName: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly turnCount: number;
  readonly totalTokens: number;
  readonly summaryMemoryId: string | null;
  readonly status: SessionStatus;
};

/**
 * A single turn within a conversation session.
 *
 * Includes provenance fields (SEC-01) for tracking Discord origin:
 * channelId, discordUserId, discordMessageId, isTrustedChannel.
 * The origin field captures the TurnOrigin string from Phase 57.
 */
export type ConversationTurn = {
  readonly id: string;
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly tokenCount: number | null;
  readonly channelId: string | null;
  readonly discordUserId: string | null;
  readonly discordMessageId: string | null;
  readonly isTrustedChannel: boolean;
  readonly origin: string | null;
  readonly instructionFlags: string | null;
  readonly createdAt: string;
};

/**
 * Input for recording a new conversation turn.
 *
 * Optional fields default at the store layer: tokenCount to null,
 * provenance fields to null/false, origin to null.
 */
export type RecordTurnInput = {
  readonly sessionId: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly tokenCount?: number;
  readonly channelId?: string;
  readonly discordUserId?: string;
  readonly discordMessageId?: string;
  readonly isTrustedChannel?: boolean;
  readonly origin?: string;
  readonly instructionFlags?: string;
};

// ---------------------------------------------------------------------------
// Phase 68 — RETR-02: full-text search over conversation turns via FTS5
// ---------------------------------------------------------------------------

/**
 * Options for searching conversation turns via FTS5.
 *
 * `limit`/`offset` are enforced by the caller (the orchestrator clamps to
 * `MAX_RESULTS_PER_PAGE = 10`; ConversationStore itself does not clamp).
 * `includeUntrustedChannels` defaults to `false` for SEC-01 hygiene — keeps
 * memory-poisoning vectors from leaking into agent context via search.
 */
export type SearchTurnsOptions = {
  readonly limit: number;
  readonly offset: number;
  readonly includeUntrustedChannels?: boolean;
  /** Phase 999.125 — inclusive ISO bounds on `created_at` (either may be absent). */
  readonly since?: string;
  readonly until?: string;
};

/**
 * A single FTS5 match against `conversation_turns.content`.
 *
 * `bm25Score` is the raw FTS5 BM25 output — lower values mean better matches
 * (FTS5 multiplies BM25 by -1 internally). Downstream consumers (the scoped
 * search orchestrator) convert to a positive relevance in [0, 1].
 */
export type ConversationTurnSearchResult = {
  readonly turnId: string;
  readonly sessionId: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly bm25Score: number;
  readonly createdAt: string;
  readonly channelId: string | null;
  readonly isTrustedChannel: boolean;
};

/**
 * Pagination envelope returned by `ConversationStore.searchTurns`.
 *
 * `totalMatches` counts every match across the full FTS5 index (not just the
 * returned page) so callers can derive `hasMore` without a second query.
 */
export type SearchTurnsResult = {
  readonly results: readonly ConversationTurnSearchResult[];
  readonly totalMatches: number;
};

// ---------------------------------------------------------------------------
// Phase 999.42 — capability A: durable cross-session full-text archive
// ---------------------------------------------------------------------------

/**
 * Provenance discriminator for a `session_archive` row.
 *
 * - `'full'` — archived from the raw turns BEFORE the consolidation prune
 *   (`summarizeSession` → `deleteTurnsForSession`). Full-fidelity raw text.
 * - `'summary-only'` — backfilled from the session-summary memory because the
 *   raw turns were already pruned before capability A shipped — un-recoverable
 *   raw text, so the archive carries the summary instead (Plan 02 / CONTEXT D2).
 */
export type ArchivedFrom = "full" | "summary-only";

/**
 * A durable `session_archive` row — one per concluded session.
 *
 * Phase 999.42 capability A. `fullText` is a denormalized copy of the
 * session's raw turn content that survives the consolidation prune (the
 * `conversation_turns_fts` index is wiped when `deleteTurnsForSession`
 * runs; this table is not). It is indexed by the `session_archive_fts`
 * FTS5 virtual table for cross-session full-text search.
 *
 * SEC-01 carry-through: `hasUntrustedTurn` is `true` iff ANY archived turn
 * came from an untrusted channel. An `archivedFrom='full'` row carries RAW
 * turn text — a stronger prompt-injection vector than the Haiku-paraphrased
 * session summary. Plan 03's `searchArchive` default-excludes rows with
 * `hasUntrustedTurn` set, mirroring the Phase 68 `searchTurns
 * includeUntrustedChannels:false` hardening. Mapped to/from the SQLite
 * `has_untrusted_turn` INTEGER column at the store boundary.
 */
export type SessionArchiveRow = {
  readonly sessionId: string;
  readonly agentName: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly turnCount: number;
  readonly totalTokens: number;
  readonly summaryMemoryId: string | null;
  readonly archivedAt: string;
  readonly archivedFrom: ArchivedFrom;
  readonly hasUntrustedTurn: boolean;
  readonly fullText: string;
};

// ---------------------------------------------------------------------------
// Phase 999.42 capability A (Plan 03) — retrieval over the session archive
// ---------------------------------------------------------------------------

/**
 * Options for searching the session archive via FTS5.
 *
 * Mirrors `SearchTurnsOptions`. `limit`/`offset` are enforced by the caller
 * (the scoped-search orchestrator over-fetches and clamps; `ConversationStore`
 * itself does not clamp).
 *
 * `includeUntrustedChannels` defaults to `false` for SEC-01 hygiene — an
 * `archivedFrom='full'` archive row carries RAW turn text, a stronger
 * prompt-injection vector than the Haiku-paraphrased session summary. When
 * false, rows with `has_untrusted_turn=1` (any turn from an untrusted
 * channel — computed at archive time in Plan 01) are EXCLUDED. This mirrors
 * the Phase 68 `searchTurns includeUntrustedChannels:false` posture verbatim.
 * See `999.42-CONTEXT.md` D3.
 */
export type SearchArchiveOptions = {
  readonly limit: number;
  readonly offset: number;
  readonly includeUntrustedChannels?: boolean;
  /**
   * Phase 999.125 — inclusive ISO bounds; an archived session matches when
   * its span [started_at, ended_at ?? archived_at] overlaps the window.
   */
  readonly since?: string;
  readonly until?: string;
};

/**
 * A single FTS5 match against `session_archive.full_text`.
 *
 * `bm25Score` is the raw FTS5 BM25 output — lower values mean better matches
 * (FTS5 multiplies BM25 by -1 internally). The scoped-search orchestrator
 * normalises to a positive relevance in [0, 1] via `1 / (1 + |bm25|)` — the
 * SAME helper the conversation-turn bucket uses.
 *
 * `hasUntrustedTurn` is mapped from the SQLite `has_untrusted_turn` INTEGER
 * (0/1) to a JS boolean at the store boundary.
 */
export type SessionArchiveSearchResult = {
  readonly sessionId: string;
  readonly agentName: string;
  readonly archivedFrom: ArchivedFrom;
  readonly hasUntrustedTurn: boolean;
  readonly fullText: string;
  readonly bm25Score: number;
  readonly archivedAt: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
};

/**
 * Pagination envelope returned by `ConversationStore.searchArchive`.
 *
 * `totalMatches` counts every match across the full FTS5 index (not just the
 * returned page), honouring the same `includeUntrustedChannels` filter as the
 * results — so an excluded untrusted row is absent from both. Mirrors
 * `SearchTurnsResult`.
 */
export type SearchArchiveResult = {
  readonly results: readonly SessionArchiveSearchResult[];
  readonly totalMatches: number;
};
