import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import {
  ManagerNotRunningError,
  IpcError,
  SessionError,
} from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

/**
 * Register the `clawcode stop <name>` command.
 * Sends a "stop" IPC request to the running daemon.
 */
export function registerStopCommand(program: Command): void {
  program
    .command("stop <name>")
    .description("Stop an individual agent by name")
    .action(async (name: string) => {
      try {
        await sendIpcRequest(SOCKET_PATH, "stop", { name });
        cliLog(`Agent '${name}' stopped`);
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError(
            "Manager is not running. Start it with: clawcode start-all",
          );
          process.exit(1);
        }
        if (error instanceof IpcError || error instanceof SessionError) {
          cliError(`Error: ${error.message}`);
          process.exit(1);
        }
        const message =
          error instanceof Error ? error.message : String(error);
        cliError(`Error: ${message}`);
        process.exit(1);
      }
    });
}
