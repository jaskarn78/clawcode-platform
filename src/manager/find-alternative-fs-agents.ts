/**
 * Phase 96 Plan 03 — D-08 cross-agent FS alternatives lookup.
 *
 * Pure module. Reads per-agent `FsCapabilitySnapshot` snapshot maps from a
 * DI provider and filters to agents whose snapshot has the queried path
 * in `status === "ready"`. Used by `clawcode_list_files` (and future fs
 * read tools) to populate `ToolCallError.alternatives` on permission-class
 * refusals — when fin-client can't read /home/X but admin-clawdy can,
 * the LLM gets that hint structured into the error.
 *
 * Verbatim mirror of Phase 94's `find-alternative-agents.ts` shape:
 *   - same provider DI surface (listAgentNames + per-agent state Map)
 *   - same Object.freeze immutability contract on the result array
 *   - same ASCII-ascending sort for stable LLM/operator rendering
 *
 * Differences from Phase 94's MCP-flavored sibling:
 *   - state Map is keyed by canonical absPath (D-06), not server name
 *   - readiness predicate checks `entry.status === "ready"` directly
 *     (FsCapabilitySnapshot has status at top level, not nested under
 *     capabilityProbe)
 *   - no tool→server resolver; the queried key IS the absPath
 *   - optional currentAgentName excludes the calling agent from results
 *     (you don't want the LLM to suggest "ask yourself"); Phase 94's
 *     equivalent is implicit because the calling agent's tool is the one
 *     that just failed
 *
 * Static-grep regression pins enforce purity (96-03-PLAN.md):
 *   - no node:fs imports
 *   - no discord.js imports
 *   - no clock construction
 */

import type { FsCapabilitySnapshot } from "./persistent-session-handle.js";

/**
 * DI surface — Phase 96 SessionManager exposes per-agent FS snapshot maps
 * via `getFsCapabilitySnapshot`. The provider abstraction lets this helper
 * remain unit-testable with synthetic snapshots.
 */
export interface FindAlternativeFsAgentsDeps {
  /** Names of all agents the manager knows about. */
  readonly listAgentNames: () => readonly string[];
  /** Per-agent FS capability snapshot Map (canonical absPath → snapshot). */
  readonly fsStateProvider: (
    agent: string,
  ) => ReadonlyMap<string, FsCapabilitySnapshot>;
  /**
   * Optional — current calling agent name. When provided, the helper
   * excludes this agent from the result so the LLM doesn't see its own
   * name in the alternatives list (the suggestion would be useless).
   */
  readonly currentAgentName?: string;
}

/**
 * Pure: list agent names whose FS capability snapshot has the queried
 * canonical absPath in `status === "ready"`. Sorted ASCII-ascending for
 * stable rendering (LLM display + operator review). Returns a frozen array.
 *
 * D-08 contract:
 *   - Empty provider → empty (frozen) array
 *   - Agent missing the path entirely → excluded
 *   - Agent with path but status='degraded' or 'unknown' → excluded
 *   - Agent matching currentAgentName → excluded (self-exclusion)
 *   - Sort: ASCII-ascending on agent name
 *   - Return: Object.frozen, immutable
 */
export function findAlternativeFsAgents(
  absPath: string,
  deps: FindAlternativeFsAgentsDeps,
): readonly string[] {
  const matches: string[] = [];
  for (const agentName of deps.listAgentNames()) {
    if (agentName === deps.currentAgentName) {
      continue;
    }
    const stateMap = deps.fsStateProvider(agentName);
    const entry = stateMap.get(absPath);
    if (entry?.status === "ready") {
      matches.push(agentName);
    }
  }
  matches.sort();
  return Object.freeze(matches);
}
