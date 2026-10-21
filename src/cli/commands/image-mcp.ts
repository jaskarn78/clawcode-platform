import type { Command } from "commander";
import { cliError } from "../output.js";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Phase 110 Stage 0b deprecation notice (2026-05-07)
 * ──────────────────────────────────────────────────────────────────────────
 *  This Node shim is deprecated runtime as of the Stage 0b deploy. The
 *  static Go binary at `/usr/local/bin/clawcode-mcp-shim --type image` is
 *  the production runtime and is selected by the default
 *  `defaults.shimRuntime.image: "static"` config value.
 *
 *  This file is retained as a flippable emergency-rollback path: setting
 *  `shimRuntime.image: "node"` in agent or default config spawns this
 *  Node shim instead of the Go static binary. Use ONLY for emergency
 *  rollback. See plan 110-08 and
 *  `.planning/phases/110-mcp-memory-reduction-shim-runtime-swap/110-CLEANUP-DECISION.md`
 *  for the rationale (path A — keep fallback).
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Register the `clawcode image-mcp` command.
 *
 * Starts the image generation MCP stdio server that delegates
 * image_generate / image_edit / image_variations tool calls to the
 * daemon's shared OpenAI / MiniMax / fal.ai clients over Unix-socket
 * IPC. Auto-injected by Task 2 of Plan 02 alongside the existing
 * `clawcode mcp` / `browser-mcp` / `search-mcp` servers.
 */
export function registerImageMcpCommand(program: Command): void {
  program
    .command("image-mcp")
    .description(
      "Start the image MCP stdio server (auto-injected per agent; delegates to daemon's image provider clients via IPC)",
    )
    .action(async () => {
      try {
        // Dynamic import keeps the MCP SDK out of the main CLI boot path.
        const { startImageMcpServer } = await import(
          "../../image/mcp-server.js"
        );
        await startImageMcpServer();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error starting image MCP server: ${msg}`);
        process.exit(1);
      }
    });
}
