/**
 * 999.149 — post text into an agent's own channel, wearing the agent's
 * identity, correctly chunked.
 *
 * WHY THIS EXISTS. `SessionManager.dispatchTurn` and `TurnDispatcher.dispatch`
 * both RETURN the agent's reply; neither posts it. For a Discord-originated
 * turn that is right — DiscordBridge opens the turn and owns delivery. But
 * every *self-fired* caller (the transcription pipeline, the workflow fan-in,
 * anything that dispatches a turn on the agent's behalf) has to deliver the
 * reply itself, and the ones that forgot silently dropped it:
 *
 *   2026-09-17, #state-contract — the Unraid pipeline transcribed a 5.5-minute
 *   standup, shared the 3.8 KB transcript, dispatched the summary turn, and
 *   threw the summary away. The owner saw a wall of transcript and no summary,
 *   two days running: "We've been doing this every business day. You shouldn't
 *   mess up like this."
 *
 * The chunking is not optional. `BotDirectSender.sendText` issues exactly ONE
 * `channel.send` and does not split, and Discord rejects anything over 2000
 * chars with `BASE_TYPE_MAX_LENGTH` — so any summary worth reading was exactly
 * the kind that got dropped. This is the same format-then-split chokepoint
 * `WebhookManager.send` and `orphan-delivery-callback.ts` use, extracted so a
 * third and fourth caller cannot re-make the same mistake.
 *
 * Format BEFORE split, never after: `formatOutboundText` can GROW text (a
 * markdown table gains a code fence), so splitting first would let a chunk
 * exceed 2000 once the sender re-wraps it. Both halves of the formatter are
 * idempotent on already-formatted input, so the sender's own re-wrap of each
 * chunk is a genuine no-op.
 */
import type { WebhookManager } from "../discord/webhook-manager.js";
import { formatOutboundText, splitKeepingAnnotations } from "../discord/markdown-table-wrap.js";
import { splitMessage } from "../messaging/split.js";

/** Discord's hard per-message ceiling (declared locally, as the other chokepoints do). */
export const MAX_MESSAGE_LENGTH = 2000;

type LogLike = {
  info(o: unknown, m?: string): void;
  warn(o: unknown, m?: string): void;
};

export type AgentTextSinks = {
  /** Resolved at DELIVERY time — the manager is DI'd in after construction. */
  readonly webhookManager?: () => WebhookManager | undefined;
  /** Bot-direct fallback for webhook-less agents: sendText(channelId, content). */
  readonly botDirectSend?: () => ((channelId: string, content: string) => Promise<unknown>) | undefined;
  /** The agent's bound channel for the bot-direct leg. */
  readonly channelId?: () => string | undefined;
};

export type DeliverAgentTextArgs = {
  readonly agentName: string;
  readonly text: string;
  readonly sinks: AgentTextSinks;
  readonly log: LogLike;
  /** Appears in the log line so a drop is traceable to its source. */
  readonly reason: string;
};

export type DeliverAgentTextResult =
  | { readonly ok: true; readonly via: "webhook" | "bot-direct"; readonly chunks: number }
  | { readonly ok: false; readonly reason: "empty" | "no-sink" | "send-failed" };

/**
 * Deliver `text` as the agent. Never throws — a Discord 5xx must not wedge the
 * pipeline that called us — but unlike the orphan sink it RETURNS the outcome,
 * so a caller that has a fallback (the workflow fan-in's deterministic summary)
 * can tell whether it needs to use it.
 */
export async function deliverAgentText(args: DeliverAgentTextArgs): Promise<DeliverAgentTextResult> {
  const { agentName, sinks, log, reason } = args;
  const text = args.text.trim();
  const base = { agent: agentName, reason, textLength: text.length };

  // An empty reply is not a delivery failure — the agent chose to say nothing
  // (or said it all through tool calls). Posting "" would be noise.
  if (text.length === 0) {
    log.info({ ...base }, "agent-text-delivery: nothing to deliver (empty reply)");
    return { ok: false, reason: "empty" };
  }

  try {
    const wm = sinks.webhookManager?.();
    if (wm !== undefined && wm.hasWebhook(agentName)) {
      await wm.send(agentName, text);
      log.info({ ...base, via: "webhook" }, "agent-text-delivery: posted");
      return { ok: true, via: "webhook", chunks: 1 };
    }
    const botSend = sinks.botDirectSend?.();
    const channelId = sinks.channelId?.();
    if (botSend && channelId) {
      const chunks = splitKeepingAnnotations(formatOutboundText(text), MAX_MESSAGE_LENGTH, splitMessage);
      // Sequential, not Promise.all: Discord preserves order only for
      // serialized sends, and a chunked message read out of order is worse
      // than a late one.
      for (const chunk of chunks) {
        await botSend(channelId, chunk);
      }
      log.info({ ...base, via: "bot-direct", channelId, chunks: chunks.length }, "agent-text-delivery: posted");
      return { ok: true, via: "bot-direct", chunks: chunks.length };
    }
    log.warn({ ...base, dropped: true }, "agent-text-delivery: no webhook and no bot-direct sink — text NOT delivered");
    return { ok: false, reason: "no-sink" };
  } catch (err) {
    log.warn(
      { ...base, error: err instanceof Error ? err.message : String(err) },
      "agent-text-delivery: send failed — text NOT delivered",
    );
    return { ok: false, reason: "send-failed" };
  }
}
