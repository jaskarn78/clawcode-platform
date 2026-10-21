/**
 * Phase 94 Plan 04 — D-07 cross-agent alternatives lookup.
 *
 * Pure module. Reads a per-agent `McpServerState` snapshot map from a DI
 * provider and filters to agents whose backing MCP server has
 * `capabilityProbe.status === "ready"` for the named tool. Used by
 * `wrapMcpToolError` to populate `ToolCallError.alternatives`.
 *
 * Static-grep regression pins enforce purity (see plan rules section).
 * No fs imports, no clock construction, no timers, no env access.
 *
 * Behavior notes:
 *   - Tolerates absent `capabilityProbe` field (legacy Phase 85 snapshots
 *     pre-Plan-94-01 read as not-ready → excluded from alternatives).
 *   - Synchronous — runs inside the TurnDispatcher tool-call wrap path
 *     which has no async slot for an in-memory provider read.
 *   - Returns a frozen array (CLAUDE.md immutability rule).
 *   - Empty result is the contract when no server resolves or every
 *     agent's snapshot is non-ready.
 *   - Default tool→server heuristic handles the two common naming
 *     conventions: `mcp__<server>__*` (SDK-prefixed) and `<server>_*`
 *     (server-injection-pattern).
 */

import type { McpServerState } from "../mcp/readiness.js";

/**
 * DI surface — Phase 85 SessionManager exposes per-agent snapshot maps
 * via `getMcpStateForAgent`. The provider abstraction lets this helper
 * remain unit-testable with synthetic snapshots.
 */
export interface McpStateProvider {
  /** Names of all agents the manager knows about. */
  readonly listAgents: () => readonly string[];
  /** Per-agent McpServerState map (server name → state). */
  readonly getStateFor: (agent: string) => ReadonlyMap<string, McpServerState>;
  /**
   * Optional tool→server resolver. When omitted, falls back to the default
   * heuristic that handles the two common naming conventions:
   *   - SDK-prefixed: `mcp__<server>__<rest>` → "<server>"
   *   - Server-injection: `<server>_<rest>`     → "<server>"
   *
   * Tools without a clear server prefix (e.g. bare `snapshot`) yield
   * undefined — the lookup short-circuits to an empty alternatives list
   * because we can't disambiguate which MCP backs that tool.
   */
  readonly toolToServer?: (toolName: string) => string | undefined;
}

/**
 * Default tool→server heuristic.
 *
 * Order: try the SDK-prefixed shape first (`mcp__<server>__*`) so
 * server names that happen to contain underscores (e.g. `acme_db`)
 * still resolve correctly when the SDK prefix is present. Fall back to
 * the simple leading-segment match otherwise.
 *
 * Tools that don't match either pattern yield undefined — caller treats
 * as "no server known" and returns the empty frozen array.
 */
function defaultToolToServer(toolName: string): string | undefined {
  const sdkMatch = /^mcp__([^_]+)__/.exec(toolName);
  if (sdkMatch) return sdkMatch[1];
  const leadingMatch = /^([a-z0-9-]+)_/i.exec(toolName);
  if (leadingMatch) return leadingMatch[1];
  return undefined;
}

/**
 * Pure: list agent names whose snapshot has the named tool's backing MCP
 * server in `capabilityProbe.status === "ready"`. Sorted alphabetically
 * for stable rendering (LLM display + operator review). Returns a frozen
 * array.
 */
export function findAlternativeAgents(
  toolName: string,
  provider: McpStateProvider,
): readonly string[] {
  const toolToServer = provider.toolToServer ?? defaultToolToServer;
  const serverName = toolToServer(toolName);
  if (!serverName) return Object.freeze<readonly string[]>([]);

  const matches: string[] = [];
  for (const agentName of provider.listAgents()) {
    const stateMap = provider.getStateFor(agentName);
    const serverState = stateMap.get(serverName);
    if (serverState?.capabilityProbe?.status === "ready") {
      matches.push(agentName);
    }
  }
  matches.sort();
  return Object.freeze(matches);
}
