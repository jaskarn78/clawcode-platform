import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError, IpcError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

// ANSI color codes
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

/**
 * Format a routing table response as a human-readable table.
 *
 * @param channels - Map of channel ID to agent name
 * @returns Formatted table string
 */
export function formatRoutesTable(
  channels: Readonly<Record<string, string>>,
): string {
  const entries = Object.entries(channels);

  if (entries.length === 0) {
    return "No channel routes configured";
  }

  // Calculate column widths
  const channelWidth = Math.max(
    10,
    ...entries.map(([id]) => id.length),
  );
  const agentWidth = Math.max(
    5,
    ...entries.map(([, name]) => name.length),
  );

  // Header
  const header = `${BOLD}${"CHANNEL".padEnd(channelWidth)}  ${"AGENT".padEnd(agentWidth)}${RESET}`;
  const separator = `${DIM}${"-".repeat(channelWidth)}  ${"-".repeat(agentWidth)}${RESET}`;

  // Rows
  const rows = entries.map(
    ([channelId, agentName]) =>
      `${channelId.padEnd(channelWidth)}  ${agentName.padEnd(agentWidth)}`,
  );

  return [header, separator, ...rows].join("\n");
}

/**
 * Action handler for the routes command.
 * Connects to daemon via IPC and displays channel-to-agent mappings.
 */
export async function routesAction(): Promise<void> {
  try {
    const result = (await sendIpcRequest(SOCKET_PATH, "routes", {})) as {
      channels: Record<string, string>;
      agents: Record<string, string[]>;
    };

    cliLog("Channel Routes:\n");
    cliLog(formatRoutesTable(result.channels));
  } catch (error) {
    if (error instanceof ManagerNotRunningError) {
      cliError(
        "Daemon is not running. Start with: clawcode start-all",
      );
      process.exit(1);
    }
    if (error instanceof IpcError) {
      cliError(`Error: ${error.message}`);
      process.exit(1);
    }
    const message = error instanceof Error ? error.message : String(error);
    cliError(`Error: ${message}`);
    process.exit(1);
  }
}

/**
 * Register the `clawcode routes` command.
 * Displays the current channel-to-agent routing table from the daemon.
 */
export function registerRoutesCommand(program: Command): void {
  program
    .command("routes")
    .description("Display channel-to-agent routing table")
    .action(routesAction);
}
