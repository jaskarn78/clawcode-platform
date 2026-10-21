/**
 * P2 (memory program) — standalone slim entry for the per-agent
 * `clawcode mcp` sidecar.
 *
 * The classic sidecar ran `clawcode mcp`, i.e. the FULL 4.4 MB CLI bundle
 * (~80 statically-imported command modules: transformers, better-sqlite3,
 * discord.js, sharp, exceljs, …) — ~246 MB RSS × one per agent, just to
 * host a thin IPC translator. This entry imports ONLY the MCP server
 * module (MCP SDK + zod + the newline-JSON IPC client) and is built by
 * `build:channels` (esbuild, --packages=external) into
 * `dist/channels/clawcode-mcp-standalone.js` — the same slim-entry
 * pattern as the channel MCP server (11 KB) and hooks.
 *
 * Selected by `defaults.sidecarRuntime.clawcodeMcp: "slim"` (loader
 * auto-inject swap; default "bundled" preserves the classic spawn until
 * the canary verifies). Env contract is unchanged — the loader/daemon
 * inject CLAWCODE_AGENT / CLAWCODE_AGENT_TOKEN exactly as before, and
 * server.ts reads them identically.
 */
import { startMcpServer } from "../mcp/server.js";

startMcpServer().catch((error: unknown) => {
  // stderr only — stdout belongs to the MCP stdio transport.
  console.error(
    `clawcode-mcp-standalone: fatal: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
