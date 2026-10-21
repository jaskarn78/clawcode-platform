import type { Command } from "commander";
import { startDashboardServer } from "../../dashboard/server.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { cliLog, cliError } from "../output.js";

/**
 * Register the `clawcode dashboard` command.
 * Starts the web dashboard server on the specified port.
 */
export function registerDashboardCommand(program: Command): void {
  program
    .command("dashboard")
    .description("Start the web dashboard")
    .option("-p, --port <number>", "Dashboard port", "3200")
    .action(async (opts: { port: string }) => {
      try {
        const port = Number(opts.port);
        if (!Number.isFinite(port) || port < 1 || port > 65535) {
          cliError(`Error: Invalid port number: ${opts.port}`);
          process.exit(1);
          return;
        }

        await startDashboardServer({ port, socketPath: SOCKET_PATH });
        cliLog(`Dashboard running at http://localhost:${port}`);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        cliError(`Error: ${message}`);
        process.exit(1);
      }
    });
}
