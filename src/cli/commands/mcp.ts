import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

/**
 * Register the `clawcode mcp` command.
 * Starts the MCP stdio server for external Claude Code sessions.
 */
export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("Start the MCP stdio server for external Claude Code sessions")
    .action(async () => {
      try {
        // Dynamic import to avoid loading MCP SDK until needed
        const { startMcpServer } = await import("../../mcp/server.js");
        await startMcpServer();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error starting MCP server: ${msg}`);
        process.exit(1);
      }
    });
}

/**
 * Phase 94 Plan 01 — `clawcode mcp-probe -a <agent>` subcommand.
 *
 * Triggers an immediate per-server capability probe for the named agent
 * via the daemon's `mcp-probe` IPC method. Renders the per-server result
 * (status / lastRunAt / error) as a compact table.
 *
 * Schedule contract: this is the operator on-demand path. Boot probe runs
 * via warm-path; periodic probe runs every 60s via the mcp-reconnect
 * heartbeat check. This subcommand is for the "I just changed the env,
 * tell me NOW if it works" use case.
 *
 * Daemon-not-running renders the same friendly message as `mcp-status`.
 */
type CapabilityProbeSnapshot = {
  readonly lastRunAt: string;
  readonly status: "ready" | "degraded" | "reconnecting" | "failed" | "unknown";
  readonly error?: string;
  readonly lastSuccessAt?: string;
};

type McpProbeServer = {
  readonly name: string;
  readonly status: string;
  readonly capabilityProbe?: CapabilityProbeSnapshot;
  readonly lastError: string | null;
  readonly optional: boolean;
};

type McpProbeResponse = {
  readonly agent: string;
  readonly servers: readonly McpProbeServer[];
};

function formatProbeTable(resp: McpProbeResponse): string {
  if (resp.servers.length === 0) {
    return `No MCP servers configured for ${resp.agent}`;
  }
  type Row = {
    readonly server: string;
    readonly status: string;
    readonly lastRunAt: string;
    readonly error: string;
  };
  const rows: readonly Row[] = resp.servers.map((s) => ({
    server: s.optional ? `${s.name} (opt)` : s.name,
    status: s.capabilityProbe?.status ?? "unknown",
    lastRunAt: s.capabilityProbe?.lastRunAt ?? "-",
    error: s.capabilityProbe?.error ?? s.lastError ?? "",
  }));
  const widths = {
    server: Math.max("SERVER".length, ...rows.map((r) => r.server.length)),
    status: Math.max("STATUS".length, ...rows.map((r) => r.status.length)),
    lastRunAt: Math.max("LAST RUN".length, ...rows.map((r) => r.lastRunAt.length)),
    error: Math.max("ERROR".length, ...rows.map((r) => r.error.length)),
  };
  const header = [
    "SERVER".padEnd(widths.server),
    "STATUS".padEnd(widths.status),
    "LAST RUN".padEnd(widths.lastRunAt),
    "ERROR".padEnd(widths.error),
  ].join("  ");
  const totalWidth =
    widths.server + widths.status + widths.lastRunAt + widths.error + 6;
  const separator = "-".repeat(totalWidth);
  const body = rows.map((r) =>
    [
      r.server.padEnd(widths.server),
      r.status.padEnd(widths.status),
      r.lastRunAt.padEnd(widths.lastRunAt),
      r.error.padEnd(widths.error),
    ].join("  "),
  );
  return [`Agent: ${resp.agent}`, header, separator, ...body].join("\n");
}

export function registerMcpProbeCommand(program: Command): void {
  program
    .command("mcp-probe")
    .description(
      "Run an on-demand capability probe of all MCP servers for an agent (Phase 94)",
    )
    .requiredOption("-a, --agent <name>", "Agent to probe")
    .action(async (opts: { agent: string }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "mcp-probe", {
          agent: opts.agent,
        })) as McpProbeResponse;
        cliLog(formatProbeTable(result));
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError("Manager is not running. Start it with: clawcode start-all");
          process.exit(1);
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });
}
