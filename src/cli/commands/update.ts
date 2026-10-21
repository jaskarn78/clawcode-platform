import type { Command } from "commander";
import { execSync } from "node:child_process";
import { cliLog, cliError } from "../output.js";

/**
 * Register the `clawcode update` command.
 * Pulls latest from the git remote, reinstalls dependencies, and rebuilds.
 */
export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Update ClawCode from the git remote and rebuild")
    .option("--restart", "Restart the daemon after updating")
    .action((opts: { restart?: boolean }) => {
      try {
        cliLog("Pulling latest from remote...");
        const pullOutput = execSync("git pull --ff-only", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        cliLog(pullOutput);

        if (pullOutput.includes("Already up to date")) {
          cliLog("Already on the latest version.");
          return;
        }

        cliLog("\nInstalling dependencies...");
        execSync("npm ci", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        cliLog("Dependencies installed.");

        cliLog("\nBuilding...");
        execSync("npm run build", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        cliLog("Build complete.");

        if (opts.restart) {
          cliLog("\nRestarting daemon...");
          try {
            execSync("systemctl restart clawcode", {
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            });
            cliLog("Daemon restarted.");
          } catch {
            cliLog("systemd service not found — restart the daemon manually.");
          }
        } else {
          cliLog("\nUpdate complete. Restart the daemon to apply changes:");
          cliLog("  clawcode update --restart");
          cliLog("  # or: sudo systemctl restart clawcode");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        cliError(`Update failed: ${message}`);
        process.exit(1);
      }
    });
}
