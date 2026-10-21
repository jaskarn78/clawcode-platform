import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliError } from "../output.js";
import type {
  SloMetric,
  SloStatus,
  ToolPercentileRow,
} from "../../performance/types.js";

/**
 * Phase 55 Plan 03 — augmented per-tool report emitted by the daemon's
 * `case "tools"` handler. Mirrors `ToolPercentileRow` + three SLO fields.
 *
 * The CLI + dashboard consume this shape verbatim — the SLO fields are
 * computed server-side via `getPerToolSlo` so per-tool override semantics
 * stay consistent across both surfaces (single source of truth).
 */
export type AugmentedToolRow = ToolPercentileRow & {
  readonly slo_status: SloStatus;
  readonly slo_threshold_ms: number;
  readonly slo_metric: SloMetric;
};

/**
 * Phase 55 Plan 03 — shape returned by the `tools` IPC method + the
 * `clawcode tools` CLI. Sorted by p95 DESC at the SQL layer so consumers
 * render slowest-first without a resort.
 */
export type ToolsReport = {
  readonly agent: string;
  readonly since: string;
  readonly tools: readonly AugmentedToolRow[];
};

/**
 * Format a millisecond value with locale thousand separators and `ms` suffix.
 * `null` renders as `—` (em dash), matching the latency / cache formatters.
 */
function formatMs(value: number | null): string {
  if (value === null) return "—";
  return `${value.toLocaleString()} ms`;
}

/**
 * Format the SLO column cell for a single tool row. Breach rows carry the
 * `[SLOW]` sigil as a standalone column so table alignment stays clean even
 * when tool names vary in length. Healthy rows show `ok`; no-data rows show
 * an em dash.
 */
function formatSloCell(status: SloStatus): string {
  if (status === "breach") return "[SLOW]";
  if (status === "healthy") return "ok";
  return "—";
}

/**
 * Format a single-agent ToolsReport as an aligned table.
 *
 * Columns: `Tool | p50 | p95 | p99 | Count | SLO`. Tool column left-aligned
 * (string); all other columns right-aligned (numeric or status sigil).
 *
 * Returns the `No tool-call data` message when the window is empty — no
 * table, no headers, just a single line so operators immediately see "no
 * data yet" without eye-scanning an empty table.
 */
export function formatToolsTable(report: ToolsReport): string {
  if (report.tools.length === 0) {
    return `No tool-call data for ${report.agent} (since ${report.since}).`;
  }

  const headers = ["Tool", "p50", "p95", "p99", "Count", "SLO"];
  const dataRows = report.tools.map((row) => [
    row.tool_name,
    formatMs(row.p50),
    formatMs(row.p95),
    formatMs(row.p99),
    row.count.toLocaleString(),
    formatSloCell(row.slo_status),
  ]);

  const allRows: string[][] = [headers, ...dataRows];
  const widths = headers.map((_, col) =>
    Math.max(...allRows.map((r) => (r[col] ?? "").length)),
  );
  const separator = widths.map((w) => "-".repeat(w)).join("  ");

  const formatted = allRows.map((row, idx) => {
    // Left-align the tool name column (col 0); right-align every other
    // column (numeric or status sigil).
    const line = row
      .map((cell, col) =>
        col === 0 ? cell.padEnd(widths[col]!) : cell.padStart(widths[col]!),
      )
      .join("  ");
    return idx === 0 ? `${line}\n${separator}` : line;
  });

  return [
    `Tool-call latency for ${report.agent} (since ${report.since}):`,
    "",
    ...formatted,
  ].join("\n");
}

/**
 * Format a fleet roll-up (one augmented ToolsReport per running agent) as
 * one table block per agent separated by blank lines. Mirrors
 * `formatFleetLatency` / `formatFleetCache` in structure.
 */
export function formatFleetTools(
  reports: readonly ToolsReport[],
): string {
  if (reports.length === 0) return "No tool-call data for any agent.";
  return reports.map((r) => formatToolsTable(r)).join("\n\n");
}

/**
 * Register the `clawcode tools` command.
 *
 * Mirrors `clawcode latency` / `clawcode cache` shape line-for-line:
 * positional `<agent>`, `--since <duration>` (default `24h`), `--all`,
 * `--json`. Sends a `tools` IPC request to the daemon and displays the
 * augmented ToolsReport (or array for --all) as an aligned table or JSON.
 *
 * Exits 1 with a friendly message when the daemon is not running
 * (ManagerNotRunningError).
 */
export function registerToolsCommand(program: Command): void {
  program
    .command("tools [agent]")
    .description("Show per-tool round-trip timing (p50/p95/p99) with SLO status")
    .option("--since <duration>", "Time window (e.g. 1h, 6h, 24h, 7d)", "24h")
    .option("--all", "Aggregate across all running agents", false)
    .option("--json", "Emit JSON instead of an aligned table", false)
    .action(
      async (
        agent: string | undefined,
        opts: { since: string; all: boolean; json: boolean },
      ) => {
        try {
          if (!opts.all && !agent) {
            cliError("Agent name required (or use --all).");
            process.exit(1);
            return;
          }
          const result = await sendIpcRequest(SOCKET_PATH, "tools", {
            agent: opts.all ? undefined : agent,
            all: opts.all === true,
            since: opts.since,
          });
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          if (opts.all) {
            const reports: readonly ToolsReport[] = Array.isArray(result)
              ? (result as readonly ToolsReport[])
              : [result as ToolsReport];
            console.log(formatFleetTools(reports));
          } else {
            console.log(formatToolsTable(result as ToolsReport));
          }
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
