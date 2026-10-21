/**
 * Phase 999.47 Plan 02 Task 3 — `clawcode homelab` CLI.
 *
 * Two subcommands:
 *
 *   - `clawcode homelab reindex [--repo-path <path>] [--strict] [--quiet]`
 *     Enumerates the live fleet from the registry, then fires the
 *     existing Phase 49 `ingest-document` IPC once per agent per
 *     INVENTORY.md / NETWORK.md / ACCESS.md file. Per-agent failures
 *     are logged and skipped (parallel-independence) unless `--strict`
 *     is passed, in which case any failure exits non-zero. The
 *     heartbeat tick (Task 2) invokes this subcommand fire-and-forget
 *     after a successful refresh so each agent's `memory_chunks` gets
 *     the latest homelab corpus on every cycle.
 *
 *   - `clawcode homelab refresh [--repo-path <path>]`
 *     Operator escape hatch that runs `scripts/refresh.sh` directly
 *     (same script the heartbeat tick spawns). Exits with the script's
 *     exit code. Designed for ad-hoc "I want a refresh NOW" workflows.
 *
 * Zero new IPC methods. Zero new SQLite tables. Reuses existing
 * primitives only.
 *
 * Test mockability — module-level injection slots for the IPC,
 * registry reader, and subprocess runner. Production wires the
 * real implementations; tests override via `__set*ForTests` helpers.
 */

import type { Command } from "commander";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH, REGISTRY_PATH } from "../../manager/daemon.js";
import { readRegistry } from "../../manager/registry.js";
import { cliLog, cliError } from "../output.js";
import { logger } from "../../shared/logger.js";

// ────────────────────────────────────────────────────────────────────
// Default knobs.
// ────────────────────────────────────────────────────────────────────
const DEFAULT_REPO_PATH = "/home/clawcode/homelab";
const CANONICAL_FILES: readonly string[] = ["INVENTORY.md", "NETWORK.md", "ACCESS.md"];

// ────────────────────────────────────────────────────────────────────
// Test-injection slots.
// ────────────────────────────────────────────────────────────────────

type IpcSender = (
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

// Narrow contract — only `name` is consumed downstream. Cast through
// `unknown` from the production `readRegistry()` return (which yields
// full RegistryEntry objects) when wiring the default impl. This shape
// is also test-friendly: tests need only construct `{name}` rows.
type RegistryReader = (path: string) => Promise<{
  readonly entries: readonly { readonly name: string }[];
}>;

type RefreshRunner = (
  repoPath: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

let ipcSender: IpcSender = sendIpcRequest;
let registryReader: RegistryReader = readRegistry;

const execFileP = promisify(execFile);
const defaultRefreshRunner: RefreshRunner = async (repoPath) => {
  try {
    const result = await execFileP("bash", [join(repoPath, "scripts", "refresh.sh")], {
      cwd: repoPath,
      timeout: 5 * 60 * 1000,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err) {
    const errAny = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: errAny.stdout ?? "",
      stderr: errAny.stderr ?? errAny.message ?? "",
      exitCode:
        typeof errAny.code === "number" ? errAny.code : errAny.code === undefined ? null : -1,
    };
  }
};
let refreshRunner: RefreshRunner = defaultRefreshRunner;

/**
 * 2026-09-23 — resolve agent-name → workspace dir from clawcode.yaml.
 *
 * The daemon's `ingest-document` handler refuses any file_path outside
 * the target agent's workspace (T-101-08), so the reindex flow can no
 * longer hand every agent the shared `/home/clawcode/homelab/*.md`
 * paths directly — that dead-errored 3 files × N agents every heartbeat
 * cycle (144 refusals/6 h measured on prod). Instead, reindex now copies
 * each canonical file into `<workspace>/homelab/<file>` and ingests the
 * workspace-local copy, keeping T-101-08 fully intact.
 *
 * Config load failure degrades gracefully: resolver returns an empty
 * map and each agent falls back to the legacy direct-path ingest (which
 * surfaces the guard's own error, same as before this change).
 */
type WorkspaceResolver = () => Promise<ReadonlyMap<string, string>>;

const defaultWorkspaceResolver: WorkspaceResolver = async () => {
  try {
    const { loadConfig, resolveAllAgents } = await import("../../config/loader.js");
    const { resolveConfigPath } = await import("../../config/resolve-path.js");
    const config = await loadConfig(resolveConfigPath("clawcode.yaml"));
    const resolved = resolveAllAgents(config);
    return new Map(resolved.map((a) => [a.name, a.workspace]));
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "phase999.47-homelab-reindex: workspace resolution failed — falling back to direct-path ingest",
    );
    return new Map();
  }
};

let workspaceResolver: WorkspaceResolver = defaultWorkspaceResolver;

/** Test-only: replace the IPC sender. Restore in afterEach. */
export function __setIpcSenderForTests(impl: IpcSender | null): void {
  ipcSender = impl ?? sendIpcRequest;
}

/** Test-only: replace the workspace resolver. Restore in afterEach. */
export function __setWorkspaceResolverForTests(
  impl: WorkspaceResolver | null,
): void {
  workspaceResolver = impl ?? defaultWorkspaceResolver;
}

/** Test-only: replace the registry reader. Restore in afterEach. */
export function __setRegistryReaderForTests(impl: RegistryReader | null): void {
  registryReader = impl ?? readRegistry;
}

/** Test-only: replace the refresh runner. Restore in afterEach. */
export function __setRefreshRunnerForTests(impl: RefreshRunner | null): void {
  refreshRunner = impl ?? defaultRefreshRunner;
}

// ────────────────────────────────────────────────────────────────────
// Exported runner — pure function for test invocation without going
// through commander's action dispatch.
// ────────────────────────────────────────────────────────────────────

export type ReindexOptions = {
  readonly repoPath?: string;
  readonly strict?: boolean;
  readonly quiet?: boolean;
};

export type ReindexResult = {
  readonly totalAgents: number;
  readonly totalFiles: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly perAgent: ReadonlyArray<{
    readonly agent: string;
    readonly succeeded: number;
    readonly failed: number;
    readonly errors: ReadonlyArray<{ readonly source: string; readonly error: string }>;
  }>;
};

/**
 * Execute the reindex flow without going through commander. Returns
 * the aggregated result; never throws on per-agent IPC failure (those
 * are captured in the result). Throws on infrastructure errors
 * (missing repo path, registry unreadable).
 */
export async function runHomelabReindex(opts: ReindexOptions): Promise<ReindexResult> {
  const repoPath = opts.repoPath ?? DEFAULT_REPO_PATH;
  if (!existsSync(repoPath)) {
    const err = new Error(`homelab repo not found at ${repoPath}`);
    (err as NodeJS.ErrnoException).code = "ENOENT";
    throw err;
  }

  const registry = await registryReader(REGISTRY_PATH);
  const agents = registry.entries;

  if (agents.length === 0) {
    logger.warn(
      { totalAgents: 0, repoPath },
      "phase999.47-homelab-reindex",
    );
    return {
      totalAgents: 0,
      totalFiles: 0,
      succeeded: 0,
      failed: 0,
      perAgent: [],
    };
  }

  const perAgent: Array<{
    agent: string;
    succeeded: number;
    failed: number;
    errors: Array<{ source: string; error: string }>;
  }> = [];

  let totalSucceeded = 0;
  let totalFailed = 0;
  let totalFiles = 0;

  // T-101-08 compliance — stage each canonical file inside the target
  // agent's workspace and ingest the local copy (see WorkspaceResolver
  // doc comment). Agents missing from the map (e.g. registry gravestones
  // not present in clawcode.yaml, or a failed config load) fall back to
  // the legacy direct repo path.
  const workspaces = await workspaceResolver();

  for (const entry of agents) {
    const agentResult = {
      agent: entry.name,
      succeeded: 0,
      failed: 0,
      errors: [] as Array<{ source: string; error: string }>,
    };

    for (const fileName of CANONICAL_FILES) {
      totalFiles += 1;
      const sourcePath = join(repoPath, fileName);
      const workspace = workspaces.get(entry.name);
      let filePath = sourcePath;
      try {
        if (workspace) {
          const stagedDir = join(workspace, "homelab");
          const stagedPath = join(stagedDir, fileName);
          const { mkdir, copyFile } = await import("node:fs/promises");
          await mkdir(stagedDir, { recursive: true });
          await copyFile(sourcePath, stagedPath);
          filePath = stagedPath;
        }
        await ipcSender(SOCKET_PATH, "ingest-document", {
          agent: entry.name,
          file_path: filePath,
          source: fileName,
        });
        agentResult.succeeded += 1;
        totalSucceeded += 1;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        agentResult.failed += 1;
        agentResult.errors.push({ source: fileName, error: errMsg });
        totalFailed += 1;
      }
    }
    perAgent.push(agentResult);
  }

  const result: ReindexResult = {
    totalAgents: agents.length,
    totalFiles,
    succeeded: totalSucceeded,
    failed: totalFailed,
    perAgent,
  };

  logger.info(
    {
      totalAgents: result.totalAgents,
      totalFiles: result.totalFiles,
      succeeded: result.succeeded,
      failed: result.failed,
      repoPath,
    },
    "phase999.47-homelab-reindex",
  );

  return result;
}

/**
 * Pretty-print the reindex result as a per-agent summary table. Used
 * by the CLI's action handler unless `--quiet` is passed.
 */
function formatReindexSummary(result: ReindexResult): string {
  const header = `Homelab reindex — ${result.totalAgents} agents, ${result.totalFiles} files`;
  const sep = "─".repeat(header.length);
  const lines: string[] = [header, sep];
  for (const row of result.perAgent) {
    const status = row.failed === 0 ? "ok" : `${row.failed} failed`;
    lines.push(`  ${row.agent.padEnd(24)}  ${row.succeeded} ok, ${status}`);
    for (const e of row.errors) {
      lines.push(`    ${e.source}: ${e.error}`);
    }
  }
  lines.push(sep);
  lines.push(
    `Total: ${result.succeeded} succeeded, ${result.failed} failed across ${result.totalAgents} agents`,
  );
  return lines.join("\n");
}

/** Decide the process exit code from the reindex outcome + flags. */
function exitCodeFor(result: ReindexResult, strict: boolean): number {
  if (result.totalAgents === 0) return 0;
  if (result.failed === 0) return 0;
  if (result.succeeded === 0) return 1;
  return strict ? 1 : 0;
}

// ────────────────────────────────────────────────────────────────────
// Refresh runner (operator escape hatch).
// ────────────────────────────────────────────────────────────────────

export type RefreshOptions = {
  readonly repoPath?: string;
};

export type RefreshResult = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export async function runHomelabRefresh(opts: RefreshOptions): Promise<RefreshResult> {
  const repoPath = opts.repoPath ?? DEFAULT_REPO_PATH;
  if (!existsSync(repoPath)) {
    const err = new Error(`homelab repo not found at ${repoPath}`);
    (err as NodeJS.ErrnoException).code = "ENOENT";
    throw err;
  }
  return refreshRunner(repoPath);
}

// ────────────────────────────────────────────────────────────────────
// commander registration.
// ────────────────────────────────────────────────────────────────────

export function registerHomelabCommand(program: Command): void {
  const homelab = program
    .command("homelab")
    .description("Homelab inventory operations (Phase 999.47)");

  homelab
    .command("reindex")
    .description(
      "Fan out INVENTORY/NETWORK/ACCESS into every agent's memory_chunks via ingest-document IPC",
    )
    .option("--repo-path <path>", "Path to the homelab repo", DEFAULT_REPO_PATH)
    .option("--strict", "Exit non-zero if ANY agent reindex fails", false)
    .option("--quiet", "Suppress the per-agent summary table", false)
    .action(
      async (options: {
        readonly repoPath: string;
        readonly strict: boolean;
        readonly quiet: boolean;
      }) => {
        try {
          const result = await runHomelabReindex({
            repoPath: options.repoPath,
            strict: options.strict,
            quiet: options.quiet,
          });

          if (!options.quiet) {
            cliLog(formatReindexSummary(result));
          }
          const code = exitCodeFor(result, options.strict);
          process.exit(code);
        } catch (err) {
          const errAny = err as NodeJS.ErrnoException;
          if (errAny.code === "ENOENT") {
            cliError(errAny.message);
            process.exit(2);
          }
          const msg = err instanceof Error ? err.message : String(err);
          cliError(`Reindex failed: ${msg}`);
          process.exit(1);
        }
      },
    );

  homelab
    .command("refresh")
    .description(
      "Run scripts/refresh.sh once directly (operator escape hatch — same path the heartbeat tick uses)",
    )
    .option("--repo-path <path>", "Path to the homelab repo", DEFAULT_REPO_PATH)
    .action(async (options: { readonly repoPath: string }) => {
      try {
        const result = await runHomelabRefresh({ repoPath: options.repoPath });
        if (result.stdout) cliLog(result.stdout);
        if (result.stderr) cliError(result.stderr);
        if (result.exitCode === 0) {
          process.exit(0);
        } else {
          process.exit(1);
        }
      } catch (err) {
        const errAny = err as NodeJS.ErrnoException;
        if (errAny.code === "ENOENT") {
          cliError(errAny.message);
          process.exit(2);
        }
        const msg = err instanceof Error ? err.message : String(err);
        cliError(`Refresh failed: ${msg}`);
        process.exit(1);
      }
    });
}
