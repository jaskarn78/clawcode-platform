/**
 * WS-1 (999.99 structural delivery) — daemon-side orphan-output delivery
 * callback factory.
 *
 * Bridges the narrow `onOrphanTurnOutput` boundary declared on
 * AgentSessionConfig to the agent's own channel. A self-fired turn's output
 * (Monitor event, background Bash exit, background Agent completion) — or an
 * abandoned daemon turn's late output (999.99-F2) — posts as a standalone
 * message the moment the turn completes, wearing the agent's identity.
 *
 * Delivery cascade (999.99 review — the original webhook-only sink dropped
 * ALL output for bot-delivered agents like client-a-health/state-contract):
 *   1. webhookManager.send(agentName, …) when the agent HAS a webhook
 *      (hasWebhook guard mirrors stream-stall-callback.ts).
 *   2. botDirectSender.sendText(channelId, …) fallback — same primitive the
 *      TriggerEngine deliveryFn uses for webhook-less agents.
 *   3. Warn-logged drop (grep: `ws1-orphan-delivery`).
 *
 * Policy (999.99 review): `isError` payloads are SUPPRESSED — a raw
 * "Aborted: interrupt deadline exceeded" posted as an agent message leaks
 * internals and reads as noise; the structured warn log keeps it auditable.
 *
 * Ordering (999.99 review): sends are serialized per agent through a tail
 * promise so orphan chunks can never interleave between chunks of an
 * in-flight streamed reply going through the same sink.
 *
 * Fire-and-forget: a Discord 5xx / webhook 401 MUST NOT wedge the demux
 * pump. Failures are warn-logged and swallowed. WS-2 (durable outbox +
 * watchdog) replaces this best-effort sink; this factory is deliberately
 * the single seam WS-2 will swap.
 *
 * Formatting: `⏱️ ` prefix (structural-plan Q2 decision), on the FIRST chunk
 * only — the prefix is prepended before splitting, exactly as it is on the
 * webhook leg.
 *
 * Chunking (2026-09-10 — fin-client post-transcription incident): the
 * bot-direct leg used to hand the whole payload to `sendText`, which issues
 * ONE `channel.send` and does NOT split. Discord rejects any message over
 * 2000 chars with `BASE_TYPE_MAX_LENGTH`, so every self-fired turn whose
 * output ran long was warn-logged and DROPPED. That was not a rare edge:
 * because no fleet agent declares a `webhook.displayName`, the provisioner
 * marks every auto-provisioned identity `a2aOnly` (webhook-provisioner.ts),
 * `hasWebhook()` is false fleet-wide, and the webhook leg — the only one
 * that split — never ran. Prod journal 2026-07-24..09-10: 100 orphan
 * deliveries, ALL via bot-direct, 15 failures, ALL `BASE_TYPE_MAX_LENGTH`,
 * smallest at 2004 chars.
 *
 * So this leg now runs the same chokepoint `WebhookManager.send` does —
 * `splitKeepingAnnotations(formatOutboundText(text), 2000, splitMessage)` —
 * and sends the chunks sequentially. Format BEFORE split, never after:
 * `formatOutboundText` can GROW text (a markdown table gains a code fence),
 * so splitting first would let a chunk exceed 2000 once `sendText` re-wraps
 * it. Both halves of the formatter are idempotent on already-formatted
 * input (`stripEmDashes` fast-paths when no em/en dash remains;
 * `wrapMarkdownTablesInCodeFence` passes fenced regions through untouched),
 * so `sendText`'s own re-wrap of each chunk is a genuine no-op.
 *
 * Deliberately NOT fixed by chunking inside `BotDirectSender.sendText`: it
 * returns a single message id that callers depend on (999.103 todo-card
 * `editText`, memory-digest-cron), and its no-split behavior is load-bearing
 * for `sendFiles`. Other callers (admin-alert-target, daemon-ask-agent-ipc)
 * truncate on purpose; this callback was the only one doing neither.
 */

import type { WebhookManager } from "../discord/webhook-manager.js";
import {
  formatOutboundText,
  splitKeepingAnnotations,
} from "../discord/markdown-table-wrap.js";
import { splitMessage } from "../messaging/split.js";
import { icons } from "../discord/icons.js";
import { rewriteIconShortcodes, stripIconShortcodes } from "../discord/icon-shortcodes.js";
import {
  extractDrafts,
  splitDraftForDelivery,
  DRAFT_ONLY_BODY,
} from "../discord/draft-extract.js";
import type { Logger } from "pino";

/**
 * Discord's hard per-message ceiling. Declared locally, matching the other
 * outbound chokepoints (`webhook-manager.ts` MAX_MESSAGE_LENGTH, `bridge.ts`
 * MAX_LENGTH) rather than importing one of them — keeps this module free of
 * the `discord.js` value graph.
 */
const MAX_MESSAGE_LENGTH = 2000;

/** Subtle self-initiated-post marker (structural plan Q2). */
export const ORPHAN_OUTPUT_PREFIX = "⏱️ ";

export type OrphanTurnOutputPayload = {
  readonly text: string;
  readonly originKind: string | null;
  readonly isError: boolean;
  readonly classification:
    | "orphan-signaled"
    | "orphan-unsignaled"
    | "reclassified-from-daemon"
    // 999.99-F2 — late output of a daemon turn whose consumer exited on the
    // abort deadline / AbortSignal without the result.
    | "abandoned-daemon";
  /** 999.173 — deliver as a Discord reply to this message (research synthesis). */
  readonly replyTo?: Readonly<{ channelId: string; messageId: string }>;
};

export type OrphanDeliveryCallbackDeps = {
  readonly agentName: string;
  /**
   * LATE-BINDING Discord sink provider, resolved at DELIVERY time (not
   * factory time). The webhookManager is DI'd into SessionManager AFTER
   * construction; a session built during the boot window would otherwise
   * capture `undefined` forever and silently lose every orphan output for
   * its lifetime. Returns undefined when still unwired.
   */
  readonly webhookManagerProvider: () => WebhookManager | undefined;
  /**
   * 999.99 review — bot-direct fallback for webhook-less agents, resolved
   * at delivery time. Same shape the TriggerEngine deliveryFn uses:
   * sendText(channelId, content). Undefined when the daemon has no bot.
   */
  readonly botDirectSendProvider?: () =>
    | ((channelId: string, content: string) => Promise<unknown>)
    | undefined;
  /**
   * 999.99 review — the agent's bound channel id for the bot-direct leg
   * (agents[].channels[0] resolution, same as trigger delivery). Undefined
   * → the bot-direct leg is skipped.
   */
  readonly channelIdProvider?: () => string | undefined;
  /**
   * 999.173 — bot-direct reply leg for payloads carrying `replyTo` (a research
   * synthesis answering a user's message). Resolved at delivery time.
   * Undefined → the reply degrades to a plain bot-direct post in that channel.
   */
  readonly botDirectReplyProvider?: () =>
    | ((channelId: string, content: string, replyToMessageId: string) => Promise<unknown>)
    | undefined;
  /**
   * Optional logger for the fire-and-forget catch handlers. Falls back
   * to console at the call sites (no hard dependency on pino in tests).
   */
  readonly log?: Logger;
};

/**
 * Build a per-agent orphan-delivery callback. Pure factory — no side
 * effects until the returned callback is invoked.
 */
export function makeOrphanDeliveryCallback(
  deps: OrphanDeliveryCallbackDeps,
): (payload: OrphanTurnOutputPayload) => void {
  // Per-agent outbound serialization (tail promise). One chain per
  // callback instance == one per session; rebuilt on session restart,
  // which is fine — ordering only matters within a live session.
  let sendTail: Promise<void> = Promise.resolve();

  return (payload: OrphanTurnOutputPayload): void => {
    const logLine = {
      agent: deps.agentName,
      classification: payload.classification,
      originKind: payload.originKind,
      isError: payload.isError,
      textLength: payload.text.length,
    };
    const warn = deps.log?.warn?.bind(deps.log) ?? console.warn;
    const info = deps.log?.info?.bind(deps.log) ?? console.info;

    // Policy: error payloads are auditable via the log, never posted.
    if (payload.isError) {
      warn(
        { ...logLine, suppressed: true },
        "ws1-orphan-delivery: error-result orphan output suppressed (logged only)",
      );
      return;
    }

    // 999.178 R1 — a self-fired turn can carry a client-facing ```draft block
    // too (e.g. a background task that drafted a message). Extract from the RAW
    // text BEFORE formatting (formatOutboundText wraps tables in ```text```
    // fences the draft matcher would otherwise pull out), post the analysis as
    // the background message, and each draft as its OWN copy-paste-clean
    // message — no ⏱️ prefix, no icons. The common no-draft orphan is
    // untouched: extractDrafts short-circuits without a ``` fence.
    const ex = extractDrafts(payload.text);
    const analysisRaw =
      ex.drafts.length > 0
        ? ex.text.trim().length > 0
          ? ex.text
          : DRAFT_ONLY_BODY
        : payload.text;
    // 999.178 R1 — the analysis is agent-authored: resolve its `:cc_name:`
    // icon shortcodes. Drafts are client-facing: every icon token is stripped.
    const analysisText = rewriteIconShortcodes(analysisRaw, icons);
    const draftPieces = ex.drafts.flatMap((d) => [
      ...splitDraftForDelivery(stripIconShortcodes(d)),
    ]);
    const content = `${ORPHAN_OUTPUT_PREFIX}${analysisText}`;

    // Post one clean draft piece through whichever sink the leg uses (chunked
    // the same way the analysis is, so a formatted table can't exceed the cap).
    const sendDraftPieces = async (
      send: (chunk: string) => Promise<unknown>,
    ): Promise<void> => {
      for (const piece of draftPieces) {
        for (const chunk of splitKeepingAnnotations(
          formatOutboundText(piece),
          MAX_MESSAGE_LENGTH,
          splitMessage,
        )) {
          await send(chunk);
        }
      }
    };

    // 999.173 — a research synthesis answers the user's request: it goes out
    // as a REPLY to that message, in that message's channel, without the ⏱️
    // self-fired marker (it is the answer, not a background post). Chunk 1
    // carries the reference; the rest follow in order; any draft trails after.
    const deliverReply = async (
      replyTo: Readonly<{ channelId: string; messageId: string }>,
    ): Promise<boolean> => {
      const botSend = deps.botDirectSendProvider?.();
      if (!botSend) return false;
      const reply = deps.botDirectReplyProvider?.();
      const chunks = splitKeepingAnnotations(
        formatOutboundText(analysisText),
        MAX_MESSAGE_LENGTH,
        splitMessage,
      );
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0 && reply) await reply(replyTo.channelId, chunks[i]!, replyTo.messageId);
        else await botSend(replyTo.channelId, chunks[i]!);
      }
      await sendDraftPieces((chunk) => botSend(replyTo.channelId, chunk));
      info(
        { ...logLine, via: reply ? "bot-direct-reply" : "bot-direct", channelId: replyTo.channelId, chunks: chunks.length, drafts: ex.drafts.length },
        "ws1-orphan-delivery: research synthesis posted as a reply",
      );
      return true;
    };

    const deliver = async (): Promise<void> => {
      if (payload.replyTo !== undefined && (await deliverReply(payload.replyTo))) return;
      const wm = deps.webhookManagerProvider();
      if (wm !== undefined && wm.hasWebhook(deps.agentName)) {
        await wm.send(deps.agentName, content);
        // Drafts wear the agent identity too — plain, no ⏱️ prefix.
        await sendDraftPieces((chunk) => wm.send(deps.agentName, chunk));
        info({ ...logLine, drafts: ex.drafts.length }, "ws1-orphan-delivery: self-fired turn output posted to channel");
        return;
      }
      const botSend = deps.botDirectSendProvider?.();
      const channelId = deps.channelIdProvider?.();
      if (botSend && channelId) {
        // `sendText` issues exactly one channel.send and does not split, so
        // the split happens HERE — same chokepoint the webhook leg uses.
        const chunks = splitKeepingAnnotations(
          formatOutboundText(content),
          MAX_MESSAGE_LENGTH,
          splitMessage,
        );
        // Sequential, not Promise.all: Discord preserves send order only for
        // serialized sends, and a chunked message read out of order is worse
        // than a late one.
        for (const chunk of chunks) {
          await botSend(channelId, chunk);
        }
        await sendDraftPieces((chunk) => botSend(channelId, chunk));
        info(
          { ...logLine, via: "bot-direct", channelId, chunks: chunks.length, drafts: ex.drafts.length },
          "ws1-orphan-delivery: self-fired turn output posted via bot-direct fallback",
        );
        return;
      }
      warn(
        { ...logLine, dropped: true },
        "ws1-orphan-delivery: no webhook and no bot-direct sink — orphan output NOT delivered",
      );
    };

    sendTail = sendTail
      .then(deliver)
      .catch((err: unknown) => {
        warn(
          {
            ...logLine,
            error: err instanceof Error ? err.message : String(err),
          },
          "ws1-orphan-delivery: delivery failed — orphan output dropped (WS-2 outbox will make this durable)",
        );
      });
  };
}
