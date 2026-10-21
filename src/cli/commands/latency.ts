import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliError } from "../output.js";
import type {
  LatencyReport,
  PercentileRow,
  CanonicalSegment,
} from "../../performance/types.js";

/**
 * Canonical display order for the percentile table. Kept here (and mirrored
 * in src/dashboard/static/app.js) so CLI and dashboard never disagree on
 * segment ordering. NOT read from CANONICAL_SEGMENTS in case future work
 * extends that list with non-display segments.
 *
 * Phase 54 Plan 04: expanded from 4 to 6 names — first_visible_token and
 * typing_indicator appended in logical order (first_visible_token after
 * first_token, typing_indicator last). Matches CONTEXT Specifics #1.
 */
const SEGMENT_DISPLAY_ORDER: readonly CanonicalSegment[] = Object.freeze([
  "end_to_end",
  "first_token",
  "first_visible_token",
  "context_assemble",
  "tool_call",
  "typing_indicator",
]);

/**
 * Format a millisecond value with thousand separators and `ms` suffix.
 * Null values (count === 0) render as `—` (em dash) matching the dashboard.
 */
function formatMs(value: number | null): string {
  if (value === null) return "—";
  return `${value.toLocaleString()} ms`;
}

/**
 * Phase 54 Plan 04 — render the First Token Latency block that appears ABOVE
 * the segments table. Designed to be printed standalone above
 * formatLatencyTable's output. Returns empty string when the report predates
 * Phase 54 (no first_token_headline field) — backward compat.
 *
 * Suffix rendering:
 *   - `slo_status === "breach"` -> ` [BREACH]`
 *   - `slo_status === "no_data"` + count < 5 -> ` (warming up — N turns)`
 *   - healthy -> no suffix
 *
 * Example output:
 *     First Token Latency (alpha):
 *       p50: 400 ms  p95: 800 ms  p99: 1,200 ms  (count: 10)
 *
 * @param report - LatencyReport with optional first_token_headline.
 * @returns Empty string OR a 3-line block ending in a trailing blank line.
 */
export function formatFirstTokenBlock(report: LatencyReport): string {
  const h = report.first_token_headline;
  if (!h) return "";
  const suffix =
    h.slo_status === "breach"
      ? " [BREACH]"
      : h.slo_status === "no_data"
        ? ` (warming up — ${h.count.toLocaleString()} turn${h.count === 1 ? "" : "s"})`
        : "";
  return [
    `First Token Latency (${report.agent}):`,
    `  p50: ${formatMs(h.p50)}  p95: ${formatMs(h.p95)}  p99: ${formatMs(h.p99)}  (count: ${h.count.toLocaleString()})${suffix}`,
    "",
  ].join("\n");
}

/**
 * Format a single-agent LatencyReport as an aligned table with header row,
 * separator, and trailing data rows. Numeric cells right-aligned.
 *
 * Phase 54 Plan 04: prepends a First Token Latency block (via
 * `formatFirstTokenBlock`) when the report carries a `first_token_headline`.
 * Pre-Phase-54 reports render identically to Phase 50/51/52 shape.
 *
 * @param report - LatencyReport from the daemon's `latency` IPC method
 * @returns Multi-line formatted table string
 */
export function formatLatencyTable(report: LatencyReport): string {
  const headers = ["Segment", "p50", "p95", "p99", "Count"];

  const segmentByName = new Map<string, PercentileRow>(
    report.segments.map((r) => [r.segment, r]),
  );
  const dataRows = SEGMENT_DISPLAY_ORDER.map((segName) => {
    const row =
      segmentByName.get(segName) ??
      ({
        segment: segName,
        p50: null,
        p95: null,
        p99: null,
        count: 0,
      } satisfies PercentileRow);
    return [
      row.segment,
      formatMs(row.p50),
      formatMs(row.p95),
      formatMs(row.p99),
      row.count.toLocaleString(),
    ];
  });

  const allRows: string[][] = [headers, ...dataRows];
  const widths = headers.map((_, col) =>
    Math.max(...allRows.map((r) => (r[col] ?? "").length)),
  );
  const separator = widths.map((w) => "-".repeat(w)).join("  ");

  const formatted = allRows.map((row, idx) => {
    // Right-align every column except the first (segment name).
    const line = row
      .map((cell, col) =>
        col === 0 ? cell.padEnd(widths[col]!) : cell.padStart(widths[col]!),
      )
      .join("  ");
    return idx === 0 ? `${line}\n${separator}` : line;
  });

  const firstTokenBlock = formatFirstTokenBlock(report);
  const table = [
    `Latency for ${report.agent} (since ${report.since}):`,
    "",
    ...formatted,
  ].join("\n");
  return firstTokenBlock ? `${firstTokenBlock}${table}` : table;
}

/**
 * Format a fleet roll-up (one LatencyReport per running agent) as one table
 * block per agent separated by blank lines.
 */
export function formatFleetLatency(reports: readonly LatencyReport[]): string {
  if (reports.length === 0) return "No trace data for any agent.";
  return reports.map((r) => formatLatencyTable(r)).join("\n\n");
}

/**
 * Register the `clawcode latency` command.
 *
 * Sends a `latency` IPC request to the daemon and displays the resulting
 * LatencyReport (or LatencyReport[] for --all) as an aligned table or JSON.
 */
export function registerLatencyCommand(program: Command): void {
  program
    .command("latency [agent]")
    .description("Show per-agent latency percentiles (p50/p95/p99)")
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
          const result = await sendIpcRequest(SOCKET_PATH, "latency", {
            agent: opts.all ? undefined : agent,
            all: opts.all === true,
            since: opts.since,
          });
          if (opts.json) {
            // Use console.log so tests can spy on stdout; mirrors the plan
            // directive "emits JSON.stringify(result, null, 2) via console.log".
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          if (opts.all) {
            // Daemon returns LatencyReport[] for --all. Be defensive and
            // accept either a single-report object (single-agent daemon
            // build) or an array; wrap-before-format in either case.
            const reports: readonly LatencyReport[] = Array.isArray(result)
              ? (result as readonly LatencyReport[])
              : [result as LatencyReport];
            console.log(formatFleetLatency(reports));
          } else {
            console.log(formatLatencyTable(result as LatencyReport));
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
