/**
 * Phase 91 Plan 04 — `clawcode sync start --reverse` + `clawcode sync stop`.
 *
 * D-18: Post-cutover, reverse sync (ClawCode → OpenClaw) is OPT-IN. The
 * 5-min timer stays as a no-op (syncOnce() returns `paused` when
 * authoritativeSide=clawcode) until the operator explicitly enables reverse
 * mode via this command.
 *
 * Storage strategy: a sentinel flag file at
 * `~/.clawcode/manager/reverse-sync-enabled.flag`. We deliberately do NOT
 * extend the SyncStateFile schema (pinned by zod in Plan 91-01) — a flag
 * file is cheaper and avoids schema churn. Future plans can promote this
 * to a proper schema field if the need arises.
 *
 * Exit codes:
 *   start --reverse: 0 on success, 1 if authoritativeSide != clawcode
 *                    (reverse sync requires post-cutover state)
 *   stop:            0 always (idempotent — unlinking a missing file is OK)
 */
import type { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import pino from "pino";
import type { Logger } from "pino";
import {
  DEFAULT_SYNC_STATE_PATH,
  readSyncState,
} from "../../sync/sync-state-store.js";
import { cliError, cliLog } from "../output.js";

/** Canonical path for the reverse-sync opt-in flag file. */
export function defaultReverseSyncFlagPath(): string {
  return join(
    process.env.HOME ?? homedir(),
    ".clawcode",
    "manager",
    "reverse-sync-enabled.flag",
  );
}

export type RunSyncReverseStartArgs = Readonly<{
  syncStatePath?: string;
  flagPath?: string;
  log?: Logger;
  now?: () => Date;
}>;

export type RunSyncStopArgs = Readonly<{
  flagPath?: string;
  log?: Logger;
}>;

export async function runSyncReverseStartAction(
  args: RunSyncReverseStartArgs,
): Promise<number> {
  const log: Logger =
    args.log ?? (pino({ level: "info" }) as unknown as Logger);
  const statePath = args.syncStatePath ?? DEFAULT_SYNC_STATE_PATH;
  const flagPath = args.flagPath ?? defaultReverseSyncFlagPath();
  const now = args.now?.() ?? new Date();

  const state = await readSyncState(statePath, log);
  if (state.authoritativeSide !== "clawcode") {
    cliError(
      "Reverse sync requires authoritativeSide=clawcode — run `clawcode sync set-authoritative clawcode --confirm-cutover` first.",
    );
    return 1;
  }

  // Touch the flag file — content is an ISO timestamp for audit trail, but
  // the 5-min timer only cares about the file's existence.
  const { dirname } = await import("node:path");
  await mkdir(dirname(flagPath), { recursive: true });
  await writeFile(flagPath, now.toISOString(), "utf8");

  cliLog(
    `Reverse sync (ClawCode → OpenClaw) ENABLED. The next timer tick will run reverse sync. Flag: ${flagPath}`,
  );
  return 0;
}

export async function runSyncStopAction(args: RunSyncStopArgs): Promise<number> {
  const flagPath = args.flagPath ?? defaultReverseSyncFlagPath();
  try {
    await unlink(flagPath);
    cliLog("Reverse sync STOPPED. authoritativeSide unchanged.");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      cliLog("Reverse sync was not enabled (no-op).");
    } else {
      // Any other unlink error is worth surfacing but not worth failing on
      // — the operator can remove the flag manually.
      const msg = err instanceof Error ? err.message : String(err);
      cliError(`Failed to remove flag file: ${msg} (continuing)`);
    }
  }
  return 0;
}

export function registerSyncReverseCommand(parent: Command): void {
  parent
    .command("start")
    .description(
      "Start reverse sync (ClawCode → OpenClaw). Requires --reverse + post-cutover state.",
    )
    .option("--reverse", "Required — enables reverse direction")
    .option(
      "--sync-state-path <path>",
      "Override sync-state.json path (testing)",
    )
    .option("--flag-path <path>", "Override reverse-sync flag file path (testing)")
    .action(
      async (opts: {
        reverse?: boolean;
        syncStatePath?: string;
        flagPath?: string;
      }) => {
        if (!opts.reverse) {
          cliError(
            "`clawcode sync start` requires --reverse. No other direction is controllable via this command.",
          );
          process.exit(1);
          return;
        }
        const code = await runSyncReverseStartAction({
          syncStatePath: opts.syncStatePath,
          flagPath: opts.flagPath,
        });
        process.exit(code);
      },
    );

  parent
    .command("stop")
    .description("Stop reverse sync (leaves authoritativeSide unchanged)")
    .option("--flag-path <path>", "Override reverse-sync flag file path (testing)")
    .action(async (opts: { flagPath?: string }) => {
      const code = await runSyncStopAction({ flagPath: opts.flagPath });
      process.exit(code);
    });
}
