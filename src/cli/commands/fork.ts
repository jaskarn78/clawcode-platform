import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

/**
 * Shape of the "fork-session" IPC response.
 */
type ForkResponse = {
  readonly ok: boolean;
  readonly forkName: string;
  readonly parentAgent: string;
  readonly sessionId: string;
};

/**
 * Register the `clawcode fork` command.
 * Forks an agent's session into a new independent session.
 */
export function registerForkCommand(program: Command): void {
  program
    .command("fork <agent>")
    .description("Fork an agent session into a new independent session")
    .option("--model <model>", "Override model for the fork (sonnet|opus|haiku|fable)")
    .option("--prompt <text>", "Override system prompt for the fork")
    .action(async (agent: string, opts: { model?: string; prompt?: string }) => {
      try {
        const params: Record<string, unknown> = { name: agent };
        if (opts.model) {
          params.model = opts.model;
        }
        if (opts.prompt) {
          params.systemPrompt = opts.prompt;
        }
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "fork-session",
          params,
        )) as ForkResponse;
        cliLog(`Forked ${result.parentAgent} -> ${result.forkName}`);
        cliLog(`Session ID: ${result.sessionId}`);
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
