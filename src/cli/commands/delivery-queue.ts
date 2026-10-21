import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";
import { formatTimeAgo } from "./health.js";

/**
 * Shape of the delivery-queue-status IPC response.
 */
type DeliveryQueueResponse = {
  readonly stats: {
    readonly pending: number;
    readonly inFlight: number;
    readonly failed: number;
    readonly delivered: number;
    readonly totalEnqueued: number;
  };
  readonly failed: readonly {
    readonly id: string;
    readonly agentName: string;
    readonly channelId: string;
    readonly content: string;
    readonly lastError: string | null;
    readonly createdAt: string;
    readonly attempts: number;
  }[];
};

/**
 * Truncate a string to the given max length, appending "..." if truncated.
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Format delivery queue status data as a human-readable output.
 *
 * @param data - The delivery-queue-status IPC response
 * @param showFailed - Whether to include the failed entries table
 * @returns Formatted output string
 */
export function formatDeliveryQueueOutput(
  data: DeliveryQueueResponse,
  showFailed: boolean,
): string {
  const lines = [
    "Delivery Queue Status",
    "",
    `Pending:        ${data.stats.pending}`,
    `In Flight:      ${data.stats.inFlight}`,
    `Failed:         ${data.stats.failed}`,
    `Delivered:      ${data.stats.delivered}`,
    `Total Enqueued: ${data.stats.totalEnqueued}`,
  ];

  if (showFailed && data.failed.length > 0) {
    lines.push("");
    lines.push("Failed Deliveries");

    // Column headers
    const idW = 10;
    const agentW = 12;
    const errorW = 42;
    const createdW = 10;

    lines.push(
      [
        "ID".padEnd(idW),
        "AGENT".padEnd(agentW),
        "ERROR".padEnd(errorW),
        "CREATED".padEnd(createdW),
      ].join("  "),
    );
    lines.push("-".repeat(idW + agentW + errorW + createdW + 6));

    for (const entry of data.failed) {
      const id = entry.id.slice(0, 8);
      const agent = truncate(entry.agentName, 10);
      const error = truncate(entry.lastError ?? "(none)", 40);
      const created = formatTimeAgo(entry.createdAt);

      lines.push(
        [
          id.padEnd(idW),
          agent.padEnd(agentW),
          error.padEnd(errorW),
          created,
        ].join("  "),
      );
    }
  }

  return lines.join("\n");
}

/**
 * Register the `clawcode delivery-queue` command.
 * Sends a "delivery-queue-status" IPC request and displays formatted results.
 */
export function registerDeliveryQueueCommand(program: Command): void {
  program
    .command("delivery-queue")
    .description("Show delivery queue status and failed messages")
    .option("--show-failed", "Include list of failed deliveries")
    .action(async (opts: { showFailed?: boolean }) => {
      try {
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "delivery-queue-status",
          {},
        )) as DeliveryQueueResponse;
        cliLog(formatDeliveryQueueOutput(result, opts.showFailed === true));
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
    });
}
