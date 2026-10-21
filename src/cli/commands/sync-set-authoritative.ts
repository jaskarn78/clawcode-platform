/**
 * Phase 91 Plan 04 — `clawcode sync set-authoritative <side>` subcommand.
 *
 * Operator-facing cutover control — the single most destructive command in
 * the sync surface. Implements D-17 drain-then-flip for the forward cutover
 * (openclaw → clawcode) + D-19 reverse drain for the 7-day rollback window,
 * with D-21 atomic mid-drain verification and D-20's 7-day guard on top.
 *
 * Flags (mutually exclusive gates):
 *   --confirm-cutover   Required when flipping TO clawcode (fresh cutover)
 *   --revert-cutover    Required when flipping back TO openclaw within 7 days
 *   --force-rollback    Override the 7-day window when reverting after expiry
 *
 * Drain-then-flip sequence (--confirm-cutover path):
 *   1. Read current sync-state.json
 *   2. Guard — already authoritative? return 1 with hint, no action
 *   3. Guard — --confirm-cutover missing? return 1 with destructive warning
 *   4. Run one synchronous OpenClaw→ClawCode cycle via syncOnce() to drain
 *   5. Guard — drain returned failed-ssh|failed-rsync? return 1, state unchanged
 *   6. Guard — drain returned partial-conflicts? return 1, tell operator to resolve first
 *   7. Prompt "Flip authoritative to clawcode? (y/N)"
 *   8. On 'y' — atomic write new authoritativeSide, on 'n' — return 0, state unchanged
 *
 * Rollback sequence (--revert-cutover path):
 *   1. Read current sync-state.json
 *   2. Guard — already authoritative=openclaw? return 1
 *   3. Guard — neither --revert-cutover nor --force-rollback? return 1 with hint
 *   4. 7-day window check (D-20) against state.updatedAt
 *        - within 7 days + --revert-cutover: proceed
 *        - past 7 days + --force-rollback: proceed with warning
 *        - past 7 days + only --revert-cutover: return 1 with "use --force-rollback"
 *   5. Prompt "Flip authoritative back to openclaw? (y/N)"
 *   6. On 'y' — atomic write, on 'n' — return 0, state unchanged
 *
 * Exit codes:
 *   0 — flip succeeded | operator aborted at prompt | already on requested side
 *       (all user-visible via stdout/stderr messaging)
 *   1 — missing/invalid flag combo | drain failed | prompt-ok but write failed
 */
import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import pino from "pino";
import type { Logger } from "pino";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SYNC_JSONL_PATH,
  DEFAULT_SYNC_STATE_PATH,
  readSyncState,
  writeSyncState,
} from "../../sync/sync-state-store.js";
import {
  syncOnce,
  type SyncRunnerDeps,
} from "../../sync/sync-runner.js";
import type {
  SyncRunOutcome,
  SyncStateFile,
} from "../../sync/types.js";
import { DEFAULT_FILTER_FILE_PATH } from "./sync-run-once.js";
import { cliError, cliLog } from "../output.js";
import {
  REPORT_FRESHNESS_MS,
  defaultCutoverReportPath,
  type SetAuthoritativePreconditionResult,
} from "../../cutover/types.js";
import { readCutoverReport } from "../../cutover/report-writer.js";
import {
  appendCutoverRow,
  DEFAULT_CUTOVER_LEDGER_PATH,
} from "../../cutover/ledger.js";

/** D-20 rollback window: 7 days in milliseconds. */
export const ROLLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Phase 92 Plan 06 — agent identity for the cutover-ready precondition gate.
 *
 * First-pass: hardcoded "fin-client" since v2.5 cutover scope is the
 * single fin-client agent (CUT-09). Future fleet generalization (Phase
 * 93+) should derive this from sync-state.json's bound agent OR from a CLI
 * --agent option. Extracted to a constant so the seam is searchable.
 */
export const CUTOVER_AGENT_NAME = "fin-client";

/**
 * Phase 92 Plan 06 — cutover-ready precondition gate (D-09 + CUT-10).
 *
 * Reads CUTOVER-REPORT.md and refuses to proceed unless:
 *   - The report exists, parses, and is schema-valid
 *   - `cutover_ready: true`
 *   - `report_generated_at` is within REPORT_FRESHNESS_MS (24h)
 *
 * The `--skip-verify --reason "<reason>"` escape hatch bypasses the gate
 * AND appends a `skip-verify` audit row to cutover-ledger.jsonl per D-09.
 * The audit row carries the operator-provided reason for forensic trace.
 *
 * Pure function — no process.exit, no cliError. Returns a discriminated
 * union; the caller is responsible for mapping outcome → exit code +
 * stderr message.
 */
export async function checkCutoverReportPrecondition(args: {
  agent: string;
  reportPath?: string;
  skipVerify?: boolean;
  skipReason?: string;
  now: Date;
  ledgerPath?: string;
  log?: Logger;
}): Promise<SetAuthoritativePreconditionResult> {
  // --skip-verify branch — write audit row + return precondition-skipped-by-flag.
  if (args.skipVerify) {
    const reason = args.skipReason ?? "(no reason provided)";
    const ledgerPath = args.ledgerPath ?? DEFAULT_CUTOVER_LEDGER_PATH;
    try {
      await appendCutoverRow(
        ledgerPath,
        {
          timestamp: args.now.toISOString(),
          agent: args.agent,
          action: "skip-verify",
          kind: "skip-verify",
          identifier: args.agent,
          sourceHash: null,
          targetHash: null,
          reversible: false,
          rolledBack: false,
          preChangeSnapshot: null,
          reason,
        },
        args.log,
      );
    } catch (err) {
      args.log?.warn(
        { err },
        "checkCutoverReportPrecondition: failed to append skip-verify ledger row",
      );
    }
    return { kind: "precondition-skipped-by-flag", reason };
  }

  const reportPath = args.reportPath ?? defaultCutoverReportPath(args.agent);
  const readRes = await readCutoverReport(reportPath);
  if (readRes.kind === "missing") {
    return { kind: "report-missing", reportPath };
  }
  if (readRes.kind === "invalid") {
    return { kind: "report-invalid", reportPath, error: readRes.error };
  }
  const generatedAt = new Date(readRes.frontmatter.report_generated_at);
  const ageMs = args.now.getTime() - generatedAt.getTime();
  if (ageMs > REPORT_FRESHNESS_MS) {
    return { kind: "report-stale", reportPath, ageMs };
  }
  if (!readRes.frontmatter.cutover_ready) {
    return {
      kind: "report-not-ready",
      reportPath,
      reason: `cutover_ready: false (gap_count=${readRes.frontmatter.gap_count}, canary_pass_rate=${readRes.frontmatter.canary_pass_rate})`,
    };
  }
  return { kind: "precondition-passed", reportPath, ageMs };
}

export type RunSyncSetAuthoritativeArgs = Readonly<{
  side: "openclaw" | "clawcode";
  confirmCutover?: boolean;
  revertCutover?: boolean;
  forceRollback?: boolean;
  /** Phase 92 Plan 06 — emergency bypass of the cutover-ready precondition. */
  skipVerify?: boolean;
  /** Phase 92 Plan 06 — operator-provided reason for the skip-verify ledger audit row. */
  skipReason?: string;
  /** Phase 92 Plan 06 — override CUTOVER-REPORT.md path (testing). */
  cutoverReportPath?: string;
  /** Phase 92 Plan 06 — override cutover-ledger.jsonl path (testing). */
  cutoverLedgerPath?: string;
  syncStatePath?: string;
  syncJsonlPath?: string;
  filterFilePath?: string;
  log?: Logger;
  /**
   * DI — override syncOnce for hermetic tests. Given the SyncRunnerDeps
   * struct, returns a canned SyncRunOutcome without spawning rsync.
   */
  runSyncOnceDep?: (deps: SyncRunnerDeps) => Promise<SyncRunOutcome>;
  /** DI — override the interactive y/N prompt for hermetic tests. */
  promptConfirm?: (question: string) => Promise<boolean>;
  /** DI — override the clock for deterministic date-math tests. */
  now?: () => Date;
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

function buildSyncDeps(
  args: RunSyncSetAuthoritativeArgs,
  log: Logger,
): SyncRunnerDeps {
  const fallbackJsonl = join(
    process.env.HOME ?? homedir(),
    ".clawcode",
    "manager",
    "sync.jsonl",
  );
  return {
    syncStatePath: args.syncStatePath ?? DEFAULT_SYNC_STATE_PATH,
    filterFilePath: args.filterFilePath ?? DEFAULT_FILTER_FILE_PATH,
    syncJsonlPath:
      args.syncJsonlPath ?? DEFAULT_SYNC_JSONL_PATH ?? fallbackJsonl,
    log,
  };
}

/**
 * Shared logic: execute a forward-drain cycle, interpret the outcome, and
 * branch on the error cases. Returns `{ok: true}` when the caller should
 * proceed to the confirmation prompt; `{ok: false, exitCode}` on hard
 * failure. Always mentions the drain outcome on stdout for operator audit.
 */
async function driveDrain(
  args: RunSyncSetAuthoritativeArgs,
  log: Logger,
): Promise<{ ok: true; outcome: SyncRunOutcome } | { ok: false; exitCode: number }> {
  const runner = args.runSyncOnceDep ?? syncOnce;
  const syncDeps = buildSyncDeps(args, log);

  let outcome: SyncRunOutcome;
  try {
    outcome = await runner(syncDeps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cliError(`Drain sync failed with exception: ${msg}. Flip aborted.`);
    return { ok: false, exitCode: 1 };
  }

  cliLog(`Drain outcome: ${JSON.stringify(outcome)}`);

  if (outcome.kind === "failed-ssh" || outcome.kind === "failed-rsync") {
    cliError(
      `Drain failed (${outcome.kind}). Flip aborted — resolve the transport issue and retry.`,
    );
    return { ok: false, exitCode: 1 };
  }

  if (outcome.kind === "partial-conflicts") {
    cliError(
      "Drain completed with unresolved conflicts. Run `clawcode sync resolve <path> --side ...` for each and retry.",
    );
    return { ok: false, exitCode: 1 };
  }

  // Acceptable: synced | skipped-no-changes | paused
  return { ok: true, outcome };
}

/**
 * Forward cutover path: openclaw → clawcode. Pauses the timer (by virtue of
 * D-18 — once flipped, syncOnce() returns `paused` without reverseEnabled),
 * drains, prompts, writes.
 */
async function executeForwardCutover(
  args: RunSyncSetAuthoritativeArgs,
  log: Logger,
  state: SyncStateFile,
  now: Date,
): Promise<number> {
  if (state.authoritativeSide === "clawcode") {
    cliError("Already authoritative: clawcode (no action taken)");
    return 1;
  }

  // Phase 96 D-11 — state-machine guard: cannot forward-cutover from
  // deprecated state. Operator must first re-enable-timer (within 7-day
  // window) OR set-authoritative openclaw (Phase 91 revert path) before
  // initiating a fresh forward cutover.
  if (state.authoritativeSide === "deprecated") {
    cliError(
      "Cannot forward-cutover from deprecated state. " +
        "First run `clawcode sync re-enable-timer` (within 7-day window of deprecation) " +
        "or set authoritativeSide back to openclaw via a fresh sync setup.",
    );
    return 1;
  }

  if (!args.confirmCutover) {
    cliError(
      "Flipping TO clawcode is destructive — pass --confirm-cutover to proceed.\n" +
        "This will: (1) drain OpenClaw→ClawCode one final time, (2) prompt y/N, (3) flip the authoritative flag.\n" +
        "The 5-min timer becomes a no-op post-flip (opt into reverse via `clawcode sync start --reverse`).",
    );
    return 1;
  }

  // Phase 92 Plan 06 — cutover-ready precondition gate (D-09 + CUT-10).
  // Runs BEFORE drain. Refuses unless the report exists, is fresh (<24h), and
  // cutover_ready: true. The --skip-verify --reason "..." escape hatch
  // bypasses the gate AND appends a `skip-verify` audit row to cutover-ledger.
  const preconditionRes = await checkCutoverReportPrecondition({
    agent: CUTOVER_AGENT_NAME,
    ...(args.cutoverReportPath !== undefined
      ? { reportPath: args.cutoverReportPath }
      : {}),
    ...(args.skipVerify !== undefined ? { skipVerify: args.skipVerify } : {}),
    ...(args.skipReason !== undefined ? { skipReason: args.skipReason } : {}),
    now,
    ...(args.cutoverLedgerPath !== undefined
      ? { ledgerPath: args.cutoverLedgerPath }
      : {}),
    log,
  });
  if (preconditionRes.kind === "precondition-skipped-by-flag") {
    cliLog(
      `WARNING: --skip-verify used. Audit row appended to cutover-ledger.jsonl. Reason: ${preconditionRes.reason}`,
    );
  } else if (preconditionRes.kind !== "precondition-passed") {
    // EXPLICIT non-passed branch (not bool coercion) — precondition-skipped-by-flag
    // is also non-passed but allowed via the separate branch above.
    let detail: string;
    switch (preconditionRes.kind) {
      case "report-missing":
        detail = `missing CUTOVER-REPORT.md at ${preconditionRes.reportPath} — run \`clawcode cutover verify --agent ${CUTOVER_AGENT_NAME}\` first`;
        break;
      case "report-stale": {
        const hours = Math.floor(preconditionRes.ageMs / (60 * 60 * 1000));
        detail = `CUTOVER-REPORT.md is stale (${hours}h old, max 24h) — re-run \`clawcode cutover verify --agent ${CUTOVER_AGENT_NAME}\``;
        break;
      }
      case "report-not-ready":
        detail = `cutover-not-ready: ${preconditionRes.reason}. Address the gaps and re-run \`clawcode cutover verify\``;
        break;
      case "report-invalid":
        detail = `CUTOVER-REPORT.md at ${preconditionRes.reportPath} failed to parse: ${preconditionRes.error}`;
        break;
    }
    cliError(
      `Cutover precondition failed: ${detail}.\nUse \`--skip-verify --reason "<reason>"\` for emergency override.`,
    );
    return 1;
  }

  cliLog("Draining OpenClaw → ClawCode (final forward sync)...");
  const drain = await driveDrain(args, log);
  if (!drain.ok) return drain.exitCode;

  // D-21 — atomic mid-drain verification is implicit: the drain's syncOnce
  // wrote perFileHashes based on the exact destination snapshot it just
  // received; any OpenClaw-side writes that happened mid-cycle land on the
  // NEXT timer tick (which won't run post-flip). Operators who want absolute
  // quiescence should coordinate with Client A to pause OpenClaw work; this
  // command does the best-effort drain + honest report.
  const prompt = args.promptConfirm ?? defaultPromptConfirm;
  const ok = await prompt(
    `Drain complete. Flip authoritative from 'openclaw' to 'clawcode'? (y/N) `,
  );
  if (!ok) {
    cliLog("Aborted — sync-state.json unchanged. Timer continues in current direction.");
    return 0;
  }

  const nextState: SyncStateFile = {
    ...state,
    authoritativeSide: "clawcode",
    updatedAt: now.toISOString(),
  };
  await writeSyncState(
    args.syncStatePath ?? DEFAULT_SYNC_STATE_PATH,
    nextState,
    log,
  );
  cliLog(
    "Flipped authoritativeSide → clawcode. The 5-min timer is now paused (opt into reverse via `clawcode sync start --reverse`).",
  );
  cliLog(
    `Rollback window open until ${new Date(now.getTime() + ROLLBACK_WINDOW_MS).toISOString()} (7 days). Use \`clawcode sync set-authoritative openclaw --revert-cutover\` to revert.`,
  );
  return 0;
}

/**
 * Reverse path: clawcode → openclaw. Honors D-20's 7-day window gated by
 * --revert-cutover, with --force-rollback as the escape hatch.
 */
async function executeReverseFlip(
  args: RunSyncSetAuthoritativeArgs,
  log: Logger,
  state: SyncStateFile,
  now: Date,
): Promise<number> {
  if (state.authoritativeSide === "openclaw") {
    cliError("Already authoritative: openclaw (no action taken)");
    return 1;
  }

  if (!args.revertCutover && !args.forceRollback) {
    cliError(
      "Flipping back to openclaw requires either --revert-cutover (within 7 days of cutover) " +
        "or --force-rollback (post-7-day emergency rollback).",
    );
    return 1;
  }

  // D-20 — 7-day window check against state.updatedAt. We use updatedAt as
  // the best available proxy for "when was the cutover?" — it's written by
  // executeForwardCutover above.
  if (state.updatedAt) {
    const ageMs = now.getTime() - new Date(state.updatedAt).getTime();
    const withinWindow = ageMs < ROLLBACK_WINDOW_MS;
    if (!withinWindow && !args.forceRollback) {
      const daysAge = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      cliError(
        `Rollback window expired (${daysAge} days since cutover). ` +
          `Pass --force-rollback to override, or run \`clawcode sync finalize\` to close the book.`,
      );
      return 1;
    }
    if (!withinWindow && args.forceRollback) {
      const daysAge = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      cliLog(
        `WARNING: Post-window rollback (${daysAge} days since cutover). Proceeding with --force-rollback.`,
      );
    }
  }

  // Best-effort reverse drain note (D-19). A true reverse rsync would need
  // src/dst swapped in the runner — out of scope for Plan 91-04 (syncOnce
  // is hardcoded forward-direction). We document the expectation so the
  // operator verifies manually or triggers reverse sync BEFORE reverting.
  cliLog(
    "(Reverse drain is a best-effort step. If reverse sync was enabled via `clawcode sync start --reverse`, stop it first. Verify ClawCode→OpenClaw convergence manually via SSH before relying on OpenClaw state.)",
  );

  const prompt = args.promptConfirm ?? defaultPromptConfirm;
  const ok = await prompt(
    `Flip authoritative from 'clawcode' back to 'openclaw'? (y/N) `,
  );
  if (!ok) {
    cliLog("Aborted — sync-state.json unchanged.");
    return 0;
  }

  const nextState: SyncStateFile = {
    ...state,
    authoritativeSide: "openclaw",
    updatedAt: now.toISOString(),
  };
  await writeSyncState(
    args.syncStatePath ?? DEFAULT_SYNC_STATE_PATH,
    nextState,
    log,
  );
  cliLog("Flipped authoritativeSide → openclaw. The 5-min timer resumes forward sync on the next tick.");
  return 0;
}

export async function runSyncSetAuthoritativeAction(
  args: RunSyncSetAuthoritativeArgs,
): Promise<number> {
  const log: Logger =
    args.log ?? (pino({ level: "info" }) as unknown as Logger);
  const statePath = args.syncStatePath ?? DEFAULT_SYNC_STATE_PATH;
  const now = args.now?.() ?? new Date();

  const state = await readSyncState(statePath, log);

  if (args.side === "clawcode") {
    return executeForwardCutover(args, log, state, now);
  }
  if (args.side === "openclaw") {
    return executeReverseFlip(args, log, state, now);
  }

  cliError(`Invalid side: '${args.side}' — must be 'openclaw' or 'clawcode'`);
  return 1;
}

export function registerSyncSetAuthoritativeCommand(parent: Command): void {
  parent
    .command("set-authoritative <side>")
    .description(
      "Flip sync direction (openclaw | clawcode). Gated by --confirm-cutover or --revert-cutover.",
    )
    .option("--confirm-cutover", "Required when flipping TO 'clawcode' (fresh cutover)")
    .option(
      "--revert-cutover",
      "Required when flipping back to 'openclaw' within 7 days",
    )
    .option(
      "--force-rollback",
      "Override 7-day window (post-Day-7 emergency rollback)",
    )
    .option(
      "--skip-verify",
      "Phase 92 Plan 06 emergency bypass of the cutover-ready precondition gate (writes a skip-verify audit row to cutover-ledger.jsonl); requires --reason",
    )
    .option(
      "--reason <reason>",
      "Phase 92 Plan 06 operator-provided reason for --skip-verify; recorded verbatim in the cutover-ledger.jsonl audit row",
    )
    .option(
      "--sync-state-path <path>",
      "Override sync-state.json path (testing)",
    )
    .option(
      "--cutover-report-path <path>",
      "Phase 92 Plan 06 — override CUTOVER-REPORT.md path (testing)",
    )
    .option(
      "--cutover-ledger-path <path>",
      "Phase 92 Plan 06 — override cutover-ledger.jsonl path (testing)",
    )
    .option(
      "--filter-file <path>",
      "Override rsync filter-file path",
      DEFAULT_FILTER_FILE_PATH,
    )
    .action(
      async (
        side: string,
        opts: {
          confirmCutover?: boolean;
          revertCutover?: boolean;
          forceRollback?: boolean;
          skipVerify?: boolean;
          reason?: string;
          syncStatePath?: string;
          cutoverReportPath?: string;
          cutoverLedgerPath?: string;
          filterFile?: string;
        },
      ) => {
        if (side !== "openclaw" && side !== "clawcode") {
          cliError(`side must be 'openclaw' or 'clawcode' (got: ${side})`);
          process.exit(1);
          return;
        }
        if (opts.skipVerify && (opts.reason === undefined || opts.reason.trim().length === 0)) {
          cliError(
            "--skip-verify requires --reason \"<operator-provided reason>\" (recorded in cutover-ledger.jsonl audit row)",
          );
          process.exit(1);
          return;
        }
        const code = await runSyncSetAuthoritativeAction({
          side,
          confirmCutover: opts.confirmCutover,
          revertCutover: opts.revertCutover,
          forceRollback: opts.forceRollback,
          skipVerify: opts.skipVerify,
          skipReason: opts.reason,
          syncStatePath: opts.syncStatePath,
          cutoverReportPath: opts.cutoverReportPath,
          cutoverLedgerPath: opts.cutoverLedgerPath,
          filterFilePath: opts.filterFile,
        });
        process.exit(code);
      },
    );
}
