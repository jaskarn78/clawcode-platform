/**
 * MessagingBridge — the platform-neutral turn loop.
 *
 * Wires a `MessagingPlatform` adapter to the existing ClawCode turn pipeline
 * (`TurnDispatcher` → `SessionManager`). One instance per adapter. Discord
 * keeps its own mature `DiscordBridge`; this bridge serves every NEW platform,
 * so the value-adds below are written once rather than duplicated per platform:
 *
 *   - inbound → agent routing (per-platform routing table)
 *   - `<channel source="…">` framing via formatAgentMessage
 *   - progressive streaming (best-effort, capability-gated edits)
 *   - per-agent identity on outbound
 *   - thread-aware replies (reply where the user spoke)
 *   - queue-state reactions (working → delivered/failed), gated on capability
 *   - graceful degradation: a missing capability becomes a no-op, never a throw
 *
 * What v1 intentionally does NOT do (documented scope-out): advisor footer,
 * subagent-thread spawning, embeds/Block-Kit, inbound attachments, slash
 * commands. Those are Discord-only today and land in later phases.
 */
import type { Logger } from "pino";
import type { TurnDispatcher } from "../manager/turn-dispatcher.js";
import { makeRootOrigin, type SourceKind } from "../manager/turn-origin.js";
import type { PlatformRoutingTable } from "./router.js";
import { formatAgentMessage } from "./format.js";
import { splitMessage } from "./split.js";
import type {
  AgentIdentity,
  InboundMessage,
  MessageHandle,
  MessagingPlatform,
} from "./types.js";

/** Minimum gap between progressive in-place edits (rate-limit friendly). */
const PROGRESSIVE_EDIT_MS = 1_200;

/** Bound for the at-least-once dedup cache (oldest entries evicted). */
const MAX_SEEN_MESSAGES = 2_000;

/**
 * Default "working" placeholder text. On platforms with no native typing
 * indicator (Slack), this is posted immediately when a turn starts and then
 * edited into the final reply — the Slack-native substitute for "is typing…".
 */
const DEFAULT_WORKING_PLACEHOLDER = "_…_";

export type MessagingBridgeConfig = {
  readonly adapter: MessagingPlatform;
  /** Live routing table ref (rebuilt on config reload). */
  readonly routingTableRef: { readonly current: PlatformRoutingTable };
  readonly turnDispatcher: TurnDispatcher;
  /** Per-agent outbound identity (display name / icon). */
  readonly identityResolver: (agentName: string) => AgentIdentity;
  /** Optional per-agent timezone for agent-visible timestamps. */
  readonly agentTzResolver?: (agentName: string) => string | undefined;
  /**
   * Apply queue-state reactions (working → delivered/failed) on the user's
   * message. Default FALSE — on Slack these read as noise (a 👀 then ✅ on
   * every message). The "working" affordance is the placeholder below instead.
   */
  readonly statusReactions?: boolean;
  /**
   * Text posted immediately as a "working" message when the platform has no
   * native typing indicator (and can edit messages); it's then edited into the
   * reply. Defaults to a subtle "_…_". Set to null to disable entirely.
   */
  readonly workingPlaceholder?: string | null;
  readonly log: Logger;
};

export class MessagingBridge {
  private readonly adapter: MessagingPlatform;
  private readonly routingTableRef: { readonly current: PlatformRoutingTable };
  private readonly turnDispatcher: TurnDispatcher;
  private readonly identityResolver: (agentName: string) => AgentIdentity;
  private readonly agentTzResolver?: (agentName: string) => string | undefined;
  private readonly statusReactions: boolean;
  private readonly workingPlaceholder: string | null;
  private readonly log: Logger;
  /** At-least-once dedup — insertion-ordered, capped at MAX_SEEN_MESSAGES. */
  private readonly seenMessages = new Map<string, true>();

  constructor(config: MessagingBridgeConfig) {
    this.adapter = config.adapter;
    this.routingTableRef = config.routingTableRef;
    this.turnDispatcher = config.turnDispatcher;
    this.identityResolver = config.identityResolver;
    this.agentTzResolver = config.agentTzResolver;
    this.statusReactions = config.statusReactions ?? false;
    this.workingPlaceholder =
      config.workingPlaceholder === undefined ? DEFAULT_WORKING_PLACEHOLDER : config.workingPlaceholder;
    this.log = config.log.child({ component: "MessagingBridge", platform: config.adapter.kind });
  }

  async start(): Promise<void> {
    this.adapter.onInbound((m) => {
      void this.handleInbound(m).catch((err) => {
        this.log.error({ err, channelId: m.channelId }, "handleInbound crashed (caught at boundary)");
      });
    });
    await this.adapter.start();
    this.log.info(
      { routes: this.routingTableRef.current.channelToAgent.size },
      "messaging bridge started",
    );
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
  }

  /**
   * Phase 145 WS3 (Plan 04) — post a plain text message to a channel via the
   * underlying adapter, applying the per-agent identity. Used by the daemon's
   * `ask-user-question` text-fallback path to render the numbered question for
   * platforms WITHOUT native interactive components (Slack today,
   * `interactivePrompt: false`). The reply is resolved separately via the
   * shared pending-prompt registry (the Slack `onSlackEvent` intercept lands in
   * Plan 07; until then the Slack text path resolves only via the daemon
   * timeout). This is a narrow accessor over the private adapter — NOT a new
   * turn-loop path. Returns the message handle (best-effort; throws propagate
   * to the daemon handler's catch).
   */
  async postText(
    channelId: string,
    agentName: string,
    text: string,
  ): Promise<MessageHandle> {
    return this.adapter.sendMessage(channelId, text, {
      identity: this.identityResolver(agentName),
    });
  }

  /** Route one inbound message through a full agent turn. */
  private async handleInbound(m: InboundMessage): Promise<void> {
    if (m.isBot) return;
    const agent = this.routingTableRef.current.channelToAgent.get(m.channelId);
    if (agent === undefined) return; // not a bound channel — ignore silently

    // At-least-once dedup: Socket Mode (and other platforms) may redeliver the
    // same message; without this a redelivery becomes a duplicate agent turn.
    const dedupKey = `${m.platform}:${m.channelId}:${m.messageId}`;
    if (this.seenMessages.has(dedupKey)) {
      this.log.debug({ dedupKey }, "duplicate inbound suppressed");
      return;
    }
    this.seenMessages.set(dedupKey, true);
    if (this.seenMessages.size > MAX_SEEN_MESSAGES) {
      const oldest = this.seenMessages.keys().next().value;
      if (oldest !== undefined) this.seenMessages.delete(oldest);
    }

    const caps = this.adapter.capabilities();
    const identity = this.identityResolver(agent);
    const replyThread = m.threadId;
    const userHandle: MessageHandle = {
      channelId: m.channelId,
      messageId: m.messageId,
      threadId: m.threadId,
    };

    this.log.info({ agent, channelId: m.channelId, threaded: Boolean(m.threadId) }, "inbound → turn");

    const sourceKind = m.platform as SourceKind; // adapter.kind must be a registered SOURCE_KIND
    const origin = makeRootOrigin(sourceKind, m.channelId);
    const formatted = formatAgentMessage(m, this.agentTzResolver?.(agent));
    const maxLen = caps.maxMessageLength;

    // Progressive streaming + working-affordance state. The dispatcher's
    // onChunk is sync; we queue async sends on a serialized chain so
    // placeholder → progressive edit → final delivery never race.
    let handle: MessageHandle | null = null;
    let chain: Promise<void> = Promise.resolve();
    let lastEditAt = 0;

    // Working affordance: native typing where the platform supports it;
    // otherwise post a placeholder message and edit it into the reply (Slack
    // has no bot typing indicator). Queued on `chain` so the first edit lands
    // on THIS message. Queue-state reactions are off by default (noisy on Slack).
    if (caps.typingIndicator && this.adapter.startTyping) {
      void this.adapter.startTyping(m.channelId).catch(() => undefined);
    } else if (caps.editMessages && this.workingPlaceholder !== null) {
      const placeholder = this.workingPlaceholder;
      chain = chain
        .then(async () => {
          handle = await this.adapter.sendMessage(m.channelId, placeholder, {
            identity,
            threadId: replyThread,
          });
        })
        .catch((err) => this.log.debug({ err }, "working placeholder post failed (non-fatal)"));
    }
    if (this.statusReactions) void this.setStatus(userHandle, "working");

    const scheduleRender = (text: string): void => {
      chain = chain
        .then(async () => {
          if (text.length === 0 || text.length > maxLen) return;
          if (!handle) {
            handle = await this.adapter.sendMessage(m.channelId, text, {
              identity,
              threadId: replyThread,
            });
          } else {
            await this.adapter.editMessage(handle, text);
          }
        })
        .catch((err) => {
          this.log.debug({ err }, "progressive edit failed (non-fatal)");
        });
    };

    const onChunk = (accumulated: string): void => {
      if (!caps.editMessages) return;
      if (accumulated.length === 0 || accumulated.length > maxLen) return;
      const now = Date.now();
      if (now - lastEditAt < PROGRESSIVE_EDIT_MS) return;
      lastEditAt = now;
      scheduleRender(accumulated);
    };

    let response: string;
    try {
      response = await this.turnDispatcher.dispatchStream(origin, agent, formatted, onChunk, {
        channelId: m.channelId,
      });
    } catch (err) {
      await chain.catch(() => undefined); // drain placeholder/in-flight edit
      this.log.error({ err, agent }, "dispatch failed");
      await this.deliverError(m.channelId, identity, replyThread, handle);
      if (this.statusReactions) void this.setStatus(userHandle, "failed");
      return;
    }

    await chain.catch(() => undefined); // ensure the placeholder handle is settled
    try {
      await this.deliverFinal({ channelId: m.channelId, identity, replyThread, response, handle, maxLen });
      if (this.statusReactions) void this.setStatus(userHandle, "delivered");
    } catch (err) {
      this.log.error({ err, agent }, "final delivery failed");
      if (this.statusReactions) void this.setStatus(userHandle, "failed");
    }
  }

  /** Deliver the final response: edit the streamed message, chunk the rest. */
  private async deliverFinal(args: {
    channelId: string;
    identity: AgentIdentity;
    replyThread: string | undefined;
    response: string;
    handle: MessageHandle | null;
    maxLen: number;
  }): Promise<void> {
    const trimmed = args.response.trim();
    // Empty turn (agent acted via tools, said nothing). Don't post noise; if we
    // streamed a placeholder, leave it as-is.
    if (trimmed.length === 0 && args.handle === null) return;

    const chunks = splitMessage(trimmed.length > 0 ? args.response : "(no textual response)", args.maxLen);

    let first = args.handle;
    if (first) {
      await this.adapter.editMessage(first, chunks[0]);
    } else {
      first = await this.adapter.sendMessage(args.channelId, chunks[0], {
        identity: args.identity,
        threadId: args.replyThread,
      });
    }
    for (let i = 1; i < chunks.length; i++) {
      await this.adapter.sendMessage(args.channelId, chunks[i], {
        identity: args.identity,
        threadId: args.replyThread,
      });
    }
  }

  private async deliverError(
    channelId: string,
    identity: AgentIdentity,
    replyThread: string | undefined,
    handle: MessageHandle | null,
  ): Promise<void> {
    const text = "⚠️ Something went wrong handling that message — please try again.";
    try {
      // Reuse the working placeholder if one was posted, so we don't leave a
      // dangling "…" message next to the error.
      if (handle) {
        await this.adapter.editMessage(handle, text);
      } else {
        await this.adapter.sendMessage(channelId, text, { identity, threadId: replyThread });
      }
    } catch (err) {
      this.log.warn({ err }, "error notice delivery failed");
    }
  }

  private async setStatus(handle: MessageHandle, status: "working" | "delivered" | "failed"): Promise<void> {
    if (!this.adapter.capabilities().reactions || !this.adapter.setStatusReaction) return;
    try {
      await this.adapter.setStatusReaction(handle, status);
    } catch (err) {
      this.log.debug({ err, status }, "status reaction failed (non-fatal)");
    }
  }
}
