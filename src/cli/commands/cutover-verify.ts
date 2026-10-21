/**
 * Phase 92 Plan 06 — `clawcode cutover verify` subcommand (CUT-09).
 *
 * Phase 92 GAP CLOSURE (post-VERIFICATION) — replaces the prior daemon-IPC
 * scaffold (which returned exit 1 unconditionally) with a fully-wired IPC
 * client that calls the daemon's `cutover-verify` handler. The daemon owns
 * all DI primitives (TurnDispatcher, dispatchStream, fetchApi, listMcpStatus,
 * runRsync, atomic YAML writers) and runs runVerifyPipeline + writes
 * CUTOVER-REPORT.md; this CLI prints the resulting summary and surfaces
 * the `Cutover ready: true|false` literal as the operator-facing exit signal.
 *
 * Exit codes:
 *   0 — pipeline completed AND cutoverReady = true
 *   1 — pipeline completed but cutoverReady = false (gaps remain), OR
 *       daemon-IPC failure / pipeline failure
 */

import type { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";

import { cliError, cliLog } from "../output.js";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import {
  IpcError,
  ManagerNotRunningError,
} from "../../shared/errors.js";

/**
 * Shape of the daemon's `cutover-verify` IPC response. Mirrors the
 * VerifyOutcome union's `verified-ready` / `verified-not-ready` projection
 * collapsed to a flat record because the operator surface only needs the
 * binary signal + the report path.
 */
export type CutoverVerifyIpcResponse = {
  readonly cutoverReady: boolean;
  readonly gapCount: number;
  readonly canaryPassRate: number;
  readonly reportPath: string;
};

export type RunCutoverVerifyArgs = Readonly<{
  agent: string;
  applyAdditive?: boolean;
  outputDir?: string;
  stagingDir?: string;
  depthMsgs?: number;
  depthDays?: number;
  log?: Logger;
  /**
   * DI hook — override the IPC sender for hermetic tests. Production callers
   * pass nothing (default wires `sendIpcRequest` against the daemon socket).
   */
  sendIpc?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}>;

/**
 * Run one cutover verify cycle by calling the daemon's `cutover-verify` IPC
 * handler. The daemon side wires the production DI surface (LLM dispatcher,
 * Discord stream, MCP probe, atomic YAML writers, rsync runner) — this CLI
 * stays a thin RPC wrapper.
 *
 * Returns the process exit code so tests can assert without spawning
 * subprocesses (mirrors the runSyncRunOnceAction pattern from Phase 91-04).
 */
export async function runCutoverVerifyAction(
  args: RunCutoverVerifyArgs,
): Promise<number> {
  const log = args.log ?? (pino({ level: "info" }) as unknown as Logger);

  // Production wiring: connect to the daemon over the canonical Unix socket.
  // Tests inject a stub via args.sendIpc so they never touch the filesystem.
  const sender =
    args.sendIpc ??
    ((method: string, params: Record<string, unknown>) =>
      sendIpcRequest(SOCKET_PATH, method, params));

  // Build the IPC params record. We forward ONLY what the operator passed +
  // the resolved defaults so the daemon can compute its own paths off the
  // agent name (avoids cross-host path bleed in tests).
  const params: Record<string, unknown> = {
    agent: args.agent,
  };
  if (args.applyAdditive !== undefined) params.applyAdditive = args.applyAdditive;
  if (args.outputDir !== undefined) params.outputDir = args.outputDir;
  if (args.stagingDir !== undefined) params.stagingDir = args.stagingDir;
  if (args.depthMsgs !== undefined) params.depthMsgs = args.depthMsgs;
  if (args.depthDays !== undefined) params.depthDays = args.depthDays;

  let response: CutoverVerifyIpcResponse;
  try {
    const raw = await sender("cutover-verify", params);
    response = raw as CutoverVerifyIpcResponse;
  } catch (err) {
    if (err instanceof ManagerNotRunningError) {
      cliError(
        "cutover verify: clawcode daemon is not running. Start it with `clawcode start-all`.",
      );
      return 1;
    }
    if (err instanceof IpcError) {
      cliError(`cutover verify: daemon-IPC error: ${err.message}`);
      return 1;
    }
    cliError(
      `cutover verify: unexpected error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }

  // Operator-facing summary on stdout. The literal `Cutover ready: true|false`
  // line mirrors the same source-of-truth field that the report writer emits
  // at the end of CUTOVER-REPORT.md, so a grep on either surface gets the
  // same answer.
  cliLog(
    JSON.stringify(
      {
        agent: args.agent,
        cutoverReady: response.cutoverReady,
        gapCount: response.gapCount,
        canaryPassRate: response.canaryPassRate,
        reportPath: response.reportPath,
      },
      null,
      2,
    ),
  );
  cliLog(`Cutover ready: ${response.cutoverReady}`);

  log.info(
    {
      agent: args.agent,
      cutoverReady: response.cutoverReady,
      gapCount: response.gapCount,
      canaryPassRate: response.canaryPassRate,
    },
    "cutover verify: completed",
  );

  return response.cutoverReady ? 0 : 1;
}

export function registerCutoverVerifyCommand(parent: Command): void {
  parent
    .command("verify")
    .description(
      "Run the full cutover verify pipeline (ingest → profile → probe → diff → apply-additive[dry-run-default] → canary[opt-in] → report) via daemon IPC. Emits CUTOVER-REPORT.md with cutover_ready signal.",
    )
    .requiredOption("--agent <name>", "Agent under verification")
    .option(
      "--apply-additive",
      "Apply the 4 additive CutoverGap kinds (default: dry-run; destructive gaps NEVER auto-applied)",
    )
    .option(
      "--output-dir <path>",
      `Override CUTOVER-REPORT.md output directory (default: ~/.clawcode/manager/cutover-reports/<agent>/)`,
    )
    .option(
      "--staging-dir <path>",
      `Override staging directory for ingestor JSONL (default: ~/.clawcode/manager/cutover-staging/<agent>/)`,
    )
    .option(
      "--depth-msgs <n>",
      "Discord history depth cap per channel (default: 10000)",
      (v) => parseInt(v, 10),
    )
    .option(
      "--depth-days <n>",
      "Discord history depth cap in days (default: 90)",
      (v) => parseInt(v, 10),
    )
    .action(
      async (opts: {
        agent: string;
        applyAdditive?: boolean;
        outputDir?: string;
        stagingDir?: string;
        depthMsgs?: number;
        depthDays?: number;
      }) => {
        const code = await runCutoverVerifyAction({
          agent: opts.agent,
          ...(opts.applyAdditive !== undefined
            ? { applyAdditive: opts.applyAdditive }
            : {}),
          ...(opts.outputDir !== undefined
            ? { outputDir: opts.outputDir }
            : {
                outputDir: join(
                  homedir(),
                  ".clawcode",
                  "manager",
                  "cutover-reports",
                  opts.agent,
                ),
              }),
          ...(opts.stagingDir !== undefined
            ? { stagingDir: opts.stagingDir }
            : {
                stagingDir: join(
                  homedir(),
                  ".clawcode",
                  "manager",
                  "cutover-staging",
                  opts.agent,
                ),
              }),
          ...(opts.depthMsgs !== undefined
            ? { depthMsgs: opts.depthMsgs }
            : {}),
          ...(opts.depthDays !== undefined
            ? { depthDays: opts.depthDays }
            : {}),
        });
        process.exit(code);
      },
    );
}
