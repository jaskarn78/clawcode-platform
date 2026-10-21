/**
 * Phase 91 Plan 04 — `clawcode sync resolve <path> --side openclaw|clawcode`.
 *
 * Resolves an existing sync conflict (recorded in sync-state.json.conflicts[]
 * by Plan 91-02's conflict detector) by copying the chosen side's version of
 * the file to the other side and updating perFileHashes[path] to the new
 * sha256. Clears the matching unresolved conflict entry so the 5-minute timer
 * resumes syncing that file on the next cycle.
 *
 * Semantics (D-14):
 *   --side openclaw  — pull `openClawHost:openClawWorkspace/<path>` to
 *                      `clawcodeWorkspace/<path>` (operator wants OpenClaw to win)
 *   --side clawcode  — push `clawcodeWorkspace/<path>` to
 *                      `openClawHost:openClawWorkspace/<path>` (operator wants
 *                      ClawCode to win — rare pre-cutover)
 *
 * Exit codes:
 *   0 — conflict resolved + state written
 *   1 — path not in conflicts, rsync failed, or invalid --side value
 */
import type { Command } from "commander";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import type { Logger } from "pino";
import {
  DEFAULT_SYNC_STATE_PATH,
  readSyncState,
  writeSyncState,
} from "../../sync/sync-state-store.js";
import type { SyncStateFile } from "../../sync/types.js";
import { cliError, cliLog } from "../output.js";

/**
 * rsync runner signature — mirrors sync-runner.ts RsyncRunner so the same
 * stub can feed both entry points.
 */
export type RsyncRunnerFn = (
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export type RunSyncResolveArgs = Readonly<{
  path: string;
  side: "openclaw" | "clawcode";
  syncStatePath?: string;
  log?: Logger;
  /** DI — override rsync for hermetic tests. */
  runRsync?: RsyncRunnerFn;
  /** DI — override readFile (for sha256 recompute) in hermetic tests. */
  readFileImpl?: typeof readFile;
}>;

async function defaultRsyncRunner(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = execFile(
      "rsync",
      args as string[],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const exitCode =
          err && typeof (err as NodeJS.ErrnoException).code === "number"
            ? ((err as NodeJS.ErrnoException).code as unknown as number)
            : err
              ? 1
              : 0;
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          exitCode,
        });
      },
    );
    child.on("error", () => {
      /* callback path handles it; avoid double-resolve */
    });
  });
}

/** Rsync args for a single-file pull/push (same shape, swap src/dst). */
function buildSingleFileRsyncArgs(src: string, dst: string): readonly string[] {
  return [
    "-av",
    "--inplace",
    "--partial",
    "--timeout=120",
    "-e",
    "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new",
    src,
    dst,
  ];
}

export async function runSyncResolveAction(
  args: RunSyncResolveArgs,
): Promise<number> {
  const log: Logger =
    args.log ?? (pino({ level: "info" }) as unknown as Logger);
  const statePath = args.syncStatePath ?? DEFAULT_SYNC_STATE_PATH;
  const runRsync = args.runRsync ?? defaultRsyncRunner;
  const readImpl = args.readFileImpl ?? readFile;

  const state = await readSyncState(statePath, log);

  // Find the unresolved conflict for this path. Multiple entries with the
  // same path can exist (one resolved, then a new divergence); we only
  // touch the one with resolvedAt === null.
  const existing = state.conflicts.find(
    (c) => c.path === args.path && c.resolvedAt === null,
  );
  if (!existing) {
    cliError(
      `No unresolved conflict for path '${args.path}' in ${statePath}`,
    );
    return 1;
  }

  // D-14 — copy chosen side → other side via single-file rsync.
  let rsyncArgs: readonly string[];
  if (args.side === "openclaw") {
    // Pull openclaw/<path> → clawcode/<path> (OpenClaw wins).
    const src = `${state.openClawHost}:${state.openClawWorkspace}/${args.path}`;
    const dst = `${state.clawcodeWorkspace}/${args.path}`;
    rsyncArgs = buildSingleFileRsyncArgs(src, dst);
  } else {
    // Push clawcode/<path> → openclaw/<path> (ClawCode wins).
    const src = `${state.clawcodeWorkspace}/${args.path}`;
    const dst = `${state.openClawHost}:${state.openClawWorkspace}/${args.path}`;
    rsyncArgs = buildSingleFileRsyncArgs(src, dst);
  }

  const result = await runRsync(rsyncArgs);
  if (result.exitCode !== 0) {
    cliError(
      `rsync failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
    );
    return 1;
  }

  // Recompute sha256 of the now-identical file, reading the local
  // (clawcode-side) copy. If we just pushed, the local copy is the source;
  // if we pulled, rsync just wrote the local copy. Either way, the local
  // path is the authoritative reference for perFileHashes.
  const localPath = join(state.clawcodeWorkspace, args.path);
  let newHash: string;
  try {
    const buf = await readImpl(localPath);
    newHash = createHash("sha256").update(buf).digest("hex");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cliError(`Failed to re-hash ${localPath} after rsync: ${msg}`);
    return 1;
  }

  // Immutable update — build a new state object, never mutate the passed-in
  // `state` (per global coding-style rules).
  const now = new Date().toISOString();
  const nextState: SyncStateFile = {
    ...state,
    updatedAt: now,
    perFileHashes: { ...state.perFileHashes, [args.path]: newHash },
    conflicts: state.conflicts.map((c) =>
      c.path === args.path && c.resolvedAt === null
        ? { ...c, resolvedAt: now }
        : c,
    ),
  };

  await writeSyncState(statePath, nextState, log);

  cliLog(
    `Resolved '${args.path}' using ${args.side} side. Automatic sync resumed for this file. New sha256: ${newHash.slice(0, 12)}...`,
  );
  return 0;
}

export function registerSyncResolveCommand(parent: Command): void {
  parent
    .command("resolve <path>")
    .description(
      "Resolve a sync conflict by choosing which side wins (--side openclaw|clawcode)",
    )
    .requiredOption("--side <side>", "openclaw | clawcode")
    .option(
      "--sync-state-path <path>",
      "Override sync-state.json path (testing)",
    )
    .action(
      async (
        path: string,
        opts: { side: string; syncStatePath?: string },
      ) => {
        if (opts.side !== "openclaw" && opts.side !== "clawcode") {
          cliError(`--side must be 'openclaw' or 'clawcode' (got: ${opts.side})`);
          process.exit(1);
          return;
        }
        const code = await runSyncResolveAction({
          path,
          side: opts.side,
          syncStatePath: opts.syncStatePath,
        });
        process.exit(code);
      },
    );
}
