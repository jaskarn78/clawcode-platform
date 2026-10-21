/**
 * Phase 94 Plan 01 Gap-Closure — real callTool / listTools primitives.
 *
 * Production wiring at the daemon edge for the capability probe's
 * `deps.callTool` and `deps.listTools` surfaces. The probe itself
 * stays DI-pure (no spawn imports) — this module spawns the MCP
 * server subprocess via JSON-RPC stdio (same pattern as
 * src/mcp/health.ts) and returns the result.
 *
 * Wiring contract:
 *   - The Claude Agent SDK does NOT expose a programmatic
 *     `query.callMcpTool(name, args)` surface (verified against
 *     @anthropic-ai/claude-agent-sdk@0.2.x sdk.d.ts) — its MCP client
 *     is internal to the LLM tool-call dispatch path. So we replicate
 *     the JSON-RPC handshake at the daemon edge: spawn → initialize
 *     → tools/list (or tools/call) → kill. Identical pattern to
 *     `checkMcpServerHealth` in src/mcp/health.ts; the only delta is
 *     the second JSON-RPC call after initialize.
 *   - One subprocess per probe call: cheap because probes run on a
 *     60s cadence and the budget per server is 10s. A persistent
 *     subprocess pool is premature optimization until probe overhead
 *     becomes meaningful (deferred-items.md tracks this).
 *
 * Used by:
 *   - src/heartbeat/checks/mcp-reconnect.ts (heartbeat tick — replaces
 *     the stubDeps.callTool that threw)
 *   - src/manager/daemon.ts mcp-probe IPC (on-demand operator trigger
 *     — replaces the stubDeps.callTool that threw)
 *   - src/manager/session-manager.ts boot-time probe (fire-and-forget
 *     at end of startAgent — see Phase 94 Plan 01 Gap 1 closure)
 *
 * NOT used directly by:
 *   - src/manager/capability-probe.ts (DI-pure, no spawn imports)
 *   - src/manager/capability-probes.ts (registry — pure DI)
 */

import { spawn } from "node:child_process";
import type { Logger } from "pino";
import { buildAnthropicSafeEnv } from "../manager/spawn-env.js";
import { killGroup } from "./process-tracker.js";

/**
 * Silent fallback logger. Mirrors src/mcp/health.ts — production callers pass
 * a real pino child for killGroup's EPERM/unexpected-error path; tests get a
 * no-op so we don't have to thread a logger through every fixture.
 */
const NOOP_LOG = {
  warn: () => {},
  error: () => {},
} as unknown as Logger;

/**
 * Minimal MCP server config shape consumed by the JSON-RPC primitives.
 * Mirrors `ReadinessMcpServer` in src/mcp/readiness.ts.
 */
export type McpServerConfig = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

/**
 * Per-call timeout. Kept under capability-probe's PROBE_TIMEOUT_MS (10s)
 * so the spawn → JSON-RPC handshake → kill sequence completes within
 * the orchestrator's budget. The orchestrator races each probe against
 * its own 10s, so this internal cap is defense-in-depth.
 */
const RPC_TIMEOUT_MS = 8_000;

/**
 * Minimal JSON-RPC tool descriptor (subset of the MCP `tools/list`
 * response). The probe registry only reads `name`, so we keep the
 * type narrow.
 */
export type McpToolDescriptor = {
  readonly name: string;
};

/**
 * Spawn an MCP server subprocess, perform the initialize handshake,
 * send a single follow-up JSON-RPC method, then kill the process.
 *
 * Returns the parsed JSON-RPC `result` field. Throws on spawn error,
 * non-2.0 protocol response, JSON-RPC error envelope, or timeout.
 *
 * Verbatim error pass-through (Phase 85 TOOL-04): when the server
 * returns a JSON-RPC error envelope, the caller sees the server's
 * `error.message` verbatim — no wrapping, no truncation.
 *
 * @param server MCP server config (command + args + env)
 * @param method JSON-RPC method ("tools/list" or "tools/call")
 * @param params Method params (typed loose; per-method shape is the
 *               caller's contract with the server)
 * @param timeoutMs Optional override (defaults to RPC_TIMEOUT_MS)
 */
async function rpcCall(
  server: McpServerConfig,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number = RPC_TIMEOUT_MS,
  log: Logger = NOOP_LOG,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let resolved = false;
    let child: ReturnType<typeof spawn> | null = null;
    let initialized = false;
    let stdout = "";

    const finish = (err?: Error, result?: unknown): void => {
      if (resolved) return;
      resolved = true;

      // Group-kill via negative PID — detached:true at spawn made the child
      // its own pgid leader, so this reaches the npm wrapper + sh + node
      // grandchildren together. Pre-fix single-PID kill orphaned the
      // grandchildren to PID 1 (mcp-server-mysql leak; see fn JSDoc).
      if (child?.pid && !child.killed) {
        killGroup(child.pid, "SIGKILL", log);
      }

      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`MCP rpc ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      child = spawn(server.command, [...server.args], {
        stdio: ["pipe", "pipe", "pipe"],
        // server.env passes through as extraEnv (spread LAST in the helper) so a
        // server's explicit `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}` survives
        // the ambient-key strip.
        env: buildAnthropicSafeEnv(server.env),
        // Phase 999.X — fresh process group so finish()'s killGroup reaps
        // the wrapper + sh + node grandchildren together.
        detached: true,
      });
      // One-shot probe — don't keep the daemon's event loop alive for it.
      child.unref();

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        finish(new Error(`Failed to start: ${err.message}`));
      });

      child.on("exit", (code: number | null) => {
        clearTimeout(timer);
        if (!resolved) {
          finish(
            new Error(
              `MCP subprocess exited with code ${code ?? "unknown"} before responding to ${method}`,
            ),
          );
        }
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        // Parse newline-delimited JSON-RPC frames as they arrive.
        let nlIdx = stdout.indexOf("\n");
        while (nlIdx !== -1) {
          const line = stdout.slice(0, nlIdx).trim();
          stdout = stdout.slice(nlIdx + 1);
          nlIdx = stdout.indexOf("\n");
          if (line.length === 0) continue;

          let parsed: {
            jsonrpc?: string;
            id?: string | number;
            result?: unknown;
            error?: { message?: string; code?: number };
          };
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (parsed.jsonrpc !== "2.0") continue;

          // Stage 1: initialize response. Send the follow-up call.
          if (!initialized && parsed.id === "init" && parsed.result !== undefined) {
            initialized = true;
            const followUp = JSON.stringify({
              jsonrpc: "2.0",
              id: "call",
              method,
              params,
            });
            try {
              child?.stdin?.write(followUp + "\n");
            } catch (err) {
              clearTimeout(timer);
              finish(new Error(`failed to write ${method}: ${(err as Error).message}`));
            }
            continue;
          }

          // Stage 2: response to our call.
          if (initialized && parsed.id === "call") {
            clearTimeout(timer);
            if (parsed.error) {
              // Verbatim error pass-through (TOOL-04).
              finish(new Error(parsed.error.message ?? "MCP rpc error"));
            } else {
              finish(undefined, parsed.result);
            }
            return;
          }
        }
      });

      // Send initialize handshake (stage 1).
      const initRequest = JSON.stringify({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "clawcode-capability-probe", version: "0.1.0" },
        },
      });
      child.stdin?.write(initRequest + "\n");
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      finish(new Error(`Failed to spawn: ${message}`));
    }
  });
}

/**
 * Production `listTools` primitive — JSON-RPC `tools/list` against the
 * named MCP server. Returns an array of tool descriptors (just the
 * names today; the registry doesn't need more).
 *
 * Used as `deps.listTools` for the capability probe at the daemon edge.
 */
export function makeRealListTools(
  serversByName: ReadonlyMap<string, McpServerConfig>,
  log: Logger = NOOP_LOG,
): (serverName: string) => Promise<readonly McpToolDescriptor[]> {
  return async (serverName: string) => {
    const server = serversByName.get(serverName);
    if (!server) {
      throw new Error(`MCP server '${serverName}' not configured`);
    }
    const result = (await rpcCall(server, "tools/list", {}, undefined, log)) as {
      tools?: ReadonlyArray<{ name?: string }>;
    };
    const tools = result?.tools ?? [];
    return tools
      .filter((t): t is { name: string } => typeof t?.name === "string")
      .map((t) => ({ name: t.name }));
  };
}

/**
 * Production `callTool` primitive — JSON-RPC `tools/call` against the
 * named MCP server. Returns the server's `result.content` payload
 * verbatim (the registry probe entries inspect this for kind="ok"
 * vs verbatim error).
 *
 * Used as `deps.callTool` for the capability probe at the daemon edge.
 *
 * Errors from the server come through as thrown exceptions with
 * verbatim error.message — Phase 85 TOOL-04 pass-through. The probe
 * registry's safe() wrapper catches these and lifts into a degraded
 * snapshot with the verbatim error.
 */
export function makeRealCallTool(
  serversByName: ReadonlyMap<string, McpServerConfig>,
  log: Logger = NOOP_LOG,
): (
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown> {
  return async (serverName, toolName, args) => {
    const server = serversByName.get(serverName);
    if (!server) {
      throw new Error(`MCP server '${serverName}' not configured`);
    }
    return await rpcCall(
      server,
      "tools/call",
      { name: toolName, arguments: args },
      undefined,
      log,
    );
  };
}
