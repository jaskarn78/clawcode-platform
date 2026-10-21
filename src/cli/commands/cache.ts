import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliError } from "../output.js";
import type {
  CacheHitRateStatus,
  CacheTelemetryReport,
} from "../../performance/types.js";

/**
 * Augmented report shape emitted by the daemon's `case "cache"` handler.
 * Mirrors `CacheTelemetryReport` + `status` + `cache_effect_ms` (exact fields
 * added by the handler's `buildReport` closure in `src/manager/daemon.ts`).
 *
 * The CLI/dashboard consume this shape verbatim — the two extra fields are
 * computed server-side so per-agent override semantics stay consistent.
 */
export type AugmentedCacheReport = CacheTelemetryReport & {
  readonly status: CacheHitRateStatus;
  readonly cache_effect_ms: number | null;
};

/**
 * Format a hit-rate ratio (0..1) as a right-padded percentage with one
 * decimal place. Renders `0.723` as `"72.3%"`, `0` as `"0.0%"`, `null` as
 * `"—"` (em dash, matches the latency formatter's null convention).
 */
function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Format a count (integer) with locale thousand separators.
 */
function formatCount(value: number): string {
  return value.toLocaleString();
}

/**
 * Format a single-agent augmented CacheTelemetryReport as an aligned table.
 *
 * Columns (per CONTEXT — Hit Rate first as the primary signal):
 *   Hit Rate | Cache Reads | Cache Writes | Input Tokens | Turns
 *
 * Returns `"No cache data for ${agent}"` when the window has zero cache-aware
 * turns (idle or pre-Phase-52 agent).
 */
export function formatCacheTable(report: AugmentedCacheReport): string {
  if (report.totalTurns === 0) {
    return `No cache data for ${report.agent} (since ${report.since}).`;
  }

  const headers = ["Hit Rate", "Cache Reads", "Cache Writes", "Input Tokens", "Turns"];
  const dataRow = [
    formatPercent(report.avgHitRate),
    formatCount(report.totalCacheReads),
    formatCount(report.totalCacheWrites),
    formatCount(report.totalInputTokens),
    formatCount(report.totalTurns),
  ];

  const allRows: string[][] = [headers, dataRow];
  const widths = headers.map((_, col) =>
    Math.max(...allRows.map((r) => (r[col] ?? "").length)),
  );
  const separator = widths.map((w) => "-".repeat(w)).join("  ");

  const formatted = allRows.map((row, idx) => {
    // All cells right-aligned (numeric or percentage).
    const line = row
      .map((cell, col) => cell.padStart(widths[col]!))
      .join("  ");
    return idx === 0 ? `${line}\n${separator}` : line;
  });

  const lines = [
    `Cache for ${report.agent} (since ${report.since}):`,
    "",
    ...formatted,
    "",
    `Status: ${report.status}   p50: ${formatPercent(report.p50HitRate)}   p95: ${formatPercent(report.p95HitRate)}`,
  ];

  // Cache-effect footer: advisory line mirroring the dashboard's subtitle.
  // Suppressed when null (< 20 eligible turns OR one-sided data — CONTEXT D-05).
  if (report.cache_effect_ms !== null) {
    const ms = Math.round(report.cache_effect_ms);
    const sign = ms < 0 ? `${ms}` : `+${ms}`;
    lines.push(`Cache effect: ${sign} ms first-token (negative = cache helps)`);
  } else {
    lines.push("Cache effect: insufficient data (< 20 eligible turns)");
  }

  return lines.join("\n");
}

/**
 * Format a fleet roll-up (one augmented report per running agent) as one
 * table block per agent separated by blank lines. Mirrors `formatFleetLatency`.
 */
export function formatFleetCache(
  reports: readonly AugmentedCacheReport[],
): string {
  if (reports.length === 0) return "No cache data for any agent.";
  return reports.map((r) => formatCacheTable(r)).join("\n\n");
}

/**
 * Register the `clawcode cache` command.
 *
 * Mirrors `clawcode latency` shape line-for-line: positional `<agent>`,
 * `--since <duration>` (default `24h`), `--all`, `--json`. Sends a `cache`
 * IPC request to the daemon and displays the augmented CacheTelemetryReport
 * (or array for --all) as an aligned table or JSON blob.
 *
 * Exits 1 with a friendly message when the daemon is not running
 * (ManagerNotRunningError).
 */
export function registerCacheCommand(program: Command): void {
  program
    .command("cache [agent]")
    .description("Show per-agent prompt-cache hit rate + first-token cache effect")
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
          const result = await sendIpcRequest(SOCKET_PATH, "cache", {
            agent: opts.all ? undefined : agent,
            all: opts.all === true,
            since: opts.since,
          });
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          if (opts.all) {
            const reports: readonly AugmentedCacheReport[] = Array.isArray(
              result,
            )
              ? (result as readonly AugmentedCacheReport[])
              : [result as AugmentedCacheReport];
            console.log(formatFleetCache(reports));
          } else {
            console.log(formatCacheTable(result as AugmentedCacheReport));
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
