/**
 * Phase 100 Plan 06 — `clawcode gsd install` CLI subcommand.
 *
 * Operator-driven one-shot install for the Admin Clawdy GSD-via-Discord
 * pre-flight: symlinks the GSD library + slash commands into the clawcode
 * user's ~/.claude/, then bootstraps /opt/clawcode-projects/sandbox/ as a
 * git repo for smoke-testing.
 *
 * Local-only: this command runs against the local filesystem. Production
 * deployment to clawdy is documented in Plan 08's runbook (operator runs
 * the same command via SSH session as the clawcode user).
 *
 * Idempotency: re-running detects pre-existing symlinks (readlink + match)
 * and pre-existing .git (stat) — no destructive deltas on second run.
 *
 * RESEARCH.md Common Pitfalls §1 + §2 mitigations:
 *   - Symlink the PARENT directories (~/.claude/get-shit-done,
 *     ~/.claude/commands/gsd), NOT individual skill subfolders. Issue
 *     #14836 (claude-code) only affects ~/.claude/skills/ — Phase 100
 *     uses ~/.claude/commands/ as the SDK-discoverable surface.
 *   - The actual SDK-discoverable command surface is ~/.claude/commands/gsd/,
 *     NOT ~/.claude/get-shit-done/skills/gsd/ (which doesn't exist as a
 *     scanned path). Both symlinks are needed: get-shit-done provides the
 *     workflow content the slash commands @-include.
 *
 * Exit codes:
 *   0 — all symlinks resolved + sandbox initialized (or already in place)
 *   1 — at least one step failed; summary table indicates which
 */

import type { Command } from "commander";
import type { Logger } from "pino";
import {
  stat as fsStat,
  mkdir as fsMkdir,
  symlink as fsSymlink,
  unlink as fsUnlink,
  readlink as fsReadlink,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";

import { logger as defaultLogger } from "../../shared/logger.js";
import { cliLog, cliError } from "../output.js";

const execFileAsync = promisify(execFile);

/**
 * Phase 100 Plan 06 — default install paths. Reflects RESEARCH.md
 * Common Pitfalls §2 (the SDK-discoverable surface is ~/.claude/commands/,
 * NOT ~/.claude/skills/). Operators override via CLI flags.
 *
 * The 5 paths:
 *   - skillsSource: where example-user's GSD library lives on the dev box
 *   - skillsTarget: clawcode user's mirror (symlink target)
 *   - commandsSource: where example-user's slash command files live
 *   - commandsTarget: clawcode user's mirror (the SDK-discoverable surface)
 *   - sandboxDir: empty repo for smoke-testing GSD on Admin Clawdy
 */
export const DEFAULTS = {
  skillsSource: "/home/example-user/.claude/get-shit-done",
  skillsTarget: "/home/clawcode/.claude/get-shit-done",
  commandsSource: "/home/example-user/.claude/commands/gsd",
  commandsTarget: "/home/clawcode/.claude/commands/gsd",
  sandboxDir: "/opt/clawcode-projects/sandbox",
} as const;

/** Outcome of a single ensureSymlink invocation. */
export type SymlinkOutcome =
  | "created"
  | "already-present"
  | "updated"
  | "failed";

/** Outcome of a single ensureSandbox invocation. */
export type SandboxOutcome = "created" | "already-present" | "failed";

/** Filesystem deps shape (DI for hermetic tests). */
export type FsDeps = {
  readonly stat: typeof fsStat;
  readonly mkdir: typeof fsMkdir;
  readonly symlink: typeof fsSymlink;
  readonly unlink: typeof fsUnlink;
  readonly readlink: typeof fsReadlink;
};

/** Git runner deps shape (DI for hermetic tests). */
export type GitRunner = {
  readonly execGit: (
    args: readonly string[],
  ) => Promise<{ stdout: string; stderr: string }>;
};

/** Logger deps shape — narrow to the methods we use. */
type LogDeps = Pick<Logger, "info" | "warn" | "error">;

/**
 * Pure helper: ensure a symlink at <target> points at <source>. Idempotent.
 *
 * Behavior matrix:
 *   - target absent → create it (returns 'created')
 *   - target is a symlink to source → no-op (returns 'already-present')
 *   - target is a symlink to something else → unlink + recreate (returns 'updated')
 *   - source missing → fail (returns 'failed')
 *   - fs.symlink throws → fail (returns 'failed')
 *
 * NEVER mutates the source. Only target may be unlinked + replaced.
 */
export async function ensureSymlink(
  deps: FsDeps,
  log: LogDeps,
  source: string,
  target: string,
): Promise<SymlinkOutcome> {
  // Verify source exists
  try {
    await deps.stat(source);
  } catch (err) {
    log.error(
      { source, error: (err as Error).message },
      "ensureSymlink: source missing",
    );
    return "failed";
  }
  // Ensure parent directory of target
  try {
    await deps.mkdir(dirname(target), { recursive: true });
  } catch (err) {
    log.error(
      { target, error: (err as Error).message },
      "ensureSymlink: cannot mkdir parent",
    );
    return "failed";
  }
  // Check existing target via readlink
  let existing: string | null = null;
  try {
    existing = await deps.readlink(target);
  } catch {
    existing = null; // target doesn't exist (or isn't a symlink)
  }
  if (existing === source) {
    return "already-present";
  }
  if (existing !== null) {
    // Stale symlink — unlink + recreate
    try {
      await deps.unlink(target);
      await deps.symlink(source, target);
      return "updated";
    } catch (err) {
      log.error(
        { target, error: (err as Error).message },
        "ensureSymlink: update failed",
      );
      return "failed";
    }
  }
  // Target absent — create
  try {
    await deps.symlink(source, target);
    return "created";
  } catch (err) {
    log.error(
      { source, target, error: (err as Error).message },
      "ensureSymlink: create failed",
    );
    return "failed";
  }
}

/**
 * Pure helper: ensure a directory exists with .git initialized + initial empty commit.
 * Idempotent. NEVER mutates a pre-existing .git tree.
 */
export async function ensureSandbox(
  deps: FsDeps,
  gitRunner: GitRunner,
  log: LogDeps,
  sandboxDir: string,
): Promise<SandboxOutcome> {
  // Ensure sandbox dir
  try {
    await deps.mkdir(sandboxDir, { recursive: true });
  } catch (err) {
    log.error(
      { sandboxDir, error: (err as Error).message },
      "ensureSandbox: mkdir failed",
    );
    return "failed";
  }
  // Check if .git already exists
  try {
    await deps.stat(`${sandboxDir}/.git`);
    return "already-present";
  } catch {
    // .git absent — git init + initial commit
  }
  try {
    await gitRunner.execGit(["-C", sandboxDir, "init", "--quiet"]);
    await gitRunner.execGit([
      "-C",
      sandboxDir,
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "init",
    ]);
    return "created";
  } catch (err) {
    log.error(
      { sandboxDir, error: (err as Error).message },
      "ensureSandbox: git init/commit failed",
    );
    return "failed";
  }
}

/** Validation — paths must be absolute and not contain '..'. */
function assertAbsolute(label: string, path: string): void {
  if (!path.startsWith("/")) {
    throw new Error(`${label}: path must be absolute (got "${path}")`);
  }
  if (path.split("/").includes("..")) {
    throw new Error(`${label}: path must not contain '..' (got "${path}")`);
  }
}

/** Args for runGsdInstallAction — every path defaults from DEFAULTS. */
export type RunGsdInstallActionArgs = {
  readonly skillsSource?: string;
  readonly skillsTarget?: string;
  readonly commandsSource?: string;
  readonly commandsTarget?: string;
  readonly sandboxDir?: string;
  readonly fs?: FsDeps;
  readonly gitRunner?: GitRunner;
  readonly log?: LogDeps;
};

/**
 * Run the install action. Returns process exit code (0 success, 1 partial fail).
 * DI-pure: production wiring uses node:fs/promises + node:child_process.
 */
export async function runGsdInstallAction(
  args: RunGsdInstallActionArgs,
): Promise<number> {
  const skillsSource = args.skillsSource ?? DEFAULTS.skillsSource;
  const skillsTarget = args.skillsTarget ?? DEFAULTS.skillsTarget;
  const commandsSource = args.commandsSource ?? DEFAULTS.commandsSource;
  const commandsTarget = args.commandsTarget ?? DEFAULTS.commandsTarget;
  const sandboxDir = args.sandboxDir ?? DEFAULTS.sandboxDir;

  assertAbsolute("skillsSource", skillsSource);
  assertAbsolute("skillsTarget", skillsTarget);
  assertAbsolute("commandsSource", commandsSource);
  assertAbsolute("commandsTarget", commandsTarget);
  assertAbsolute("sandboxDir", sandboxDir);

  const fs: FsDeps = args.fs ?? {
    stat: fsStat,
    mkdir: fsMkdir,
    symlink: fsSymlink,
    unlink: fsUnlink,
    readlink: fsReadlink,
  };
  const gitRunner: GitRunner = args.gitRunner ?? {
    execGit: async (gitArgs) => {
      const { stdout, stderr } = await execFileAsync("git", [...gitArgs]);
      return { stdout, stderr };
    },
  };
  const log: LogDeps = args.log ?? defaultLogger;

  const outcomes = {
    skillsLink: await ensureSymlink(fs, log, skillsSource, skillsTarget),
    commandsLink: await ensureSymlink(fs, log, commandsSource, commandsTarget),
    sandbox: await ensureSandbox(fs, gitRunner, log, sandboxDir),
  };

  // Print summary table
  cliLog("");
  cliLog("clawcode gsd install — summary:");
  cliLog(
    `  skills symlink:   ${skillsTarget} -> ${skillsSource}  [${outcomes.skillsLink}]`,
  );
  cliLog(
    `  commands symlink: ${commandsTarget} -> ${commandsSource}  [${outcomes.commandsLink}]`,
  );
  cliLog(`  sandbox repo:     ${sandboxDir}  [${outcomes.sandbox}]`);

  const anyFailed =
    outcomes.skillsLink === "failed" ||
    outcomes.commandsLink === "failed" ||
    outcomes.sandbox === "failed";
  if (anyFailed) {
    cliError("");
    cliError(
      "One or more steps failed — see log above. Exit code 1.",
    );
    return 1;
  }
  cliLog("");
  cliLog("All steps completed successfully. Exit code 0.");
  return 0;
}

/**
 * Register the `clawcode gsd install` subcommand. Creates the `gsd` parent
 * group if it doesn't exist; adds `install` as a subcommand under it.
 */
export function registerGsdInstallCommand(parent: Command): void {
  // Find or create the `gsd` parent group
  let gsdGroup = parent.commands.find((c) => c.name() === "gsd");
  if (!gsdGroup) {
    gsdGroup = parent
      .command("gsd")
      .description("GSD workflow tooling (install, status, etc.)");
  }
  gsdGroup
    .command("install")
    .description(
      "Install GSD skills + commands symlinks for the clawcode user; bootstrap /opt/clawcode-projects/sandbox/",
    )
    .option(
      "--skills-source <path>",
      "Override default skills source",
      DEFAULTS.skillsSource,
    )
    .option(
      "--skills-target <path>",
      "Override default skills target",
      DEFAULTS.skillsTarget,
    )
    .option(
      "--commands-source <path>",
      "Override default commands source",
      DEFAULTS.commandsSource,
    )
    .option(
      "--commands-target <path>",
      "Override default commands target",
      DEFAULTS.commandsTarget,
    )
    .option(
      "--sandbox <path>",
      "Override default sandbox directory",
      DEFAULTS.sandboxDir,
    )
    .action(
      async (opts: {
        skillsSource: string;
        skillsTarget: string;
        commandsSource: string;
        commandsTarget: string;
        sandbox: string;
      }) => {
        const code = await runGsdInstallAction({
          skillsSource: opts.skillsSource,
          skillsTarget: opts.skillsTarget,
          commandsSource: opts.commandsSource,
          commandsTarget: opts.commandsTarget,
          sandboxDir: opts.sandbox,
        });
        process.exit(code);
      },
    );
}
