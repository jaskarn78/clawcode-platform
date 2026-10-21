/**
 * 2026-09-24 — `remote-mcp-reconnect` heartbeat check.
 *
 * Revives an agent's ssh-stdio MCP servers (mac-remote-node, mac-chrome,
 * mac-mini-node, …) after the remote machine sleeps or reboots, IN PLACE —
 * no agent restart, no lost context. The sibling `mcp-reconnect` check only
 * classifies health (its header assumes the SDK reconnects transparently; on
 * the pinned CLI it does not — a dead stdio server keeps reporting
 * `connected`). Decision logic + rationale: src/manager/remote-mcp-reconnect.ts.
 *
 * Runs every heartbeat tick. Cost when everything is healthy: one /proc scan
 * per agent that holds an ssh server; no network, no spawn. Probes (TCP only)
 * run only while a server is dead.
 *
 * Kill switch: `CLAWCODE_REMOTE_MCP_RECONNECT=off` (or 0/false) in the daemon
 * environment → the check is a no-op.
 */

import type { CheckContext, CheckResult } from "../types.js";
import {
  remoteServersOf,
  runRemoteMcpReconnectTick,
  type ServerReconnectState,
} from "../../manager/remote-mcp-reconnect.js";
import { isSshHostReachable, listChildArgv } from "../../manager/remote-mcp-io.js";
import { logger } from "../../shared/logger.js";

const log = logger.child({ component: "remote-mcp-reconnect" });

/** agent → server → state, for the daemon's lifetime. */
const stateByAgent = new Map<string, ReadonlyMap<string, ServerReconnectState>>();

export function isRemoteMcpReconnectDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = (env.CLAWCODE_REMOTE_MCP_RECONNECT ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false";
}

/** Test-only: forget carried state. */
export function __resetRemoteMcpReconnectStateForTests(): void {
  stateByAgent.clear();
}

const remoteMcpReconnectCheck = {
  name: "remote-mcp-reconnect",
  // Worst case one reconnect into a host that answered TCP but then stalls
  // (ssh ConnectTimeout=15) plus probes — well inside 45 s.
  timeout: 45,

  async execute(ctx: CheckContext): Promise<CheckResult> {
    if (isRemoteMcpReconnectDisabled()) {
      return { status: "healthy", message: "disabled (CLAWCODE_REMOTE_MCP_RECONNECT)" };
    }
    const agent = ctx.agentName;
    const sm = ctx.sessionManager;
    const cfg = sm.getAgentConfig(agent);
    const servers = remoteServersOf(cfg?.mcpServers ?? []);
    if (servers.length === 0) {
      return { status: "healthy", message: "no ssh MCP servers" };
    }

    const { outcomes, next } = await runRemoteMcpReconnectTick({
      servers,
      prior: stateByAgent.get(agent) ?? new Map(),
      deps: {
        listCliChildArgv: async () => {
          const pid = sm.getClaudePidForAgent(agent);
          return pid === null ? null : listChildArgv(pid);
        },
        getSdkStatuses: () => sm.getMcpServerStatusesForAgent(agent),
        isHostReachable: isSshHostReachable,
        hasActiveTurn: () => sm.hasActiveTurn(agent),
        reconnect: (server) => sm.reconnectMcpServerForAgent(agent, server),
        now: ctx.now ?? Date.now,
      },
    });
    stateByAgent.set(agent, next);

    for (const o of outcomes) {
      if (o.action === "reconnected") {
        log.info(
          { agent, server: o.server, host: o.host, deadReason: o.deadReason },
          "remote MCP server reconnected in place",
        );
      } else if (o.action === "reconnect-failed") {
        log.warn(
          { agent, server: o.server, host: o.host, deadReason: o.deadReason, error: o.error },
          "remote MCP server reconnect failed — backing off",
        );
      }
    }

    const dead = outcomes.filter((o) => o.action !== "alive" && o.action !== "reconnected");
    const failed = outcomes.filter((o) => o.action === "reconnect-failed");
    const summary = outcomes.map((o) => `${o.server}=${o.action}`).join(", ");
    return {
      // A sleeping laptop is normal, not an incident: dead-but-unreachable
      // stays healthy so /api/health `incidents` (the morning fleet brief)
      // doesn't report the Mac's bedtime. Only a reconnect that was ATTEMPTED
      // against a reachable host and failed is a warning; never critical.
      status: failed.length === 0 ? "healthy" : "warning",
      message: summary,
      metadata: {
        reconnected: outcomes.filter((o) => o.action === "reconnected").length,
        dead: dead.length,
        failed: failed.length,
      },
    };
  },
};

export default remoteMcpReconnectCheck;
