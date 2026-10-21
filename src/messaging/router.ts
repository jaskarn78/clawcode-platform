/**
 * Per-platform routing table.
 *
 * The Discord router (src/discord/router.ts) maps opaque channel ids → agent
 * names; it is already platform-neutral in spirit. This builds the same
 * structure for a non-Discord platform from per-agent channel lists, so each
 * platform owns its own namespace (a Slack channel id and a Discord snowflake
 * never collide because they live in separate tables).
 */

export type PlatformRoutingTable = {
  readonly channelToAgent: ReadonlyMap<string, string>;
  readonly agentToChannels: ReadonlyMap<string, readonly string[]>;
};

/** Minimal per-agent binding the builder needs. */
export type PlatformBindingEntry = {
  readonly name: string;
  readonly channels: readonly string[];
};

/**
 * Build an immutable routing table for one platform. Throws if a channel is
 * claimed by two agents (same one-agent-per-channel invariant the Discord
 * router enforces). Agents with no channels are skipped.
 */
export function buildPlatformRoutingTable(
  entries: readonly PlatformBindingEntry[],
): PlatformRoutingTable {
  const channelToAgent = new Map<string, string>();
  const agentToChannels = new Map<string, readonly string[]>();

  for (const { name, channels } of entries) {
    if (channels.length === 0) continue;
    for (const channelId of channels) {
      const existing = channelToAgent.get(channelId);
      if (existing !== undefined && existing !== name) {
        throw new Error(
          `Duplicate channel binding: channel "${channelId}" is claimed by both "${existing}" and "${name}"`,
        );
      }
      channelToAgent.set(channelId, name);
    }
    agentToChannels.set(name, [...channels]);
  }

  return { channelToAgent, agentToChannels };
}

export function getAgentForChannel(
  table: PlatformRoutingTable,
  channelId: string,
): string | undefined {
  return table.channelToAgent.get(channelId);
}
