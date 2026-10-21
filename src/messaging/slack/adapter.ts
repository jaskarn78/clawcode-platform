/**
 * SlackAdapter — `MessagingPlatform` implementation for Slack.
 *
 * Transport: Socket Mode (WebSocket inbound, no public endpoint) + Web API
 * (HTTP outbound). Identity: per-message `username`/`icon_url` gives each
 * agent its own face from a single Slack app. Threads: native `thread_ts`.
 * Typing: Slack has no bot typing indicator, so the method is omitted and the
 * bridge degrades.
 */
import type { Logger } from "pino";
import type {
  AgentIdentity,
  InboundAttachment,
  InboundMessage,
  MessageHandle,
  MessagingPlatform,
  OutboundOptions,
  PlatformCapabilities,
  TurnStatus,
} from "../types.js";
import { SlackWebClient } from "./web-api.js";
import { SlackSocketMode, type SlackEvent, type SlackFile } from "./socket-mode.js";
import { toSlackMrkdwn } from "./mrkdwn.js";
import { downloadSlackAttachments } from "./file-download.js";
import { pendingPromptRegistry } from "../pending-prompt-registry.js";

/** Slack practical per-message text ceiling (hard limit is higher; this splits sanely). */
const SLACK_MAX_MESSAGE_LENGTH = 3900;

/** Coarse turn-status → Slack emoji name (no colons). */
const STATUS_EMOJI: Record<TurnStatus, string> = {
  working: "eyes",
  delivered: "white_check_mark",
  failed: "x",
};

export type SlackAdapterConfig = {
  /** Bot token (xoxb-…) for the Web API. */
  readonly botToken: string;
  /** App-level token (xapp-…) for Socket Mode. */
  readonly appToken: string;
  readonly log: Logger;
};

export class SlackAdapter implements MessagingPlatform {
  readonly kind = "slack" as const;

  private readonly web: SlackWebClient;
  private readonly socket: SlackSocketMode;
  private readonly log: Logger;
  private handler: ((message: InboundMessage) => void) | null = null;
  private botUserId = "";
  /**
   * Whether per-message identity (username/icon) can be applied — requires the
   * `chat:write.customize` scope. Detected at start(); optimistic default so
   * unit tests and header-less responses still attempt identity. When false,
   * messages post cleanly as the app instead of failing.
   */
  private canCustomize = true;
  /**
   * Whether inbound file bytes can be downloaded — requires the `files:read`
   * scope. Detected at start(). Default false: without the scope a download
   * attempt just gets an HTML login page, so we don't try; inbound files
   * surface as metadata only.
   */
  private canDownloadFiles = false;
  /** handleKey (`channel:ts`) → last status emoji set, for replace semantics. */
  private readonly lastStatus = new Map<string, string>();

  constructor(config: SlackAdapterConfig) {
    this.log = config.log.child({ component: "SlackAdapter" });
    this.web = new SlackWebClient(config.botToken, this.log);
    this.socket = new SlackSocketMode(config.appToken, this.log);
  }

  capabilities(): PlatformCapabilities {
    return {
      editMessages: true,
      reactions: true,
      typingIndicator: false,
      threads: true,
      // Reflects the detected chat:write.customize scope (accurate after start()).
      perMessageIdentity: this.canCustomize,
      // Reflects the detected files:read scope (accurate after start()).
      fileDownload: this.canDownloadFiles,
      // Phase 145 WS3 — text fallback. Stays false: the Slack-native Block Kit
      // path is DEFERRED (Plan 07 landed the socket-mode interactive dispatch +
      // pure parser/builder as scaffolding, but the adapter `askQuestion` +
      // capability flip are not wired — and the daemon ask-user-question
      // handler still hard-codes `interactivePrompt: platform === "discord"` and
      // never calls `adapter.askQuestion`, so flipping this alone would be a
      // no-op false affordance; see 145-07-SUMMARY § Native deferred). false
      // routes ask_user_question through the universal text fallback, whose
      // reply the onSlackEvent intercept below resolves through the shared
      // pending-prompt registry — the same allowlisted path as Discord.
      interactivePrompt: false,
      maxMessageLength: SLACK_MAX_MESSAGE_LENGTH,
    };
  }

  onInbound(handler: (message: InboundMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const { userId, scopes } = await this.web.authTest();
    this.botUserId = userId;
    // Only gate when we actually observed a scope list (header present). An
    // empty list means the header was absent — stay optimistic on identity.
    if (scopes.length > 0) {
      this.canCustomize = scopes.includes("chat:write.customize");
      // files:read is opt-in: without the header we DON'T assume it (a
      // download attempt without it just yields an HTML login page).
      this.canDownloadFiles = scopes.includes("files:read");
    }
    if (!this.canCustomize) {
      this.log.warn(
        "slack: chat:write.customize scope not granted — per-agent identity disabled; posting as the app. Add the scope + reinstall to enable.",
      );
    }
    if (!this.canDownloadFiles) {
      this.log.warn(
        "slack: files:read scope not granted — inbound files surface as metadata only (no download). Add the scope + reinstall to let agents read shared images/files.",
      );
    }
    this.log.info(
      { botUserId: this.botUserId, perAgentIdentity: this.canCustomize, fileDownload: this.canDownloadFiles },
      "slack adapter authenticated",
    );
    this.socket.onEvent((event) => this.onSlackEvent(event));
    await this.socket.start();
  }

  async stop(): Promise<void> {
    await this.socket.stop();
  }

  async sendMessage(
    channelId: string,
    text: string,
    opts?: OutboundOptions,
  ): Promise<MessageHandle> {
    // Only apply per-message identity when chat:write.customize is granted;
    // otherwise Slack rejects/ignores username+icon, so post cleanly as the app.
    const identity = this.canCustomize ? opts?.identity : undefined;
    const res = await this.web.postMessage({
      channel: channelId,
      // Translate the agent's canonical (Discord-flavored) Markdown to Slack
      // mrkdwn at the wire boundary. Done once, on canonical text — see the
      // non-idempotency note in mrkdwn.ts.
      text: toSlackMrkdwn(text),
      username: identity?.displayName,
      iconUrl: identity?.iconUrl,
      iconEmoji: identity?.iconEmoji,
      threadTs: opts?.threadId,
    });
    return { channelId: res.channel, messageId: res.ts, threadId: opts?.threadId };
  }

  async editMessage(handle: MessageHandle, text: string): Promise<void> {
    // Same canonical → mrkdwn translation as sendMessage. The bridge always
    // passes full accumulated canonical text here (never prior output), so a
    // single translation per edit is correct even mid-stream.
    await this.web.updateMessage({
      channel: handle.channelId,
      ts: handle.messageId,
      text: toSlackMrkdwn(text),
    });
  }

  async setStatusReaction(handle: MessageHandle, status: TurnStatus): Promise<void> {
    const emoji = STATUS_EMOJI[status];
    const key = `${handle.channelId}:${handle.messageId}`;
    const prior = this.lastStatus.get(key);
    if (prior === emoji) return;
    try {
      if (prior) {
        await this.web.removeReaction({ channel: handle.channelId, ts: handle.messageId, name: prior });
      }
      await this.web.addReaction({ channel: handle.channelId, ts: handle.messageId, name: emoji });
      this.lastStatus.set(key, emoji);
    } catch (err) {
      // Best-effort UI affordance — never let a reaction failure break a turn.
      this.log.debug({ err, status }, "slack setStatusReaction failed (non-fatal)");
    }
  }

  // NOTE: startTyping is intentionally omitted — Slack bots have no typing
  // indicator via the Web API. capabilities().typingIndicator === false, so
  // the bridge skips it.

  /** Convert a raw Slack message event into a neutral InboundMessage. */
  private onSlackEvent(event: SlackEvent): void {
    if (!this.handler) return;
    const message = slackEventToInbound(event, this.botUserId);
    if (!message) return;

    // Phase 145 WS3 (Plan 07) — pending-prompt intercept (RESEARCH Pitfall 4 /
    // LANDMINE B); the Slack mirror of Discord's `bridge.ts handleMessage`
    // intercept. An `ask_user_question` text-fallback reply (Slack reports
    // interactivePrompt:false, so the daemon posts the numbered text fallback)
    // arrives here as a NORMAL inbound message; without this intercept
    // onSlackEvent would dispatch it as a FRESH TURN and the blocked tool call
    // would never resolve. Consult the SHARED singleton registry BEFORE
    // this.handler (before BOTH the download and direct-dispatch branches). On
    // a match (a pending prompt for this channel AND the sender is in the
    // prompt's fail-closed operator allowlist AND the reply parses to valid
    // options) the stored resolve() fires and we RETURN — suppressing the
    // spurious turn (the answer reaches the agent only as the tool result). On
    // ANY miss this is an O(1) Map lookup with no side effects, so the
    // non-pending inbound path is byte-identical. NOTE: the operator's Slack
    // user id must be in CLAWCODE_ASK_USER_AUTHORIZED_IDS (the daemon allowlist
    // falls back to CLAWCODE_ADMIN_DISCORD_USER_IDS, which are Discord
    // snowflakes that never match a Slack id) — see 145-07-SUMMARY § Deploy.
    const resolution = pendingPromptRegistry.tryResolve(
      "slack",
      message.channelId,
      message.userId,
      message.text,
    );
    if (resolution.resolved) {
      this.log.info(
        { channelId: message.channelId, user: message.userId },
        "ask_user_question: text-fallback reply resolved a pending prompt (turn suppressed)",
      );
      return;
    }

    // Files present + scope granted → download the bytes to a local path before
    // dispatch so the agent can read them. Download is best-effort and async;
    // on any failure dispatchWithDownloads still delivers the metadata-only
    // message. The bridge's dedup runs on dispatch, so a redelivery is
    // suppressed there (the only cost is a rare re-download).
    if (this.canDownloadFiles && message.attachments && message.attachments.length > 0) {
      void this.dispatchWithDownloads(message);
    } else {
      this.handler(message);
    }
  }

  private async dispatchWithDownloads(message: InboundMessage): Promise<void> {
    let enriched = message;
    try {
      enriched = await downloadSlackAttachments(this.web, message, this.log);
    } catch (err) {
      // downloadSlackAttachments is already fail-open, but guard the dispatch.
      this.log.warn({ err }, "slack attachment download path threw; dispatching metadata only");
    }
    this.handler?.(enriched);
  }
}

/** Convert raw Slack `event.files[]` into neutral InboundAttachment metadata. */
function extractAttachments(files: readonly SlackFile[] | undefined): InboundAttachment[] {
  if (!files || files.length === 0) return [];
  const out: InboundAttachment[] = [];
  for (const f of files) {
    const url = f.url_private_download ?? f.url_private;
    if (!url) continue; // can't surface a file we have no URL for
    out.push({
      name: f.name ?? f.title ?? "file",
      mimeType: f.mimetype ?? null,
      sizeBytes: typeof f.size === "number" ? f.size : 0,
      url,
    });
  }
  return out;
}

/**
 * Pure conversion: a raw Slack message event → neutral InboundMessage, or
 * null when the event should be ignored (wrong type, a subtype like edits/
 * joins, a bot/own message, or empty text). Exported for unit testing.
 */
export function slackEventToInbound(event: SlackEvent, botUserId: string): InboundMessage | null {
  if (event.type !== "message") return null;
  // Accept plain messages and `file_share` (a user sharing a file/image, often
  // with a caption or no text). Skip every other subtype (edits/joins/deletes/
  // bot_message/etc.).
  if (event.subtype && event.subtype !== "file_share") return null;
  // Skip our own posts and any bot-authored message.
  if (event.bot_id) return null;
  if (!event.user || event.user === botUserId) return null;
  if (!event.channel || !event.ts) return null;

  const text = event.text ?? "";
  const attachments = extractAttachments(event.files);
  // Drop only when there's neither text nor a file to surface — a file-only
  // share (empty caption) is still a real, answerable message.
  if (text.trim().length === 0 && attachments.length === 0) return null;

  return {
    platform: "slack",
    channelId: event.channel,
    messageId: event.ts,
    userId: event.user,
    userName: event.user,
    text,
    threadId: event.thread_ts,
    isBot: false,
    ts: slackTsToDate(event.ts),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/** Slack `ts` is "<epoch-seconds>.<seq>". Convert to a Date. */
function slackTsToDate(ts: string): Date {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
}
