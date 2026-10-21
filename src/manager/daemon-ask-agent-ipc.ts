/**
 * Phase 999.2 Plan 03 — daemon `ask-agent` IPC handler (pure-DI).
 *
 * Extracted from `src/manager/daemon.ts` `case "ask-agent":` body so the v2
 * sync-reply contract can be exercised without spawning the full daemon.
 * Mirrors the Phase 103 daemon-rate-limit-ipc.ts blueprint and the Phase 96
 * daemon-fs-ipc.ts shape.
 *
 * Behavior contract (D-SYN-01..06, D-PST-03):
 *   1. ALWAYS write inbox first (preserves offline-path inbox guarantee).
 *   2. If target is NOT running → return {ok: true, messageId, response: undef}.
 *      MCP wrapper renders explicit-offline text. (A2A-12)
 *   3. If mirror_to_target_channel=true AND target has a webhook → post a
 *      prompt embed (caller's identity) BEFORE dispatch. Webhook failure is
 *      best-effort logged and does NOT abort the ask (Pitfall 7).
 *   4. Dispatch the turn (`deps.dispatchTurn(to, content)`). Errors PROPAGATE
 *      — there is no `try {...} catch {}` around this call. The MCP wrapper
 *      renders `Failed to ask {to}: {error.message}` on caught error. (A2A-11)
 *   5. If mirror=true AND target has a webhook AND response truthy → post a
 *      response embed (target's identity, description prepended with the
 *      Pitfall-4 reply-threading blockquote `> reply to {from}:\n\n`). Same
 *      best-effort wrapping as the prompt mirror.
 *   6. Return {ok: true, messageId, response}. MCP wrapper renders the reply
 *      in the tool-result text — fixes the 2026-04-29 smoking-gun bug. (A2A-09)
 *
 * Notes:
 * - Escalation handling stays in the daemon edge (the `escalationMonitor`
 *   path inspects `response` text for indicator strings AND can re-dispatch
 *   on a fork). Plan 03 keeps that path UNCHANGED — escalation reads the
 *   response returned by this module and may overwrite it before returning
 *   to the IPC client. The decision to keep escalation outside this module
 *   matches the deps shape: escalation needs the SessionManager, not just a
 *   dispatcher closure.
 * - `webhookManager.sendAsAgent` returns the message id `Promise<string>`;
 *   we don't read it (best-effort fire-and-forget for the mirror).
 */
import type { EmbedBuilder } from "discord.js";
import type { DaemonChannelMessage } from "../channels/clawcode-channel-server.js";
import { buildAgentMessageEmbed } from "../discord/agent-message.js";
import { ManagerError } from "../shared/errors.js";

/**
 * Phase 140 #14b(ask) — narrow daemon-side bridge surface for the v3 path.
 * Structurally satisfied by `AgentChannelBridge` (push + awaitReply).
 */
export type AskAgentChannelBridge = {
  push(msg: DaemonChannelMessage): void;
  awaitReply(
    correlationId: string,
    timeoutMs?: number,
  ): Promise<{ readonly result?: string }>;
};

/** Minimal config shape consumed by the handler — readonly subset. */
export type AskAgentAgentConfigLike = Readonly<{
  name: string;
  webhook?: Readonly<{
    displayName: string;
    avatarUrl?: string;
    webhookUrl?: string;
  }>;
  /**
   * Phase 999.12 IPC-02 — bound channel IDs. Used by the bot-direct fallback
   * when `agentChannels` (routing-table snapshot) doesn't have a binding,
   * matching the `triggerDeliveryFn` channel-resolution path at daemon.ts:2212.
   */
  channels?: readonly string[];
}>;

/** Minimal pino-like logger surface. */
export type AskAgentLogger = Readonly<{
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}>;

/** Minimal WebhookManager surface — extends to whatever the production class exposes. */
export type AskAgentWebhookManagerLike = Readonly<{
  hasWebhook(agentName: string): boolean;
  /**
   * 2026-09-03 — includes A2A-only identities (auto-provisioned for agents
   * with no `webhook:` block). The ask mirrors are agent-to-agent embeds, so
   * they use this; ordinary replies keep using `hasWebhook`. Optional so
   * narrowed test doubles compile; falls back to `hasWebhook`.
   */
  hasA2aWebhook?(agentName: string): boolean;
  sendAsAgent(
    targetAgent: string,
    senderDisplayName: string,
    senderAvatarUrl: string | undefined,
    embed: EmbedBuilder,
  ): Promise<string | void>;
}>;

/** Inbox-write closure (production wraps `writeMessage` + `createMessage`). */
export type AskAgentInboxWriter = (params: {
  from: string;
  to: string;
  content: string;
  priority: string;
}) => Promise<{ messageId: string }>;

/** Dependency surface — pure-DI for testability. */
export type AskAgentDeps = Readonly<{
  /** Names of currently-running agents. Array or Set both supported. */
  runningAgents: readonly string[] | ReadonlySet<string>;
  /** Dispatches a turn to the target and returns its response text. */
  dispatchTurn: (to: string, content: string) => Promise<string>;
  /** Persists the message to the target's inbox; returns the message id. */
  writeInbox: AskAgentInboxWriter;
  /** Webhook manager for the optional `mirror_to_target_channel` path. */
  webhookManager: AskAgentWebhookManagerLike;
  /** Resolved agent configs — used to look up webhook display name + avatar. */
  configs: readonly AskAgentAgentConfigLike[];
  /** Logger for best-effort mirror-failure warnings. */
  log: AskAgentLogger;
  /**
   * Phase 999.12 IPC-02 — optional bot-direct sender for the no-webhook
   * fallback path. When the target agent has no webhook configured,
   * `mirror_to_target_channel: true` falls back to plain-text via this
   * sender (matches `triggerDeliveryFn` shape at daemon.ts:2200-2248).
   * Optional: pre-bridge boot leaves the sender unwired, in which case the
   * mirror is silently skipped and the ask still returns successfully.
   */
  botDirectSender?: { sendText(channelId: string, text: string): Promise<void> };
  /**
   * Phase 999.12 IPC-02 — agent → channel-IDs map (routingTable.agentToChannels).
   * Used to resolve the target's bound channel for the bot-direct fallback.
   * Falls through to `configs.find(c => c.name === to).channels?.[0]` when
   * the routing table doesn't have a binding (test-only path).
   */
  agentChannels?: ReadonlyMap<string, readonly string[]>;
  /**
   * Phase 140 #14b(ask) — v3 ClawCode-channel bridge resolver. When the target
   * runs the `claude-code-interactive` backend, ask over the live channel
   * (`push` with a reply correlation + `awaitReply`) instead of `dispatchTurn`,
   * which does not drive a v3 agent's chat turns. `undefined` for v2/SDK targets
   * → unchanged dispatchTurn path. The v3 agent replies in its OWN Discord
   * channel, so the v2-only webhook mirrors are skipped on this branch.
   */
  getBridge?: (agent: string) => AskAgentChannelBridge | undefined;
  /** v3 reply-wait deadline (ms). Defaults to 30s. */
  replyTimeoutMs?: number;
  /**
   * Phase 999.117 WS-3 — the SAME loop governor instance the post-to-agent
   * handler uses. `ask_agent` is the more loop-shaped of the two tools —
   * synchronous request/reply IS the A-to-B conversation being bounded — and
   * it is deliberately registered first in the MCP tool list to steer agents
   * toward it. Leaving it ungoverned would mean the bound covered one of two
   * live entry paths, which is the same silent-bifurcation shape this phase
   * exists to remove. Optional so existing test doubles compile unchanged.
   */
  loopGovernor?: {
    evaluate(input: {
      from: string;
      to: string;
      conversationId?: string;
      hops?: number;
      kind: "message" | "ack";
      autoSubmitted: boolean;
    }): {
      allow: boolean;
      tripped: boolean;
      rule?: string;
      detail?: string;
      conversationId: string;
      hops: number;
    };
  };
}>;

/** Wire param shape accepted by the handler. */
export type AskAgentParams = Readonly<{
  from: string;
  to: string;
  content: string;
  priority?: string;
  mirror_to_target_channel?: boolean;
}>;

/** Wire result shape returned by the handler. */
export type AskAgentResult = Readonly<{
  ok: true;
  messageId: string;
  /** Undefined when target was not running (offline path — A2A-12). */
  response?: string;
}>;

/**
 * Build a fully-defaulted `AskAgentDeps` from partial overrides. Used by tests
 * to wire only the fields each test cares about; production daemon constructs
 * the full deps directly at the case-body call site.
 */
export function buildAskAgentDeps(
  overrides: Partial<AskAgentDeps> = {},
): AskAgentDeps {
  const noopLog: AskAgentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const noopWebhookManager: AskAgentWebhookManagerLike = {
    hasWebhook: () => false,
    sendAsAgent: async () => {},
  };
  return {
    runningAgents: overrides.runningAgents ?? [],
    dispatchTurn: overrides.dispatchTurn ?? (async () => ""),
    writeInbox:
      overrides.writeInbox ??
      (async () => ({ messageId: "test-msg-id" })),
    webhookManager: overrides.webhookManager ?? noopWebhookManager,
    configs: overrides.configs ?? [],
    log: overrides.log ?? noopLog,
    // Phase 999.12 IPC-02 — pass through when set; undefined means
    // "skip bot-direct fallback" (production wires real values; tests that
    // don't care leave them out).
    ...(overrides.botDirectSender !== undefined
      ? { botDirectSender: overrides.botDirectSender }
      : {}),
    ...(overrides.agentChannels !== undefined
      ? { agentChannels: overrides.agentChannels }
      : {}),
    ...(overrides.getBridge !== undefined
      ? { getBridge: overrides.getBridge }
      : {}),
    ...(overrides.replyTimeoutMs !== undefined
      ? { replyTimeoutMs: overrides.replyTimeoutMs }
      : {}),
  };
}

function isRunning(
  set: AskAgentDeps["runningAgents"],
  name: string,
): boolean {
  if (Array.isArray(set)) return set.includes(name);
  // ReadonlySet<string>
  return (set as ReadonlySet<string>).has(name);
}

/**
 * Handle an `ask-agent` IPC request. See module docstring for behavior.
 *
 * Errors from `deps.dispatchTurn` propagate (D-SYN-05) — caller is expected
 * to surface them as `Failed to ask {to}: {error.message}` text in the MCP
 * wrapper.
 */
export async function handleAskAgentIpc(
  params: AskAgentParams,
  deps: AskAgentDeps,
): Promise<AskAgentResult> {
  const { from, to, content } = params;
  const priority = params.priority ?? "normal";
  const mirror = params.mirror_to_target_channel === true;
  // The ask mirrors post an AGENT-TO-AGENT embed into the target's channel,
  // so they may use an A2A-only identity — that is precisely what those
  // identities exist for. `hasWebhook` deliberately hides them (it gates
  // ordinary replies, which must stay on the bot), so asking it here left
  // ask_agent with no webhook path at all.
  const targetHasA2aWebhook =
    deps.webhookManager.hasA2aWebhook?.(to) ??
    deps.webhookManager.hasWebhook(to);

  // 1. Always write inbox first — preserves offline-path inbox guarantee even
  //    when the target is running (a record of the prompt is durable).
  // Phase 999.117 WS-3 — governed on the same budgets as post-to-agent, and
  // BEFORE the inbox write so a suppressed ask leaves no record for the
  // watcher to deliver anyway. Throwing (rather than returning a degraded
  // result) is deliberate: the caller is an LLM mid-turn and a soft failure
  // reads as "retry", which is the loop.
  if (deps.loopGovernor) {
    const verdict = deps.loopGovernor.evaluate({
      from,
      to,
      kind: "message",
      autoSubmitted: false,
    });
    if (verdict.tripped) {
      deps.log.warn(
        {
          from,
          to,
          conversationId: verdict.conversationId,
          hops: verdict.hops,
          rule: verdict.rule,
          enforced: !verdict.allow,
        },
        "[999.117] a2a loop guard tripped (ask-agent)",
      );
    }
    if (!verdict.allow) {
      throw new ManagerError(
        `Ask to '${to}' blocked by the agent-to-agent loop guard ` +
          `(${verdict.rule}). ${verdict.detail ?? ""} ` +
          `Do not retry — if this exchange genuinely needs to continue, ` +
          `surface it to the operator instead.`,
      );
    }
  }

  const { messageId } = await deps.writeInbox({ from, to, content, priority });

  if (!isRunning(deps.runningAgents, to)) {
    // A2A-12 — offline path. No dispatch, no mirror.
    return { ok: true, messageId };
  }

  // 1b. Phase 140 #14b(ask) — v3 target: ask over the live ClawCode channel.
  //     Push the prompt with a reply correlation (reusing messageId as the
  //     correlation id) and await the agent's clawcode_ack(result). dispatchTurn
  //     does NOT drive a v3 turn, so this is the correct delivery; the v3 agent
  //     surfaces its reply in its own Discord channel, so the v2 webhook mirrors
  //     are skipped here. On timeout we return response-undefined (same shape as
  //     the offline path — a degraded ask, never a throw).
  const bridge = deps.getBridge?.(to);
  if (bridge) {
    // Phase 140-12 (live-E2E finding): the system prompt alone does NOT reliably
    // make the agent ack — it tends to answer as plain text. An IN-CONTEXT,
    // per-message ack instruction (with the exact message_id) is reliable: the
    // agent processes the turn AND calls clawcode_ack so the synchronous caller
    // gets the reply. Verified: agent computed the answer but didn't ack until
    // the message itself said to.
    const askContent =
      `${content}\n\n[REPLY REQUIRED — when done, call the clawcode_ack tool with ` +
      `message_id "${messageId}", status "processed", and your full answer in "result". ` +
      `Do not just reply in chat; the asker only receives your clawcode_ack result.]`;
    bridge.push({
      type: "a2a",
      message_id: messageId,
      content: askContent,
      meta: { source_agent: from, reply_correlation_id: messageId },
    });
    try {
      const ack = await bridge.awaitReply(messageId, deps.replyTimeoutMs ?? 30_000);
      return { ok: true, messageId, response: ack.result };
    } catch (err) {
      deps.log.warn(
        { from, to, err: err instanceof Error ? err.message : String(err) },
        "[ask-agent] v3 channel reply timeout (returning without response)",
      );
      return { ok: true, messageId };
    }
  }

  // 2. Pre-dispatch mirror — best-effort, never aborts the ask (Pitfall 7).
  if (mirror && targetHasA2aWebhook) {
    try {
      const senderConfig = deps.configs.find((c) => c.name === from);
      const senderDisplayName =
        senderConfig?.webhook?.displayName ?? from;
      const senderAvatarUrl = senderConfig?.webhook?.avatarUrl;
      // Phase 999.144 — DELIBERATELY UNSIGNED. Mirrors are display-only: the
      // turn is dispatched by dispatchTurn() below, so a mirror that also
      // dispatched via the relay was the ask-agent double-run. No id, no
      // signature ⇒ under envelopeAuth: enforce the relay refuses to
      // dispatch it, which is exactly the desired behavior. Do NOT sign.
      const embed = buildAgentMessageEmbed(from, senderDisplayName, content);
      await deps.webhookManager.sendAsAgent(
        to,
        senderDisplayName,
        senderAvatarUrl,
        embed,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        { from, to, err: errMsg },
        "[ask-agent] mirror prompt webhook failed (best-effort, ask continues)",
      );
    }
  }

  // 3. Dispatch the turn — errors PROPAGATE (D-SYN-05). No try/catch here.
  const response = await deps.dispatchTurn(to, content);

  // 4. Post-dispatch mirror — best-effort, never aborts the ask.
  if (mirror && response && targetHasA2aWebhook) {
    try {
      const targetConfig = deps.configs.find((c) => c.name === to);
      const targetDisplayName =
        targetConfig?.webhook?.displayName ?? to;
      const targetAvatarUrl = targetConfig?.webhook?.avatarUrl;
      // Pitfall 4 — Discord webhooks can't natively reply-thread; prepend the
      // description with a blockquote `> reply to {from}:\n\n` so an operator
      // scrolling the target's channel sees the visual link.
      const embedBody = `> reply to ${from}:\n\n${response}`;
      // Phase 999.144 — DELIBERATELY UNSIGNED display-only mirror (see the
      // pre-dispatch mirror above for the rationale).
      const embed = buildAgentMessageEmbed(
        to,
        targetDisplayName,
        embedBody,
      );
      await deps.webhookManager.sendAsAgent(
        to,
        targetDisplayName,
        targetAvatarUrl,
        embed,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        { from, to, err: errMsg },
        "[ask-agent] mirror response webhook failed (best-effort, ask continues)",
      );
    }
  }

  // 5. Phase 999.12 IPC-02 — bot-direct fallback for the response mirror when
  //    the target has NO webhook. Plain text (matches triggerDeliveryFn at
  //    daemon.ts:2239-2242). Best-effort — never aborts the ask.
  if (
    mirror &&
    response &&
    !targetHasA2aWebhook &&
    deps.botDirectSender
  ) {
    const channelId =
      deps.agentChannels?.get(to)?.[0] ??
      deps.configs.find((c) => c.name === to)?.channels?.[0];
    if (!channelId) {
      deps.log.warn(
        { from, to },
        "[ask-agent] mirror response: no channel resolved for target (best-effort, ask continues)",
      );
    } else {
      try {
        // Discord hard limit is 2000 chars per message. Truncate + ellipsis —
        // verbatim shape from triggerDeliveryFn (daemon.ts:2224-2229).
        const MAX = 2000;
        const ELLIPSIS = "...";
        const truncated =
          response.length > MAX
            ? response.slice(0, MAX - ELLIPSIS.length) + ELLIPSIS
            : response;
        await deps.botDirectSender.sendText(channelId, truncated);
        deps.log.info(
          { to, channel: channelId, responseLength: response.length },
          "agent response sent to Discord",
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          { from, to, channelId, err: errMsg },
          "[ask-agent] mirror response bot-direct failed (best-effort, ask continues)",
        );
      }
    }
  }

  return { ok: true, messageId, response };
}
