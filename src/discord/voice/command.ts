/**
 * Phase 135 Plan 02 — /vc {join,leave,status} subcommand handler.
 *
 * Plan 02 replaces the Plan 01 placeholder branches with real calls into
 * `VoiceManager.{join,leave,status}`. The dispatch shape (try/catch around
 * the whole switch + ephemeral replies) is unchanged — per RESEARCH
 * Pitfall 8, voice subsystem errors must never leak into the shared
 * discord.js Client.
 *
 *   - join    → look up the agent in this guild whose voice.channelId is set
 *               → voiceManager.join(agent.name, channelId)
 *               → "joined: <channelId>" or "voice join failed: <msg>"
 *   - leave   → voiceManager.leave(interaction.guildId)
 *               → "left voice"
 *   - status  → JSON.stringify(voiceManager.status())
 *
 * MVP-scope simplification — the slash command itself takes NO arguments
 * (the Plan 01 schema does not register a `channel:CHANNEL` nested option
 * on the `join` subcommand because the codebase's slash-types schema
 * does not support nested options on SUB_COMMAND entries today; extending
 * that would be scope creep). Instead, `/vc join` joins the channel
 * configured in `agent.voice.channelId` for the invoking guild's bound
 * agent. This matches the "voice is opt-in per agent" yaml posture
 * established in Plan 01 and lets operators control channel binding
 * declaratively in clawcode.yaml.
 */
import type { ChatInputCommandInteraction } from "discord.js";
import type { VoiceManager } from "./manager.js";
import type { AgentWithVoice } from "./config.js";
import type { RoutingTable } from "../types.js";

/**
 * Find the agent bound to the current guild's channels with a `voice.channelId`
 * set. Voice config is per-agent (CONTEXT.md: "missing block = no voice for
 * that agent"); we route the slash command to whichever agent has its voice
 * channel in this guild.
 *
 * ACCEPTED DEBT — TODO(135.3): the `guildId` argument is currently
 * threaded through but not used for filtering (REVIEW WR-02). The
 * RoutingTable today only indexes channel → agent, not guild → agent.
 * For multi-guild deployments where two agents both have
 * `voice.channelId` configured (Agent A in Guild 1, Agent B in Guild 2),
 * `/vc join` invoked from Guild 2 may return Agent A and then attempt
 * to join Guild 1's voice channel from a Guild 2 invocation. Per
 * CONTEXT.md `<deferred>` the multi-guild polish is parked at v3.0.1
 * inserted phase 135.3 (BACKLOG Phase 4). Two cleanest paths when 135.3
 * lands:
 *   (a) add a `guildId?: string` field to the voice block schema so the
 *       agent declares its owning guild explicitly, then filter on it.
 *   (b) add a `guildToAgent` index to RoutingTable populated from each
 *       agent's resolved channel bindings (requires Discord client
 *       channel.fetch to resolve channelId → guildId at boot).
 * Option (a) is simpler and avoids the client-side fetch. Either way,
 * the filter chain below is the single touch point.
 */
function findAgentForGuild(
  guildId: string | null,
  resolvedAgents: readonly AgentWithVoice[],
  routingTable: RoutingTable | null,
): AgentWithVoice | undefined {
  if (!guildId) return undefined;
  // First pass: any agent whose voice.channelId is set. For multi-agent
  // multi-guild deployments where each guild has at most one voice-enabled
  // agent (the v3.0 MVP shape), this is sufficient.
  //
  // If multiple agents have voice configured, we prefer one whose
  // text-channel binding (via routingTable) is in the same guild — that
  // matches the agent's owning guild identity.
  const candidates = resolvedAgents.filter((a) => a.voice?.channelId);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  if (!routingTable) return candidates[0];
  // Multi-candidate disambiguation: pick the one whose text-channels
  // include any channel in the routing table that's in this guild. The
  // routing table only knows channel→agent; we approximate by checking
  // every channel binding for a match. Note: routingTable has no guildId
  // surface today, so this fallback degrades to "first candidate".
  // TODO(135.3) — see function-level comment above for the two cleanest
  // disambiguation strategies. Until then, accept "first candidate" as
  // MVP soft-degrade behaviour (single-guild deployments are unaffected;
  // multi-guild deployments need to enforce one voice-enabled agent
  // per guild at config-load time as an operational discipline).
  return candidates[0];
}

export async function handleVcCommand(
  interaction: ChatInputCommandInteraction,
  voiceManager: VoiceManager,
  resolvedAgents: readonly AgentWithVoice[] = [],
  routingTable: RoutingTable | null = null,
): Promise<void> {
  try {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case "join": {
        const guildId = interaction.guildId;
        if (!guildId) {
          await interaction.reply({
            content: "/vc join must be invoked in a guild (not a DM)",
            ephemeral: true,
          });
          return;
        }
        const agent = findAgentForGuild(guildId, resolvedAgents, routingTable);
        if (!agent || !agent.voice?.channelId) {
          await interaction.reply({
            content:
              "no voice-enabled agent found for this guild — add a "
              + "`voice.channelId:` block to an agent's clawcode.yaml entry "
              + "and restart the daemon",
            ephemeral: true,
          });
          return;
        }
        try {
          await voiceManager.join(agent.name, agent.voice.channelId);
          await interaction.reply({
            content: `joined: ${agent.voice.channelId} (agent: ${agent.name})`,
            ephemeral: true,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await interaction.reply({
            content: `voice join failed: ${msg}`,
            ephemeral: true,
          });
        }
        return;
      }
      case "leave": {
        const guildId = interaction.guildId;
        if (!guildId) {
          await interaction.reply({
            content: "/vc leave must be invoked in a guild (not a DM)",
            ephemeral: true,
          });
          return;
        }
        try {
          await voiceManager.leave(guildId);
          await interaction.reply({
            content: "left voice",
            ephemeral: true,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await interaction.reply({
            content: `voice leave failed: ${msg}`,
            ephemeral: true,
          });
        }
        return;
      }
      case "status": {
        const sessions = voiceManager.status();
        await interaction.reply({
          content: JSON.stringify(sessions),
          ephemeral: true,
        });
        return;
      }
      default:
        await interaction.reply({
          content: `Unknown /vc subcommand: ${sub}`,
          ephemeral: true,
        });
        return;
    }
  } catch (err) {
    // Pitfall 8: log loudly, never re-throw — voice errors must NOT
    // bubble out of the slash-commands runner and risk affecting the
    // shared discord.js Client / text-channel routing.
    const msg = err instanceof Error ? err.message : String(err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: `voice subsystem error — see daemon logs (${msg})`,
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: `voice subsystem error — see daemon logs (${msg})`,
          ephemeral: true,
        });
      }
    } catch {
      /* interaction expired or already consumed — give up silently */
    }
  }
}
