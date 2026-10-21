import type { ResolvedAgentConfig } from "../shared/types.js";
import type { RoutingTable } from "./types.js";

/**
 * Build an immutable routing table from resolved agent configs.
 *
 * Maps channel IDs to agent names and agent names to their channel lists.
 * Throws if any channel ID is claimed by more than one agent (duplicate detection).
 * Agents with no channels are excluded from agentToChannels.
 */
export function buildRoutingTable(
  configs: readonly ResolvedAgentConfig[],
): RoutingTable {
  const channelToAgent = new Map<string, string>();
  const agentToChannels = new Map<string, readonly string[]>();

  for (const config of configs) {
    const { name, channels } = config;

    if (channels.length === 0) {
      continue;
    }

    for (const channelId of channels) {
      const existing = channelToAgent.get(channelId);
      if (existing !== undefined) {
        throw new Error(
          `Duplicate channel binding: channel "${channelId}" is claimed by both "${existing}" and "${name}"`,
        );
      }
      channelToAgent.set(channelId, name);
    }

    agentToChannels.set(name, [...channels]);
  }

  return {
    channelToAgent,
    agentToChannels,
  };
}

/**
 * Look up which agent handles a given channel.
 * Returns undefined if the channel is not bound to any agent.
 */
export function getAgentForChannel(
  table: RoutingTable,
  channelId: string,
): string | undefined {
  return table.channelToAgent.get(channelId);
}

/**
 * Look up which channels are bound to a given agent.
 * Returns an empty array if the agent has no channel bindings.
 */
export function getChannelsForAgent(
  table: RoutingTable,
  agentName: string,
): readonly string[] {
  return table.agentToChannels.get(agentName) ?? [];
}
