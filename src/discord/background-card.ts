/**
 * 999.178 — the "Working in the background" card: pure renderer + REST port.
 *
 * Posted by the BackgroundTaskBoard when the agent's background work
 * (downloads, waits, non-research subagents) outlives the turn that started
 * it, edited as each task ends, settled when the last one does. Icons come
 * from the cc_* registry; a missing icon renders text-only, never a Unicode
 * glyph.
 */

import { Routes } from "discord-api-types/v10";
import type { BackgroundCardPort, BackgroundCardSnapshot, BackgroundTaskView } from "../manager/background-task-board.js";
import { formatElapsed } from "./duration-format.js";
import type { IconName } from "./icons.js";

type InlineIcon = (name: IconName) => string;

const SUPPRESS_EMBEDS = 1 << 2;

function withIcon(icon: string, text: string): string {
  return icon.length > 0 ? `${icon} ${text}` : text;
}

function withElapsed(head: string, ms: number): string {
  const e = formatElapsed(ms);
  return e.length > 0 ? `${head} · ${e}` : head;
}

function taskLine(t: BackgroundTaskView, now: number, inline: InlineIcon): string {
  const end = t.endedAt ?? now;
  const base = withElapsed(t.description, end - t.startedAt);
  switch (t.status) {
    case "running":
      return withIcon(inline("loader"), t.lastLine ? `${base} — ${t.lastLine}` : base);
    case "completed":
      return withIcon(inline("circle_check"), base);
    default:
      return withIcon(inline("circle_x"), `${base} (${t.status})`);
  }
}

export function renderBackgroundCardContent(snap: BackgroundCardSnapshot, inline: InlineIcon = () => ""): string {
  const running = snap.tasks.filter((t) => t.status === "running").length;
  const end = snap.settledAt ?? snap.now;
  const head =
    snap.settledAt === null
      ? `Working in the background · ${running} running`
      : `Background work finished`;
  const lines = [`**${withElapsed(head, end - snap.startedAt)}**`];
  for (const t of snap.tasks) lines.push(`-# ${taskLine(t, snap.now, inline)}`);
  if (snap.settledAt === null) lines.push("-# Ask \"eta\" any time for a status check.");
  return lines.join("\n");
}

/** Minimal REST surface (discord.js `client.rest`). */
export type BackgroundCardRest = {
  post(route: `/${string}`, opts: { body: unknown }): Promise<unknown>;
  patch(route: `/${string}`, opts: { body: unknown }): Promise<unknown>;
};

export function makeBackgroundCardPort(rest: BackgroundCardRest, inline?: InlineIcon): BackgroundCardPort {
  return {
    async post(channelId, replyTo, snap) {
      const res = (await rest.post(Routes.channelMessages(channelId), {
        body: {
          content: renderBackgroundCardContent(snap, inline),
          flags: SUPPRESS_EMBEDS,
          allowed_mentions: { parse: [] },
          ...(replyTo !== null ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
        },
      })) as { id?: unknown };
      if (typeof res?.id !== "string") throw new Error("background card post returned no message id");
      return res.id;
    },
    async edit(channelId, messageId, snap) {
      await rest.patch(Routes.channelMessage(channelId, messageId), {
        body: { content: renderBackgroundCardContent(snap, inline) },
      });
    },
    async typing(channelId) {
      await rest.post(Routes.channelTyping(channelId), { body: {} });
    },
  };
}
