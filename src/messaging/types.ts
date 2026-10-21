/**
 * Multi-platform messaging — the platform-neutral seam.
 *
 * ClawCode was built on Discord. This module introduces a thin abstraction
 * (`MessagingPlatform`) so an agent can be bound to a Slack channel (and,
 * later, a Telegram chat) and run the full turn lifecycle there.
 *
 * Design note (see .planning/multi-platform-messaging-PLAN.md):
 *   - INBOUND is one cheap seam — every adapter produces a neutral
 *     `InboundMessage`, and `formatAgentMessage` stamps `source="<platform>"`.
 *   - OUTBOUND is the expensive surface — the adapter exposes every leaf
 *     I/O the bridge core needs (send / edit / react / typing), and the
 *     bridge degrades gracefully via `capabilities()` rather than throwing
 *     when a platform lacks a feature.
 *
 * Discord itself is intentionally NOT migrated onto this seam in v1 — the
 * mature 159KB `DiscordBridge` keeps its own code path. New platforms share
 * this single neutral bridge, so the value-adds are written once, not
 * duplicated per platform.
 */

/** The platforms a `MessagingPlatform` adapter can speak. */
export type PlatformKind = "discord" | "slack" | "telegram";

/**
 * A neutral inbound attachment (file/image a user shared). Adapters that can
 * download the bytes (with their own auth — Slack `url_private` needs the bot
 * token + `files:read`) set `localPath`; `formatAgentMessage` then points the
 * agent at the local file. Adapters without download access leave `localPath`
 * unset and only the metadata + `url` are surfaced.
 */
export type InboundAttachment = {
  /** Original file name (best-effort; may be empty). */
  readonly name: string;
  /** MIME type if the platform reported one (e.g. `image/png`), else null. */
  readonly mimeType: string | null;
  /** Size in bytes (0 if unknown). */
  readonly sizeBytes: number;
  /**
   * Platform URL for the bytes. MAY require platform auth to fetch (Slack
   * `url_private`), so it is not necessarily agent-fetchable on its own.
   */
  readonly url: string;
  /**
   * Local filesystem path once the adapter has downloaded the bytes. Absent
   * when download is unavailable (missing scope) or failed. The agent's Read
   * tool can open this path directly.
   */
  readonly localPath?: string;
};

/**
 * A neutral inbound message — what every adapter converts its native event
 * into before handing it to the bridge core. Channel/message/user ids are
 * opaque strings (Discord snowflakes, Slack channel ids + `ts`, Telegram
 * chat ids all serialize to strings).
 */
export type InboundMessage = {
  readonly platform: PlatformKind;
  /** Opaque channel/conversation id (routing key). */
  readonly channelId: string;
  /** Opaque per-message id (Slack `ts`, Discord snowflake). */
  readonly messageId: string;
  /** Opaque author id. */
  readonly userId: string;
  /** Human-readable author name (best-effort; may equal userId). */
  readonly userName: string;
  /** Plain text body (mentions left as the platform rendered them). */
  readonly text: string;
  /**
   * Thread/conversation-thread id when the message arrived inside a thread.
   * On Slack this is `thread_ts`. Replies are routed back into this thread.
   */
  readonly threadId?: string;
  /** True for messages authored by a bot (our own app or any other bot). */
  readonly isBot: boolean;
  /** Message timestamp. */
  readonly ts: Date;
  /** Files/images shared with the message (empty/omitted when none). */
  readonly attachments?: readonly InboundAttachment[];
};

/**
 * Per-agent outbound identity. On platforms that support per-message
 * masquerade (Discord webhooks, Slack `username`/`icon_url`) this gives each
 * agent its own face from a single bot. On Telegram (one bot = one identity)
 * the operator provisions a per-agent bot token instead and this is unused.
 */
export type AgentIdentity = {
  readonly displayName: string;
  readonly iconUrl?: string;
  /** Slack-style `:emoji:` name, used when no iconUrl is set. */
  readonly iconEmoji?: string;
};

/** Options for an outbound send. */
export type OutboundOptions = {
  readonly identity?: AgentIdentity;
  /** Reply inside this thread when set (echoes an inbound `threadId`). */
  readonly threadId?: string;
};

/**
 * Handle to a posted message, returned by `sendMessage` and accepted by
 * `editMessage` / `setStatusReaction`. Replaces the raw discord.js `Message`
 * reference the Discord streaming editor holds.
 */
export type MessageHandle = {
  readonly channelId: string;
  /** Platform message id (Slack `ts`). */
  readonly messageId: string;
  readonly threadId?: string;
};

/**
 * Coarse turn lifecycle states surfaced as a reaction on the user's message
 * (the platform-neutral analog of the Discord queue-state icons). Each
 * adapter maps these to a native emoji; unsupported platforms no-op.
 */
export type TurnStatus = "working" | "delivered" | "failed";

/**
 * Phase 145 WS3 — platform-neutral interactive-prompt shapes for the
 * `ask_user_question` MCP tool. The MCP tool + IPC contract are PLATFORM
 * NEUTRAL (`{questions} → {answers}`); the daemon resolves the agent's bound
 * channel + platform and dispatches to the native renderer (Discord buttons,
 * Slack Block Kit) or the universal text fallback.
 *
 * The shape mirrors the real built-in AskUserQuestion (the non-rendering tool
 * this replaces) for a true drop-in: up to 4 questions, each with labelled
 * options and an optional multi-select. Plan 04 (Discord + text) and Plan 06
 * (Slack) implement the renderers against these fixed types.
 */

/** One selectable option within a {@link NeutralQuestion}. */
export type NeutralQuestionOption = {
  /** Stable opaque id echoed back in {@link NeutralAnswer.selectedOptionIds}. */
  readonly id: string;
  /** Human-readable label rendered as the button / select-row text. */
  readonly label: string;
  /** Optional longer description (Slack option description, Discord row blurb). */
  readonly description?: string;
};

/**
 * One question in an {@link AskQuestionOpts} batch. A batch carries up to 4
 * questions (the built-in AskUserQuestion ceiling); the MCP tool's zod schema
 * (Plan 04) enforces the 1..4 bound and ≥1 option per question.
 */
export type NeutralQuestion = {
  /** Stable opaque id echoed back in {@link NeutralAnswer.questionId}. */
  readonly id: string;
  /** Short heading (the question prompt / Block Kit section header). */
  readonly header: string;
  /** Optional longer body text rendered under the header. */
  readonly text?: string;
  /** The selectable options (≥1). */
  readonly options: readonly NeutralQuestionOption[];
  /**
   * When true the operator may pick multiple options (Discord multi-select /
   * Slack multi-static-select). Defaults to single-select when omitted.
   */
  readonly multiSelect?: boolean;
};

/** The operator's selection for a single {@link NeutralQuestion}. */
export type NeutralAnswer = {
  /** Echoes {@link NeutralQuestion.id}. */
  readonly questionId: string;
  /**
   * The chosen {@link NeutralQuestionOption.id}s. Exactly one for a
   * single-select question; one-or-more when `multiSelect` is set.
   */
  readonly selectedOptionIds: readonly string[];
};

/**
 * The full set of answers — one {@link NeutralAnswer} per question in the
 * batch (same order is NOT guaranteed; consumers match by `questionId`).
 */
export type NeutralAnswers = {
  readonly answers: readonly NeutralAnswer[];
};

/**
 * Options for {@link MessagingPlatform.askQuestion}.
 *  - `timeoutMs` — adapter-side render TTL hint; the daemon handler owns the
 *    load-bearing bounded timeout (the IPC client has no socket timeout), so
 *    this is advisory for the native renderer's own component collector.
 *  - `promptId` — correlation id for the pending-prompt registry (the
 *    text-fallback intercept in the inbound handler keys on this, Plan 04/06).
 */
export type AskQuestionOpts = {
  readonly timeoutMs?: number;
  readonly promptId?: string;
};

/** What a platform can do — drives the bridge's degradation decisions. */
export type PlatformCapabilities = {
  /** Can an existing message be edited in place (progressive streaming)? */
  readonly editMessages: boolean;
  /** Can a reaction be set on a message (queue-state icons)? */
  readonly reactions: boolean;
  /** Is there a real "typing…" indicator? */
  readonly typingIndicator: boolean;
  /** Native threads (Slack thread_ts, Discord threads)? */
  readonly threads: boolean;
  /** Per-message identity masquerade (Slack username/icon, Discord webhook)? */
  readonly perMessageIdentity: boolean;
  /**
   * Can the adapter download inbound file bytes to a local path (so an agent
   * can read shared images/files)? On Slack this reflects the `files:read`
   * scope — without it, inbound files surface as metadata only.
   *
   * NOTE: this is the only "rich" capability flag we add in P0. The
   * command/interaction/rich-content flags (slash commands, modals, Block
   * Kit, ephemeral, file upload) are deliberately deferred — their right
   * shape only becomes clear with a second adapter; an unconsumed flag is
   * not degradation infrastructure, just drift. See
   * .planning/messaging-platform-parity-PLAN.md §4.
   */
  readonly fileDownload: boolean;
  /**
   * Phase 145 WS3 — can the adapter render native interactive prompts
   * (buttons / select) AND collect a structured answer back? When false, the
   * bridge uses the universal text fallback (post the question + numbered
   * options, parse the next inbound reply). Capability-gated graceful
   * degradation — no per-platform special-casing at the call site. Slack
   * reports `false` until the Socket Mode interactive-envelope plumbing +
   * app reinstall land (Plan 06).
   */
  readonly interactivePrompt: boolean;
  /** Hard per-message character ceiling. */
  readonly maxMessageLength: number;
};

/**
 * The adapter contract. One implementation per platform. Optional methods
 * correspond to optional capabilities — an adapter that reports
 * `capabilities().reactions === false` may omit `setStatusReaction`.
 */
export interface MessagingPlatform {
  readonly kind: PlatformKind;

  /** Static capability descriptor (drives degradation in the bridge). */
  capabilities(): PlatformCapabilities;

  /** Connect to the platform and begin receiving inbound messages. */
  start(): Promise<void>;

  /** Disconnect and release resources. */
  stop(): Promise<void>;

  /** Register the inbound handler. Must be called before `start()`. */
  onInbound(handler: (message: InboundMessage) => void): void;

  /** Post a message; returns a handle for later edit/react. */
  sendMessage(
    channelId: string,
    text: string,
    opts?: OutboundOptions,
  ): Promise<MessageHandle>;

  /** Replace the text of a previously posted message (progressive stream). */
  editMessage(handle: MessageHandle, text: string): Promise<void>;

  /** Set the coarse turn-status reaction on a message (best-effort). */
  setStatusReaction?(handle: MessageHandle, status: TurnStatus): Promise<void>;

  /** Show a typing indicator in a channel (best-effort, may be a no-op). */
  startTyping?(channelId: string): Promise<void>;

  /**
   * Phase 145 WS3 — render a native interactive prompt (buttons / select) and
   * resolve with the operator's structured answer. Optional, mirroring the
   * `setStatusReaction?` ↔ `reactions` pattern: an adapter that reports
   * `capabilities().interactivePrompt === false` MAY omit this method, and the
   * bridge then uses the universal text fallback. Plan 06 implements it for
   * Slack (Block Kit + `block_actions`); the daemon's Discord dispatch keeps
   * its own DiscordBridge path (Discord is deliberately off this seam).
   */
  askQuestion?(
    channelId: string,
    questions: readonly NeutralQuestion[],
    opts?: AskQuestionOpts,
  ): Promise<NeutralAnswers>;
}
