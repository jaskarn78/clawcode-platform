import type { Command } from "commander";
import { join } from "node:path";
import { cliLog, cliError } from "../output.js";
import { loadConfig, resolveAllAgents, defaultOpRefResolver } from "../../config/loader.js";
import { SdkSessionAdapter } from "../../manager/session-adapter.js";
import { SessionManager } from "../../manager/session-manager.js";
import { DiscordBridge, loadBotToken } from "../../discord/bridge.js";
import { buildRoutingTable } from "../../discord/router.js";
import { installWorkspaceSkills } from "../../skills/installer.js";
import { logger } from "../../shared/logger.js";
import { buildSessionConfig } from "../../manager/session-config.js";
import { resolveConfigPath } from "../../config/resolve-path.js";

/**
 * Register the `clawcode run <agent>` command.
 *
 * Starts a single agent in the foreground: SessionManager + Discord bridge.
 * No daemon required (no IPC socket, registry, or heartbeat).
 * Ctrl+C for graceful shutdown.
 */
export function registerRunCommand(program: Command): void {
  program
    .command("run <agent>")
    .description("Run a single agent in the foreground (no daemon required)")
    .option("-c, --config <path>", "Path to config file", "clawcode.yaml")
    .action(async (agentName: string, opts: { config: string }) => {
      const configPath = resolveConfigPath(opts.config);
      const log = logger.child({ component: "run" });

      // 1. Install workspace skills
      await installWorkspaceSkills(join(process.cwd(), "skills"), undefined, log);

      // 2. Load config and find agent
      let config;
      try {
        config = await loadConfig(configPath);
      } catch (err) {
        cliError(`Config error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      // `clawcode run` spawns the real MCP children via SessionManager —
      // must resolve op:// secret refs before the env reaches the SDK.
      // Otherwise a config like `MYSQL_HOST: op://.../hostname` arrives at
      // the child as a literal `op://...` string and fails at DNS lookup.
      // Graceful degradation: a broken op:// ref disables that MCP for the
      // running agent and logs the reason, letting the agent still come up
      // with its other tools rather than blocking startup entirely.
      const resolvedAgents = resolveAllAgents(config, defaultOpRefResolver, (info) => {
        log.error(
          { agent: info.agent, server: info.server, reason: info.message },
          "MCP server disabled — env resolution failed",
        );
      });
      const agentConfig = resolvedAgents.find((a) => a.name === agentName);

      if (!agentConfig) {
        cliError(
          `Agent '${agentName}' not found in config. Available: ${resolvedAgents.map((a) => a.name).join(", ")}`,
        );
        process.exit(1);
      }

      // 3. Build routing table (single agent only)
      const routingTable = buildRoutingTable([agentConfig]);

      // 4. Create SessionManager
      const adapter = new SdkSessionAdapter();
      const manager = new SessionManager({
        adapter,
        registryPath: join(process.env.HOME ?? "~", ".clawcode", "manager", "registry.json"),
      });
      manager.setAllAgentConfigs(resolvedAgents);

      // 5. Load bot token and create Discord bridge
      let botToken: string;
      try {
        botToken = loadBotToken();
      } catch {
        cliError(
          "Discord bot token not found. Set DISCORD_BOT_TOKEN or configure in ~/.claude/channels/discord/.env",
        );
        process.exit(1);
      }

      const bridge = new DiscordBridge({
        routingTableRef: { current: routingTable },
        sessionManager: manager,
        botToken,
        log,
      });

      // 6. Build session config
      const sessionConfig = await buildSessionConfig(agentConfig, {
        tierManagers: new Map(),
        skillsCatalog: new Map(),
        allAgentConfigs: resolvedAgents,
      });

      // 7. Print startup summary
      cliLog(`\nStarting agent: ${agentConfig.name}`);
      cliLog(`  Model:    ${agentConfig.model}`);
      cliLog(`  Channels: ${agentConfig.channels.join(", ") || "(none)"}`);
      cliLog(`  Workspace: ${agentConfig.workspace}`);
      cliLog(`\nPress Ctrl+C to stop.\n`);

      // 8. Graceful shutdown
      const shutdown = async (signal: string) => {
        cliLog(`\n${signal} received — stopping agent...`);
        await manager.stopAgent(agentConfig.name);
        await bridge.stop();
        process.exit(0);
      };

      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));

      // 9. Start bridge then agent
      try {
        await bridge.start();
        await manager.startAgent(agentConfig.name, { ...agentConfig, ...sessionConfig });
        log.info({ agent: agentConfig.name }, "agent runner started");

        // Block forever — agent runs via Discord message callbacks
        await new Promise(() => {});
      } catch (err) {
        cliError(`Failed to start agent: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
