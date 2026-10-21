/**
 * Phase 96 Plan 06 Task 2 — `clawcode sync disable-timer` subcommand (D-11).
 *
 * Operator-facing CLI for deprecating the Phase 91 5-min mirror sync timer.
 * Idempotent: running twice is safe — second run detects the already-deprecated
 * state and no-ops without rewriting state or invoking systemctl.
 *
 * Sequence:
 *   1. Read sync-state.json
 *   2. If already deprecated → log "already deprecated", exit 0 (idempotent)
 *   3. Atomic temp+rename: set authoritativeSide='deprecated', deprecatedAt=now
 *   4. Invoke `systemctl --user disable clawcode-sync-acme.timer` via
 *      execFile (node:child_process — Phase 91 line 540 pattern; zero new deps)
 *   5. systemctl failure is GRACEFUL (RESEARCH.md Pitfall 6) — log warning,
 *      DO NOT abort. State is already updated; subsequent reads will see
 *      'deprecated' and the runner short-circuits regardless of whether the
 *      systemd unit was successfully disabled.
 *   6. Append a ledger row to deprecation-ledger.jsonl
 *   7. Print success + suggest re-enable-timer command
 *
 * Exit codes:
 *   0 — flipped to deprecated (or already deprecated; idempotent)
 *   (no exit 1 path — this command is a one-way switch with rollback guarded
 *   separately by re-enable-timer's 7-day window)
 *
 * All I/O is DI-injected (execFileImpl, appendLedgerRow, now) so tests can
 * inject fakes without touching real systemctl or the real filesystem.
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
import type { SyncStateFile } from "../../sync/types.js";
import { cliLog } from "../output.js";
import {
  DEFAULT_DEPRECATION_LEDGER_PATH,
  defaultLedgerAppender,
  type DeprecationLedgerEntry,
  type DeprecationLedgerAppender,
} from "./sync-deprecation-ledger.js";

const execFileAsync = promisify(nodeExecFile);

/**
 * Default systemctl invoker — wraps execFile via promisify. Tests inject a
 * vi.fn that returns canned outcomes without spawning a real subprocess.
 */
export type ExecFileImpl = (
  cmd: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileImpl = async (cmd, args) => {
  const result = await execFileAsync(cmd, args as string[]);
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr),
  };
};

export type RunSyncDisableTimerArgs = Readonly<{
  syncStatePath?: string;
  ledgerPath?: string;
  log?: Logger;
  /** DI — override systemctl invocation for hermetic tests. */
  execFileImpl?: ExecFileImpl;
  /** DI — override deprecation-ledger appender for hermetic tests. */
  appendLedgerRow?: DeprecationLedgerAppender;
  /** DI — override the clock for deterministic timestamps. */
  now?: () => Date;
}>;

/**
 * Execute the disable-timer action. Returns CLI exit code (0 always — this
 * command is one-way + idempotent + graceful on systemctl failure).
 */
export async function runSyncDisableTimerAction(
  args: RunSyncDisableTimerArgs,
): Promise<number> {
  const log: Logger =
    args.log ?? (pino({ level: "info" }) as unknown as Logger);
  const statePath = args.syncStatePath ?? DEFAULT_SYNC_STATE_PATH;
  const ledgerPath = args.ledgerPath ?? DEFAULT_DEPRECATION_LEDGER_PATH;
  const execFileImpl = args.execFileImpl ?? defaultExecFile;
  const ledgerWriter = args.appendLedgerRow ?? defaultLedgerAppender;
  const now = args.now?.() ?? new Date();

  const state = await readSyncState(statePath, log);

  // Idempotent: already deprecated → no-op exit 0
  if (state.authoritativeSide === "deprecated") {
    cliLog(
      `Already deprecated (deprecatedAt=${state.deprecatedAt ?? "(unknown)"}). No-op.`,
    );
    return 0;
  }

  // Atomic temp+rename: flip authoritativeSide + set deprecatedAt
  const next: SyncStateFile = {
    ...state,
    authoritativeSide: "deprecated",
    deprecatedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await writeSyncState(statePath, next, log);

  // Invoke systemctl. Failure is GRACEFUL (Pitfall 6 — dev box may not have
  // the unit installed). Log warning, continue.
  try {
    await execFileImpl("systemctl", [
      "--user",
      "disable",
      "clawcode-sync-acme.timer",
    ]);
    cliLog("systemctl --user disable clawcode-sync-acme.timer: OK");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      { error: msg },
      "systemctl disable failed — unit may be absent on this host (continuing; state already deprecated)",
    );
    cliLog(
      `(systemctl disable failed — unit may be absent on this host: ${msg}. State is still flipped to deprecated.)`,
    );
  }

  // Ledger row — operator audit trail
  const entry: DeprecationLedgerEntry = {
    action: "disable-timer",
    timestamp: now.toISOString(),
    deprecatedAt: now.toISOString(),
  };
  try {
    await ledgerWriter(entry, { filePath: ledgerPath, log });
  } catch (err) {
    log.warn({ err }, "deprecation-ledger append failed");
  }

  cliLog(`Phase 91 mirror sync deprecated at ${now.toISOString()}`);
  cliLog(
    "Run `clawcode sync re-enable-timer` within 7 days to restore the timer.",
  );
  return 0;
}

export function registerSyncDisableTimerCommand(parent: Command): void {
  parent
    .command("disable-timer")
    .description(
      "Disable the Phase 91 mirror sync timer (Phase 96 D-11 — agents read source via ACL)",
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
        const code = await runSyncDisableTimerAction({
          syncStatePath: opts.syncStatePath,
          ledgerPath: opts.ledgerPath,
        });
        process.exit(code);
      },
    );
}

