/**
 * Phase 999.42 Plan 06 T-03 — skill-patch-embed module.
 *
 * Capability C operator review surface — Discord embed builders for the
 * skill PATCH lifecycle. Mirrors `src/discord/skill-draft-embed.ts` (the
 * Phase 132 create-draft embed) with patch-shaped fields.
 *
 *   - buildSkillPatchEmbed(record)        — summarizes a pending patch
 *     artifact (skill slug, patchClass, version current→bumped, source
 *     session, patch-id, drafted-at). Posted when a patch lands; Plan 07's
 *     distiller patch-suggest will be the producer — this plan ships the
 *     builder so the surface is ready.
 *   (2026-09-23 — the operator action renderer went with the retired
 *   /patch-skill, /approve-patch and /reject-patch commands. The producer is
 *   off unless `skillDistiller.suggestPatches: true`.)
 *
 * Pure render functions — no I/O, no Discord client calls — so they are
 * unit-testable. Posting goes through the single Discord posting path
 * (`DiscordBridge.postEmbedToAgentChannel`, added in Phase 132 Plan 03);
 * `postSkillPatchEmbed` is a thin wrapper that delegates to it so the
 * single-bridge invariant holds (no second Discord posting path).
 *
 * Zero new npm dependencies — reuses discord.js EmbedBuilder (14.x).
 */
import { Colors, EmbedBuilder } from "discord.js";
import type { PatchClass } from "../manager/skill-patch-version.js";

/**
 * The fields `buildSkillPatchEmbed` needs to summarize a pending patch.
 * `currentVersion` → `bumpedVersion` is the semver transition the patch
 * proposes (computed at apply time from `patchClass` — see D5).
 */
export type SkillPatchRecord = {
  readonly patchId: string;
  readonly slug: string;
  readonly patchClass: PatchClass;
  readonly currentVersion: string;
  readonly bumpedVersion: string;
  readonly sourceSessionId: string;
  readonly draftedAt: string;
};

/**
 * Bridge surface this module needs — the single `postEmbedToAgentChannel`
 * helper added on DiscordBridge by Phase 132 Plan 03 (no parallel Discord
 * posting path).
 */
export type EmbedAgentPoster = {
  readonly postEmbedToAgentChannel: (
    agent: string,
    embed: EmbedBuilder,
  ) => Promise<string | null>;
};

/**
 * Build the pending-patch review embed. Title names the patched skill;
 * fields cover class / version transition / source session / patch-id /
 * drafted-at; the footer points at the patch file for review by hand.
 */
export function buildSkillPatchEmbed(record: SkillPatchRecord): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`📝 Skill patch proposed: ${record.slug}`)
    .setColor(Colors.Gold)
    .addFields(
      { name: "Class", value: record.patchClass, inline: true },
      {
        name: "Version",
        value: `${record.currentVersion} → ${record.bumpedVersion}`,
        inline: true,
      },
      {
        name: "Source session",
        value: record.sourceSessionId,
        inline: true,
      },
      {
        name: "Patch id",
        value: `\`${record.patchId}\``,
        inline: false,
      },
      { name: "Drafted at", value: record.draftedAt, inline: false },
    )
    .setFooter({
      // The /approve-patch + /reject-patch commands were retired 2026-09-23.
      text: `Review by hand: skill-patches/${record.patchId}.patch.md`,
    })
    .setTimestamp();
}

/**
 * Post a pending-patch embed to the agent's Discord channel via the single
 * bridge helper. Swallows bridge I/O failures (returns null) — never
 * propagates a Discord error up through a fire-and-forget caller.
 */
export async function postSkillPatchEmbed(
  bridge: EmbedAgentPoster,
  agent: string,
  embed: EmbedBuilder,
): Promise<string | null> {
  try {
    return await bridge.postEmbedToAgentChannel(agent, embed);
  } catch {
    return null;
  }
}
