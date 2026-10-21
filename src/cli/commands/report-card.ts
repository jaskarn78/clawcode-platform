/**
 * Phase 999.130 — `clawcode report-card`: the weekly fleet report card on
 * demand (the same numbers the Monday post carries).
 */

import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

type ReportCardResponse = {
  readonly text: string;
  readonly card: unknown;
};

export function registerReportCardCommand(program: Command): void {
  program
    .command("report-card")
    .description("Grade every running agent on the last 7 days (turns, cost, latency, cache, memory, incidents, workflows)")
    .option("--json", "Print the raw card (metrics + grades) instead of the rendered text")
    .action(async (opts: { json?: boolean }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "report-card", {})) as ReportCardResponse;
        if (opts.json) {
          cliLog(JSON.stringify(result.card, null, 2));
          return;
        }
        cliLog(result.text.length > 0 ? result.text : "No running agents to grade.");
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
