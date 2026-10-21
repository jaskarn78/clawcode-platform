import type { Command } from "commander";
import { cliError } from "../output.js";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Phase 110 Stage 0b deprecation notice (2026-05-07)
 * ──────────────────────────────────────────────────────────────────────────
 *  This Node shim is deprecated runtime as of the Stage 0b deploy. The
 *  static Go binary at `/usr/local/bin/clawcode-mcp-shim --type search` is
 *  the production runtime and is selected by the default
 *  `defaults.shimRuntime.search: "static"` config value.
 *
 *  This file is retained as a flippable emergency-rollback path: setting
 *  `shimRuntime.search: "node"` in agent or default config spawns this
 *  Node shim instead of the Go static binary. Use ONLY for emergency
 *  rollback. See plan 110-08 and
 *  `.planning/phases/110-mcp-memory-reduction-shim-runtime-swap/110-CLEANUP-DECISION.md`
 *  for the rationale (path A — keep fallback).
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Register the `clawcode search-mcp` command.
 *
 * Starts the web-search MCP stdio server that delegates web_search and
 * web_fetch_url tool calls to the daemon's shared BraveClient/ExaClient +
 * URL fetcher over Unix-socket IPC. Auto-injected by Task 2 of Plan 02
 * alongside the existing `clawcode mcp` / `browser-mcp` servers.
 */
export function registerSearchMcpCommand(program: Command): void {
  program
    .command("search-mcp")
    .description(
      "Start the search MCP stdio server (auto-injected per agent; delegates to daemon's BraveClient/ExaClient via IPC)",
    )
    .action(async () => {
      try {
        // Dynamic import keeps the MCP SDK out of the main CLI boot path.
        const { startSearchMcpServer } = await import(
          "../../search/mcp-server.js"
        );
        await startSearchMcpServer();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error starting search MCP server: ${msg}`);
        process.exit(1);
      }
    });
}
