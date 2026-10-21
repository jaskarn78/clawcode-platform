/**
 * Phase 999.27 — broker-shim detection helper.
 *
 * The Phase 108 broker-pooled `1password` MCP is wired by the loader as
 * `command="clawcode" args=["mcp-broker-shim", "--pool", "1password"]`.
 * Heartbeat / warm-path / on-demand probes that spawn this shim with the
 * un-overridden default env (the daemon's clawdbot-fleet token) cause the
 * broker to see a tokenHash that doesn't match the agent's actual
 * per-agent overridden token (e.g., Acme-scope), triggering rebind
 * cycles every 60s and pool churn — root cause of the 2026-05-01 incident
 * documented in Phase 999.27.
 *
 * Fix: detect the broker-shim signature and skip it from per-agent probes.
 * The broker has its own dedicated heartbeat (`mcp-broker.ts`) that
 * verifies pool aliveness via `getPoolStatus()` — no per-agent probe is
 * needed for a daemon-singleton transport.
 *
 * Detection is intentionally conservative: we match BOTH the command name
 * AND the `mcp-broker-shim` arg. A future server that happens to use
 * `clawcode` as its command but is NOT broker-pooled (e.g., the existing
 * `clawcode mcp` / `browser-mcp` / `search-mcp` entries) is correctly NOT
 * skipped because they don't carry the `mcp-broker-shim` arg.
 */

export type ProbeMcpServerLike = {
  readonly command: string;
  readonly args: readonly string[];
};

/**
 * Returns true when the given MCP server is a broker-pooled shim that
 * should be skipped from per-agent capability probes / warm-path checks /
 * heartbeat probes.
 *
 * The broker's own heartbeat (`heartbeat/checks/mcp-broker.ts`) covers
 * liveness for these pools without spawning probe shims.
 */
export function isBrokerPooledMcpServer(
  server: ProbeMcpServerLike,
): boolean {
  return (
    server.command === "clawcode" &&
    server.args.some((a) => a === "mcp-broker-shim")
  );
}

/**
 * Filter convenience: returns a new array with broker-pooled shims
 * removed. Order-preserving. Safe to call on empty/all-shim arrays.
 */
export function filterOutBrokerPooled<T extends ProbeMcpServerLike>(
  servers: readonly T[],
): T[] {
  return servers.filter((s) => !isBrokerPooledMcpServer(s));
}
