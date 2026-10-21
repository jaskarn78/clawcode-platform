/**
 * Quick 260511-pw2 — daemon `post-to-agent` IPC handler (pure-DI).
 *
 * Extracted from `src/manager/daemon.ts` `case "post-to-agent":` body so the
 * fire-and-forget delivery contract can be exercised without spawning the full
 * daemon. Mirrors the Phase 999.2 Plan 03 `daemon-ask-agent-ipc.ts` blueprint.
 *
 * Background — why this module exists today:
 *
 *   Admin Clawdy observed (2026-05-11 Discord) that messages sent via
 *   `post_to_agent` to the Projects agent appeared to vanish — no error
 *   surfaced to the sender's LLM, no Discord embed reached the recipient's
 *   channel, and the returned id was opaque (looked task-shaped, but
 *   `task_status` returned "not found" because nanoid post-ids are a
 *   different system from delegate-task ids). Three failure modes compound:
 *
 *     1. Recipient has no Discord webhook configured  → inbox-only delivery.
 *     2. Recipient agent not running (process not up)  → inbox written, but
 *        the InboxSource watcher / heartbeat reconciler can't dispatch a
 *        turn to a dead process.
 *     3. Recipient has no channels in the routing table → webhook can't
 *        target anything.
 *
 *   Pre-2026-05-11 the daemon caught the webhook failure and logged a
 *   `console.warn` then returned `{ delivered: false, messageId }` to the
 *   caller. The MCP wrapper then rendered that as `"Message queued for X
 *   (id: <nanoid>)"`, which the sender's LLM interpreted as a queryable
 *   task id. The post-id-looks-task-shaped confusion is the *user-visible*
 *   half of the silent-drop class of bug described in:
 *     ~/.claude/projects/.../memory/feedback_silent_path_bifurcation.md
 *
 * Contract this module enforces:
 *
 *   ALL six silent-return / silent-catch points emit a structured
 *   `"post-to-agent skipped"` pino info log with a `reason` tag. Reasons:
 *
 *     - "target-not-found"        target name absent from configs
 *     - "inbox-write-failed"      writeMessage threw (disk / permissions)
 *     - "no-target-channels"      routing table has no channel for target
 *     - "no-webhook"              target has no webhook identity
 *     - "webhook-send-failed"     webhookManager.sendAsAgent threw
 *     - "target-not-running"      target not in runningAgents — best-effort
 *                                 heartbeat reconciler delivery only
 *
 *   The return shape preserves backward compat (`{ delivered, messageId }`)
 *   but adds two new fields:
 *
 *     - `ok: boolean`             true iff inbox-write succeeded
 *     - `reason?: string`         present iff `delivered=false`; one of the
 *                                 reason tags above
 *
 *   Errors propagate. The only failure that throws is `target-not-found`
 *   (validation; matches pre-existing behavior). Webhook + routing failures
 *   degrade to inbox-only with `delivered=false, reason=...` because the
 *   inbox path is the canonical fallback (heartbeat inbox check drains it
 *   for every agent fleet-wide — see src/heartbeat/checks/inbox.ts).
 *
 *   The MCP wrapper at src/mcp/server.ts:postToAgentHandler reads `reason`
 *   and renders explicit text so the sender's LLM can NEVER mistake the
 *   inbox id for a queryable task id.
 */

import { nanoid } from "nanoid";
import type { EmbedBuilder } from "discord.js";
import type { InboxMessageKind } from "../collaboration/types.js";
import type { DaemonChannelMessage } from "../channels/clawcode-channel-server.js";
import { ManagerError } from "../shared/errors.js";
import {
  buildAgentMessageEmbed,
  truncateA2aDescription,
} from "../discord/agent-message.js";
import { incrementNoWebhookFallback } from "./fleet-stats.js";
import { RECEIPT_EMOJI } from "../collaboration/presentation-registry.js";
import { signA2aEnvelope } from "../collaboration/envelope-auth.js";
import { getProcessIdentitySecret } from "./agent-identity-token.js";
import {
  resolveAgentName,
  describeResolutionFailure,
} from "../collaboration/agent-addressing.js";

/** Reason discriminator surfaced in `reason` on the response. */
export type PostToAgentSkipReason =
  | "target-not-found"
  | "inbox-write-failed"
  | "no-target-channels"
  | "no-webhook"
  | "webhook-send-failed"
  | "target-not-running"
  // WS-0 (quick 260716-u5h) — ack had no channel route (bot-direct absent or
  // failed); the inbox audit record exists but no notification was posted.
  | "ack-notification-only"
  // WS-0 (quick 260716-u5h) — self-targeted post found no channel route
  // (no webhook, no bot-direct). Nothing was queued: self-posts never write
  // an inbox record (that record would echo back as the agent's own turn).
  | "self-target-no-delivery"
  // Phase 999.117 WS-3 — a loop-governance bound tripped. The message was
  // NOT delivered and no inbox record was written; the sender is told which
  // bound fired and why, so it can stop rather than retry.
  | "loop-guard";

/** Minimal config shape consumed by the handler. */
export type PostToAgentAgentConfigLike = Readonly<{
  name: string;
  memoryPath: string;
  webhook?: Readonly<{
    displayName: string;
    avatarUrl?: string;
    webhookUrl?: string;
  }>;
  /**
   * Phase 119 A2A-01 — bound channel IDs. Mirrors daemon-ask-agent-ipc.ts:53.
   * Used as the bot-direct fallback channel resolver when the routing-table
   * snapshot has no binding.
   */
  channels?: readonly string[];
}>;

/** Minimal pino-like logger surface. */
export type PostToAgentLogger = Readonly<{
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}>;

/** Minimal WebhookManager surface. */
export type PostToAgentWebhookManagerLike = Readonly<{
  hasWebhook(agentName: string): boolean;
  /**
   * 2026-09-03 — includes A2A-only identities (auto-provisioned for agents
   * that never configured `webhook:`). A2A embeds SHOULD use those; ordinary
   * replies must not. Optional so narrowed test doubles compile unchanged;
   * falls back to `hasWebhook` when absent.
   */
  hasA2aWebhook?(agentName: string): boolean;
  sendAsAgent(
    targetAgent: string,
    senderDisplayName: string,
    senderAvatarUrl: string | undefined,
    embed: EmbedBuilder,
  ): Promise<string | void>;
  /**
   * WS-0 (quick 260716-u5h) — optional PLAIN-TEXT send wearing the agent's
   * own identity (real WebhookManager.send). Used by the self-target
   * short-circuit: a plain webhook post carries no A2A embed footer, so the
   * bridge's webhook branch cannot mistake it for an agent-to-agent message
   * and forward it back (extractAgentSender returns undefined → dropped).
   * Optional so the narrowed test doubles and legacy call-sites compile
   * unchanged.
   */
  send?(agentName: string, content: string): Promise<unknown>;
}>;

/** Inbox-write closure (production wraps writeMessage + createMessage). */
export type PostToAgentInboxWriter = (params: {
  from: string;
  to: string;
  content: string;
  /**
   * Quick 260520-r70 — additive-optional message-role discriminator.
   * Absent → the closure writes a "message" (default, unchanged
   * behavior). Set to "ack" so the agent-to-agent acknowledgment loop
   * reuses this exact delivery cascade without a 4th delivery path.
   */
  kind?: InboxMessageKind;
  /**
   * Phase 999.117 WS-1 — envelope fields, all optional so existing callers
   * and test doubles compile unchanged. The production closure threads them
   * into `createMessage`; a closure that ignores them still writes a valid
   * message (the envelope then resolves to a fresh single-hop conversation).
   */
  conversationId?: string;
  causationId?: string;
  hops?: number;
  autoSubmitted?: boolean;
}) => Promise<{ messageId: string }>;

export type PostToAgentDeps = Readonly<{
  runningAgents: readonly string[];
  configs: readonly PostToAgentAgentConfigLike[];
  agentChannels: ReadonlyMap<string, readonly string[]>;
  webhookManager: PostToAgentWebhookManagerLike;
  writeInbox: PostToAgentInboxWriter;
  log: PostToAgentLogger;
  /**
   * Phase 119 A2A-01 — optional bot-direct sender. Mirrors the
   * daemon-ask-agent-ipc.ts:104 shape verbatim per D-01. When set AND the
   * target has no webhook AND a channel is bound, the handler dispatches
   * the message via the bot client instead of falling straight through to
   * the inbox-heartbeat path. Unwired in pre-bridge boot windows — when
   * undefined the no-webhook path retains its prior inbox-only behavior.
   */
  /**
   * Phase 119 A2A-01 bot-direct sender. Phase 999.117 WS-4 widened the return
   * to `void | string`: the daemon's implementation already returned the
   * posted message id, it was just being discarded. Keeping it lets the ack
   * path react on the message instead of posting a second one. Still declared
   * loosely so existing test doubles returning void compile unchanged.
   */
  botDirectSender?: {
    sendText(channelId: string, text: string): Promise<void | string>;
  };
  /**
   * Phase 140 #14b — v3 ClawCode-channel push. When the target agent runs the
   * v3 (`claude-code-interactive`) backend it has a live `AgentChannelBridge`;
   * return it here and the handler delivers the message via channel push (the
   * correct v3 mechanism) INSTEAD of the webhook→bot-direct→inbox-heartbeat
   * cascade — that cascade ends in a heartbeat turn-dispatch, which does NOT
   * drive a v3 agent's chat turns (the daemon is out of the v3 hot path). The
   * inbox-write floor still runs first as the persistent record. `undefined`
   * for v2/SDK targets (no bridge) → the cascade is unchanged. Narrow
   * `{ push }` shape so this module doesn't import the bridge class.
   */
  getBridge?: (agent: string) => { push(msg: DaemonChannelMessage): void } | undefined;
  /**
   * Phase 999.117 WS-3 — loop governor. Optional so every existing test
   * double and any pre-bridge boot window keeps today's behavior; when
   * absent, no bound is applied (identical to `mode: "off"`).
   *
   * Evaluated ONCE, here, before the inbox write. This is the single point
   * where an A2A message's fate is decided, so it is the only correct place
   * to count it — evaluating in two places would double-count and trip
   * early; evaluating in none leaves the exchange unbounded.
   */
  /**
   * Phase 999.117 WS-2 — shared cross-path delivery dedupe. Used on the v3
   * branch to claim the delivery the channel push is about to make, so the
   * inbox watcher does not deliver the same message again.
   */
  deliveryDedupe?: { claim(deliveryId: string | undefined): boolean };
  /**
   * Phase 999.117 WS-4 — remembers where each delivery was rendered, so an
   * ack can be a REACTION on the original message instead of a whole new
   * post. Optional: without it, acks fall back to the plain-text notification
   * exactly as before.
   */
  presentations?: {
    record(deliveryId: string | undefined, ref: { channelId: string; messageId: string } | undefined): void;
    get(deliveryId: string | undefined): { channelId: string; messageId: string } | undefined;
  };
  /** Phase 999.117 WS-4 — add a reaction to an already-posted message. */
  reactionSender?: {
    react(channelId: string, messageId: string, emoji: string): Promise<void>;
  };
  loopGovernor?: {
    evaluate(input: {
      from: string;
      to: string;
      /**
       * Optional on purpose. Absent is the NORMAL case — the tool schema
       * carries no conversation id and the recipient never sees one to
       * thread back, so the governor derives the conversation itself from
       * the pair plus a recency window. Passing a minted id here would make
       * every message hop 1 of a fresh conversation and silently disable
       * three of the four bounds.
       */
      conversationId?: string;
      hops?: number;
      kind: InboxMessageKind;
      autoSubmitted: boolean;
    }): {
      allow: boolean;
      tripped: boolean;
      rule?: string;
      detail?: string;
      /**
       * The governor's RESOLVED conversation identity. Required, not
       * optional: the handler adopts these for the persisted envelope, and a
       * stub that omitted them would silently write an undefined
       * conversation — reintroducing the "every message is hop 1" defect the
       * derivation exists to fix.
       */
      conversationId: string;
      hops: number;
    };
  };
}>;

export type PostToAgentRequest = Readonly<{
  from: string;
  to: string;
  message: string;
  /**
   * Quick 260520-r70 — additive-optional message-role discriminator,
   * threaded into the `writeInbox` closure. Absent (existing callers) →
   * a normal "message" is written, behavior unchanged. The agent-to-agent
   * ack-emitter sets `kind: "ack"` so the ack reuses this exact
   * webhook→bot-direct→inbox-only cascade with no new delivery path.
   */
  kind?: InboxMessageKind;
  /**
   * Phase 999.117 WS-1 — envelope carried from the sender. Absent means
   * "this starts a fresh exchange", which is the correct default for an
   * agent messaging another out of the blue. A reply threads these through
   * so the governor can see how deep the exchange has gone.
   */
  conversationId?: string;
  causationId?: string;
  hops?: number;
  autoSubmitted?: boolean;
}>;

/**
 * Phase 999.117 WS-0 — which mechanism actually carried the message.
 *
 * `delivered: true` alone is not a truthful answer to "did the recipient get
 * it?", and the MCP wrapper renders it as *"Message delivered to X via their
 * Discord channel"* for every success. That sentence is false on the
 * `bot-direct` rung: the recipient's Discord bridge drops all bot-authored
 * messages that are not webhooks (bridge.ts handleMessage), so a bot-direct
 * post is seen by the OPERATOR only — the turn is actually driven by the
 * inbox watcher moments later. On prod that was 61 dispatches in one week,
 * every one reported to the sending LLM as a Discord delivery that never
 * happened. `via` lets the wrapper describe what really occurred.
 *
 *   - "v3-channel"    live ClawCode channel push — drives the turn directly
 *   - "webhook"       A2A embed under the sender's identity; the recipient's
 *                     bridge DOES relay this one back into a turn
 *   - "bot-direct"    plain bot post — operator-visible only, does NOT drive
 *                     a turn; the inbox watcher does
 *   - "self-channel"  self-targeted post echoed into the agent's own channel
 *   - "inbox"         no live presentation; the inbox watcher / heartbeat
 *                     reconciler drives the turn
 */
export type PostToAgentVia =
  /** Phase 999.117 WS-4 — an ack rendered as a reaction on the original. */
  | "reaction"
  | "v3-channel"
  | "webhook"
  | "bot-direct"
  | "self-channel"
  | "inbox";

export type PostToAgentResponse = Readonly<{
  ok: boolean;
  delivered: boolean;
  messageId: string;
  reason?: PostToAgentSkipReason;
  /** Phase 999.117 WS-0 — the mechanism that actually ran. */
  via?: PostToAgentVia;
}>;

/**
 * Execute the post-to-agent IPC contract.
 *
 * Throws `ManagerError("Target agent 'X' not found")` when validation fails
 * — matches pre-extraction behavior so existing callers stay green.
 *
 * For every other skip path returns `{ ok: true, delivered: false, reason }`
 * after writing to the inbox (so the heartbeat reconciler can still deliver).
 */
export async function handlePostToAgentIpc(
  req: PostToAgentRequest,
  deps: PostToAgentDeps,
): Promise<PostToAgentResponse> {
  // Phase 999.117 WS-5 — `requestedTo` is the caller's spelling; it is used
  // ONLY for resolution and the not-found message. Everything downstream uses
  // the resolved `to` below, so the inbox path, the routing lookup, the
  // governor budgets and the dedupe key can never disagree about identity.
  const { from, to: requestedTo, message, kind } = req;

  // 1. Validate target — fail loud (existing contract).
  // Phase 999.117 WS-5 — resolve through the shared addresser: exact name,
  // then operator-declared alias, then a UNIQUE case/space/dash-insensitive
  // match. An ambiguous match resolves to nothing rather than picking one —
  // silently delivering to the wrong agent is worse than failing, because
  // neither the sender nor the operator can tell it happened.
  const resolution = resolveAgentName(requestedTo, deps.configs);
  const targetConfig =
    resolution.kind === "exact" ||
    resolution.kind === "alias" ||
    resolution.kind === "normalised"
      ? deps.configs.find((c) => c.name === resolution.name)
      : undefined;
  if (!targetConfig) {
    deps.log.info(
      {
        from,
        to: requestedTo,
        reason: "target-not-found" satisfies PostToAgentSkipReason,
        resolution: resolution.kind,
        known: deps.configs.map((c) => c.name),
      },
      "post-to-agent skipped",
    );
    // Phase 999.117 WS-0 — a bare "not found" gave the sending LLM nothing
    // to correct with, so it would guess again or give up silently. One prod
    // agent is literally named "Admin Clawdy" — space and capitals — so
    // `to: "admin"` is the natural guess and it failed with no hint at all.
    // Listing the valid targets makes the next tool call self-correcting.
    throw new ManagerError(
      describeResolutionFailure(requestedTo, resolution, deps.configs),
    );
  }

  // From here on `to` IS the resolved name. Shadowing once beats threading a
  // second variable through thirty call sites, where a single missed one
  // would address a different agent than the rest of the function.
  const to = targetConfig.name;

  // 1b. WS-0 (quick 260716-u5h) — self-targeted post short-circuits to
  //     channel-only delivery. A self-post means "put this in MY channel"
  //     (the 999.99 background-output escape hatch); the inbox write and the
  //     v3 push are both self-echo vectors — the agent would consume its own
  //     post as a fresh turn, respond to it, post again (the 2026-07-16
  //     Admin Clawdy incident chain). Delivery: plain-text webhook wearing
  //     the agent's own identity (no A2A embed footer → the bridge cannot
  //     route it back), bot-direct fallback. No inbox record, no ack, no
  //     turn. Covers every kind, acks included (a self-ack has no consumer
  //     to inform).
  if (from === to) {
    const selfMessageId = `self-${nanoid()}`;
    const selfChannelId =
      deps.agentChannels.get(to)?.[0] ?? targetConfig.channels?.[0];
    if (deps.webhookManager.hasWebhook(to) && deps.webhookManager.send) {
      try {
        await deps.webhookManager.send(to, message);
        deps.log.info(
          { from, to, messageId: selfMessageId, via: "self-webhook" },
          "post-to-agent self-post delivered to own channel",
        );
        return { ok: true, delivered: true, messageId: selfMessageId, via: "self-channel" };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          { from, to, messageId: selfMessageId, error: errMsg },
          "post-to-agent self-post webhook failed (trying bot-direct)",
        );
      }
    }
    if (deps.botDirectSender && selfChannelId) {
      try {
        await deps.botDirectSender.sendText(selfChannelId, message);
        deps.log.info(
          { from, to, messageId: selfMessageId, channelId: selfChannelId, via: "self-bot-direct" },
          "post-to-agent self-post delivered to own channel",
        );
        return { ok: true, delivered: true, messageId: selfMessageId, via: "self-channel" };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          { from, to, messageId: selfMessageId, channelId: selfChannelId, error: errMsg },
          "post-to-agent self-post bot-direct failed",
        );
      }
    }
    deps.log.info(
      { from, to, messageId: selfMessageId, reason: "self-target-no-delivery" satisfies PostToAgentSkipReason },
      "post-to-agent skipped",
    );
    return { ok: true, delivered: false, messageId: selfMessageId, reason: "self-target-no-delivery" };
  }

  // 1c. Phase 999.117 WS-3 — loop governance. Evaluated BEFORE the inbox
  //     write on purpose: a suppressed message must leave no inbox record,
  //     or the watcher would deliver it anyway and the bound would be
  //     decorative. This is also the single counting point — the one place
  //     every A2A message passes through exactly once.
  //
  //     Self-posts are already short-circuited above and never reach here,
  //     so the governor only ever sees genuine cross-agent traffic.
  const autoSubmitted = req.autoSubmitted ?? kind === "ack";
  // Deliberately DO NOT mint a conversation id here. The governor derives it
  // from the unordered pair plus a recency window when the caller has none —
  // and the caller almost never has one, because `post_to_agent` accepts only
  // {from, to, message} and the recipient never sees an id it could thread
  // back. Minting one here would hand the governor a fresh id every message,
  // making every message hop 1 of a new conversation and silently disabling
  // maxHops, conversationCap AND maxConsecutiveAutoReplies. (That is exactly
  // what the first cut of this code did; the unit tests missed it because
  // they passed conversationId explicitly.)
  let envelope = {
    conversationId: req.conversationId,
    hops: typeof req.hops === "number" && req.hops > 0 ? req.hops : undefined,
    autoSubmitted,
  } as { conversationId?: string; hops?: number; autoSubmitted: boolean };
  if (deps.loopGovernor) {
    const verdict = deps.loopGovernor.evaluate({
      from,
      to,
      conversationId: req.conversationId,
      hops: envelope.hops,
      kind: kind ?? "message",
      autoSubmitted,
    });
    // Adopt the governor's resolved identity — it owns the derivation, so
    // this is what must be persisted for the next hop to line up.
    envelope = {
      conversationId: verdict.conversationId,
      hops: verdict.hops,
      autoSubmitted,
    };
    if (verdict.tripped) {
      deps.log.warn(
        {
          from,
          to,
          conversationId: envelope.conversationId,
          hops: envelope.hops,
          rule: verdict.rule,
          detail: verdict.detail,
          enforced: !verdict.allow,
        },
        "[999.117] a2a loop guard tripped",
      );
    }
    if (!verdict.allow) {
      deps.log.info(
        { from, to, reason: "loop-guard" satisfies PostToAgentSkipReason },
        "post-to-agent skipped",
      );
      // Throw rather than return a soft failure. The sender is an LLM mid-
      // turn; a `delivered: false` reads as "retry later" and it would, which
      // is the loop. An error with the reason in it is the stop signal.
      throw new ManagerError(
        `Message to '${to}' blocked by the agent-to-agent loop guard ` +
          `(${verdict.rule}). ${verdict.detail ?? ""} ` +
          `Do not retry — if this exchange genuinely needs to continue, ` +
          `surface it to the operator instead.`,
      );
    }
  }

  // 2. Inbox-write first — the canonical fallback. Heartbeat reconciler
  //    (src/heartbeat/checks/inbox.ts) drains this for every agent so the
  //    message still lands eventually even when webhook delivery fails.
  let messageId: string;
  try {
    const written = await deps.writeInbox({
      from,
      to,
      content: message,
      kind,
      // Phase 999.117 WS-1 — envelope travels with the message so the
      // recipient's reply can carry the conversation forward and the
      // governor can see the true depth on the next hop.
      // No governor wired (tests, pre-bridge boot) → mint here so the
      // persisted message still carries a usable envelope.
      conversationId: envelope.conversationId ?? nanoid(),
      causationId: req.causationId,
      hops: envelope.hops ?? 1,
      autoSubmitted: envelope.autoSubmitted,
    });
    messageId = written.messageId;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    deps.log.warn(
      {
        from,
        to,
        reason: "inbox-write-failed" satisfies PostToAgentSkipReason,
        error: errMsg,
      },
      "post-to-agent skipped",
    );
    // Throw — inbox write is the floor of the delivery contract. If we
    // can't even write the inbox file we have nothing to return.
    throw new ManagerError(`Inbox write failed for '${to}': ${errMsg}`);
  }

  // 2a. WS-0 (quick 260716-u5h) — acks are channel-visible notifications,
  //     NEVER turn inputs. Three turn-vectors are deliberately bypassed for
  //     kind "ack": the v3 bridge push (would land in the agent's chat as
  //     input), the A2A webhook embed (the recipient's bridge forwards A2A
  //     embeds back into the agent as an "[Agent Message from …]" turn),
  //     and the inbox copy (consumers markProcessed acks without dispatch —
  //     see inbox-source.ts / heartbeat inbox check). Delivery is bot-direct
  //     plain text: the bridge drops plain bot posts, so the ack is visible
  //     in the channel and nothing more. 2026-07-16 Admin Clawdy self-echo
  //     incident.
  if (kind === "ack") {
    // Phase 999.117 WS-4 — react on the ORIGINAL message when we know where
    // it was rendered.
    //
    // An ack is a receipt, not a conversation. Posting it as its own message
    // (51 in one week on prod, roughly one per real message) makes the
    // operator read past a line that says nothing the original message could
    // not say by wearing a checkmark. A reaction lands exactly where they are
    // already looking and stacks states on one message instead of
    // accumulating posts. `causationId` is the id of the message being
    // acked, which is what the registry is keyed on.
    const originalRef = deps.presentations?.get(req.causationId);
    if (deps.reactionSender && originalRef) {
      try {
        await deps.reactionSender.react(
          originalRef.channelId,
          originalRef.messageId,
          RECEIPT_EMOJI.processed,
        );
        deps.log.info(
          { from, to, messageId, causationId: req.causationId, via: "ack-reaction" },
          "post-to-agent ack rendered as a reaction",
        );
        return { ok: true, delivered: true, messageId, via: "reaction" };
      } catch (err) {
        // Fall through to the text notification — a failed decoration must
        // never cost the operator the receipt entirely.
        deps.log.warn(
          {
            from,
            to,
            messageId,
            error: err instanceof Error ? err.message : String(err),
          },
          "ack reaction failed (falling back to text notification)",
        );
      }
    }

    const ackChannelId =
      deps.agentChannels.get(to)?.[0] ?? targetConfig.channels?.[0];
    if (deps.botDirectSender && ackChannelId) {
      try {
        await deps.botDirectSender.sendText(ackChannelId, message);
        deps.log.info(
          { from, to, messageId, channelId: ackChannelId, via: "ack-bot-direct" },
          "post-to-agent ack posted as channel notification",
        );
        return { ok: true, delivered: true, messageId, via: "bot-direct" };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          { from, to, messageId, channelId: ackChannelId, error: errMsg },
          "post-to-agent ack bot-direct send failed (inbox audit record only)",
        );
      }
    }
    deps.log.info(
      { from, to, messageId, reason: "ack-notification-only" satisfies PostToAgentSkipReason },
      "post-to-agent skipped",
    );
    return { ok: true, delivered: false, messageId, reason: "ack-notification-only" };
  }

  // 2b. Phase 140 #14b — v3 target: deliver via the live ClawCode channel.
  //     For a `claude-code-interactive` agent the daemon is OUT of the chat-turn
  //     hot path; the webhook→bot-direct→inbox-heartbeat cascade below ends in a
  //     turn-dispatch that drives a v2 agent but cannot reach a v3 one. The
  //     bridge push IS the live delivery. The inbox-write above stays as the
  //     persistent floor. v2/SDK targets (no bridge) fall through unchanged.
  //     Reuse `messageId` as the channel message_id so the inbox record and the
  //     channel push share one correlation id.
  const bridge = deps.getBridge?.(to);
  if (bridge) {
    bridge.push({
      type: "a2a",
      message_id: messageId,
      content: message,
      meta: { source_agent: from },
    });
    // Phase 999.117 WS-2 (F8) — claim the delivery. The inbox record written
    // above is the durable floor, but the channel push IS the live delivery;
    // without claiming, the InboxSource watcher picks the same file up and
    // delivers it a second time. This path returned early without retiring
    // the record, so every v3 target got every message twice — dormant only
    // because prod currently runs zero v3 agents.
    deps.deliveryDedupe?.claim(messageId);
    deps.log.info(
      { from, to, messageId, via: "v3-channel" },
      "post-to-agent delivered via v3 channel",
    );
    return { ok: true, delivered: true, messageId, via: "v3-channel" };
  }

  // 3. Webhook delivery — best-effort. Each silent-skip emits a structured
  //    log with `reason`.
  const targetChannels = deps.agentChannels.get(to);
  if (!targetChannels || targetChannels.length === 0) {
    deps.log.info(
      { from, to, messageId, reason: "no-target-channels" satisfies PostToAgentSkipReason },
      "post-to-agent skipped",
    );
    // No channelId resolvable on the no-target-channels path — counter
    // remains uncounted here (Sentinel B keeps the count at 2 via the
    // bot-direct site + the inbox-only-with-channelId site below).
    return inboxOnlyResponse(messageId, "no-target-channels", deps, from, to);
  }

  // A2A embeds may use an A2A-only identity — that is exactly what those
  // identities are for. Ordinary replies still go through `hasWebhook`.
  const targetHasA2aWebhook =
    deps.webhookManager.hasA2aWebhook?.(to) ??
    deps.webhookManager.hasWebhook(to);
  if (!targetHasA2aWebhook) {
    // Phase 119 A2A-01 — bot-direct fallback rung (mirror of
    // daemon-ask-agent-ipc.ts:262-299 per D-01). Attempts plain-text
    // delivery via the bot client BEFORE falling through to the inbox-
    // heartbeat path. On success returns delivered=true; on send failure
    // or no resolved channel, falls through to inboxOnlyResponse.
    if (deps.botDirectSender) {
      const channelId =
        deps.agentChannels.get(to)?.[0] ??
        targetConfig.channels?.[0];
      if (channelId) {
        try {
          const posted = await deps.botDirectSender.sendText(channelId, message);
          // Phase 999.117 WS-4 — same reason as the webhook rung above.
          if (typeof posted === "string") {
            deps.presentations?.record(messageId, { channelId, messageId: posted });
          }
          // Phase 119 D-05 — bot-direct success IS a fallback dispatch.
          // Site 1 of 2; site 2 is in inboxOnlyResponse. Sentinel B in the
          // test suite pins the call-site count to exactly 2 so a future
          // refactor cannot silently over- or under-count.
          incrementNoWebhookFallback(to, channelId);
          deps.log.info(
            {
              agent: to,
              channel: channelId,
              reason: "bot-direct-fallback",
            },
            "[A2A-01] bot-direct dispatch",
          );
          return { ok: true, delivered: true, messageId, via: "bot-direct" };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          deps.log.warn(
            { from, to, channelId, error: errMsg },
            "[A2A-01] bot-direct dispatch failed (falling through to inbox)",
          );
        }
      }
    }
    deps.log.info(
      { from, to, messageId, reason: "no-webhook" satisfies PostToAgentSkipReason },
      "post-to-agent skipped",
    );
    return inboxOnlyResponse(
      messageId,
      "no-webhook",
      deps,
      from,
      to,
      targetChannels[0],
    );
  }

  const senderConfig = deps.configs.find((c) => c.name === from);
  const senderDisplayName = senderConfig?.webhook?.displayName ?? from;
  const senderAvatarUrl = senderConfig?.webhook?.avatarUrl;
  // Phase 999.117 WS-2 — carry the deliveryId into the embed so the bridge
  // relay can recognise it as the same logical message the inbox watcher is
  // already delivering. `messageId` IS the deliveryId (createMessage defaults
  // deliveryId to the message id), so the two paths share one key.
  //
  // Phase 999.144 — sign what is POSTED: the signature binds the truncated
  // description (the exact string the relay will read back from the embed),
  // the deliveryId, and both endpoints. No secret (pre-boot window) → the
  // embed goes out unsigned and the relay's shadow/no-secret handling applies.
  const signedDescription = truncateA2aDescription(message);
  const identitySecret = getProcessIdentitySecret();
  const envelopeSig =
    identitySecret !== null
      ? signA2aEnvelope(identitySecret, {
          deliveryId: messageId,
          sender: from,
          recipient: to,
          content: signedDescription,
        })
      : undefined;
  const embed = buildAgentMessageEmbed(
    from,
    senderDisplayName,
    signedDescription,
    messageId,
    envelopeSig,
  );

  try {
    const posted = await deps.webhookManager.sendAsAgent(
      to,
      senderDisplayName,
      senderAvatarUrl,
      embed,
    );
    // Phase 999.117 WS-4 — remember where this rendered so the recipient's
    // ack can land as a reaction here rather than as a fresh post.
    if (typeof posted === "string") {
      deps.presentations?.record(messageId, {
        channelId: targetChannels[0],
        messageId: posted,
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    deps.log.warn(
      {
        from,
        to,
        messageId,
        reason: "webhook-send-failed" satisfies PostToAgentSkipReason,
        error: errMsg,
      },
      "post-to-agent skipped",
    );
    return inboxOnlyResponse(
      messageId,
      "webhook-send-failed",
      deps,
      from,
      to,
      targetChannels[0],
    );
  }

  return { ok: true, delivered: true, messageId, via: "webhook" };
}

/**
 * Build the "inbox-only" return shape AND log the optional second-degree
 * skip reason: `target-not-running`. Heartbeat reconciler can't dispatch a
 * turn to a stopped process, so when both webhook is unreachable AND the
 * agent is offline we surface that secondary reason for operator visibility.
 *
 * Phase 119 D-05 — when `channelId` is resolved (caller had a target
 * channel even if delivery failed for another reason), increments the
 * `no_webhook_fallbacks_total` counter so the dashboard tile surfaces the
 * inbox-only landing. Site 2 of 2 — Sentinel B in the test suite pins the
 * call-site count to exactly 2. When `channelId` is undefined (the
 * no-target-channels skip path), the counter is NOT incremented — that key
 * shape (`agent:`) is meaningless to operators.
 */
function inboxOnlyResponse(
  messageId: string,
  reason: PostToAgentSkipReason,
  deps: PostToAgentDeps,
  from: string,
  to: string,
  channelId?: string,
): PostToAgentResponse {
  if (channelId) {
    incrementNoWebhookFallback(to, channelId);
  }
  if (!deps.runningAgents.includes(to)) {
    deps.log.info(
      {
        from,
        to,
        messageId,
        reason: "target-not-running" satisfies PostToAgentSkipReason,
        primaryReason: reason,
      },
      "post-to-agent skipped",
    );
  }
  return { ok: true, delivered: false, messageId, reason, via: "inbox" };
}
