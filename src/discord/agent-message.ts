import { EmbedBuilder } from "discord.js";

/** Footer prefix. Append-only contract — see parseAgentMessageFooter. */
export const AGENT_MESSAGE_FOOTER_PREFIX = "Agent-to-agent message from ";

/**
 * Separator between sender name and delivery id in the footer. Agent names
 * are operator-chosen and contain spaces ("Admin Clawdy"), so this has to be
 * a sequence that cannot occur in one; the parse also takes the LAST
 * occurrence so a name containing it still resolves correctly.
 */
export const FOOTER_ID_SEP = " \u00b7 id:";

/**
 * Phase 999.144 \u2014 separator for the envelope signature (HMAC, lowercase hex).
 * Appended AFTER the id segment; both parses take the LAST occurrence, so the
 * format stays append-only: name \u2192 name\u00b7id \u2192 name\u00b7id\u00b7sig each parse under
 * every newer parser. See src/collaboration/envelope-auth.ts for what the
 * signature binds and why it exists.
 */
export const FOOTER_SIG_SEP = " \u00b7 sig:";

/** Discord embed description limit. */
const MAX_EMBED_DESCRIPTION = 4096;

/**
 * The exact truncation applied to an A2A embed description. Exported because
 * the envelope signature binds the POSTED description \u2014 producers must sign
 * precisely this string, so the truncation cannot live only inside the
 * builder.
 */
export function truncateA2aDescription(content: string): string {
  return content.length > MAX_EMBED_DESCRIPTION
    ? content.slice(0, MAX_EMBED_DESCRIPTION - 3) + "..."
    : content;
}

/**
 * Build a Discord embed for an agent-to-agent message.
 *
 * @param senderName - Machine name of the sending agent
 * @param senderDisplayName - Human-friendly display name of the sender
 * @param content - Message content (truncated to 4096 chars if too long)
 * @returns Configured EmbedBuilder ready to send via webhook
 */
export function buildAgentMessageEmbed(
  senderName: string,
  senderDisplayName: string,
  content: string,
  deliveryId?: string,
  sig?: string,
): EmbedBuilder {
  const description = truncateA2aDescription(content);

  // Phase 999.117 WS-2 — the delivery id rides in the footer.
  //
  // A webhook embed is one of four ways the same logical message can reach an
  // agent, and the bridge relays it back into a turn. Without a shared key the
  // relay cannot tell "this is the message the inbox watcher already
  // delivered" from "this is new", so both fire and every hop doubles. The
  // footer is the only field that already round-trips (extractAgentSender
  // parses it), so the id goes there.
  //
  // Format is append-only: the sender name is still the first capture group,
  // so an embed posted by an older build (no id) parses exactly as before.
  let footer =
    deliveryId !== undefined && deliveryId !== ""
      ? `${AGENT_MESSAGE_FOOTER_PREFIX}${senderName}${FOOTER_ID_SEP}${deliveryId}`
      : `${AGENT_MESSAGE_FOOTER_PREFIX}${senderName}`;
  // Phase 999.144 — the envelope signature rides last. Only meaningful
  // alongside an id (the sig binds the deliveryId); a signed-but-idless
  // embed is not produced anywhere and would fail verification anyway.
  if (sig !== undefined && sig !== "") {
    footer = `${footer}${FOOTER_SIG_SEP}${sig}`;
  }

  return new EmbedBuilder()
    .setAuthor({ name: `${senderDisplayName} [Agent]` })
    .setDescription(description)
    .setColor(0x5865F2)
    .setFooter({ text: footer })
    .setTimestamp();
}

/**
 * Parse an A2A embed footer back into its parts.
 *
 * Single source of truth for the footer contract — the bridge MUST use this
 * rather than its own regex, or the two drift and the relay silently stops
 * recognising agent messages (which would turn the webhook rung back into a
 * black hole). Returns undefined for any footer that is not an A2A footer.
 */
export function parseAgentMessageFooter(
  footer: string | undefined,
): { senderName: string; deliveryId?: string; sig?: string } | undefined {
  if (!footer || !footer.startsWith(AGENT_MESSAGE_FOOTER_PREFIX)) return undefined;
  let rest = footer.slice(AGENT_MESSAGE_FOOTER_PREFIX.length);
  if (rest.length === 0) return undefined;

  // Phase 999.144 — strip the trailing signature segment first (appended
  // last by the builder, so it is the last occurrence). An embed from a
  // pre-signature build has no segment and parses exactly as before.
  let sig: string | undefined;
  const sigSep = rest.lastIndexOf(FOOTER_SIG_SEP);
  if (sigSep !== -1) {
    sig = rest.slice(sigSep + FOOTER_SIG_SEP.length) || undefined;
    rest = rest.slice(0, sigSep);
  }

  const sep = rest.lastIndexOf(FOOTER_ID_SEP);
  if (sep === -1) return sig === undefined ? { senderName: rest } : { senderName: rest, sig };
  const deliveryId = rest.slice(sep + FOOTER_ID_SEP.length) || undefined;
  return {
    senderName: rest.slice(0, sep),
    ...(deliveryId !== undefined ? { deliveryId } : {}),
    ...(sig !== undefined ? { sig } : {}),
  };
}
