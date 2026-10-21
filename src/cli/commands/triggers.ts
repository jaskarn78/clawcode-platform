/**
 * Phase 63 Plan 01 Task 1 -- CLI `clawcode triggers` command.
 *
 * Lists recent trigger fire events from tasks.db with correlated task
 * outcomes. Opens SQLite in read-only mode -- no running daemon needed (OBS-01).
 *
 * Join strategy: temporal proximity LEFT JOIN between trigger_events and tasks.
 * The trigger_events table has no causation_id column -- the link is indirect.
 * We match events to tasks by finding the task whose started_at falls within
 * a [created_at - 1s, created_at + 10s] window. For high-frequency overlapping
 * triggers this may produce false matches; acceptable for a v1 CLI display.
 *
 * Color-coded table output with --json flag for machine-readable output.
 */

import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import { parseDuration } from "./policy.js";
import { cliLog, cliError } from "../output.js";

// ---------------------------------------------------------------------------
// TriggerFireRow — the shape of each result row
// ---------------------------------------------------------------------------

export type TriggerFireRow = {
  readonly timestamp: string;
  readonly source: string;
  readonly kind: string;
  readonly target: string;
  readonly result: string;
  readonly duration: string;
};

// ---------------------------------------------------------------------------
// formatTokenCount — human-readable token counts
// ---------------------------------------------------------------------------

/**
 * Format a token count into a human-readable string.
 *
 * @param n Token count (non-negative integer)
 * @returns "0", "500", "1.2K", "45.3K", "1.2M", etc.
 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// formatDuration — human-readable elapsed time
// ---------------------------------------------------------------------------

/**
 * Format a time span as a human-readable duration.
 *
 * @param startedAt Start epoch (ms)
 * @param endedAt End epoch (ms), or null if still running
 * @returns "running", "500ms", "1.2s", "3.4m"
 */
export function formatDuration(
  startedAt: number,
  endedAt: number | null,
): string {
  if (endedAt === null) return "running";
  const ms = endedAt - startedAt;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// ---------------------------------------------------------------------------
// queryTriggerFires — read trigger events with task correlation
// ---------------------------------------------------------------------------

/** Raw row shape returned by the temporal proximity JOIN query. */
type JoinedRow = {
  readonly created_at: number;
  readonly source_id: string;
  readonly source_kind: string | null;
  readonly idempotency_key: string;
  readonly target_agent: string | null;
  readonly task_status: string | null;
  readonly task_started_at: number | null;
  readonly task_ended_at: number | null;
};

/**
 * Query trigger_events from tasks.db (read-only) with temporal proximity
 * JOIN to tasks table for outcome correlation.
 *
 * @param opts.dbPath Path to tasks.db
 * @param opts.sinceMs Time window in milliseconds from now
 * @param opts.source Optional source_id filter
 * @param opts.agent Optional target_agent filter
 * @returns Frozen array of TriggerFireRow
 * @throws Error if dbPath doesn't exist
 */
export function queryTriggerFires(opts: {
  readonly dbPath: string;
  readonly sinceMs: number;
  readonly source?: string;
  readonly agent?: string;
}): readonly TriggerFireRow[] {
  if (!existsSync(opts.dbPath)) {
    throw new Error(`tasks.db not found at ${opts.dbPath}`);
  }

  const sinceEpoch = Date.now() - opts.sinceMs;
  const db = new Database(opts.dbPath, { readonly: true, fileMustExist: true });

  try {
    // Build query with optional filters.
    // Temporal proximity JOIN: match trigger_events to the closest task
    // whose started_at falls within [created_at - 1s, created_at + 10s].
    // GROUP BY te.rowid + MIN(ABS(delta)) handles multiple-match windows.
    const conditions: string[] = ["te.created_at > ?"];
    const params: (string | number)[] = [sinceEpoch];

    if (opts.source) {
      conditions.push("te.source_id = ?");
      params.push(opts.source);
    }

    if (opts.agent) {
      conditions.push("t.target_agent = ?");
      params.push(opts.agent);
    }

    const whereClause = conditions.join(" AND ");

    // For the agent filter, we need an INNER JOIN (to filter out events
    // without matching tasks). Otherwise, LEFT JOIN to show all events.
    const joinType = opts.agent ? "INNER JOIN" : "LEFT JOIN";

    const sql = `
      SELECT
        te.created_at,
        te.source_id,
        te.source_kind,
        te.idempotency_key,
        t.target_agent,
        t.status AS task_status,
        t.started_at AS task_started_at,
        t.ended_at AS task_ended_at
      FROM trigger_events te
      ${joinType} (
        SELECT tasks.*, ABS(tasks.started_at - te2.created_at) AS delta
        FROM trigger_events te2
        JOIN tasks ON tasks.started_at BETWEEN te2.created_at - 1000 AND te2.created_at + 10000
      ) t ON t.delta = (
        SELECT MIN(ABS(tasks2.started_at - te.created_at))
        FROM tasks tasks2
        WHERE tasks2.started_at BETWEEN te.created_at - 1000 AND te.created_at + 10000
      )
      WHERE ${whereClause}
      GROUP BY te.rowid
      ORDER BY te.created_at DESC
    `;

    const rows = db.prepare(sql).all(...params) as JoinedRow[];

    return Object.freeze(
      rows.map(
        (row): TriggerFireRow => ({
          timestamp: new Date(row.created_at).toISOString(),
          source: row.source_id,
          kind: row.source_kind ?? "unknown",
          target: row.target_agent ?? "--",
          result: row.task_status ?? "--",
          duration:
            row.task_started_at !== null
              ? formatDuration(row.task_started_at, row.task_ended_at)
              : "--",
        }),
      ),
    );
  } finally {
    db.close();
  }
}

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
// formatTriggersTable — aligned table with color-coded Result column
// ---------------------------------------------------------------------------

/**
 * Format trigger fire results as an aligned table with color-coded results.
 *
 * @param rows Array of TriggerFireRow results
 * @returns Formatted table string
 */
export function formatTriggersTable(rows: readonly TriggerFireRow[]): string {
  if (rows.length === 0) {
    return "No trigger events found in the specified window.";
  }

  const headers = ["Timestamp", "Source", "Kind", "Target", "Result", "Duration"];

  const dataRows = rows.map((r) => [
    r.timestamp,
    r.source,
    r.kind,
    r.target,
    r.result,
    r.duration,
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
      // Color the Result column (index 4) for data rows
      if (colIdx === 4 && rowIdx > 0) {
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

// ---------------------------------------------------------------------------
// registerTriggersCommand — CLI command registration
// ---------------------------------------------------------------------------

/** Default path to tasks.db */
const defaultTasksDbPath = join(
  homedir(),
  ".clawcode",
  "manager",
  "tasks.db",
);

/**
 * Register the `clawcode triggers` command.
 *
 * @param program Commander program instance
 */
export function registerTriggersCommand(program: Command): void {
  program
    .command("triggers")
    .description("List recent trigger fire events with task outcomes")
    .option("--since <duration>", "Time window (e.g., 1h, 30m, 2d)", "1h")
    .option("--source <source_id>", "Filter by trigger source")
    .option("--agent <name>", "Filter by target agent")
    .option("--json", "Output as JSON")
    .option("--db <path>", "Path to tasks.db", defaultTasksDbPath)
    .action(
      async (opts: {
        since: string;
        source?: string;
        agent?: string;
        json?: boolean;
        db: string;
      }) => {
        try {
          const sinceMs = parseDuration(opts.since);
          const results = queryTriggerFires({
            dbPath: opts.db,
            sinceMs,
            source: opts.source,
            agent: opts.agent,
          });

          if (results.length === 0) {
            cliLog("No trigger events found in the specified window.");
            return;
          }

          if (opts.json) {
            cliLog(JSON.stringify(results, null, 2));
          } else {
            cliLog(formatTriggersTable(results));
          }
        } catch (error) {
          cliError(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exit(1);
        }
      },
    );
}
