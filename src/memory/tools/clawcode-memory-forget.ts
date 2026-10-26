/**
 * Memory overhaul 2026-10-25 (WP5) - `clawcode_memory_forget` MCP tool.
 *
 * Retires a saved memory the agent has learned is wrong or no longer
 * applies. Nothing is deleted: the row is marked
 * `superseded_by = "forgotten"` with a `superseded_at` timestamp and from
 * then on every search, retrieval and listing path hides it by default
 * (`MemoryStore.forget`). Forgetting is archiving plus ranking, never
 * deletion, so an operator can audit or restore it later.
 *
 * Scope: rows in the agent's own `memories` table only.
 *   - A memory_chunks id (a section of a memory file) cannot be forgotten
 *     here; the file is the source of truth and is edited through
 *     `clawcode_memory_edit`.
 *   - A `shared:<id>` owner fact lives in the fleet SharedFactsStore and is
 *     out of scope for this tool.
 *
 * Per-agent isolation: `store` is the calling agent's per-agent
 * MemoryStore resolved daemon-side; `agentName` comes from the daemon's
 * identity-checked params, never from the tool input.
 */

import { z } from "zod/v4";
import type { MemoryStore } from "../store.js";

export const FORGET_INPUT_SCHEMA = z.object({
  id: z.string().min(1).max(200),
  /** Why the memory is being retired; logged for the operator, not stored on the row. */
  reason: z.string().min(1).max(2000),
});

export type ForgetInput = z.infer<typeof FORGET_INPUT_SCHEMA>;

export interface ForgetDeps {
  readonly store: MemoryStore;
  readonly agentName: string;
  readonly log?: {
    readonly info?: (obj: Record<string, unknown>, msg?: string) => void;
  };
}

export interface ForgetResult {
  readonly ok: boolean;
  readonly id: string;
  /** "forgotten" when this call retired the row; "already-superseded" when it was retired before. */
  readonly status?: "forgotten" | "already-superseded";
  /** The existing `superseded_by` value when `status === "already-superseded"`. */
  readonly supersededBy?: string;
  readonly supersededAt?: string;
  readonly error?: string;
}

const SHARED_PREFIX = "shared:";

export async function clawcodeMemoryForget(
  input: ForgetInput,
  deps: ForgetDeps,
): Promise<ForgetResult> {
  const parsed = FORGET_INPUT_SCHEMA.parse(input);
  const id = parsed.id;

  if (id.startsWith(SHARED_PREFIX)) {
    return Object.freeze({
      ok: false,
      id,
      error: "owner facts (shared:<id>) cannot be forgotten with this tool",
    });
  }

  // peekById reads superseded rows too and never bumps access state.
  const existing = deps.store.peekById(id);
  if (!existing) {
    if (deps.store.getMemoryChunk(id)) {
      return Object.freeze({
        ok: false,
        id,
        error:
          "this id is a memory file section, not a saved memory; edit the file with clawcode_memory_edit instead",
      });
    }
    return Object.freeze({ ok: false, id, error: "memory not found in this agent's store" });
  }

  if (existing.supersededBy) {
    return Object.freeze({
      ok: true,
      id,
      status: "already-superseded" as const,
      supersededBy: existing.supersededBy,
      ...(existing.supersededAt ? { supersededAt: existing.supersededAt } : {}),
    });
  }

  const at = new Date().toISOString();
  const marked = deps.store.forget(id, at);
  if (!marked) {
    // Raced with another supersession between the peek and the update.
    const again = deps.store.peekById(id);
    return Object.freeze({
      ok: true,
      id,
      status: "already-superseded" as const,
      ...(again?.supersededBy ? { supersededBy: again.supersededBy } : {}),
      ...(again?.supersededAt ? { supersededAt: again.supersededAt } : {}),
    });
  }

  deps.log?.info?.(
    {
      component: "clawcode-memory-forget",
      agent: deps.agentName,
      memoryId: id,
      reason: parsed.reason,
      action: "memory-forgotten",
    },
    "[diag] clawcode-memory-forget: memory retired",
  );

  return Object.freeze({
    ok: true,
    id,
    status: "forgotten" as const,
    supersededBy: "forgotten",
    supersededAt: at,
  });
}
