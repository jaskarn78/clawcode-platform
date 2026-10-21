import type { Command } from "commander";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { sendIpcRequest } from "../../ipc/client.js";
import { startDaemon, SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { formatStatusTable } from "./status.js";
import type { RegistryEntry } from "../../manager/types.js";
import { cliLog, cliError } from "../output.js";
import { resolveConfigPath } from "../../config/resolve-path.js";
// Phase 999.87 — single source of truth for child-spawn env credential
// handling.
import { buildAnthropicSafeEnv } from "../../manager/spawn-env.js";

/**
 * Check if the daemon is already running by sending a status request.
 * Returns the status entries if running, null if not.
 */
async function checkDaemonRunning(): Promise<readonly RegistryEntry[] | null> {
  try {
    const result = (await sendIpcRequest(SOCKET_PATH, "status", {})) as {
      entries: readonly RegistryEntry[];
    };
    return result.entries;
  } catch (error) {
    if (error instanceof ManagerNotRunningError) {
      return null;
    }
    return null;
  }
}

/**
 * Wait for the daemon to become responsive, retrying a few times.
 */
async function waitForDaemon(
  maxAttempts: number = 5,
  delayMs: number = 500,
): Promise<readonly RegistryEntry[] | null> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const entries = await checkDaemonRunning();
    if (entries !== null) {
      return entries;
    }
  }
  return null;
}

/**
 * Register the `clawcode start-all` command.
 * Starts the manager daemon and boots all configured agents.
 */
export function registerStartAllCommand(program: Command): void {
  program
    .command("start-all")
    .description("Start the manager daemon and boot all configured agents")
    .option("-c, --config <path>", "Path to config file", "clawcode.yaml")
    .option("--foreground", "Run daemon in foreground (for development)", false)
    .action(async (opts: { config: string; foreground: boolean }) => {
      const configPath = resolveConfigPath(opts.config);
      try {
        if (opts.foreground) {
          cliLog(
            "Manager running in foreground. Press Ctrl+C to stop.",
          );
          await startDaemon(configPath);
          // startDaemon returns when server is created; block forever
          await new Promise(() => {});
        } else {
          // Check if already running
          const existing = await checkDaemonRunning();
          if (existing !== null) {
            cliLog("Manager is already running");
            return;
          }

          // Spawn daemon as detached child process.
          // Use cwd-relative path since the bundled CLI's import.meta.dirname
          // resolves to dist/cli/ which breaks the relative path to source.
          const entryScript = resolve(
            process.cwd(),
            "src/manager/daemon-entry.ts",
          );

          const child = spawn(
            "npx",
            ["tsx", entryScript, "--config", configPath],
            {
              detached: true,
              stdio: "ignore",
              cwd: process.cwd(),
              // Phase 999.87 — strip ANTHROPIC_API_KEY via the single
              // source of truth helper.
              env: buildAnthropicSafeEnv() as NodeJS.ProcessEnv,
            },
          );

          child.unref();

          // Wait for daemon to become responsive
          const entries = await waitForDaemon();

          if (entries !== null) {
            cliLog(`Manager started with ${entries.length} agent(s).`);
            cliLog("");
            cliLog(formatStatusTable(entries));
          } else {
            cliError(
              "Manager failed to start. Check logs at ~/.clawcode/manager/",
            );
            process.exit(1);
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        cliError(`Error: ${message}`);
        process.exit(1);
      }
    });
}
