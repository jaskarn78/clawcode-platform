/**
 * Phase 95 Plan 03 DREAM-07 — `clawcode dream <agent>` CLI subcommand.
 *
 * Operator-driven manual dream-pass trigger backed by the daemon's
 * `run-dream-pass` IPC method (Plan 95-03 daemon edge). Reuses the
 * Phase 91-04 sync-run-once pattern: an exported pure async action returns
 * the process exit code, so tests can assert without spawning subprocesses.
 *
 * Exit codes (operator-script contract):
 *   0 — outcome.kind = 'completed' AND applied.kind != 'failed'
 *   1 — outcome.kind = 'failed' OR applied.kind = 'failed' OR IPC error
 *   2 — outcome.kind = 'skipped' (informational; not a hard failure;
 *       operator can re-invoke with --force / --idle-bypass)
 *
 * stdout: pretty-printed JSON of the full RunDreamPassResponse so operator
 *   scripts can pipe into jq for log path / counts / cost extraction.
 * stderr: human-readable error / skip reason (one line).
 */

import type { Command } from "commander";
import { Option } from "commander";
import pino, { type Logger } from "pino";

import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError, IpcError } from "../../shared/errors.js";

/**
 * Phase 95 Plan 03 — IPC response shape mirrored from
 * src/manager/daemon.ts RunDreamPassResponse. Re-declared here so the CLI
 * surface doesn't pull in the daemon's internal types (avoids a heavy
 * import graph for the thin RPC wrapper).
 */
export type RunDreamPassIpcResponse = {
  readonly agent: string;
  readonly startedAt: string;
  readonly outcome:
    | {
        readonly kind: "completed";
        readonly result: {
          readonly newWikilinks: ReadonlyArray<unknown>;
          readonly promotionCandidates: ReadonlyArray<unknown>;
          readonly themedReflection: string;
          readonly suggestedConsolidations: ReadonlyArray<unknown>;
        };
        readonly durationMs: number;
        readonly tokensIn: number;
        readonly tokensOut: number;
        readonly model: string;
      }
    | {
        readonly kind: "skipped";
        readonly reason: "agent-active" | "disabled";
      }
    | { readonly kind: "failed"; readonly error: string };
  readonly applied:
    | {
        readonly kind: "applied";
        readonly appliedWikilinkCount: number;
        readonly surfacedPromotionCount: number;
        readonly surfacedConsolidationCount: number;
        readonly logPath: string;
      }
    | {
        readonly kind: "skipped";
        readonly reason: "no-completed-result";
      }
    | { readonly kind: "failed"; readonly error: string };
};

export type RunDreamActionArgs = Readonly<{
  agent: string;
  force?: boolean;
  idleBypass?: boolean;
  model?: "haiku" | "sonnet" | "opus";
  /**
   * Phase 115 Plan 05 T03 — D-05 priority dream-pass override. When true,
   * the daemon bypasses the truncation-event counter gate and treats
   * the run as a priority pass (D-10 Row 5 — mutating promotion allowed,
   * priorityScore floor overridden). Surfaces as `--priority` on the CLI.
   *
   * For operator-driven testing + emergency override only; the production
   * trigger is the cron's tier-1 truncation counter consult.
   */
  priority?: boolean;
  log?: Logger;
  /**
   * DI hook for hermetic tests. Production callers omit this and the action
   * wires `sendIpcRequest` against the canonical daemon socket.
   */
  sendIpc?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}>;

/**
 * Run one dream pass via the daemon `run-dream-pass` IPC method.
 *
 * Returns the process exit code so tests can assert without spawning
 * subprocesses (mirrors runSyncRunOnceAction / runCutoverVerifyAction).
 */
export async function runDreamAction(
  args: RunDreamActionArgs,
): Promise<number> {
  const log =
    args.log ?? (pino({ level: "info" }) as unknown as Logger);

  const sender =
    args.sendIpc ??
    ((method: string, params: Record<string, unknown>) =>
      sendIpcRequest(SOCKET_PATH, method, params));

  const params: Record<string, unknown> = {
    agent: args.agent,
    force: args.force === true,
    idleBypass: args.idleBypass === true,
    modelOverride: args.model,
    // Phase 115 Plan 05 T03 — D-05 priority pass override. Daemon-side
    // run-dream-pass handler treats this as the priority signal threading
    // through D-10 Row 5 in dream-auto-apply.
    priority: args.priority === true,
  };

  let response: RunDreamPassIpcResponse;
  try {
    const raw = await sender("run-dream-pass", params);
    response = raw as RunDreamPassIpcResponse;
  } catch (err) {
    if (err instanceof ManagerNotRunningError) {
      process.stderr.write(
        "dream pass: clawcode daemon is not running. Start it with `clawcode start-all`.\n",
      );
      return 1;
    }
    if (err instanceof IpcError) {
      process.stderr.write(`dream pass: daemon-IPC error: ${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`dream pass: unexpected error: ${msg}\n`);
    return 1;
  }

  // Pretty-printed JSON on stdout — pipe-friendly for operator scripts
  // (jq .applied.logPath / jq .outcome.result.themedReflection / etc.).
  process.stdout.write(JSON.stringify(response, null, 2) + "\n");

  // Exit-code contract — see file header.
  if (response.outcome.kind === "failed") {
    process.stderr.write(
      `dream pass failed: ${response.outcome.error}\n`,
    );
    return 1;
  }
  if (response.applied.kind === "failed") {
    process.stderr.write(
      `dream pass applied-failed: ${response.applied.error}\n`,
    );
    return 1;
  }
  if (response.outcome.kind === "skipped") {
    process.stderr.write(
      `dream pass skipped: ${response.outcome.reason}\n`,
    );
    return 2;
  }

  // Best-effort log line at info level — operator visibility into the
  // run that just shipped without spamming stdout.
  log.info(
    {
      agent: response.agent,
      tokensIn: response.outcome.kind === "completed" ? response.outcome.tokensIn : 0,
      tokensOut: response.outcome.kind === "completed" ? response.outcome.tokensOut : 0,
      durationMs: response.outcome.kind === "completed" ? response.outcome.durationMs : 0,
    },
    "dream pass completed",
  );
  return 0;
}

/**
 * Register the `clawcode dream <agent>` subcommand.
 *
 * Validation:
 *   - <agent> required (commander emits usage error if omitted)
 *   - --model is choice-restricted to haiku|sonnet|opus via Option.choices
 */
export function registerDreamCommand(parent: Command): void {
  parent
    .command("dream <agent>")
    .description(
      "Trigger a dream pass for the named agent (operator-driven manual reflection)",
    )
    .option(
      "--force",
      "Override dream.enabled=false config (manual operator trigger)",
    )
    .option(
      "--idle-bypass",
      "Skip the isAgentIdle gate (fire even if agent is active)",
    )
    .option(
      "--priority",
      "Phase 115 D-05 — force-priority pass: mutating promotion allowed, " +
        "priorityScore floor overridden (D-10 Row 5). For operator testing " +
        "+ emergency override; the cron's truncation-event counter is the " +
        "production trigger.",
    )
    .addOption(
      new Option(
        "--model <model>",
        "Override dream.model for this run only",
      ).choices(["haiku", "sonnet", "opus"]),
    )
    .action(
      async (
        agent: string,
        opts: {
          force?: boolean;
          idleBypass?: boolean;
          priority?: boolean;
          model?: "haiku" | "sonnet" | "opus";
        },
      ) => {
        const code = await runDreamAction({
          agent,
          force: opts.force,
          idleBypass: opts.idleBypass,
          priority: opts.priority,
          model: opts.model,
        });
        process.exit(code);
      },
    );
}
