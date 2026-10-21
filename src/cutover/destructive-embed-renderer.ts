/**
 * Phase 92 Plan 04 — Destructive-fix admin-clawdy embed renderer (D-06).
 *
 * PURE function: gap → {embed, components, gapId}. No I/O, no clock, no env.
 * Same input twice → byte-identical output (gapId is sha256(agent|kind|identifier)
 * truncated to 12 hex chars).
 *
 * Exhaustive switch over the 5 DestructiveCutoverGap kinds (D-04 + D-11):
 *   - outdated-memory-file
 *   - mcp-credential-drift
 *   - tool-permission-gap
 *   - cron-session-not-mirrored (D-11)
 *
 * Adding a 6th destructive kind triggers a TypeScript compile error in the
 * default branch (assertNever). Pinned by static-grep regression in the
 * Plan 92-04 acceptance criteria.
 *
 * Button discipline (D-06):
 *   - Accept = ButtonStyle.Danger (red — destructive intent)
 *   - Reject = ButtonStyle.Secondary
 *   - Defer  = ButtonStyle.Secondary
 *
 * customId namespacing (collision-safe with model-confirm:, skills-picker:,
 * plugins-picker:, marketplace-, cancel:, modal-, skills-action-confirm:,
 * plugin-confirm-x:):
 *   `cutover-{agent}-{gapId}:{accept|reject|defer}`
 *
 * NO-LEAK invariant: only env KEY NAMES are read from gap.sourceRef.envKeys.
 * The renderer never touches env values (the gap shape doesn't even carry them).
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { createHash } from "node:crypto";
import {
  CUTOVER_BUTTON_PREFIX,
  type DestructiveCutoverGap,
  assertNever,
} from "./types.js";

/**
 * D-06 — Phase-91 conflict-embed red. Pinned by static-grep so a future
 * theme change can't silently turn a destructive embed white.
 */
const CUTOVER_EMBED_COLOR_DESTRUCTIVE = 15158332; // 0xE74C3C

/**
 * Truncate a sha256 hash to 16 chars for embed display. Operators reading the
 * embed in Discord don't need the full 64-char hash; full hashes ship in the
 * ledger row.
 */
const HASH_PREVIEW_LEN = 16;

export type RenderedDestructiveEmbed = {
  /** Discord embed builder ready to send. */
  readonly embed: EmbedBuilder;
  /**
   * One row of three buttons: [Accept, Reject, Defer]. Accept is FIRST and
   * is ButtonStyle.Danger per D-06. customIds follow the cutover-{agent}-
   * {gapId}:{action} shape so the slash-commands.ts collector can route via
   * a single `i.customId.startsWith(CUTOVER_BUTTON_PREFIX)` filter.
   */
  readonly components: ReadonlyArray<ActionRowBuilder<ButtonBuilder>>;
  /**
   * Deterministic short hash of (agent, kind, identifier) — used in customIds
   * AND as the ledger pointer key. Same input → same gapId across renders so
   * a verify rerun re-surfaces the same embed if the operator deferred earlier.
   */
  readonly gapId: string;
};

/**
 * Compute the deterministic gapId for a destructive gap. Pure function;
 * exported for tests + the slash-commands.ts gap-by-id resolver.
 */
export function computeGapId(
  agent: string,
  gap: DestructiveCutoverGap,
): string {
  return createHash("sha256")
    .update(`${agent}|${gap.kind}|${gap.identifier}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * Render the admin-clawdy ephemeral embed for ONE destructive cutover gap.
 *
 * Returns (embed, components, gapId). Caller posts via interaction.editReply
 * or webhook send, then sets up a button collector with prefix filter
 * `i.customId.startsWith(CUTOVER_BUTTON_PREFIX)` (mirrors Phase 86-03
 * model-confirm pattern).
 *
 * The exhaustive switch over `gap.kind` is enforced by TypeScript via
 * `assertNever(gap)` in the default branch. Adding a 6th DestructiveCutoverGap
 * variant without a corresponding case here fails the build.
 */
export function renderDestructiveGapEmbed(
  agent: string,
  gap: DestructiveCutoverGap,
): RenderedDestructiveEmbed {
  const gapId = computeGapId(agent, gap);

  const embed = new EmbedBuilder()
    .setTitle(`Cutover gap: ${gap.kind}`)
    .setColor(CUTOVER_EMBED_COLOR_DESTRUCTIVE);

  switch (gap.kind) {
    case "outdated-memory-file": {
      const srcPreview = gap.sourceRef.sourceHash.slice(0, HASH_PREVIEW_LEN);
      const tgtPreview = gap.targetRef.targetHash.slice(0, HASH_PREVIEW_LEN);
      embed.setDescription(
        [
          `**OpenClaw side:** \`${gap.sourceRef.path}\` (sha256: \`${srcPreview}\`)`,
          `**ClawCode side:** \`${gap.targetRef.path}\` (sha256: \`${tgtPreview}\`)`,
          "",
          "Accepting will overwrite the ClawCode copy with the OpenClaw content.",
          "The pre-change snapshot is captured to the ledger for rollback (files <64KB).",
        ].join("\n"),
      );
      break;
    }
    case "mcp-credential-drift": {
      // NO-LEAK: only key NAMES are surfaced (gap.sourceRef.envKeys carries
      // names only — the diff engine extracts via Object.keys at probe time).
      const keyList = gap.sourceRef.envKeys
        .map((k) => `\`${k}\``)
        .join(", ");
      embed.setDescription(
        [
          `**Server:** \`${gap.sourceRef.mcpServerName}\``,
          `**Env key names:** ${keyList || "_(none reported)_"}`,
          `**Runtime status:** \`${gap.targetRef.status}\``,
          "",
          "Accepting will record the operator's confirmation; the actual op:// rotation",
          "is operator-driven: update the op:// refs in clawcode.yaml (D-06 propose-and-confirm).",
        ].join("\n"),
      );
      break;
    }
    case "tool-permission-gap": {
      const denyList = gap.targetRef.aclDenies
        .map((a) => `\`${a}\``)
        .join(", ");
      embed.setDescription(
        [
          `**Tool:** \`${gap.sourceRef.toolName}\``,
          `**ACL denies:** ${denyList || "_(none reported)_"}`,
          "",
          "Accepting records the operator decision to enable this tool. Verify the",
          "tool is intended to be available before accepting (ACL writer wiring deferred).",
        ].join("\n"),
      );
      break;
    }
    case "cron-session-not-mirrored": {
      embed.setDescription(
        [
          `**Cron session:** \`${gap.sourceRef.sessionKey}\``,
          `**Label:** ${gap.sourceRef.label}`,
          `**Last seen:** ${gap.sourceRef.lastSeenAt}`,
          `**Target mirrored crons:** ${
            gap.targetRef.mirroredCronEntries.length === 0
              ? "_(none)_"
              : gap.targetRef.mirroredCronEntries
                  .map((e) => `\`${e}\``)
                  .join(", ")
          }`,
          "",
          "Accepting records the operator's intent to mirror this cron entry.",
          "Schedule + skill + tool wiring is deferred to a follow-up plan; this",
          "embed surfaces the gap for parity verification only.",
        ].join("\n"),
      );
      break;
    }
    default:
      // Compile-time exhaustiveness witness. Adding a 6th DestructiveCutoverGap
      // kind without a corresponding case above fails the TypeScript build.
      assertNever(gap);
  }

  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUTOVER_BUTTON_PREFIX}${agent}-${gapId}:accept`)
      .setLabel("Accept")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${CUTOVER_BUTTON_PREFIX}${agent}-${gapId}:reject`)
      .setLabel("Reject")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${CUTOVER_BUTTON_PREFIX}${agent}-${gapId}:defer`)
      .setLabel("Defer")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, components: [buttonRow], gapId };
}
