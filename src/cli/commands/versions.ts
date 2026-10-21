/**
 * Phase 999.169 — `clawcode versions`: the Claude Code CLI + Agent SDK report on
 * demand. Same evaluation as the daily version-watch cron, without dedup and
 * without a daemon: this install's SDK, the fleet binary it resolves to, npm's
 * latest matched pair, and the model floors.
 *
 * Exit codes: 0 in lockstep and up to date; 1 a finding (new pair, skew,
 * override, unresolved binary); 2 could not evaluate.
 */

import { existsSync } from "node:fs";
import type { Command } from "commander";
import { loadConfig } from "../../config/loader.js";
import { checkCliVersion, collectCliVersionRequirements } from "../../manager/cli-version-guard.js";
import { defaultFetchJson } from "../../manager/version-watch-cron.js";
import {
  evaluateVersions,
  fetchLatestPair,
  renderReport,
  type FetchJson,
  type RegistryPair,
} from "../../manager/version-watch.js";
import {
  buildBinaryManifest,
  probeFleetBinary,
  writeBinaryManifest,
  type FleetBinaryProbe,
} from "../../shared/claude-binary.js";
import { cliError, cliLog } from "../output.js";

export type VersionsOptions = { readonly config?: string; readonly json?: boolean };
export type VersionsDeps = {
  readonly probe?: () => FleetBinaryProbe;
  readonly fetchJson?: FetchJson;
  readonly highestFloor?: (configPath: string) => Promise<string | null>;
  readonly now?: () => number;
};

async function floorFromConfig(configPath: string): Promise<string | null> {
  if (!existsSync(configPath)) return null;
  const cfg = await loadConfig(configPath);
  return checkCliVersion(null, collectCliVersionRequirements(cfg)).highestRequired;
}

export async function runVersions(options: VersionsOptions, deps: VersionsDeps = {}): Promise<number> {
  const probe = (deps.probe ?? (() => probeFleetBinary()))();
  let latest: RegistryPair | null = null;
  let registryError: string | null = null;
  try {
    latest = await fetchLatestPair(deps.fetchJson ?? defaultFetchJson, () => true);
  } catch (err) {
    registryError = err instanceof Error ? err.message : String(err);
  }
  let highestFloor: string | null = null;
  try {
    highestFloor = await (deps.highestFloor ?? floorFromConfig)(options.config ?? "clawcode.yaml");
  } catch (err) {
    cliError(`versions: could not read model floors: ${err instanceof Error ? err.message : String(err)}`);
  }

  const input = {
    latest,
    registryError,
    runtime: {
      sdkVersion: probe.sdkVersion,
      sdkClaudeCodeVersion: probe.sdkClaudeCodeVersion,
      binaryVersion: probe.version,
      source: probe.source,
      pin: probe.pin,
      error: probe.error,
    },
    highestFloor,
    now: (deps.now ?? Date.now)(),
  };
  const findings = evaluateVersions(input);

  if (options.json === true) {
    cliLog(JSON.stringify({ ...input, findings }, null, 2));
  } else {
    cliLog(renderReport(input, findings));
  }
  if (probe.sdkVersion === null) return 2;
  return findings.length === 0 ? 0 : 1;
}

export function registerVersionsCommand(program: Command): void {
  program
    .command("versions")
    .description("Report the Claude Code CLI + Agent SDK pair: installed, fleet binary, npm latest, lockstep")
    .option("-c, --config <path>", "Config file to read model floors from", "clawcode.yaml")
    .option("--json", "Emit the report as JSON")
    .action(async (options: VersionsOptions) => {
      process.exitCode = await runVersions(options);
    });
}

/**
 * `clawcode binary-manifest --out dist/claude-binary.json` — run at build time
 * (after `npm ci`) so the artifact records the sha256 of the SDK-bundled binary
 * it was built against. Deploy gates (`check-cli-version --expect-manifest`) and
 * the boot log compare the installed binary to it.
 */
export function runBinaryManifest(options: { readonly out?: string }): number {
  const manifest = buildBinaryManifest();
  if (manifest === null) {
    cliError("binary-manifest: no SDK-bundled Claude binary resolvable here (run `npm ci` first)");
    return 1;
  }
  if (options.out !== undefined) writeBinaryManifest(options.out, manifest);
  cliLog(JSON.stringify(manifest, null, 2));
  return 0;
}

export function registerBinaryManifestCommand(program: Command): void {
  program
    .command("binary-manifest")
    .description("Record the sha256 of the Agent SDK's bundled Claude binary (build-time integrity manifest)")
    .option("--out <path>", "Write the manifest JSON to this path")
    .action((options: { out?: string }) => {
      process.exitCode = runBinaryManifest(options);
    });
}
