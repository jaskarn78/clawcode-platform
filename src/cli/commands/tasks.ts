/**
 * Phase 59 Plan 03 -- CLI `clawcode tasks` subcommands.
 *
 * Provides `retry <task_id>` and `status <task_id>` against a running daemon
 * via IPC. Mirrors the `schedules` command pattern (sendIpcRequest + error
 * handling for ManagerNotRunningError).
 *
 * Phase 63 Plan 01 -- adds `list` subcommand (offline, read-only SQLite).
 * Lists recent inter-agent tasks with caller, target, state, duration,
 * depth, chain_token_cost. No running daemon needed (OBS-02 + OBS-05).
 */

import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { parseDuration } from "./policy.js";
import { formatTokenCount, formatDuration } from "./triggers.js";
import { cliLog, cliError } from "../output.js";

// ---------------------------------------------------------------------------
// TaskListRow — the shape of each result row for `tasks list`
// ---------------------------------------------------------------------------

export type TaskListRow = {
  readonly taskId: string;
  readonly caller: string;
  readonly target: string;
  readonly state: string;
  readonly duration: string;
  readonly depth: number;
  readonly cost: string;
};

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Terminal statuses that show red. */
const RED_STATUSES = new Set(["failed", "timed_out", "cancelled", "orphaned"]);

/** In-flight statuses that show yellow. */
const YELLOW_STATUSES = new Set(["running", "pending", "awaiting_input"]);

// ---------------------------------------------------------------------------
// queryTaskList — read tasks from tasks.db (read-only)
// ---------------------------------------------------------------------------

/** Raw row shape from SELECT on tasks table. */
type TaskRawRow = {
  readonly task_id: string;
  readonly caller_agent: string;
  readonly target_agent: string;
  readonly status: string;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly depth: number;
  readonly chain_token_cost: number;
};

/**
 * Query tasks from tasks.db (read-only) with optional filters.
 *
 * @param opts.dbPath Path to tasks.db
 * @param opts.sinceMs Time window in milliseconds from now
 * @param opts.agent Optional caller/target agent filter
 * @param opts.state Optional status filter
 * @returns Frozen array of TaskListRow
 * @throws Error if dbPath doesn't exist
 */
export function queryTaskList(opts: {
  readonly dbPath: string;
  readonly sinceMs: number;
  readonly agent?: string;
  readonly state?: string;
}): readonly TaskListRow[] {
  if (!existsSync(opts.dbPath)) {
    throw new Error(`tasks.db not found at ${opts.dbPath}`);
  }

  const sinceEpoch = Date.now() - opts.sinceMs;
  const db = new Database(opts.dbPath, { readonly: true, fileMustExist: true });

  try {
    const conditions: string[] = ["started_at > ?"];
    const params: (string | number)[] = [sinceEpoch];

    if (opts.agent) {
      conditions.push("(caller_agent = ? OR target_agent = ?)");
      params.push(opts.agent, opts.agent);
    }

    if (opts.state) {
      conditions.push("status = ?");
      params.push(opts.state);
    }

    const whereClause = conditions.join(" AND ");

    const sql = `
      SELECT task_id, caller_agent, target_agent, status,
             started_at, ended_at, depth, chain_token_cost
      FROM tasks
      WHERE ${whereClause}
      ORDER BY started_at DESC
    `;

    const rows = db.prepare(sql).all(...params) as TaskRawRow[];

    return Object.freeze(
      rows.map(
        (row): TaskListRow => ({
          taskId:
            row.task_id.length > 12
              ? row.task_id.slice(0, 12) + "..."
              : row.task_id,
          caller: row.caller_agent,
          target: row.target_agent,
          state: row.status,
          duration: formatDuration(row.started_at, row.ended_at),
          depth: row.depth,
          cost: formatTokenCount(row.chain_token_cost),
        }),
      ),
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// formatTasksTable — aligned table with color-coded State column
// ---------------------------------------------------------------------------

/**
 * Format task list results as an aligned table with color-coded state.
 *
 * @param rows Array of TaskListRow results
 * @returns Formatted table string
 */
export function formatTasksTable(rows: readonly TaskListRow[]): string {
  if (rows.length === 0) {
    return "No tasks found in the specified window.";
  }

  const headers = ["Task ID", "Caller", "Target", "State", "Duration", "Depth", "Cost"];

  const dataRows = rows.map((r) => [
    r.taskId,
    r.caller,
    r.target,
    r.state,
    r.duration,
    String(r.depth),
    r.cost,
  ]);

  const allRows = [headers, ...dataRows];

  // Calculate column widths (plain text, no ANSI codes)
  const widths = headers.map((_, colIdx) =>
    Math.max(...allRows.map((row) => (row[colIdx] ?? "").length)),
  );

  // Format each row with padding and color
  const formatted = allRows.map((row, rowIdx) => {
    const cells = row.map((cell, colIdx) => {
      const padded = cell.padEnd(widths[colIdx]!);
      // Color the State column (index 3) for data rows
      if (colIdx === 3 && rowIdx > 0) {
        if (cell === "complete") {
          return `${GREEN}${padded}${RESET}`;
        }
        if (RED_STATUSES.has(cell)) {
          return `${RED}${padded}${RESET}`;
        }
        if (YELLOW_STATUSES.has(cell)) {
          return `${YELLOW}${padded}${RESET}`;
        }
      }
      return padded;
    });

    const line = cells.join("  ");

    if (rowIdx === 0) {
      const separator = widths.map((w) => "-".repeat(w)).join("  ");
      return `${line}\n${separator}`;
    }
    return line;
  });

  return formatted.join("\n");
}

/** Default path to tasks.db */
const defaultTasksDbPath = join(
  homedir(),
  ".clawcode",
  "manager",
  "tasks.db",
);

export function registerTasksCommand(program: Command): void {
  const tasks = program
    .command("tasks")
    .description("Cross-agent task commands");

  // Phase 63 -- list subcommand (offline, read-only SQLite)
  tasks
    .command("list")
    .description("List recent inter-agent tasks")
    .option("--since <duration>", "Time window (e.g., 1h, 30m, 2d)", "1h")
    .option("--agent <name>", "Filter by caller or target agent")
    .option("--state <status>", "Filter by task status")
    .option("--json", "Output as JSON")
    .option("--db <path>", "Path to tasks.db", defaultTasksDbPath)
    .action(
      async (opts: {
        since: string;
        agent?: string;
        state?: string;
        json?: boolean;
        db: string;
      }) => {
        try {
          const sinceMs = parseDuration(opts.since);
          const results = queryTaskList({
            dbPath: opts.db,
            sinceMs,
            agent: opts.agent,
            state: opts.state,
          });

          if (results.length === 0) {
            cliLog("No tasks found in the specified window.");
            return;
          }

          if (opts.json) {
            cliLog(JSON.stringify(results, null, 2));
          } else {
            cliLog(formatTasksTable(results));
          }
        } catch (error) {
          cliError(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exit(1);
        }
      },
    );

  tasks
    .command("retry <task_id>")
    .description("Re-run a failed/cancelled/timed_out task with the identical payload")
    .action(async (taskId: string) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "task-retry", {
          task_id: taskId,
        })) as { task_id: string };
        cliLog(`Retried ${taskId} as ${result.task_id} (digest preserved).`);
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError("Manager is not running. Start it with: clawcode start-all");
          process.exit(1);
          return;
        }
        cliError(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  tasks
    .command("status <task_id>")
    .description("Print the status of a delegated task")
    .action(async (taskId: string) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "task-status", {
          task_id: taskId,
        })) as {
          task_id: string;
          status: string;
          error?: string;
          result?: unknown;
        };
        cliLog(`Task ${result.task_id}: ${result.status}`);
        if (result.error) cliLog(`  error: ${result.error}`);
        if (result.result !== undefined) {
          cliLog(`  result: ${JSON.stringify(result.result, null, 2)}`);
        }
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError("Manager is not running. Start it with: clawcode start-all");
          process.exit(1);
          return;
        }
        cliError(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
