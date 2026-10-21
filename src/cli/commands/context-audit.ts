/**
 * Phase 53 Plan 01 — `clawcode context-audit <agent>` CLI command.
 *
 * Mirrors `clawcode cache` / `clawcode latency` shape for consistency.
 * Filesystem-direct — no IPC round-trip, no daemon dependency. Reads the
 * per-agent `traces.db` and aggregates per-section token counts emitted
 * on the `context_assemble` span (Wave 2 writes them).
 *
 * Default trace-store path: ~/.clawcode/agents/<agent>/traces.db
 * Override via `--trace-store <path>`.
 */

import type { Command } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import {
  buildContextAuditReport,
  type ContextAuditReport,
} from "../../performance/context-audit.js";
import { cliError, cliLog } from "../output.js";

/**
 * Format a ContextAuditReport as an aligned table with header, per-section
 * rows, trailing summary line (sampled turns + over-budget count), and
 * optional WARN / new_defaults blocks. Zero-data reports render a short
 * placeholder line instead of the table.
 */
export function formatAuditTable(report: ContextAuditReport): string {
  if (report.sampledTurns === 0) {
    return `No context-assemble data for ${report.agent} (since ${report.since}).`;
  }
  const headers = ["Section", "p50 tok", "p95 tok", "Count"];
  const rows = report.sections.map((s) => [
    s.sectionName,
    s.p50 === null ? "—" : `${s.p50}`,
    s.p95 === null ? "—" : `${s.p95}`,
    `${s.count}`,
  ]);
  const allRows: string[][] = [headers, ...rows];
  const widths = headers.map((_, col) =>
    Math.max(...allRows.map((r) => (r[col] ?? "").length)),
  );
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  const formatted = allRows.map((row, idx) => {
    const line = row
      .map((cell, col) =>
        col === 0
          ? cell.padEnd(widths[col] ?? 0)
          : cell.padStart(widths[col] ?? 0),
      )
      .join("  ");
    return idx === 0 ? `${line}\n${separator}` : line;
  });

  const lines = [
    `Context audit for ${report.agent} (since ${report.since}):`,
    "",
    ...formatted,
    "",
    `Sampled turns: ${report.sampledTurns} | over-budget resume summaries: ${report.resume_summary_over_budget_count}`,
  ];
  if (report.warnings.length > 0) {
    lines.push("", ...report.warnings.map((w) => `WARN: ${w}`));
  }
  const recs = Object.entries(report.recommendations.new_defaults);
  if (recs.length > 0) {
    lines.push("", "Recommended new_defaults (p95 * 1.2):");
    for (const [sec, val] of recs) lines.push(`  ${sec}: ${val}`);
  }
  return lines.join("\n");
}

function defaultTraceStorePath(agent: string): string {
  return join(homedir(), ".clawcode", "agents", agent, "traces.db");
}

/**
 * Register `clawcode context-audit <agent>` on the given Commander program.
 *
 * Options mirror `clawcode cache` / `clawcode latency` for consistency,
 * with three audit-specific extras: `--turns`, `--min-turns`, `--trace-store`,
 * `--out`. Filesystem-direct — NO IPC method, NO daemon dependency.
 */
export function registerContextAuditCommand(program: Command): void {
  program
    .command("context-audit <agent>")
    .description(
      "Audit per-section context payload sizes (CTX-01). Reads traces.db filesystem-direct.",
    )
    .option("--since <duration>", "Time window (e.g. 1h, 24h, 7d)", "24h")
    .option(
      "--turns <n>",
      "Sample most recent N turns (bounds the since window)",
      (v) => Number(v),
    )
    .option(
      "--min-turns <n>",
      "Minimum turns required before warning",
      (v) => Number(v),
      20,
    )
    .option(
      "--trace-store <path>",
      "Explicit traces.db path (default ~/.clawcode/agents/<agent>/traces.db)",
    )
    .option("--json", "Emit JSON instead of aligned table", false)
    .option(
      "--out <path>",
      "Also write JSON report to path (default .planning/audits/context-<timestamp>.json)",
    )
    .action(
      async (
        agent: string,
        opts: {
          since: string;
          turns?: number;
          minTurns: number;
          traceStore?: string;
          json: boolean;
          out?: string;
        },
      ) => {
        try {
          const traceStorePath =
            opts.traceStore ?? defaultTraceStorePath(agent);
          const report = buildContextAuditReport({
            traceStorePath,
            agent,
            since: opts.since,
            turns: opts.turns,
            minTurns: opts.minTurns,
          });

          const outPath =
            opts.out ??
            join(
              ".planning",
              "audits",
              `context-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
            );
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

          if (opts.json) {
            // Use console.log so tests can spy on stdout; mirrors the
            // `latency` / `cache` CLI convention.
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          console.log(formatAuditTable(report));
          cliLog(`Report written to ${outPath}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          cliError(`context-audit failed: ${msg}`);
          process.exit(1);
        }
      },
    );
}
