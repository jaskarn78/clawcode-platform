/**
 * Phase 92 Plan 01 — `clawcode cutover profile` subcommand (D-11 amended).
 *
 * Reads BOTH staging JSONLs (mc-history.jsonl + discord-history.jsonl)
 * via the source profiler and emits a deterministic AGENT-PROFILE.json to
 * the per-run report directory.
 *
 * The bare CLI invocation requires a wired TurnDispatcher — Plan 92-06
 * lands the daemon-side IPC that spawns the profiler against a live
 * clawdy session. Until then, this command is callable only from
 * hermetic tests (or from a daemon context that DI's the dispatcher).
 */
import type { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import {
  runSourceProfiler,
  type ProfileDeps,
} from "../../cutover/source-profiler.js";
import type { ProfileOutcome } from "../../cutover/types.js";
import { cliError, cliLog } from "../output.js";

export type RunCutoverProfileArgs = Readonly<{
  agent: string;
  stagingDir?: string;
  outputDir?: string;
  log?: Logger;
  /** DI — required for tests + daemon-context production. */
  dispatcher?: ProfileDeps["dispatcher"];
  profilerAgent?: string;
  chunkThresholdMsgs?: number;
}>;

/**
 * Run one cutover profile cycle. Returns the process exit code.
 *
 * Exit code policy:
 *   - profiled                    → 0
 *   - no-history                  → 0 (operator-recoverable: re-run ingest)
 *   - dispatcher-failed           → 1
 *   - schema-validation-failed    → 1
 *   - missing dispatcher dep      → 1
 */
export async function runCutoverProfileAction(
  args: RunCutoverProfileArgs,
): Promise<number> {
  const log = args.log ?? (pino({ level: "info" }) as unknown as Logger);

  if (args.dispatcher === undefined) {
    cliError(
      "cutover profile requires a TurnDispatcher dependency — invoke via daemon IPC (Plan 92-06) or pass dispatcher in tests",
    );
    return 1;
  }

  const stagingDir =
    args.stagingDir ??
    join(homedir(), ".clawcode", "manager", "cutover-staging", args.agent);
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

  const historyJsonlPaths = [
    join(stagingDir, "mc-history.jsonl"),
    join(stagingDir, "discord-history.jsonl"),
  ] as const;

  const deps: ProfileDeps = {
    agent: args.agent,
    historyJsonlPaths,
    outputDir,
    dispatcher: args.dispatcher,
    ...(args.profilerAgent !== undefined ? { profilerAgent: args.profilerAgent } : {}),
    ...(args.chunkThresholdMsgs !== undefined
      ? { chunkThresholdMsgs: args.chunkThresholdMsgs }
      : {}),
    log,
  };

  const outcome: ProfileOutcome = await runSourceProfiler(deps);
  cliLog(JSON.stringify(outcome, null, 2));

  if (
    outcome.kind === "dispatcher-failed" ||
    outcome.kind === "schema-validation-failed"
  ) {
    return 1;
  }
  return 0;
}

export function registerCutoverProfileCommand(parent: Command): void {
  parent
    .command("profile")
    .description(
      "Run the source-agent behavior profiler over staged JSONL → AGENT-PROFILE.json (requires daemon context for dispatcher)",
    )
    .requiredOption("--agent <name>", "Agent to profile")
    .option("--staging-dir <path>", "Override staging directory")
    .option("--output-dir <path>", "Override report output directory")
    .action(
      async (opts: {
        agent: string;
        stagingDir?: string;
        outputDir?: string;
      }) => {
        const code = await runCutoverProfileAction({
          agent: opts.agent,
          ...(opts.stagingDir !== undefined ? { stagingDir: opts.stagingDir } : {}),
          ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}),
        });
        process.exit(code);
      },
    );
}
