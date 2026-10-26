/**
 * Phase 115 Plan 05 sub-scope 7 — `clawcode_memory_search` MCP tool.
 *
 * Pure-DI tool function. The agent calls this to search its own per-agent
 * memory store (memory_chunks + memories tables) via the existing
 * Phase 90 MEM-03 hybrid-RRF retrieval primitive. Returns top-K snippets
 * with memory IDs the agent can pass to `clawcode_memory_recall` for the
 * full body.
 *
 * Per-agent isolation: `agentName` is taken from the calling session/auth
 * context (resolved daemon-side via `validateStringParam(params, "agent")`)
 * and threaded through `deps`. Because the per-agent MemoryStore is also
 * resolved daemon-side via `manager.getMemoryStore(agent)`, the tool can
 * only ever see the calling agent's memories. Phase 90's per-agent-DB
 * isolation lock holds.
 *
 * SECURITY: snippets are capped at 500 chars per hit (Pain Point #2 — the
 * pre-115 path leaked giant blobs into the prompt; lazy-load tools must
 * not regress this). Threat model row 4 (prompt injection through memory
 * content) is mitigated by the snippet cap + Phase 999.1 directive set on
 * the calling agent.
 */

import { z } from "zod/v4";
import type { MemoryStore } from "../store.js";
import type { EmbeddingService } from "../embedder.js";
import { retrieveMemoryChunks } from "../memory-retrieval.js";
import { ownerFactsAsChunks, type SharedFactsStore } from "../shared-facts-store.js";

/** Zod schema for the tool's input — exposed so the MCP server can derive the tool spec shape. */
export const SEARCH_INPUT_SCHEMA = z.object({
  query: z.string().min(1).max(2000),
  k: z.number().int().min(1).max(50).optional().default(10),
  /**
   * Phase 115 sub-scope 7 — optional include-tag filter applied AFTER
   * retrieval. Pre-filtered hits whose tags don't intersect this list are
   * dropped. Empty / undefined → no filter. Tags exist only on saved
   * memories: when this is set, file-chunk and owner-fact hits (which carry
   * no tags) are dropped too. The check is side-effect free (WP5): it no
   * longer bumps access counters on rows it filters out.
   */
  includeTags: z.array(z.string()).optional(),
  /** Optional exclude-tag filter passed through to retrieveMemoryChunks. */
  excludeTags: z.array(z.string()).optional(),
});

/** Input shape BEFORE zod defaults apply (k optional). */
export type SearchInput = z.input<typeof SEARCH_INPUT_SCHEMA>;

export interface SearchHit {
  /** Memory ID (chunk_id for memory_chunks, memory_id for memories, shared:<id> for owner facts). */
  readonly memoryId: string;
  /** Optional heading from a memory_chunks row. */
  readonly heading?: string | null;
  /** Snippet capped at 500 chars (Pain Point #2: prevents giant-blob leaks). */
  readonly snippet: string;
  /** Fused RRF + path-derived score. Higher is better. */
  readonly score: number;
  /**
   * Retrieval surface: memory_chunks ("chunk", which also carries the
   * owner's shared facts) or the memories table ("memory"). Kept as the
   * pre-WP5 two-value field; `kind` below is the finer label.
   */
  readonly source: "chunk" | "memory";
  /** Path of the originating file (memory_chunks) or synthetic memory:<id> (memories). */
  readonly path?: string;
  /**
   * Memory overhaul 2026-10-25 (WP5) - what the hit is: a saved memory
   * ("memory"), a section of a memory file such as a daily note, digest or
   * MEMORY.md ("file"), or one of the owner's shared facts ("owner-fact",
   * recall it with the same `shared:<id>` id).
   */
  readonly kind: SearchHitKind;
  /**
   * WP5 - when the content dates from (ISO): the saved memory's
   * created_at, the memory file's mtime for a file section, or the owner
   * fact's created_at. Lets the agent prefer the fresher of two
   * contradicting hits.
   */
  readonly createdAt?: string;
  /** WP5 - tags of a saved memory (absent for file sections and owner facts). */
  readonly tags?: ReadonlyArray<string>;
  /** WP5 - the saved memory's `source` column (manual, conversation, consolidation ...). */
  readonly memorySource?: string;
}

/** WP5 - finer hit label than `SearchHit.source`. */
export type SearchHitKind = "memory" | "file" | "owner-fact";

export interface SearchDeps {
  readonly store: MemoryStore;
  /**
   * `embedForVersion` is optional so existing test doubles (`{ embed }`)
   * keep working; production passes the full EmbeddingService and the
   * query follows the agent's read version (Phase 999.119 v2 switch).
   */
  readonly embedder: Pick<EmbeddingService, "embed"> &
    Partial<Pick<EmbeddingService, "embedForVersion">>;
  /**
   * agentName is sourced from the daemon's session/auth context (via
   * validateStringParam(params, "agent") at the IPC handler), NEVER from
   * the tool input. Threat model row 3 (per-agent isolation breach)
   * mitigation.
   */
  readonly agentName: string;
  /**
   * Phase 999.187 — owner-scoped shared facts (999.131) ride into the lazy
   * search too; before this only the pre-turn path saw them, so an agent
   * that searched for "how does Operator like answers" found nothing. The owner
   * comes from the agent's config, never from the tool input. `embed` is
   * the v1 (MiniLM) embedder the shared store indexes with.
   */
  readonly ownerFacts?: {
    readonly store: SharedFactsStore;
    readonly owner: string;
    readonly embed: (text: string) => Promise<Float32Array>;
  };
  readonly log?: {
    readonly debug?: (
      obj: Record<string, unknown>,
      msg?: string,
    ) => void;
    readonly warn?: (msg: string) => void;
  };
}

export interface SearchResult {
  readonly hits: ReadonlyArray<SearchHit>;
  readonly agentName: string;
}

const SNIPPET_MAX_CHARS = 500;
/** Id prefix `ownerFactsAsChunks` puts on the owner's shared facts. */
const SHARED_ID_PREFIX = "shared:";

/**
 * WP5 - the store as the retriever sees it when `includeTags` is set: the
 * same store minus `touchAccessedAt`, so the retriever does not reset the
 * decay clock of memories the tag filter then drops (it skips the touch
 * when the method is absent). The tool touches only the hits it returns.
 */
function storeWithoutRetrievalTouch(store: MemoryStore): MemoryStore {
  return Object.create(store, {
    touchAccessedAt: { value: undefined, enumerable: false },
  }) as MemoryStore;
}

/**
 * Phase 115 Plan 05 sub-scope 7 — `clawcode_memory_search` tool body.
 *
 * Pure-DI: no daemon imports, no fs imports. Production wiring at the
 * daemon edge resolves `store` + `embedder` + `agentName` from the per-
 * agent MemoryStore + manager.getEmbedder().
 */
export async function clawcodeMemorySearch(
  input: SearchInput,
  deps: SearchDeps,
): Promise<SearchResult> {
  const parsed = SEARCH_INPUT_SCHEMA.parse(input);

  const tagFilter =
    parsed.includeTags && parsed.includeTags.length > 0
      ? new Set(parsed.includeTags)
      : undefined;

  const chunks = await retrieveMemoryChunks({
    query: parsed.query,
    store: tagFilter ? storeWithoutRetrievalTouch(deps.store) : deps.store,
    // Phase 999.119 v2 switch — follow the agent's read version.
    embed: (q) =>
      typeof deps.embedder.embedForVersion === "function"
        ? deps.store.embedQuery(
            deps.embedder as Pick<EmbeddingService, "embedForVersion">,
            q,
          )
        : deps.embedder.embed(q),
    topK: parsed.k,
    // Phase 999.187 — NO time window on the lazy tool. The memory protocol
    // tells the agent to call this "for older context"; with the pre-turn
    // path's 14-day window copied here, anything older than two weeks was
    // unreachable from every search path.
    timeWindowDays: 0,
    tokenBudget: 4000,
    excludeTags: parsed.excludeTags,
    agent: deps.agentName,
    log: deps.log
      ? { debug: deps.log.debug as (obj: Record<string, unknown>, msg?: string) => void }
      : undefined,
  });

  // Phase 999.187 — append matching owner facts (fail-open).
  let allChunks = chunks;
  if (deps.ownerFacts) {
    try {
      const ownerEmbedding = await deps.ownerFacts.embed(parsed.query);
      const facts = ownerFactsAsChunks(deps.ownerFacts.store, deps.ownerFacts.owner, ownerEmbedding);
      if (facts.length > 0) allChunks = [...chunks, ...facts];
    } catch (err) {
      deps.log?.warn?.(`owner facts unavailable for lazy search: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const hits: SearchHit[] = [];
  for (const c of allChunks) {
    const memoryId = c.chunkId ?? "";
    if (memoryId.length === 0) continue;
    const body = c.body ?? "";
    const kind: SearchHitKind =
      c.source === "memory"
        ? "memory"
        : memoryId.startsWith(SHARED_ID_PREFIX)
          ? "owner-fact"
          : "file";
    // WP5 - provenance per hit. Both lookups are side-effect free (no
    // access bump): getMemoryForRetrieval for saved memories, getMemoryChunk
    // for file sections. A date the retriever already carries wins.
    let createdAt = c.createdAt;
    let tags: ReadonlyArray<string> | undefined;
    let memorySource: string | undefined;
    if (kind === "memory") {
      const meta = deps.store.getMemoryForRetrieval(memoryId);
      if (meta) {
        createdAt = createdAt ?? meta.created_at;
        tags = meta.tags;
        memorySource = meta.source;
      }
    } else if (kind === "file" && createdAt === undefined) {
      const chunk = deps.store.getMemoryChunk(memoryId);
      if (chunk && Number.isFinite(chunk.file_mtime_ms) && chunk.file_mtime_ms > 0) {
        createdAt = new Date(chunk.file_mtime_ms).toISOString();
      }
    }
    hits.push({
      memoryId,
      heading: c.heading,
      snippet: body.length > SNIPPET_MAX_CHARS ? body.slice(0, SNIPPET_MAX_CHARS) : body,
      score: c.fusedScore ?? 0,
      source: c.source,
      path: c.path,
      kind,
      ...(createdAt ? { createdAt } : {}),
      ...(tags ? { tags } : {}),
      ...(memorySource ? { memorySource } : {}),
    });
  }

  if (!tagFilter) {
    return { hits: Object.freeze(hits), agentName: deps.agentName };
  }

  // Optional includeTags filter, applied post-retrieval. Tags exist only on
  // saved memories: when the filter is set, file sections and owner facts
  // (no tags) are dropped and a saved memory is kept only when its tags
  // intersect the list. With no filter every hit is kept (above). WP5: the
  // tags were read without an access bump and the retriever's recency
  // touch was withheld, so only the memories actually returned are touched.
  const filtered = hits.filter(
    (h) => h.kind === "memory" && (h.tags ?? []).some((t) => tagFilter.has(t)),
  );
  const keptMemoryIds = filtered.map((h) => h.memoryId);
  if (keptMemoryIds.length > 0) {
    try {
      deps.store.touchAccessedAt(keptMemoryIds);
    } catch {
      /* bookkeeping never fails a search */
    }
  }
  return { hits: Object.freeze(filtered), agentName: deps.agentName };
}
