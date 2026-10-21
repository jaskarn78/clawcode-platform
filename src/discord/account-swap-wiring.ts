/**
 * Phase 999.176 — build the `/clawcode-account` dependencies from daemon
 * pieces, keeping daemon.ts to a few lines of glue.
 *
 * Admin gate is STRICTER than isAdminClawdyInteraction: the caller must be
 * in CLAWCODE_ADMIN_DISCORD_USER_IDS AND be in a channel bound to an
 * `admin: true` agent. A fleet-wide restart + credential rewrite should not
 * be reachable by anyone who can merely type in #admin-clawdy, nor from an
 * arbitrary channel. Empty allowlist → the command is disabled (fail closed).
 */

import type { ResolvedAgentConfig } from "../shared/types.js";
import type { SessionManager } from "../manager/session-manager.js";
import type { AccountService } from "../account/account-service.js";
import { isAdminClawdyInteraction } from "./slash-commands.js";
import { resolveV3ChatBridge, type ChatChannelBridge } from "./bridge.js";
import type { AccountFlowDeps, AccountFlowLog } from "./account-swap-flow.js";

export type AccountWiringInput = {
  readonly service: AccountService;
  readonly adminUserIds: readonly string[];
  readonly getRoutingTable: () => { readonly channelToAgent: ReadonlyMap<string, string> };
  readonly resolvedAgents: readonly ResolvedAgentConfig[];
  readonly sessionManager: SessionManager;
  readonly getBridge: (agent: string) => ChatChannelBridge | undefined;
  /** `defaults.accountSwap.macAgent`, read lazily. */
  readonly getMacAgent: () => string | undefined;
  readonly log: AccountFlowLog;
};

export function isAccountAdmin(
  i: { readonly user: { readonly id: string }; readonly channelId: string },
  input: Pick<AccountWiringInput, "adminUserIds" | "getRoutingTable" | "resolvedAgents">,
): boolean {
  if (!input.adminUserIds.includes(i.user.id)) return false;
  return isAdminClawdyInteraction(i, {
    adminUserIds: [],
    routingTable: input.getRoutingTable(),
    resolvedAgents: input.resolvedAgents,
  });
}

/** The agent that drives the MacBook: explicit config, else the admin agent. */
export function resolveMacAgent(
  resolvedAgents: readonly ResolvedAgentConfig[],
  configured: string | undefined,
): string | undefined {
  if (configured) return resolvedAgents.some((a) => a.name === configured) ? configured : undefined;
  return resolvedAgents.find((a) => a.admin === true)?.name;
}

export function buildAccountFlowDeps(input: AccountWiringInput): AccountFlowDeps {
  const macAgent = (): string | undefined => {
    const name = resolveMacAgent(input.resolvedAgents, input.getMacAgent());
    return name !== undefined && input.sessionManager.getRunningAgents().includes(name) ? name : undefined;
  };

  const dispatchMacLogin = async (
    instruction: string,
    correlationId: string,
    timeoutMs: number,
  ): Promise<string> => {
    const agent = macAgent();
    if (agent === undefined) return "MAC_UNAVAILABLE: the Mac agent isn't running";
    const backend = input.sessionManager.getAgentConfig?.(agent)?.llmRuntime?.backend;
    const v3 = resolveV3ChatBridge(backend, input.getBridge, agent);
    if (v3) {
      v3.push({
        type: "a2a",
        message_id: correlationId,
        content: instruction,
        meta: { source_agent: "discord-account-swap", source_channel: "", reply_correlation_id: correlationId },
      });
      const ack = await v3.awaitReply(correlationId, timeoutMs);
      return ack.result ?? "";
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      return await input.sessionManager.streamFromAgent(agent, instruction, () => undefined, undefined, {
        signal: abort.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    service: input.service,
    isAdmin: (i) => isAccountAdmin(i, input),
    listRunningAgents: () => input.sessionManager.getRunningAgents(),
    hasActiveTurn: (agent) => input.sessionManager.hasActiveTurn(agent),
    // Evaluated per login so a Mac agent that starts later is picked up.
    get dispatchMacLogin() {
      return macAgent() !== undefined ? dispatchMacLogin : null;
    },
    log: input.log,
  };
}
