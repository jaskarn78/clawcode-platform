import { spawn } from "node:child_process";
import type { Logger } from "pino";
import { buildAnthropicSafeEnv } from "../manager/spawn-env.js";
import { killGroup } from "./process-tracker.js";

/**
 * Silent fallback logger. Production callers pass a real pino child; tests and
 * pre-Phase-999.X callers that don't supply one get a no-op so probe spawn
 * cleanup stays best-effort without forcing a deps churn.
 */
const NOOP_LOG = {
  warn: () => {},
  error: () => {},
} as unknown as Logger;

/**
 * Result of an MCP server health check.
 */
export type McpHealthResult = {
  readonly name: string;
  readonly healthy: boolean;
  readonly latencyMs: number;
  readonly error?: string;
};

/**
 * MCP server config for health checking.
 */
type McpServerConfig = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

// Phase 108 broker shim path needs more headroom: when an agent's health
// check is the FIRST connection to a cold pool, the broker has to spawn
// `npx -y @takescake/1password-mcp@latest` (npm registry lookup + tarball
// extract + node startup, ~5-15s on cold cache). Subsequent agents attach
// to the warm pool and respond in <100ms. 30s covers the cold-start;
// agents on warm pools complete well under it.
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Check if an MCP server is healthy by spawning it and sending an initialize request.
 *
 * Spawns the server process, sends a JSON-RPC initialize message, and waits for
 * a valid response. Always kills the spawned PROCESS GROUP after the check
 * completes — `detached: true` makes the child its own pgid leader so the
 * negative-PID SIGKILL reaches the npm wrapper plus its `sh -c` and `node`
 * grandchildren together. Without this, the wrapper dies but grandchildren
 * (e.g. `node /.../bin/mcp-server-mysql` holding a MariaDB connection)
 * reparent to PID 1 and leak until the 999.14 orphan reaper sweep — fast
 * enough probes (heartbeat 60s × 14 agents) outpaced the reaper in production.
 *
 * @param server - MCP server configuration
 * @param timeoutMs - Maximum time to wait for response (default
 *                    DEFAULT_TIMEOUT_MS = 30000ms). Callers that need a
 *                    different bound pass it explicitly — e.g. the MCP
 *                    readiness handshake passes 5s (heartbeat steady-
 *                    state) or 20s (cold warm-path gate); see
 *                    src/mcp/readiness.ts.
 * @param log - Optional pino logger; killGroup uses it for EPERM/unexpected
 *              kill errors (rare). Defaults to a no-op logger so existing
 *              callers and tests don't have to thread one through.
 * @returns Health check result with name, healthy status, latency, and optional error
 */
export async function checkMcpServerHealth(
  server: McpServerConfig,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  log: Logger = NOOP_LOG,
): Promise<McpHealthResult> {
  const startTime = Date.now();

  return new Promise<McpHealthResult>((resolve) => {
    let resolved = false;
    let child: ReturnType<typeof spawn> | null = null;

    const finish = (healthy: boolean, error?: string): void => {
      if (resolved) return;
      resolved = true;
      const latencyMs = Date.now() - startTime;

      // Kill the child PROCESS GROUP if still running. detached:true at
      // spawn made the child a pgid leader so `process.kill(-pid, ...)` via
      // killGroup reaches the npm wrapper + sh + node together. Single-PID
      // kill (pre-fix) only signaled the wrapper; grandchildren orphaned to
      // PID 1 with their MariaDB connections still open.
      if (child?.pid && !child.killed) {
        killGroup(child.pid, "SIGKILL", log);
      }

      resolve({
        name: server.name,
        healthy,
        latencyMs,
        ...(error !== undefined ? { error } : {}),
      });
    };

    // Set up timeout
    const timer = setTimeout(() => {
      finish(false, `Health check timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    try {
      child = spawn(server.command, [...server.args], {
        stdio: ["pipe", "pipe", "pipe"],
        // server.env passes through as extraEnv (spread LAST in the helper) so a
        // server's explicit `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}` survives
        // the ambient-key strip.
        env: buildAnthropicSafeEnv(server.env),
        // Phase 999.X — fresh process group so finish()'s killGroup reaches
        // the wrapper + sh + node grandchildren together (see fn JSDoc).
        detached: true,
      });
      // Don't keep the daemon's event loop alive for this one-shot probe.
      child.unref();

      child.on("error", (err: Error) => {
        clearTimeout(timer);
        finish(false, `Failed to start: ${err.message}`);
      });

      child.on("exit", (code: number | null) => {
        clearTimeout(timer);
        if (!resolved) {
          finish(false, `Process exited with code ${code ?? "unknown"} before responding`);
        }
      });

      // Collect stdout data to parse JSON-RPC response
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        // Check if we have a complete JSON-RPC response (newline-delimited)
        const lines = stdout.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            const parsed = JSON.parse(trimmed) as { jsonrpc?: string; id?: string; result?: unknown };
            if (parsed.jsonrpc === "2.0" && parsed.result !== undefined) {
              clearTimeout(timer);
              finish(true);
              return;
            }
          } catch {
            // Not valid JSON yet, keep collecting
          }
        }
      });

      // Send JSON-RPC initialize request
      const initializeRequest = JSON.stringify({
        jsonrpc: "2.0",
        id: "health-check",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "clawcode-health", version: "0.1.0" },
        },
      });

      child.stdin?.write(initializeRequest + "\n");
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      finish(false, `Failed to spawn: ${message}`);
    }
  });
}
