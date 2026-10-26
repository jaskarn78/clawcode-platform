/**
 * Phase 115 Plan 05 sub-scope 7 — `clawcode_memory_recall` MCP tool.
 *
 * Pure-DI tool function. The agent calls this with a memoryId returned by
 * `clawcode_memory_search` to fetch the FULL body — search returns 500-
 * char snippets only, recall hydrates them on demand. Lazy-load by design.
 *
 * Per-agent isolation: store is the calling agent's per-agent MemoryStore,
 * resolved daemon-side via `manager.getMemoryStore(agent)`. Cross-agent
 * recall is impossible at the tool boundary — the agent literally has no
 * handle to another agent's store.
 *
 * Lookup order:
 *   0. `shared:<id>` ids (memory overhaul 2026-10-25, WP5): the owner's
 *      shared facts that `clawcode_memory_search` lists with that prefix,
 *      read from the fleet SharedFactsStore and checked against THIS
 *      agent's owner so another owner's fact can never be read.
 *   1. memories table (agent-saved memories via memory_save / consolidation)
 *   2. memory_chunks table (file-scanned MEMORY.md sections)
 *
 * Returns `{ ok: false, error }` on miss instead of throwing — the LLM
 * gets a clean error string it can read; the daemon doesn't propagate
 * a 500.
 */

import { z } from "zod/v4";
import type { MemoryStore } from "../store.js";
import { SHARED_FACT_PATH, type SharedFactsStore } from "../shared-facts-store.js";
import { FORGOTTEN_MARKER } from "../types.js";

export const RECALL_INPUT_SCHEMA = z.object({
  memoryId: z.string().min(1).max(200),
});

export type RecallInput = z.infer<typeof RECALL_INPUT_SCHEMA>;

export interface RecallDeps {
  readonly store: MemoryStore;
  readonly agentName: string;
  /**
   * WP5 - owner facts, so a `shared:<id>` hit from search can be recalled.
   * The owner comes from the agent's config (daemon side), never from the
   * tool input. Absent on old daemons or agents without an owner.
   */
  readonly ownerFacts?: {
    readonly store: Pick<SharedFactsStore, "get">;
    readonly owner: string;
  };
}

/** Id prefix `ownerFactsAsChunks` puts on shared facts. */
export const SHARED_MEMORY_ID_PREFIX = "shared:";

export interface RecallResult {
  readonly ok: boolean;
  readonly memoryId: string;
  readonly content?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly source?: string;
  readonly importance?: number;
  readonly created_at?: string;
  readonly heading?: string | null;
  readonly path?: string;
  /**
   * WP5 - set when the recalled memory has been replaced or forgotten: the
   * successor's id, or "forgotten". The content is still returned so the
   * agent can see what it used to believe, but it should prefer the
   * successor (recall it by this id).
   */
  readonly supersededBy?: string;
  readonly supersededAt?: string;
  /** WP5 - plain-language hint that rides along with `supersededBy`. */
  readonly note?: string;
  readonly error?: string;
}

/**
 * Phase 115 Plan 05 sub-scope 7 — `clawcode_memory_recall` tool body.
 *
 * memories-table hit: returns full content + tags + source + importance.
 * memory_chunks-table hit: returns body as content + heading + path.
 * Miss: returns `{ ok: false, error: "memory not found in this agent's store" }`.
 */
export async function clawcodeMemoryRecall(
  input: RecallInput,
  deps: RecallDeps,
): Promise<RecallResult> {
  const parsed = RECALL_INPUT_SCHEMA.parse(input);
  const id = parsed.memoryId;

  // 0. WP5 - owner facts. Search lists them as `shared:<id>`; before this
  //    the agent was shown a hit it could not recall.
  if (id.startsWith(SHARED_MEMORY_ID_PREFIX)) {
    const factId = id.slice(SHARED_MEMORY_ID_PREFIX.length);
    const fact = deps.ownerFacts && factId.length > 0 ? deps.ownerFacts.store.get(factId) : null;
    if (fact && deps.ownerFacts && fact.owner === deps.ownerFacts.owner) {
      return Object.freeze({
        ok: true,
        memoryId: id,
        content: fact.content,
        tags: fact.tags,
        source: "owner-fact",
        importance: fact.importance,
        created_at: fact.createdAt,
        heading: `Owner fact (shared by ${fact.sourceAgent})`,
        path: SHARED_FACT_PATH,
      });
    }
    return Object.freeze({
      ok: false,
      memoryId: id,
      error: deps.ownerFacts
        ? "owner fact not found for this agent's owner"
        : "owner facts are not available to this agent (no owner configured)",
    });
  }

  // 1. Try memories table first. For a live row getById bumps
  //    access_count + accessed_at, which is intended (the agent recalled a
  //    memory; mark it as accessed). WP5: a superseded row is still
  //    returned (the agent may hold its id from an earlier turn), read
  //    without the access bump and flagged so the successor is preferred.
  const peeked = deps.store.peekById(id);
  const mem = peeked && !peeked.supersededBy ? (deps.store.getById(id) ?? peeked) : peeked;
  if (mem) {
    const retired = mem.supersededBy
      ? {
          supersededBy: mem.supersededBy,
          ...(mem.supersededAt ? { supersededAt: mem.supersededAt } : {}),
          note:
            mem.supersededBy === FORGOTTEN_MARKER
              ? "This memory was forgotten and no longer applies."
              : `This memory was replaced by ${mem.supersededBy}; recall that id for the current version.`,
        }
      : {};
    return Object.freeze({
      ok: true,
      memoryId: id,
      content: mem.content,
      tags: mem.tags,
      source: mem.source,
      importance: mem.importance,
      created_at: mem.createdAt,
      ...retired,
    });
  }

  // 2. Fall through to memory_chunks (file-scanned MEMORY.md sections).
  //    getMemoryChunk has no side effects — it's a read-only lookup.
  //    WP5 - the file's mtime is the best available date for a chunk.
  const chunk = deps.store.getMemoryChunk(id);
  if (chunk) {
    return Object.freeze({
      ok: true,
      memoryId: id,
      content: chunk.body,
      tags: Object.freeze([] as string[]),
      source: "memory_chunks",
      heading: chunk.heading,
      path: chunk.path,
      ...(Number.isFinite(chunk.file_mtime_ms) && chunk.file_mtime_ms > 0
        ? { created_at: new Date(chunk.file_mtime_ms).toISOString() }
        : {}),
    });
  }

  return Object.freeze({
    ok: false,
    memoryId: id,
    error: "memory not found in this agent's store",
  });
}
