/**
 * Phase 999.8 follow-up (2026-04-30) — `clawcode tier-tick` CLI command.
 *
 * Triggers tier-maintenance on-demand for one agent or all agents. The same
 * `TierManager.runMaintenance()` runs every 6 hours via the heartbeat
 * (Phase 107 Plan 03 fixed the discovery so it actually fires now). This
 * command lets the operator backfill the hot/warm/cold tier distribution
 * without waiting up to 6h for the first scheduled tick — useful right
 * after a fresh deploy.
 *
 * Mirrors the `clawcode health` IPC-thin-wrapper pattern: send IPC request,
 * format response as a table, exit non-zero on error.
 */

import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

/** Per-agent maintenance result returned by the IPC. */
type AgentResult = Readonly<{
  promoted: number;
  demoted: number;
  archived: number;
  /** Phase 999.119 — optional so an older daemon's response still renders. */
  rewarmed?: number;
  errors?: number;
  firstError?: string | null;
}>;

/** Shape of the tier-maintenance-tick IPC response. */
type TierTickResponse = Readonly<{
  results: Readonly<Record<string, AgentResult>>;
  skipped: readonly string[];
}>;

/**
 * Format the IPC response as an aligned per-agent table.
 *
 * Pure function — exported for testing.
 */
export function formatTierTickTable(data: TierTickResponse): string {
  const names = Object.keys(data.results);
  if (names.length === 0 && data.skipped.length === 0) {
    return "No agents with tier managers configured";
  }
  const rows = names.map((name) => {
    const r = data.results[name];
    return {
      name,
      promoted: r.promoted,
      demoted: r.demoted,
      archived: r.archived,
      rewarmed: r.rewarmed ?? 0,
      errors: r.errors ?? 0,
      firstError: r.firstError ?? null,
    };
  });
  const nameWidth = Math.max(5, ...rows.map((r) => r.name.length));
  const numWidth = 8;
  const header = [
    "AGENT".padEnd(nameWidth),
    "PROMOTED".padEnd(numWidth),
    "DEMOTED".padEnd(numWidth),
    "COOLED".padEnd(numWidth),
    "REWARMED".padEnd(numWidth),
    "ERRORS".padEnd(numWidth),
  ].join("  ");
  const sep = "-".repeat(nameWidth + numWidth * 5 + 10);
  const body = rows.map((r) =>
    [
      r.name.padEnd(nameWidth),
      String(r.promoted).padEnd(numWidth),
      String(r.demoted).padEnd(numWidth),
      String(r.archived).padEnd(numWidth),
      String(r.rewarmed).padEnd(numWidth),
      String(r.errors).padEnd(numWidth),
    ].join("  "),
  );
  const lines = [header, sep, ...body];
  const errored = rows.filter((r) => r.errors > 0 && r.firstError);
  for (const r of errored) {
    lines.push(`  ${r.name}: first error — ${r.firstError}`);
  }
  if (data.skipped.length > 0) {
    lines.push("", `Skipped (no tier manager): ${data.skipped.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Register the `clawcode tier-tick` command.
 * Sends a `tier-maintenance-tick` IPC request and prints the result table.
 */
export function registerTierTickCommand(program: Command): void {
  program
    .command("tier-tick [agent]")
    .description(
      "Run tier-maintenance now for one agent or all (skips waiting for 6h heartbeat tick)",
    )
    .action(async (agent: string | undefined) => {
      try {
        const params: Record<string, unknown> = {};
        if (agent !== undefined) params.agent = agent;
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "tier-maintenance-tick",
          params,
        )) as TierTickResponse;
        cliLog(formatTierTickTable(result));
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError("Manager is not running. Start it with: clawcode start-all");
          process.exit(1);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${message}`);
        process.exit(1);
      }
    });
}
