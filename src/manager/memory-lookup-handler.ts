/**
 * Phase 68-02 — memory-lookup IPC handler body, extracted for direct testing.
 *
 * Single source of truth for the `memory-lookup` IPC case body. Keeps
 * daemon.ts's switch case thin (a single delegating call) and lets
 * integration tests exercise the exact same branching logic against
 * real `:memory:` MemoryStore + ConversationStore fixtures — no
 * vi.mock() on daemon internals, no duplicated case-body reimplementation.
 *
 * Learning from 67-VERIFICATION.md: the prior `configDeps` wiring gap
 * shipped because tests exercised helper-layer correctness but missed the
 * "is this actually wired into production?" end-to-end chain. Extracting
 * the handler body into its own file closes that gap — the same function
 * runs in both production (daemon IPC switch) and tests (via
 * `invokeMemoryLookup`).
 *
 * Branching logic:
 *   - scope='memories' && page=0 → legacy GraphSearch path (pre-v1.9
 *     byte-compatible response: {id, content, relevance_score, tags,
 *     created_at, source, linked_from}).
 *   - Anything else → searchByScope orchestrator (paginated envelope
 *     with hasMore, nextOffset, origin, session_id).
 *
 * Defense-in-depth: the IPC handler clamps limit to
 * MAX_RESULTS_PER_PAGE=10 regardless of MCP-layer Zod validation, since
 * a non-MCP caller (CLI, test, future consumer) could bypass Zod.
 */

import { GraphSearch } from "../memory/graph-search.js";
import { searchByScope } from "../memory/conversation-search.js";
import { MAX_RESULTS_PER_PAGE } from "../memory/conversation-search.types.js";
import type { MemoryStore } from "../memory/store.js";
import type { ConversationStore } from "../memory/conversation-store.js";
import type { EmbeddingService } from "../memory/embedder.js";
import { ManagerError } from "../shared/errors.js";
import { hasWindow, resolveTimeWindow } from "../memory/time-window.js";

/**
 * Discriminated envelope returned by the memory-lookup handler.
 *
 * Legacy responses omit hasMore/nextOffset. New-path responses include
 * them plus a `origin` + `session_id` field per result.
 */
export type MemoryLookupLegacyResult = {
  readonly id: string;
  readonly content: string;
  readonly relevance_score: number;
  readonly tags: readonly string[];
  readonly created_at: string;
  readonly source: string;
  readonly linked_from: readonly string[] | undefined;
};

export type MemoryLookupScopedResult = {
  readonly id: string;
  readonly content: string;
  readonly relevance_score: number;
  readonly tags: readonly string[];
  readonly created_at: string;
  readonly source: string;
  readonly origin:
    | "memory"
    | "session-summary"
    | "conversation-turn"
    | "session-archive";
  readonly session_id: string | null;
  /** Phase 999.125 — archived sessions: when the conversation began. */
  readonly started_at?: string;
};

export type MemoryLookupResponse =
  | { readonly results: readonly MemoryLookupLegacyResult[] }
  | {
      readonly results: readonly MemoryLookupScopedResult[];
      readonly hasMore: boolean;
      readonly nextOffset: number | null;
    };

/**
 * Parameters accepted by the memory-lookup IPC handler.
 *
 * Shape matches what `sendIpcRequest(SOCKET_PATH, "memory-lookup", ...)`
 * passes through from the MCP tool wrapper. All fields except `agent`
 * and `query` are optional to preserve backward-compat with pre-v1.9
 * callers.
 */
export type MemoryLookupParams = {
  readonly agent: string;
  readonly query: string;
  readonly limit?: number;
  readonly scope?: "memories" | "conversations" | "all";
  readonly page?: number;
  /** Phase 68 — RETR-03 override. Resolved per-agent from conversation config; falls through to DEFAULT_RETRIEVAL_HALF_LIFE_DAYS=14 when undefined. */
  readonly retrievalHalfLifeDays?: number;
  /**
   * Phase 999.125 — raw time bounds as the caller wrote them (ISO, bare
   * date, `7d`, `yesterday`, …). Resolved here; invalid → ManagerError.
   * With a window the `query` may be empty (chronological browse).
   */
  readonly since?: string;
  readonly until?: string;
};

/**
 * Dependencies injected into the handler. Resolved at call-time from
 * `AgentMemoryManager` in production; provided directly in tests with
 * in-memory SQLite stores.
 */
export type MemoryLookupDeps = {
  readonly memoryStore: MemoryStore;
  readonly conversationStore: ConversationStore | undefined;
  readonly embedder: EmbeddingService;
};

/**
 * Execute the memory-lookup IPC case against the provided deps.
 *
 * Throws `ManagerError` when:
 *   - The legacy path runs without a MemoryStore (handled upstream; the
 *     caller resolves `manager.getMemoryStore(agent)` before calling).
 *   - The new path runs without a ConversationStore (misconfiguration
 *     guard — production always has both if the legacy path doesn't
 *     match).
 *
 * Returns a discriminated response: legacy shape for pre-v1.9 callers,
 * paginated envelope for new scopes or page > 0.
 */
export async function invokeMemoryLookup(
  params: MemoryLookupParams,
  deps: MemoryLookupDeps,
): Promise<MemoryLookupResponse> {
  // Gap 4 (memory-persistence-gaps): track whether the caller explicitly
  // asked for the legacy 'memories' scope. The implicit-default fallback
  // fires ONLY when scope was omitted — an explicit 'memories' request keeps
  // the legacy response shape and no retry, preserving pre-v1.9 semantics.
  const scopeIsExplicit = params.scope !== undefined;
  const scope = params.scope ?? "memories";

  // Phase 999.125 — time window. A bad bound is the caller's error (named
  // back to the agent); a window with an empty query is a chronological
  // browse, which only the scoped path can serve.
  const resolvedWindow = resolveTimeWindow({
    ...(params.since !== undefined ? { since: params.since } : {}),
    ...(params.until !== undefined ? { until: params.until } : {}),
  });
  if (!resolvedWindow.ok) {
    throw new ManagerError(`memory_lookup: ${resolvedWindow.error}`);
  }
  const window = resolvedWindow.window;
  const windowed = hasWindow(window);
  if (!windowed && params.query.trim().length === 0) {
    throw new ManagerError("memory_lookup: query is required unless since/until is given");
  }
  const page =
    typeof params.page === "number" && params.page >= 0
      ? Math.floor(params.page)
      : 0;

  // IPC-layer defense-in-depth: clamp limit to MAX_RESULTS_PER_PAGE=10.
  // MCP layer also enforces via Zod .max(10), but a CLI or future caller
  // could bypass that and reach the daemon directly.
  const rawLimit = typeof params.limit === "number" ? params.limit : 5;
  const limit = Math.min(Math.max(rawLimit, 1), MAX_RESULTS_PER_PAGE);

  const memoryStore = deps.memoryStore;
  const embedder = deps.embedder;

  // Legacy branch — scope='memories' && page=0. Byte-for-byte identical
  // to the pre-v1.9 response shape (Plan 68-02 § Backward-Compat).
  if (scope === "memories" && page === 0 && !windowed) {
    // Phase 999.119 v2 switch — embed for the agent's read version. Test
    // doubles that only implement `embed` stay on the v1 path.
    const queryEmbedding =
      typeof (embedder as { embedForVersion?: unknown }).embedForVersion === "function"
        ? await memoryStore.embedQuery(embedder, params.query)
        : await embedder.embed(params.query);
    const graphSearch = new GraphSearch(memoryStore);
    const results = graphSearch.search(queryEmbedding, limit);

    // Gap 4: when the caller did NOT explicitly request scope='memories'
    // AND the default-scope search returned nothing, retry once with
    // scope='all' so agents that never touched the scope knob still pick
    // up conversation history (session summaries + raw turns). Legacy
    // callers that explicitly set scope='memories' (scopeIsExplicit)
    // always get the legacy shape, empty or not.
    if (results.length > 0 || scopeIsExplicit) {
      return {
        results: results.map((r) => ({
          id: r.id,
          content: r.content,
          relevance_score: r.combinedScore,
          tags: r.tags,
          created_at: r.createdAt,
          source: r.source,
          linked_from: r.linkedFrom,
        })),
      };
    }
    // Fall through to the new-path branch below with scope='all'.
  }

  // New path — scope='conversations' | 'all' OR page > 0 OR Gap 4 fallback.
  // Requires both MemoryStore AND ConversationStore.
  const conversationStore = deps.conversationStore;
  if (!conversationStore) {
    throw new ManagerError(
      `ConversationStore not found for agent '${params.agent}' ` +
        `(conversation persistence may be disabled or agent not fully initialized)`,
    );
  }

  // Gap 4: when we reached here via the fallback branch (implicit-default,
  // empty legacy result, page=0), widen the scope to 'all'. Otherwise honor
  // the original scope from params.
  const effectiveScope =
    scope === "memories" && page === 0 && !scopeIsExplicit ? "all" : scope;

  const offset = page * limit;
  const scopedPage = await searchByScope(
    { memoryStore, conversationStore, embedder },
    {
      scope: effectiveScope,
      query: params.query,
      limit,
      offset,
      // Phase 68 — RETR-03: forward the resolved per-agent half-life. Left
      // undefined-when-absent so searchByScope's existing fallback to
      // DEFAULT_RETRIEVAL_HALF_LIFE_DAYS remains the single source of truth.
      halfLifeDays: params.retrievalHalfLifeDays,
      // Phase 999.125 — resolved ISO bounds.
      ...(window.since !== undefined ? { since: window.since } : {}),
      ...(window.until !== undefined ? { until: window.until } : {}),
    },
  );

  return {
    results: scopedPage.results.map((r) => ({
      id: r.id,
      content: r.snippet, // orchestrator truncates to SNIPPET_MAX_CHARS
      relevance_score: r.combinedScore,
      tags: r.tags,
      created_at: r.createdAt,
      // Phase 999.42 capability A — `session-archive` is a session-derived
      // surface like `session-summary`, so it maps to the "conversation"
      // source label (NOT the previous else-fallthrough to "conversation-turn",
      // which would have mislabelled a consolidated-session archive hit as a
      // live raw turn).
      source:
        r.origin === "memory"
          ? "knowledge"
          : r.origin === "session-summary" || r.origin === "session-archive"
            ? "conversation"
            : "conversation-turn",
      origin: r.origin,
      session_id: r.sessionId,
      ...(r.startedAt !== undefined ? { started_at: r.startedAt } : {}),
    })),
    hasMore: scopedPage.hasMore,
    nextOffset: scopedPage.nextOffset,
  };
}
