/**
 * claude.ai connector entitlement — who may run with the logged-in account's
 * connectors (`mcp__claude_ai_*` tools).
 *
 * An agent is entitled only when ALL hold:
 *   - it opted in (`claudeAiConnectors: true`);
 *   - its `owner` is in `defaults.claudeAiConnectors.allowedOwners`;
 *   - it is NOT `admin` (admin agents accept requests from every owner, so they
 *     would be a laundering route to the connectors).
 * Everyone else runs with ENABLE_CLAUDEAI_MCP_SERVERS=false (spawn-env.ts).
 */

export interface ConnectorEntitlementInput {
  readonly name: string;
  readonly claudeAiConnectors?: boolean;
  readonly owner?: string;
  readonly admin?: boolean;
}

export interface ConnectorEntitlement {
  readonly entitled: boolean;
  /** Set when an opt-in was refused — the loader logs it. */
  readonly refusedReason?: string;
}

export function resolveClaudeAiConnectorsEntitlement(
  agent: ConnectorEntitlementInput,
  allowedOwners: readonly string[],
): ConnectorEntitlement {
  if (agent.claudeAiConnectors !== true) return { entitled: false };
  if (agent.admin === true) {
    return {
      entitled: false,
      refusedReason: "admin agents accept cross-owner requests and never get claude.ai connectors",
    };
  }
  if (agent.owner === undefined) {
    return {
      entitled: false,
      refusedReason: "agent has no owner; set `owner` and list it in defaults.claudeAiConnectors.allowedOwners",
    };
  }
  if (!allowedOwners.includes(agent.owner)) {
    return {
      entitled: false,
      refusedReason: `owner '${agent.owner}' is not in defaults.claudeAiConnectors.allowedOwners`,
    };
  }
  return { entitled: true };
}
