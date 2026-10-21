import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

/**
 * A single MCP server entry from the IPC response.
 */
export type McpServerEntry = {
  readonly agent: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly healthy: boolean | null;
  readonly latencyMs?: number;
  readonly error?: string;
};

/**
 * Shape of the "mcp-servers" IPC response.
 */
export type McpServersResponse = {
  readonly servers: readonly McpServerEntry[];
};

/**
 * Format the status of a server entry for display.
 */
function formatStatus(entry: McpServerEntry): string {
  if (entry.healthy === null) {
    return "unknown";
  }
  if (entry.healthy) {
    return `healthy (${entry.latencyMs ?? 0}ms)`;
  }
  return `unhealthy: ${entry.error ?? "unknown error"}`;
}

/**
 * Format MCP servers IPC response as a table.
 * Columns: AGENT, SERVER, COMMAND, STATUS
 *
 * @param data - The mcp-servers IPC response
 * @returns Formatted table string
 */
export function formatMcpServersTable(data: McpServersResponse): string {
  if (data.servers.length === 0) {
    return "No MCP servers configured";
  }

  type Row = {
    readonly agent: string;
    readonly server: string;
    readonly command: string;
    readonly status: string;
  };

  const rows: readonly Row[] = data.servers.map((entry) => ({
    agent: entry.agent,
    server: entry.name,
    command: `${entry.command} ${entry.args.join(" ")}`.trim(),
    status: formatStatus(entry),
  }));

  // Calculate column widths dynamically
  const agentWidth = Math.max(5, ...rows.map((r) => r.agent.length));
  const serverWidth = Math.max(6, ...rows.map((r) => r.server.length));
  const commandWidth = Math.max(7, ...rows.map((r) => r.command.length));
  const statusWidth = Math.max(6, ...rows.map((r) => r.status.length));

  // Header
  const header = [
    "AGENT".padEnd(agentWidth),
    "SERVER".padEnd(serverWidth),
    "COMMAND".padEnd(commandWidth),
    "STATUS".padEnd(statusWidth),
  ].join("  ");

  const separator = "-".repeat(
    agentWidth + serverWidth + commandWidth + statusWidth + 6,
  );

  // Format rows
  const formattedRows = rows.map((row) =>
    [
      row.agent.padEnd(agentWidth),
      row.server.padEnd(serverWidth),
      row.command.padEnd(commandWidth),
      row.status.padEnd(statusWidth),
    ].join("  "),
  );

  return [header, separator, ...formattedRows].join("\n");
}

/**
 * Register the `clawcode mcp-servers` command.
 * Sends a "mcp-servers" IPC request and displays a formatted table.
 */
export function registerMcpServersCommand(program: Command): void {
  program
    .command("mcp-servers")
    .description("Show configured MCP servers per agent with optional health check")
    .option("-a, --agent <name>", "Filter to a specific agent")
    .option("--check", "Run health checks on each server")
    .action(async (opts: { agent?: string; check?: boolean }) => {
      try {
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "mcp-servers",
          {
            agent: opts.agent,
            check: opts.check ?? false,
          },
        )) as McpServersResponse;
        cliLog(formatMcpServersTable(result));
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError(
            "Manager is not running. Start it with: clawcode start-all",
          );
          process.exit(1);
          return;
        }
        const message =
          error instanceof Error ? error.message : String(error);
        cliError(`Error: ${message}`);
        process.exit(1);
      }
    });
}
