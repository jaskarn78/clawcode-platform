/**
 * Phase 999.173 — the daemon's research card port: raw REST post/edit under
 * the bot identity (the same client.rest path the ledger card uses). The card
 * is posted as a reply to the message that asked (no pings, no link previews)
 * and edited in place; it carries its buttons only while research runs.
 */

import { Routes } from "discord-api-types/v10";
import type { ResearchCardPort, ResearchCardSnapshot } from "../manager/research-card-sink.js";
import type { IconRegistry } from "./icons.js";
import { renderResearchCardComponents, renderResearchCardContent } from "./research-card.js";

/** Minimal REST surface (discord.js `client.rest`). */
export type ResearchCardRest = {
  post(route: `/${string}`, opts: { body: unknown }): Promise<unknown>;
  patch(route: `/${string}`, opts: { body: unknown }): Promise<unknown>;
};

const SUPPRESS_EMBEDS = 1 << 2;

export function makeResearchCardPort(
  rest: ResearchCardRest,
  iconSet?: Pick<IconRegistry, "button">,
): ResearchCardPort {
  const body = (snap: ResearchCardSnapshot) => ({
    content: renderResearchCardContent(snap),
    components: renderResearchCardComponents(snap, iconSet),
  });
  return {
    async post(channelId, snap) {
      const res = (await rest.post(Routes.channelMessages(channelId), {
        body: {
          ...body(snap),
          flags: SUPPRESS_EMBEDS,
          allowed_mentions: { parse: [] },
          message_reference: { message_id: snap.session.origin.messageId, fail_if_not_exists: false },
        },
      })) as { id?: unknown };
      if (typeof res?.id !== "string") throw new Error("research card post returned no message id");
      return res.id;
    },
    async edit(channelId, messageId, snap) {
      await rest.patch(Routes.channelMessage(channelId, messageId), { body: body(snap) });
    },
    async typing(channelId) {
      await rest.post(Routes.channelTyping(channelId), { body: {} });
    },
  };
}
