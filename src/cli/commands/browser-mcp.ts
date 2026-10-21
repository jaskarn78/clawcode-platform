import type { Command } from "commander";
import { cliError } from "../output.js";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Phase 110 Stage 0b deprecation notice (2026-05-07)
 * ──────────────────────────────────────────────────────────────────────────
 *  This Node shim is deprecated runtime as of the Stage 0b deploy. The
 *  static Go binary at `/usr/local/bin/clawcode-mcp-shim --type browser`
 *  is the production runtime and is selected by the default
 *  `defaults.shimRuntime.browser: "static"` config value.
 *
 *  This file is retained as a flippable emergency-rollback path: setting
 *  `shimRuntime.browser: "node"` in agent or default config spawns this
 *  Node shim instead of the Go static binary. Use ONLY for emergency
 *  rollback. See plan 110-08 and
 *  `.planning/phases/110-mcp-memory-reduction-shim-runtime-swap/110-CLEANUP-DECISION.md`
 *  for the rationale (path A — keep fallback).
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Register the `clawcode browser-mcp` command.
 *
 * Starts the browser MCP stdio server that delegates browser tool calls
 * to the daemon's BrowserManager over Unix-socket IPC. Auto-injected by
 * Plan 03 alongside the existing `clawcode mcp` server.
 */
export function registerBrowserMcpCommand(program: Command): void {
  program
    .command("browser-mcp")
    .description(
      "Start the browser MCP stdio server (auto-injected per agent; delegates to daemon's BrowserManager via IPC)",
    )
    .action(async () => {
      try {
        // Dynamic import keeps the MCP SDK out of the main CLI boot path.
        const { startBrowserMcpServer } = await import(
          "../../browser/mcp-server.js"
        );
        await startBrowserMcpServer();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error starting browser MCP server: ${msg}`);
        process.exit(1);
      }
    });
}
