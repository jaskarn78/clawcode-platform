/**
 * Phase 91 Plan 04 — `clawcode sync finalize` subcommand (D-20).
 *
 * Day-7 cleanup prompt. Designed to run manually (or from a cron) AFTER the
 * rollback window closes. This command NEVER deletes the OpenClaw workspace
 * — that is always an operator-executed `ssh ... rm -rf ...` or equivalent,
 * for safety. This command just:
 *
 *   1. Checks that authoritativeSide=clawcode (finalize is post-cutover only)
 *   2. Verifies the 7-day rollback window has closed (state.updatedAt + 7 days < now)
 *   3. Prompts the operator to confirm the rollback window should close
 *   4. On confirm — prints the exact ssh command for manual workspace removal
 *
 * This conservative shape matches D-20's "never auto-deletes" rule: the
 * 513MB+ OpenClaw workspace is a rollback safety net; removing it is a
 * hands-on operation, not an automated one.
 *
 * Exit codes:
 *   0 — prompt completed (regardless of y/N)
 *   1 — authoritativeSide != clawcode | rollback window not yet expired
 */
import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import pino from "pino";
import type { Logger } from "pino";
import {
  DEFAULT_SYNC_STATE_PATH,
  readSyncState,
} from "../../sync/sync-state-store.js";
import { cliError, cliLog } from "../output.js";
import { ROLLBACK_WINDOW_MS } from "./sync-set-authoritative.js";

export type RunSyncFinalizeArgs = Readonly<{
  syncStatePath?: string;
  log?: Logger;
  /** DI — override the interactive prompt for hermetic tests. */
  promptConfirm?: (question: string) => Promise<boolean>;
  /** DI — override the clock for deterministic date-math tests. */
  now?: () => Date;
  /** If true, skip the 7-day guard (mirrors --force flag — destructive). */
  force?: boolean;
}>;

async function defaultPromptConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function runSyncFinalizeAction(
  args: RunSyncFinalizeArgs,
): Promise<number> {
  const log: Logger =
    args.log ?? (pino({ level: "info" }) as unknown as Logger);
  const statePath = args.syncStatePath ?? DEFAULT_SYNC_STATE_PATH;
  const now = args.now?.() ?? new Date();

  const state = await readSyncState(statePath, log);

  if (state.authoritativeSide !== "clawcode") {
    cliError(
      "Finalize only runs post-cutover (authoritativeSide=clawcode). Run `clawcode sync set-authoritative clawcode --confirm-cutover` first.",
    );
    return 1;
  }

  if (state.updatedAt && !args.force) {
    const ageMs = now.getTime() - new Date(state.updatedAt).getTime();
    if (ageMs < ROLLBACK_WINDOW_MS) {
      const remainingDays = Math.ceil(
        (ROLLBACK_WINDOW_MS - ageMs) / (24 * 60 * 60 * 1000),
      );
      cliError(
        `Cannot finalize — ${remainingDays} days remain in the 7-day rollback window. ` +
          `Either wait for expiry, or run with --force to bypass the guard (not recommended).`,
      );
      return 1;
    }
  }

  const prompt = args.promptConfirm ?? defaultPromptConfirm;
  const ok = await prompt(
    `Rollback window expired. Close the book and acknowledge the OpenClaw mirror can be removed? (y/N) `,
  );
  if (!ok) {
    cliLog("Aborted. Re-run when ready.");
    return 0;
  }

  cliLog(
    "Acknowledged. To reclaim the 513MB+ OpenClaw mirror, run this command MANUALLY via SSH:",
  );
  cliLog("");
  cliLog(`  ssh ${state.openClawHost} "rm -rf ${state.openClawWorkspace}"`);
  cliLog("");
  cliLog(
    "See .planning/migrations/fin-client-cutover.md §Day-7 Finalize for the full runbook.",
  );
  return 0;
}

export function registerSyncFinalizeCommand(parent: Command): void {
  parent
    .command("finalize")
    .description(
      "Day-7 post-cutover cleanup prompt (non-destructive — prints manual ssh removal command)",
    )
    .option("--force", "Bypass the 7-day rollback window guard")
    .option(
      "--sync-state-path <path>",
      "Override sync-state.json path (testing)",
    )
    .action(async (opts: { force?: boolean; syncStatePath?: string }) => {
      const code = await runSyncFinalizeAction({
        force: opts.force,
        syncStatePath: opts.syncStatePath,
      });
      process.exit(code);
    });
}
