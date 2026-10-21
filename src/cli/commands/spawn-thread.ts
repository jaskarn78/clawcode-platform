import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

/**
 * Shape of the spawn-subagent-thread IPC response.
 */
type SpawnResult = {
  readonly threadId: string;
  readonly sessionName: string;
  readonly parentAgent: string;
  readonly channelId: string;
};

/**
 * Format a spawn result into a human-readable output string.
 *
 * @param result - The IPC response from spawn-subagent-thread
 * @returns Formatted multi-line string with thread URL, session, parent, and channel
 */
export function formatSpawnResult(result: SpawnResult): string {
  const lines = [
    `Thread URL: https://discord.com/channels/@me/${result.threadId}`,
    `Thread ID: ${result.threadId}`,
    `Session: ${result.sessionName}`,
    `Parent Agent: ${result.parentAgent}`,
    `Channel: ${result.channelId}`,
  ];
  return lines.join("\n");
}

/**
 * Register the `clawcode spawn-thread` command.
 * Spawns a subagent in a new Discord thread via the daemon IPC.
 */
export function registerSpawnThreadCommand(program: Command): void {
  program
    .command("spawn-thread")
    .description("Spawn a subagent in a new Discord thread")
    .requiredOption("-a, --agent <name>", "Parent agent name")
    .requiredOption("-n, --name <threadName>", "Name for the Discord thread")
    .option("-m, --model <model>", "Model for the subagent (sonnet|opus|haiku|fable)")
    .option("-p, --prompt <text>", "Custom system prompt for the subagent")
    .action(async (opts: { agent: string; name: string; model?: string; prompt?: string }) => {
      try {
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "spawn-subagent-thread",
          {
            parentAgent: opts.agent,
            threadName: opts.name,
            model: opts.model,
            systemPrompt: opts.prompt,
          },
        )) as SpawnResult;
        cliLog(formatSpawnResult(result));
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError(
            "Manager is not running. Start it with: clawcode start-all",
          );
          process.exit(1);
          return;
        }
        const message =
          error instanceof Error ? error.message : String(error);
        cliError(`Error: ${message}`);
        process.exit(1);
      }
    });
}
