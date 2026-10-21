/**
 * Phase 999.43 Plan 04 T03 — `clawcode rag` CLI subcommand.
 *
 * Operator-only entry into the priority-override surface (CLI bypasses
 * the agent-side D-08 sandbox — operator can set HIGH from the shell):
 *
 *   clawcode rag set-priority <agent> <source> <level> [--reason <text>]
 *   clawcode rag reclassify   --agent <name>   --rule <pattern=level>
 *
 * Both subcommands delegate to existing IPC methods registered in
 * src/manager/daemon.ts T01:
 *
 *   set-priority   → set-doc-priority   (who="operator" — bypasses sandbox)
 *   reclassify     → reclassify-docs    (who="operator" — bulk glob)
 *
 * Mirrors the `clawcode homelab` precedent (Phase 999.47 Plan 02): zero
 * new IPC methods owned by the CLI layer; this is a thin wrapper around
 * the daemon-owned write surface. Test-injection slots match the
 * homelab pattern for parity.
 */

import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { cliLog, cliError } from "../output.js";

// ────────────────────────────────────────────────────────────────────
// Test-injection slot — mirrors homelab.ts shape.
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

const VALID_LEVELS = ["high", "medium", "low"] as const;

// ────────────────────────────────────────────────────────────────────
// commander registration.
// ────────────────────────────────────────────────────────────────────

export function registerRagCommand(program: Command): void {
  const rag = program
    .command("rag")
    .description(
      "Phase 999.43 — manage RAG document priority + reclassification",
    );

  rag
    .command("set-priority <agent> <source> <level>")
    .description(
      "Set the retrieval priority for a document. Operator-only (CLI bypasses the D-08 agent sandbox — you can set HIGH from here).",
    )
    .option("--reason <text>", "Audit-log rationale")
    .action(
      async (
        agent: string,
        source: string,
        level: string,
        opts: { reason?: string },
      ) => {
        if (!(VALID_LEVELS as readonly string[]).includes(level)) {
          cliError(
            `Invalid level '${level}' — must be one of: ${VALID_LEVELS.join(", ")}`,
          );
          process.exit(1);
        }
        try {
          const result = await ipcSender(SOCKET_PATH, "set-doc-priority", {
            agent,
            source,
            level,
            who: "operator",
            reason: opts.reason,
          });
          cliLog(JSON.stringify(result, null, 2));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          cliError(`set-priority failed: ${msg}`);
          process.exit(1);
        }
      },
    );

  rag
    .command("reclassify")
    .description(
      "Bulk-update document priorities matching a glob-on-source rule (operator-only).",
    )
    .requiredOption("--agent <name>", "Agent whose document store to walk")
    .requiredOption(
      "--rule <pattern=level>",
      "Glob rule of the form '<pattern>=<level>', e.g. 'Screenshot*=low'",
    )
    .action(async (opts: { agent: string; rule: string }) => {
      try {
        const result = await ipcSender(SOCKET_PATH, "reclassify-docs", {
          agent: opts.agent,
          rule: opts.rule,
          who: "operator",
        });
        cliLog(JSON.stringify(result, null, 2));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        cliError(`reclassify failed: ${msg}`);
        process.exit(1);
      }
    });
}
