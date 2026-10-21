import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";
import type { CostByAgentModel } from "../../usage/types.js";

/**
 * Format cost data as an aligned table with totals.
 *
 * Phase 72 extension — adds a "Category" column between "Agent" and
 * "Model" so image-generation rows (category="image") are visually
 * distinct from token rows (category="tokens" / null / undefined).
 * Back-compat: legacy rows with `category` null or undefined display
 * as "tokens".
 *
 * @param rows - Array of CostByAgentModel entries
 * @returns Formatted table string
 */
export function formatCostsTable(rows: readonly CostByAgentModel[]): string {
  if (rows.length === 0) {
    return "No cost data for the selected period.";
  }

  const headers = ["Agent", "Category", "Model", "Tokens In", "Tokens Out", "Cost (USD)"];

  const dataRows = rows.map((r) => [
    r.agent,
    r.category ?? "tokens",
    r.model,
    r.tokens_in.toLocaleString(),
    r.tokens_out.toLocaleString(),
    `$${r.cost_usd.toFixed(4)}`,
  ]);

  const totalIn = rows.reduce((sum, r) => sum + r.tokens_in, 0);
  const totalOut = rows.reduce((sum, r) => sum + r.tokens_out, 0);
  const totalCost = rows.reduce((sum, r) => sum + r.cost_usd, 0);
  const totalRow = ["TOTAL", "", "", totalIn.toLocaleString(), totalOut.toLocaleString(), `$${totalCost.toFixed(4)}`];

  const allRows = [headers, ...dataRows, totalRow];

  // Calculate column widths
  const widths = headers.map((_, colIdx) =>
    Math.max(...allRows.map((row) => (row[colIdx] ?? "").length)),
  );

  // Format each row with padding
  const formatted = allRows.map((row, rowIdx) => {
    const line = row.map((cell, colIdx) => cell.padEnd(widths[colIdx]!)).join("  ");
    if (rowIdx === 0) {
      const separator = widths.map((w) => "-".repeat(w)).join("  ");
      return `${line}\n${separator}`;
    }
    if (rowIdx === allRows.length - 1) {
      const separator = widths.map((w) => "-".repeat(w)).join("  ");
      return `${separator}\n${line}`;
    }
    return line;
  });

  return formatted.join("\n");
}

/**
 * Register the `clawcode costs` command.
 * Sends a "costs" IPC request and displays formatted results.
 */
export function registerCostsCommand(program: Command): void {
  program
    .command("costs")
    .description("Show per-agent/per-model cost breakdown")
    .option("--period <period>", "Cost period: today, week, month", "today")
    .option("--agent <name>", "Filter by agent name")
    .action(async (opts: { period: string; agent?: string }) => {
      try {
        // IPC handler returns `{ period, costs: [...] }` — unwrap before
        // rendering. Accept the legacy bare-array shape defensively so older
        // daemons (pre-Phase-74 fix) keep working.
        const raw = (await sendIpcRequest(SOCKET_PATH, "costs", {
          period: opts.period,
          agent: opts.agent,
        })) as CostByAgentModel[] | { costs: CostByAgentModel[] };
        const rows = Array.isArray(raw) ? raw : (raw?.costs ?? []);
        cliLog(formatCostsTable(rows));
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
