/**
 * 999.147 — `clawcode mem relieve --pid <N>`.
 *
 * The text equivalent of the 🩹 button on a MemoryGuard imminence page. It
 * exists because `deliverAdminAlert` falls back webhook → bot-direct → pino
 * and only the webhook leg can carry components: on a fallback the button is
 * simply not there. Every page names this command inline, so the operator is
 * never handed a warning they cannot act on.
 *
 * Deliberately routed through the daemon rather than killing from this
 * process. The guards that make a relief kill safe — pid-reuse via
 * `starttime`, cgroup membership, never-the-daemon — have to be the same code
 * on both surfaces, and one of them cannot work here at all: a CLI-side
 * membership check would resolve THIS process's cgroup (a user session scope),
 * not the fleet's, and would fail closed on every pid. The audit trail stays
 * single-writer for the same reason.
 */

import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

interface ReliefReply {
  readonly ok?: boolean;
  readonly message?: string;
}

export function registerMemCommand(program: Command): void {
  const mem = program
    .command("mem")
    .description("Fleet memory pressure — inspect and relieve");

  mem
    .command("relieve")
    .description(
      "Kill the named memory offender (the action behind the 🩹 button on a MemoryGuard page)",
    )
    .requiredOption("--pid <pid>", "PID to kill, as named in the alert")
    .option(
      "--start-ticks <ticks>",
      "Expected /proc/<pid>/stat starttime. Optional interactively; pass it in scripts so a recycled pid is refused rather than killed",
    )
    .action(async (opts: { pid: string; startTicks?: string }) => {
      const pid = Number(opts.pid);
      if (!Number.isInteger(pid) || pid <= 1) {
        cliError(`Invalid --pid: ${opts.pid}`);
        process.exitCode = 1;
        return;
      }
      const startTicks =
        opts.startTicks === undefined ? undefined : Number(opts.startTicks);
      if (startTicks !== undefined && !Number.isInteger(startTicks)) {
        cliError(`Invalid --start-ticks: ${opts.startTicks}`);
        process.exitCode = 1;
        return;
      }

      try {
        const reply = (await sendIpcRequest(
          SOCKET_PATH,
          "memory-relieve",
          {
            pid,
            ...(startTicks !== undefined ? { startTicks } : {}),
            actor: process.env.SUDO_USER ?? process.env.USER ?? "unknown",
          },
        )) as ReliefReply;
        cliLog(reply?.message ?? "(no response)");
        // A refusal is not a crash, but it IS a non-zero outcome: a script
        // that pipes this must be able to tell "killed" from "refused".
        if (reply?.ok !== true) process.exitCode = 1;
      } catch (err) {
        if (err instanceof ManagerNotRunningError) {
          cliError("ClawCode daemon is not running.");
        } else {
          cliError(
            `Relief failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        process.exitCode = 1;
      }
    });
}
