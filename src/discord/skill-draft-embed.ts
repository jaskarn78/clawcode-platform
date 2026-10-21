/**
 * Phase 132 Plan 03 T-02 — skill-draft-embed module.
 *
 * Pure builder + thin poster for the locked CONTEXT §specifics review embed:
 *
 *   📜 Candidate skill ready for review
 *   Agent: Admin Clawdy
 *   Name: find-clients-by-industry
 *   Trigger: when user asks "which clients do X"
 *   Tools: mysql_query, clawcode_share_file
 *   Steps: 4
 *   Source session: <session-id>
 *   Approve: /approve-skill 132-AC-001
 *   Reject: /reject-skill 132-AC-001 [reason]
 *
 * The 8-field shape is byte-locked — any divergence from the field names
 * fails Plan 03 T-02 EM-02. The slash command names (/approve-skill,
 * /reject-skill) match D-06 verbatim; /edit-skill and its Edit field were
 * retired 2026-09-23.
 *
 * Trigger derivation: first clause of `manifest.description` up to the
 * first period; full description when no period present.
 *
 * Posting: `postSkillDraftEmbed(bridge, agent, embed)` delegates to the
 * single helper `bridge.postEmbedToAgentChannel(agent, embed)` so the
 * single-bridge invariant holds (no second Discord posting path).
 */
import { Colors, EmbedBuilder } from "discord.js";
import type { SkillManifest } from "../plugin-sdk/index.js";

/**
 * Subset of Plan 02's `staged` result enriched with what the operator-
 * review embed needs at the daemon edge (sessionId + agent come from the
 * `TaskCompletedEvent`; stepCount + manifest + fingerprint come from the
 * distiller). draftId / slug are deterministic from the staging filename
 * and manifest.name respectively.
 */
export type DraftStagedRecord = {
  readonly draftId: string;
  readonly slug: string;
  readonly agent: string;
  readonly sessionId: string;
  readonly trajectoryFingerprint: string;
  readonly stepCount: number;
  readonly manifest: SkillManifest;
  readonly draftPath: string;
};

/**
 * Bridge surface this module needs. The single method `postEmbedToAgentChannel`
 * is added on DiscordBridge by Plan 03 T-02 (no parallel Discord posting
 * path — same client.channels.fetch + channel.send sequence already used
 * by sendBudgetAlert in bridge.ts).
 */
export type EmbedAgentPoster = {
  readonly postEmbedToAgentChannel: (
    agent: string,
    embed: EmbedBuilder,
  ) => Promise<string | null>;
};

function deriveTrigger(description: string): string {
  const trimmed = description.trim();
  const periodIdx = trimmed.indexOf(".");
  if (periodIdx === -1) return trimmed;
  return trimmed.slice(0, periodIdx).trim();
}

function joinTools(manifest: SkillManifest): string {
  const all = [...manifest.requiredTools, ...manifest.requiredMcpServers];
  return all.join(", ");
}

export function buildSkillDraftEmbed(record: DraftStagedRecord): EmbedBuilder {
  const trigger = deriveTrigger(record.manifest.description);
  const tools = joinTools(record.manifest);
  return new EmbedBuilder()
    .setTitle("📜 Candidate skill ready for review")
    .setColor(Colors.Aqua)
    .addFields(
      { name: "Agent", value: record.agent, inline: true },
      { name: "Name", value: record.manifest.name, inline: true },
      { name: "Trigger", value: trigger, inline: false },
      { name: "Tools", value: tools, inline: false },
      { name: "Steps", value: String(record.stepCount), inline: true },
      { name: "Source session", value: record.sessionId, inline: true },
      {
        name: "Approve",
        value: `/approve-skill ${record.draftId}`,
        inline: false,
      },
      {
        name: "Reject",
        value: `/reject-skill ${record.draftId} [reason]`,
        inline: false,
      },
    )
    .setTimestamp();
}

export async function postSkillDraftEmbed(
  bridge: EmbedAgentPoster,
  agent: string,
  embed: EmbedBuilder,
): Promise<string | null> {
  try {
    return await bridge.postEmbedToAgentChannel(agent, embed);
  } catch {
    // Single source-of-truth swallow: never propagate Discord I/O failure
    // up through the distiller's fire-and-forget path. The bridge logs the
    // underlying error inside postEmbedToAgentChannel.
    return null;
  }
}
