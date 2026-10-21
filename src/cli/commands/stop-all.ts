import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

/**
 * Register the `clawcode stop-all` command.
 * Stops every active agent session without shutting down the daemon.
 */
export function registerStopAllCommand(program: Command): void {
  program
    .command("stop-all")
    .description("Stop all running agents (daemon stays up)")
    .action(async () => {
      try {
        await sendIpcRequest(SOCKET_PATH, "stop-all", {});
        cliLog("All agents stopped.");
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError(
            "Manager is not running. Nothing to stop.",
          );
          process.exit(1);
        }
        const message =
          error instanceof Error ? error.message : String(error);
        cliError(`Error: ${message}`);
        process.exit(1);
      }
    });
}
