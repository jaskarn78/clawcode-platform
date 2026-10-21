import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

/**
 * Shape of the "send-message" IPC response.
 */
type SendResponse = {
  readonly ok: boolean;
  readonly messageId: string;
};

/**
 * Register the `clawcode send` command.
 * Sends a message to an agent via the IPC "send-message" method.
 */
export function registerSendCommand(program: Command): void {
  program
    .command("send <agent> <message>")
    .description("Send a message to an agent")
    .option("--from <name>", "Sender name", "cli")
    .option("--priority <level>", "Message priority (normal|high|urgent)", "normal")
    .action(async (agent: string, message: string, opts: { from: string; priority: string }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "send-message", {
          from: opts.from,
          to: agent,
          content: message,
          priority: opts.priority,
        })) as SendResponse;
        cliLog(`Message sent to ${agent} (id: ${result.messageId})`);
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError("Manager is not running. Start it with: clawcode start-all");
          process.exit(1);
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });
}
