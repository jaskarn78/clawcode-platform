/**
 * Phase 124 Plan 01 T-04 — `clawcode session compact <agent>` CLI subcommand.
 *
 * Operator surface for the hybrid compaction primitive (memory-extract +
 * SDK forkSession). Calls the daemon's `compact-session` IPC handler and
 * renders the result with exit-code semantics:
 *
 *   0  success
 *   1  AGENT_NOT_RUNNING
 *   2  ERR_TURN_TOO_LONG
 *   3  DAEMON_NOT_READY
 *   4  unknown error (incl. AGENT_NOT_INITIALIZED — added during T-02)
 *
 * `--json` flag prints the raw IPC payload for scripting. Default is a
 * concise human-readable rendering.
 */
import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

/** Success-shape mirror of CompactSessionSuccess (daemon-compact-session-ipc.ts). */
type CompactSuccess = Readonly<{
  ok: true;
  tokens_before: number | null;
  tokens_after: number | null;
  summary_written: boolean;
  // Phase 999.75 Part B — native /compact performs no fork; null on that path.
  forked_to: string | null;
  memories_created: number;
  // Phase 999.75 Part B — Layer 2 live-window-reduction telemetry.
  live_reduced?: boolean;
  skip_reason?: string;
}>;

/** Error-shape mirror of CompactSessionError. */
type CompactError = Readonly<{
  ok: false;
  error:
    | "AGENT_NOT_RUNNING"
    | "ERR_TURN_TOO_LONG"
    | "DAEMON_NOT_READY"
    | "AGENT_NOT_INITIALIZED"
    | "UNKNOWN";
  message?: string;
}>;

type CompactResult = CompactSuccess | CompactError;

/**
 * Map the IPC error code to a process exit code. Per plan T-04 mapping:
 * 1=AGENT_NOT_RUNNING, 2=ERR_TURN_TOO_LONG, 3=DAEMON_NOT_READY, 4=unknown.
 * AGENT_NOT_INITIALIZED was added during T-02 (Rule 3); folded into 4.
 */
function exitCodeForError(code: CompactError["error"]): number {
  switch (code) {
    case "AGENT_NOT_RUNNING":
      return 1;
    case "ERR_TURN_TOO_LONG":
      return 2;
    case "DAEMON_NOT_READY":
      return 3;
    case "AGENT_NOT_INITIALIZED":
    case "UNKNOWN":
      return 4;
  }
}

function renderHuman(result: CompactSuccess, agent: string): void {
  cliLog(`Compaction complete for ${agent}:`);
  const tb = result.tokens_before === null ? "n/a" : result.tokens_before.toString();
  const ta = result.tokens_after === null ? "n/a" : result.tokens_after.toString();
  // Phase 999.75 Part B — tokens are now the real SDK context-window count.
  cliLog(`  tokens: ${tb} → ${ta}`);
  cliLog(`  summary written: ${result.summary_written}`);
  cliLog(`  memories extracted: ${result.memories_created}`);
  // Phase 999.75 Part B — Layer 2: did native /compact shrink the live window?
  if (result.live_reduced === true) {
    cliLog(`  live window reduced: yes (native /compact)`);
  } else {
    const reason =
      result.skip_reason !== undefined ? ` (${result.skip_reason})` : "";
    cliLog(`  live window reduced: no${reason}`);
    cliLog(
      `  note: Layer 1 still ran — memory.db + daily log updated; no data lost.`,
    );
  }
}

export function registerSessionCompactCommand(program: Command): void {
  const session = program
    .command("session")
    .description("Session-level operator commands (compact, etc.)");

  session
    .command("compact <agent>")
    .description(
      "Compact an agent's session: extract facts into memory.db + fork session JSONL.",
    )
    .option("--json", "Print raw IPC payload as JSON")
    .action(async (agent: string, opts: { json?: boolean }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "compact-session", {
          agent,
        })) as CompactResult;

        if (!result.ok) {
          if (opts.json) {
            cliLog(JSON.stringify(result));
          } else {
            const detail = result.message ? ` — ${result.message}` : "";
            cliError(`Error: ${result.error}${detail}`);
          }
          process.exit(exitCodeForError(result.error));
          return;
        }

        if (opts.json) {
          cliLog(JSON.stringify(result));
        } else {
          renderHuman(result, agent);
        }
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError("Manager is not running. Start it with: clawcode start-all");
          process.exit(3);
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(4);
      }
    });
}
