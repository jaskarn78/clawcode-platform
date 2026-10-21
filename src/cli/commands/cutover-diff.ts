/**
 * Phase 92 Plan 02 — `clawcode cutover diff` subcommand.
 *
 * Reads:
 *   - <outputDir>/AGENT-PROFILE.json     (Plan 92-01 source profiler output)
 *   - <outputDir>/TARGET-CAPABILITY.json (Plan 92-02 target probe output)
 *
 * Calls the pure `diffAgentVsTarget` function and writes:
 *   - <outputDir>/CUTOVER-GAPS.json      (sorted readonly CutoverGap[])
 *
 * Atomic write (temp+rename) mirrors the discipline used across the v2.x
 * atomic-writer convention (Phase 78/86/91).
 */
import type { Command } from "commander";
import { mkdir, readFile, rename, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pino, { type Logger } from "pino";
import { diffAgentVsTarget } from "../../cutover/diff-engine.js";
import {
  agentProfileSchema,
  targetCapabilitySchema,
  type CutoverGap,
  type DiffOutcome,
} from "../../cutover/types.js";
import { cliError, cliLog } from "../output.js";

export type RunCutoverDiffArgs = Readonly<{
  agent: string;
  /** Directory containing AGENT-PROFILE.json and TARGET-CAPABILITY.json. */
  inputDir?: string;
  /** Where to write CUTOVER-GAPS.json. Defaults to inputDir. */
  outputDir?: string;
  /** Override profile path (otherwise inputDir/AGENT-PROFILE.json). */
  profilePath?: string;
  /** Override capability path (otherwise inputDir/TARGET-CAPABILITY.json). */
  capabilityPath?: string;
  log?: Logger;
}>;

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, path);
}

/**
 * Run one cutover diff cycle. Returns the process exit code.
 *
 * Exit code policy:
 *   - diffed                 → 0
 *   - missing-profile        → 1
 *   - missing-capability     → 1
 *   - schema-validation-fail → 1 (logged via cliError, no DiffOutcome variant
 *                                 in v1 since 92-01/02 own producing valid
 *                                 JSONs; surfaces as a generic CLI error)
 */
export async function runCutoverDiffAction(
  args: RunCutoverDiffArgs,
): Promise<number> {
  const log = args.log ?? (pino({ level: "info" }) as unknown as Logger);
  const start = Date.now();

  const inputDir =
    args.inputDir ??
    join(
      homedir(),
      ".clawcode",
      "manager",
      "cutover-reports",
      args.agent,
      "latest",
    );
  const outputDir = args.outputDir ?? inputDir;

  const profilePath =
    args.profilePath ?? join(inputDir, "AGENT-PROFILE.json");
  const capabilityPath =
    args.capabilityPath ?? join(inputDir, "TARGET-CAPABILITY.json");

  if (!(await fileExists(profilePath))) {
    const outcome: DiffOutcome = {
      kind: "missing-profile",
      agent: args.agent,
      profilePath,
    };
    cliLog(JSON.stringify(outcome, null, 2));
    return 1;
  }
  if (!(await fileExists(capabilityPath))) {
    const outcome: DiffOutcome = {
      kind: "missing-capability",
      agent: args.agent,
      capabilityPath,
    };
    cliLog(JSON.stringify(outcome, null, 2));
    return 1;
  }

  // Read + validate both inputs.
  const profileRaw = await readFile(profilePath, "utf8");
  const capabilityRaw = await readFile(capabilityPath, "utf8");

  const profileParsed = agentProfileSchema.safeParse(JSON.parse(profileRaw));
  if (!profileParsed.success) {
    cliError(
      `cutover diff: AGENT-PROFILE.json schema validation failed: ${profileParsed.error.message}`,
    );
    return 1;
  }
  const capabilityParsed = targetCapabilitySchema.safeParse(
    JSON.parse(capabilityRaw),
  );
  if (!capabilityParsed.success) {
    cliError(
      `cutover diff: TARGET-CAPABILITY.json schema validation failed: ${capabilityParsed.error.message}`,
    );
    return 1;
  }

  // PURE diff call.
  const gaps: readonly CutoverGap[] = diffAgentVsTarget(
    profileParsed.data,
    capabilityParsed.data,
  );

  const additiveCount = gaps.filter((g) => g.severity === "additive").length;
  const destructiveCount = gaps.length - additiveCount;

  await mkdir(outputDir, { recursive: true });
  const gapsPath = join(outputDir, "CUTOVER-GAPS.json");
  await writeAtomic(gapsPath, JSON.stringify(gaps, null, 2));

  const outcome: DiffOutcome = {
    kind: "diffed",
    agent: args.agent,
    gapCount: gaps.length,
    additiveCount,
    destructiveCount,
    gapsPath,
    durationMs: Date.now() - start,
  };

  log.info(
    {
      agent: args.agent,
      gapCount: gaps.length,
      additiveCount,
      destructiveCount,
      gapsPath,
    },
    "cutover diff: emitted CUTOVER-GAPS.json",
  );

  cliLog(JSON.stringify(outcome, null, 2));
  return 0;
}

export function registerCutoverDiffCommand(parent: Command): void {
  parent
    .command("diff")
    .description(
      "Diff AGENT-PROFILE.json against TARGET-CAPABILITY.json → CUTOVER-GAPS.json",
    )
    .requiredOption("--agent <name>", "Agent to diff")
    .option("--input-dir <path>", "Directory containing both input JSONs")
    .option("--output-dir <path>", "Override CUTOVER-GAPS.json output dir")
    .option("--profile <path>", "Override AGENT-PROFILE.json path")
    .option("--capability <path>", "Override TARGET-CAPABILITY.json path")
    .action(
      async (opts: {
        agent: string;
        inputDir?: string;
        outputDir?: string;
        profile?: string;
        capability?: string;
      }) => {
        const code = await runCutoverDiffAction({
          agent: opts.agent,
          ...(opts.inputDir !== undefined ? { inputDir: opts.inputDir } : {}),
          ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}),
          ...(opts.profile !== undefined ? { profilePath: opts.profile } : {}),
          ...(opts.capability !== undefined
            ? { capabilityPath: opts.capability }
            : {}),
        });
        process.exit(code);
      },
    );
}
