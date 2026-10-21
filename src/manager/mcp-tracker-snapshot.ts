/**
 * Phase 999.15 Plan 03 (TRACK-05) — pure handler that builds the
 * `mcp-tracker-snapshot` IPC response payload from a McpProcessTracker.
 *
 * Intentionally a sibling module (NOT inlined into daemon.ts) so the
 * Wave 0 IPC-1 + IPC-2 vitest cases can exercise the contract directly
 * without instantiating the full daemon. The daemon's routeMethod switch
 * delegates to this builder.
 *
 * Read-only: does NOT mutate tracker state. Snapshot is point-in-time —
 * `getRegisteredAgents()` is read once, then per-PID liveness checks are
 * sync `process.kill(pid, 0)` calls via isPidAlive.
 *
 * Optional `getCmdlinesForAgent(name)` accessor on the tracker is consumed
 * when present; absent → empty cmdlines array (forward-compatible with
 * fake trackers used by IPC-1 / IPC-2 tests).
 */

import { isPidAlive } from "../mcp/proc-scan.js";

/**
 * Minimal structural shape this builder needs from a tracker.
 *
 * The real `McpProcessTracker` (Plan 01) satisfies this; the IPC-1 /
 * IPC-2 vitest fakeTracker also satisfies it. Defining the input as a
 * structural interface keeps the builder testable in isolation without
 * importing the McpProcessTracker class (avoids tracker → snapshot
 * circular import surface).
 */
export interface SnapshotTracker {
  readonly getRegisteredAgents: () => ReadonlyMap<
    string,
    {
      readonly claudePid: number;
      readonly mcpPids: readonly number[];
      readonly registeredAt: number;
    }
  >;
  /** Optional — present on the real tracker; absent on minimal fakes. */
  readonly getCmdlinesForAgent?: (name: string) => readonly string[];
}

/** Per-agent payload entry in the snapshot response. */
export interface McpTrackerSnapshotAgent {
  readonly agent: string;
  readonly claudePid: number;
  readonly claudeAlive: boolean;
  readonly mcpPids: readonly number[];
  readonly aliveCount: number;
  readonly totalCount: number;
  readonly cmdlines: readonly string[];
  readonly registeredAt: number;
}

/** Full IPC response shape for `mcp-tracker-snapshot`. */
export interface McpTrackerSnapshotResponse {
  readonly agents: readonly McpTrackerSnapshotAgent[];
}

/**
 * Build the IPC response payload from a tracker.
 *
 * Optional `agentFilter` — when set, only that agent appears in the result.
 * Used by `clawcode mcp-tracker -a <name>`. Unknown agent → empty agents
 * array (CLI layer surfaces "agent not found" — pure builder stays
 * non-throwing).
 */
export function buildMcpTrackerSnapshot(
  tracker: SnapshotTracker,
  agentFilter?: string,
): McpTrackerSnapshotResponse {
  const entries = tracker.getRegisteredAgents();
  const agents: McpTrackerSnapshotAgent[] = [];
  for (const [name, entry] of entries) {
    if (agentFilter && name !== agentFilter) continue;
    let aliveCount = 0;
    for (const pid of entry.mcpPids) {
      if (isPidAlive(pid)) aliveCount += 1;
    }
    const cmdlines =
      typeof tracker.getCmdlinesForAgent === "function"
        ? tracker.getCmdlinesForAgent(name)
        : [];
    agents.push({
      agent: name,
      claudePid: entry.claudePid,
      claudeAlive: isPidAlive(entry.claudePid),
      mcpPids: [...entry.mcpPids],
      aliveCount,
      totalCount: entry.mcpPids.length,
      cmdlines: [...cmdlines],
      registeredAt: entry.registeredAt,
    });
  }
  return { agents };
}
