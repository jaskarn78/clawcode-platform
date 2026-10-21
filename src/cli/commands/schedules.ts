import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

// ANSI color codes
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

/**
 * A single scheduled task entry from the IPC response.
 */
type ScheduleStatusEntry = {
  readonly name: string;
  readonly agentName: string;
  readonly cron: string;
  readonly enabled: boolean;
  readonly lastRun: number | null;
  readonly lastStatus: "success" | "error" | "pending";
  readonly lastError: string | null;
  readonly nextRun: number | null;
};

/**
 * Shape of the "schedules" IPC response.
 */
type SchedulesResponse = {
  readonly schedules: readonly ScheduleStatusEntry[];
};

/**
 * Format a future timestamp as a relative time string.
 * Examples: "in 30s", "in 5m", "in 3h", "in 2d"
 *
 * @param timestamp - Future timestamp in ms, or null
 * @param now - Current time in ms (for testability)
 * @returns Human-readable relative time string
 */
export function formatNextRun(timestamp: number | null, now?: number): string {
  if (timestamp === null) {
    return "-";
  }

  const currentTime = now ?? Date.now();
  const diffMs = timestamp - currentTime;

  if (diffMs <= 0) {
    return "now";
  }

  const seconds = Math.floor(diffMs / 1_000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) {
    return `in ${seconds}s`;
  }
  if (minutes < 60) {
    return `in ${minutes}m`;
  }
  if (hours < 24) {
    return `in ${hours}h`;
  }
  return `in ${days}d`;
}

/**
 * Colorize a schedule status with ANSI escape codes.
 */
function colorizeLastStatus(
  status: "success" | "error" | "pending",
  enabled: boolean,
  lastError: string | null,
): string {
  if (!enabled) {
    return `${DIM}(disabled)${RESET}`;
  }

  switch (status) {
    case "success":
      return `${GREEN}${status}${RESET}`;
    case "error": {
      const errorSuffix = lastError
        ? ` (${lastError.length > 40 ? lastError.slice(0, 40) + "..." : lastError})`
        : "";
      return `${RED}${status}${RESET}${errorSuffix}`;
    }
    case "pending":
      return `${DIM}${status}${RESET}`;
    default:
      return status;
  }
}

/**
 * Format schedules IPC response as a table.
 * Columns: AGENT, TASK, CRON, NEXT RUN, LAST STATUS
 *
 * @param data - The schedules IPC response
 * @param now - Current time in ms (for testability)
 * @returns Formatted table string
 */
export function formatSchedulesTable(
  data: SchedulesResponse,
  now?: number,
): string {
  if (data.schedules.length === 0) {
    return "No scheduled tasks";
  }

  // Build raw row data for width calculation
  type Row = {
    readonly agent: string;
    readonly task: string;
    readonly cron: string;
    readonly nextRun: string;
    readonly lastStatusFormatted: string;
    readonly lastStatusRaw: string;
  };

  const rows: Row[] = data.schedules.map((entry) => {
    const rawStatus = entry.enabled
      ? entry.lastStatus + (entry.lastStatus === "error" && entry.lastError
          ? ` (${entry.lastError.length > 40 ? entry.lastError.slice(0, 40) + "..." : entry.lastError})`
          : "")
      : "(disabled)";

    return {
      agent: entry.agentName,
      task: entry.name,
      cron: entry.cron,
      nextRun: formatNextRun(entry.nextRun, now),
      lastStatusFormatted: colorizeLastStatus(
        entry.lastStatus,
        entry.enabled,
        entry.lastError,
      ),
      lastStatusRaw: rawStatus,
    };
  });

  // Calculate column widths dynamically
  const agentWidth = Math.max(5, ...rows.map((r) => r.agent.length));
  const taskWidth = Math.max(4, ...rows.map((r) => r.task.length));
  const cronWidth = Math.max(4, ...rows.map((r) => r.cron.length));
  const nextRunWidth = Math.max(8, ...rows.map((r) => r.nextRun.length));
  const statusWidth = Math.max(
    11,
    ...rows.map((r) => r.lastStatusRaw.length),
  );

  // Header
  const header = [
    "AGENT".padEnd(agentWidth),
    "TASK".padEnd(taskWidth),
    "CRON".padEnd(cronWidth),
    "NEXT RUN".padEnd(nextRunWidth),
    "LAST STATUS".padEnd(statusWidth),
  ].join("  ");

  const separator = "-".repeat(
    agentWidth + taskWidth + cronWidth + nextRunWidth + statusWidth + 8,
  );

  // Format rows with ANSI-aware padding for status column
  const formattedRows = rows.map((row) => {
    const statusPadded =
      row.lastStatusFormatted +
      " ".repeat(Math.max(0, statusWidth - row.lastStatusRaw.length));

    return [
      row.agent.padEnd(agentWidth),
      row.task.padEnd(taskWidth),
      row.cron.padEnd(cronWidth),
      row.nextRun.padEnd(nextRunWidth),
      statusPadded,
    ].join("  ");
  });

  return [header, separator, ...formattedRows].join("\n");
}

/**
 * Register the `clawcode schedules` command.
 * Sends a "schedules" IPC request and displays a formatted table.
 */
export function registerSchedulesCommand(program: Command): void {
  program
    .command("schedules")
    .description("Show scheduled tasks and their status")
    .action(async () => {
      try {
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "schedules",
          {},
        )) as SchedulesResponse;
        cliLog(formatSchedulesTable(result));
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
