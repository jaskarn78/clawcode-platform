/**
 * Phase 94 Plan 02 — TOOL-03 dynamic tool advertising filter.
 *
 * Pure module: no I/O, no SDK imports, no logger, no fs access, no
 * `new Date()` constructor without DI. The flapHistory Map is owned by
 * the caller (typically the SessionHandle for a given agent) so the
 * filter remains deterministic over its arguments.
 *
 * Contract:
 *   filterToolsByCapabilityProbe(tools, deps) => readonly Tool[]
 *
 * A tool is INCLUDED iff its `mcpServer` attribution names a server whose
 * `capabilityProbe.status === "ready"`. Built-in tools (no mcpServer
 * attribution — Read / Write / Bash / etc.) ALWAYS pass.
 *
 * D-12 flap-stability window:
 *   If the same server transitions ready ↔ non-ready ≥ FLAP_TRANSITION_THRESHOLD
 *   times within FLAP_WINDOW_MS (5 minutes), the filter STICKS in degraded
 *   mode for the rest of the window — even when the current snapshot says
 *   ready. This prevents prompt-cache prefix-hash yo-yo when an MCP server
 *   is hot-flapping.
 *
 * Returns Object.freeze'd readonly array (CLAUDE.md immutability rule).
 *
 * Invariants pinned by tests:
 *   - FT-READY/DEGRADED/FAILED/RECONNECTING/UNKNOWN map directly onto the
 *     5-value CapabilityProbeStatus enum from Plan 94-01.
 *   - FT-BUILTIN: tools without mcpServer attribution always pass.
 *   - FT-IDEMPOTENT: same input twice yields deep-equal frozen output.
 *   - FT-FLAP-STABILITY: D-12 5min window + 3-transition threshold sticky.
 */

import type {
  CapabilityProbeStatus,
  McpServerState,
} from "../mcp/readiness.js";

/**
 * The narrow tool shape consumed by the filter. Only `name` (rendering /
 * debugging) and `mcpServer` (filter key) are read. Real Claude Agent SDK
 * tool definitions carry richer fields (input schema, description, etc.)
 * — they survive untouched through the filter because we never construct
 * a derived shape, only push the original reference into the result.
 */
export interface ToolDef {
  readonly name: string;
  /**
   * Server attribution. Required for filter — if missing, the tool is
   * treated as built-in (Read / Write / Bash / etc.) and always passes.
   */
  readonly mcpServer?: string;
}

/**
 * Per-server flap-history entry. Caller (typically SessionHandle) owns
 * the Map. Window resets when (now - windowStart) > FLAP_WINDOW_MS.
 */
export interface FlapHistoryEntry {
  /** ISO8601 — start of the current 5min flap window. */
  readonly windowStart: string;
  /** Count of ready ↔ non-ready transitions within the window. */
  readonly transitions: number;
  /** True iff D-12 sticky-degraded engaged this window. */
  readonly stickyDegraded: boolean;
  /**
   * Last observed ready/non-ready state used to detect a transition on
   * the next tick. Persisted so cross-tick transition counting works
   * even when the caller passes a fresh `tools` argument.
   */
  readonly lastReady: boolean;
}

/** D-12: 5-minute flap-stability window. Pinned by static-grep regression. */
export const FLAP_WINDOW_MS = 5 * 60 * 1000;

/**
 * D-12: 3 transitions in a window → sticky degraded. With threshold=2
 * every recovery cycle would trigger sticky and the window would become a
 * permanent block; 3 is the minimum that catches genuine flapping.
 */
export const FLAP_TRANSITION_THRESHOLD = 3;

export interface FilterDeps {
  /** Per-server state map (server name → state). Read-only contract. */
  readonly snapshot: ReadonlyMap<string, McpServerState>;
  /**
   * Mutable Map carrying flap-history across calls. Caller-owned so the
   * filter remains pure-over-its-arguments. Optional — when absent the
   * filter still applies the ready/degraded gate; the flap-stability
   * window simply doesn't engage.
   */
  readonly flapHistory?: Map<string, FlapHistoryEntry>;
  /** DI clock. Defaults to `new Date(Date.now())` when absent. */
  readonly now?: () => Date;
}

/**
 * Pure-ish helper — reads + writes the caller-owned flapHistory Map.
 *
 * Returns true iff the server should be treated as sticky-degraded for
 * THIS call (sticky has engaged within the active window).
 *
 * Behavior:
 *   - First observation: seeds the entry with current windowStart, no
 *     transition counted (we have no prior to compare against).
 *   - Window expired: resets the entry (new window, transitions=0,
 *     sticky=false, lastReady=current).
 *   - Within window: increments transitions iff current readiness flips
 *     from lastReady. Once transitions ≥ FLAP_TRANSITION_THRESHOLD,
 *     sticky engages and stays engaged for the rest of the window.
 */
function updateFlapHistory(
  serverName: string,
  isReady: boolean,
  flapHistory: Map<string, FlapHistoryEntry>,
  now: Date,
): boolean {
  const prev = flapHistory.get(serverName);
  if (!prev) {
    flapHistory.set(serverName, {
      windowStart: now.toISOString(),
      transitions: 0,
      stickyDegraded: false,
      lastReady: isReady,
    });
    return false;
  }

  const elapsedMs = now.getTime() - new Date(prev.windowStart).getTime();
  if (elapsedMs > FLAP_WINDOW_MS) {
    // Window elapsed — reset under a fresh window.
    flapHistory.set(serverName, {
      windowStart: now.toISOString(),
      transitions: 0,
      stickyDegraded: false,
      lastReady: isReady,
    });
    return false;
  }

  const transitioned = isReady !== prev.lastReady;
  const transitions = prev.transitions + (transitioned ? 1 : 0);
  const sticky =
    prev.stickyDegraded || transitions >= FLAP_TRANSITION_THRESHOLD;
  flapHistory.set(serverName, {
    windowStart: prev.windowStart,
    transitions,
    stickyDegraded: sticky,
    lastReady: isReady,
  });
  return sticky;
}

/**
 * Pure: returns true iff the server should be treated as advertisable to
 * the LLM (i.e. its tools may pass the filter). False for non-ready
 * statuses AND for sticky-degraded servers within an active flap window.
 *
 * The flap-history Map mutation is a side-effect by design: caller owns
 * the Map and the filter advances flap-tracking state on every call.
 * Same `(state, history-snapshot, now)` triple yields the same boolean —
 * deterministic over inputs.
 */
export function isServerLlmAdvertisable(
  serverName: string,
  state: McpServerState | undefined,
  flapHistory: Map<string, FlapHistoryEntry> | undefined,
  now: Date,
): boolean {
  const status: CapabilityProbeStatus | undefined = state?.capabilityProbe?.status;
  const isReady = status === "ready";

  if (!flapHistory) {
    return isReady;
  }

  const sticky = updateFlapHistory(serverName, isReady, flapHistory, now);
  if (!isReady) return false;
  return !sticky;
}

/**
 * Filter the tool list to those backed by a ready MCP server.
 *
 * Built-in tools (no `mcpServer` attribution) always pass — Read, Write,
 * Bash, and any future built-in are trusted by definition.
 *
 * Returns a frozen readonly array. The contained ToolDef references are
 * the original input references — no defensive copy of the per-tool
 * objects (their fields are already readonly by interface, and freezing
 * shallow is sufficient for cache-stability hashing on the result identity).
 */
export function filterToolsByCapabilityProbe(
  tools: readonly ToolDef[],
  deps: FilterDeps,
): readonly ToolDef[] {
  // DI clock fallback. Static-grep regression pin tolerates `new Date(Date.now())`
  // (integer-arg signature) — same purity convention as Plan 94-01's
  // capability-probe.ts `currentTime(deps)` helper.
  const now = (deps.now ?? ((): Date => new Date(Date.now())))();
  const result: ToolDef[] = [];
  for (const tool of tools) {
    if (!tool.mcpServer) {
      result.push(tool); // built-in — always passes
      continue;
    }
    const state = deps.snapshot.get(tool.mcpServer);
    if (
      isServerLlmAdvertisable(tool.mcpServer, state, deps.flapHistory, now)
    ) {
      result.push(tool);
    }
  }
  return Object.freeze(result);
}
