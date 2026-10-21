/**
 * Phase 999.15 Plan 03 (TRACK-05) — `clawcode mcp-tracker [-a <agent>]`.
 *
 * Operator visibility surface for the daemon-side McpProcessTracker. Calls
 * the IPC method `mcp-tracker-snapshot` (Plan 03 Task 1) and renders an
 * ASCII table with liveness counts + top cmdlines. With `-a <agent>` it
 * filters to one agent and renders a verbose per-PID block.
 *
 * Locked decisions (per CONTEXT + Wave 0 RED tests):
 *   - Subcommand name `mcp-tracker` — Phase 85 already owns `mcp-status`
 *     (per-server readiness probe in src/cli/commands/mcp-status.ts);
 *     do NOT rename or replace.
 *   - Read-only — no mutations on the tracker.
 *   - Exit codes: 0 healthy, 1 partial liveness OR claude-dead, 2 daemon
 *     not running (ECONNREFUSED / ManagerNotRunningError), 3 unknown
 *     agent under -a filter.
 *   - cmdlines redaction handled upstream by the proc-scan layer; this
 *     CLI does not re-redact.
 */

import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

/**
 * Per-agent payload from the `mcp-tracker-snapshot` IPC method.
 *
 * Shape pinned by buildMcpTrackerSnapshot (src/manager/mcp-tracker-snapshot.ts)
 * and the IPC-1/IPC-2 vitest contract.
 */
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

/** Full IPC response shape. */
export interface McpTrackerSnapshotResponse {
  readonly agents: readonly McpTrackerSnapshotAgent[];
}

/** Truncate a string to maxLen, appending "..." when shortened. */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, Math.max(0, maxLen - 3)) + "...";
}

/**
 * Format a registeredAt epoch-ms timestamp as a relative time string.
 * Examples: "just now", "5m ago", "2h ago", "3d ago".
 */
function formatTimeAgo(timestamp: number, now: number = Date.now()): string {
  const diff = now - timestamp;
  if (diff < 0) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format the IPC snapshot as a column-aligned ASCII table.
 *
 * Pure function — exported for unit testing. Mirrors the `clawcode threads`
 * formatThreadsTable contract: empty agent list returns a friendly
 * "no entries" message; non-empty renders header + rows.
 *
 * Columns: AGENT, CLAUDE_PID, MCP_PIDS, MCP_ALIVE, CMDLINES (top 3).
 *
 * Per-row formatting:
 *   - claudeAlive===false → CLAUDE_PID column annotated "(dead)"
 *   - aliveCount===totalCount && totalCount>0 → MCP_ALIVE renders "N/N"
 *   - aliveCount<totalCount → MCP_ALIVE renders "{alive}/{total}"
 *   - totalCount===0 → MCP_ALIVE renders "0/0" (operator sees the gap)
 *   - cmdlines truncated to top 3 entries, joined with ", "
 */
export function formatTrackerTable(
  snapshot: McpTrackerSnapshotResponse,
): string {
  const agents = snapshot?.agents ?? [];
  if (agents.length === 0) {
    return "No agents registered with the MCP tracker";
  }

  type Row = {
    readonly agent: string;
    readonly claudePid: string;
    readonly mcpPids: string;
    readonly mcpAlive: string;
    readonly cmdlines: string;
  };

  const rows: readonly Row[] = agents.map((entry) => {
    const claudePidStr =
      String(entry.claudePid) + (entry.claudeAlive ? "" : " (dead)");
    const mcpPidsStr =
      entry.mcpPids.length === 0
        ? "(none)"
        : entry.mcpPids.join(",");
    const mcpAliveStr = `${entry.aliveCount}/${entry.totalCount}`;
    const topCmdlines = entry.cmdlines.slice(0, 3);
    const cmdlinesStr =
      topCmdlines.length === 0
        ? entry.totalCount === 0
          ? "(no MCPs registered)"
          : "(cmdlines pending)"
        : topCmdlines.map((c) => truncate(c, 50)).join(", ");
    return {
      agent: truncate(entry.agent, 30),
      claudePid: claudePidStr,
      mcpPids: truncate(mcpPidsStr, 40),
      mcpAlive: mcpAliveStr,
      cmdlines: cmdlinesStr,
    };
  });

  // Column widths
  const agentW = Math.max(5, ...rows.map((r) => r.agent.length));
  const claudeW = Math.max(10, ...rows.map((r) => r.claudePid.length));
  const pidsW = Math.max(8, ...rows.map((r) => r.mcpPids.length));
  const aliveW = Math.max(9, ...rows.map((r) => r.mcpAlive.length));

  const header = [
    "AGENT".padEnd(agentW),
    "CLAUDE_PID".padEnd(claudeW),
    "MCP_PIDS".padEnd(pidsW),
    "MCP_ALIVE".padEnd(aliveW),
    "CMDLINES (top 3)",
  ].join("  ");

  const sep = "-".repeat(agentW + claudeW + pidsW + aliveW + 24);

  const body = rows.map((r) =>
    [
      r.agent.padEnd(agentW),
      r.claudePid.padEnd(claudeW),
      r.mcpPids.padEnd(pidsW),
      r.mcpAlive.padEnd(aliveW),
      r.cmdlines,
    ].join("  "),
  );

  return [
    "MCP Tracker Snapshot",
    "",
    header,
    sep,
    ...body,
  ].join("\n");
}

/**
 * Verbose per-agent block for `clawcode mcp-tracker -a <name>`.
 *
 * Renders one block per agent with:
 *   - Agent name + claude PID + liveness
 *   - Registered timestamp + relative age
 *   - Per-MCP-PID liveness line + cmdline (full, no truncation — operator
 *     debug surface)
 */
export function formatTrackerVerbose(
  snapshot: McpTrackerSnapshotResponse,
  now: number = Date.now(),
): string {
  const agents = snapshot?.agents ?? [];
  if (agents.length === 0) {
    return "No matching agents in the MCP tracker";
  }
  const blocks: string[] = [];
  for (const entry of agents) {
    const lines: string[] = [];
    lines.push(`Agent: ${entry.agent}`);
    lines.push(
      `claude PID: ${entry.claudePid}${entry.claudeAlive ? " (alive)" : " (dead)"}`,
    );
    const iso = new Date(entry.registeredAt).toISOString();
    lines.push(`Registered: ${iso} (${formatTimeAgo(entry.registeredAt, now)})`);
    lines.push(
      `MCP children (${entry.aliveCount}/${entry.totalCount} alive):`,
    );
    if (entry.mcpPids.length === 0) {
      lines.push("  (no MCPs registered)");
    } else {
      // Best-effort align cmdline with PID — cmdlines may be sparser than
      // mcpPids if enrichment hasn't completed. The CLI just iterates pids
      // in registration order and pairs each with cmdlines[i] if present.
      for (let i = 0; i < entry.mcpPids.length; i += 1) {
        const pid = entry.mcpPids[i]!;
        const cmd = entry.cmdlines[i] ?? "(cmdline pending)";
        // Per-PID liveness isn't broken out by the snapshot builder — the
        // aliveCount/totalCount pair is the operator-actionable signal.
        // Render the cmdline directly.
        lines.push(`  ${pid}  ${cmd}`);
      }
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

/** Internal: classify the snapshot for exit-code purposes. */
function classifyHealth(
  snapshot: McpTrackerSnapshotResponse,
): "healthy" | "partial" {
  for (const entry of snapshot.agents) {
    // Treat missing claudeAlive (undefined) as alive — only an explicit
    // `false` flips to partial. The buildMcpTrackerSnapshot builder always
    // sets the field, so undefined only occurs in test fixtures or older
    // IPC payloads. Conservative default avoids false-positive exit 1.
    if (entry.claudeAlive === false) return "partial";
    if (entry.aliveCount < entry.totalCount) return "partial";
  }
  return "healthy";
}

/**
 * Detect the daemon-not-running case across BOTH paths the IPC layer
 * may surface:
 *   - ManagerNotRunningError (sendIpcRequest's translated form)
 *   - Raw NodeJS.ErrnoException with code === "ECONNREFUSED" or "ENOENT"
 *     (test fakes mock sendIpcRequest directly, bypassing the translator).
 */
function isDaemonDownError(err: unknown): boolean {
  if (err instanceof ManagerNotRunningError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ECONNREFUSED" || code === "ENOENT") return true;
  return false;
}

/**
 * Register the `mcp-tracker` subcommand on the program.
 *
 * Locked at this name to avoid collision with Phase 85's `mcp-status`
 * (per-server readiness probe). Both commands coexist in the CLI.
 */
export function registerMcpTrackerCommand(program: Command): void {
  program
    .command("mcp-tracker")
    .description(
      "Show daemon-tracked MCP child process state per agent (Phase 999.15)",
    )
    .option(
      "-a, --agent <name>",
      "Filter to one agent + render verbose cmdline block",
    )
    .action(async (opts: { agent?: string }) => {
      const params: Record<string, unknown> = {};
      if (opts.agent) params.agent = opts.agent;

      let snapshot: McpTrackerSnapshotResponse;
      try {
        snapshot = (await sendIpcRequest(
          SOCKET_PATH,
          "mcp-tracker-snapshot",
          params,
        )) as McpTrackerSnapshotResponse;
      } catch (err) {
        if (isDaemonDownError(err)) {
          cliError(
            "clawcode daemon is not running — start with: clawcode start-all",
          );
          process.exit(2);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        cliError(`Error: ${message}`);
        process.exit(1);
        return;
      }

      // -a filter with no matching agent → exit 3 (operator-actionable
      // signal that the named agent isn't in the tracker).
      if (opts.agent && snapshot.agents.length === 0) {
        cliError(`agent ${opts.agent} not found in tracker`);
        process.exit(3);
        return;
      }

      // Render: verbose under -a, table otherwise.
      if (opts.agent) {
        cliLog(formatTrackerVerbose(snapshot));
      } else {
        cliLog(formatTrackerTable(snapshot));
      }

      const health = classifyHealth(snapshot);
      if (health === "partial") {
        process.exit(1);
        return;
      }
      // Implicit exit 0 (no explicit call — Commander's action handler
      // returns and Node exits with the default code).
    });
}
