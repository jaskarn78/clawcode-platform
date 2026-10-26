/**
 * Memory overhaul 2026-10-25 (WP5) - the text `memory_save` returns to the
 * agent.
 *
 * Dedup is non-destructive and the agent is told what happened:
 *   - created    - a new memory was stored.
 *   - duplicate  - nothing was stored; the content is already in memory
 *                  under the returned id.
 *   - superseded - a new memory was stored and the older, similar memory
 *                  it replaces is now hidden from search and retrieval.
 *
 * Deliberately import-free: `src/mcp/server.ts` is bundled into the
 * standalone MCP process, which must not load the memory store (and its
 * native SQLite modules) just to format a string.
 */

/** The daemon's `memory-save` IPC response. */
export type MemorySaveIpcResult = Readonly<{
  id: string;
  /** "owner" when the fact went to the fleet shared-facts store. */
  scope?: string;
  owner?: string;
  /** Shared-facts outcome: "inserted" | "refreshed". */
  action?: string;
  /** Agent-memory outcome; absent from a pre-WP5 daemon. */
  status?: string;
  /** Set with status "superseded": the id of the retired older memory. */
  supersedes?: string;
}>;

/** Render the `memory_save` tool result text. */
export function formatMemorySaveText(result: MemorySaveIpcResult): string {
  if (result.scope === "owner") {
    return `Owner fact ${result.action === "refreshed" ? "refreshed" : "saved"} for ${result.owner} (id: ${result.id}); every agent they own will recall it.`;
  }
  switch (result.status) {
    case "duplicate":
      return `Memory not stored (status: duplicate): it repeats an existing memory (id: ${result.id}). Nothing changed.`;
    case "superseded":
      return (
        `Memory saved (id: ${result.id}, status: superseded). It replaces the older similar memory ` +
        `${result.supersedes ?? "(unknown id)"}, which is now hidden from search and retrieval. ` +
        `Recall that id if you need to compare the two.`
      );
    case "created":
      return `Memory saved (id: ${result.id}, status: created)`;
    default:
      return `Memory saved (id: ${result.id})`;
  }
}
