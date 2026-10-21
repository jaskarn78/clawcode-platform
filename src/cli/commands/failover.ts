/**
 * Phase 138 Plan 05 T-06 — `clawcode failover` CLI subcommand.
 *
 * Operator surface over the runtime-state failover override:
 *
 *   clawcode failover status [<agent>]      — list active overrides
 *   clawcode failover reset  <agent>        — clear one agent's override
 *   clawcode failover set    <agent> <backend>  — force a manual override
 *
 * All three delegate to daemon IPC methods (`failover-{status,reset,set}`)
 * registered in `src/ipc/protocol.ts` + dispatched in `daemon.ts`
 * routeMethod. The daemon operates on the live `FailoverStateStore` —
 * the CLI owns no SQLite handle.
 *
 * **Admin gate.** `reset` / `set` are admin-only by the SAME mechanism
 * as `clawcode stop` / `clawcode restart`: the daemon's IPC socket is
 * owner-only (chmod 0700 dir) — reaching the daemon means shell access
 * on the daemon host. No extra per-request gate is added (mirrors the
 * `stop` precedent — HARD CONSTRAINT #5).
 *
 * Mirrors the `clawcode rag` precedent (Phase 999.43 Plan 04): a thin
 * IPC wrapper with a test-injection slot for the sender.
 *
 * See:
 *   - `src/cli/commands/rag.ts` — the subcommand-shape template
 *   - `src/cli/commands/stop.ts` — the IPC + admin-gate precedent
 */

import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { cliLog, cliError } from "../output.js";

// ────────────────────────────────────────────────────────────────────
// Test-injection slot — mirrors rag.ts / homelab.ts shape.
// ────────────────────────────────────────────────────────────────────

type IpcSender = (
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

let ipcSender: IpcSender = sendIpcRequest;

/** Test-only: replace the IPC sender. Restore in afterEach. */
export function __setIpcSenderForTests(impl: IpcSender | null): void {
  ipcSender = impl ?? sendIpcRequest;
}

/** Backend IDs accepted by `failover set`. Mirrors llmRuntimeBackendSchema. */
const VALID_BACKENDS = ["anthropic-agent-sdk", "codex-cli"] as const;

/** One failover-state row as returned by `failover-status`. */
interface FailoverRowDto {
  agent: string;
  active_backend: string;
  reason: string;
  triggered_at: number;
  expires_at: number | null;
}

/** Render a millis instant as a readable UTC string (or "—" for null). */
function fmtTime(millis: number | null): string {
  return millis === null ? "—" : new Date(millis).toISOString();
}

// ────────────────────────────────────────────────────────────────────
// commander registration.
// ────────────────────────────────────────────────────────────────────

export function registerFailoverCommand(program: Command): void {
  const failover = program
    .command("failover")
    .description(
      "Phase 138 — inspect + manage cross-provider runtime failover overrides",
    );

  // --- status -------------------------------------------------------
  failover
    .command("status [agent]")
    .description(
      "List active failover overrides (all agents, or one if <agent> given)",
    )
    .option("--json", "Emit raw JSON instead of a table")
    .action(async (agent: string | undefined, opts: { json?: boolean }) => {
      try {
        const result = (await ipcSender(SOCKET_PATH, "failover-status", {
          ...(agent ? { agent } : {}),
        })) as { rows: FailoverRowDto[] };
        const rows = result.rows ?? [];
        if (opts.json) {
          cliLog(JSON.stringify(result, null, 2));
          return;
        }
        if (rows.length === 0) {
          cliLog("No active failover overrides.");
          return;
        }
        cliLog("Active failover overrides:");
        for (const r of rows) {
          cliLog(
            `  ${r.agent} → ${r.active_backend} ` +
              `(${r.reason}; triggered ${fmtTime(r.triggered_at)}; ` +
              `expires ${fmtTime(r.expires_at)})`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        cliError(`failover status failed: ${msg}`);
        process.exit(1);
      }
    });

  // --- reset --------------------------------------------------------
  failover
    .command("reset <agent>")
    .description("Clear an agent's failover override (revert to configured backend)")
    .action(async (agent: string) => {
      try {
        const result = await ipcSender(SOCKET_PATH, "failover-reset", {
          agent,
        });
        cliLog(JSON.stringify(result, null, 2));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        cliError(`failover reset failed: ${msg}`);
        process.exit(1);
      }
    });

  // --- set ----------------------------------------------------------
  failover
    .command("set <agent> <backend>")
    .description(
      "Force a manual failover override (admin escape hatch — persists until reset). " +
        `Backend must be one of: ${VALID_BACKENDS.join(", ")}.`,
    )
    .action(async (agent: string, backend: string) => {
      // Reject invalid backends at CLI parse time — `portable-fork` and
      // any bogus value never reach the daemon.
      if (!(VALID_BACKENDS as readonly string[]).includes(backend)) {
        cliError(
          `Invalid backend '${backend}' — must be one of: ${VALID_BACKENDS.join(", ")}`,
        );
        process.exit(1);
      }
      try {
        const result = await ipcSender(SOCKET_PATH, "failover-set", {
          agent,
          backend,
        });
        cliLog(JSON.stringify(result, null, 2));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        cliError(`failover set failed: ${msg}`);
        process.exit(1);
      }
    });
}
