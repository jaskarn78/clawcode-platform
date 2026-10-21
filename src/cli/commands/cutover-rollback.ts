/**
 * Phase 92 Plan 06 — `clawcode cutover rollback` subcommand (CUT-10 + D-10).
 *
 * Phase 92 GAP CLOSURE — replaces the prior daemon-IPC scaffold (which
 * returned exit 1) with a fully-wired IPC client. The daemon's
 * `cutover-rollback` handler reads `cutover-ledger.jsonl`, filters rows
 * newer than `--ledger-to`, and reverses each in LIFO order:
 *
 *   - apply-additive missing-skill        → remove from skills[] + delete dir
 *   - apply-additive missing-memory-file  → unlink target file
 *   - apply-additive missing-upload       → unlink target file
 *   - apply-additive model-not-in-allowlist → remove from allowedModels[]
 *   - apply-destructive outdated-memory-file (with preChangeSnapshot, < 64KB)
 *                                         → restore pre-change content from
 *                                           gzip+base64 snapshot
 *   - apply-destructive mcp-credential-drift / tool-permission-gap /
 *     cron-session-not-mirrored (audit-only) → emit rolled-back audit row
 *
 * Idempotency mechanism (D-10):
 *   The ledger is APPEND-ONLY — rollback never mutates existing rows. A NEW
 *   row with `action: "rollback"` AND `reason: "rollback-of:<origTimestamp>"`
 *   is appended for each successful revert. Re-running rollback over already-
 *   rewound rows yields zero new reverts.
 *
 * The marker literal `"rollback-of:"` is pinned by static-grep in source so
 * reviewers can grep for it without diving into runtime traces.
 */

import type { Command } from "commander";
import pino, { type Logger } from "pino";

import { cliError, cliLog } from "../output.js";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { DEFAULT_CUTOVER_LEDGER_PATH } from "../../cutover/ledger.js";
import {
  IpcError,
  ManagerNotRunningError,
} from "../../shared/errors.js";

/**
 * Idempotency reason marker — every rollback row's `reason` field begins
 * with this literal string followed by the original row's timestamp.
 * Pinned by static-grep so the convention can't drift silently.
 */
export const ROLLBACK_OF_REASON_PREFIX = "rollback-of:";

/**
 * Shape of one error entry returned by the daemon when a single row fails
 * to reverse. The rollback continues to the next row regardless — partial
 * rewinds are operator-recoverable, but the CLI exits 1 so the operator
 * knows the cutover state isn't fully reverted.
 */
export type CutoverRollbackError = {
  readonly row: number;
  readonly error: string;
};

export type CutoverRollbackIpcResponse = {
  readonly rewoundCount: number;
  readonly errors: readonly CutoverRollbackError[];
};

export type RunCutoverRollbackArgs = Readonly<{
  agent: string;
  ledgerTo: string;
  ledgerPath?: string;
  dryRun?: boolean;
  log?: Logger;
  /** DI hook — override IPC sender for hermetic tests. */
  sendIpc?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}>;

export async function runCutoverRollbackAction(
  args: RunCutoverRollbackArgs,
): Promise<number> {
  const log = args.log ?? (pino({ level: "info" }) as unknown as Logger);
  const ledgerPath = args.ledgerPath ?? DEFAULT_CUTOVER_LEDGER_PATH;

  const sender =
    args.sendIpc ??
    ((method: string, params: Record<string, unknown>) =>
      sendIpcRequest(SOCKET_PATH, method, params));

  const params: Record<string, unknown> = {
    agent: args.agent,
    ledgerTo: args.ledgerTo,
    ledgerPath,
    dryRun: args.dryRun ?? false,
  };

  let response: CutoverRollbackIpcResponse;
  try {
    const raw = await sender("cutover-rollback", params);
    response = raw as CutoverRollbackIpcResponse;
  } catch (err) {
    if (err instanceof ManagerNotRunningError) {
      cliError(
        "cutover rollback: clawcode daemon is not running. Start it with `clawcode start-all`.",
      );
      return 1;
    }
    if (err instanceof IpcError) {
      cliError(`cutover rollback: daemon-IPC error: ${err.message}`);
      return 1;
    }
    cliError(
      `cutover rollback: unexpected error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }

  // Operator-facing summary on stdout. The rewoundCount + per-row errors are
  // both surfaced so the operator can pipe to jq / grep / open the ledger
  // directly without a second round-trip.
  cliLog(
    JSON.stringify(
      {
        agent: args.agent,
        ledgerTo: args.ledgerTo,
        ledgerPath,
        dryRun: params.dryRun,
        rewoundCount: response.rewoundCount,
        errors: response.errors,
      },
      null,
      2,
    ),
  );

  if (response.errors.length > 0) {
    log.warn(
      {
        agent: args.agent,
        rewoundCount: response.rewoundCount,
        errorCount: response.errors.length,
      },
      "cutover rollback: completed with errors — partial rewind",
    );
    return 1;
  }

  log.info(
    { agent: args.agent, rewoundCount: response.rewoundCount },
    "cutover rollback: completed",
  );
  return 0;
}

export function registerCutoverRollbackCommand(parent: Command): void {
  parent
    .command("rollback")
    .description(
      "Rewind cutover-ledger.jsonl rows newer than --ledger-to in LIFO order via daemon IPC. Idempotent via rollback-of:<ts> reason markers; re-running yields zero new reverts.",
    )
    .requiredOption("--agent <name>", "Agent whose cutover rows to rewind")
    .requiredOption(
      "--ledger-to <iso-timestamp>",
      "Rewind all rows newer than this ISO 8601 timestamp (LIFO order)",
    )
    .option(
      "--ledger-path <path>",
      `Override cutover-ledger.jsonl path (default: ${DEFAULT_CUTOVER_LEDGER_PATH})`,
    )
    .option(
      "--dry-run",
      "Compute the rewind plan without mutating filesystem / YAML / ledger (no rollback rows appended)",
    )
    .action(
      async (opts: {
        agent: string;
        ledgerTo: string;
        ledgerPath?: string;
        dryRun?: boolean;
      }) => {
        const code = await runCutoverRollbackAction({
          agent: opts.agent,
          ledgerTo: opts.ledgerTo,
          ...(opts.ledgerPath !== undefined
            ? { ledgerPath: opts.ledgerPath }
            : {}),
          ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
        });
        process.exit(code);
      },
    );
}
