/**
 * Phase 91 Plan 04 + Phase 96 Plan 06 — `clawcode sync run-once` subcommand.
 *
 * Synchronously drives ONE sync cycle via syncOnce() and prints the
 * SyncRunOutcome as JSON on stdout. This is the operator-facing manual
 * trigger AND the entry point invoked by scripts/sync/clawcode-sync.sh
 * (the systemd timer wrapper from Plan 91-01).
 *
 * Exit codes:
 *   0 — synced | skipped-no-changes | partial-conflicts | paused
 *   1 — failed-ssh | failed-rsync | thrown exception
 *   2 — deprecated (Phase 96 D-11 — Phase 91 mirror disabled; real refusal,
 *       NOT a graceful skip; exit 2 prevents systemd's SuccessExitStatus=1
 *       from masking deprecation as "all clear")
 *
 * Rationale for exit codes: systemd's `SuccessExitStatus=1` (set in
 * scripts/systemd/clawcode-sync.service) means a graceful-SSH-fail exit=1
 * won't pollute journalctl with failed-unit entries. Real rsync bugs
 * (exit 2+) still surface normally. Phase 96 D-11 deprecation is treated
 * as a real refusal (exit 2) so journalctl shows the unit as failed —
 * forcing operators to notice and run `clawcode sync re-enable-timer`
 * or accept the deprecation by removing the timer entirely.
 */
import type { Command } from "commander";
import pino from "pino";
import type { Logger } from "pino";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SYNC_JSONL_PATH,
  DEFAULT_SYNC_STATE_PATH,
} from "../../sync/sync-state-store.js";
import {
  syncOnce,
  type SyncRunnerDeps,
} from "../../sync/sync-runner.js";
import type { SyncRunOutcome } from "../../sync/types.js";
import { cliError, cliLog } from "../output.js";

/** Default rsync filter-file path (deployed by 91-01 scripts/sync/). */
export const DEFAULT_FILTER_FILE_PATH = "/opt/clawcode/scripts/sync/clawcode-sync-filter.txt";

export type RunSyncRunOnceArgs = Readonly<{
  syncStatePath?: string;
  filterFile?: string;
  syncJsonlPath?: string;
  log?: Logger;
  /**
   * DI — override the syncOnce invocation for hermetic tests. Given the
   * resolved deps struct, the stub can return canned outcomes without
   * spawning rsync or hitting the filesystem.
   */
  runSyncOnceDep?: (deps: SyncRunnerDeps) => Promise<SyncRunOutcome>;
}>;

function resolveDeps(args: RunSyncRunOnceArgs, log: Logger): SyncRunnerDeps {
  const fallbackJsonl = process.env.HOME
    ? join(process.env.HOME, ".clawcode", "manager", "sync.jsonl")
    : join(homedir(), ".clawcode", "manager", "sync.jsonl");
  return {
    syncStatePath: args.syncStatePath ?? DEFAULT_SYNC_STATE_PATH,
    filterFilePath: args.filterFile ?? DEFAULT_FILTER_FILE_PATH,
    syncJsonlPath: args.syncJsonlPath ?? DEFAULT_SYNC_JSONL_PATH ?? fallbackJsonl,
    log,
  };
}

export async function runSyncRunOnceAction(
  args: RunSyncRunOnceArgs,
): Promise<number> {
  const log: Logger =
    args.log ?? (pino({ level: "info" }) as unknown as Logger);
  const deps = resolveDeps(args, log);
  const runner = args.runSyncOnceDep ?? syncOnce;

  let outcome: SyncRunOutcome;
  try {
    outcome = await runner(deps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cliError(`sync run-once failed: ${msg}`);
    return 1;
  }

  cliLog(JSON.stringify(outcome, null, 2));
  // Phase 96 D-11: deprecated state is a REAL refusal (exit 2) — distinct
  // from graceful skips (exit 0) and rsync/ssh failures (exit 1). Exit 2
  // ensures systemd's SuccessExitStatus=1 doesn't mask the deprecation as
  // a successful no-op.
  if (outcome.kind === "deprecated") {
    cliError(
      `Phase 91 mirror deprecated; agents read source via ACL. Reason: ${outcome.reason}`,
    );
    cliError(
      "Use `clawcode sync re-enable-timer` to restore (within 7-day window).",
    );
    return 2;
  }
  // Only hard failures bubble to exit 1. Pause/skipped/partial-conflicts are
  // all "normal cycle outcomes" and map to exit 0.
  if (outcome.kind === "failed-ssh" || outcome.kind === "failed-rsync") {
    return 1;
  }
  return 0;
}

export function registerSyncRunOnceCommand(parent: Command): void {
  parent
    .command("run-once")
    .description("Run one synchronous sync cycle (manual trigger / systemd hook)")
    .option(
      "--filter-file <path>",
      "Override rsync filter-file path",
      DEFAULT_FILTER_FILE_PATH,
    )
    .option(
      "--sync-state-path <path>",
      "Override sync-state.json path (testing)",
    )
    .option(
      "--sync-jsonl-path <path>",
      "Override sync.jsonl path (testing)",
    )
    .action(
      async (opts: {
        filterFile?: string;
        syncStatePath?: string;
        syncJsonlPath?: string;
      }) => {
        const code = await runSyncRunOnceAction({
          filterFile: opts.filterFile,
          syncStatePath: opts.syncStatePath,
          syncJsonlPath: opts.syncJsonlPath,
        });
        process.exit(code);
      },
    );
}
