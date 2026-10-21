/**
 * Phase 62 Plan 03 -- CLI `clawcode policy dry-run` command.
 *
 * Replays recent trigger events (from tasks.db) against on-disk policies.yaml
 * to validate policy changes BEFORE they affect the running system.
 *
 * Opens SQLite in read-only mode -- no running daemon needed (POL-04).
 * Color-coded table output with --json flag for machine-readable output.
 */

import type { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { loadPolicies } from "../../triggers/policy-loader.js";
import { PolicyEvaluator, type PolicyResult } from "../../triggers/policy-evaluator.js";
import type { TriggerEvent } from "../../triggers/types.js";
import { cliLog, cliError } from "../output.js";

// ---------------------------------------------------------------------------
// DryRunRow — the shape of each result row
// ---------------------------------------------------------------------------

export type DryRunRow = {
  readonly timestamp: string;
  readonly source: string;
  readonly sourceKind: string;
  readonly event: string;
  readonly rule: string;
  readonly agent: string;
  readonly action: string;
};

// ---------------------------------------------------------------------------
// parseDuration — convert human-readable duration strings to milliseconds
// ---------------------------------------------------------------------------

/**
 * Parse a duration string like "1h", "30m", "2d", "60s" into milliseconds.
 *
 * @param input Duration string with number + unit suffix (s/m/h/d)
 * @returns Duration in milliseconds
 * @throws Error if the format is invalid
 */
export function parseDuration(input: string): number {
  const match = input.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(
      `Invalid duration: "${input}". Use format like 1h, 30m, 2d, 60s`,
    );
  }
  const [, value, unit] = match;
  const n = parseInt(value!, 10);
  const multipliers: Readonly<Record<string, number>> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return n * multipliers[unit!]!;
}

// ---------------------------------------------------------------------------
// runDryRun — core dry-run logic
// ---------------------------------------------------------------------------

/**
 * Read trigger_events from tasks.db (read-only), evaluate each against
 * on-disk policies.yaml, and return result rows.
 *
 * @param opts.dbPath Path to tasks.db
 * @param opts.policyPath Path to policies.yaml
 * @param opts.sinceMs Time window in milliseconds
 * @returns Array of DryRunRow results
 * @throws Error if dbPath or policyPath doesn't exist
 */
export function runDryRun(opts: {
  readonly dbPath: string;
  readonly policyPath: string;
  readonly sinceMs: number;
}): readonly DryRunRow[] {
  // 1. Validate files exist
  if (!existsSync(opts.dbPath)) {
    throw new Error(`tasks.db not found at ${opts.dbPath}`);
  }
  if (!existsSync(opts.policyPath)) {
    throw new Error(`policies.yaml not found at ${opts.policyPath}`);
  }

  // 2. Load policies
  const yamlContent = readFileSync(opts.policyPath, "utf-8");
  const rules = loadPolicies(yamlContent);

  // 3. Create evaluator — dry-run uses a permissive agent set (all rule targets allowed)
  //    so we see what WOULD happen, not what the daemon currently allows.
  const allTargets = new Set(rules.map((r) => r.target));
  const evaluator = new PolicyEvaluator(rules, allTargets);

  // 4. Read trigger_events from SQLite (read-only per locked decision)
  const sinceEpoch = Date.now() - opts.sinceMs;
  const db = new Database(opts.dbPath, { readonly: true, fileMustExist: true });

  type EventRow = {
    readonly source_id: string;
    readonly idempotency_key: string;
    readonly created_at: number;
    readonly source_kind: string | null;
    readonly payload: string | null;
  };

  let rows: readonly EventRow[];
  try {
    rows = db
      .prepare(
        "SELECT source_id, idempotency_key, created_at, source_kind, payload FROM trigger_events WHERE created_at > ? ORDER BY created_at ASC",
      )
      .all(sinceEpoch) as EventRow[];
  } finally {
    db.close();
  }

  // 5. Evaluate each event against the policy
  return rows.map((row): DryRunRow => {
    let parsedPayload: unknown = null;
    if (row.payload) {
      try {
        parsedPayload = JSON.parse(row.payload);
      } catch {
        parsedPayload = row.payload;
      }
    }

    const event: TriggerEvent = {
      sourceId: row.source_id,
      idempotencyKey: row.idempotency_key,
      targetAgent: "", // dry-run: let the policy decide the target
      payload: parsedPayload,
      timestamp: row.created_at,
      sourceKind: row.source_kind ?? undefined,
    };

    const result: PolicyResult = evaluator.evaluate(event);

    return {
      timestamp: new Date(row.created_at).toISOString(),
      source: row.source_id,
      sourceKind: row.source_kind ?? "unknown",
      event:
        row.idempotency_key.length > 20
          ? row.idempotency_key.slice(0, 17) + "..."
          : row.idempotency_key,
      rule: result.allow ? result.ruleId : "no match",
      agent: result.allow ? result.targetAgent : "-",
      action: result.allow ? "allow" : `deny: ${result.reason}`,
    };
  });
}

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// formatDryRunTable — aligned table with color-coded Action column
// ---------------------------------------------------------------------------

/**
 * Format dry-run results as an aligned table with color-coded actions.
 * Follows the formatCostsTable pattern from costs.ts.
 *
 * @param rows Array of DryRunRow results
 * @returns Formatted table string
 */
export function formatDryRunTable(rows: readonly DryRunRow[]): string {
  if (rows.length === 0) {
    return "No events found in the specified window.";
  }

  const headers = ["Timestamp", "Source", "Event", "Rule", "Agent", "Action"];

  const dataRows = rows.map((r) => [
    r.timestamp,
    r.source,
    r.event,
    r.rule,
    r.agent,
    r.action,
  ]);

  const allRows = [headers, ...dataRows];

  // Calculate column widths (ignoring ANSI codes for Action column)
  const widths = headers.map((_, colIdx) =>
    Math.max(...allRows.map((row) => (row[colIdx] ?? "").length)),
  );

  // Format each row with padding and color
  const formatted = allRows.map((row, rowIdx) => {
    const cells = row.map((cell, colIdx) => {
      const padded = cell.padEnd(widths[colIdx]!);
      // Color the Action column (last column) for data rows
      if (colIdx === 5 && rowIdx > 0) {
        if (cell.startsWith("allow")) {
          return `${GREEN}${padded}${RESET}`;
        }
        return `${RED}${padded}${RESET}`;
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
// formatDryRunJson — machine-readable JSON output
// ---------------------------------------------------------------------------

/**
 * Format dry-run results as a pretty-printed JSON array.
 *
 * @param rows Array of DryRunRow results
 * @returns JSON string
 */
export function formatDryRunJson(rows: readonly DryRunRow[]): string {
  return JSON.stringify(rows, null, 2);
}

// ---------------------------------------------------------------------------
// registerPolicyCommand — CLI command registration
// ---------------------------------------------------------------------------

/**
 * Register the `clawcode policy` command group with `dry-run` subcommand.
 *
 * @param program Commander program instance
 */
export function registerPolicyCommand(program: Command): void {
  const policy = program
    .command("policy")
    .description("Policy management commands");

  policy
    .command("dry-run")
    .description(
      "Replay recent trigger events against on-disk policies.yaml",
    )
    .requiredOption(
      "--since <duration>",
      "Time window to replay (e.g., 1h, 30m, 2d)",
    )
    .option("--json", "Output as JSON instead of table")
    .option(
      "--db <path>",
      "Path to tasks.db",
      join(process.env.HOME ?? "~", ".clawcode", "manager", "tasks.db"),
    )
    .option(
      "--policy <path>",
      "Path to policies.yaml",
      join(process.env.HOME ?? "~", ".clawcode", "policies.yaml"),
    )
    .action(
      async (opts: {
        since: string;
        json?: boolean;
        db: string;
        policy: string;
      }) => {
        try {
          const sinceMs = parseDuration(opts.since);
          const results = runDryRun({
            dbPath: opts.db,
            policyPath: opts.policy,
            sinceMs,
          });

          if (results.length === 0) {
            cliLog("No trigger events found in the specified window.");
            return;
          }

          if (opts.json) {
            cliLog(formatDryRunJson(results));
          } else {
            cliLog(formatDryRunTable(results));
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
