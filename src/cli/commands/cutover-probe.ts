/**
 * Phase 92 Plan 02 — `clawcode cutover probe` subcommand.
 *
 * Production wrapper that wires three production-side I/O slots into the
 * pure-DI `probeTargetCapability`:
 *   - loadConfig         → src/config/loader.js loadConfig
 *   - listMcpStatus      → IpcClient.send("list-mcp-status", {agent}) +
 *                          status-vocabulary mapper (Phase 85's "ready/
 *                          degraded/failed/reconnecting/unknown" → the
 *                          probe's "healthy/warning/critical/unknown")
 *   - readWorkspaceInv.  → defaultReadWorkspaceInventory: walks memory tree
 *                          .md files, uploads/discord, skills, computing sha256 hashes
 *
 * Tests pass synthetic deps directly to `probeTargetCapability` — this CLI
 * wrapper is exercised via the daemon-context production path (Plan 92-06).
 */
import type { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import {
  probeTargetCapability,
  type McpServerSnapshot,
  type ProbeConfigShape,
  type ProbeDeps,
  type WorkspaceInventory,
} from "../../cutover/target-probe.js";
import type { ProbeOutcome } from "../../cutover/types.js";
import { cliError, cliLog } from "../output.js";

export type RunCutoverProbeArgs = Readonly<{
  agent: string;
  outputDir?: string;
  log?: Logger;
  /** DI for tests; production reads via loadConfig in this module. */
  loadConfigDep?: () => Promise<ProbeConfigShape>;
  /** DI for tests; production wires the IPC client. */
  listMcpStatusDep?: (agent: string) => Promise<readonly McpServerSnapshot[]>;
  /** DI for tests; production wires defaultReadWorkspaceInventory. */
  readWorkspaceInventoryDep?: (
    agent: string,
    memoryRoot: string,
  ) => Promise<WorkspaceInventory>;
}>;

/**
 * Run one cutover probe cycle. Returns the process exit code.
 *
 * Exit code policy:
 *   - probed              → 0
 *   - agent-not-found     → 1
 *   - yaml-load-failed    → 1
 *   - ipc-failed          → 1
 */
export async function runCutoverProbeAction(
  args: RunCutoverProbeArgs,
): Promise<number> {
  const log = args.log ?? (pino({ level: "info" }) as unknown as Logger);

  const outputDir =
    args.outputDir ??
    join(
      homedir(),
      ".clawcode",
      "manager",
      "cutover-reports",
      args.agent,
      new Date().toISOString().replace(/[:.]/g, "-"),
    );

  // Production wiring is the responsibility of Plan 92-06 (daemon IPC).
  // Bare CLI without DI explicitly errors so callers don't accidentally
  // probe with stub deps.
  if (
    args.loadConfigDep === undefined ||
    args.listMcpStatusDep === undefined ||
    args.readWorkspaceInventoryDep === undefined
  ) {
    cliError(
      "cutover probe requires loadConfig + listMcpStatus + readWorkspaceInventory deps — " +
        "invoke via daemon IPC (Plan 92-06) or pass deps in tests",
    );
    return 1;
  }

  const deps: ProbeDeps = {
    agent: args.agent,
    outputDir,
    loadConfig: args.loadConfigDep,
    listMcpStatus: args.listMcpStatusDep,
    readWorkspaceInventory: args.readWorkspaceInventoryDep,
    log,
  };

  const outcome: ProbeOutcome = await probeTargetCapability(deps);
  cliLog(JSON.stringify(outcome, null, 2));

  if (outcome.kind === "probed") return 0;
  return 1;
}

export function registerCutoverProbeCommand(parent: Command): void {
  parent
    .command("probe")
    .description(
      "Probe the target ClawCode side and emit TARGET-CAPABILITY.json (requires daemon context for IPC + config + workspace inventory)",
    )
    .requiredOption("--agent <name>", "Agent to probe")
    .option("--output-dir <path>", "Override report output directory")
    .action(
      async (opts: { agent: string; outputDir?: string }) => {
        const code = await runCutoverProbeAction({
          agent: opts.agent,
          ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}),
        });
        process.exit(code);
      },
    );
}
