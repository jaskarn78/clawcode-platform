import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliError, cliLog } from "../output.js";

/** Pasted codes are ~100–200 chars; anything far larger is not a code. */
const MAX_STDIN_BYTES = 4096;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write("Paste the code, then press Enter and Ctrl-D:\n");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_STDIN_BYTES) throw new Error("input too large to be an authorization code");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

function fail(error: unknown): never {
  if (error instanceof ManagerNotRunningError) {
    cliError("Manager is not running.");
  } else {
    cliError(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}

/**
 * Phase 999.176 — `clawcode account`. Operator status plus the one verb the
 * Mac-capable admin agent uses: hand a pasted OAuth code to the daemon's
 * pending login. The code is read from STDIN only — never argv, which is
 * visible to every process on the host via /proc.
 */
export function registerAccountCommand(program: Command): void {
  const account = program
    .command("account")
    .description("Fleet Claude subscription account (swap via /clawcode-account in Discord)");

  account
    .command("status")
    .description("Show the live account and saved slots (no token values)")
    .action(async () => {
      try {
        const r = await sendIpcRequest(SOCKET_PATH, "account-status", {});
        cliLog(JSON.stringify(r, null, 2));
      } catch (error) {
        fail(error);
      }
    });

  account
    .command("submit-code [sessionId]")
    .description("Submit the sign-in page's code (read from stdin) to the pending login")
    .action(async (sessionId: string | undefined) => {
      try {
        const code = await readStdin();
        if (code.length === 0) throw new Error("no code on stdin");
        const r = (await sendIpcRequest(SOCKET_PATH, "account-login-submit", {
          ...(sessionId ? { sessionId } : {}),
          code,
        })) as { accepted: boolean; status?: string; detail?: string; error?: string; email?: string };
        if (!r.accepted) {
          cliError(`Not accepted: ${r.error ?? "unknown"}`);
          process.exit(2);
        }
        if (r.status === "succeeded") {
          cliLog(`Login succeeded for ${r.email ?? "the target account"} — the operator confirms the switch in Discord.`);
          return;
        }
        cliError(`Login ${r.status ?? "failed"}: ${r.detail ?? ""}`);
        process.exit(3);
      } catch (error) {
        fail(error);
      }
    });
}
