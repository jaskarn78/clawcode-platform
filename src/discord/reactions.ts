import type { Message } from "discord.js";

/**
 * Add a reaction to a Discord message.
 *
 * Plan 117-09 (RESEARCH §4.6) — observational hook used by the Discord
 * bridge to land the 💭 reaction on the triggering user message when
 * the advisor is consulted during a turn. Failures are swallowed: the
 * reaction is decorative; the assistant's response delivery is what
 * matters (matches the codebase's "observational hooks must not break
 * the message path" invariant — see session-adapter.ts:1422 precedent
 * and the Plan 117-04 fail-silent emitter wrappers).
 *
 * discord.js v14 `Message.react(emoji)` accepts a unicode emoji string
 * like `"💭"` directly.
 */
export async function addReaction(message: Message, emoji: string): Promise<void> {
  try {
    await message.react(emoji);
  } catch {
    // Non-fatal: the reaction is decorative; delivery is what matters.
  }
}

/**
 * Represents a reaction event from Discord.
 */
export type ReactionEvent = {
  readonly type: "add" | "remove";
  readonly emoji: string;
  readonly userName: string;
  readonly messageId: string;
  readonly channelId: string;
  readonly messageContent?: string;
};

/**
 * Format a reaction event as a structured message for the agent.
 * Uses XML-like tags consistent with the Discord message format.
 *
 * @param event - The reaction event details
 * @returns Formatted string for agent consumption
 */
export function formatReactionEvent(event: ReactionEvent): string {
  const parts = [
    `<reaction type="${event.type}" emoji="${event.emoji}" user="${event.userName}" message_id="${event.messageId}" channel_id="${event.channelId}">`,
  ];

  if (event.messageContent) {
    parts.push(`Original message: ${event.messageContent}`);
  }

  parts.push("</reaction>");

  return parts.join("\n");
}
