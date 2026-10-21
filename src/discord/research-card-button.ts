/**
 * Phase 999.173 — research card controls (`rsch:` prefix).
 *
 *   Status  (button) — ephemeral per-researcher detail; anyone in the channel.
 *   Stop…   (button) — ephemeral "Stop which researcher?" with a select menu of
 *                      the RUNNING researchers plus "Stop all".
 *   picker  (select) — stops the chosen researcher (or all) via
 *                      `SessionHandle.stopTask(taskId)`, then edits the
 *                      ephemeral to one confirming line. The card itself
 *                      updates when the stopped notification arrives.
 *
 * Stop… and the picker are limited to the person whose message started the
 * research (the origin message's author, fetched at click time — no stored
 * identity to go stale). Never throws: registered on `interactionCreate`,
 * where an unhandled rejection takes the whole daemon down.
 */

import { MessageFlags } from "discord.js";
import { findResearchSession, type ResearchCardSessionView } from "../manager/research-registry.js";
import {
  parseResearchButtonId,
  parseStopSelection,
  renderResearchStatus,
  renderResearchStopPicker,
} from "./research-card.js";

export type ResearchButtonInteractionLike = {
  readonly customId: string;
  readonly user?: { readonly id: string };
  /** Select-menu interactions only: the chosen option values. */
  readonly values?: readonly string[];
  readonly channel?: {
    readonly messages?: { fetch: (id: string) => Promise<{ readonly author?: { readonly id: string } }> };
  } | null;
  reply: (opts: { content: string; flags?: number; components?: unknown[] }) => Promise<unknown>;
  /** Select-menu interactions: edit the (ephemeral) message the menu sits on. */
  update?: (opts: { content: string; components: unknown[] }) => Promise<unknown>;
};

export type ResearchButtonDeps = Readonly<{
  getSessionHandle: (agentName: string) => { stopTask?: (taskId: string) => Promise<boolean> } | undefined;
  findSession?: (key: string) => ResearchCardSessionView | undefined;
  now?: () => number;
  log: Readonly<{
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  }>;
}>;

export const RESEARCH_ENDED_TEXT = "This research has already ended.";
export const RESEARCH_NOT_YOURS_TEXT = "Only the person who asked for this research can stop a researcher.";
export const RESEARCH_NOTHING_RUNNING_TEXT = "Nothing is running any more.";
export const RESEARCH_STOP_PROMPT = "Stop which researcher?";

async function safeReply(
  i: ResearchButtonInteractionLike,
  content: string,
  deps: ResearchButtonDeps,
  components?: unknown[],
): Promise<void> {
  try {
    await i.reply({ content, flags: MessageFlags.Ephemeral, ...(components ? { components } : {}) });
  } catch (err) {
    deps.log.warn({ error: err instanceof Error ? err.message : String(err) }, "research: button reply failed (interaction likely expired)");
  }
}

/** Replace the ephemeral picker with one line; falls back to a new ephemeral reply. */
async function safeUpdate(i: ResearchButtonInteractionLike, content: string, deps: ResearchButtonDeps): Promise<void> {
  if (i.update) {
    try {
      await i.update({ content, components: [] });
      return;
    } catch (err) {
      deps.log.warn({ error: err instanceof Error ? err.message : String(err) }, "research: picker update failed — replying instead");
    }
  }
  await safeReply(i, content, deps);
}

async function isOriginAuthor(i: ResearchButtonInteractionLike, originMessageId: string): Promise<boolean> {
  const userId = i.user?.id;
  if (!userId || !i.channel?.messages) return false;
  try {
    const origin = await i.channel.messages.fetch(originMessageId);
    return origin.author?.id === userId;
  } catch {
    return false;
  }
}

export async function handleResearchButton(
  interaction: ResearchButtonInteractionLike,
  deps: ResearchButtonDeps,
): Promise<void> {
  try {
    const id = parseResearchButtonId(interaction.customId);
    if (id === null) {
      await safeReply(interaction, "That button is malformed and was ignored.", deps);
      return;
    }
    const session = (deps.findSession ?? findResearchSession)(id.key);
    if (session === undefined) {
      await (id.action === "stop-select" ? safeUpdate : safeReply)(interaction, RESEARCH_ENDED_TEXT, deps);
      return;
    }
    if (id.action === "status") {
      await safeReply(interaction, renderResearchStatus(session, (deps.now ?? Date.now)()), deps);
      return;
    }
    if (!(await isOriginAuthor(interaction, session.origin.messageId))) {
      await (id.action === "stop-select" ? safeUpdate : safeReply)(interaction, RESEARCH_NOT_YOURS_TEXT, deps);
      return;
    }
    if (id.action === "stop-menu") {
      const picker = renderResearchStopPicker(session);
      if (picker.length === 0) {
        await safeReply(interaction, RESEARCH_NOTHING_RUNNING_TEXT, deps);
        return;
      }
      await safeReply(interaction, RESEARCH_STOP_PROMPT, deps, picker);
      return;
    }
    await stopSelected(interaction, session, deps);
  } catch (err) {
    deps.log.warn({ error: err instanceof Error ? err.message : String(err) }, "research: button handler failed");
    await safeReply(interaction, "Something went wrong handling that button.", deps);
  }
}

async function stopSelected(
  interaction: ResearchButtonInteractionLike,
  session: ResearchCardSessionView,
  deps: ResearchButtonDeps,
): Promise<void> {
  const choice = parseStopSelection(interaction.values?.[0]);
  if (choice === null) {
    await safeUpdate(interaction, "That choice was not recognised.", deps);
    return;
  }
  const running = session.tasks.filter((t) => t.status === "running");
  const targets = choice === "all" ? running : running.filter((t) => t.index === choice);
  if (targets.length === 0) {
    await safeUpdate(
      interaction,
      choice === "all" ? RESEARCH_NOTHING_RUNNING_TEXT : "That researcher has already finished.",
      deps,
    );
    return;
  }
  const handle = deps.getSessionHandle(session.agentName);
  const results = await Promise.all(
    targets.map(async (t) => ({ t, ok: handle?.stopTask ? await handle.stopTask(t.taskId) : false })),
  );
  const stopped = results.filter((r) => r.ok).map((r) => r.t);
  deps.log.info(
    { agent: session.agentName, key: session.key, stopped: stopped.map((t) => t.taskId), requested: targets.length, by: interaction.user?.id },
    "research: stopped",
  );
  let line: string;
  if (stopped.length === 0) line = "Couldn't stop that — the session may have restarted.";
  else if (choice === "all") line = `Stopped ${stopped.length === 1 ? "1 researcher" : `all ${stopped.length} researchers`}.`;
  else line = `Stopped: ${stopped[0]!.description}`;
  await safeUpdate(interaction, line, deps);
}
