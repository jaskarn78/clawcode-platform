import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import {
  ManagerNotRunningError,
  IpcError,
  SessionError,
} from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";
import { resolveConfigPath } from "../../config/resolve-path.js";

/**
 * Register the `clawcode restart <name>` command.
 * Sends a "restart" IPC request to the running daemon.
 */
export function registerRestartCommand(program: Command): void {
  program
    .command("restart <name>")
    .description("Restart an individual agent by name")
    .option("-c, --config <path>", "Path to config file", "clawcode.yaml")
    .action(async (name: string, opts: { config: string }) => {
      const configPath = resolveConfigPath(opts.config);
      try {
        await sendIpcRequest(SOCKET_PATH, "restart", {
          name,
          config: configPath,
        });
        cliLog(`Agent '${name}' restarted`);
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
