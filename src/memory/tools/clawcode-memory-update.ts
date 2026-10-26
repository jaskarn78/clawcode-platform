/**
 * Memory overhaul 2026-10-25 (WP5) - `clawcode_memory_update` MCP tool.
 *
 * Replaces a saved memory with corrected content. The correction is a NEW
 * row (its own id, embedding, created_at) and the old row is marked
 * `superseded_by = <new id>` inside the same insert transaction
 * (`CreateMemoryInput.supersedes`). The old text is kept for audit; the
 * default read paths show only the new row. Supersession is explicit, so
 * the dedup probe is skipped: a correction can never be swallowed as a
 * "duplicate" of some third memory.
 *
 * Source, importance, tags and turn lineage are carried over from the
 * old row unless the caller supplies new tags.
 *
 * Scope: rows in the agent's own `memories` table only (a memory file
 * section is edited through `clawcode_memory_edit`; a `shared:<id>` owner
 * fact is out of scope).
 */

import { z } from "zod/v4";
import type { MemoryStore } from "../store.js";

export const UPDATE_INPUT_SCHEMA = z.object({
  id: z.string().min(1).max(200),
  content: z.string().min(1).max(20_000),
  /** Optional replacement tags; omitted keeps the old row's tags. */
  tags: z.array(z.string()).optional(),
});

export type UpdateInput = z.infer<typeof UPDATE_INPUT_SCHEMA>;

export interface UpdateDeps {
  readonly store: MemoryStore;
  readonly agentName: string;
  /** v1 (MiniLM) embedder for the new content, the space `vec_memories` indexes. */
  readonly embed: (text: string) => Promise<Float32Array>;
  readonly log?: {
    readonly info?: (obj: Record<string, unknown>, msg?: string) => void;
  };
}

export interface UpdateResult {
  readonly ok: boolean;
  /** The NEW memory's id when ok. */
  readonly id?: string;
  /** The retired memory's id when ok. */
  readonly supersedes?: string;
  readonly createdAt?: string;
  readonly error?: string;
}

const SHARED_PREFIX = "shared:";

export async function clawcodeMemoryUpdate(
  input: UpdateInput,
  deps: UpdateDeps,
): Promise<UpdateResult> {
  const parsed = UPDATE_INPUT_SCHEMA.parse(input);
  const oldId = parsed.id;

  if (oldId.startsWith(SHARED_PREFIX)) {
    return Object.freeze({
      ok: false,
      error: "owner facts (shared:<id>) cannot be updated with this tool; save the corrected fact with memory_save scope='owner'",
    });
  }

  const existing = deps.store.peekById(oldId);
  if (!existing) {
    if (deps.store.getMemoryChunk(oldId)) {
      return Object.freeze({
        ok: false,
        error:
          "this id is a memory file section, not a saved memory; edit the file with clawcode_memory_edit instead",
      });
    }
    return Object.freeze({ ok: false, error: "memory not found in this agent's store" });
  }

  if (existing.content === parsed.content && parsed.tags === undefined) {
    return Object.freeze({
      ok: false,
      error: "the new content is identical to the stored memory; nothing to update",
    });
  }

  const embedding = await deps.embed(parsed.content);
  const outcome = deps.store.insertWithStatus(
    {
      content: parsed.content,
      source: existing.source,
      importance: existing.importance,
      tags: parsed.tags ?? existing.tags,
      ...(existing.sourceTurnIds ? { sourceTurnIds: existing.sourceTurnIds } : {}),
      supersedes: oldId,
    },
    embedding,
  );

  deps.log?.info?.(
    {
      component: "clawcode-memory-update",
      agent: deps.agentName,
      memoryId: outcome.entry.id,
      supersedes: oldId,
      action: "memory-updated",
    },
    "[diag] clawcode-memory-update: memory replaced",
  );

  return Object.freeze({
    ok: true,
    id: outcome.entry.id,
    supersedes: oldId,
    createdAt: outcome.entry.createdAt,
  });
}
