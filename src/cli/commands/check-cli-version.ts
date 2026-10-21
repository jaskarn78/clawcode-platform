/**
 * Phase 999.159 WS-4 — `clawcode check-cli-version`.
 *
 * Read-only pre-deploy gate: does the Claude Code binary satisfy the CLI floor
 * of every model this config will run? Same `minCliVersion` data and same
 * comparator the daemon's boot guard uses (`manager/cli-version-guard.ts`), so
 * the gate and the boot check can never disagree.
 *
 * WHY A CLI COMMAND AND NOT A SCRIPT IN `scripts/`. Both production outages
 * shipped through `deploy-from-ci.sh`, which runs ON prod against an EXTRACTED
 * ARTIFACT — the repo checkout there can sit at a different commit than the
 * bundle being installed. A gate that reads the checkout's source would
 * validate the wrong code. As a command inside the bundle, the artifact
 * validates ITSELF against the live config and the live binary.
 *
 * Needs no daemon, no IPC and no network: safe to run before a restart, after a
 * stage, or on a box whose fleet is down.
 *
 * Exit codes (consumed by both deploy scripts):
 *   0 — every model in use is served by the installed binary (deploy may proceed)
 *   1 — a model an agent will RUN needs a newer CLI, or (999.169) the fleet
 *       binary is missing / not the CLI its SDK was built for (BLOCK the deploy)
 *   2 — could not evaluate (config unreadable, binary unprobeable) — decide, do
 *       not assume a pass
 */

import type { Command } from "commander";
import { loadConfig } from "../../config/loader.js";
import {
  checkCliVersion,
  checkClaudeBinaryLockstep,
  collectCliVersionRequirements,
  formatCliVersionFailure,
  formatLockstepFailure,
  isLockstepFatal,
  type LockstepVerdict,
  type ModelCliRequirement,
} from "../../manager/cli-version-guard.js";
import {
  checkBinaryIntegrity,
  probeBinaryVersion,
  probeFleetBinary,
  readBinaryManifest,
  readInstalledSdk,
  type BinaryIntegrityVerdict,
  type ClaudeBinaryManifest,
  type FleetBinaryProbe,
} from "../../shared/claude-binary.js";
import { cliLog, cliError } from "../output.js";

export type CheckCliVersionOptions = {
  readonly config?: string;
  /** Probe this binary instead of the fleet resolver (e.g. prod's CLAWCODE_CLAUDE_BIN override). */
  readonly bin?: string;
  /**
   * Pre-probed version string, bypassing any local probe. This is how the
   * PUSH path works: `deploy-clawdy.sh` runs on the dev box but the binary that
   * matters is the one on prod, so it probes over ssh and passes the result in.
   * Probing the dev box's own binary there would validate the wrong machine —
   * exactly the 999.85 "pinned to local" trap.
   */
  readonly installedVersion?: string;
  /**
   * 999.169 — build manifest (`dist/claude-binary.json`) recording the sha256
   * of the SDK-bundled binary the artifact was built against. A different
   * installed binary BLOCKS (tampered or corrupted node_modules).
   */
  readonly expectManifest?: string;
  readonly json?: boolean;
};

export type CheckCliVersionDeps = {
  readonly loadRequirements?: (configPath: string) => Promise<readonly ModelCliRequirement[]>;
  readonly probeFleet?: () => FleetBinaryProbe;
  readonly probeVersion?: (bin: string) => string | null;
  readonly readManifest?: (path: string) => ClaudeBinaryManifest | null;
};

/**
 * Which binary to evaluate — the same one the daemon spawns (999.169):
 *   --installed-version  a version probed elsewhere (push path, remote host)
 *   --bin                an explicit binary (prod's CLAWCODE_CLAUDE_BIN override)
 *   (default)            the fleet resolver: CLAWCODE_CLAUDE_BIN, else the Agent
 *                        SDK's own bundled binary from THIS install's node_modules
 * The old `/opt/clawcode/claude-pin` default is gone: the fleet binary moves with
 * the SDK now, and a gate that probed a stale side path would validate the wrong
 * binary.
 */
function evaluateBinary(options: CheckCliVersionOptions, deps: CheckCliVersionDeps): FleetBinaryProbe | null {
  if (options.installedVersion !== undefined) return null;
  if (options.bin !== undefined && options.bin.trim().length > 0) {
    const bin = options.bin.trim();
    const sdk = readInstalledSdk();
    return {
      pin: bin,
      source: "override",
      platformPackage: null,
      sha256: null,
      version: (deps.probeVersion ?? probeBinaryVersion)(bin),
      sdkVersion: sdk?.version ?? null,
      sdkClaudeCodeVersion: sdk?.claudeCodeVersion ?? null,
      error: null,
    };
  }
  return (deps.probeFleet ?? (() => probeFleetBinary()))();
}

export async function runCheckCliVersion(
  options: CheckCliVersionOptions,
  deps: CheckCliVersionDeps = {},
): Promise<number> {
  const configPath = options.config ?? "clawcode.yaml";

  let requirements: readonly ModelCliRequirement[];
  try {
    requirements = await (deps.loadRequirements ??
      (async (p: string) => collectCliVersionRequirements(await loadConfig(p))))(configPath);
  } catch (err) {
    cliError(
      `check-cli-version: could not load config ${configPath}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }

  const fleet = evaluateBinary(options, deps);
  const probedFrom = fleet === null ? "(supplied)" : (fleet.pin ?? "(unresolved)");
  const installedRaw = fleet === null ? (options.installedVersion ?? null) : fleet.version;
  const lockstep: LockstepVerdict | null = fleet === null ? null : checkClaudeBinaryLockstep(fleet);

  const verdict = checkCliVersion(installedRaw, requirements);

  let integrity: BinaryIntegrityVerdict | null = null;
  if (options.expectManifest !== undefined && fleet !== null) {
    const manifest = (deps.readManifest ?? readBinaryManifest)(options.expectManifest);
    integrity =
      manifest === null
        ? { kind: "not-applicable", reason: `no readable manifest at ${options.expectManifest}` }
        : checkBinaryIntegrity(fleet, manifest);
  }

  if (options.json === true) {
    cliLog(
      JSON.stringify(
        {
          installed: verdict.installed,
          highestRequired: verdict.highestRequired,
          probedFrom,
          binarySource: fleet?.source ?? "supplied",
          sdk: fleet === null ? null : { version: fleet.sdkVersion, claudeCodeVersion: fleet.sdkClaudeCodeVersion },
          lockstep,
          sha256: fleet?.sha256 ?? null,
          integrity,
          blocking: verdict.blocking,
          selectableUnmet: verdict.selectableUnmet,
          requirementCount: requirements.length,
        },
        null,
        2,
      ),
    );
  }

  if (integrity !== null && integrity.kind === "mismatch") {
    cliError(
      `check-cli-version: BLOCKED — the installed Claude binary ${integrity.path ?? ""} has sha256 ` +
        `${integrity.actual}, but the build recorded ${integrity.expected} for the same SDK package. ` +
        "node_modules was modified after install (or the install is corrupt): re-run `npm ci`.",
    );
    return 1;
  }
  if (integrity !== null && integrity.kind === "not-applicable") {
    cliError(`check-cli-version: integrity not checked — ${integrity.reason}`);
  }

  // 999.169 — the daemon refuses to boot on these, so the gate must refuse to deploy.
  if (lockstep !== null && isLockstepFatal(lockstep)) {
    cliError(`check-cli-version: BLOCKED — ${formatLockstepFailure(lockstep)}`);
    return 1;
  }
  if (lockstep !== null && lockstep.kind !== "ok") {
    cliError(`check-cli-version: WARNING — ${formatLockstepFailure(lockstep)}`);
  }

  if (requirements.length === 0) {
    if (options.json !== true) {
      cliLog("check-cli-version: OK — no configured model declares a CLI floor.");
    }
    return 0;
  }

  if (verdict.installed === null) {
    cliError(
      `check-cli-version: could not read a version from ${probedFrom}. ` +
        `The configured models need CLI >= ${verdict.highestRequired ?? "unknown"}; ` +
        "compatibility is UNVERIFIED. Pass --installed-version to supply it.",
    );
    return 2;
  }

  for (const unmet of verdict.selectableUnmet) {
    cliError(
      `check-cli-version: WARNING — selectable model ${unmet.model} (${unmet.source}) ` +
        `needs CLI >= ${unmet.minCliVersion}, installed ${verdict.installed}. ` +
        "Nothing is broken until someone selects it.",
    );
  }

  if (verdict.blocking.length > 0) {
    cliError(`check-cli-version: BLOCKED\n${formatCliVersionFailure(verdict)}`);
    return 1;
  }

  if (options.json !== true) {
    cliLog(
      `check-cli-version: OK — binary ${verdict.installed} satisfies all ` +
        `${requirements.length} declared floor(s) (highest ${verdict.highestRequired}).`,
    );
  }
  return 0;
}

export function registerCheckCliVersionCommand(program: Command): void {
  program
    .command("check-cli-version")
    .description(
      "Verify the Claude Code binary satisfies every configured model's minimum CLI version",
    )
    .option("-c, --config <path>", "Config file to read models from", "clawcode.yaml")
    .option("--bin <path>", "Binary to probe (default: the fleet binary — $CLAWCODE_CLAUDE_BIN, else the SDK-bundled one)")
    .option(
      "--installed-version <version>",
      "Use this version string instead of probing (for checking a REMOTE host's binary)",
    )
    .option(
      "--expect-manifest <path>",
      "Build manifest (dist/claude-binary.json); BLOCK if the installed bundled binary's sha256 differs",
    )
    .option("--json", "Emit the verdict as JSON")
    .action(async (options: CheckCliVersionOptions) => {
      const code = await runCheckCliVersion(options);
      process.exitCode = code;
    });
}
