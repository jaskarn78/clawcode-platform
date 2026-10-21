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
 *   1. memories table (agent-saved memories via memory_save / consolidation)
 *   2. memory_chunks table (file-scanned MEMORY.md sections)
 *
 * Returns `{ ok: false, error }` on miss instead of throwing — the LLM
 * gets a clean error string it can read; the daemon doesn't propagate
 * a 500.
 */

import { z } from "zod/v4";
import type { MemoryStore } from "../store.js";

export const RECALL_INPUT_SCHEMA = z.object({
  memoryId: z.string().min(1).max(200),
});

export type RecallInput = z.infer<typeof RECALL_INPUT_SCHEMA>;

export interface RecallDeps {
  readonly store: MemoryStore;
  readonly agentName: string;
}

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

  // 1. Try memories table first. getById bumps access_count + accessed_at —
  //    that's intended (the agent recalled a memory; mark it as accessed).
  const mem = deps.store.getById(id);
  if (mem) {
    return Object.freeze({
      ok: true,
      memoryId: id,
      content: mem.content,
      tags: mem.tags,
      source: mem.source,
      importance: mem.importance,
      created_at: mem.createdAt,
    });
  }

  // 2. Fall through to memory_chunks (file-scanned MEMORY.md sections).
  //    getMemoryChunk has no side effects — it's a read-only lookup.
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
    });
  }

  return Object.freeze({
    ok: false,
    memoryId: id,
    error: "memory not found in this agent's store",
  });
}
