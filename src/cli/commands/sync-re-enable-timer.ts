/**
 * Phase 96 Plan 06 Task 2 — `clawcode sync re-enable-timer` subcommand (D-11).
 *
 * Operator-facing CLI for restoring the Phase 91 5-min mirror sync timer
 * AFTER it was deprecated by `clawcode sync disable-timer`. Honors the
 * 7-day rollback window (DEPRECATION_ROLLBACK_WINDOW_MS) — re-enable past
 * the window is refused with an operator-actionable error.
 *
 * State machine guards:
 *   1. authoritativeSide must be 'deprecated'   — else exit 1 "not in deprecated state"
 *   2. deprecatedAt must be present              — else exit 1 "inconsistent state"
 *   3. (now - deprecatedAt) must be < 7 days     — else exit 1 "rollback window expired"
 *   4. systemctl --user enable --now must succeed — else exit 1 (state NOT flipped)
 *
 * Sequence:
 *   1. Read sync-state.json
 *   2. Apply guards 1-3 (refuse on each with exit 1, state unchanged)
 *   3. Invoke `systemctl --user enable --now clawcode-sync-acme.timer`
 *   4. On systemctl failure: exit 1, state UNCHANGED (rollback semantics —
 *      we MUST be able to re-start the timer; failing systemctl means the
 *      operator must investigate before claiming the state is restored).
 *   5. Atomic temp+rename: set authoritativeSide='openclaw', clear deprecatedAt
 *   6. Append a ledger row to deprecation-ledger.jsonl with windowDaysRemaining
 *
 * Note systemctl ordering vs disable-timer:
 *   - disable-timer: state-update FIRST, systemctl SECOND (systemctl failure is graceful)
 *   - re-enable-timer: systemctl FIRST, state-update SECOND (systemctl failure is fatal)
 * Reasoning: re-enable is the rollback path — we want the systemd unit running
 * BEFORE we tell other code that authoritativeSide=openclaw. Otherwise we
 * have a window where state says "active" but no timer is firing.
 *
 * Exit codes:
 *   0 — flipped back to openclaw + timer enabled
 *   1 — guard refused | systemctl failed (state unchanged in all exit-1 paths)
 */
import type { Command } from "commander";
import { promisify } from "node:util";
import { execFile as nodeExecFile } from "node:child_process";
import pino from "pino";
import type { Logger } from "pino";
import {
  DEFAULT_SYNC_STATE_PATH,
  readSyncState,
  writeSyncState,
} from "../../sync/sync-state-store.js";
import {
  DEPRECATION_ROLLBACK_WINDOW_MS,
  type SyncStateFile,
} from "../../sync/types.js";
import { cliError, cliLog } from "../output.js";
import {
  DEFAULT_DEPRECATION_LEDGER_PATH,
  defaultLedgerAppender,
  type DeprecationLedgerEntry,
  type DeprecationLedgerAppender,
} from "./sync-deprecation-ledger.js";
import type { ExecFileImpl } from "./sync-disable-timer.js";

const execFileAsync = promisify(nodeExecFile);

const defaultExecFile: ExecFileImpl = async (cmd, args) => {
  const result = await execFileAsync(cmd, args as string[]);
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr),
  };
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export type RunSyncReEnableTimerArgs = Readonly<{
  syncStatePath?: string;
  ledgerPath?: string;
  log?: Logger;
  /** DI — override systemctl invocation for hermetic tests. */
  execFileImpl?: ExecFileImpl;
  /** DI — override deprecation-ledger appender for hermetic tests. */
  appendLedgerRow?: DeprecationLedgerAppender;
  /** DI — override the clock for deterministic 7-day-window math. */
  now?: () => Date;
}>;

/**
 * Execute the re-enable-timer action. Returns CLI exit code:
 *   0 — flipped successfully
 *   1 — state-machine guard or systemctl failure (state unchanged)
 */
export async function runSyncReEnableTimerAction(
  args: RunSyncReEnableTimerArgs,
): Promise<number> {
  const log: Logger =
    args.log ?? (pino({ level: "info" }) as unknown as Logger);
  const statePath = args.syncStatePath ?? DEFAULT_SYNC_STATE_PATH;
  const ledgerPath = args.ledgerPath ?? DEFAULT_DEPRECATION_LEDGER_PATH;
  const execFileImpl = args.execFileImpl ?? defaultExecFile;
  const ledgerWriter = args.appendLedgerRow ?? defaultLedgerAppender;
  const now = args.now?.() ?? new Date();

  const state = await readSyncState(statePath, log);

  // Guard 1: must be in deprecated state
  if (state.authoritativeSide !== "deprecated") {
    cliError(
      `Not in deprecated state (current: ${state.authoritativeSide}); nothing to re-enable.`,
    );
    return 1;
  }

  // Guard 2: deprecatedAt must be present (consistency check)
  if (state.deprecatedAt === undefined) {
    cliError(
      "Inconsistent state: authoritativeSide=deprecated but deprecatedAt missing. Manual recovery needed.",
    );
    return 1;
  }

  // Guard 3: 7-day rollback window
  const elapsedMs = now.getTime() - new Date(state.deprecatedAt).getTime();
  if (elapsedMs > DEPRECATION_ROLLBACK_WINDOW_MS) {
    const days = Math.floor(elapsedMs / ONE_DAY_MS);
    cliError(
      `Rollback window expired (${days} days since deprecation; max 7 days). Create a new sync setup.`,
    );
    return 1;
  }

  // systemctl FIRST: rollback semantics — we want the timer running BEFORE
  // we update authoritativeSide. Failure is FATAL (NOT graceful like disable).
  try {
    await execFileImpl("systemctl", [
      "--user",
      "enable",
      "--now",
      "clawcode-sync-acme.timer",
    ]);
    cliLog(
      "systemctl --user enable --now clawcode-sync-acme.timer: OK",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cliError(
      `systemctl enable failed: ${msg}. State NOT flipped — investigate the timer unit, then retry.`,
    );
    return 1;
  }

  // Atomic temp+rename: clear deprecatedAt, restore openclaw
  // (use destructure to drop the optional field cleanly)
  const { deprecatedAt: _omit, ...rest } = state;
  void _omit;
  const next: SyncStateFile = {
    ...rest,
    authoritativeSide: "openclaw",
    updatedAt: now.toISOString(),
  };
  await writeSyncState(statePath, next, log);

  // Ledger row with window-days-remaining at the time of re-enable
  const remainingMs = DEPRECATION_ROLLBACK_WINDOW_MS - elapsedMs;
  const remainingDays = Math.ceil(remainingMs / ONE_DAY_MS);
  const entry: DeprecationLedgerEntry = {
    action: "re-enable-timer",
    timestamp: now.toISOString(),
    deprecatedAt: state.deprecatedAt,
    windowDaysRemaining: remainingDays,
  };
  try {
    await ledgerWriter(entry, { filePath: ledgerPath, log });
  } catch (err) {
    log.warn({ err }, "deprecation-ledger append failed");
  }

  cliLog(
    `Phase 91 mirror sync timer re-enabled at ${now.toISOString()} (was deprecated for ${Math.floor(elapsedMs / ONE_DAY_MS)} day(s)).`,
  );
  return 0;
}

export function registerSyncReEnableTimerCommand(parent: Command): void {
  parent
    .command("re-enable-timer")
    .description(
      "Restore the Phase 91 mirror sync timer (within the 7-day rollback window of deprecation)",
    )
    .option(
      "--sync-state-path <path>",
      "Override sync-state.json path (testing)",
    )
    .option(
      "--ledger-path <path>",
      "Override deprecation-ledger.jsonl path (testing)",
    )
    .action(
      async (opts: { syncStatePath?: string; ledgerPath?: string }) => {
        const code = await runSyncReEnableTimerAction({
          syncStatePath: opts.syncStatePath,
          ledgerPath: opts.ledgerPath,
        });
        process.exit(code);
      },
    );
}
