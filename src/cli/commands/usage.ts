import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

/**
 * Shape of the "usage" IPC response.
 */
export type UsageResponse = {
  readonly agent: string;
  readonly period: string;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cost_usd: number;
  readonly turns: number;
  readonly duration_ms: number;
  readonly event_count: number;
};

/**
 * Format duration in milliseconds as a human-readable "Xm Xs" string.
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

/**
 * Format a UsageResponse as a compact key-value display.
 *
 * @param data - The usage IPC response
 * @returns Formatted usage string
 */
export function formatUsageTable(data: UsageResponse): string {
  const lines = [
    `Usage for ${data.agent} (${data.period})`,
    "",
    `Tokens In:    ${data.tokens_in}`,
    `Tokens Out:   ${data.tokens_out}`,
    `Total Cost:   $${data.cost_usd.toFixed(4)}`,
    `Turns:        ${data.turns}`,
    `Duration:     ${formatDuration(data.duration_ms)}`,
    `Events:       ${data.event_count}`,
  ];
  return lines.join("\n");
}

/**
 * Register the `clawcode usage <agent>` command.
 * Sends a "usage" IPC request and displays formatted results.
 */
export function registerUsageCommand(program: Command): void {
  program
    .command("usage <agent>")
    .description("Show token usage and costs for an agent")
    .option("--period <period>", "Usage period: session, daily, weekly, total", "session")
    .option("--date <date>", "Date for daily period (YYYY-MM-DD)")
    .option("--session-id <id>", "Session ID for session period")
    .action(
      async (
        agent: string,
        opts: { period: string; date?: string; sessionId?: string },
      ) => {
        try {
          const result = (await sendIpcRequest(SOCKET_PATH, "usage", {
            agent,
            period: opts.period,
            date: opts.date,
            sessionId: opts.sessionId,
          })) as UsageResponse;
          cliLog(formatUsageTable(result));
        } catch (error) {
          if (error instanceof ManagerNotRunningError) {
            cliError(
              "Manager is not running. Start it with: clawcode start-all",
            );
            process.exit(1);
            return;
          }
          const msg = error instanceof Error ? error.message : String(error);
          cliError(`Error: ${msg}`);
          process.exit(1);
        }
      },
    );
}
