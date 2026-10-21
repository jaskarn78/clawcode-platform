/**
 * Phase 115 Plan 05 sub-scope 7 — `clawcode_memory_archive` MCP tool.
 *
 * Agent-curated promotion: the agent calls this on a chunkId returned by
 * `clawcode_memory_search` to archive that chunk into MEMORY.md or USER.md
 * (Tier 2 → Tier 1 promotion, Letta archival_insert pattern).
 *
 * Bypass note: agent-curated archive bypasses the D-10 hybrid auto-apply
 * policy (CONTEXT.md D-11: "Agent-curated promotion via clawcode_memory_
 * archive (lazy-load tool, sub-scope 7) bypasses this review window
 * entirely — the agent's own decision is operator-trusted"). The
 * dream-pass-driven path goes through the 30-min Discord veto window;
 * the agent-driven path appends immediately.
 *
 * Per-agent isolation: store.getMemoryChunk and clawcodeMemoryEdit both
 * operate on the calling agent's per-agent surface. Cross-agent archive
 * is impossible.
 */

import { z } from "zod/v4";
import type { MemoryStore } from "../store.js";
import { clawcodeMemoryEdit, type EditDeps } from "./clawcode-memory-edit.js";

export const ARCHIVE_INPUT_SCHEMA = z.object({
  chunkId: z.string().min(1).max(200),
  /** Same enum as clawcode_memory_edit — operator-curated identity files excluded. */
  targetPath: z.enum(["MEMORY.md", "USER.md"]),
  /** Optional curated wrapping prefix (e.g. heading text the agent wants to add). */
  wrappingPrefix: z.string().optional(),
  /** Optional wrapping suffix (e.g. dated footer). */
  wrappingSuffix: z.string().optional(),
});

export type ArchiveInput = z.infer<typeof ARCHIVE_INPUT_SCHEMA>;

export interface ArchiveDeps {
  readonly store: MemoryStore;
  readonly memoryRoot: string;
  readonly agentName: string;
  readonly log?: EditDeps["log"] & {
    readonly info?: (obj: Record<string, unknown>, msg?: string) => void;
  };
}

export interface ArchiveResult {
  readonly ok: boolean;
  readonly error?: string;
}

export async function clawcodeMemoryArchive(
  input: ArchiveInput,
  deps: ArchiveDeps,
): Promise<ArchiveResult> {
  const parsed = ARCHIVE_INPUT_SCHEMA.parse(input);

  const chunk = deps.store.getMemoryChunk(parsed.chunkId);
  if (!chunk) {
    return { ok: false, error: "chunk not found" };
  }

  const sectionContent =
    `\n\n${parsed.wrappingPrefix ?? ""}${chunk.body}${parsed.wrappingSuffix ?? ""}\n`;

  // Append to the target Tier 1 file via the jailed edit primitive.
  // clawcodeMemoryEdit enforces the path enum + symlink check.
  const editResult = await clawcodeMemoryEdit(
    { path: parsed.targetPath, mode: "append", content: sectionContent },
    {
      memoryRoot: deps.memoryRoot,
      agentName: deps.agentName,
      log: deps.log,
    },
  );

  if (!editResult.ok) {
    return { ok: false, error: editResult.error };
  }

  deps.log?.info?.(
    {
      component: "clawcode-memory-archive",
      agent: deps.agentName,
      chunkId: parsed.chunkId,
      targetPath: parsed.targetPath,
      action: "agent-curated-archive",
    },
    "[diag] clawcode-memory-archive: agent-curated promotion",
  );

  return { ok: true };
}
