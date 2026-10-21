import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
  type MessageComponentInteraction,
} from "discord.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../shared/logger.js";
import type { RoutingTable } from "./types.js";
import type { SessionManager } from "../manager/session-manager.js";
import type { TurnDispatcher } from "../manager/turn-dispatcher.js";
import type { MemoryContextAugmenter } from "../manager/memory-context-augmenter.js";
import type { ThreadManager } from "./thread-manager.js";
import type { Logger } from "pino";
import { buildCv2Payload, Cv2ValidationError, type Cv2Spec } from "./cv2-renderer.js";
import { postCv2WithFiles, editCv2Message, type RestLike } from "./cv2-post.js";
import { Routes } from "discord-api-types/v10";
// Phase 145 WS3 (Plan 04) — the shared pending-prompt registry singleton +
// neutral question/answer types. handleMessage consults the registry BEFORE
// turn dispatch (text-fallback intercept, LANDMINE B); askQuestionDiscord
// renders native components.
import { pendingPromptRegistry } from "../messaging/pending-prompt-registry.js";
import type {
  NeutralQuestion,
  NeutralAnswer,
  NeutralAnswers,
} from "../messaging/types.js";
import type { DownloadResult } from "./attachment-types.js";
import {
  extractAttachments,
  downloadAllAttachments,
  formatAttachmentMetadata,
  isImageAttachment,
  attachmentInboxDir,
} from "./attachments.js";
import { formatReactionEvent, addReaction } from "./reactions.js";
import {
  transitionQueueState,
  QUEUE_STATE_ICON,
  reactionCacheKey,
  type DiscordChannelHandle,
  type QueueState,
} from "./queue-state-icon.js";
import type {
  AdvisorInvokedEvent,
  AdvisorResultedEvent,
} from "../advisor/types.js";
import { ProgressiveMessageEditor } from "./streaming.js";
import { formatOutboundText } from "./markdown-table-wrap.js";
import { planOutboundTables, stripTablePlaceholders, type OutboundFile } from "./table-delivery.js";
import { DRAFT_ONLY_BODY, extractDrafts, splitDraftForDelivery } from "./draft-extract.js";
import { rewriteIconShortcodes, stripIconShortcodes } from "./icon-shortcodes.js";
import { diffSpan } from "../manager/financial-correction-patch.js";
import { deliveryFlags } from "./delivery-flags.js";
import { stripModelSourcesBlock } from "./sources-footer.js";
import { renderRecallFooter } from "../manager/recall-footer.js";
import {
  applyDigestFeedback,
  digestReplyText,
  feedbackForEmoji,
  isDigestMessage,
  parseDigestMessage,
} from "../manager/memory-digest.js";
import {
  replaceVerificationLine,
  splitCorrectionForDrafts,
  MAX_EDIT_LENGTH,
  DeliveredMessageRefStore,
  HOLD_PLACEHOLDER,
  PENDING_MARKER,
  decideCorrectionEdit,
  decidePendingMarkerAppend,
} from "./correction-edit.js";
import {
  HoldStatusThrottle,
  StatusTrail,
  describeToolActivity,
  sanitizeEcho,
  shouldArmQuietTrail,
  TRAIL_QUIET_MS,
  stripDivertedNarration,
  composeTrailHeader,
} from "./hold-status.js";
import { startLiveThinking, type LiveThinkingHandle } from "./live-thinking-trail.js";
import { resolveUxFeature } from "../manager/ux-feature-state-store.js";
import { isTopicPrompt } from "../manager/topic-prompt.js";
/** 2026-08-27 — longest accumulated text still treated as a progress fragment. */
const NARRATION_FRAGMENT_MAX_CHARS = 160;
import { resolveTopicProfile } from "../manager/topic-profiles.js";
import { getVerificationOverride } from "../manager/verification-state-store.js";
import { registerClaimSink } from "../manager/claim-sink.js";
import { extractCitations, reconcileCitations } from "../manager/evidence-ledger.js";
import { buildLedgerCardSpec, sourcesButtonLabel, VSRC_PREFIX } from "./ledger-card.js";
// Phase 999.160 — reply actions: relevance-gated buttons under a reply.
import {
  ReplyActionRegistry,
  REPLY_ACTION_TTL_MS,
  buildReplyActionRow,
  evaluateReplyActions,
  suggestionAction,
  type ReplyAction,
} from "./reply-actions.js";
// 999.178 R1 — Retry button on a failed turn (own `retry:` prefix + registry).
import {
  RetryActionRegistry,
  RETRY_ACTION_TTL_MS,
  buildRetryButtonRow,
  plainFailureReason,
} from "./retry-actions.js";
// Phase 999.172 — prompt suggestions: the rendezvous with the stream side.
import { registerSuggestionReply } from "../manager/suggestion-sink.js";
import { formatDuration } from "./duration-format.js";
import { VerificationLedgerStore, type TurnLedger } from "./ledger-store.js";
import { LedgerPersistence } from "./ledger-store-sqlite.js";
import { measureShape } from "./reply-shape.js";
import {
  appendAdvisorSubtext,
  composeDeliveryAnnotations,
  decideTier,
  decideVerdictMarks,
  selectSources,
  type SourceItem,
  type VerdictReaction,
} from "./sources-footer.js";
import {
  ChunkRefStore,
  planChunkEdits,
  type ChunkRef,
} from "./chunk-refs.js";
import { isVerificationEnforced } from "../manager/financial-verification-policy.js";
import { AutoIngestProgress } from "../manager/auto-ingest-progress.js";
import { autoIngestQueue } from "../manager/auto-ingest-queue.js";
import type { WebhookManager } from "./webhook-manager.js";
import { makeWebhookEditFn, type WebhookEditFn } from "./webhook-manager.js";
import type { DeliveryQueue } from "./delivery-queue.js";
import { checkChannelAccess } from "../security/acl-parser.js";
import { enforceVoiceChannelAcl, isVoiceUserAllowed } from "./voice/access.js";
import {
  beginVoiceTurn,
  endVoiceTurn,
  isVoiceAbortError,
  setVoicePhase,
} from "./voice/turn-state.js";
import {
  attachPlayerTrace,
  stampVoiceTurn,
  summarizeVoiceTurnTrace,
  VOICE_TURN_TRACE_MSG,
  type VoiceSttTiming,
} from "./voice/turn-trace.js";
import type { SecurityPolicy } from "../security/types.js";
import type { Turn, Span } from "../performance/trace-collector.js";
import {
  makeRootOrigin,
  makeRootOriginWithTurnId,
  DISCORD_SNOWFLAKE_PREFIX,
} from "../manager/turn-origin.js";
import { decideBotTrigger, buildBotTriggerPrompt } from "./bot-trigger.js";
import { isSilentTickResponse } from "../triggers/silence-sentinel.js";
import { captureDiscordExchange } from "./capture.js";
// 999.160 v1.2 — icons as application emojis (text-only until synced).
import { icons, isIconEmojiName, type IconName, type IconSyncResult } from "./icons.js";
// Phase 999.161 — fast lane (quick questions on the haiku-direct bridge).
import {
  QuickLaneRecentBuffer,
  buildQuickSystemPrompt,
  buildQuickUserPrompt,
  parseQuickAnswer,
  quickLaneFooter,
  truncateForDiscord,
} from "../manager/fast-lane.js";
// Phase 999.164 — per-agent quick-lane routing.
import {
  compileTaskTopics,
  renderDomainDigest,
  resolveAgentDomains,
  routeQuickLane,
  routingProfileFromConfig,
} from "../manager/fast-lane-routing.js";
import { getFastLaneOverride, resolveFastLaneEnabled } from "../manager/fast-lane-state-store.js";
// 999.160 v1.3 — "Shorter" replaces the reply in place.
import {
  LastReplyTracker,
  SHORTEN_MIN_SOURCE_CHARS,
  SHORTEN_SYSTEM_PROMPT,
  buildShortenPrompt,
  isShorterRequest,
  parseShortened,
  shortenedNote,
  parseActionsBlock,
  stripActionsForStreaming,
} from "./reply-actions.js";
import { MessageCoalescer } from "./message-coalescer.js";
import { QUEUE_FULL_ERROR_MESSAGE } from "../manager/persistent-session-queue.js";
// Phase 999.100 — mid-turn intent steering (steer / new_task / stop) on v2
// main channels. Route orchestration + config baseline live in the manager
// module; the bridge contributes only Discord glue (gate condition, trigger
// tracking, reactions, expected-interrupt suppression).
import {
  routeMidturnMessage,
  resolveSteeringRuntime,
  isStatusPing,
  frameMidturnSteer,
} from "../manager/midturn-intent.js";
// 999.178 R1 — status-ping renderer + queued-ask persistence.
import {
  renderStatusPing,
  isTurnStalled,
  buildStatusPingButtonId,
  parseStatusPingButtonId,
  type StatusPingView,
} from "./status-ping-render.js";
import { getResearchTracker } from "../manager/research-registry.js";
import { getBackgroundBoard } from "../manager/background-task-board.js";
import {
  DEFAULT_COALESCED_QUEUE_STATE_PATH,
  loadCoalescedQueue,
  upsertQueuedAsk,
  removeQueuedAsk,
  removeQueuedAsks,
} from "../manager/coalesced-queue-store.js";
import { callHaikuDirect, callModelDirect } from "../manager/haiku-direct.js";
// Debug session `in-tool-wedge-recovery` work-stream (B) — wedge-recovery
// decision core. `decideWedgeRecovery` chooses auto-rerun vs notify from
// the `WedgeInfo` the SDK handle attaches to a wedged turn's AbortError.
import {
  decideWedgeRecovery,
  type WedgeInfo,
  describeStallNotice,
} from "../manager/tool-mutation-classifier.js";
import { renderAgentVisibleTimestamp } from "../shared/agent-visible-time.js";
import { runVisionPrePass, MAX_EAGER_IMAGES } from "./vision-pre-pass.js";
import { PendingImageLedger } from "./pending-image-ledger.js";
import { BurstGatherer, shouldLeadBurst } from "./burst-gatherer.js";
import {
  buildTurnImages,
  describeTurnImages,
  pathOnlyManifest,
  type TurnImages,
  type TurnImageSource,
} from "../vision/turn-images.js";
import { resolveTurnVisionConfig } from "../vision/turn-vision-config.js";
import { isTranscribable, writeTranscriptRequest } from "../transcription/request-meta.js";
import type { VerboseState } from "../usage/verbose-state.js";
// Phase 999.43 Plan 02 T02 — fire-and-forget IPC dispatch into daemon's
// `auto-ingest-attachment` case after Phase 113 attachment download +
// vision pre-pass complete. Single auto-ingest entry point per
// feedback_silent_path_bifurcation.md.
import { sendIpcRequest } from "../ipc/client.js";
import { SOCKET_PATH } from "../manager/daemon.js";
import { V3_CHANNEL_REPLY_TIMEOUT_MS } from "../manager/agent-channel-bridge.js";
import { isSubagentThreadName } from "../manager/subagent-name.js";
import {
  frameSteeringGuidance,
  hasLeadingSteerMarker,
  prepareSubagentSteer,
  shouldAutoSteer,
} from "../manager/steer-subagent.js";
import {
  getBindingForThread,
  readThreadRegistry,
  resetSteerGates,
} from "./thread-registry.js";
import { THREAD_REGISTRY_PATH } from "./thread-types.js";
import { parseAgentMessageFooter } from "./agent-message.js";
import {
  evaluateEnvelopeAuth,
  isHumanAuthorAllowed,
  type EnvelopeAuthMode,
} from "./ingress-auth.js";
import { getProcessIdentitySecret } from "../manager/agent-identity-token.js";

/**
 * Configuration for the Discord bridge.
 */
export type BridgeConfig = {
  readonly routingTableRef: { readonly current: RoutingTable };
  readonly sessionManager: SessionManager;
  /**
   * Phase 57 Plan 03: optional TurnDispatcher injection.
   *
   * Daemon path (`startDaemon`): ALWAYS injects — Discord turns are
   * dispatched through TurnDispatcher.dispatchStream, which attaches the
   * TurnOrigin blob (source.kind='discord', source.id=<snowflake>) to
   * the caller-owned Turn so Plan 57-02's writeTurn persists it.
   *
   * Standalone runner (`src/cli/commands/run.ts`): does NOT inject.
   * `handleMessage` falls back to `this.sessionManager.streamFromAgent(...)`
   * — identical to the v1.7 path. No TurnOrigin is written (expected; the
   * standalone runner is out of v1.8 scope). This keeps TS strict happy
   * for existing callers and unblocks incremental rollout.
   */
  readonly turnDispatcher?: TurnDispatcher;
  /**
   * 2026-08-28 — on-disk verification ledger (`verification-ledger.db`). The
   * 🧾 card survives daemon restarts (7-day retention). Absent → memory only.
   */
  readonly ledgerDbPath?: string;
  readonly threadManager?: ThreadManager;
  readonly webhookManager?: WebhookManager;
  readonly deliveryQueue?: DeliveryQueue;
  readonly securityPolicies?: ReadonlyMap<string, SecurityPolicy>;
  readonly botToken?: string;
  readonly log?: Logger;
  /**
   * Phase 116-03 F27 — optional hook fired after each conversation turn
   * write (user + assistant). The daemon sets this to a closure that
   * broadcasts a `conversation-turn` SSE event via the dashboard's
   * SseManager. Metadata only — `{agentName, turnId, role, createdAt}`.
   * Optional because standalone runners (src/cli/commands/run.ts) construct
   * the bridge without a dashboard.
   */
  readonly onConversationTurn?: (info: {
    readonly agent: string;
    readonly turnId: string;
    readonly role: "user" | "assistant";
    readonly ts: string;
  }) => void;
  /**
   * Phase 117 Plan 117-11 — per-channel verbose-level state for the
   * advisor visibility mutation point at `streamAndPostResponse:~810`.
   *
   * Optional: daemon boot ALWAYS injects (construction at daemon.ts:~2706
   * alongside AdvisorBudget). Standalone runner (`src/cli/commands/run.ts`)
   * and direct-bridge tests omit it — the mutation falls through to the
   * `"normal"` branch (reaction + plain footer), identical to today.
   *
   * Existing tests in `bridge-advisor-footer.test.ts` Case F/F' inject a
   * stub via `(bridge as any).verboseState = { getLevel: () => "verbose" }`
   * — `as any` bypasses TS, so the structural-match stub continues to
   * work even after the field type is tightened to `VerboseState`.
   */
  readonly verboseState?: VerboseState;
  /**
   * Phase 135 Plan 02 — VoiceManager wired into the bridge so the
   * `client.on("ready")` / `client.on("resumed")` listeners can call
   * `voiceManager.autoJoin()` and the `voiceStateUpdate` listener can
   * call `voiceManager.handleUserLeave()` (RESEARCH Pitfall 5). Optional
   * because standalone runners and most unit tests do NOT need voice;
   * when omitted, the listeners short-circuit.
   */
  readonly voiceManager?: import("./voice/manager.js").VoiceManager;
  /**
   * Phase 140 Model B — resolver for a v3 agent's ClawCode channel bridge. When
   * the message target runs the `claude-code-interactive` backend, the daemon
   * owns the single Discord gateway and routes the message to the agent over the
   * channel (push + awaitReply) instead of the v2 SDK dispatch — the agent's
   * turns run in its own process. Returns `undefined` for v2 agents (or when no
   * live bridge) → unchanged dispatch. Wired in daemon.ts from AgentChannelRegistry.
   */
  readonly getBridge?: (agentName: string) => ChatChannelBridge | undefined;
  /**
   * Phase 999.86 — Pre-warmed worker pool dispatcher for v3 Discord chat.
   * When injected, the v3 branch routes inbound Discord messages through
   * a pool of pre-spawned `claude --channels` workers (each receives its
   * one turn via the proven `\r<message>\n` fresh-spawn write pattern)
   * instead of pushing to the long-lived parent agent (whose
   * `notifications/claude/channel` turn-trigger is empirically flaky —
   * see 999.84-EXPERIMENT). When omitted, the existing long-lived
   * parent dispatch path runs unchanged (regression-safe fallback).
   */
  readonly ephemeralChatDispatcher?: import("./ephemeral-chat-dispatcher.js").EphemeralChatDispatcher;
  /** 999.171 TEST SEAM: live-thinking tick and first-paint floor. Production leaves it unset. */
  readonly liveThinkingTiming?: { readonly tickMs?: number; readonly firstPaintMinMs?: number };
  /** 999.178 R1 TEST SEAM: queued-ask persistence path. Production uses the manager-dir default. */
  readonly coalescedQueueStatePath?: string;
};

/**
 * Phase 140 Model B — narrow daemon-side bridge surface the chat path needs.
 * Structurally satisfied by `AgentChannelBridge` (push + awaitReply).
 */
export type ChatChannelBridge = {
  /**
   * Phase 999.160 — reply-action button clicks (`ra:` customIds). Optional:
   * only the Discord bridge renders reply actions; other bridges leave it
   * undefined and the dispatcher answers the click with an ephemeral note.
   */
  handleReplyActionButton?(interaction: import("discord.js").MessageComponentInteraction): Promise<void>;
  /**
   * 999.178 R1 — Retry button clicks (`retry:` customIds) on a failed-turn
   * notice. Optional, same as the reply-action hook: only the Discord bridge
   * renders it.
   */
  handleRetryButton?(
    interaction: import("discord.js").MessageComponentInteraction,
    adminIds?: readonly string[],
  ): Promise<void>;

  /**
   * 999.178 R1 — Continue/Stop clicks on a stalled status-ping reply
   * (`sping:` customIds). Optional for the same reason as reply actions.
   */
  handleStatusPingButton?(interaction: import("discord.js").MessageComponentInteraction): Promise<void>;

  push(msg: import("../channels/clawcode-channel-server.js").DaemonChannelMessage): void;
  awaitReply(
    correlationId: string,
    timeoutMs?: number,
  ): Promise<{ readonly result?: string }>;
  /**
   * Phase 999.82 Plan 02 — streaming surface. Optional so the structural type
   * still matches the narrow Phase-140 test doubles; the v3 branch
   * feature-detects before use.
   */
  registerProgressCallback?(cb: (text: string) => void): void;
  clearProgressCallback?(): void;
  /**
   * Count of OTHER in-flight `awaitReply` registrations at call time. The
   * current turn's `push` only `track`s (does NOT register a pending reply),
   * so checking this BEFORE `awaitReply` measures concurrent turns. >0 ⇒ skip
   * streaming (single-in-flight correlation, SPEC §Risks).
   */
  pendingReplyCount?(): number;
  /**
   * Phase 141 (1C) — reject every pending `awaitReply` (abort cleanup for
   * `/clawcode-interrupt`, so a turn stops at once instead of hanging to the
   * 120s timeout). Optional: feature-detected at the call site.
   */
  cancelPendingReplies?(reason: string): number;
};

/**
 * Phase 999.82 Plan 02 — the SINGLE-BRANCH final-vs-progress dedup decision.
 *
 * The final agent text must be delivered by EXACTLY ONE path
 * (`feedback_silent_path_bifurcation`):
 *   - `flush-editor`  — a progress message exists; the final EDITS it (flush).
 *                       sendResponse is NOT invoked. ≤ maxLength.
 *   - `flush-and-tail` — a progress message exists but the final EXCEEDS
 *                        maxLength: the streamed message holds the first
 *                        `maxLength` chars EXACTLY (no truncate ellipsis —
 *                        head.length === maxLength is a no-op for the editor's
 *                        truncate), and the remainder is sent via sendResponse.
 *                        ONE logical delivery split across edit + tail chunks;
 *                        no double-post, no silent tail loss.
 *   - `send-only`     — no progress message was posted (tool-less turn, or
 *                        streaming was skipped): the whole final goes through
 *                        the existing sendResponse chunking path unchanged.
 *
 * Pure + exported so the 5-case matrix is pinned by a unit test, not driven
 * only through the heavy handleMessage path.
 */
export type V3Delivery =
  | { readonly kind: "flush-editor" }
  | { readonly kind: "flush-and-tail"; readonly head: string; readonly tail: string }
  | { readonly kind: "send-only"; readonly response: string };

export function decideV3Delivery(input: {
  readonly editorPosted: boolean;
  readonly response: string;
  readonly maxLength: number;
}): V3Delivery {
  const { editorPosted, response, maxLength } = input;
  if (!editorPosted) {
    return { kind: "send-only", response };
  }
  if (response.length > maxLength) {
    return {
      kind: "flush-and-tail",
      head: response.slice(0, maxLength),
      tail: response.slice(maxLength),
    };
  }
  return { kind: "flush-editor" };
}

/**
 * Phase 140 Model B — gate: should this message route over the v3 ClawCode
 * channel instead of the v2 SDK dispatch? True only when the agent's CONFIGURED
 * backend is `claude-code-interactive` AND a live bridge exists. Pure +
 * exported for the silent-path-bifurcation unit test (both branches pinned).
 */
export function resolveV3ChatBridge(
  backend: string | undefined,
  getBridge: ((agent: string) => ChatChannelBridge | undefined) | undefined,
  agentName: string,
): ChatChannelBridge | undefined {
  if (backend !== "claude-code-interactive") return undefined;
  return getBridge?.(agentName);
}

/**
 * Load the Discord bot token from the standard Claude Code location.
 */
export function loadBotToken(): string {
  const envFile = join(
    homedir(),
    ".claude",
    "channels",
    "discord",
    ".env",
  );
  try {
    const content = readFileSync(envFile, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^DISCORD_BOT_TOKEN=(.+)$/);
      if (match) {
        return match[1].trim();
      }
    }
  } catch {
    // Config file not found or unreadable -- fall through to env var
  }

  const envToken = process.env.DISCORD_BOT_TOKEN;
  if (envToken) {
    return envToken;
  }

  throw new Error(
    "Discord bot token not found. Set DISCORD_BOT_TOKEN or configure in ~/.claude/channels/discord/.env",
  );
}

/**
 * Backlog 999.95 — public Discord application id for the "Clawdy Code" Embedded
 * App (Activity). NOT a secret — it is the OAuth client_id, already present in
 * the activity's `.env.example`. Used as the `target_application_id` of the
 * activity-launch invite. Overridable via `DISCORD_ACTIVITY_APP_ID` for other
 * deployments.
 */
const CLAWDY_ACTIVITY_APP_ID = "000000000000000000";

/** Discord invite `target_type` for an embedded-application (Activity) invite. */
const INVITE_TARGET_EMBEDDED_APPLICATION = 2;

/**
 * The Discord message bridge.
 * Connects to Discord, listens for messages in bound channels,
 * routes them to the correct agent session, and sends responses back.
 */
export class DiscordBridge {
  /**
   * Phase 999.11 — coalescer storm fix.
   *
   * COMBINED_PREFIX: idempotent guard for formatCoalescedPayload — a single
   * pending entry that already starts with this prefix is returned unchanged
   * (no nested wrappers). Defends against the QUEUE_FULL spin-loop case where
   * a previously-coalesced payload was re-queued and would otherwise gain a
   * second [Combined: …] header per iteration.
   *
   * MAX_DRAIN_DEPTH: hard cap on recursive drain depth in streamAndPostResponse.
   * On cap-hit: emit one warn, push pending back via messageCoalescer.requeue,
   * and return — the next message-arrival drain will pick them up.
   */
  private static readonly COMBINED_PREFIX = "[Combined:";
  private static readonly MAX_DRAIN_DEPTH = 3;

  private readonly client: Client;
  private readonly routingTableRef: { readonly current: RoutingTable };
  private readonly sessionManager: SessionManager;
  /**
   * Phase 57 Plan 03: optional TurnDispatcher injected by the daemon path.
   * Undefined in the standalone runner (`src/cli/commands/run.ts`), where
   * handleMessage falls back to `sessionManager.streamFromAgent` directly.
   */
  private readonly turnDispatcher: TurnDispatcher | undefined;
  /** Phase 140 Model B — v3 channel-bridge resolver (see BridgeConfig.getBridge). */
  private readonly getBridge:
    | ((agentName: string) => ChatChannelBridge | undefined)
    | undefined;
  /** Phase 999.86 — warm worker pool dispatcher (see BridgeConfig.ephemeralChatDispatcher). */
  private ephemeralChatDispatcher:
    | import("./ephemeral-chat-dispatcher.js").EphemeralChatDispatcher
    | undefined;
  /** Phase 141 — pre-turn <memory-context> augmenter for the v3 chat path (daemon-wired). */
  private memoryContextAugmenter: MemoryContextAugmenter | undefined;
  private readonly threadManager: ThreadManager | undefined;
  private webhookManager: WebhookManager | undefined;
  /**
   * Phase 999.117 WS-2 — the SHARED cross-path delivery dedupe. Same instance
   * the inbox watcher and the heartbeat reconciler hold; a second instance
   * would dedupe nothing between paths, which is the bug. Set by the daemon
   * via `setDeliveryDedupe`; undefined before that (pre-boot) → no dedupe.
   */
  private deliveryDedupe: { claim(deliveryId: string | undefined): boolean } | undefined;
  /** Phase 999.144 — envelope-auth rollout dial; "off" until the daemon wires it. */
  private a2aEnvelopeAuthMode: EnvelopeAuthMode = "off";
  /** Phase 999.144 — human ingress allowlist; undefined = feature off. */
  private allowedUserIds: readonly string[] | undefined;
  private readonly deliveryQueue: DeliveryQueue | undefined;
  private readonly securityPolicies: ReadonlyMap<string, SecurityPolicy> | undefined;
  private readonly botToken: string;
  private readonly log: Logger;
  private readonly liveThinkingTiming: BridgeConfig["liveThinkingTiming"];
  /** P2-PROGRESS — edit-in-place ingest progress tracker for attachment bursts. */
  private readonly ingestProgress: AutoIngestProgress;
  /** Phase 116-03 F27 — SSE-broadcast hook for conversation turn writes. */
  private readonly onConversationTurn:
    | ((info: {
        readonly agent: string;
        readonly turnId: string;
        readonly role: "user" | "assistant";
        readonly ts: string;
      }) => void)
    | undefined;
  private running = false;
  private readonly recentlySent: Set<string> = new Set();
  /**
   * Phase 119 A2A-03 hotfix 2026-05-14 — tracks message IDs that have been
   * QUEUED (backoff retry or QUEUE_FULL coalesce). IN_FLIGHT (👍) and
   * DELIVERED (✅) transitions only fire for messages in this set — i.e.,
   * messages that took the queue path. Fast-path messages (direct dispatch,
   * no queue) get no icons. Operator-visible result: ⏳→👍→✅ progression
   * for queued messages only; nothing on every-message responses.
   * Cleaned up on DELIVERED/FAILED to bound memory.
   */
  private readonly queuedMessageIds: Set<string> = new Set();
  /**
   * message_ids that have already received a wedge "please resend" stall
   * notice. A wedged turn can reach the notify path more than once for the
   * SAME user message (an auto-rerun that wedges again, or a double-delivered
   * turn), which posted DUPLICATE notices into the channel (observed in prod).
   * Guards the notice to at-most-once per message; FIFO-bounded so it can't
   * grow unbounded (the notice is terminal, so ids are never deleted).
   */
  private readonly noticedMessageIds: Set<string> = new Set();
  /**
   * Auto-steer (2026-05-23) — message IDs the daemon's `steer-subagent`
   * IPC handler posted into a subagent's thread on behalf of the parent
   * agent (Path B). Bot-authored messages are normally filtered from
   * the in-thread auto-steer path, but a forwarded steer needs to flow
   * through the same dispatch pipeline as Path A (human-in-thread).
   * Marking the message ID here whitelists exactly that one bot post.
   * The entry is removed as the bridge consumes it so the set stays
   * bounded.
   */
  private readonly pendingSteerMessageIds: Set<string> = new Set();
  /**
   * Phase 100 follow-up — per-agent pending-message coalescer.
   *
   * Operator-reported bug 2026-04-28: rapid-fire messages while the agent is
   * busy hit `SerialTurnQueue.QUEUE_FULL` (depth-1) and used to get ❌-reacted
   * (forcing the operator to track + manually resend). Coalescer buffers them
   * upstream of the turn queue so they ride along on the next dispatched turn.
   *
   * Mutated only inside `streamAndPostResponse` — not exposed publicly. Tests
   * inject a fake by direct assignment to `(bridge as any).messageCoalescer`.
   */
  private messageCoalescer: MessageCoalescer = new MessageCoalescer();
  /**
   * 999.178 R1 — every message that arrived while a turn was running and so
   * will WAIT (the depth-1 queued slot OR the coalescer). Keyed agent → set of
   * messageIds. Drives the `cc_hourglass` on message 2, the "N queued" count in
   * a status-ping reply, and the IN_FLIGHT-suppression at the queued-message's
   * own dispatch. Pruned lazily against `queuedMessageIds`; an entry equal to
   * the running turn's trigger is excluded from the count (it is running now).
   */
  private readonly queuedAskIds = new Map<string, Set<string>>();
  /**
   * 999.178 R1 — the current step label (last tool activity) of each agent's
   * running turn, so a status ping can name what the agent is doing without a
   * StatusTrail reference. Best-effort: only the streamStatus tool writer fills
   * it, so hold-mode / no-streamStatus turns render a status line without it.
   * Cleared at turn end.
   */
  private readonly liveStepLabel = new Map<string, string>();
  /** 999.178 R1 — durable mirror of queued asks (see coalesced-queue-store.ts). */
  private readonly coalescedQueueStatePath: string;
  /** 999.178 R1 — restore runs once; a second `ready` event must not re-add. */
  private queuedAsksRestored = false;
  /** Phase 999.154 — per-turn image side-channel (see pending-image-ledger.ts). */
  private readonly imageLedger = new PendingImageLedger();
  /** Phase 999.154 — multi-message upload gathering (see burst-gatherer.ts). */
  private readonly burstGatherer = new BurstGatherer();

  /**
   * Plan 117-09 seam, Plan 117-11 wiring — per-channel verbose-level state.
   *
   * In production, the daemon constructs a `VerboseState` instance backed
   * by `~/.clawcode/manager/verbose-state.db` (separate file from the
   * advisor budget — RESEARCH §6 Pitfall 4) and passes it via
   * `BridgeConfig.verboseState`. The single mutation point in
   * `streamAndPostResponse` (~:809) reads `getLevel(message.channelId)`
   * once per turn — at the same call site for both `"normal"` (plain
   * footer) and `"verbose"` (fenced advice block) branches.
   *
   * Standalone runner / tests may omit it; the seam falls through to
   * `"normal"` (no behavior change). `bridge-advisor-footer.test.ts`
   * Case F/F' still inject a structural stub via
   * `(bridge as any).verboseState = { getLevel: () => "verbose" }` —
   * `as any` bypasses the type so the stub keeps working.
   */
  private verboseState:
    | VerboseState
    | { getLevel(channelId: string): "normal" | "verbose" }
    | undefined;

  /**
   * Phase 135 Plan 02 — VoiceManager wired in at construction OR via
   * `setVoiceManager` post-construction (the daemon takes the
   * post-construction path because VoiceManager needs the bridge's
   * Discord client). Used by the `ready`/`resumed` listeners (autoJoin
   * sweep) and the `voiceStateUpdate` listener (Pitfall 5 receiver
   * cleanup). When null (standalone runner, most unit tests), all
   * voice-related listeners short-circuit.
   *
   * Mutable so the daemon can inject after the bridge boots — the
   * bridge's ready listener reads `this.voiceManager` at fire time
   * (not at construction time), so post-construction injection is safe
   * as long as it happens before `start()` is called.
   */
  private voiceManager: import("./voice/manager.js").VoiceManager | null;

  /**
   * Phase 135.5 — agents already warned (once per process) that
   * `voice.transcriptToChannel === true` is configured but the agent has
   * no text channels in `channels[]` to post into. Dedupes the
   * info-level log so it fires at most once per agent per process —
   * otherwise every voice turn for a misconfigured agent would spam.
   */
  private readonly voiceTranscriptToChannelWarnedAgents = new Set<string>();

  /**
   * Expose the Discord client for use by SubagentThreadSpawner.
   */
  get discordClient(): Client {
    return this.client;
  }

  /**
   * Set the webhook manager after construction.
   * Used when webhooks are auto-provisioned after the Client connects.
   */
  setWebhookManager(wm: WebhookManager): void {
    this.webhookManager = wm;
  }

  /** Phase 999.117 WS-2 — inject the shared cross-path delivery dedupe. */
  setDeliveryDedupe(dedupe: { claim(deliveryId: string | undefined): boolean }): void {
    this.deliveryDedupe = dedupe;
  }

  /**
   * Phase 999.144 — inject the inbound-channel auth policy (same
   * post-construction idiom as setDeliveryDedupe). Boot-applied: the daemon
   * calls this once at wiring time; a config change needs a restart, like
   * every other a2a knob.
   */
  setIngressAuth(policy: {
    envelopeAuthMode: EnvelopeAuthMode;
    allowedUserIds?: readonly string[];
  }): void {
    this.a2aEnvelopeAuthMode = policy.envelopeAuthMode;
    this.allowedUserIds = policy.allowedUserIds;
  }

  /**
   * Phase 135 Plan 02 — post-construction VoiceManager injection.
   *
   * The daemon constructs the bridge before the VoiceManager (because
   * the VoiceManager needs the bridge's Discord client). This setter
   * lets the daemon wire voice support after both objects exist. The
   * bridge's `client.on("ready")` listener reads `this.voiceManager`
   * at fire time, so post-construction injection is safe as long as
   * it happens BEFORE `start()` is called.
   */
  setVoiceManager(vm: import("./voice/manager.js").VoiceManager): void {
    this.voiceManager = vm;
  }

  /**
   * Phase 999.86 — post-construction dispatcher injection. The pool +
   * dispatcher are wired AFTER `SubagentThreadSpawner` is constructed
   * (they share the same daemon callbacks); the bridge is constructed
   * earlier. This setter lets the daemon connect the two without
   * reordering construction. Idempotent — calling it twice replaces the
   * dispatcher (canary use-case: hot-rewire after a pool restart).
   */
  setEphemeralChatDispatcher(
    dispatcher:
      | import("./ephemeral-chat-dispatcher.js").EphemeralChatDispatcher
      | undefined,
  ): void {
    this.ephemeralChatDispatcher = dispatcher;
  }

  /** Phase 141 — wire the pre-turn <memory-context> augmenter for v3 chat. */
  setMemoryContextAugmenter(
    augmenter: MemoryContextAugmenter | undefined,
  ): void {
    this.memoryContextAugmenter = augmenter;
  }

  constructor(config: BridgeConfig) {
    this.routingTableRef = config.routingTableRef;
    this.sessionManager = config.sessionManager;
    this.turnDispatcher = config.turnDispatcher;
    this.getBridge = config.getBridge;
    this.ephemeralChatDispatcher = config.ephemeralChatDispatcher;
    this.threadManager = config.threadManager;
    this.webhookManager = config.webhookManager;
    this.deliveryQueue = config.deliveryQueue;
    this.securityPolicies = config.securityPolicies;
    this.botToken = config.botToken ?? loadBotToken();
    this.log = config.log ?? logger;
    // 2026-08-28 — verification ledger persistence (constructed here, not in a
    // field initializer: it needs this.log, and field order would race it).
    let ledgerPersist: LedgerPersistence | undefined;
    if (config.ledgerDbPath) {
      try {
        ledgerPersist = new LedgerPersistence(config.ledgerDbPath, { log: this.log });
      } catch (err) {
        this.log.warn(
          { dbPath: config.ledgerDbPath, error: err instanceof Error ? err.message : String(err) },
          "verification ledger persistence unavailable — memory-only",
        );
      }
    }
    this.ledgerPersist = ledgerPersist;
    this.ledgerStore = new VerificationLedgerStore(ledgerPersist ? { persist: ledgerPersist } : {});
    this.onConversationTurn = config.onConversationTurn;
    // Phase 117 Plan 117-11 — daemon injects the real VerboseState here;
    // standalone runner / direct tests leave it undefined (mutation falls
    // through to "normal" branch — identical to Plan 117-09 pre-wiring).
    this.verboseState = config.verboseState;
    this.liveThinkingTiming = config.liveThinkingTiming;
    // 999.178 R1 — queued-ask persistence path. Overridable for tests; prod
    // uses the shared manager-dir default (beside the other *-state.json files).
    this.coalescedQueueStatePath =
      config.coalescedQueueStatePath ?? DEFAULT_COALESCED_QUEUE_STATE_PATH;
    // Phase 135 Plan 02 — VoiceManager wiring. Optional: standalone runner
    // and most unit tests omit it; the ready/resumed/voiceStateUpdate
    // listeners check for null before calling through.
    this.voiceManager = config.voiceManager ?? null;

    // P2-PROGRESS — edit-in-place ingest progress for attachment bursts. The
    // auto-ingest queue (a module singleton, init'd at boot) emits a per-item
    // event; we subscribe AFTER construction here (sidesteps the init-ordering
    // problem — queue.init runs before the bridge is built).
    this.ingestProgress = new AutoIngestProgress({ logger: this.log });
    autoIngestQueue.setObserver({
      onItemDone: (e) => this.ingestProgress.onItemDone(e),
    });

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
        // Phase 135 Plan 01 — required for receiver.speaking events to fire on
        // VoiceConnections (Pitfall 2 in 135-RESEARCH.md). The gateway silently
        // drops voice-state events for clients that haven't subscribed.
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });
  }

  /**
   * Start the bridge — connect to Discord and begin routing messages.
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    // 999.155 — drain ⏳-buffered messages stranded behind a self-fired turn.
    if (this.strandedDrainTimer === null) {
      this.strandedDrainTimer = setInterval(() => {
        void this.sweepStrandedCoalesced().catch(() => undefined);
      }, DiscordBridge.STRANDED_DRAIN_SWEEP_MS);
      (this.strandedDrainTimer as { unref?: () => void }).unref?.();
    }

    this.client.on("messageCreate", (message) => {
      this.log.info(
        { channel: message.channelId, author: message.author.username, bot: message.author.bot, content: message.content.slice(0, 50) },
        "messageCreate event received",
      );
      void this.handleMessage(message);
    });

    // Thread creation listener -- spawns thread sessions for bound channels.
    // Threads the bot creates itself (via SubagentThreadSpawner) are already
    // handled end-to-end by that path; handling them here too races on the
    // binding registry and produces duplicate threads.
    this.client.on("threadCreate", (thread) => {
      if (!this.threadManager) return;
      const botUserId = this.client.user?.id;
      if (botUserId && thread.ownerId === botUserId) {
        this.log.debug(
          { threadId: thread.id, threadName: thread.name },
          "threadCreate from own bot, ignoring (handled by SubagentThreadSpawner)",
        );
        return;
      }
      this.log.info(
        { threadId: thread.id, threadName: thread.name, parentId: thread.parentId },
        "threadCreate event received",
      );
      if (thread.parentId) {
        void this.threadManager.handleThreadCreate(
          thread.id,
          thread.name ?? "unnamed",
          thread.parentId,
        );
      }
    });

    // Reaction event listeners -- forward reactions in bound channels to agents
    this.client.on("messageReactionAdd", (reaction, user) => {
      void this.handleReaction(reaction, user, "add");
    });

    this.client.on("messageReactionRemove", (reaction, user) => {
      void this.handleReaction(reaction, user, "remove");
    });

    // Debug: log ALL events to see what's coming through
    this.client.on("debug", (info) => {
      if (info.includes("Heartbeat") || info.includes("Session")) return; // skip noise
      this.log.debug({ info }, "discord debug");
    });

    this.client.on("warn", (info) => {
      this.log.warn({ info }, "discord warning");
    });

    this.client.on("ready", () => {
      void this.loadIcons();
      // 999.178 R1 — re-seat queued asks persisted before a restart. After the
      // gateway is ready so channel fetches + the QUEUED re-issue work; the
      // stranded-drain sweep drains them once agents are up. Non-blocking, like
      // the daemon's hydrate calls (999.177 startup-drain concern).
      void this.restoreQueuedAsks().catch((err) =>
        this.log.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "queued-ask restore failed (non-fatal)",
        ),
      );
      const guilds = this.client.guilds.cache.map(g => ({ id: g.id, name: g.name }));
      this.log.info(
        { user: this.client.user?.tag, channels: this.routingTableRef.current.channelToAgent.size, guilds },
        "Discord bridge connected",
      );
      // Phase 135 Plan 02 — voice auto-join on initial connect.
      // RESEARCH § Pattern 1: agents with `voice.channelId` configured
      // are joined here. Fatal failures (perm, channel-deleted) are
      // recorded inside autoJoin so subsequent `resumed` events don't
      // retry storm. The catch is defensive — autoJoin's outer try
      // should never throw, but if it did we MUST NOT let it bubble
      // into discord.js's listener pump.
      if (this.voiceManager) {
        void this.voiceManager.autoJoin().catch((err) => {
          this.log.error(
            { error: err instanceof Error ? err.message : String(err) },
            "voiceManager.autoJoin threw on ready (caught at bridge boundary)",
          );
        });
      }
    });

    // Phase 135 Plan 02 — voice auto-join after gateway resume. The
    // `resumed` event fires after a session-resume (transient gateway
    // disconnect followed by recovery). Voice connections are tied to
    // the previous gateway session and may be invalidated on a hard
    // reconnect; re-running autoJoin restores them. Fatal-failure dedup
    // (inside autoJoin) prevents retry storms for known-broken joins.
    this.client.on("resumed", () => {
      this.log.info(
        { user: this.client.user?.tag },
        "Discord gateway resumed",
      );
      if (this.voiceManager) {
        void this.voiceManager.autoJoin().catch((err) => {
          this.log.error(
            { error: err instanceof Error ? err.message : String(err) },
            "voiceManager.autoJoin threw on resumed (caught at bridge boundary)",
          );
        });
      }
    });

    // Phase 135 Plan 02 — voice receiver cleanup on user leave
    // (RESEARCH Pitfall 5). Without this, per-user receiver
    // subscriptions opened in VoiceManager.attachSpeakingListeners
    // would leak — receivers stay subscribed even after the user
    // disconnects, holding the SSRC slot and accumulating until the
    // session is torn down.
    //
    // Trigger: a user transitions OUT of a voice channel that the bot
    // currently has a session in. Sources of the transition:
    //   - oldState.channelId set, newState.channelId === null (left voice entirely)
    //   - oldState.channelId set, newState.channelId !== oldState (moved to a different channel)
    //
    // The handler is intentionally tolerant — it only cleans up if the
    // bot HAS a session for `oldState.guild.id`. Events for guilds we
    // don't have a session in are no-ops.
    this.client.on("voiceStateUpdate", (oldState, newState) => {
      try {
        if (!this.voiceManager) return;
        // Spoofing guard (T-135-02-03): ignore events for the bot itself
        // (the bot's own join/leave is handled by VoiceManager.join/leave,
        // not by external state changes).
        if (oldState.id === this.client.user?.id) return;
        const guildId = oldState.guild?.id ?? newState.guild?.id;
        if (!guildId) return;
        // User-leave transition: was in a channel, now either out
        // entirely OR moved to a different channel.
        const wasInChannel = oldState.channelId != null;
        const sameChannel = oldState.channelId === newState.channelId;
        if (wasInChannel && !sameChannel) {
          this.voiceManager.handleUserLeave(guildId, oldState.id);
          // 999.116 hotfix — auto-leave when no humans remain in the channel
          // we are in. discord.js updates the cache before emitting, so the
          // leaver is already gone from `channel.members`.
          const remaining = oldState.channel?.members;
          const humansLeft = remaining
            ? remaining.filter((m) => m.user?.bot !== true).size
            : null;
          if (humansLeft === 0 && oldState.channelId) {
            void this.voiceManager
              .handleChannelEmpty(guildId, oldState.channelId)
              .catch(() => undefined);
          }
        }
        // 999.116 hotfix — auto-join when a human enters an agent's voice
        // channel (the manager checks the channel binding + autoJoinOnUser).
        const joinedChannel = newState.channelId != null && !sameChannel;
        if (joinedChannel && newState.channelId) {
          void this.voiceManager
            .handleUserJoin(
              guildId,
              newState.channelId,
              newState.id,
              newState.member?.user?.bot === true,
            )
            .catch(() => undefined);
        }
      } catch (err) {
        // Pitfall 8 — never let voice-state handling leak into the
        // shared discord.js Client.
        this.log.error(
          { error: err instanceof Error ? err.message : String(err) },
          "voiceStateUpdate handler threw (caught at bridge boundary)",
        );
      }
    });

    this.client.on("error", (error) => {
      this.log.error({ error: error.message }, "Discord client error");
    });

    // 2026-05-08 hotfix — Discord-side outages (Service Unavailable / Internal
    // Server Error during gateway shard recovery) used to leave the bridge
    // permanently dead because there was no startup retry. The bot would come
    // up healthy but blind to Discord; only a manual daemon restart could
    // recover. Now: 5 attempts with exponential backoff (0s, 5s, 15s, 30s, 60s
    // — total ~110s window) so a transient Discord outage at deploy time
    // doesn't require operator intervention. Final failure still logs at
    // error and lets the daemon continue (existing fallback path); operator
    // can run `clawcode discord-reconnect` (TODO) or restart manually if all
    // 5 attempts fail.
    const RETRY_DELAYS_MS = [0, 5_000, 15_000, 30_000, 60_000];
    let lastError: unknown = null;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
      const delay = RETRY_DELAYS_MS[attempt] ?? 0;
      if (delay > 0) {
        this.log.warn(
          { attempt: attempt + 1, totalAttempts: RETRY_DELAYS_MS.length, delayMs: delay, lastError: lastError instanceof Error ? lastError.message : String(lastError) },
          "Discord bridge login retrying after backoff",
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        await this.client.login(this.botToken);
        this.deliveryQueue?.start();
        this.running = true;
        if (attempt > 0) {
          this.log.info({ attemptsUsed: attempt + 1 }, "Discord bridge connected after retry");
        }
        return;
      } catch (err) {
        lastError = err;
        this.log.error(
          { attempt: attempt + 1, totalAttempts: RETRY_DELAYS_MS.length, error: err instanceof Error ? err.message : String(err) },
          "Discord bridge login attempt failed",
        );
      }
    }
    // All retries exhausted — re-throw to preserve the existing "bridge failed
    // to start" log line + fallback in daemon.ts (manual webhook mode).
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Send a budget alert embed to a Discord channel.
   * Fire-and-forget: errors are logged, never thrown.
   */
  async sendBudgetAlert(
    channelId: string,
    data: {
      readonly agent: string;
      readonly model: string;
      readonly tokensUsed: number;
      readonly tokenLimit: number;
      readonly period: string;
      readonly threshold: "warning" | "exceeded";
    },
  ): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !("send" in channel) || typeof channel.send !== "function") {
        this.log.warn({ channelId }, "cannot send budget alert: channel not sendable");
        return;
      }

      const percentage = Math.round((data.tokensUsed / data.tokenLimit) * 100);
      const isExceeded = data.threshold === "exceeded";

      const embed = new EmbedBuilder()
        .setTitle(isExceeded ? "Budget Exceeded" : "Budget Warning")
        .setColor(isExceeded ? 0xFF0000 : 0xFFCC00)
        .addFields(
          { name: "Agent", value: data.agent, inline: true },
          { name: "Model", value: data.model, inline: true },
          { name: "Usage", value: `${data.tokensUsed.toLocaleString()} / ${data.tokenLimit.toLocaleString()} (${percentage}%)`, inline: true },
          { name: "Period", value: data.period, inline: true },
        )
        .setTimestamp();

      await channel.send({ embeds: [embed] });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error({ channelId, error: errorMsg, agent: data.agent }, "failed to send budget alert");
    }
  }

  /**
   * Phase 132 Plan 03 T-02 — post an EmbedBuilder to the agent's bound
   * Discord channel. Single helper used by the Phase 132 skill-draft review
   * surface (skill-draft-embed.ts postSkillDraftEmbed) and reusable by any
   * future "post arbitrary embed to agent channel" caller. Resolves the
   * channel via routingTableRef.current.agentToChannels (same lookup the
   * ask-agent IPC mirror uses at daemon-ask-agent-ipc.ts) and forwards to
   * channel.send mirroring sendBudgetAlert's structure — NOT a new Discord
   * posting path; same client.channels.fetch + channel.send chain.
   *
   * Returns the resulting message ID on success, null on any failure
   * (no channel binding, channel unsendable, send threw). All failure
   * paths log structured at warn or error level.
   */
  async postEmbedToAgentChannel(
    agent: string,
    embed: EmbedBuilder,
  ): Promise<string | null> {
    const channels = this.routingTableRef.current.agentToChannels.get(agent);
    const channelId = channels?.[0];
    if (!channelId) {
      this.log.warn(
        { agent },
        "postEmbedToAgentChannel: no channel binding for agent",
      );
      return null;
    }
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !("send" in channel) || typeof channel.send !== "function") {
        this.log.warn(
          { agent, channelId },
          "postEmbedToAgentChannel: channel not sendable",
        );
        return null;
      }
      const sent = await channel.send({ embeds: [embed] });
      return sent.id;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(
        { agent, channelId, error: errorMsg },
        "postEmbedToAgentChannel: send failed",
      );
      return null;
    }
  }

  /**
   * Post a Discord Components v2 (CV2) message to the agent's bound
   * channel. Looks up the channel via `routingTableRef.current.agentToChannels`
   * (same lookup `postEmbedToAgentChannel` uses), then sends our exact CV2
   * payload via the raw REST API — bypassing
   * `MessagePayload.resolveBody()`.
   *
   * Why the REST bypass: discord.js v14.26.2's `MessagePayload.resolveBody()`
   * unconditionally adds `content: ''` and `embeds: []` to every message
   * body, even when `flags: IsComponentsV2` is set. Discord's CV2 spec
   * forbids `content`, `embeds`, `stickers`, and `poll` fields (even empty)
   * when that flag is on, so Discord rejects with HTTP 400 "Invalid
   * Request" before validating the component structure. The library's
   * design assumes the classic embed+content model and v15 (which has
   * proper CV2 support) is still pre-release. Calling
   * `client.rest.post(Routes.channelMessages(id), { body })` puts our
   * exact JSON on the wire — same auth, same rate limits — without
   * library-side body mangling. This is the canonical low-level path
   * discord.js itself uses (see `MessageManager.crosspost` line 275).
   *
   * The agent's call path is: MCP tool `post_cv2_embed` → IPC
   * `post-cv2-embed` → this method. After calling the tool the agent
   * should ack with empty `result` so the existing post-skip in the
   * response path (`response.trim().length > 0`) suppresses the redundant
   * text follow-up.
   *
   * Returns the resulting message ID on success, or a structured error
   * result on validation/send failure — caller forwards to the MCP
   * tool's response so the agent can adapt.
   */
  /**
   * 999.143 — edit a CV2 card already posted in an agent's channel.
   *
   * The transcription watcher posts ONE progress card per job and then redraws
   * it as the job advances. Editing keeps that to a single message; posting per
   * phase would turn a long recording into a wall of notifications.
   *
   * Mirrors `postCv2ToAgentChannel`'s channel resolution exactly, so a card can
   * only ever be edited in the channel it was posted to.
   */
  async editCv2InAgentChannel(
    agent: string,
    messageId: string,
    spec: Cv2Spec,
  ): Promise<{ ok: true } | { ok: false; reason: string; detail: string }> {
    const channels = this.routingTableRef.current.agentToChannels.get(agent);
    const channelId = channels?.[0];
    if (!channelId) {
      return { ok: false, reason: "no-binding", detail: `no channel binding for agent ${agent}` };
    }
    try {
      buildCv2Payload(spec);   // fail closed on a bad spec rather than 400ing Discord
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log.warn({ agent, channelId, error: detail }, "editCv2InAgentChannel: invalid spec");
      return { ok: false, reason: "invalid-spec", detail };
    }
    const ok = await editCv2Message({
      rest: this.client.rest as unknown as RestLike,
      channelId,
      messageId,
      spec,
      // The progress card is text only. Passing [] is the documented idiom for
      // "keep no attachments", which is correct here and avoids re-uploading.
      files: [],
      log: this.log,
    });
    return ok
      ? { ok: true }
      : { ok: false, reason: "edit-failed", detail: "Discord rejected the edit" };
  }

  async postCv2ToAgentChannel(
    agent: string,
    spec: Cv2Spec,
    files: readonly OutboundFile[] = [],
  ): Promise<
    | { ok: true; messageId: string }
    | { ok: false; reason: "no-binding" | "invalid-spec" | "send-failed"; detail: string }
  > {
    const channels = this.routingTableRef.current.agentToChannels.get(agent);
    const channelId = channels?.[0];
    if (!channelId) {
      this.log.warn(
        { agent },
        "postCv2ToAgentChannel: no channel binding for agent",
      );
      return { ok: false, reason: "no-binding", detail: `no channel binding for agent ${agent}` };
    }

    let payload: ReturnType<typeof buildCv2Payload>;
    try {
      payload = buildCv2Payload(spec);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.warn(
        { agent, channelId, error: errorMsg },
        "postCv2ToAgentChannel: spec validation failed",
      );
      return {
        ok: false,
        reason: "invalid-spec",
        detail: error instanceof Cv2ValidationError ? error.message : errorMsg,
      };
    }

    // 2026-09-10 — cards that carry attachments (media galleries, thumbnails,
    // file blocks) go through `postCv2WithFiles`, the bot-identity path
    // proven end-to-end: same REST route, body === payload, the
    // files riding the same multipart call so `attachment://<name>` binds.
    // It also fails closed on a reference with no backing file. The
    // attachment-free path below is untouched (its exact REST call is pinned
    // by bridge-cv2.test.ts).
    if (files.length > 0) {
      const res = await postCv2WithFiles({
        rest: this.client.rest as unknown as RestLike,
        channelId,
        spec,
        files,
        identity: "bot",
        log: this.log,
      });
      if (!res.ok) {
        this.log.error(
          { agent, channelId, error: res.reason, files: files.length },
          "postCv2ToAgentChannel: send with files failed",
        );
        return { ok: false, reason: "send-failed", detail: res.reason };
      }
      this.log.info(
        { agent, channelId, messageId: res.messageId, blockCount: spec.blocks.length, files: files.length },
        "CV2 embed posted (with files)",
      );
      return { ok: true, messageId: res.messageId };
    }

    try {
      const route = Routes.channelMessages(channelId);
      const result = (await this.client.rest.post(route, { body: payload })) as {
        readonly id: string;
      };
      this.log.info(
        { agent, channelId, messageId: result.id, blockCount: spec.blocks.length },
        "CV2 embed posted",
      );
      return { ok: true, messageId: result.id };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(
        { agent, channelId, error: errorMsg },
        "postCv2ToAgentChannel: send failed",
      );
      return { ok: false, reason: "send-failed", detail: errorMsg };
    }
  }

  /**
   * Backlog 999.95 — post a one-tap launch affordance for the live preview into
   * the agent's bound channel.
   *
   * Discord activity-launch invites are voice-channel-scoped: the only true
   * one-tap mechanism is `POST /channels/{voiceChannelId}/invites` with
   * `target_type=2, target_application_id`. So this is two-tier:
   *   1. Voice path — if a voice channel resolves (the operator's current voice
   *      state, or a configured `DISCORD_ACTIVITY_VOICE_CHANNEL_ID`), create the
   *      activity invite there and post a link button to the agent's text
   *      channel → tapping it opens the Activity straight into the preview.
   *   2. Text fallback — no voice channel (or the invite failed): post a plain
   *      message. The Activity self-resolves `/preview/current` on open, so no
   *      launch params need to travel through Discord.
   *
   * Config comes from env (operator-level deploy settings, not per-agent):
   * `DISCORD_ACTIVITY_APP_ID` (defaults to the public Clawdy Code app id),
   * `DISCORD_ACTIVITY_OPERATOR_ID`, `DISCORD_ACTIVITY_VOICE_CHANNEL_ID`. The
   * guild is derived from the agent's text channel. Never throws into the
   * preview push — all failures return a structured `{ ok: false }`.
   */
  /**
   * 999.95-fu (2026-09-02) — post (or hot-update) the inline PNG snapshot for a
   * preview id. First delivery for an id sends a new message with the image;
   * subsequent deliveries EDIT that message's attachment in place, mirroring
   * the Activity's own hot-reload semantics ("updates without relaunch") on the
   * instant-view surface. If the tracked message vanished (deleted), falls back
   * to posting fresh and re-tracks.
   */
  private readonly previewSnapshotMessages = new Map<string, string>();

  async postPreviewSnapshot(args: {
    readonly agent: string;
    readonly previewId: string;
    readonly media: Buffer;
    readonly filename: string;
    readonly caption: string;
    readonly links?: readonly { readonly label: string; readonly url: string }[];
  }): Promise<{ ok: boolean; reason?: string }> {
    const channelId = this.routingTableRef.current.agentToChannels.get(args.agent)?.[0];
    if (!channelId) {
      return { ok: false, reason: "no-binding" };
    }
    let channel: unknown;
    try {
      channel = await this.client.channels.fetch(channelId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `channel-fetch: ${msg.slice(0, 120)}` };
    }
    const sendable = channel as {
      send?: (o: object) => Promise<{ id: string }>;
      messages?: { fetch: (id: string) => Promise<{ edit: (o: object) => Promise<unknown> }> };
    } | null;
    if (!sendable?.send) {
      return { ok: false, reason: "channel-not-sendable" };
    }
    // Link buttons ride WITH the image so the reader can jump straight to the
    // product page. Always send `components` (empty on edit) so a re-push that
    // drops its links actually clears the stale buttons.
    const buttons = (args.links ?? []).slice(0, 5).map((l) => ({
      type: 2,
      style: 5,
      label: l.label.slice(0, 80),
      url: l.url,
    }));
    const payload = {
      content: args.caption,
      files: [{ attachment: args.media, name: args.filename }],
      components: buttons.length > 0 ? [{ type: 1, components: buttons }] : [],
    };
    const priorId = this.previewSnapshotMessages.get(args.previewId);
    if (priorId && sendable.messages) {
      try {
        const prior = await sendable.messages.fetch(priorId);
        await prior.edit(payload);
        return { ok: true };
      } catch {
        // Deleted/unreachable — fall through to a fresh post below.
        this.previewSnapshotMessages.delete(args.previewId);
      }
    }
    try {
      const sent = await sendable.send(payload);
      this.previewSnapshotMessages.set(args.previewId, sent.id);
      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `send: ${msg.slice(0, 120)}` };
    }
  }

  /**
   * 999.95-fu2 — mint an embedded-Activity invite URL WITHOUT posting a message.
   *
   * `postActivityLaunchButton` below does the same work but always posts its
   * own message. Since 2026-09-02 the preview push leads with a snapshot and
   * the operator explicitly did not want a second post carrying a link — so
   * the launch affordance became a fallback that, in practice, never fired.
   * Returning just the URL lets the caller hang the real Activity launch on
   * the snapshot message itself: one message, and the button still opens the
   * Activity inside Discord rather than a browser tab.
   *
   * The returned `https://discord.gg/<code>` is an ordinary https URL, so it
   * is a legal Discord link-button target.
   *
   * Returns undefined when no invite can be minted — most often because no
   * voice channel resolves. NOTE: with `DISCORD_ACTIVITY_VOICE_CHANNEL_ID`
   * unset, resolution falls back to wherever the operator is CURRENTLY sitting
   * in voice, so the button silently disappears whenever they are not in a
   * voice channel. Set that env var to make it deterministic.
   */
  async createActivityInviteUrl(agent: string): Promise<string | undefined> {
    const channelId = this.routingTableRef.current.agentToChannels.get(agent)?.[0];
    if (!channelId) return undefined;

    const appId =
      process.env.DISCORD_ACTIVITY_APP_ID?.trim() || CLAWDY_ACTIVITY_APP_ID;
    if (!appId) return undefined;

    let guildId: string | null = null;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && "guildId" in channel) {
        guildId = (channel as { guildId: string | null }).guildId ?? null;
      }
    } catch {
      return undefined;
    }

    const voiceChannelId = this.resolveActivityVoiceChannel(guildId);
    if (!voiceChannelId) {
      this.log.info(
        { agent, guildId },
        "activity invite skipped — no voice channel resolved (set DISCORD_ACTIVITY_VOICE_CHANNEL_ID for a stable target)",
      );
      return undefined;
    }

    try {
      const invite = (await this.client.rest.post(
        Routes.channelInvites(voiceChannelId),
        {
          body: {
            max_age: 0,
            target_type: INVITE_TARGET_EMBEDDED_APPLICATION,
            target_application_id: appId,
          },
        },
      )) as { code: string };
      return `https://discord.gg/${invite.code}`;
    } catch (error) {
      // Best-effort decoration: a failed invite must never cost the operator
      // the snapshot it was going to be attached to.
      this.log.warn(
        {
          agent,
          voiceChannelId,
          error: error instanceof Error ? error.message : String(error),
        },
        "activity invite mint failed",
      );
      return undefined;
    }
  }

  async postActivityLaunchButton(args: {
    readonly agent: string;
    readonly previewId: string;
    readonly previewUrl: string;
  }): Promise<
    | { ok: true; mode: "voice-invite" | "fallback-message"; messageId: string }
    | { ok: false; reason: string }
  > {
    const channelId = this.routingTableRef.current.agentToChannels.get(args.agent)?.[0];
    if (!channelId) {
      this.log.warn({ agent: args.agent }, "postActivityLaunchButton: no channel binding");
      return { ok: false, reason: "no-binding" };
    }

    const appId =
      process.env.DISCORD_ACTIVITY_APP_ID?.trim() || CLAWDY_ACTIVITY_APP_ID;
    if (!appId) {
      return { ok: false, reason: "no-app-id" };
    }

    // Derive the guild from the agent's text channel, then resolve a voice
    // channel for the one-tap activity invite.
    let guildId: string | null = null;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && "guildId" in channel) {
        guildId = (channel as { guildId: string | null }).guildId ?? null;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.warn(
        { agent: args.agent, channelId, error: msg },
        "postActivityLaunchButton: channel fetch failed",
      );
    }

    const voiceChannelId = this.resolveActivityVoiceChannel(guildId);

    // Voice path — true one-tap activity invite.
    if (voiceChannelId) {
      try {
        const invite = (await this.client.rest.post(
          Routes.channelInvites(voiceChannelId),
          {
            body: {
              max_age: 0,
              target_type: INVITE_TARGET_EMBEDDED_APPLICATION,
              target_application_id: appId,
            },
          },
        )) as { code: string };
        const url = `https://discord.gg/${invite.code}`;
        const sent = (await this.client.rest.post(Routes.channelMessages(channelId), {
          body: {
            content: `🪟 Live preview ready (\`${args.previewId}\`). Tap to open it in Discord:`,
            components: [
              {
                type: 1,
                components: [{ type: 2, style: 5, label: "Open Live Preview", url }],
              },
            ],
          },
        })) as { id: string };
        this.log.info(
          { agent: args.agent, channelId, voiceChannelId, messageId: sent.id },
          "activity launch invite posted",
        );
        return { ok: true, mode: "voice-invite", messageId: sent.id };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log.warn(
          { agent: args.agent, voiceChannelId, error: msg },
          "activity invite failed — falling back to text message",
        );
        // fall through to the text fallback below
      }
    }

    // Text fallback — no voice channel (or the invite failed). The Activity
    // self-resolves /preview/current on open.
    try {
      const note =
        `🪟 Live preview ready (\`${args.previewId}\`). Open the **Clawdy Code** ` +
        `activity to view it — it opens straight to the latest preview.` +
        (args.previewUrl ? `\n${args.previewUrl}` : "");
      const sent = (await this.client.rest.post(Routes.channelMessages(channelId), {
        body: { content: note },
      })) as { id: string };
      return { ok: true, mode: "fallback-message", messageId: sent.id };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.error(
        { agent: args.agent, channelId, error: msg },
        "postActivityLaunchButton: fallback post failed",
      );
      return { ok: false, reason: msg };
    }
  }

  /**
   * Resolve the voice channel for the activity invite. An explicit
   * `DISCORD_ACTIVITY_VOICE_CHANNEL_ID` wins; otherwise look up the operator's
   * current voice state in the agent's guild (requires GuildVoiceStates intent,
   * which the client enables). Returns null when no voice channel applies — the
   * caller then posts the text fallback.
   */
  private resolveActivityVoiceChannel(guildId: string | null): string | null {
    const configured = process.env.DISCORD_ACTIVITY_VOICE_CHANNEL_ID?.trim();
    if (configured) return configured;
    const operatorId = process.env.DISCORD_ACTIVITY_OPERATOR_ID?.trim();
    if (!operatorId || !guildId) return null;
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return null;
    return guild.voiceStates.cache.get(operatorId)?.channelId ?? null;
  }

  /**
   * Phase 145 WS3 (Plan 04) — Discord-native interactive prompt. Renders the
   * neutral question batch (≤4) as StringSelectMenus (one per question) + a
   * Submit button, posts the card AS THE BOT (so the component custom_id
   * interactions route back to the bot gateway — a webhook post does NOT), and
   * collects the operator's selections via an operator-filtered
   * `createMessageComponentCollector`. Returns the {@link NeutralAnswers} on
   * Submit, or `null` on timeout / channel error (the daemon handler owns the
   * canonical bounded timeout via Promise.race, so `null` is a clean unblock).
   *
   * Self-contained: this path does NOT register a pending-prompt entry — the
   * collector is its own resolution channel. (The handleMessage registry
   * intercept stays a pure no-op safety net for Discord; only the text
   * fallback registers.) Operator attribution is FAIL-CLOSED: an empty
   * allowlist means the filter accepts no one and the collector simply times
   * out (the daemon surfaces `no-operator` before ever calling this).
   *
   * Mirrors the bot-post-for-interaction pattern of the other bot-posted
   * component cards (bridge.ts) + the operator-filtered component collection of the slash
   * model-picker (slash-commands.ts).
   */
  async askQuestionDiscord(
    channelId: string,
    questions: readonly NeutralQuestion[],
    allowlistIds: readonly string[],
    timeoutMs: number,
    promptId: string,
  ): Promise<NeutralAnswers | null> {
    const SUBMIT_TOKEN = "__submit__";
    // Discord caps a message at 5 action rows. We use one row per question
    // (≤4) + one row for the Submit button → ≤5. Each select is also capped at
    // 25 options by Discord; the neutral batch should already be ≤25.
    const capped = questions.slice(0, 4);
    // Use a SHORT positional token (q0..q3) in the custom_id rather than the
    // model-supplied question id — a long id would blow Discord's 100-char
    // custom_id cap and the REST post would throw (degrading to a timeout).
    // We translate the token back to the real questionId via `capped[idx]`.
    const tokenFor = (i: number) => `q${i}`;

    try {
      const selectRows = capped.map((q, i) => {
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`pp:${promptId}:${tokenFor(i)}`)
          .setPlaceholder(q.header.slice(0, 150))
          .setMinValues(1)
          .setMaxValues(q.multiSelect ? Math.max(1, q.options.length) : 1)
          .addOptions(
            q.options.slice(0, 25).map((o) => {
              const opt = new StringSelectMenuOptionBuilder()
                .setLabel(o.label.slice(0, 100))
                .setValue(o.id.slice(0, 100));
              if (o.description) opt.setDescription(o.description.slice(0, 100));
              return opt;
            }),
          );
        return new ActionRowBuilder<StringSelectMenuBuilder>()
          .addComponents(menu)
          .toJSON();
      });

      const submitRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`pp:${promptId}:${SUBMIT_TOKEN}`)
            .setLabel("Submit")
            .setStyle(ButtonStyle.Primary),
        )
        .toJSON();

      const content = capped
        .map((q, i) => {
          const body = q.text ? `\n${q.text}` : "";
          const multi = q.multiSelect ? " _(select one or more)_" : "";
          return `**${i + 1}. ${q.header}**${multi}${body}`;
        })
        .join("\n");

      await this.client.rest.post(Routes.channelMessages(channelId), {
        body: { content, components: [...selectRows, submitRow] },
      });

      const channel = await this.client.channels.fetch(channelId);
      if (
        !channel ||
        !("createMessageComponentCollector" in channel) ||
        typeof channel.createMessageComponentCollector !== "function"
      ) {
        this.log.warn(
          { channelId },
          "askQuestionDiscord: channel not collectable",
        );
        return null;
      }

      // Keyed by the positional token (q0..q3) → chosen option ids.
      const selections = new Map<string, readonly string[]>();

      return await new Promise<NeutralAnswers | null>((resolve) => {
        const collector = channel.createMessageComponentCollector({
          // Operator allowlist filter (fail-closed) + this prompt's components.
          filter: (i: MessageComponentInteraction) =>
            allowlistIds.includes(i.user.id) &&
            i.customId.startsWith(`pp:${promptId}:`),
          time: timeoutMs,
        });

        let settled = false;
        const finish = (answers: NeutralAnswers | null) => {
          if (settled) return;
          settled = true;
          collector.stop();
          resolve(answers);
        };

        collector.on("collect", (interaction: MessageComponentInteraction) => {
          const token = interaction.customId.slice(`pp:${promptId}:`.length);
          if (token === SUBMIT_TOKEN) {
            // Submit: resolve only when EVERY question has a selection.
            if (selections.size < capped.length) {
              void interaction
                .reply({
                  content: "Please answer every question before submitting.",
                  flags: 64, // ephemeral
                })
                .catch(() => undefined);
              return;
            }
            // Translate positional tokens back to the real questionIds.
            const answers: NeutralAnswer[] = capped.map((q, i) => ({
              questionId: q.id,
              selectedOptionIds: selections.get(tokenFor(i)) ?? [],
            }));
            void interaction
              .update({ content: "Answer recorded.", components: [] })
              .catch(() => undefined);
            finish({ answers });
            return;
          }
          // A select menu: record the chosen option ids for that question.
          if (interaction.isStringSelectMenu()) {
            selections.set(token, [...interaction.values]);
          }
          void interaction.deferUpdate().catch(() => undefined);
        });

        collector.on("end", (_collected, reason) => {
          if (reason === "time") finish(null);
        });
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.error(
        { channelId, promptId, error: msg },
        "askQuestionDiscord: render/collect failed",
      );
      return null;
    }
  }

  /**
   * Stop the bridge — disconnect from Discord.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    if (this.strandedDrainTimer !== null) clearInterval(this.strandedDrainTimer);
    this.strandedDrainTimer = null;
    this.deliveryQueue?.stop();
    this.ledgerPersist?.close();
    this.client.removeAllListeners();
    await this.client.destroy();
    this.running = false;
    this.log.info("Discord bridge disconnected");
  }

  /**
   * Phase 54 Plan 02 — Discord.js Message.type === 0 (Default) or 19 (Reply)
   * are the only message types that represent a user-authored chat message.
   * Everything else (pin notices, thread-created system messages, channel
   * follow adds, etc.) is NOT a user message and should NOT trigger the
   * typing indicator.
   *
   * CONTEXT D-04 guard #4: "Message type is a user message (not system/pin/etc)".
   */
  private isUserMessageType(message: Message): boolean {
    return message.type === 0 || message.type === 19;
  }

  /**
   * Auto-steer Path B (2026-05-23) — daemon IPC handler calls this after
   * posting the forwarded steer message into the subagent's thread, so
   * the next `MessageCreate` event for that ID (which would normally be
   * filtered as a bot post) is whitelisted and flows through the
   * auto-steer trigger in the thread-route branch above. The Set entry
   * is consumed (deleted) on first read so it never leaks.
   */
  markPendingSteer(messageId: string): void {
    this.pendingSteerMessageIds.add(messageId);
  }

  /**
   * Auto-steer Path B (2026-05-23) — post a steer-forward message into a
   * subagent's thread on behalf of the daemon IPC handler. Returns the
   * posted message's ID so the caller can pair it with
   * `markPendingSteer`. Returns `null` if the channel can't be fetched
   * or doesn't support `send`. The bridge's private `client` is
   * encapsulated here so the daemon doesn't reach across the surface.
   */
  async postToThread(
    threadId: string,
    content: string,
  ): Promise<{ id: string } | null> {
    try {
      const channel = await this.client.channels.fetch(threadId).catch(() => null);
      const sendable = channel as
        | { send?: (content: string) => Promise<{ id: string }> }
        | null;
      if (!sendable || typeof sendable.send !== "function") {
        return null;
      }
      return await sendable.send(content);
    } catch (err) {
      this.log.warn(
        { threadId, err: (err as Error).message },
        "bridge.postToThread failed",
      );
      return null;
    }
  }

  /**
   * Phase 119 A2A-03 — single mutation point for the queue-state icon.
   *
   * Wraps `transitionQueueState` with a per-message DiscordChannelHandle
   * adapter built from the live discord.js Message object. The state
   * machine module owns the mutex, debounce, retry, and prior-emoji
   * tracking — bridge.ts no longer remembers which emoji it last added.
   *
   * Reaction failures NEVER abort delivery. The state machine swallows
   * non-rate-limit errors internally; this outer try/catch is a belt-and-
   * suspenders guard in case a future refactor changes that contract.
   */
  /**
   * Record a message_id as having received a wedge stall notice. Returns
   * `true` the FIRST time (caller should post the notice), `false` on every
   * subsequent call for the same id (caller should suppress the duplicate).
   * FIFO-bounded so the terminal-only set cannot grow unbounded.
   */
  private rememberNoticedOnce(id: string): boolean {
    if (this.noticedMessageIds.has(id)) return false;
    this.noticedMessageIds.add(id);
    const CAP = 1024;
    if (this.noticedMessageIds.size > CAP) {
      const oldest = this.noticedMessageIds.values().next().value;
      if (oldest !== undefined) this.noticedMessageIds.delete(oldest);
    }
    return true;
  }

  /**
   * 999.178 R1 — forget a message's "already noticed" mark so a USER-INITIATED
   * retry of it can post a fresh failure notice + Retry button if it fails
   * again. Without this, the retried turn re-uses the original message id, so
   * `rememberNoticedOnce` would suppress the second notice and the user would
   * see a silent failure.
   */
  private forgetNoticedOnce(id: string): void {
    this.noticedMessageIds.delete(id);
  }

  private async transitionIcon(message: Message, target: QueueState): Promise<void> {
    const handle: DiscordChannelHandle = {
      addReaction: async (_channelId, _messageId, emoji) => {
        // `emoji` is a `cc_name:id` identifier; discord.js v14 Message.react
        // accepts that form (same as the advisor reaction at ~4739).
        await message.react(emoji);
      },
      removeReaction: async (_channelId, _messageId, emoji) => {
        // 999.178 R1 — custom-emoji reactions are cached by emoji ID, not by
        // name; the pre-migration `cache.get(emoji)` (keyed by the whole
        // `name:id` string, or the old Unicode glyph) never matched a custom
        // emoji, so the prior icon was never removed. Key by the id.
        const reaction = message.reactions.cache.get(reactionCacheKey(emoji));
        if (!reaction) return;
        const botUserId = message.client.user?.id;
        if (botUserId) {
          await reaction.users.remove(botUserId);
        }
      },
    };
    try {
      await transitionQueueState(
        message.channelId,
        message.id,
        target,
        handle,
        (state) => icons.reaction(QUEUE_STATE_ICON[state]),
      );
    } catch (err) {
      this.log.warn(
        { error: (err as Error).message, target, messageId: message.id },
        "queue-state icon transition failed (non-fatal, delivery unaffected)",
      );
    }
  }

  /**
   * Phase 119 A2A-03 hotfix 2026-05-14 #3 — transition the queue-state icon
   * on a message identified by ID only (rather than a live Message ref).
   *
   * Used by the coalescer-drain path: when QUEUE_FULL stacks M2/M3 while M1
   * processes, the eventual drain dispatches a synthesized combined payload
   * via streamAndPostResponse(M1, ..., combinedPayload). Without this
   * helper, the IN_FLIGHT/DELIVERED transitions in streamAndPostResponse
   * check `queuedMessageIds.has(message.id)` — but `message.id` is M1's,
   * not M2's or M3's, so the check fails and M2/M3's ⏳ icons stay stuck
   * forever. Caller fetches the pending messages by ID and routes through
   * here so the transitions land on the actual queued messages.
   *
   * Lookup is cache-first (channel.messages.cache.get), falling back to
   * an API fetch. On 404 (message deleted) or other fetch errors, logs a
   * warn and returns — reaction failures NEVER abort delivery.
   */
  private async transitionIconByMessageId(
    channel: Message["channel"],
    channelId: string,
    messageId: string,
    target: QueueState,
  ): Promise<void> {
    let resolved: Message | undefined;
    // Cast through unknown — discord.js v14 typings; cache + fetch live on
    // TextChannel / DMChannel / ThreadChannel, all of which carry them.
    const ch = channel as unknown as {
      messages?: {
        cache?: Map<string, Message>;
        fetch?: (id: string) => Promise<Message>;
      };
    };
    const cached = ch.messages?.cache?.get(messageId);
    if (cached) {
      resolved = cached;
    } else if (ch.messages?.fetch) {
      try {
        resolved = await ch.messages.fetch(messageId);
      } catch (err) {
        this.log.warn(
          { error: (err as Error).message, target, messageId, channelId },
          "queue-state icon transition skipped — message fetch failed (deleted? expired? non-fatal)",
        );
        return;
      }
    }
    if (!resolved) {
      this.log.warn(
        { target, messageId, channelId },
        "queue-state icon transition skipped — message not found in cache and no fetch available (non-fatal)",
      );
      return;
    }
    await this.transitionIcon(resolved, target);
  }

  /**
   * Phase 54 Plan 02 — fire the Discord typing indicator AND record a
   * `typing_indicator` span on the caller-owned Turn. The span opens on
   * entry and ends synchronously right after the sendTyping() call, so
   * its duration captures the fire latency (not any downstream work).
   *
   * Wrapped in try/catch so that typing failures NEVER block the response
   * path (CONTEXT D-04: typing is observational only). A rejected
   * sendTyping() promise is caught separately and logged at pino.debug.
   */
  private fireTypingIndicator(message: Message, turn: Turn | undefined): void {
    let span: Span | undefined;
    try {
      span = turn?.startSpan("typing_indicator", {});
      if ("sendTyping" in message.channel && typeof message.channel.sendTyping === "function") {
        void message.channel.sendTyping().catch((err) => {
          this.log.debug(
            { error: (err as Error).message, channelId: message.channelId },
            "sendTyping failed — observational, non-fatal",
          );
        });
      }
    } catch (err) {
      this.log.debug(
        { error: (err as Error).message, channelId: message.channelId },
        "typing indicator setup failed — observational, non-fatal",
      );
    } finally {
      try { span?.end(); } catch { /* non-fatal */ }
    }
  }

  /**
   * Phase 999.43 Plan 02 T02 — fire-and-forget auto-ingest dispatch.
   *
   * Dispatches every downloaded attachment to the daemon's
   * `auto-ingest-attachment` IPC handler (Plan 02 T01). The agent's turn
   * does NOT wait on this call — it runs in parallel with the SDK request
   * and may complete after the assistant has already replied. This matches
   * the Phase 101 daemon-tick reindex precedent (best-effort enrichment).
   *
   * Single auto-ingest dispatch site per feedback_silent_path_bifurcation.md.
   * Daemon-side handler decides eligibility (agent flag, classifier reject)
   * and writes the D-04 provenance row.
   */
  /**
   * Phase 999.154 — attachment intake shared by the thread and channel routes:
   * burst announce/open (on ARRIVAL, before downloads), download, auto-ingest
   * dispatch, the legacy Haiku pre-pass only in `vision.mode: prepass`,
   * formatting, the per-turn image ledger, and — for a burst leader — waiting
   * for and folding in the members. `folded` ⇒ this message was handed to an
   * open burst's leader and must not dispatch a turn of its own.
   */
  private async prepareInboundMessage(
    message: Message,
    agentName: string,
  ): Promise<
    | { readonly kind: "folded" }
    | { readonly kind: "ready"; readonly formattedMessage: string; readonly imageCount: number }
  > {
    const agentConfig = this.sessionManager.getAgentConfig(agentName);
    const turnVision = resolveTurnVisionConfig(agentConfig?.vision);
    const inlineVision = turnVision.enabled && turnVision.mode === "inline";

    const burstKey = BurstGatherer.key(message.channelId, message.author.id);
    const burstMember = inlineVision
      ? this.burstGatherer.announce(burstKey, message.id)
      : null;
    const imageAttachmentCount = [...message.attachments.values()].filter((a) =>
      isImageAttachment(a.contentType ?? null),
    ).length;
    const burstLeader =
      inlineVision &&
      burstMember === null &&
      turnVision.burst.quietMs > 0 &&
      shouldLeadBurst({
        attachmentCount: message.attachments.size,
        imageCount: imageAttachmentCount,
        text: message.content,
      })
        ? this.burstGatherer.open(burstKey, message.id, turnVision.burst)
        : null;

    try {
      let downloadResults: readonly DownloadResult[] | undefined;
      if (message.attachments.size > 0) {
        // Shared helper — the auto-ingest rescan reads from the SAME path so
        // the reconstructed source matches what was ingested (dedup-safe).
        const attachDir = attachmentInboxDir(agentConfig?.memoryPath);
        const attachments = extractAttachments(message.attachments);
        downloadResults = await downloadAllAttachments(attachments, attachDir, this.log);
      }

      let visionAnalyses = new Map<string, string>();
      if (downloadResults && turnVision.enabled && turnVision.mode === "prepass") {
        visionAnalyses = await runVisionPrePass(
          downloadResults,
          { timeoutMs: 30_000 },
          this.log,
        );
      }

      // Phase 999.43 Plan 02 T02 — fire-and-forget auto-ingest dispatch.
      if (downloadResults) {
        this.recordTranscriptRequests(agentName, agentConfig?.memoryPath, downloadResults, message);
        this.dispatchAutoIngestAttachments(agentName, downloadResults, visionAnalyses, message);
      }

      // Fetch the referenced message if this is a reply, so the agent sees
      // the quoted content (not just an opaque message_id).
      let referencedMessage: Message | undefined;
      if (message.reference?.messageId) {
        try {
          referencedMessage = (await message.fetchReference()) as Message;
        } catch (err) {
          this.log.debug({ err, refId: message.reference.messageId }, "fetchReference failed");
        }
      }

      const imageSources = inlineVision ? turnImageSourcesFrom(downloadResults) : [];
      let formattedMessage = formatDiscordMessage(
        message,
        downloadResults,
        referencedMessage,
        undefined,
        visionAnalyses,
        { inlineImages: inlineVision },
      );

      if (burstMember !== null) {
        // Resolves once the leader commits (or false if it aborted / the
        // window closed) — only then is it safe to skip our own dispatch.
        if (await burstMember.contribute({ text: formattedMessage, sources: imageSources })) {
          const foldedIcon = icons.reaction("puzzle");
          if (foldedIcon) void message.react(foldedIcon).catch(() => {
            /* non-fatal */
          });
          this.log.info(
            { tag: "phase999.154-burst", agent: agentName, messageId: message.id, images: imageSources.length },
            "message folded into an open upload burst",
          );
          return { kind: "folded" };
        }
      }

      this.imageLedger.add(agentName, message.id, imageSources);
      let imageCount = imageSources.length;
      if (burstLeader !== null) {
        const members = await burstLeader.wait();
        for (const m of members) {
          formattedMessage += `\n\n${m.text}`;
          this.imageLedger.add(agentName, message.id, m.sources);
          imageCount += m.sources.length;
        }
        burstLeader.commit();
        if (members.length > 0) {
          this.log.info(
            {
              tag: "phase999.154-burst",
              agent: agentName,
              leader: message.id,
              members: members.map((m) => m.messageId),
              images: imageCount,
            },
            "upload burst gathered into one turn",
          );
        }
      }
      return { kind: "ready", formattedMessage, imageCount };
    } catch (err) {
      burstMember?.abandon();
      // Release anyone who already handed us their message: they dispatch
      // their own turns instead of vanishing behind a failed leader.
      burstLeader?.abort();
      throw err;
    }
  }

  /**
   * P2-PROGRESS — a standalone edit-in-place editor bound to `channel` + a
   * freshly-posted progress message. Mirrors the streaming editFn (post-then-
   * edit) but is owned by the ingest batch, not the turn. Reuses the
   * ProgressiveMessageEditor throttle + Discord 429 backoff.
   */
  private createIngestProgressEditor(
    channel: Message["channel"],
    agentName: string,
    turnId: string,
  ): ProgressiveMessageEditor {
    const messageRef: { current: Message | null } = { current: null };
    return new ProgressiveMessageEditor({
      editFn: async (content: string) => {
        const wrapped = formatOutboundText(content);
        if (!messageRef.current) {
          if ("send" in channel && typeof channel.send === "function") {
            messageRef.current = await channel.send(wrapped);
          }
        } else {
          await messageRef.current.edit(wrapped);
        }
      },
      editIntervalMs: 1500,
      log: this.log,
      agent: agentName,
      turnId,
    });
  }

  private dispatchAutoIngestAttachments(
    agentName: string,
    downloadResults: readonly DownloadResult[],
    visionAnalyses: Map<string, string>,
    message: Message,
  ): void {
    // P2-PROGRESS — seed an edit-in-place progress message for bursts (>=2
    // dispatched attachments) on ingest-ENABLED agents. Gating on the flag
    // avoids a misleading counter for agents whose handler will skip every item.
    const dispatchCount = downloadResults.filter(
      (r) => r.success && r.path !== null,
    ).length;
    const ingestEnabled =
      this.sessionManager.getAgentConfig(agentName)?.autoIngestAttachments ===
      true;
    if (ingestEnabled && dispatchCount >= 2) {
      const editor = this.createIngestProgressEditor(
        message.channel,
        agentName,
        message.id,
      );
      this.ingestProgress.seedBatch(
        message.channelId,
        message.id,
        dispatchCount,
        editor,
      );
    }

    for (const result of downloadResults) {
      if (!result.success || !result.path) continue;
      const info = result.attachmentInfo;
      // P1-VISIONKEY — the map is keyed by result.path (vision-pre-pass.ts:71),
      // NOT info.name (the Discord filename). The old info.name lookup NEVER
      // matched → auto-ingest's classifier always received null vision.
      const visionAnalysis = visionAnalyses.get(result.path) ?? null;
      sendIpcRequest(SOCKET_PATH, "auto-ingest-attachment", {
        agent: agentName,
        file_path: result.path,
        filename: info.name,
        mime_type: info.contentType,
        size: info.size,
        vision_analysis: visionAnalysis,
        channel_id: message.channelId,
        message_id: message.id,
        user_id: message.author.id,
        user_name: message.author.username,
      })
        .then((res: unknown) => {
          // Phase 999.154 — surface a queue-full deferral on the receipt.
          if (
            typeof res === "object" &&
            res !== null &&
            (res as { deferred?: unknown }).deferred === true
          ) {
            this.ingestProgress.noteDeferred(message.channelId, message.id);
          }
        })
        .catch((err: unknown) => {
        this.log.warn(
          {
            tag: "phase999.43-autoingest",
            err: err instanceof Error ? err.message : String(err),
            agent: agentName,
            messageId: message.id,
            filename: info.name,
          },
          "phase999.43-autoingest dispatch failed",
        );
      });
    }
  }

  /**
   * Handle an incoming Discord message.
   * Routes to the correct agent based on channel binding.
   */
  private async handleMessage(message: Message): Promise<void> {
    // Handle bot messages: allow agent-to-agent webhooks, ignore everything else
    if (message.author.bot) {
      // Webhook messages from known agents are allowed through
      if (message.webhookId && this.webhookManager) {
        const envelope = this.extractAgentEnvelope(message);
        if (envelope) {
          // Phase 999.144 — envelope authentication BEFORE the dedupe claim.
          // Order matters: a forged embed must never consume the deliveryId
          // claim of the legitimate copy (that would let an attacker with a
          // leaked webhook URL suppress a real delivery by forging its id).
          // The verdict itself: dispatch on format alone was the
          // INCIDENT-webhook-spam-2026-09-16 hole — see ingress-auth.ts.
          {
            const recipient =
              this.routingTableRef.current.channelToAgent.get(message.channelId);
            const decision = evaluateEnvelopeAuth(
              this.a2aEnvelopeAuthMode,
              getProcessIdentitySecret(),
              {
                deliveryId: envelope.deliveryId ?? "",
                sender: envelope.senderName,
                recipient: recipient ?? "",
                content: message.embeds[0]?.description ?? message.content ?? "",
              },
              envelope.sig,
            );
            if (decision.verdict !== "pass" && decision.verdict !== "skipped") {
              this.log.warn(
                {
                  tag: "a2a-envelope-auth",
                  verdict: decision.verdict,
                  dispatched: decision.dispatch,
                  mode: this.a2aEnvelopeAuthMode,
                  from: envelope.senderName,
                  channel: message.channelId,
                  deliveryId: envelope.deliveryId,
                  messageId: message.id,
                },
                decision.dispatch
                  ? "[999.144] a2a envelope not verified (shadow — delivered)"
                  : "[999.144] a2a envelope REJECTED — turn not dispatched",
              );
            }
            if (!decision.dispatch) return;
          }
          // Phase 999.117 WS-2 — cross-path dedupe at the relay.
          //
          // This embed and the recipient's inbox file are the SAME logical
          // message: post_to_agent writes the inbox record and posts the
          // embed. The watcher turns the file into a turn and this relay
          // turns the embed into a second, differently-formatted turn
          // (`[Agent Message from X]` vs `[Message from X]:`). Nothing
          // reconciled them, which is why enabling the webhook rung doubled
          // every hop and made the reported loop worse rather than better.
          //
          // Whichever consumer claims the deliveryId first owns the turn.
          // An embed with no id (posted by an older build) has nothing to
          // claim and is relayed as before.
          if (
            this.deliveryDedupe &&
            !this.deliveryDedupe.claim(envelope.deliveryId)
          ) {
            this.log.info(
              {
                from: envelope.senderName,
                channel: message.channelId,
                deliveryId: envelope.deliveryId,
              },
              "[999.117] duplicate a2a delivery suppressed at webhook relay",
            );
            return;
          }
          await this.handleAgentMessage(message, envelope.senderName);
          return;
        }
      }
      // 999.101 — bot-trigger allowlist. An operator-configured author
      // (e.g. the Strava webhook) may dispatch an automated turn to the
      // channel's agent; every other bot message (including our own)
      // stays dropped exactly as before.
      this.maybeFireBotTrigger(message);
      return;
    }

    // Phase 999.144 — human ingress allowlist. Guild membership and channel
    // permissions are the outer walls; this is the inner one, so an account
    // added to the guild (or a compromised member account) still cannot
    // drive the fleet. Unset = feature off (schema forbids an empty list).
    // Sits ABOVE the pending-prompt intercept on purpose: a prompt's own
    // fail-closed answer allowlist should never be reachable by an author
    // the fleet-level gate already refuses.
    if (!isHumanAuthorAllowed(this.allowedUserIds, message.author.id)) {
      this.log.warn(
        {
          tag: "human-ingress-denied",
          author: message.author.username,
          authorId: message.author.id,
          channel: message.channelId,
          messageId: message.id,
        },
        "[999.144] human author not on discord.allowedUserIds — message ignored",
      );
      return;
    }

    // Phase 145 WS3 (Plan 04) — pending-prompt intercept (RESEARCH Pitfall 4 /
    // LANDMINE B). An `ask_user_question` text-fallback reply arrives here as a
    // normal inbound message; without this intercept handleMessage would
    // dispatch it as a FRESH TURN and the blocked tool call would never
    // resolve. Consult the shared registry BEFORE any turn dispatch (thread or
    // channel route). On a match (a pending prompt for this channel AND the
    // sender is in the prompt's fail-closed operator allowlist AND the reply
    // parses to valid options) the stored resolve() fires and we RETURN —
    // suppressing the spurious turn (clean drop-in; the answer reaches the
    // agent only as the tool result). On ANY miss this is an O(1) Map lookup
    // with NO side effects, so the non-pending inbound path is byte-identical.
    {
      const resolution = pendingPromptRegistry.tryResolve(
        "discord",
        message.channelId,
        message.author.id,
        message.content,
      );
      if (resolution.resolved) {
        this.log.info(
          { channelId: message.channelId, user: message.author.id },
          "ask_user_question: text-fallback reply resolved a pending prompt (turn suppressed)",
        );
        return;
      }
    }

    // Thread routing takes priority over channel routing (per D-09)
    if (this.threadManager && message.channel.isThread()) {
      const sessionName = await this.threadManager.routeMessage(message.channelId);
      if (sessionName) {
        // Phase 50: open Turn + receive span for thread-routed messages (parity with channel route)
        // Phase 57 Plan 03: turnId is `discord:<snowflake>` so Turn.id matches
        // TurnOrigin.rootTurnId (the invariant TurnDispatcher expects). Raw
        // snowflake queries against traces.id require rewriting to
        // `'discord:' || <snowflake>` — see 57-01-SUMMARY.md locked_shapes.
        let turn: Turn | undefined;
        let receiveSpan: Span | undefined;
        try {
          const collector = this.sessionManager.getTraceCollector(sessionName);
          turn = collector?.startTurn(`${DISCORD_SNOWFLAKE_PREFIX}${message.id}`, sessionName, message.channelId);
          receiveSpan = turn?.startSpan("receive", {
            channel: message.channelId,
            user: message.author.id,
            is_thread: true,
          });
        } catch (err) {
          this.log.warn(
            { error: (err as Error).message, agent: sessionName },
            "trace setup failed — continuing without tracing",
          );
        }

        // Phase 54: fire typing indicator at the EARLIEST point where we know
        // the message is ours to answer — after thread routing resolved an
        // agent, before attachment download + session dispatch. Guard #4
        // (user-message-type) from CONTEXT D-04 applies here.
        if (this.isUserMessageType(message)) {
          this.fireTypingIndicator(message, turn);
        }

        // Phase 999.154 — attachment intake (download, ingest dispatch, turn
        // images, burst gathering), shared with the channel route. Memory-path
        // inbox per Phase 75 SHARED-01.
        const inbound = await this.prepareInboundMessage(message, sessionName);
        if (inbound.kind === "folded") {
          try { receiveSpan?.end(); } catch { /* non-fatal */ }
          try { turn?.end("success"); } catch { /* non-fatal */ }
          return;
        }
        const formattedMessage = inbound.formattedMessage;

        // Auto-steer Path A (2026-05-24 marker-required redesign) —
        // wrap + interrupt fires ONLY when the operator's message
        // begins with the 🧭 marker. The pre-marker behavior fired on
        // ANY human message during an active turn and killed in-flight
        // tool work on casual operator check-ins ("still going?",
        // "what happened?") — observed 2026-05-24 on admin-clawdy's
        // sdd-uia-v3 UI-automation subagent.
        //
        // Without the marker, the message dispatches as-is and queues
        // behind the active turn via the SDK's turn lock — same as
        // the pre-auto-steer behavior. The operator sees ⏳→👍→✅
        // queue-state icons (Phase 119 A2A-03) so it's clear the
        // message is waiting for the current work to finish.
        //
        // Path B (parent-triggered via `steer_subagent` MCP tool)
        // does ALL the steer-prep + framing in the IPC handler. Its
        // bot post body already contains <operator-steering>; bridge
        // MUST NOT re-wrap or it'd double-frame. Bot posts have
        // `isHumanAuthor === false`, so `shouldAutoSteer` returns
        // false and the bot post flows through the bridge's normal
        // dispatch pipeline with the already-framed body. The
        // `pendingSteerMessageIds` entry is consumed here for
        // accounting cleanup only — it no longer drives the wrap
        // decision (the pre-2026-05-24 code path that did so caused
        // a double-frame bug if Path B's interrupt didn't fully
        // clear in time).
        this.pendingSteerMessageIds.delete(message.id);
        const isHumanAuthor = !message.author.bot && message.webhookId === null;
        const hasSteerMarker = hasLeadingSteerMarker(message.content);
        let dispatchMessage = formattedMessage;
        if (
          shouldAutoSteer({
            isSubagentThread: isSubagentThreadName(sessionName),
            isAcceptedAuthor: isHumanAuthor,
            hasActiveTurn: this.sessionManager.hasActiveTurn(sessionName),
            hasSteerMarker,
          })
        ) {
          try {
            const steerPrep = await prepareSubagentSteer({
              threadId: message.channelId,
              deps: {
                getBinding: async (threadId) => {
                  const registry = await readThreadRegistry(THREAD_REGISTRY_PATH);
                  return getBindingForThread(registry, threadId);
                },
                interruptAgent: (name) => this.sessionManager.interruptAgent(name),
                hasActiveTurn: (name) => this.sessionManager.hasActiveTurn(name),
                sleep: (ms) =>
                  new Promise<void>((resolve) => setTimeout(resolve, ms)),
                resetSteerGates: (threadId) =>
                  resetSteerGates(THREAD_REGISTRY_PATH, threadId),
                log: this.log,
              },
            });
            if (steerPrep.ok) {
              dispatchMessage = frameSteeringGuidance(formattedMessage);
              // compass reaction marks "this message steered the subagent" so
              // the thread reader can see what redirected work. Fire-and-
              // forget; reaction failure is non-fatal.
              const steerAck = icons.reaction("compass");
              if (steerAck) void message.react(steerAck).catch((err) => {
                this.log.debug(
                  { err: (err as Error).message, messageId: message.id },
                  "steer compass reaction failed (non-fatal)",
                );
              });
              this.log.info(
                {
                  sessionName,
                  threadId: message.channelId,
                  source: "in-thread-human-with-marker",
                  interrupted: steerPrep.interrupted,
                  hadActiveTurn: steerPrep.hadActiveTurn,
                },
                "subagent auto-steered — dispatching framed guidance as next turn",
              );
            } else {
              this.log.info(
                {
                  sessionName,
                  threadId: message.channelId,
                  reason: steerPrep.reason,
                  detail: steerPrep.detail,
                },
                "subagent auto-steer skipped — proceeding with normal dispatch",
              );
            }
          } catch (err) {
            // Defensive: prep should never throw, but if it does we
            // proceed with normal (unwrapped) dispatch so the operator's
            // message still reaches the subagent — degraded UX > drop.
            this.log.warn(
              {
                err: (err as Error).message,
                sessionName,
                threadId: message.channelId,
              },
              "subagent auto-steer prep threw — proceeding with normal dispatch",
            );
          }
        }

        // End the receive span right before dispatching to the session (end_to_end still open)
        try { receiveSpan?.end(); } catch { /* non-fatal */ }
        await this.streamAndPostResponse(message, sessionName, dispatchMessage, turn);
        this.log.info({ sessionName, threadId: message.channelId }, "message routed to thread session");
        return;
      }
    }

    const channelId = message.channelId;
    const agentName = this.routingTableRef.current.channelToAgent.get(channelId);

    if (!agentName) {
      // Channel not bound to any agent — ignore
      return;
    }

    // Check channel ACL before routing (SECR-01, SECR-02)
    if (this.securityPolicies) {
      const policy = this.securityPolicies.get(agentName);
      if (policy && policy.channelAcls.length > 0) {
        const allowed = checkChannelAccess(channelId, message.author.id, [], policy.channelAcls);
        if (!allowed) {
          this.log.info(
            { agent: agentName, user: message.author.username, userId: message.author.id, channel: channelId },
            "message blocked by channel ACL",
          );
          return; // Silent ignore per SECR-02
        }
      }
    }

    // Phase 50: open Turn + receive span for channel-routed messages.
    // Caller-owned lifecycle — streamAndPostResponse ends the Turn with success/error.
    // Phase 57 Plan 03: turnId is `discord:<snowflake>` (see thread-route
    // branch above for the trace-id continuity rationale).
    let turn: Turn | undefined;
    let receiveSpan: Span | undefined;
    try {
      const collector = this.sessionManager.getTraceCollector(agentName);
      turn = collector?.startTurn(`${DISCORD_SNOWFLAKE_PREFIX}${message.id}`, agentName, channelId);
      receiveSpan = turn?.startSpan("receive", {
        channel: channelId,
        user: message.author.id,
        is_thread: false,
      });
    } catch (err) {
      this.log.warn(
        { error: (err as Error).message, agent: agentName },
        "trace setup failed — continuing without tracing",
      );
    }

    // Phase 54: fire typing indicator at the EARLIEST point where we know
    // the message is ours to answer — after channel routing + ACL pass +
    // non-bot author (all 3 already enforced above), before attachment
    // download + session dispatch. Guard #4 (user-message-type) is the
    // last check.
    if (this.isUserMessageType(message)) {
      this.fireTypingIndicator(message, turn);
    }

    this.log.info(
      {
        channel: channelId,
        agent: agentName,
        user: message.author.username,
        messageId: message.id,
      },
      "routing message to agent",
    );

    // 999.178 R1 — status-ping gate. A bare check-in ("eta", "we good?") is
    // answered from the live turn state with no model turn and no queueing.
    // Placed before attachment intake + the mid-turn gate: a ping has no
    // attachments and needs neither. Gated on uxFeatures.statusPing (default
    // off); a no-op for every other agent and every non-ping message.
    if (await this.tryStatusPing(message, agentName, channelId)) {
      try { receiveSpan?.end(); } catch { /* non-fatal */ }
      try { turn?.end("success"); } catch { /* non-fatal */ }
      return;
    }

    // Download attachments if present, before formatting the message
    // Phase 75 SHARED-01 — memoryPath (not workspace) so attachments land
    // in the receiving agent's private inbox on shared-workspace setups.
    // Phase 999.154 — attachment intake shared with the thread route.
    const inbound = await this.prepareInboundMessage(message, agentName);
    if (inbound.kind === "folded") {
      try { receiveSpan?.end(); } catch { /* non-fatal */ }
      try { turn?.end("success"); } catch { /* non-fatal */ }
      return;
    }
    const formattedMessage = inbound.formattedMessage;
    // End the receive span right before session dispatch; end_to_end remains open
    try { receiveSpan?.end(); } catch { /* non-fatal */ }

    // Phase 999.100 — mid-turn intent gate. Only consulted when the agent's
    // steering config enables autoClassify AND a turn is in flight; handles
    // steer (inject into the running turn) and stop (interrupt) fully, and
    // falls through to the normal dispatch for new_task / any failure. With
    // the feature off (fleet default) this is a single boolean check.
    // A mid-turn steer is injected into the RUNNING turn as text, so its
    // images travel as a path manifest; the ledger entry is then done.
    const midturnText =
      inbound.imageCount > 0
        ? `${formattedMessage}\n\n${pathOnlyManifest(this.imageLedger.get(agentName, message.id))}`
        : formattedMessage;
    const midturnRoute = await this.tryMidturnRoute(
      message,
      agentName,
      channelId,
      midturnText,
      turn,
    );
    if (midturnRoute.handled) {
      this.imageLedger.release(agentName, message.id);
      return;
    }
    // 2026-09-24 late-steer grace — a steer classified after its turn ended
    // dispatches wrapped in the late-steer envelope. It skips the shorten
    // and fast-lane branches below: the raw content is short ("no, the
    // other file") and would otherwise be a quick-lane candidate on the
    // now-idle agent, answering generically without the steering context.
    const lateSteerText = midturnRoute.dispatchOverride;

    // Phase 999.161 — fast lane. Only text-only messages on an idle agent are
    // candidates; everything else (and every uncertain verdict) is the ordinary
    // session turn. When the lane answers, the turn ends here.
    // 999.160 v1.3 — a typed "shorter" / "tl;dr" replaces the agent's last reply
    // in place instead of starting a turn. Addressee-only; falls through when
    // there is no fresh reply to shorten.
    if (lateSteerText === undefined && inbound.imageCount === 0 && isShorterRequest(message.content)) {
      const last = this.lastReplies.get(channelId);
      if (last && last.agentName === agentName && last.userId === message.author.id) {
        const target = await this.fetchMessageOrNull(message, last.messageId);
        if (target && (await this.shortenInPlace({ ...last, target, keepRows: [], source: "typed" }))) {
          try { turn?.end("success"); } catch { /* non-fatal */ }
          return;
        }
      }
    }
    if (lateSteerText === undefined && inbound.imageCount === 0 && (await this.tryFastLane(message, agentName, channelId, formattedMessage, turn))) {
      return;
    }
    // A task-lane turn after quick-lane answers carries a compact recap, because
    // the persistent session never saw those exchanges.
    const recap = this.quickLaneRecent.drain(agentName);
    // Late-steer text already embeds the (image-manifest-augmented) formatted
    // message inside its envelope — never double-send the bare copy.
    const dispatchBase = lateSteerText ?? formattedMessage;
    const taskMessage = recap.length > 0 ? `${recap}\n\n${dispatchBase}` : dispatchBase;

    // 999.178 R1 — a turn is already running, so this message WILL wait (the
    // depth-1 queued slot, or the coalescer if that slot is taken). Give it the
    // cc_hourglass now (message 2 used to wait silently) and persist it so a
    // restart doesn't drop it. A rare race where the turn finishes first only
    // paints a brief hourglass before delivery — harmless.
    if (this.sessionManager.hasActiveTurn(agentName)) {
      this.registerQueuedAsk(message, agentName, channelId, taskMessage);
    }

    await this.streamAndPostResponse(message, agentName, taskMessage, turn);
  }

  // ───────────────────── Phase 999.161 — fast lane ─────────────────────
  private readonly quickLaneRecent = new QuickLaneRecentBuffer();

  /**
   * Try to answer on the quick lane. Returns true only when a reply was
   * delivered (and captured); any other outcome returns false so the caller
   * dispatches the ordinary session turn — the message is never lost.
   */
  private async tryFastLane(message: Message, agentName: string, channelId: string, formattedMessage: string, turn: Turn | undefined): Promise<boolean> {
    const agentCfg = this.sessionManager.getAgentConfig(agentName);
    const cfg = agentCfg?.fastLane;
    // 999.164 — on for every agent by default; `/clawcode-quick` overrides per
    // agent (persisted, re-applied on boot).
    if (!agentCfg || !cfg || !resolveFastLaneEnabled(getFastLaneOverride(agentName), cfg.enabled).enabled) return false;
    const text = message.content.trim();
    // 999.164 — every message on an enabled agent logs exactly one `fast-lane:`
    // line naming its outcome, so the per-agent map can be re-audited from the
    // journal alone.
    const skip =
      text.length === 0 ? "empty"
      : text.length > cfg.maxMessageChars ? "long"
      : text.startsWith("/") ? "slash"
      : message.attachments.size > 0 ? "attachment"
      : this.sessionManager.hasActiveTurn(agentName) ? "busy"
      : null;
    if (skip) {
      this.log.info({ agent: agentName, messageId: message.id, skip }, "fast-lane: not a candidate → task lane");
      return false;
    }
    // 999.164 — per-agent routing, before any bridge call: the quick lane only
    // answers standalone messages outside the domains this agent owns (derived
    // from its MCP servers, skills and admin flag).
    const profile = routingProfileFromConfig(agentCfg);
    const domains = resolveAgentDomains(profile);
    const verdict = routeQuickLane({
      text,
      isReply: Boolean(message.reference?.messageId),
      domains,
      taskTopics: compileTaskTopics(profile.taskTopics),
    });
    if (verdict.lane === "task") {
      this.log.info({ agent: agentName, messageId: message.id, rule: verdict.rule, domain: verdict.domain, matched: verdict.matched }, "fast-lane: rule → task lane");
      return false;
    }
    const t0 = Date.now();
    const convStore = this.sessionManager.getConversationStore(agentName);
    const sessionId = this.sessionManager.getActiveConversationSessionId(agentName);
    let recentTurns: readonly { role: string; content: string }[] = [];
    try {
      if (convStore && sessionId) recentTurns = convStore.getTurnsForSession(sessionId, 8).map((r) => ({ role: r.role, content: r.content }));
    } catch {
      recentTurns = [];
    }
    this.fireTypingIndicator(message, turn);
    const hot = (() => {
      try { return this.sessionManager.getTierManager(agentName)?.getHotMemories().slice(0, 5).map((m) => m.content) ?? []; } catch { return []; }
    })();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.answerTimeoutMs);
    let raw = "";
    try {
      // 999.164 — `fastLane.model` was inert (callHaikuDirect is pinned to
      // haiku). callModelDirect takes the bridge route for every model.
      raw = await callModelDirect(
        buildQuickSystemPrompt({ agentName, soul: agentCfg.soul, identity: agentCfg.identity, hotMemories: hot, canSee: renderDomainDigest(domains) }),
        buildQuickUserPrompt({ message: text, recentTurns }),
        cfg.model,
        { signal: controller.signal, maxTokens: cfg.maxTokens, trimmedStartup: true },
        "fast-lane",
      );
    } catch (err) {
      this.log.warn({ agent: agentName, error: err instanceof Error ? err.message : String(err), messageId: message.id }, "fast-lane: answer failed — task lane");
      return false;
    } finally {
      clearTimeout(timer);
    }
    const parsed = parseQuickAnswer(raw);
    if (parsed.kind !== "answer") {
      this.log.info({ agent: agentName, messageId: message.id, rule: verdict.rule, reason: parsed.reason, totalMs: Date.now() - t0, model: cfg.model }, "fast-lane: model asked for the task lane");
      return false;
    }
    const durationMs = Date.now() - t0;
    const reply = appendAdvisorSubtext(truncateForDiscord(parsed.text), quickLaneFooter(durationMs));
    try {
      await this.sendResponse(message, reply, agentName);
    } catch (err) {
      this.log.warn({ agent: agentName, error: err instanceof Error ? err.message : String(err) }, "fast-lane: delivery failed — task lane");
      return false;
    }
    if (convStore && sessionId) {
      try {
        captureDiscordExchange({
          convStore,
          sessionId,
          userContent: formattedMessage,
          assistantContent: parsed.text,
          channelId,
          discordUserId: message.author.id,
          discordMessageId: message.id,
          isTrustedChannel: true,
          log: this.log,
          agentName,
        });
      } catch (err) {
        this.log.warn({ agent: agentName, error: err instanceof Error ? err.message : String(err) }, "fast-lane: capture failed");
      }
    }
    this.quickLaneRecent.push(agentName, text, parsed.text);
    this.log.info({ agent: agentName, messageId: message.id, rule: verdict.rule, durationMs, chars: parsed.text.length, model: cfg.model }, "fast-lane: answered");
    try { turn?.end("success"); } catch { /* non-fatal */ }
    return true;
  }

  /**
   * Phase 135 Plan 02 — voice transcript ingress. Called by VoiceManager
   * (via the ingress helper) when a final Deepgram transcript arrives
   * for an utterance in one of the bot's joined voice sessions.
   *
   * The body wraps the transcript with the voice-mode prompt suffix
   * and dispatches through the SAME TurnDispatcher path as text turns
   * (RESEARCH § Architecture Pattern 3) — the agent's full
   * tools/MCPs/skills work transparently. Only the response-emit point
   * differs: instead of editing a Discord message, the voice path
   * streams the response to ElevenLabs and plays it back through the
   * session's AudioPlayer.
   *
   * **Access control (Phase 135 Plan 03 Task 1).** Voice transcripts go
   * through the SAME `checkChannelAccess` predicate as text messages
   * (RESEARCH § Anti-Patterns: no parallel auth route). Plan 02's
   * fail-closed env-gate guard + the Plan-03 deferral marker were
   * removed in a single atomic commit and replaced by
   * `enforceVoiceChannelAcl` at the head of this method. A
   * non-allowlisted voice user produces a silent drop (info log in
   * access.ts) — the agent never sees the transcript, no turn is
   * opened, no Deepgram / ElevenLabs cost.
   */
  /**
   * Phase 135.1 — non-logging ACL predicate for the barge-in speaking tap
   * (wired into VoiceManager.setBargeInAcl by the daemon). Decides whether a
   * speaker may *interrupt* the agent; the actual turn is still gated (and
   * logged) by enforceVoiceChannelAcl at final-transcript dispatch.
   */
  voiceBargeInAllowed(
    agentName: string,
    channelId: string,
    voiceUserId: string,
  ): boolean {
    return isVoiceUserAllowed(
      this.securityPolicies,
      agentName,
      channelId,
      voiceUserId,
    );
  }

  async handleVoiceTranscript(args: {
    readonly agentName: string;
    readonly channelId: string;
    readonly transcript: string;
    readonly voiceUserId: string;
    readonly guildId: string;
    readonly voiceSession: import("./voice/session.js").VoiceSession;
    /** 999.116 A3 (G7) — STT decision timing for the turn trace. */
    readonly sttTiming?: VoiceSttTiming;
  }): Promise<void> {
    // Phase 135 Plan 03 Task 1 — ACL enforcement. Same predicate as the
    // text path (bridge.ts:944 for the channel-routed text branch). Voice
    // has no userRoles context, so the wrapper passes [] internally.
    if (
      !enforceVoiceChannelAcl(
        this.securityPolicies,
        args.agentName,
        args.channelId,
        args.voiceUserId,
        this.log,
      )
    ) {
      return;
    }

    // 999.116 A3 (G7) — the bridge received the transcript (pre turn-lock).
    const enqueuedAt = Date.now();

    // Phase 135.5 — USER-HALF post. Fire-and-forget at BOTH layers: the
    // helper itself wraps the Discord API call in a detached IIFE, AND
    // the call site is not awaited (we still `void` the helper return
    // to silence accidental floating-promise lint). Posts after the
    // ACL gate (so dropped transcripts produce no scrollback) but
    // BEFORE turn-lock acquisition (so a queued turn behind a long
    // prior turn STILL gets its user-half visible immediately).
    // Channel ordering is best-effort: the agent dispatch + TTS round
    // trip is ~2-5s so the user-half post (100-300ms) lands first in
    // practice.
    void this.postVoiceTurnTranscript({
      agentName: args.agentName,
      voiceSession: args.voiceSession,
      voiceUserId: args.voiceUserId,
      transcript: args.transcript,
      agentResponse: undefined, // user-half: response not yet computed
      fallbackSpoken: false,
    });

    // 135.0.5 — per-session turn serialisation. Two transcripts arriving
    // within Deepgram's utterance-end window otherwise race for the
    // AudioPlayer; the second speakResponse() interrupts the first
    // mid-speech. Chain each new turn onto session.turnLock so they
    // dispatch sequentially. The lock awaits the previous turn's full
    // settlement (agent turn + TTS playback) before this one starts.
    const previous = args.voiceSession.turnLock;
    let release: () => void;
    args.voiceSession.turnLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    // Phase 135.1 — open the cancellation-spine turn. Its AbortController is
    // read by streamVoiceResponse (threaded into the SDK's abort path) and
    // fired by barge-in / leave; endVoiceTurn (generation-guarded) clears it
    // in the finally below.
    const voiceTurn = beginVoiceTurn(
      args.voiceSession,
      `voice-${args.voiceSession.id}-${Date.now()}`,
      {
        sttTiming: args.sttTiming,
        enqueuedAt,
        transcriptChars: args.transcript.length,
      },
    );
    // Phase 135.5 — the agent's response text, captured via the
    // onVoiceResponseComplete seam. Read by the agent-half transcript post
    // and (999.116) the turn trace's responseChars.
    let capturedResponse: string | undefined;
    try {
      // Open a turn span just like the text path. The turn id uses
      // the `discord:` prefix (voice is a discord-origin event); the
      // session id + timestamp suffix makes the id unique per voice
      // turn. TURN_ID_REGEX requires the prefix-suffix shape and
      // alphanumeric-plus-`_-` suffix; we replace any unsafe chars in
      // the session id (UUIDs include hyphens, which are allowed).
      let turn: Turn | undefined;
      try {
        const safeSessionId = args.voiceSession.id.replace(/[^a-zA-Z0-9_-]/g, "_");
        const collector = this.sessionManager.getTraceCollector(args.agentName);
        turn = collector?.startTurn(
          `${DISCORD_SNOWFLAKE_PREFIX}voice-${safeSessionId}-${Date.now()}`,
          args.agentName,
          args.channelId,
        );
      } catch (err) {
        this.log.warn(
          { error: (err as Error).message, agent: args.agentName },
          "trace setup failed (voice) — continuing without tracing",
        );
      }

      // Wrap the user message with the voice-mode directive. The agent
      // sees this as in-band guidance for the current turn only — the
      // session-scoped system prompt is unchanged.
      const { buildVoicePromptSuffix } = await import("./voice/prompt.js");
      const suffix = buildVoicePromptSuffix(args.voiceSession.voiceCfg);
      const wrapped = `<voice-mode>${suffix}</voice-mode>\n\n${args.transcript}`;

      // Phase 135 Plan 03 Task 2 — silence-fallback timer. Arm BEFORE
      // dispatching the turn; cancel after streamAndPostResponse resolves
      // (or rejects). If the agent doesn't respond within the window
      // (default 30s, configurable via voice.silenceFallbackMs), the timer
      // fires fireProgressCue() which speaks a short "still working" filler
      // so the user doesn't sit in dead air.
      //
      // 999.116 — the cue is a PROGRESS CUE, not a replacement answer: it
      // never sets session.fallbackSpoken, so the agent's real (tool-
      // grounded) reply still plays when it lands. Resetting the flag here
      // is retained as defensive belt-and-suspenders — nothing sets it true
      // any more, so the bridge's fallbackSpoken suppression branches stay
      // inert. This deletes the replace-race that made prior verifies
      // inconclusive (a slow turn used to let Haiku's guess suppress the
      // real answer).
      args.voiceSession.fallbackSpoken = false;
      const { armSilenceTimer, cancelSilenceTimer, fireProgressCue } =
        await import("./voice/silence-fallback.js");
      armSilenceTimer(args.voiceSession, () => {
        fireProgressCue(args.voiceSession, this.log).catch((err) => {
          this.log.error(
            {
              agent: args.agentName,
              sessionId: args.voiceSession.id,
              error: err instanceof Error ? err.message : String(err),
            },
            "voice silence-fallback closure threw (defensive catch)",
          );
        });
      });

      // Phase 135.5 — capture the agent's response text via the
      // streamAndPostResponse `onVoiceResponseComplete` seam so we can
      // post the AGENT-HALF transcript after dispatch settles. The
      // callback fires once, BEFORE TTS, inside streamVoiceResponse.
      // We stash into a closure-scoped local; the finally block reads
      // it to decide whether to emit the agent-half post.
      capturedResponse = undefined;
      try {
        await this.streamAndPostResponse(
          undefined,
          args.agentName,
          wrapped,
          turn,
          0,
          0,
          // Debug session `in-tool-wedge-recovery` work-stream (B) — the
          // new `wedgeRetryCount` parameter sits BEFORE `delivery`; the
          // voice path starts at 0 like every other entry point.
          0,
          {
            kind: "voice",
            session: args.voiceSession,
            onVoiceResponseComplete: (response: string) => {
              capturedResponse = response;
            },
          },
        );
      } finally {
        // Cancel ALWAYS — whether the dispatch succeeded, threw, or was
        // racing the timer. Agent-answers-in-time = no Haiku spoken.
        // Agent-throws = also no Haiku, because the transcript was
        // delivered to the agent (just unsuccessfully); the user can
        // re-speak.
        cancelSilenceTimer(args.voiceSession);

        // Phase 135.5 — AGENT-HALF post. Only emits when we captured a
        // response (i.e., streamVoiceResponse reached the onComplete
        // seam — dispatch errors short-circuit BEFORE that seam and
        // capturedResponse stays undefined, which postVoiceTurnTranscript
        // treats as "no agent-half to post"). Suppression rules
        // (fallbackSpoken, empty response, feature disabled, empty
        // channels) are evaluated inside the helper. Awaited here so
        // a slow webhook send completes before the voice turn settles —
        // but caught defensively so a Discord failure can never break
        // the voice flow.
        if (capturedResponse !== undefined) {
          try {
            await this.postVoiceTurnTranscript({
              agentName: args.agentName,
              voiceSession: args.voiceSession,
              voiceUserId: args.voiceUserId,
              transcript: args.transcript,
              agentResponse: capturedResponse,
              fallbackSpoken: args.voiceSession.fallbackSpoken,
            });
          } catch (err) {
            // Defensive — postVoiceTurnTranscript already catches its
            // own send failures, but a programming bug in the helper
            // (or in a future overrider) MUST NOT crash the voice
            // turn's finally chain.
            this.log.warn(
              {
                agent: args.agentName,
                error: err instanceof Error ? err.message : String(err),
              },
              "postVoiceTurnTranscript (agent-half) threw (defensive catch)",
            );
          }
        }
      }
    } catch (err) {
      if (isVoiceAbortError(err)) {
        // Phase 135.1 — a barge-in / leave abort is a benign disposition, not
        // a failure. Log at debug and move on rather than spamming error logs
        // and red turn dashboards on every interruption.
        if (voiceTurn.trace.outcome === "unknown") voiceTurn.trace.outcome = "aborted";
        this.log.debug(
          {
            agent: args.agentName,
            guildId: args.guildId,
            sessionId: args.voiceSession.id,
          },
          "voice turn aborted (barge-in / leave)",
        );
      } else {
        // Pitfall 8 — voice ingress errors MUST NOT leak into the
        // shared discord.js Client. Log loudly, swallow.
        voiceTurn.trace.outcome = "error";
        this.log.error(
          {
            agent: args.agentName,
            guildId: args.guildId,
            channelId: args.channelId,
            voiceUserId: args.voiceUserId,
            error: err instanceof Error ? err.message : String(err),
          },
          "handleVoiceTranscript failed (caught at bridge boundary)",
        );
      }
    } finally {
      // 999.116 A3 (G7) — one structured latency record per turn (lengths
      // only, never text). scripts/voice-verify.sh reads these off the prod
      // journal and prints the PASS/FAIL table; the tag is the grep key.
      try {
        const trace = voiceTurn.trace;
        stampVoiceTurn(trace, "end");
        trace.responseChars = capturedResponse?.length ?? 0;
        const cfg = args.voiceSession.voiceCfg;
        this.log.info(
          summarizeVoiceTurnTrace(trace, {
            agent: args.agentName,
            sessionId: args.voiceSession.id,
            turnId: voiceTurn.id,
            generation: voiceTurn.generation,
            engine: cfg.stt?.engine ?? "nova3",
            streamingTts: cfg.streamingTts?.enabled === true,
            bargeInEnabled: cfg.bargeIn?.enabled === true,
          }),
          VOICE_TURN_TRACE_MSG,
        );
      } catch (err) {
        this.log.debug(
          { error: err instanceof Error ? err.message : String(err) },
          "voice turn trace failed (non-fatal)",
        );
      }
      // Phase 135.1 — clear the cancellation-spine turn (generation-guarded,
      // so a barge-in that already superseded this turn does not clobber its
      // successor).
      endVoiceTurn(args.voiceSession, voiceTurn);
      // 135.0.5 — release the turn lock so the next queued turn can run.
      release!();
    }
  }

  /**
   * Phase 135 Plan 02 — voice-path streaming branch of
   * streamAndPostResponse. Dispatches through TurnDispatcher just like
   * the text path, but routes the final response through ElevenLabs
   * TTS into the session's AudioPlayer instead of editing/sending a
   * Discord message.
   *
   * Kept as a small dedicated method so the existing text-path code in
   * `streamAndPostResponse` stays byte-identical for every pre-Plan-02
   * call site — the byte-identical-text invariant from the plan
   * `<must_haves>`.
   */
  /**
   * Phase 135.1 Phase 4 — lazily open (and reuse) the per-session ElevenLabs
   * streaming-TTS socket.
   */
  private async ensureTtsSocket(
    session: import("./voice/session.js").VoiceSession,
  ): Promise<import("./voice/tts-ws.js").VoiceTtsSocket> {
    if (session.ttsSocket) {
      await session.ttsSocket.ensureOpen();
      return session.ttsSocket;
    }
    const { VoiceTtsSocket } = await import("./voice/tts-ws.js");
    const sock = new VoiceTtsSocket({
      apiKey: session.voiceCfg.elevenLabsKey,
      voiceId: session.voiceCfg.voiceId,
      outputFormat: session.voiceCfg.streamingTts?.outputFormat,
      log: this.log,
    });
    session.ttsSocket = sock;
    await sock.ensureOpen();
    return sock;
  }

  /**
   * Phase 135.1 Phase 4 — prepare a streaming-TTS context for a turn, or return
   * null to fall back to HTTP speakResponse. On success: opens a WS context,
   * plays its (resampled 48k-stereo) audio through the session player, parks the
   * stream for hard-stop, wires the abort signal to close_context, and honors
   * the post-interrupt backoff + SPEAKING phase transition.
   */
  private async setupStreamingTts(
    session: import("./voice/session.js").VoiceSession,
    sessionName: string,
    abortSignal: AbortSignal | undefined,
  ): Promise<{
    context: import("./voice/tts-ws.js").TtsSpeechContext;
    aggregator: import("./voice/sentence-aggregator.js").SentenceAggregator;
    resource: unknown;
  } | null> {
    const cfg = session.voiceCfg.streamingTts;
    if (!cfg?.enabled) return null;
    if (session.fallbackSpoken) return null; // silence fallback owns the audio
    if (!session.voiceCfg.elevenLabsKey || !session.voiceCfg.voiceId) return null;
    if (!session.player) return null;
    try {
      const socket = await this.ensureTtsSocket(session);
      // 999.116 A3 (G7) — TTS first byte = the first audio message routed to
      // this turn's context.
      const trace = session.currentTurn?.trace;
      const context = socket.beginContext(undefined, {
        onFirstAudio: () => {
          if (trace) stampVoiceTurn(trace, "ttsFirstByte");
        },
      });
      const { createAudioResource, StreamType } = await import("@discordjs/voice");
      const resource = createAudioResource(context.audio, {
        inputType: StreamType.Raw,
      });
      if (session.currentTurn) session.currentTurn.ttsStream = context.audio;
      if (abortSignal) {
        if (abortSignal.aborted) {
          try { context.cancel(); } catch { /* non-fatal */ }
          return null;
        }
        abortSignal.addEventListener(
          "abort",
          () => {
            try { context.cancel(); } catch { /* non-fatal */ }
          },
          { once: true },
        );
      }
      // Post-interrupt backoff, then mark SPEAKING (so a speaking-start now
      // triggers a barge-in) and start playback.
      const backoffWait = (session.bargeInBackoffUntil ?? 0) - Date.now();
      if (backoffWait > 0) {
        await new Promise((r) => setTimeout(r, Math.min(backoffWait, 1500)));
      }
      setVoicePhase(session, "speaking");
      // 999.116 A3 (G7) — observe THIS resource's Playing/Idle transitions
      // (registered before play() so the first frame can't be missed).
      if (trace) attachPlayerTrace(session.player, resource, trace);
      session.player.play(resource);
      // Streaming audio is committed (~1s to first sentence) — cancel the
      // slow-turn silence fallback so Haiku can't grab the AudioPlayer and talk
      // over the agent mid-stream.
      try {
        const { cancelSilenceTimer } = await import("./voice/silence-fallback.js");
        cancelSilenceTimer(session);
      } catch {
        /* non-fatal */
      }
      const { SentenceAggregator } = await import("./voice/sentence-aggregator.js");
      return { context, aggregator: new SentenceAggregator(), resource };
    } catch (err) {
      this.log.warn(
        {
          agent: sessionName,
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "streaming TTS setup failed — falling back to HTTP TTS",
      );
      return null;
    }
  }

  private async streamVoiceResponse(
    session: import("./voice/session.js").VoiceSession,
    sessionName: string,
    formattedMessage: string,
    turn?: Turn,
    onVoiceResponseComplete?: (response: string) => void,
  ): Promise<void> {
    // Phase 135.1 — the in-flight turn's AbortController signal (set by
    // beginVoiceTurn in handleVoiceTranscript). Threaded into the SDK so a
    // barge-in / leave cancels generation, and into speakResponse so it stops
    // playback. Undefined only on the silence-fallback / no-turn paths.
    const abortSignal = session.currentTurn?.abort.signal;
    // 999.116 A3 (G7) — captured once: a barge-in nulls session.currentTurn
    // mid-turn, but this turn's trace must still receive its outcome.
    const trace = session.currentTurn?.trace;
    // Phase 135.1 Phase 4 — set up sentence-streamed TTS when enabled. While
    // active, each completed sentence is piped into the ElevenLabs multi-context
    // WebSocket as the LLM produces it (audio starts after sentence 1). Null =
    // the proven post-dispatch HTTP speakResponse path (disabled, no creds,
    // silence-fallback active, or WS setup failed).
    const stream = await this.setupStreamingTts(session, sessionName, abortSignal);
    if (trace && stream) trace.ttsMode = "ws";
    try {
      const onChunk = (accumulated: string) => {
        if (trace && accumulated.length > 0) stampVoiceTurn(trace, "firstToken");
        if (!stream) return;
        try {
          for (const s of stream.aggregator.push(accumulated)) {
            stream.context.pushSentence(s);
            if (trace) stampVoiceTurn(trace, "firstSentence");
          }
        } catch {
          /* non-fatal — a bad chunk must not break the dispatch */
        }
      };

      let response: string;
      if (this.turnDispatcher) {
        const safeSessionId = session.id.replace(/[^a-zA-Z0-9_-]/g, "_");
        const turnId = `${DISCORD_SNOWFLAKE_PREFIX}voice-${safeSessionId}-${Date.now()}`;
        const origin = makeRootOriginWithTurnId("discord", session.id, turnId);
        response = await this.turnDispatcher.dispatchStream(
          origin,
          sessionName,
          formattedMessage,
          onChunk,
          { turn, channelId: session.channelId, signal: abortSignal },
        );
      } else {
        response = await this.sessionManager.streamFromAgent(
          sessionName,
          formattedMessage,
          onChunk,
          turn,
          { signal: abortSignal },
        );
      }

      // Phase 135.5 — fire the Plan-05 capture seam BEFORE TTS (or
      // before the fallbackSpoken-suppress branch). Caller in
      // handleVoiceTranscript stashes this into a local closure so
      // the finally block can post the agent-half transcript. The
      // callback is invoked even when fallbackSpoken=true; the
      // post-site is responsible for honoring suppression rules.
      // Wrapped in try/catch so a misbehaving callback can't break
      // the voice flow.
      if (onVoiceResponseComplete) {
        try {
          onVoiceResponseComplete(response);
        } catch (err) {
          this.log.warn(
            {
              agent: sessionName,
              sessionId: session.id,
              error: err instanceof Error ? err.message : String(err),
            },
            "onVoiceResponseComplete callback threw (defensive catch)",
          );
        }
      }

      // Phase 135.1 Phase 4 — streaming path finalisation. Flush the LLM tail
      // into the WS context, await playback, then return (skips the HTTP
      // speakResponse block below). Barge-in during the LLM stream throws
      // AbortError and is handled by the outer catch; barge-in during playback
      // resolves waitForPlayerIdle via player.stop(true) and is detected here.
      if (stream) {
        if (session.fallbackSpoken || !response || response.trim().length === 0) {
          if (trace) trace.outcome = "empty";
          try { stream.context.cancel(); } catch { /* non-fatal */ }
          try { turn?.end(session.fallbackSpoken ? "success" : "error"); } catch { /* non-fatal */ }
          return;
        }
        const tail = stream.aggregator.flush(response);
        if (tail) stream.context.pushSentence(tail);
        stream.context.flush();
        try {
          const { waitForPlayerIdle } = await import("./voice/tts.js");
          await waitForPlayerIdle(session);
          if (abortSignal?.aborted) {
            try { stream.context.cancel(); } catch { /* non-fatal */ }
            // Charge only what actually played (barge-in never over-counts).
            if (session.minutesTracker) {
              const played = (stream.resource as { playbackDuration?: number }).playbackDuration ?? 0;
              if (played > 0) session.minutesTracker.addSynthesisSeconds(played / 1000);
            }
            this.log.debug(
              { agent: sessionName, sessionId: session.id },
              "voice streaming TTS interrupted during playback (barge-in)",
            );
            try { turn?.end("error"); } catch { /* non-fatal */ }
            return;
          }
          if (session.minutesTracker) {
            const played =
              (stream.resource as { playbackDuration?: number }).playbackDuration ?? 0;
            const seconds = played > 0 ? played / 1000 : response.length / 15;
            if (seconds > 0) session.minutesTracker.addSynthesisSeconds(seconds);
          }
          if (this.voiceManager) {
            void this.voiceManager
              .checkCapAndDisconnectIfNeeded(session)
              .catch(() => undefined);
          }
          if (trace) trace.outcome = "spoken";
          this.log.info(
            { agent: sessionName, sessionId: session.id },
            "voice streaming TTS: playback complete",
          );
          try { turn?.end("success"); } catch { /* non-fatal */ }
        } catch (err) {
          try { stream.context.cancel(); } catch { /* non-fatal */ }
          if (isVoiceAbortError(err)) {
            this.log.debug(
              { agent: sessionName, sessionId: session.id },
              "voice streaming TTS interrupted (barge-in)",
            );
          } else {
            if (trace) trace.outcome = "tts-error";
            this.log.error(
              { agent: sessionName, sessionId: session.id, error: err instanceof Error ? err.message : String(err) },
              "voice streaming TTS playback failed",
            );
          }
          try { turn?.end("error"); } catch { /* non-fatal */ }
        }
        return;
      }

      // Phase 135 REVIEW WR-06 — track TTS success/failure separately
      // so the turn audit reflects what the USER ACTUALLY HEARD, not
      // just whether the agent generated text. Previously, a TTS
      // playback failure was caught + logged but the outer try block
      // still fell through to turn?.end("success"), so operator
      // dashboards showed a healthy turn while the voice channel had
      // dead air. ttsOutcome captures the user-audible result.
      let ttsOutcome: "success" | "error" | "skipped-fallback" | "empty" =
        "empty";
      if (response && response.trim().length > 0) {
        // Phase 135 REVIEW CR-02 — claim-speaker check. If the silence
        // fallback already fired (Haiku has either spoken or is in
        // flight toward TTS), suppress the agent's response to avoid
        // talking over Haiku. The flag is set inside fireHaikuFallback
        // before the Haiku call begins; reset happens at the start of
        // every new handleVoiceTranscript turn.
        if (session.fallbackSpoken) {
          this.log.info(
            {
              agent: sessionName,
              sessionId: session.id,
              responseLength: response.length,
            },
            "agent response arrived after silence-fallback fired — skipping TTS to avoid talking over Haiku",
          );
          // WR-06: skipped-due-to-fallback is a SUCCESS at the turn-audit
          // layer (the user heard Haiku's reply; the agent's text
          // exists but was deliberately suppressed). The dashboards
          // record this turn as completed, which is correct.
          try {
            turn?.end("success");
          } catch {
            /* non-fatal */
          }
          return;
        }
        const { speakResponse } = await import("./voice/tts.js");
        // Phase 135.1 Phase 3 — honor the post-interrupt backoff (stay quiet
        // briefly after a confirmed barge-in), then mark SPEAKING so a
        // speaking-start during playback triggers the interrupt.
        const backoffWait = (session.bargeInBackoffUntil ?? 0) - Date.now();
        if (backoffWait > 0) {
          await new Promise((r) => setTimeout(r, Math.min(backoffWait, 1500)));
        }
        setVoicePhase(session, "speaking");
        if (trace) trace.ttsMode = "http";
        this.log.info(
          { agent: sessionName, sessionId: session.id, responseLength: response.length },
          "voice TTS: calling speakResponse",
        );
        try {
          const spoken = await speakResponse(session, response, abortSignal, trace);
          this.log.info(
            { agent: sessionName, sessionId: session.id, interrupted: spoken.interrupted },
            spoken.interrupted
              ? "voice TTS: playback interrupted by barge-in"
              : "voice TTS: speakResponse returned (audio played to idle)",
          );
          ttsOutcome = spoken.interrupted ? "skipped-fallback" : "success";
          if (trace && !spoken.interrupted) trace.outcome = "spoken";
          // Phase 135 Plan 03 — check cap after TTS synthesis. The
          // tts.ts speakResponse path accumulates estimated synthesis
          // seconds into session.minutesTracker; the cap-check here
          // disconnects + warns the operator if the cap is hit.
          if (this.voiceManager) {
            void this.voiceManager
              .checkCapAndDisconnectIfNeeded(session)
              .catch((err) => {
                this.log.error(
                  {
                    agent: sessionName,
                    sessionId: session.id,
                    error: err instanceof Error ? err.message : String(err),
                  },
                  "voice cap-check after TTS failed",
                );
              });
          }
        } catch (err) {
          ttsOutcome = "error";
          if (trace) trace.outcome = "tts-error";
          this.log.error(
            {
              agent: sessionName,
              sessionId: session.id,
              error: err instanceof Error ? err.message : String(err),
            },
            "ElevenLabs TTS playback failed",
          );
        }
      } else {
        if (trace) trace.outcome = "empty";
        this.log.warn(
          { agent: sessionName, sessionId: session.id },
          "voice agent returned empty response — nothing to speak",
        );
      }

      try {
        // WR-06: 'success' only when audio was actually played. Empty
        // response and TTS failure both mark the turn as 'error' —
        // operator dashboards correctly flag voice-side silent
        // degradations instead of recording a green turn over dead air.
        turn?.end(ttsOutcome === "success" ? "success" : "error");
      } catch {
        /* non-fatal */
      }
    } catch (err) {
      // Phase 135.1 Phase 4 — cancel any open streaming-TTS context so a
      // barge-in / error during the LLM stream stops server-side synthesis,
      // and charge the minutes cap for what actually played (if anything).
      if (stream) {
        try { stream.context.cancel(); } catch { /* non-fatal */ }
        if (session.minutesTracker) {
          const played = (stream.resource as { playbackDuration?: number }).playbackDuration ?? 0;
          if (played > 0) session.minutesTracker.addSynthesisSeconds(played / 1000);
        }
      }
      // Phase 135.1 — a barge-in / leave abort cancelled this turn. Benign:
      // trace it, but no error log, no "not awake" notice, no re-speak.
      if (isVoiceAbortError(err)) {
        try {
          turn?.end("error");
        } catch {
          /* non-fatal */
        }
        this.log.debug(
          { agent: sessionName, sessionId: session.id },
          "voice turn aborted mid-dispatch (barge-in / leave)",
        );
        return;
      }
      try {
        turn?.end("error");
      } catch {
        /* non-fatal */
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      if (trace) trace.outcome = "error";
      this.log.error(
        { agent: sessionName, sessionId: session.id, error: errMsg },
        "streamVoiceResponse failed (caught at voice-path boundary)",
      );
      // 135.0.2 — clear user-facing TTS error when the agent session isn't
      // bound yet (race with cold-start / mid-crash-recovery). Without this,
      // the voice channel goes silent and the operator has no signal that
      // anything happened. Speak a short notice via the same ElevenLabs path
      // the success branch uses; swallow TTS errors here (we're already in
      // the catch).
      if (errMsg.includes("is not running") || errMsg.includes("not bound")) {
        try {
          const { speakResponse } = await import("./voice/tts.js");
          await speakResponse(
            session,
            "I'm not awake right now. Send me a text message first to wake me, then try voice again.",
          );
        } catch (ttsErr) {
          this.log.warn(
            {
              agent: sessionName,
              sessionId: session.id,
              error: ttsErr instanceof Error ? ttsErr.message : String(ttsErr),
            },
            "voice-error-notice TTS playback failed (non-fatal)",
          );
        }
      }
    }
  }

  /**
   * Stream a response from the named session and post it back to the incoming
   * message's channel (regular channel or thread). Handles typing indicators,
   * progressive message editing, multi-message splitting for long output, and
   * error reactions.
   */
  /**
   * Phase 135 Plan 02 — discriminated delivery union. The text path
   * stays byte-identical: when callers omit `delivery`, we internally
   * synthesise `{ kind: "text", message }` from the `message` argument.
   * Voice callers (handleVoiceTranscript) pass `{ kind: "voice",
   * session }` and a `message: undefined`.
   */
  // -------------------------------------------------------------------------
  // Phase 999.100 — mid-turn intent steering (v2 main channels)
  // -------------------------------------------------------------------------

  /**
   * In-flight dispatch trigger records, per agent. Pushed at
   * streamAndPostResponse entry (text path), removed at its success tail /
   * catch head. FIFO — the SerialTurnQueue serializes turns in dispatch
   * order and the bridge awaits, so the HEAD approximates the trigger of
   * the turn currently RUNNING (a queued 2nd dispatch sits behind it).
   * Read-side pruning (2h) self-heals the rare strand (a throw inside the
   * catch handler itself); a stale record only degrades classifier context,
   * never correctness.
   */
  private readonly inFlightTriggers = new Map<
    string,
    Array<{
      messageId: string;
      channelId: string;
      excerpt: string;
      startedAt: number;
      // 999.178 R1 — for a status-ping reply: the ORIGINATING message content
      // and WHEN the user sent it. Distinct from `excerpt` (the formatted /
      // recap / [Combined:] / late-steer-wrapped dispatch text) and from
      // `startedAt` (turn start). The ping renders "your 2:14 PM ask" from when
      // he asked, and the excerpt from his own words.
      content: string;
      askedAt: number;
    }>
  >();

  /** Trigger records older than this are pruned on read (self-healing). */
  private static readonly IN_FLIGHT_TRIGGER_MAX_AGE_MS = 2 * 60 * 60 * 1000;

  /**
   * 999.63c — delivered-message refs for edit-in-place corrections, keyed
   * by turn id. Written ONLY at the v2 final-delivery edit exit (bot
   * identity, ≤2000 chars); the >2000 webhook re-delivery and the
   * no-stream sendResponse exits retain no ids, so their corrections fall
   * back to the follow-up post by map miss. Age-pruned + size-capped in
   * the store (same self-healing posture as inFlightTriggers).
   */
  private readonly deliveredRefs = new DeliveredMessageRefStore();
  /** 2026-08-27 verification v2 — per-reply evidence + claims, keyed by turn/message. */
  private readonly ledgerStore: VerificationLedgerStore;
  private readonly ledgerPersist: LedgerPersistence | undefined;

  /**
   * 2026-08-27 — the 08-26 "verified badge" (✅ after the post-delivery
   * verification settles clean) predates the verdict-reaction family. Once
   * `ux.verdictReactions` is on, reactions are EXCEPTIONS only (✏️ / ⚠️): the
   * operator's rule is "not every message needs a green checkmark - knowing
   * sources were cited is enough", and the Sources line already says that.
   * The legacy badge therefore stands down whenever the verdict family is
   * active, regardless of `ux.verifiedBadge`.
   */
  private verdictReactionsOwnBadges(agentName: string): boolean {
    try {
      return this.sessionManager.getAgentConfig(agentName)?.verification?.ux?.verdictReactions === true;
    } catch {
      return false;
    }
  }

  /** 🧾 button/reaction lookup (daemon-side, no model turn). */
  getLedgerByMessageId(messageId: string): TurnLedger | undefined {
    return this.ledgerStore.byMessageId(messageId);
  }

  getRecentLedgers(agent: string, limit = 5): TurnLedger[] {
    return this.ledgerStore.recent(agent, limit);
  }

  /**
   * Post the ledger card as a REPLY to the message that carried the answer
   * (bot identity, raw CV2 REST — the renderer has no edit path). Falls back
   * to a one-line note when no ledger exists. 10-min dedupe per message.
   */
  async postLedgerCard(args: {
    channelId: string;
    replyToMessageId: string;
    ledger: TurnLedger | undefined;
  }): Promise<boolean> {
    if (!this.ledgerStore.markCardPosted(args.replyToMessageId)) return false;
    const reference = {
      message_reference: { message_id: args.replyToMessageId, fail_if_not_exists: false },
      allowed_mentions: { parse: [] as string[], replied_user: false },
    };
    try {
      if (!args.ledger) {
        await this.client.rest.post(Routes.channelMessages(args.channelId), {
          body: {
            content:
              "-# No verification ledger for this message (older than 7 days, or not a verified turn) · react 🔍 to re-verify",
            ...reference,
          },
        });
        return true;
      }
      const spec = buildLedgerCardSpec({
        agent: args.ledger.agent,
        promptExcerpt: args.ledger.promptExcerpt,
        at: new Date(args.ledger.deliveredAt).toISOString().slice(11, 16),
        claims: args.ledger.claims,
        evidence: args.ledger.evidence,
        ...(args.ledger.recall ? { recall: args.ledger.recall } : {}),
      });
      await this.client.rest.post(Routes.channelMessages(args.channelId), {
        body: { ...buildCv2Payload(spec), ...reference },
      });
      return true;
    } catch (err) {
      this.log.warn(
        { channelId: args.channelId, error: err instanceof Error ? err.message : String(err) },
        "ledger card post failed (non-fatal)",
      );
      return false;
    }
  }
  /** 999.63d/4 — chunk refs for long (chunked) deliveries. */
  private readonly chunkRefs = new ChunkRefStore();

  /**
   * Agents whose next dispatch rejection is an EXPECTED mid-turn stop
   * (value = marker expiry, ms-epoch). Set immediately before the stop
   * intent's interruptAgent call; consumed single-shot at the dispatch
   * catch head (suppresses wedge/crash/❌ UX) or at the success tail (the
   * interrupt raced a natural completion). The 10s self-expiry guarantees
   * a stale marker can never swallow a genuine later failure.
   */
  private readonly expectedInterrupts = new Map<string, number>();

  private pushInFlightTrigger(
    agentName: string,
    rec: { messageId: string; channelId: string; excerpt: string; startedAt: number; content: string; askedAt: number },
  ): void {
    const list = this.inFlightTriggers.get(agentName) ?? [];
    list.push(rec);
    this.inFlightTriggers.set(agentName, list);
  }

  private removeInFlightTrigger(agentName: string, messageId: string): void {
    const list = this.inFlightTriggers.get(agentName);
    if (!list) return;
    const next = list.filter((r) => r.messageId !== messageId);
    if (next.length === 0) this.inFlightTriggers.delete(agentName);
    else this.inFlightTriggers.set(agentName, next);
  }

  private headInFlightTrigger(
    agentName: string,
  ): { messageId: string; channelId: string; excerpt: string; startedAt: number; content: string; askedAt: number } | null {
    const list = this.inFlightTriggers.get(agentName);
    if (!list || list.length === 0) return null;
    const cutoff = Date.now() - DiscordBridge.IN_FLIGHT_TRIGGER_MAX_AGE_MS;
    const fresh = list.filter((r) => r.startedAt >= cutoff);
    if (fresh.length !== list.length) {
      if (fresh.length === 0) this.inFlightTriggers.delete(agentName);
      else this.inFlightTriggers.set(agentName, fresh);
    }
    return fresh[0] ?? null;
  }

  /** Single-shot consume; returns true only for a live (unexpired) marker. */
  private consumeExpectedInterrupt(agentName: string): boolean {
    const expiry = this.expectedInterrupts.get(agentName);
    if (expiry === undefined) return false;
    this.expectedInterrupts.delete(agentName);
    return expiry > Date.now();
  }

  /**
   * 2026-07-31 — agents whose RUNNING turn absorbed ≥1 mid-turn steer
   * injection. Entry pinned to the running turn's trigger messageId so it
   * can only ever annotate THAT dispatch's delivery (exact-match consume
   * makes a stale "steered" footer on a later unrelated reply structurally
   * impossible; Discord snowflakes never repeat). Written by
   * tryMidturnRoute on action==="steered" (where the 🧭 lands); consumed
   * single-shot at the footer mutation point in streamAndPostResponse;
   * cleared at the dispatch catch head (wedge auto-rerun / crash retry /
   * expected stop / terminal failure all flow through it BEFORE recursing,
   * so a rerun delivery never over-claims — the injected steer text does
   * not ride the rerun's re-sent original message). Read-side max-age
   * prune self-heals any strand (same discipline as inFlightTriggers).
   */
  private readonly steeredIntoFlight = new Map<
    string,
    {
      readonly triggerMessageId: string;
      readonly count: number;
      readonly lastSteerMessageId: string;
      readonly armedAt: number;
    }
  >();

  private static readonly STEERED_MAX_AGE_MS =
    DiscordBridge.IN_FLIGHT_TRIGGER_MAX_AGE_MS;

  /** Arm (or increment) the steered marker for the running turn. */
  private noteSteeredIntoFlight(
    agentName: string,
    triggerMessageId: string,
    steerMessageId: string,
  ): void {
    const prev = this.steeredIntoFlight.get(agentName);
    if (prev && prev.triggerMessageId === triggerMessageId) {
      this.steeredIntoFlight.set(agentName, {
        ...prev,
        count: prev.count + 1,
        lastSteerMessageId: steerMessageId,
      });
      return;
    }
    // A mismatched leftover is by definition stale (a new turn started) —
    // overwrite with a fresh entry.
    this.steeredIntoFlight.set(agentName, {
      triggerMessageId,
      count: 1,
      lastSteerMessageId: steerMessageId,
      armedAt: Date.now(),
    });
  }

  /**
   * Single-shot consume for the delivery epilogue: returns the entry ONLY
   * on an exact trigger match within the max age; prunes (and returns
   * null) on mismatch or expiry.
   */
  private consumeSteeredIntoFlight(
    agentName: string,
    triggerMessageId: string,
  ): { count: number; lastSteerMessageId: string } | null {
    const entry = this.steeredIntoFlight.get(agentName);
    if (!entry) return null;
    this.steeredIntoFlight.delete(agentName);
    if (entry.triggerMessageId !== triggerMessageId) return null;
    if (Date.now() - entry.armedAt >= DiscordBridge.STEERED_MAX_AGE_MS) {
      return null;
    }
    return { count: entry.count, lastSteerMessageId: entry.lastSteerMessageId };
  }

  /**
   * Failure-path clear — delete ONLY when the entry belongs to the failing
   * dispatch (a failing OLD dispatch must never wipe a NEW turn's entry).
   */
  private clearSteeredIntoFlight(
    agentName: string,
    triggerMessageId: string,
  ): void {
    const entry = this.steeredIntoFlight.get(agentName);
    if (entry && entry.triggerMessageId === triggerMessageId) {
      this.steeredIntoFlight.delete(agentName);
    }
  }

  // ─────────────────────── 999.178 R1 — status ping ───────────────────────

  /**
   * Shared interrupt path for the mid-turn stop intent AND the status-ping Stop
   * button. Refuses when the running turn's trigger changed since the caller
   * captured the head (stale stop), arms the expected-stop marker BEFORE
   * interrupting so the in-flight dispatch's rejection reads as intentional, and
   * clears the marker on failure. Requires an attributed stream at the call site.
   */
  private async interruptRunningTurn(
    agentName: string,
    expectedTriggerMessageId: string | null,
  ): Promise<unknown> {
    const headNow = this.headInFlightTrigger(agentName);
    if (
      expectedTriggerMessageId !== null &&
      headNow?.messageId !== expectedTriggerMessageId
    ) {
      throw new Error("stale stop — the running turn changed");
    }
    this.expectedInterrupts.set(agentName, Date.now() + 10_000);
    try {
      return await this.sessionManager.interruptAgent(agentName);
    } catch (err) {
      this.expectedInterrupts.delete(agentName);
      throw err;
    }
  }

  /**
   * Asks currently waiting behind the running turn: the depth-1 queued message
   * plus everything in the coalescer. Both were registered into `queuedAskIds`
   * at the channel-route site. The running turn's own trigger is excluded (it is
   * running, not waiting), and terminally-done ids are pruned lazily against
   * `queuedMessageIds`.
   */
  private queuedAskCount(agentName: string, headMessageId: string | null): number {
    const set = this.queuedAskIds.get(agentName);
    if (!set || set.size === 0) return 0;
    let n = 0;
    for (const id of [...set]) {
      if (!this.queuedMessageIds.has(id)) {
        set.delete(id); // terminal — prune
        continue;
      }
      if (id === headMessageId) continue; // running now, not queued
      n += 1;
    }
    if (set.size === 0) this.queuedAskIds.delete(agentName);
    return n;
  }

  /**
   * 999.178 R1 — a message arrived while a turn was running, so it WILL wait
   * (depth-1 queued slot or coalescer). React `cc_hourglass` now (message 2
   * used to wait silently), track it for the "N queued" count, and persist it so
   * a restart in a quiet window doesn't drop it. Idempotent per messageId.
   */
  private registerQueuedAsk(
    message: Message,
    agentName: string,
    channelId: string,
    dispatchText: string,
  ): void {
    let set = this.queuedAskIds.get(agentName);
    if (!set) {
      set = new Set();
      this.queuedAskIds.set(agentName, set);
    }
    if (set.has(message.id)) return;
    set.add(message.id);
    this.queuedMessageIds.add(message.id);
    this.coalescedChannelById.set(message.id, channelId);
    void this.transitionIcon(message, "QUEUED");
    // Persist the DISPATCH text (the formatted/recap/late-steer-wrapped payload),
    // not the raw content, so a restored ask drains exactly as it would have run.
    void upsertQueuedAsk(
      this.coalescedQueueStatePath,
      {
        agentName,
        messageId: message.id,
        channelId,
        content: dispatchText,
        receivedAt: message.createdTimestamp,
        kind: "coalesced",
      },
      this.log,
    ).catch(() => undefined);
  }

  /** Drop a queued ask from the count + the durable store once it is DELIVERED. */
  private clearQueuedAsk(agentName: string, messageId: string): void {
    this.queuedAskIds.get(agentName)?.delete(messageId);
    void removeQueuedAsk(this.coalescedQueueStatePath, messageId, this.log).catch(() => undefined);
  }

  /**
   * A queued ask reached a terminal end OTHER than a clean delivery (stopped,
   * failed, empty). Resolve its hourglass, drop it from the count and delete it
   * from the durable store — persistence only needs to survive the process
   * dying, so any exit where code runs must clear it, or a restart re-answers a
   * turn the user stopped and the count never falls. A no-op unless it was queued.
   */
  private terminalizeQueuedAsk(message: Message, agentName: string, target: QueueState): void {
    if (!this.queuedAskIds.get(agentName)?.has(message.id)) return;
    this.queuedMessageIds.delete(message.id);
    void this.transitionIcon(message, target);
    this.clearQueuedAsk(agentName, message.id);
  }

  /** The agent's own background work still running (non-research), for the status ping. */
  private backgroundTasksFor(agentName: string): StatusPingView["background"] {
    try {
      return getBackgroundBoard(agentName)?.running() ?? [];
    } catch {
      return [];
    }
  }

  /** The agent's live background research, for the status ping (null when none or unknown). */
  private researchStatusFor(agentName: string): StatusPingView["research"] {
    try {
      return getResearchTracker(agentName)?.statusView?.() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The status-ping gate. Answers a short check-in ("eta", "we good?") from the
   * live turn state with NO model turn and NO queueing, and marks it handled.
   * Independent of `steering.autoClassify`; gated only on `uxFeatures.statusPing`
   * (default off) and no attachments. Never throws — any fault falls through to
   * the normal dispatch as if the feature were off.
   */
  private async tryStatusPing(
    message: Message,
    agentName: string,
    channelId: string,
  ): Promise<boolean> {
    try {
      if (message.attachments.size > 0) return false;
      if (!isStatusPing(message.content ?? "")) return false;
      const uxAgent = this.uxFeatureAgentFor(message, agentName);
      const uxConfig =
        uxAgent === agentName
          ? this.sessionManager.getAgentConfig(agentName)
          : this.sessionManager.getAgentConfig(uxAgent);
      if (!resolveUxFeature(uxAgent, "statusPing", uxConfig?.uxFeatures).enabled) {
        return false;
      }

      const now = Date.now();
      const running = this.sessionManager.hasActiveTurn(agentName);
      const head = this.headInFlightTrigger(agentName);
      const lastReply = this.lastReplies.get(channelId);
      const view: StatusPingView = {
        running,
        nowMs: now,
        askedAtMs: running ? head?.askedAt ?? null : null,
        askExcerpt: running ? head?.content ?? null : null,
        turnStartedAtMs: running ? this.sessionManager.getTurnStartedAt(agentName) : null,
        stepLabel: running ? this.liveStepLabel.get(agentName) ?? null : null,
        queuedCount: this.queuedAskCount(agentName, head?.messageId ?? null),
        lastReplyAtMs: lastReply?.at ?? null,
        loaderIcon: icons.inline("loader") || icons.inline("activity"),
        // Background research and self-fired turns (a research synthesis) are
        // not daemon turns — without these the ping said "Nothing running"
        // while the agent was writing up four researchers' findings.
        research: this.researchStatusFor(agentName),
        selfFiredTurnOpen: !running && this.sessionManager.isOrphanTurnOpen(agentName),
        background: this.backgroundTasksFor(agentName),
        lastReplyText: lastReply?.text ?? null,
      };
      const text = renderStatusPing(view);

      // Continue/Stop only once the running turn has gone quiet for ~3 min, and
      // only when it can actually be steered/stopped (attributed stream).
      const lastProgressAt = running ? this.sessionManager.getLastTurnActivityAt(agentName) : null;
      const canControl = running && this.sessionManager.hasAttributedStream(agentName);
      const stalled = canControl && isTurnStalled(lastProgressAt, now) && head !== null;
      const components =
        stalled ? this.buildStatusPingButtons(agentName, head!.messageId, message.author.id) : undefined;

      await message.reply({
        content: text,
        ...(components ? { components: components as never } : {}),
        allowedMentions: { repliedUser: false, parse: [] },
      });
      this.log.info(
        { agent: agentName, channel: channelId, messageId: message.id, running, queued: view.queuedCount, stalled },
        "status-ping answered from live trail (no model turn)",
      );
      return true;
    } catch (err) {
      this.log.warn(
        { agent: agentName, channel: channelId, error: err instanceof Error ? err.message : String(err) },
        "status-ping gate failed — proceeding with normal dispatch",
      );
      return false;
    }
  }

  /** Continue + Stop rows for a stalled status-ping reply. */
  private buildStatusPingButtons(agentName: string, triggerMessageId: string, userId: string): unknown[] {
    const cont = new ButtonBuilder()
      .setCustomId(buildStatusPingButtonId("continue", agentName, triggerMessageId, userId))
      .setLabel("Continue")
      .setStyle(ButtonStyle.Secondary);
    const play = icons.button("play");
    if (play) cont.setEmoji({ id: play.id, name: play.name });
    const stop = new ButtonBuilder()
      .setCustomId(buildStatusPingButtonId("stop", agentName, triggerMessageId, userId))
      .setLabel("Stop")
      .setStyle(ButtonStyle.Danger);
    const stopIcon = icons.button("stop");
    if (stopIcon) stop.setEmoji({ id: stopIcon.id, name: stopIcon.name });
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(cont, stop).toJSON()];
  }

  /**
   * A Continue/Stop click on a stalled status-ping reply. Gated to the person
   * who asked (the userId in the customId). Stop reuses the shared interrupt
   * path (attributed-stream + stale-turn guards); Continue injects a "continue"
   * steer into the running turn via the existing steering path.
   */
  async handleStatusPingButton(interaction: MessageComponentInteraction): Promise<void> {
    const parsed = parseStatusPingButtonId(interaction.customId);
    if (!parsed) return;
    if (interaction.user.id !== parsed.userId) {
      await interaction.reply({ content: "That button belongs to the person who asked.", flags: 64 as never }).catch(() => {});
      return;
    }
    const { action, agent, triggerMessageId } = parsed;
    try { await interaction.deferUpdate(); } catch { /* already acked */ }
    // Retire the buttons so a double-tap can't fire twice.
    await interaction.message.edit({ components: [] }).catch(() => {});

    if (!this.sessionManager.hasActiveTurn(agent) || !this.sessionManager.hasAttributedStream(agent)) {
      await interaction.followUp({ content: "That turn already finished.", flags: 64 as never }).catch(() => {});
      return;
    }

    if (action === "stop") {
      try {
        await this.interruptRunningTurn(agent, triggerMessageId);
        await interaction.followUp({ content: "Stopped.", flags: 64 as never }).catch(() => {});
      } catch (err) {
        this.log.warn({ agent, error: err instanceof Error ? err.message : String(err) }, "status-ping stop failed");
        await interaction.followUp({ content: "Couldn't stop it — that turn may have just finished.", flags: 64 as never }).catch(() => {});
      }
      return;
    }

    // Continue — inject a steer into the running turn (no new dispatch).
    const cfg = resolveSteeringRuntime(this.sessionManager.getAgentConfig(agent)?.steering);
    const res = this.sessionManager.injectMidTurn(agent, frameMidturnSteer("continue"), {
      maxPerTurn: cfg.maxInjectionsPerTurn,
    });
    await interaction.followUp({
      content: res.injected ? "Nudged it to keep going." : "That turn already finished.",
      flags: 64 as never,
    }).catch(() => {});
  }

  /**
   * Boot restore (999.178 R1): re-seat queued asks persisted before a restart
   * into the coalescer, re-issue their `cc_hourglass`, and let the existing
   * stranded-drain sweep drain them once the agent is up. Non-blocking; a fault
   * only loses durability, never boot.
   */
  async restoreQueuedAsks(): Promise<void> {
    // `coalescer.addMessage` doesn't dedupe by id, so a second `ready` would
    // send every ask twice in the combined payload. Restore exactly once.
    if (this.queuedAsksRestored) return;
    this.queuedAsksRestored = true;
    let asks: Awaited<ReturnType<typeof loadCoalescedQueue>>;
    try {
      asks = await loadCoalescedQueue(this.coalescedQueueStatePath, Date.now(), this.log);
    } catch (err) {
      this.log.warn({ error: err instanceof Error ? err.message : String(err) }, "queued-ask restore failed to load");
      return;
    }
    if (asks.length === 0) return;
    // Fetch each distinct channel once so the QUEUED re-issue has a live handle.
    const channels = new Map<string, Message["channel"] | undefined>();
    for (const ask of asks) {
      // Re-add to the coalescer so the stranded-drain sweep picks it up as a
      // combined dispatch once the agent is running.
      this.messageCoalescer.addMessage(ask.agentName, ask.content, ask.messageId);
      this.coalescedChannelById.set(ask.messageId, ask.channelId);
      this.queuedMessageIds.add(ask.messageId);
      let set = this.queuedAskIds.get(ask.agentName);
      if (!set) {
        set = new Set();
        this.queuedAskIds.set(ask.agentName, set);
      }
      set.add(ask.messageId);
      // Re-issue QUEUED so channelLastState is seeded and the later
      // IN_FLIGHT/DELIVERED transitions can remove the pre-restart hourglass.
      if (!channels.has(ask.channelId)) {
        let ch: Message["channel"] | undefined;
        try {
          ch = (await this.client.channels.fetch(ask.channelId)) as Message["channel"];
        } catch {
          ch = undefined;
        }
        channels.set(ask.channelId, ch);
      }
      const ch = channels.get(ask.channelId);
      if (ch) void this.transitionIconByMessageId(ch, ask.channelId, ask.messageId, "QUEUED");
    }
    this.log.info({ count: asks.length }, "restored persisted queued asks — sweep will drain once agents are up");
  }

  /**
   * Phase 999.100 — mid-turn intent gate for the channel-route branch.
   *
   * Returns true when the message was fully handled here (steered into the
   * running turn, or the running turn was stopped) — the caller must NOT
   * dispatch it. Returns false in every other case, including any internal
   * failure: the caller proceeds with the normal queued dispatch exactly as
   * if the feature were off (fail-open discipline; SC-4 in 999.100-PLAN.md).
   */
  private async tryMidturnRoute(
    message: Message,
    agentName: string,
    channelId: string,
    formattedMessage: string,
    turn: Turn | undefined,
  ): Promise<{ handled: boolean; dispatchOverride?: string }> {
    try {
      const cfg = resolveSteeringRuntime(
        this.sessionManager.getAgentConfig(agentName)?.steering,
      );
      if (!cfg.autoClassify) return { handled: false };
      if (!this.sessionManager.hasActiveTurn(agentName)) return { handled: false };
      // 999.99 review — HARD capability gate: steering only acts on a live
      // attributed-stream session. On a legacy session a steering STOP
      // interrupts a turn whose result then rots unread in the shared
      // stream — re-seeding the exact off-by-one incident this integration
      // fixes. Feature-inert (normal queue path) until the demux is live.
      if (!this.sessionManager.hasAttributedStream(agentName)) {
        this.log.debug(
          { agent: agentName },
          "midturn-intent gate skipped — session has no attributed stream (steering requires delivery.attributedStream)",
        );
        return { handled: false };
      }

      const head = this.headInFlightTrigger(agentName);
      const isReplyToInFlightTrigger =
        head !== null && message.reference?.messageId === head.messageId;

      const result = await routeMidturnMessage({
        agentName,
        content: message.content ?? "",
        formattedMessage,
        isReplyToInFlightTrigger,
        triggerExcerpt: head?.excerpt ?? null,
        elapsedInFlightMs: head ? Date.now() - head.startedAt : null,
        cfg,
        deps: {
          inject: (framed) =>
            this.sessionManager.injectMidTurn(agentName, framed, {
              maxPerTurn: cfg.maxInjectionsPerTurn,
            }),
          // 999.99 review (stale-stop) — the LLM classification can take
          // seconds; the turn the user wanted stopped may have finished and a
          // NEW turn started meanwhile. `interruptRunningTurn` refuses when the
          // running turn's trigger changed since this route began (the throw is
          // folded into a normal dispatch, so the "stop" message just queues).
          interruptAgent: () => this.interruptRunningTurn(agentName, head?.messageId ?? null),
          callClassifier: (system, user, opts) =>
            // 2026-09-24 — trimmedStartup, same as the fast-lane sites: the
            // untrimmed spawn cost 5.7–8 s per classification on prod and
            // SIGTERM'd at the 12 s classifierTimeout twice in one evening
            // (each one silently downgraded a real steer to new_task).
            callHaikuDirect(
              system,
              user,
              { ...opts, trimmedStartup: true },
              "midturn-intent",
            ),
          log: this.log,
        },
      });

      this.log.info(
        {
          agent: agentName,
          channel: channelId,
          messageId: message.id,
          intent: result.classification.intent,
          confidence: result.classification.confidence,
          source: result.classification.source,
          action: result.action,
          ...(result.action === "dispatch" ? { reason: result.reason } : {}),
          // 2026-07-31 — additive field: whether the steered-reply footer
          // was armed for this steer. False only on the head-less edge
          // (e.g. a voice turn in flight — no trigger record → no footer
          // risk, 🧭 still lands).
          ...(result.action === "steered"
            ? { indicated: head !== null }
            : {}),
        },
        "midturn-intent routed",
      );

      if (result.action === "steered") {
        const steerAck = icons.reaction("compass");
        if (steerAck) void message.react(steerAck).catch((err) => {
          this.log.warn(
            { agent: agentName, error: (err as Error).message },
            "midturn steer compass reaction failed (non-fatal)",
          );
        });
        // 2026-07-31 — arm the steered-reply footer on the ABSORBING
        // dispatch (the running turn triggered by head.messageId). Its
        // delivery epilogue consumes this single-shot at the advisor
        // footer mutation point.
        if (head) {
          this.noteSteeredIntoFlight(agentName, head.messageId, message.id);
        }
        // The steer rides the ALREADY-OPEN turn — this message's own Turn
        // closes here (its receive span already ended upstream).
        try { turn?.end("success"); } catch { /* non-fatal */ }
        return { handled: true };
      }
      if (result.action === "stopped") {
        const stopAck = icons.reaction("stop");
        if (stopAck) void message.react(stopAck).catch((err) => {
          this.log.warn(
            { agent: agentName, error: (err as Error).message },
            "midturn stop reaction failed (non-fatal)",
          );
        });
        try { turn?.end("success"); } catch { /* non-fatal */ }
        return { handled: true };
      }
      // 2026-09-24 late-steer grace — a steer whose inject was declined
      // (turn ended during classification) falls through to the normal
      // dispatch, but wrapped in the late-steer envelope and with the compass
      // ack so the user can SEE the steer was recognized. The caller must
      // bypass the fast lane for it (a bare "no, the other one" would
      // otherwise be a quick-lane candidate on the now-idle agent).
      if (
        result.action === "dispatch" &&
        result.reason === "inject-declined" &&
        result.dispatchText !== undefined
      ) {
        const lateSteerAck = icons.reaction("compass");
        if (lateSteerAck) void message.react(lateSteerAck).catch((err) => {
          this.log.warn(
            { agent: agentName, error: (err as Error).message },
            "midturn late-steer compass reaction failed (non-fatal)",
          );
        });
        return { handled: false, dispatchOverride: result.dispatchText };
      }
      return { handled: false };
    } catch (err) {
      this.log.warn(
        { agent: agentName, channel: channelId, error: (err as Error).message },
        "midturn-intent gate failed — proceeding with normal dispatch",
      );
      return { handled: false };
    }
  }

  /**
   * 999.171 MD-01 - per-agent UX toggles (`uxFeatures`, `/clawcode-ux`) key on
   * the CONFIGURED agent. A thread session (`<agent>-thread-<id>`, subagent
   * threads too) holds a one-time snapshot of its parent's config that reload
   * never refreshes, and it is never an override key, so it resolves to the
   * agent bound to the thread's parent channel: the routing lookup
   * ThreadManager itself uses to pick the parent when it creates the session.
   */
  private uxFeatureAgentFor(message: Message, sessionName: string): string {
    const channel = message.channel as { isThread?: () => boolean; parentId?: string | null };
    if (typeof channel.isThread !== "function" || !channel.isThread() || !channel.parentId) return sessionName;
    return this.routingTableRef.current.channelToAgent.get(channel.parentId) ?? sessionName;
  }

  private async streamAndPostResponse(
    message: Message | undefined,
    sessionName: string,
    formattedMessage: string,
    turn?: Turn,
    drainDepth = 0,
    retryCount = 0,
    // Debug session `in-tool-wedge-recovery` work-stream (B), FORK 7 — a
    // SEPARATE single-shot budget for in-tool-wedge auto re-runs, distinct
    // from `retryCount` (the crash-recovery budget). A wedge and a crash
    // are different failure modes; a wedge auto re-run is capped at EXACTLY
    // ONE attempt (`wedgeRetryCount < 1`). If the re-run itself wedges,
    // the recovery falls through to NOTIFY rather than looping. The two
    // budgets are also summed against the existing `retryCount < 2` cap so
    // a request that alternates crash/wedge can never infinite-loop.
    wedgeRetryCount = 0,
    delivery?:
      | { readonly kind: "text"; readonly message: Message }
      | {
          readonly kind: "voice";
          readonly session: import("./voice/session.js").VoiceSession;
          /**
           * Phase 135.5 — optional voice-only callback fired once the
           * agent's response text is computed (BEFORE TTS playback). The
           * Plan-05 caller in handleVoiceTranscript uses this seam to
           * capture the final response so it can post a paired user/
           * agent transcript pair to the agent's primary text channel.
           * Invoked with the empty string when the agent returned no
           * text — caller decides how to handle that (Plan 05 skips the
           * agent-half post on empty).
           */
          readonly onVoiceResponseComplete?: (response: string) => void;
        },
  ): Promise<void> {
    // Phase 135 Plan 02 — synthesise the discriminated union when the
    // caller didn't pass one. The text path is the existing one — every
    // pre-Plan-02 call site stays byte-identical.
    const effectiveDelivery:
      | { readonly kind: "text"; readonly message: Message }
      | {
          readonly kind: "voice";
          readonly session: import("./voice/session.js").VoiceSession;
          readonly onVoiceResponseComplete?: (response: string) => void;
        } =
      delivery ?? (message ? { kind: "text", message } : (() => {
        throw new Error(
          "streamAndPostResponse called with neither a message nor a delivery — caller bug",
        );
      })());

    // Voice path takes a separate, simpler code path — no progressive
    // editor, no typing indicator, no Discord message send. Voice
    // turns are streamed to TurnDispatcher and the final response is
    // spoken via ElevenLabs.
    if (effectiveDelivery.kind === "voice") {
      return this.streamVoiceResponse(
        effectiveDelivery.session,
        sessionName,
        formattedMessage,
        turn,
        effectiveDelivery.onVoiceResponseComplete,
      );
    }

    // Text path — narrow the parameter to a non-undefined local. From
    // here down, the body reads identically to the pre-Plan-02 text-only
    // implementation.
    message = effectiveDelivery.message;
    const channelId = message.channelId;

    // Phase 54: the eager-first sendTyping() fire that used to live here was
    // relocated to DiscordBridge.handleMessage so it fires at message arrival
    // (before session dispatch). The 8-second re-typing heartbeat below is
    // a separate concern (extends typing during long responses) and stays.

    let editor: ProgressiveMessageEditor | undefined;
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    // 999.63d/5 — one-shot quiet-turn arm for the activity trail. Declared
    // out here (with `typingInterval`) so the finally-backstop below clears
    // it on EVERY exit path, including throws.
    let trailQuietTimer: ReturnType<typeof setTimeout> | undefined;
    // 999.171 - per-turn live-thinking controller; stopped by the backstop too.
    let liveThinking: LiveThinkingHandle | undefined;
    // Phase 999.82 Plan 02 — v3 (Model B) block-level streaming. Distinct from
    // the v2 `editor`/`messageRef` locals: the v3 editor posts/edits via the
    // masking webhook (not channel.send), is registered as the bridge progress
    // callback, and DEDUPS the final delivery against the same message. Cleared
    // in `finally`. `v3DeliveryHandled` makes the final-text delivery a single
    // explicit branch (editor flush XOR sendResponse) per
    // `feedback_silent_path_bifurcation`.
    let v3Bridge: ChatChannelBridge | undefined;
    let v3Editor: ProgressiveMessageEditor | undefined;
    let v3EditFn: WebhookEditFn | undefined;
    let v3DeliveryHandled = false;

    // Phase 999.100 — record this dispatch's trigger so the mid-turn intent
    // gate can (a) match Discord replies against the RUNNING turn's trigger
    // and (b) feed the classifier its excerpt. Removed at the success tail
    // and the catch head; read-side 2h pruning self-heals any strand.
    this.pushInFlightTrigger(sessionName, {
      messageId: message.id,
      channelId,
      excerpt: formattedMessage.slice(0, 600),
      startedAt: Date.now(),
      // 999.178 R1 — the user's own words + when he sent them, for the ETA reply.
      content: message.content ?? "",
      askedAt: message.createdTimestamp,
    });

    try {
      // The 8s re-typing heartbeat is cleared on the success path (below) and
      // the catch path — BOTH of which require `await dispatchStream` to settle.
      // A `generator-dead` wedge (the SDK generator dies out-of-band via
      // session-onError without rejecting the in-flight dispatch) leaves that
      // await parked forever, so neither clear runs and the channel shows a
      // PERMANENT typing indicator (the indefinite-typing incident). Hard-cap
      // the heartbeat so a wedged turn cannot type forever: a single chat turn
      // still "typing" past TYPING_MAX_MS has wedged (the stall timeout is 180s;
      // 10 min is far beyond any real turn). Self-clears + logs; the normal
      // clears still fire first on any turn that actually settles.
      const TYPING_INTERVAL_MS = 8000;
      const TYPING_MAX_MS = 600_000;
      // 999.156 — past the soft cap, keep typing while the agent really has a
      // turn in flight (999.155 makes the stall tracker the authority on
      // wedges); the absolute cap is the last-resort backstop.
      const TYPING_ABSOLUTE_MAX_MS = 60 * 60_000;
      let typingBeats = 0;
      typingInterval = setInterval(() => {
        const typedMs = ++typingBeats * TYPING_INTERVAL_MS;
        if (
          typedMs > TYPING_ABSOLUTE_MAX_MS ||
          (typedMs > TYPING_MAX_MS && !this.sessionManager.hasActiveTurn(sessionName))
        ) {
          if (typingInterval) clearInterval(typingInterval);
          typingInterval = undefined;
          this.log.warn(
            { agent: sessionName, channel: channelId },
            "typing indicator hard-capped — turn exceeded max duration (likely wedged)",
          );
          return;
        }
        if ("sendTyping" in message.channel && typeof message.channel.sendTyping === "function") {
          // INC-2026-07-16 fleet crash-loop — this refresh fired inside a
          // setInterval with a bare `void`, so a Discord 5xx on the typing
          // endpoint became an unhandledRejection and the daemon's
          // exit-on-unhandled policy killed the WHOLE fleet (4 crashes in 6
          // minutes during a Discord 500 storm; one short of the systemd
          // 5-per-10min hard stop). Typing is purely cosmetic — swallow, at
          // debug like the handleMessage-entry guard at the first fire site.
          void message.channel.sendTyping().catch((err) => {
            this.log.debug(
              { agent: sessionName, channel: channelId, error: err instanceof Error ? err.message : String(err) },
              "typing refresh failed — observational, non-fatal",
            );
          });
        }
      }, TYPING_INTERVAL_MS);

      // v3 (Model B) — kill the daemon-bot typing "tail" (2026-06-14). The
      // daemon gateway bot fires the typing indicator, but a v3 answer is
      // delivered by the masking webhook (a DIFFERENT identity), so the webhook
      // post never clears the daemon bot's typing — Discord keeps showing it
      // until its own ~8-10s auto-expiry, AFTER the answer is already visible
      // (v2 clears instantly because the same bot sends the reply). Once the
      // webhook starts streaming content (first progress frame), the daemon-bot
      // typing is redundant — the streamed content is now the live "working"
      // signal — so stop the heartbeat here: it then expires mid-turn and there
      // is no typing tail at turn end. Idempotent; safe with the later
      // clearInterval sites (all guard on `typingInterval` / no-op on undefined).
      let v3StreamTypingStopped = false;
      const stopDaemonTypingForV3Stream = (): void => {
        if (v3StreamTypingStopped) return;
        v3StreamTypingStopped = true;
        if (typingInterval) {
          clearInterval(typingInterval);
          typingInterval = undefined;
        }
      };

      const channel = message.channel;
      const messageRef: { current: Message | null } = { current: null };
      // Phase 54 Plan 03: per-agent streaming cadence override. When
      // perf.streaming.editIntervalMs is present on the agent config, thread
      // it into the editor (falls back to the 750ms default). The Turn is
      // passed through so the editor can emit its first-visible-token span
      // on the first editFn call. Log + agent + turnId power the single
      // WARN per turn emitted on rate-limit detection.
      const agentConfig = this.sessionManager.getAgentConfig(sessionName);
      const streamingCfg = agentConfig?.perf?.streaming;
      // C (2026-08-26) — pre-delivery HOLD mode. When the agent opts in
      // (`verification.holdDelivery: true`) AND the gate is
      // enforced for it, nothing unverified may land in the channel:
      // draft streaming is replaced by a static placeholder, and the
      // final text is verified (turnDispatcher.preDeliveryVerify) before
      // the delivery block below runs. Fleet default is OFF — with the
      // flag off this block is byte-identical to the legacy path.
      const holdFvCfg = agentConfig?.verification;
      const holdDeliveryActive =
        holdFvCfg?.holdDelivery === true &&
        isVerificationEnforced(sessionName, holdFvCfg?.enforced) &&
        this.turnDispatcher !== undefined;
      // 999.63d — status-then-stream. During pre-text tool phases the
      // message slot shows a live activity trail ("🔎 working / → searching:
      // …");
      // the FIRST draft chunk streams over it and normal progressive
      // streaming proceeds — draft streaming is never suppressed (that is
      // hold mode, which wins when both are on). Off fleet-wide by
      // default (`verification.ux.streamStatus`).
      // 2026-09-03 — the trail is a COSMETIC display, so it no longer requires
      // financial-verification ENFORCEMENT.
      //
      // It used to also demand `isVerificationEnforced(...)`, which falls back
      // to a name-prefix rule (`fin-`, `acme-`). So on any agent not
      // named like a finance agent the trail could never paint, whatever the
      // config or the /clawcode-verify panel said — and the only way to switch
      // it on was `verification.enforced: true`, which arms the whole
      // claim-verification classifier on every turn ("a non-enforced agent
      // incurs ZERO gate cost" — financial-verification-runner.ts:350). That
      // is a large behavioural price for a status line, and these knobs are
      // documented as "cosmetic UX knobs" precisely because they are not
      // supposed to carry it.
      //
      // `holdDeliveryActive` above KEEPS the enforcement check: holding a
      // message back IS verification behaviour and is correctly gated. This
      // changes nothing for agents that never set `ux.streamStatus` (it
      // defaults false fleet-wide), and nothing for fin-client, which
      // sets it and is enforced either way.
      const streamStatusActive =
        !holdDeliveryActive &&
        holdFvCfg?.ux?.streamStatus === true &&
        this.turnDispatcher !== undefined;
      // 999.171 - live thinking keeps every streamStatusActive precondition and
      // is read per message (override beats yaml), so a toggle hits the next turn.
      // MD-01 - a thread session reads its parent agent's override and live config.
      const uxAgent = this.uxFeatureAgentFor(message, sessionName);
      const uxConfig = uxAgent === sessionName ? agentConfig : this.sessionManager.getAgentConfig(uxAgent);
      const liveThinkingActive =
        streamStatusActive && resolveUxFeature(uxAgent, "liveThinking", uxConfig?.uxFeatures).enabled;
      // 999.63d/5 — ARMING is separate from ACTIVE. `streamStatusActive`
      // says the trail MAY render for this agent; arming says this turn
      // has earned it (operator feedback 2026-08-26: the trail
      // "shouldn't be happening on every prompt, just when it is deemed
      // necessary for verification"). The trail always RECORDS events
      // once active; arming decides when it starts PAINTING them.
      //
      // Two ways to arm:
      //   1. The inbound prompt reads as a financial topic — the only
      //      signal available this early, since both draft classifiers
      //      run at DELIVERY, long after the pre-text tool phase the
      //      trail exists to narrate.
      //   2. The turn goes quiet and tool-heavy anyway. A turn can
      //      acquire financial substance from the WORK rather than the
      //      ask: the 2026-08-26 12-plan audit was prompted with no
      //      figure and no rule term, yet its draft carried 17 figure
      //      tokens and the rules class flagged 529 / 457(b).
      //
      // Display gate only — it never gates verification, a corrective
      // hop, or a delivery. A short shallow turn simply never paints.
      // The classifier is skipped entirely when the trail is off (every
      // agent but fin-client today).
      //
      // `streamStatusMode` selects between those two, so the operator can
      // pick the tradeoff rather than inherit ours:
      //   "always" — arm immediately; every turn with a pre-text tool
      //              phase narrates.
      //   "topic"  — arm ONLY on a financial-topic prompt. Strictest
      //              reading of "only when necessary for verification";
      //              accepts that an audit-shaped turn paints nothing.
      //   "auto"   — DEFAULT, and what shipped 2026-08-26: topic prompts
      //              paint from the first event, everything else paints
      //              only once it proves it is working.
      // 999.63d/7 — a /clawcode-verify override layers OVER the yaml.
      // Config stays the operator-authored baseline; the runtime override
      // is what the slash command sets, persisted and re-applied on boot.
      // Read from the in-memory registry — this is the per-message hot
      // path and must not touch the filesystem.
      const trailOverride = getVerificationOverride(sessionName);
      const trailMode =
        trailOverride?.mode ?? holdFvCfg?.ux?.streamStatusMode ?? "auto";
      const narrationAsTrailActive =
        streamStatusActive && holdFvCfg?.ux?.narrationAsTrail === true;
      const trailQuietArmAllowed = trailMode === "auto";
      const trailStartedAt = Date.now();
      // "topic" and "auto" both arm on a topic match; they differ only in
      // whether the quiet-turn fallback below is allowed to arm as well.
      // 999.63d/6 — the topic vocabulary is per-agent, so a legal agent
      // narrates on clause language and fin-client on figures and
      // eligibility rules. Resolved once per turn; the compiled matchers
      // are cached per distinct profile inside topic-prompt.
      // An override that names a DIFFERENT profile drops the yaml's
      // extraTerms. Those terms were authored to widen a specific
      // vocabulary; carrying them onto another one would silently blend
      // two topics — the same mixing the loader's whole-block `topic`
      // cascade exists to prevent, one layer up.
      const trailConfigProfile = holdFvCfg?.topic?.profile;
      const trailProfileName = trailOverride?.profile ?? trailConfigProfile;
      const trailExtraTerms =
        trailOverride?.profile !== undefined &&
        trailOverride.profile !== trailConfigProfile
          ? []
          : (holdFvCfg?.topic?.extraTerms ?? []);
      const trailProfile = resolveTopicProfile(
        trailProfileName,
        trailExtraTerms,
      );
      let trailArmed =
        streamStatusActive &&
        (trailMode === "always" ||
          isTopicPrompt(formattedMessage, trailProfile));
      let trailToolEvents = 0;
      // UX-C (2026-08-26) — single-flight slot-message creation. The
      // editor's editFn (first draft chunk) and the status callback
      // (first tool event, which typically fires BEFORE any text chunk)
      // may race to create the slot message; the promise latch guarantees
      // exactly one channel.send. `slotCreatedWith` lets a status writer
      // that just created the slot skip its redundant follow-up edit.
      let slotCreatePromise: Promise<void> | null = null;
      let slotCreatedWith: string | null = null;
      // 2026-08-27 — SEPARATE verification status message
      // (`verification.ux.statusMessage: "separate"`). Operator feedback:
      // "I only saw the verify status updates briefly and then they were
      // immediately replaced/edited with the content" — the trail and the
      // answer shared ONE slot, so the answer necessarily destroyed the
      // trail. In separate mode the trail gets its own message that is
      // posted the moment verification is warranted, updated in place, and
      // settled to a one-line summary at delivery; `messageRef` stays the
      // answer slot and every delivery exit is untouched.
      //
      // Its own (promise, lastContent) pair — sharing the slot latch would
      // make the editor await an already-resolved promise and skip creating
      // the ANSWER message.
      const statusRef: { current: Message | null } = { current: null };
      let statusCreatePromise: Promise<void> | null = null;
      let statusCreatedWith: string | null = null;
      // Set BEFORE the settle write; every paint path checks it, so a paint
      // still in flight on the 750 ms cadence cannot re-render the trail
      // over the settled summary.
      let statusSettled = false;
      // 999.63d — set synchronously at editFn entry (streamStatus mode):
      // once draft text is flowing, the status writer must never touch
      // the slot again (a stray in-flight status edit is self-healed by
      // the next ≤750 ms throttled draft edit — documented race).
      let draftStarted = false;
      // 2026-08-27 verification v2 — live claim counters (fed by the claim
      // sink registered below; read by the pinned line while streaming).
      let trailClaimCount = 0;
      let trailClaimVerified = 0;
      // 2026-08-27 — how many chars of the ACCUMULATED draft have already
      // been shown as status items, as TEXT. The editor is handed accumulated text,
      // so once a later fragment pushes it past the fragment size the whole
      // accumulation (narration included) used to land in the answer — which
      // was invisible while the trail and answer shared one message, and an
      // obvious duplicate once the status message became its own. Only the
      // remainder is rendered as the answer, and the same prefix is stripped
      // from the FINAL delivered text.
      let narrationDiverted = "";
      // Real tool calls only — `trailToolEvents` is also bumped by narration
      // fragments, so it cannot answer "did work happen after this text?".
      let toolCallsSeen = 0;
      let narrationDivertedAtTools = -1;
      // Two different consumers of `ux.liveClaims`, and they diverge in
      // separate mode: the claim SINK must stay on (its ✓/✏️ lines are the
      // whole point of the status message), while the PINNED line must go
      // off (it would duplicate the status message's counter inside the
      // answer). Gating both on one flag silenced the sink — caught by
      // bridge-status-message.test.ts.
      const liveClaimsActive =
        streamStatusActive && holdFvCfg?.ux?.liveClaims === true;
      const pinnedLineActive =
        liveClaimsActive && holdFvCfg?.ux?.statusMessage !== "separate";
      /**
       * The diverted text is only NARRATION if real tool work followed it.
       *
       * The detector accepts any short newline-free accumulation, so the first
       * streamed characters of an ordinary answer ("Y", "Yes.") match it too.
       * Stripping those ate the opening of a delivered reply — it shipped as
       * "es. Every trading day for two weeks…" (operator, 18:23). A genuine
       * progress fragment is emitted BETWEEN tool calls, so at least one tool
       * must have run after it; an answer's opening is followed by more text
       * and nothing else.
       */
      const divertedNarrationToStrip = (): string =>
        narrationDivertedAtTools >= 0 && toolCallsSeen > narrationDivertedAtTools
          ? narrationDiverted
          : "";
      const renderPinnedLine = (): string =>
        pinnedLineActive && trailClaimCount > 0
          ? `\n\n-# Verifying ${trailClaimCount} claim${trailClaimCount === 1 ? "" : "s"} · ${trailClaimVerified} verified`
          : "";
      const ensureSlotMessage = async (initialContent: string): Promise<void> => {
        if (messageRef.current) return;
        if (!slotCreatePromise) {
          slotCreatePromise = (async () => {
            if ("send" in channel && typeof channel.send === "function") {
              slotCreatedWith = initialContent;
              messageRef.current = await channel.send(initialContent);
            }
          })();
        }
        await slotCreatePromise;
      };
      // Hold mode is deliberately excluded: `streamStatusActive` already
      // requires !holdDeliveryActive, and hold's placeholder IS the answer
      // slot (exit C edits it in place to keep deliveredRefs, the 🧾 button
      // and the verdict reaction). Nothing about hold mode changes here.
      const separateStatus =
        streamStatusActive && holdFvCfg?.ux?.statusMessage === "separate";
      const ensureStatusMessage = async (initialContent: string): Promise<void> => {
        if (statusRef.current) return;
        if (!statusCreatePromise) {
          statusCreatePromise = (async () => {
            if ("send" in channel && typeof channel.send === "function") {
              statusCreatedWith = initialContent;
              statusRef.current = await channel.send(initialContent);
            }
          })();
        }
        await statusCreatePromise;
      };
      editor = new ProgressiveMessageEditor({
        editFn: async (content: string) => {
          // C — hold mode: post the placeholder once, then suppress every
          // draft-content edit. The placeholder message becomes
          // messageRef.current, so the ≤2000-char final delivery lands as
          // an EDIT of it (and >2000 deletes it before chunking — the
          // existing exits handle both).
          if (holdDeliveryActive) {
            await ensureSlotMessage(HOLD_PLACEHOLDER);
            return;
          }
          // 2026-08-27 — narration-as-trail (`verification.ux.narrationAsTrail`).
          // Measured on fin-client: the model emits short progress
          // fragments between tool calls ("Reading the source first.",
          // "Now the gate.") and the FIRST one set draftStarted, standing
          // the trail down on exactly the long turns it exists for. While
          // the accumulated text is still one short line and no newline
          // has arrived, treat it as an activity line: record it in the
          // trail, paint if armed, and do NOT claim the slot for draft.
          // The moment the text grows past the fragment size or gains a
          // newline it is the answer and the normal path resumes. The
          // fragment still reaches the final delivered text (content is
          // never mutated here); the SOUL line shipped alongside this
          // asks the model to stop narrating at all.
          if (
            narrationAsTrailActive &&
            !draftStarted &&
            streamTrail !== null &&
            content.length <= NARRATION_FRAGMENT_MAX_CHARS &&
            !content.includes("\n")
          ) {
            const line = sanitizeEcho(content.trim(), NARRATION_FRAGMENT_MAX_CHARS);
            if (line.length > 0 && streamTrail.push(line, "speech")) {
              // Separate mode owns a persistent status message, so the
              // narration must NOT also appear in the answer.
              if (separateStatus) {
                narrationDiverted = content;
                narrationDivertedAtTools = toolCallsSeen;
              }
              trailToolEvents += 1;
              if (trailArmed) {
                void paintTrail().catch(() => undefined);
              }
            }
            return;
          }
          // 999.63d — draft text takes the slot over from the status
          // writer. Set BEFORE awaiting the latch so a status callback
          // that fires after this point sees it and stands down.
          draftStarted = true;
          if (slotCreatePromise) {
            await slotCreatePromise;
          }
          // Phase 100 follow-up — wrap raw markdown tables in ```text``` fences
          // so Discord renders them as monospace (columns visibly align).
          // Pass-through for content without tables; idempotent for content
          // already in code fences.
          const body = stripDivertedNarration(content, divertedNarrationToStrip());
          if (body.length === 0) return; // nothing but narration so far
          const wrapped = formatOutboundText(body) + renderPinnedLine();
          if (!messageRef.current) {
            if ("send" in channel && typeof channel.send === "function") {
              messageRef.current = await channel.send({ content: wrapped, ...deliveryFlags() });
            }
          } else {
            await messageRef.current.edit({ content: wrapped, ...deliveryFlags() });
          }
        },
        editIntervalMs: streamingCfg?.editIntervalMs,
        // 2026-08-27 — reserve room for the pinned "verifying…" subtext line.
        maxLength: pinnedLineActive ? Math.min(streamingCfg?.maxLength ?? 2000, 2000) - 120 : streamingCfg?.maxLength,
        turn,
        log: this.log,
        agent: sessionName,
        turnId: message.id,
      });

      // UX-C (2026-08-26) — live verification status on the hold-mode
      // placeholder. Name-only (the onToolUse sink carries no args by
      // construction) mapped to a FIXED phrase set — nothing
      // model-generated can render, preserving hold mode's invariant.
      // Fire-and-forget + fully guarded: a status fault must never
      // break the turn. Undefined outside hold mode ⇒ the dispatcher
      // and handle see the byte-identical legacy path.
      const holdStatusThrottle = holdDeliveryActive
        ? new HoldStatusThrottle(streamingCfg?.editIntervalMs ?? 750)
        : null;
      const holdOnToolUse = holdStatusThrottle
        ? (toolName: string): void => {
            void (async () => {
              try {
                const status = holdStatusThrottle.next(toolName, Date.now());
                if (status === null) return;
                await ensureSlotMessage(status);
                if (messageRef.current && slotCreatedWith !== status) {
                  await messageRef.current.edit(status);
                }
              } catch {
                // Observational only — never break the message path.
              }
            })();
          }
        : undefined;
      // 999.63d (ADDENDUM) — streamStatus writer: a rolling activity
      // trail with real sources ("→ reading irs.gov…"), sanitized via
      // `describeToolActivity` (mention/markdown injection stripped,
      // hard caps). It stands down the moment draft text starts flowing
      // (checked before AND after the latch await to narrow the race; a
      // stray status edit that slips through is overwritten by the next
      // throttled draft edit within ~750 ms). Every event is RECORDED in
      // the trail; only the edits are interval-throttled.
      const streamTrail = streamStatusActive ? new StatusTrail() : null;
      let streamStatusLastEditAt = 0;
      /**
       * Paint the trail's CURRENT recorded state into the slot. Shared by
       * the tool-event writer and the quiet-turn timer so both go through
       * the same draftStarted guards and single-flight slot creation.
       */
      const paintTrail = async (): Promise<void> => {
        if (streamTrail === null) return;
        // 999.151 — no leading emoji (operator: "I don't like all the icons
        // everywhere"), and the elapsed time rides the header so a long quiet
        // stretch still reads as movement rather than a frozen card.
        const header = composeTrailHeader({
          claimCount: trailClaimCount,
          toolCallsSeen,
          thinkingSeen: streamTrail.thinkingSeen,
          elapsedMs: Date.now() - trailStartedAt,
        });
        const body = separateStatus ? streamTrail.renderSubtext(header) : streamTrail.render();
        if (separateStatus) {
          // Own message: `draftStarted` is NOT a stop condition (that is the
          // point — the trail keeps updating while the answer streams into
          // its own message); `statusSettled` is.
          if (statusSettled) return;
          await ensureStatusMessage(body);
          if (statusSettled) return;
          if (statusRef.current && statusCreatedWith !== body) {
            await statusRef.current.edit(body);
            statusCreatedWith = body;
          }
          streamStatusLastEditAt = Date.now();
          return;
        }
        if (draftStarted) return;
        await ensureSlotMessage(body);
        if (draftStarted) return;
        if (messageRef.current && slotCreatedWith !== body) {
          await messageRef.current.edit(body);
          slotCreatedWith = body;
        }
        streamStatusLastEditAt = Date.now();
      };
      /**
       * Settle the separate status message at delivery. A turn that armed on
       * the topic but did no verification work (no claim, no tool event)
       * deletes its status message rather than leaving an empty
       * "🔎 working" in the channel — the arming heuristics used to suppress
       * exactly that turn, and "fire immediately" reintroduces it.
       */
      const settleStatus = async (opts: { deliveredOk: boolean; footerInAnswer?: boolean }): Promise<void> => {
        liveThinking?.stop();
        if (!separateStatus || statusSettled) return;
        statusSettled = true;
        // LO-02 - a status post still in flight would land after settle, stale: wait for it.
        if (statusCreatePromise) await statusCreatePromise.catch(() => undefined);
        const msg = statusRef.current;
        if (!msg) return;
        try {
          // 2026-08-27 sweep — three outcomes, none of which leaves the
          // working trail standing (the operator's "wall of text"):
          //   failed / empty turn → a one-line ⚠️ so the question isn't met
          //                         with silence (the old path DELETED it);
          //   no real work        → delete (armed on topic, trivial answer);
          //   work done           → one grey line with what was checked.
          if (!opts.deliveredOk) {
            // 999.178 R1 — the dead "react 🔍 to retry" (nothing handled 🔍) is
            // removed. A no-answer Retry button is deferred (see the success-tail
            // comment): delivered===false also covers tool-delivered / held
            // financial turns, and no reliable no-tool signal exists here.
            await msg.edit("-# No answer produced");
            return;
          }
          // 2026-08-28 — the answer carries the merged verification line, so
          // the status message has said everything it had to say: remove it.
          if (opts.footerInAnswer) {
            await msg.delete();
            statusRef.current = null;
            return;
          }
          const didWork = trailClaimCount > 0 || toolCallsSeen > 0;
          if (!didWork) {
            // 999.171 (operator 2026-09-24): a live-thinking post is kept as one
            // grey line. Aug-27 forbids post-then-delete; a think under the 5 s
            // floor never posted, so it still gets nothing. Keyed on the
            // controller's own latch, not thinkingSeen: a card narration posted
            // over a sub-floor think is not a live-thinking post (VERIFICATION gap).
            if (liveThinkingActive && liveThinking?.postedThinkingOnly === true) {
              const thoughtSecs = Math.max(1, Math.round((Date.now() - trailStartedAt) / 1000));
              await msg.edit(`-# Thought for ${formatDuration(thoughtSecs, { precise: true })}`);
              return;
            }
            await msg.delete();
            statusRef.current = null;
            return;
          }
          const secs = Math.max(1, Math.round((Date.now() - trailStartedAt) / 1000));
          // 999.151 — same restrained register as the answer's tail line:
          // sentence-case words, no leading glyph, a readable duration.
          const hosts = [
            ...new Set(
              (ledgerSnapshot?.evidence ?? [])
                .filter((e) => e.stale !== true && (e.kind === "read" || e.kind === "document" || e.kind === "queried"))
                .map((e) => e.host ?? e.file ?? e.table ?? "")
                .filter((h) => h.length > 0),
            ),
          ].slice(0, 3);
          const what =
            trailClaimCount > 0
              ? `Verified ${trailClaimVerified} of ${trailClaimCount} claim${trailClaimCount === 1 ? "" : "s"}`
              : `Checked ${toolCallsSeen} step${toolCallsSeen === 1 ? "" : "s"}`;
          const parts = [
            what,
            ...(hosts.length ? [hosts.join(", ")] : []),
            formatDuration(secs, { precise: true }),
          ];
          await msg.edit(`-# ${parts.join(" · ")}`);
          // Tool events but no claims: the trail lines ARE the record; leave
          // the last paint standing rather than replacing it with less.
        } catch (err) {
          this.log.debug(
            { agent: sessionName, error: err instanceof Error ? err.message : String(err) },
            "status message settle failed (non-fatal)",
          );
        }
      };
      // The elapsed-time arm has to be its OWN timer: the tool-event
      // callback can only evaluate elapsed time when an event arrives, so
      // a turn that makes one long synchronous call (a 10-minute Bash, a
      // blocking subagent fan-out) would otherwise never paint — which is
      // exactly the case the operator most wants narrated. Fires once;
      // cleared by the turn's finally-backstop.
      //
      // WHY IT CANNOT PAINT OVER A LIVE DELIVERY. Unlike the tool-event
      // writer, this fires on a wall clock, so `draftStarted` is its only
      // guard against landing a stray slot next to real output. Two
      // invariants close that, and BOTH must hold if this is ever changed:
      //   - v2 (`dispatchStream`) is the only branch that passes
      //     `onToolUse`, and its editFn sets `draftStarted` synchronously
      //     on the first chunk — well inside 20s at a 750ms cadence.
      //     Chunking of a >2000-char reply happens at FINAL delivery,
      //     after streaming, by which point draftStarted is long true.
      //   - the v3 branch never passes `onToolUse` at all, so
      //     `trailToolEvents` stays 0 there and the zero-events guard
      //     below no-ops the timer. Hold mode is excluded by construction
      //     (`streamStatusActive` requires `!holdDeliveryActive`), so
      //     `streamTrail` is null and no timer is created.
      // Separate mode fires the moment verification is warranted (the topic
      // gate already decided that at turn start) instead of waiting for the
      // 3-tool-event / 20 s-quiet arming heuristics, which existed only to
      // keep a SHARED slot quiet.
      // 2026-08-27 sweep — do NOT paint on arm alone. Posting on the topic
      // gate and deleting when no work followed pushed a phantom notification
      // to the phone. The first real tool event (typically 1-3 s in) paints
      // instead, which still reads as immediate; a turn that never touches a
      // tool has nothing to verify and gets no status message at all.
      if (streamTrail !== null && !trailArmed && trailQuietArmAllowed) {
        trailQuietTimer = setTimeout(() => {
          trailQuietTimer = undefined;
          if (trailArmed || draftStarted || trailToolEvents === 0) return;
          trailArmed = true;
          void paintTrail().catch(() => {
            // Observational only — never break the message path.
          });
        }, TRAIL_QUIET_MS);
        // Never hold the process open for a cosmetic status edit.
        trailQuietTimer.unref?.();
      }
      const streamStatusOnToolUse = streamTrail
        ? (toolName: string, input?: unknown): void => {
            toolCallsSeen += 1;
            void (async () => {
              try {
                if (draftStarted) return;
                const activity = describeToolActivity(toolName, input, "stream");
                streamTrail.push(activity);
                // 999.178 R1 — expose the current step so a status ping can name
                // what the agent is doing (best-effort; streamStatus turns only).
                this.liveStepLabel.set(sessionName, activity);
                const now = Date.now();
                // Record always; paint only once armed. An unarmed turn
                // that keeps working arms itself, and the trail it then
                // paints already carries the history recorded above.
                trailToolEvents += 1;
                if (!trailArmed) {
                  if (!trailQuietArmAllowed) return;
                  trailArmed = shouldArmQuietTrail(
                    trailToolEvents,
                    now - trailStartedAt,
                  );
                  if (!trailArmed) return;
                }
                const interval = streamingCfg?.editIntervalMs ?? 750;
                if (now - streamStatusLastEditAt < interval) {
                  liveThinking?.requestPaint(); // 999.171 - catch up instead of dropping
                  return;
                }
                await paintTrail();
              } catch {
                // Observational only — never break the message path.
              }
            })();
          }
        : undefined;

      // Phase 57 Plan 03: route through TurnDispatcher when injected (daemon
      // path) so the trace row carries a TurnOrigin JSON blob. Fall back to
      // the v1.7 streamFromAgent path when the dispatcher is undefined
      // (standalone runner — src/cli/commands/run.ts). The Turn is
      // caller-owned on both branches: streamAndPostResponse keeps ownership
      // of turn.end() so it can fire on success/error in the try/catch
      // below. TurnDispatcher on the caller-owned-Turn path calls
      // turn.recordOrigin(origin) but NOT turn.end().
      //
      // Plan 117-09 (RESEARCH §2 Gate 3, §4.5, §6 Pitfall 1, §13.12 A13) —
      // register `advisor:invoked` / `advisor:resulted` listeners on
      // `sessionManager.advisorEvents` ONLY for the duration of this turn's
      // dispatch. The closure (`didConsultAdvisor`, `lastAdvisorResult`)
      // IS the per-turn scope; the register-around-dispatch pattern means
      // listeners are GC'd naturally at turn end and cannot leak across
      // turns. The agent-name guard (`ev.agent !== sessionName`) filters
      // events that belong to a different agent's concurrent turn.
      //
      // RESEARCH §13.9 / §13.13 Pitfall 8: the standalone-runner branch
      // (`this.turnDispatcher === undefined`) goes through
      // `sessionManager.streamFromAgent`, which does NOT thread the
      // advisor observer that emits these events. That bypass is
      // accepted (production daemon always injects `turnDispatcher`).
      let response: string;
      // 999.163 — follow-ups the model proposed in its <actions> block (stripped from the text).
      let proposedActions: readonly ReplyAction[] = [];
      let didConsultAdvisor = false;
      // 999.151 — the advisor fact, carried as data to the annotation
      // composer (see the single mutation point below).
      let advisorNote = "";
      let lastAdvisorResult:
        | { kind: AdvisorResultedEvent["kind"]; text?: string; errorCode?: string }
        | null = null;
      const onInvoked = (ev: AdvisorInvokedEvent): void => {
        if (ev.agent !== sessionName) return;
        didConsultAdvisor = true;
        // Plan 117.1-01 — production telemetry. INFO so it surfaces in
        // daemon logs without DEBUG noise; matches existing pino convention
        // ({ ...fields }, "message"). Closes the silent-path gap that
        // masked Issue 2 in the 117 operator smoke (see 117.1-CONTEXT.md).
        this.log.info(
          {
            agent: sessionName,
            channel: channelId,
            userMessageId: message.id,
          },
          "advisor invoked (native server tool fired)",
        );
        // Fire-and-forget — addReaction swallows errors itself.
        // 999.160 v1.2 — icon reaction only when the set is loaded; the footer line carries the fact regardless.
        // 999.178 R1 — advisor-consulted reaction is `cc_thought` (locked map).
        const advice = icons.reaction("thought");
        if (advice) void addReaction(message, advice);
      };
      const onResulted = (ev: AdvisorResultedEvent): void => {
        if (ev.agent !== sessionName) return;
        lastAdvisorResult = { kind: ev.kind, text: ev.text, errorCode: ev.errorCode };
        // Plan 117.1-01 — production telemetry. `variant` discriminates
        // advisor_result / advisor_redacted_result / advisor_tool_result_error
        // (RESEARCH §13.4). errorCode only logged on the error variant.
        this.log.info(
          {
            agent: sessionName,
            channel: channelId,
            variant: ev.kind,
            ...(ev.kind === "advisor_tool_result_error"
              ? { errorCode: ev.errorCode }
              : {}),
          },
          "advisor resulted",
        );
      };
      this.sessionManager.advisorEvents.on("advisor:invoked", onInvoked);
      this.sessionManager.advisorEvents.on("advisor:resulted", onResulted);
      // 2026-08-27 — live claim lines. verify_claim records reach the daemon
      // over IPC (not through the handle), so the trail subscribes by TURN id
      // and each validated claim paints as "✓ <claim> · <host>". Claims count
      // toward arming from the second one, so a one-claim short ask never
      // paints a trail on its own.
      const unregisterClaimSink =
        streamTrail !== null && turn?.id && liveClaimsActive
          ? registerClaimSink(turn.id, (entry) => {
              try {
                trailClaimCount += 1;
                if (entry.effectiveVerdict === "verified") trailClaimVerified += 1;
                const glyph =
                  entry.effectiveVerdict === "verified"
                    ? "✓"
                    : entry.effectiveVerdict === "corrected"
                      ? "✏️"
                      : entry.effectiveVerdict === "not-a-claim"
                        ? "·"
                        : "?";
                const where =
                  entry.sourceHost ??
                  (entry.sourceStatus === "in-ledger" ? entry.source : undefined) ??
                  (entry.sourceStatus === "not-consulted" ? "source not opened" : "no source yet");
                const line = `${glyph} ${sanitizeEcho(entry.claim, 60)} · ${sanitizeEcho(where ?? "", 40)}`;
                if (!streamTrail.push(line)) return;
                trailToolEvents += 1;
                if (!trailArmed && trailQuietArmAllowed && trailClaimCount >= 2) trailArmed = true;
                if (trailArmed) void paintTrail().catch(() => undefined);
              } catch {
                // Observational only.
              }
            })
          : null;
      // 999.171 - live thinking: sink + guarded paint + repaint ticker for THIS turn id.
      if (liveThinkingActive && streamTrail !== null && turn?.id) {
        const thinkingTurnId = turn.id;
        liveThinking = startLiveThinking({
          turnId: thinkingTurnId,
          trail: streamTrail,
          paintTrail,
          isArmed: () => trailArmed,
          // 999.178 R1 — thinking-arm: a tool-less draft that only thinks never
          // trips the quiet-TOOL arm. Arm on thinking alone, but only in the
          // mode where the quiet arm is allowed (auto): "always" is already
          // armed and "topic" is topic-prompts-only, so this honours the modes.
          armOnThinking: trailQuietArmAllowed ? () => { trailArmed = true; } : undefined,
          isDraftStarted: () => draftStarted,
          hasActivityBeyondThinking: () => toolCallsSeen > 0 || trailClaimCount > 0,
          // An in-flight creation counts: a paint that merely awaits another path's post did not make it.
          hasPaintedSurface: () =>
            separateStatus
              ? statusRef.current !== null || statusCreatePromise !== null
              : messageRef.current !== null || slotCreatePromise !== null,
          elapsedMs: () => Date.now() - trailStartedAt,
          intervalMs: streamingCfg?.editIntervalMs ?? 750,
          lastPaintAt: () => streamStatusLastEditAt,
          tickMs: this.liveThinkingTiming?.tickMs,
          firstPaintMinMs: this.liveThinkingTiming?.firstPaintMinMs,
          // MD-03 - the typing heartbeat's caps: a never-settling dispatch never reaches a stop site.
          softMaxLifetimeMs: TYPING_MAX_MS,
          maxLifetimeMs: TYPING_ABSOLUTE_MAX_MS,
          isTurnActive: () => this.sessionManager.hasActiveTurn(sessionName),
          onLifetimeCap: () =>
            this.log.warn(
              { agent: sessionName, channel: channelId, turnId: thinkingTurnId },
              "live-thinking repaint hard-capped — turn exceeded max duration (likely wedged)",
            ),
          onSummary: ({ frames, peakTokens }) =>
            this.log.debug({ agent: sessionName, turnId: thinkingTurnId, frames, peakTokens }, "thinking-tokens"),
        });
      }

      // Phase 119 A2A-03 — IN_FLIGHT (👍) transition. Only fires if this
      // message was previously QUEUED (rode the queue path); fast-path
      // messages get no icons. See queuedMessageIds field comment.
      // 999.178 R1 — a depth-1 queued message (in queuedAskIds) is still parked
      // in the SerialTurnQueue at this synchronous point (its dispatch has not
      // been admitted yet), so flipping it to IN_FLIGHT now would collapse the
      // cc_hourglass into a thumbs-up via the 200ms debounce. It stays QUEUED
      // until DELIVERED — QUEUED → DELIVERED is the honest minimum here.
      if (
        this.queuedMessageIds.has(message.id) &&
        !this.queuedAskIds.get(sessionName)?.has(message.id)
      ) {
        void this.transitionIcon(message, "IN_FLIGHT");
      }

      // Phase 140 Model B — v3 agents (claude-code-interactive) run in their own
      // process; the daemon owns the single Discord gateway and routes the
      // message over the ClawCode channel (push + awaitReply) instead of the v2
      // SDK dispatch.
      //
      // Phase 999.82 Plan 02 — block-level streaming. When this is the only
      // in-flight turn AND the agent has a masking webhook, register a
      // ProgressiveMessageEditor (webhook post-then-edit) as the bridge
      // progress callback. Mid-turn PostToolUse frames (Plan 01) drive
      // progressive edits; the final `awaitReply` result then FLUSHES into the
      // SAME message (dedup) instead of posting a second one. If no progress
      // arrived (tool-less turn) OR streaming was skipped (>1 pending), the
      // final falls through to the unchanged sendResponse path.
      v3Bridge = resolveV3ChatBridge(
        agentConfig?.llmRuntime?.backend,
        this.getBridge,
        sessionName,
      );
      // Phase 999.86 — pool path takes priority over the long-lived parent
      // path when wired. Both go through the same advisor-footer + dedup
      // block below, gated by `v3ChatHandled` so either path flows through
      // identically.
      const useWorkerPool =
        this.ephemeralChatDispatcher !== undefined &&
        agentConfig?.llmRuntime?.backend === "claude-code-interactive";
      let v3ChatHandled = false;
      // Phase 141 — pre-turn <memory-context> auto-injection for v3 chat. The
      // v2 path gets this via TurnDispatcher; v3 (pool OR persistent push)
      // bypasses it, so augment here so a v3 agent gets the same auto-retrieval
      // reflex. Cadence-gated + fail-open inside augment(); a no-op (returns the
      // message unchanged) when no augmenter is wired or this isn't a v3 chat.
      // Phase 999.154 WS-2 — this turn's images (its own + any burst members
      // or coalesced siblings merged under its id). The v2 SDK path gets them
      // as native image blocks + a numbered manifest; v3 runtimes (no image
      // plumbing) get the manifest with local paths only.
      const turnImageSources = message
        ? this.imageLedger.get(sessionName, message.id)
        : [];
      let turnText = formattedMessage;
      let turnImages: TurnImages | null = null;
      if (turnImageSources.length > 0) {
        if (useWorkerPool || v3Bridge) {
          turnText = `${formattedMessage}\n\n${pathOnlyManifest(turnImageSources)}`;
        } else {
          try {
            turnImages = await buildTurnImages(
              turnImageSources,
              resolveTurnVisionConfig(agentConfig?.vision).inline,
            );
          } catch (err) {
            // Never let image prep fail the turn — degrade to path hints.
            this.log.warn(
              { tag: "phase999.154-turn-vision", agent: sessionName, err: (err as Error).message },
              "turn image build failed — sending path manifest only",
            );
            turnImages = null;
          }
          turnText = turnImages
            ? `${formattedMessage}\n\n${turnImages.manifest}`
            : `${formattedMessage}\n\n${pathOnlyManifest(turnImageSources)}`;
          if (turnImages) this.log.info(
            {
              tag: "phase999.154-turn-vision",
              agent: sessionName,
              messageId: message?.id,
              ...turnImages.stats,
            },
            "turn images attached",
          );
          if (message && turnImages && turnImages.stats.total >= 2) {
            this.ingestProgress.setHeadline(
              message.channelId,
              message.id,
              describeTurnImages(turnImages.stats),
            );
          }
        }
      }
      const v3Message =
        this.memoryContextAugmenter && (useWorkerPool || v3Bridge)
          ? await this.memoryContextAugmenter.augment(sessionName, turnText)
          : turnText;
      // Phase 141 — "agent is active" is signalled by the Discord typing
      // indicator (fired at message arrival + refreshed every 8s during the
      // turn). The webhook editor streams the agent's prose + a humanized
      // tool-activity line ("🔍 Searching the web…"); the activity render STYLE
      // is chosen by the agent's per-agent `perf.streaming.activity` config
      // (natural | raw | off) at SPAWN (CLAWCODE_ACTIVITY_STYLE → progress hook),
      // so the daemon just streams whatever frame arrives — decoupled from the
      // /clawcode-verbose advisor flag (which still drives the advisor block below).
      // fleet-audit-2026-06-16 (H5) — v3 telemetry black hole. The SDK branch
      // below builds a TurnOrigin and threads it through TurnDispatcher, which
      // calls `turn.recordOrigin(origin)` → the trace row's `turn_origin`
      // column is populated. BOTH v3 branches (worker-pool + persistent push)
      // bypass TurnDispatcher entirely, so research's trace rows had a NULL
      // turn_origin — invisible to every origin/provenance analysis. Record the
      // origin here so v3 turns carry the same provenance as SDK turns. The
      // turnId MUST match the caller-created Turn's id
      // (`${DISCORD_SNOWFLAKE_PREFIX}${message.id}` — bridge.ts startTurn) so the
      // origin attaches to the right trace row. Wrapped in try/catch:
      // observational-only — a trace side-effect must NEVER break the message
      // path (mirrors the TurnDispatcher recordOrigin pattern + the Phase 50
      // invariant). Token/tool spans for v3 remain a separate gap (the PTY child
      // does not report tokens to the daemon) — see the H5 deferred note.
      if (turn && (useWorkerPool || v3Bridge) && message) {
        try {
          const v3TurnId = `${DISCORD_SNOWFLAKE_PREFIX}${message.id}`;
          turn.recordOrigin(
            makeRootOriginWithTurnId("discord", message.id, v3TurnId),
          );
        } catch {
          // Trace side-effect only — never disturb the message path.
        }
      }
      try {
        if (useWorkerPool && this.ephemeralChatDispatcher) {
          const correlationId = `discord-${message.id}`;
          // Pool dispatches are 1:1 (one worker per message), so no
          // single-in-flight gate is needed. Streaming attaches when the
          // agent has a masking webhook — the pool wires the worker's
          // bridge progress callback internally.
          const canStream =
            this.webhookManager?.hasWebhook(sessionName) === true;
          if (canStream && this.webhookManager) {
            v3EditFn = makeWebhookEditFn(this.webhookManager, sessionName);
            v3Editor = new ProgressiveMessageEditor({
              editFn: v3EditFn,
              editIntervalMs: streamingCfg?.editIntervalMs,
              maxLength: streamingCfg?.maxLength,
              turn,
              log: this.log,
              agent: sessionName,
              turnId: message.id,
            });
          }
          const editorRef = v3Editor;
          try {
            const { result } = await this.ephemeralChatDispatcher.dispatch({
              parent: sessionName,
              userMessage: v3Message,
              correlationId,
              // Phase 141 — stream whatever the progress hook rendered (prose +
              // humanized/raw/no activity per the agent's spawn-time style). Skip
              // empty frames.
              onProgress: editorRef
                ? (accumulated: string) => {
                    if (accumulated) {
                      stopDaemonTypingForV3Stream();
                      editorRef.update(accumulated);
                    }
                  }
                : undefined,
            });
            response = result;
            v3ChatHandled = true;
          } catch (err) {
            throw new Error(
              `v3 agent '${sessionName}' worker dispatch failed: ` +
                (err instanceof Error ? err.message : String(err)),
            );
          }
          await v3Editor?.flush();
        } else if (v3Bridge) {
          const correlationId = `discord-${message.id}`;
          // Decide streaming BEFORE awaitReply: skip if another turn is already
          // awaiting (single-in-flight correlation — SPEC §Risks), and only if
          // the agent actually has a masking webhook + the bridge exposes the
          // progress surface.
          const otherPending = v3Bridge.pendingReplyCount?.() ?? 0;
          const canStream =
            otherPending === 0 &&
            this.webhookManager?.hasWebhook(sessionName) === true &&
            typeof v3Bridge.registerProgressCallback === "function";
          if (canStream && this.webhookManager) {
            v3EditFn = makeWebhookEditFn(this.webhookManager, sessionName);
            v3Editor = new ProgressiveMessageEditor({
              editFn: v3EditFn,
              editIntervalMs: streamingCfg?.editIntervalMs,
              maxLength: streamingCfg?.maxLength,
              turn,
              log: this.log,
              agent: sessionName,
              turnId: message.id,
            });
            // onProgress fans accumulated text here; the editor throttles +
            // serializes (post-once-then-edit). Captured so the type narrows.
            const editorRef = v3Editor;
            // Phase 141 — stream whatever the progress hook rendered (prose +
            // humanized/raw/no activity per the agent's spawn-time style).
            v3Bridge.registerProgressCallback?.((acc: string) => {
              if (acc) {
                stopDaemonTypingForV3Stream();
                editorRef.update(acc);
              }
            });
          }

          v3Bridge.push({
            type: "a2a",
            message_id: correlationId,
            content: v3Message,
            meta: {
              reply_correlation_id: correlationId,
              source_agent: "discord",
              source_channel: channelId,
            },
          });
          try {
            // Wait the full turn-ceiling window (not the old 120s, which
            // rejected every real research turn before it could finish — a
            // long v3 turn only delivers on completion via the Stop-hook). See
            // V3_CHANNEL_REPLY_TIMEOUT_MS.
            const ack = await v3Bridge.awaitReply(
              correlationId,
              V3_CHANNEL_REPLY_TIMEOUT_MS,
            );
            response = ack.result ?? "";
            v3ChatHandled = true;
          } catch (err) {
            throw new Error(
              `v3 agent '${sessionName}' did not reply over the channel within timeout: ` +
                (err instanceof Error ? err.message : String(err)),
            );
          }
          // Drain any mid-turn frame still held in the editor's throttle window.
          // The FINAL dedup decision (which edits the SAME message with the
          // advisor-footer-included `response`) happens AFTER the footer
          // mutation below — mirroring the v2 editor flush → footer → final-edit
          // ordering, so the streamed message ends with the footer.
          await v3Editor?.flush();
        } else if (this.turnDispatcher) {
          // 999.156 — a follow-up turn replying to an EARLIER message gets its
          // own trace id (traces are INSERT OR REPLACE on id).
          const turnId =
            this.turnIdOverrides.get(message.id) ?? `${DISCORD_SNOWFLAKE_PREFIX}${message.id}`;
          const origin = makeRootOriginWithTurnId("discord", message.id, turnId);
          response = await this.turnDispatcher.dispatchStream(
            origin,
            sessionName,
            turnText,
            (accumulated) => editor!.update(stripActionsForStreaming(accumulated)),
            {
              turn,
              channelId,
              ...(turnImages && turnImages.images.length > 0
                ? { images: turnImages.images }
                : {}),
              // UX-C / 999.63d — defined only in hold or streamStatus
              // mode (undefined ⇒ legacy). Hold wins when both are on.
              ...(holdOnToolUse ?? streamStatusOnToolUse
                ? { onToolUse: holdOnToolUse ?? streamStatusOnToolUse }
                : {}),
            },
          );
          ({ text: response, actions: proposedActions } = parseActionsBlock(response));
        } else {
          // v1.7 fallback — preserves standalone runner (src/cli/commands/run.ts)
          response = await this.sessionManager.streamFromAgent(
            sessionName,
            turnText,
            (accumulated) => editor!.update(stripActionsForStreaming(accumulated)),
            turn,
            turnImages && turnImages.images.length > 0
              ? { images: turnImages.images }
              : undefined,
          );
          ({ text: response, actions: proposedActions } = parseActionsBlock(response));
        }
        // Phase 999.154 — delivered; drop the ledger entry. Failure paths
        // keep it so a retry or QUEUE_FULL coalesce still carries the images
        // (TTL eviction bounds anything left behind).
        if (message && turnImageSources.length > 0) {
          this.imageLedger.release(sessionName, message.id);
        }
      } finally {
        this.sessionManager.advisorEvents.off("advisor:invoked", onInvoked);
        this.sessionManager.advisorEvents.off("advisor:resulted", onResulted);
        try {
          unregisterClaimSink?.();
        } catch {
          // Observational only.
        }
        // Phase 999.82 Plan 02 — clear the progress sink the moment dispatch
        // ends (success OR awaitReply timeout). No more progress frames can
        // arrive after the turn resolves; clearing here guarantees the callback
        // never leaks into the next turn. The v3Editor itself is still used by
        // the dedup block below on the success path (clearing the bridge slot
        // does not dispose the editor).
        v3Bridge?.clearProgressCallback?.();
      }

      clearInterval(typingInterval);
      typingInterval = undefined;
      // v3 (Model B) never fed the editor (no streaming) → skip flush so it
      // doesn't post an empty message; the single result posts via sendResponse.
      if (!v3Bridge) await editor.flush();

      // 999.178 R1 — resolve `:cc_name:` icon shortcodes the AGENT wrote into
      // the registry's `<:cc_name:id>` tokens (unknown names strip cleanly;
      // fenced/inline code is untouched). Done ONCE here — before the v3 dedup
      // (which delivers `response` directly) and before `deliveryText` derives
      // from it. The held-corrected path re-runs it on `deliveryText`
      // (idempotent). Client-facing drafts have every icon STRIPPED at the
      // draft-extraction site below.
      if (response && response.trim().length > 0) {
        response = rewriteIconShortcodes(response, icons);
      }

      // Plan 117-09 — advisor visibility mutation (RESEARCH §4.5, §6 Pitfall 1,
      // §13.2, §13.4). SINGLE injection point — all three delivery exits below
      // (sendResponse-large, edit-small, sendResponse-no-typing-indicator) read
      // the same `response` local. Do NOT add a fallback mutation inside
      // sendResponse() or messageRef.current.edit(): that's the silent-path-
      // bifurcation anti-pattern flagged by `feedback_silent_path_bifurcation`
      // memory and §6 Pitfall 1. Mutate ONCE here.
      //
      // Standalone-runner branch (bridge.ts:turnDispatcher=undefined ->
      // streamFromAgent path) does NOT fire advisor events today (RESEARCH
      // §13.9 / §13.13 Pitfall 8); didConsultAdvisor stays false and no
      // footer is appended. Documented acceptable absence.
      if (didConsultAdvisor && response && response.trim().length > 0) {
        // Plan 117-11 attaches verboseState; for now default to "normal".
        const level: "normal" | "verbose" =
          this.verboseState?.getLevel(message.channelId) ?? "normal";
        // Snapshot `lastAdvisorResult` into a local — closure mutation from
        // `onResulted` isn't visible to TS control-flow narrowing (TS would
        // otherwise narrow to `null` here), so we read once through an
        // explicit cast to the declared union type.
        const result = lastAdvisorResult as
          | { kind: AdvisorResultedEvent["kind"]; text?: string; errorCode?: string }
          | null;
        const variant = result?.kind;
        if (variant === "advisor_tool_result_error") {
          const code = result?.errorCode ?? "unknown";
          advisorNote = `advisor unavailable (${code})`;
        } else if (
          level === "verbose" &&
          variant === "advisor_result" &&
          result?.text
        ) {
          // Plan 117-11 seam — verbose mode shows the (truncated) advisor
          // reply inline. advisor_redacted_result intentionally falls through
          // to the plain footer (no plaintext leak — RESEARCH §13.4).
          const adviceRaw = result.text;
          const advice =
            adviceRaw.length > 500 ? adviceRaw.slice(0, 500) + "…" : adviceRaw;
          response =
            response +
            // 999.178 R1 — plain text: a custom emoji cannot render inside a
            // code fence, so no `cc_thought` here (the reaction on the user
            // message carries the icon).
            "\n\n```\nadvisor consulted (Opus)\n" +
            advice +
            "\n```";
        } else {
          // includes: level === "normal" (any kind), level === "verbose" with
          // advisor_redacted_result (no plaintext), or kind === undefined
          // (invoked but never resulted — partial-failure: still show footer
          // because the 💭 reaction already landed).
          //
          // 999.151 — the fact now travels as DATA to the annotation composer
          // instead of being glued on here as italic prose. Gluing guaranteed
          // two footers in two typographic registers stacked under every
          // verified answer (operator screenshots, 2026-09-17); as a field it
          // merges into the single grey line, or becomes that line when there
          // is no verification to report. Still ONE mutation point.
          advisorNote = "advisor consulted (Opus)";
        }
      }

      // 2026-07-31 — mid-turn steering visibility footer (999.100
      // indicator). Consumed single-shot and keyed to THIS dispatch's
      // message.id, so a steer armed for a different (earlier/later) turn
      // can never annotate this reply. Same single-mutation-point
      // discipline as the advisor footer above: runs AFTER it
      // (composition: advisor line first, steered line last) and BEFORE
      // the v3 dedup below, so the streamed message edits to the
      // footer-included response. Do NOT add fallback mutations inside
      // sendResponse()/edit(). Consume runs unconditionally (outside the
      // response-empty check) so an empty-response turn still clears the
      // entry. No verbose variant — the steer content is the user's own
      // visible message; there is nothing hidden to reveal.
      const steered = this.consumeSteeredIntoFlight(sessionName, message.id);
      if (steered && response && response.trim().length > 0) {
        response =
          response +
          (steered.count > 1
            ? `\n\n*— steered mid-turn: incorporated your ${steered.count} follow-ups*`
            : "\n\n*— steered mid-turn: incorporated your follow-up*");
      }

      // Phase 999.124 — memory-recall visibility footer. The turn dispatcher
      // records what its pre-turn retrieval put in front of the model
      // (single-shot per session, TTL-guarded); consumed HERE, at the same
      // mutation point, so every delivery exit carries it. Composition:
      // advisor, steered, recalled. Consume runs unconditionally so a turn
      // that produced no text still clears the entry. The `typeof` guard
      // keeps older dispatcher stubs (tests, standalone runner) working.
      const recalled =
        typeof this.turnDispatcher?.consumeRecallFooter === "function"
          ? this.turnDispatcher.consumeRecallFooter(sessionName)
          : undefined;
      // Phase 999.133 — by default the recall rides the 🧾 Sources button and
      // its card (recorded with the turn ledger below; no footer text).
      // `memoryRecallDisplay: footer` keeps the italic line + verbose block.
      const recallDisplay = this.recallDisplayFor(sessionName);
      const recalledForLedger = recalled && recallDisplay === "button" ? recalled : undefined;
      if (recalled && recallDisplay === "footer" && response && response.trim().length > 0) {
        const recallLevel: "normal" | "verbose" =
          this.verboseState?.getLevel(message.channelId) ?? "normal";
        response = response + renderRecallFooter(recalled, recallLevel);
      }

      // 999.151 — who renders the advisor fact. The annotation composer owns
      // it whenever it runs (it merges the fact into the single grey footer
      // row); this site covers the deliveries the composer never sees — v3
      // edit-in-place (which delivers BELOW, before the composer exists), no
      // turn dispatcher, or `sourcesFooter: off`. ONE renderer
      // (`appendAdvisorSubtext`) either way, and `advisorNote` is cleared on
      // use so no delivery can carry the row twice.
      const advisorFooterCfg = holdFvCfg?.ux;
      const annotationsOwnAdvisor =
        this.turnDispatcher !== undefined &&
        advisorFooterCfg?.sourcesFooter !== undefined &&
        advisorFooterCfg.sourcesFooter !== "off";
      if (
        advisorNote.length > 0 &&
        !annotationsOwnAdvisor &&
        response &&
        response.trim().length > 0
      ) {
        response = appendAdvisorSubtext(response, advisorNote);
        advisorNote = "";
      }

      // Phase 999.82 Plan 02 — v3 SINGLE-BRANCH final-vs-progress DEDUP.
      // Runs AFTER the advisor-footer mutation so the streamed message edits to
      // the footer-included `response` (mirrors the v2 flush→footer→edit order).
      // The final text is delivered by EXACTLY one of {webhook edit-in-place
      // (+optional tail), sendResponse} — `decideV3Delivery` is the pure,
      // unit-pinned decision and `v3DeliveryHandled` gates the downstream
      // sendResponse block so the two paths can never both fire
      // (`feedback_silent_path_bifurcation`).
      //
      // Phase 999.86 — `v3ChatHandled` covers BOTH the long-lived parent
      // dispatch (v3Bridge.push + awaitReply) AND the warm worker pool
      // dispatch — either way the v3Editor may have posted a streamed
      // placeholder that the final must edit-in-place rather than dup.
      if (v3ChatHandled && response && response.trim().length > 0) {
        const editorPosted = v3EditFn?.posted() === true;
        const decision = decideV3Delivery({
          editorPosted,
          response,
          maxLength: streamingCfg?.maxLength ?? 2000,
        });
        if (decision.kind === "flush-editor" && v3EditFn) {
          // Single deliberate edit-in-place of the streamed message (NOT the
          // throttled editor.update path) — the footer-included final.
          await v3EditFn(response);
          v3DeliveryHandled = true;
        } else if (decision.kind === "flush-and-tail" && v3EditFn) {
          await v3EditFn(decision.head);
          // The tail (chars maxLength+) rides the existing chunking path — ONE
          // logical delivery split across the edited message + tail chunks.
          await this.sendResponse(message, decision.tail, sessionName);
          v3DeliveryHandled = true;
        }
        // decision.kind === "send-only" → v3DeliveryHandled stays false; the
        // whole final flows through the unchanged sendResponse block below.
      }

      // `delivered` tracks whether the final text reached Discord by EITHER
      // path so the shared post-delivery cleanup (success log + DELIVERED ✅
      // transition + queuedMessageIds drain) runs exactly once regardless of
      // which path delivered. Phase 999.82 Plan 02: a v3 streamed turn delivers
      // via the editor (v3DeliveryHandled) — without this, the queue-path icon
      // would stay stuck at IN_FLIGHT 👍 and the empty-response warn would fire
      // spuriously since `messageRef.current` is null on the v3 path.
      // C — pre-delivery verification hold. Runs BEFORE anything lands:
      // clean drafts pass through instantly; flagged drafts hold (bounded
      // by holdTimeoutMs) for the patch hop and deliver the corrected
      // text as the FIRST public content. Fail-open: any throw delivers
      // the original (the dispatcher/runner never throws by contract —
      // this catch is belt-and-braces).
      let deliveryText = response;
      let holdFollowUpPost: string | null = null;
      let holdVerdict: "clean" | "corrected" | "timeout" | "error" | null =
        null;
      if (
        holdDeliveryActive &&
        this.turnDispatcher &&
        !v3DeliveryHandled &&
        response &&
        response.trim().length > 0
      ) {
        try {
          const held = await this.turnDispatcher.preDeliveryVerify({
            agentName: sessionName,
            channelId,
            response,
            turn,
          });
          deliveryText = held.finalText;
          // 999.178 R1 — the follow-up correction post is agent-authored;
          // resolve its shortcodes (idempotent on the runner-side rewrite).
          holdFollowUpPost = held.followUpPost
            ? rewriteIconShortcodes(held.followUpPost, icons)
            : null;
          holdVerdict = held.verdict;
        } catch (err) {
          this.log.warn(
            { agent: sessionName, error: (err as Error).message },
            "preDeliveryVerify threw — delivering original (fail-open)",
          );
          deliveryText = response;
        }
      }

      // 999.178 R1 — the held path can swap in freshly corrected model text;
      // resolve its shortcodes too (idempotent on the already-rewritten
      // `response`, so the non-held path is a no-op).
      if (deliveryText && deliveryText.trim().length > 0) {
        deliveryText = rewriteIconShortcodes(deliveryText, icons);
      }

      // 2026-08-27 verification v2 — delivery annotations. The Sources line
      // is built from the EVIDENCE ledger (what tools returned), the verdict
      // from the CLAIM ledger + citation integrity; the model's own Sources
      // block was already stripped/flagged in the dispatcher when configured.
      // 2026-08-28 — client-facing drafts leave the reply here and are posted
      // as their own messages after delivery (copy-paste clean). Before the
      // annotations so no Sources/verdict line can land inside a draft, and
      // before table planning so a draft's text is never re-rendered.
      let pendingDrafts: readonly string[] = [];
      let bridgeCitedHosts: readonly string[] = [];
      if (!v3DeliveryHandled && deliveryText.includes("```")) {
        const ex = extractDrafts(deliveryText);
        if (ex.drafts.length > 0) {
          // 999.178 R1 — client-facing drafts are pasted into texts and
          // emails: strip every icon token (shortcode and formed alike).
          pendingDrafts = ex.drafts.map(stripIconShortcodes);
          // A reply that was ONLY a draft still needs an answer message; keep
          // a one-line lead so the analysis slot isn't empty.
          deliveryText = ex.text.trim().length > 0 ? ex.text : DRAFT_ONLY_BODY;
        }
      }
      // 2026-08-28 — the model's own `Sources:` block, wherever it sits. The
      // dispatcher strips it too, but a block written ABOVE a draft fence was
      // not trailing at that point and survived into the answer, so the
      // reader got two Sources blocks (the model's, with unfurling links, and
      // ours). Hosts it named still feed the cited-but-unopened check.
      if (!v3DeliveryHandled && (holdFvCfg?.ux?.modelSourcesLine ?? "keep") !== "keep") {
        const r = stripModelSourcesBlock(deliveryText);
        if (r.citedHosts.length > 0 || r.text !== deliveryText) {
          deliveryText = r.text;
          bridgeCitedHosts = r.citedHosts;
        }
      }
      // 2026-08-28 — reply-shape telemetry (measure, don't nag): the model's
      // raw text, before the bridge strips/annotates it. Pure + non-fatal.
      if (!v3DeliveryHandled && typeof response === "string" && response.trim().length > 0) {
        try {
          this.log.info({ tag: "phase999.63-shape", agent: sessionName, ...measureShape(response) }, "reply shape");
        } catch {
        }
      }
      const uxCfg = holdFvCfg?.ux;
      let verdictReaction: VerdictReaction | null = null;
      let uxTier: "none" | "compact" | "full" | "client-facing" = "none";
      let ledgerSnapshot: ReturnType<TurnDispatcher["getLedgerSnapshot"]> | null = null;
      let annotationFooter = "";
      let clientFacingTurn = false;
      // 2026-08-28 — sources shared by the footer line and the 🧾 button; the
      // merged verification line lives in the answer (status message deleted).
      let sourceItems: readonly SourceItem[] = [];
      let verificationLineInAnswer = false;
      if (
        !v3DeliveryHandled &&
        deliveryText.trim().length > 0 &&
        this.turnDispatcher &&
        uxCfg?.sourcesFooter !== undefined &&
        uxCfg.sourcesFooter !== "off"
      ) {
        try {
          ledgerSnapshot = this.turnDispatcher.getLedgerSnapshot(sessionName);
          const counted = ledgerSnapshot.claims.filter((c) => c.effectiveVerdict !== "not-a-claim");
          clientFacingTurn = ledgerSnapshot.claims.some((c) => c.audience === "client");
          const tier = decideTier({
            responseChars: deliveryText.length,
            claimCount: counted.length,
            evidenceCount: ledgerSnapshot.evidence.length,
            clientFacing: clientFacingTurn,
            compactBelowChars: uxCfg.compactBelowChars,
          });
          uxTier = uxCfg.sourcesFooter === "always" && tier === "none" ? "compact" : tier;
          const extracted = extractCitations(deliveryText);
          const citedHosts = [...new Set([...extracted.hosts, ...ledgerSnapshot.modelCitedHosts, ...bridgeCitedHosts])];
          const recon = reconcileCitations({ urls: extracted.urls, hosts: citedHosts }, ledgerSnapshot.evidence);
          const marks = decideVerdictMarks({
            claims: ledgerSnapshot.claims,
            unmatchedHosts: recon.unmatchedHosts,
            correctionsApplied: holdVerdict === "corrected" ? 1 : 0,
            holdTimedOut: holdVerdict === "timeout",
            evidenceCount: ledgerSnapshot.evidence.length,
          });
          const linesOn = uxCfg.unverifiedNotice !== false;
          const allVerified = counted.length > 0 && marks.reaction === "✅";
          sourceItems = selectSources(ledgerSnapshot.evidence, ledgerSnapshot.claims, citedHosts);
          const verifiedCount = counted.filter(
            (c) => c.effectiveVerdict === "verified" || c.effectiveVerdict === "corrected",
          ).length;
          const composed = composeDeliveryAnnotations({
            response: deliveryText,
            tier: uxTier,
            sources: sourceItems,
            marks: linesOn ? marks : { reaction: marks.reaction, lines: [], note: "" },
            // 2026-08-28 — one merged footer line replaces the Sources line and
            // the separate status message's settle line (operator decision).
            verification: {
              counted: counted.length,
              verified: verifiedCount,
              steps: toolCallsSeen,
              secs: Math.max(1, Math.round((Date.now() - trailStartedAt) / 1000)),
              clientFacing: uxTier === "client-facing" && allVerified,
            },
            ...(advisorNote ? { advisor: advisorNote } : {}),
            ...(uxCfg.sourcesCharBudget !== undefined ? { sourcesCharBudget: uxCfg.sourcesCharBudget } : {}),
          });
          // The composer owns the advisor line from here — clear it so the
          // fallback below cannot append a second one.
          if (composed.footer !== "omitted-oversize") advisorNote = "";
          // The annotation TEXT (was the kind string — corrections could never carry it).
          annotationFooter = composed.deliveryText.slice(deliveryText.length);
          verificationLineInAnswer = composed.footer === "appended" || composed.footer === "compact";
          deliveryText = composed.deliveryText;
          // 2026-08-27 — reactions are for EXCEPTIONS only. A ✅ on every
          // sourced answer is noise ("not every message needs a green
          // checkmark — knowing sources have been cited is enough"): the
          // Sources line already says the answer is backed. So ✏️ (something
          // was corrected) and ⚠️ (something needs a second look) still get a
          // reaction; a clean verified turn gets none.
          verdictReaction =
            uxCfg.verdictReactions === true && marks.reaction !== "✅" ? marks.reaction : null;
          this.log.info(
            {
              tag: "phase999.63-delivery",
              agent: sessionName,
              uxTier,
              footer: composed.footer,
              footerChars: composed.footerChars,
              verdictReaction,
              claims: counted.length,
              evidence: ledgerSnapshot.evidence.length,
              unmatchedHosts: recon.unmatchedHosts,
              clientFacing: clientFacingTurn,
            },
            "verification delivery annotations",
          );
        } catch (err) {
          this.log.warn(
            { agent: sessionName, error: err instanceof Error ? err.message : String(err) },
            "delivery annotations failed — delivering unannotated (fail-open)",
          );
        }
      }
      // The composer was expected to carry the advisor fact but could not
      // (it threw, or the footer did not fit). Same renderer, still once.
      if (advisorNote.length > 0 && !v3DeliveryHandled && deliveryText.trim().length > 0) {
        deliveryText = appendAdvisorSubtext(deliveryText, advisorNote);
        advisorNote = "";
      }
      const recordLedger = (messageIds: readonly string[]): void => {
        // Phase 999.133 — a recall alone is worth a record: it is what the
        // 🧾 button opens on agents that run no verification.
        if (!ledgerSnapshot && !recalledForLedger) return;
        try {
          this.ledgerStore.record({
            turnId: turn?.id ?? `${DISCORD_SNOWFLAKE_PREFIX}${message.id}`,
            agent: sessionName,
            channelId,
            promptExcerpt: formattedMessage.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 70),
            evidence: ledgerSnapshot?.evidence ?? [],
            claims: ledgerSnapshot?.claims ?? [],
            deliveredAt: Date.now(),
            messageIds,
            clientFacing: clientFacingTurn,
            ...(recalledForLedger ? { recall: recalledForLedger } : {}),
          });
        } catch {
          // Observational only.
        }
      };
      // 2026-08-27 — final-delivery formatting for the bot edit-in-place
      // exit. Until today exit C edited the RAW draft into the placeholder:
      // the streamed preview showed rendered tables, then the final edit put
      // the literal pipes back. Plan once here (tables → list/grid/cards or
      // PNG cards + placeholder); the >2000 branch hands the RAW text to the
      // delivery queue, whose deliverFn plans on its own leg.
      // The narration already shown as status items is not part of the
      // answer. EXACT-PREFIX only: `deliveryText` is the dispatcher's final
      // string, NOT the editor's accumulated buffer, and the two can differ
      // (model-Sources stripping, em-dash rewriting). Slicing by a character
      // COUNT across those two strings cut an answer mid-word — it shipped as
      // "…ame growth list as before" (operator, 16:50). A mismatch now leaves
      // the text ALONE: duplicated narration is a blemish, a truncated answer
      // is a defect.
      if (separateStatus) {
        const stripped = stripDivertedNarration(deliveryText, divertedNarrationToStrip());
        if (stripped.length > 0) deliveryText = stripped;
      }
      const rawDeliveryText = deliveryText;
      let deliveryFiles: readonly OutboundFile[] = [];
      if (!v3DeliveryHandled && deliveryText.trim().length > 0) {
        const plan = await planOutboundTables(deliveryText, { log: this.log });
        deliveryText = plan.text;
        deliveryFiles = plan.files;
      }
      // LO-02 - a slot post still in flight would land after the checks below, orphaned.
      const pendingSlot = slotCreatePromise as Promise<void> | null;
      if (pendingSlot) await pendingSlot.catch(() => undefined);
      let delivered = v3DeliveryHandled;
      if (!v3DeliveryHandled && deliveryText && deliveryText.trim().length > 0) {
        if (deliveryText.length > 2000) {
          if (messageRef.current) {
            try { await messageRef.current.delete(); } catch (err) { this.log.debug({ error: (err as Error).message }, "failed to delete typing indicator message"); }
          }
          recordLedger([]);
          await this.sendResponse(message, rawDeliveryText, sessionName);
        } else if (messageRef.current) {
          // 2026-08-27 — narration-as-trail turns can reach delivery with
          // draftStarted still false (every chunk was a fragment). Claim
          // the slot now so a late status/trail paint cannot overwrite
          // the answer; the trail writers all check this flag.
          draftStarted = true;
          liveThinking?.stop();
          if (trailQuietTimer) {
            clearTimeout(trailQuietTimer);
            trailQuietTimer = undefined;
          }
          // 2026-08-28 — the PNG cards ride THIS message: no "table below" marker.
          if (deliveryFiles.length > 0) deliveryText = stripTablePlaceholders(deliveryText);
          const editFiles =
            deliveryFiles.length > 0
              ? {
                  files: deliveryFiles.map((f) => ({
                    attachment: f.attachment,
                    name: f.name,
                    ...(f.description ? { description: f.description } : {}),
                  })),
                }
              : {};
          // 2026-08-28 — a button reading "0 claims" looks broken. It appears only
          // when at least one claim was recorded; a sources-only turn keeps the
          // Sources line, and the 🧾 reaction still opens the card.
          const nClaims = ledgerSnapshot
            ? ledgerSnapshot.claims.filter((c) => c.effectiveVerdict !== "not-a-claim").length
            : 0;
          // 2026-08-28 — the button counts SOURCES (never "0 claims") and only
          // appears on substantial replies: 2+ sources or any recorded claim.
          const nSources = sourceItems.length;
          const verificationButtonOn =
            uxCfg?.ledgerButton === true &&
            ledgerSnapshot !== null &&
            (nSources >= 2 || nClaims >= 1) &&
            (uxTier === "full" || uxTier === "client-facing");
          // Phase 999.133 — recalled memory alone earns the button (🧠 N).
          const ledgerButtonOn = verificationButtonOn || recalledForLedger !== undefined;
          const ledgerRow = ledgerButtonOn
            ? this.ledgerButtonRow(
                messageRef.current.id,
                sourcesButtonLabel(verificationButtonOn ? nSources : 0, recalledForLedger),
              )
            : undefined;
          // Phase 999.160 — reply actions. Relevance-gated: most replies get no
          // row at all (see reply-actions.ts for every trigger). The row sits
          // beside the 🧾 ledger row and is removed on click or after the TTL.
          const replyActions = this.replyActionsFor(sessionName, deliveryText, nSources, message, proposedActions);
          const actionRow = replyActions.length > 0 ? buildReplyActionRow(messageRef.current.id, replyActions) : undefined;
          const rows = [ledgerRow, actionRow].filter((r) => r !== undefined);
          const withRows = rows.length > 0 ? { components: rows as never } : {};
          if (ledgerButtonOn || actionRow !== undefined) {
            try {
              await messageRef.current.edit({ content: deliveryText, ...withRows, ...editFiles, ...deliveryFlags() });
            } catch {
              await messageRef.current.edit({ content: deliveryText, ...editFiles, ...deliveryFlags() });
            }
          } else if (deliveryFiles.length > 0) {
            try {
              await messageRef.current.edit({ content: deliveryText, ...editFiles, ...deliveryFlags() });
            } catch (err) {
              this.log.warn(
                { agent: sessionName, error: err instanceof Error ? err.message : String(err) },
                "edit with table images failed — delivering text only",
              );
              await messageRef.current.edit({ content: deliveryText, ...deliveryFlags() });
            }
          } else {
            await messageRef.current.edit({ content: deliveryText, ...deliveryFlags() });
          }
          // 999.160 v1.3 — remember the reply so a typed "shorter" can replace it in place.
          this.lastReplies.record({ channelId, messageId: messageRef.current.id, agentName: sessionName, userId: message.author.id, text: deliveryText });
          if (actionRow !== undefined) {
            this.registerReplyActions(messageRef.current, message, sessionName, channelId, replyActions, ledgerRow ? [ledgerRow] : [], deliveryText);
          }
          recordLedger([messageRef.current.id]);
          // 999.63c — remember the delivered message so a financial-
          // verification correction can edit it in place. ONLY this exit
          // records: it is the only one whose message id survives delivery
          // (bot identity, single message). Deliberate semantic note: the
          // conversation store (captureDiscordExchange below) keeps the
          // ORIGINAL text as the audit record, and the corrective hop's
          // own exchange lands in the agent's session history — so after
          // an in-place edit, Discord shows the corrected text while the
          // store preserves what was first said. That drift is accepted by
          // operator decision (2026-08-26).
          // Phase 999.172 — this reply (single message, bot identity) is where a
          // prompt suggestion for this turn may land. Registered under the same
          // turn id the handle keys the suggestion by; only this exit records,
          // so chunked (>2000), v3 and sendResponse-fallback replies never get one.
          this.registerSuggestionTarget({
            turnId: turn?.id ?? `${DISCORD_SNOWFLAKE_PREFIX}${message.id}`,
            delivered: messageRef.current,
            original: message,
            agentName: sessionName,
            channelId,
            shownActions: replyActions,
            ledgerRow,
            replyText: deliveryText,
          });
          this.deliveredRefs.record({
            kind: "bot",
            messageId: messageRef.current.id,
            channelId,
            agentName: sessionName,
            turnId: turn?.id ?? `${DISCORD_SNOWFLAKE_PREFIX}${message.id}`,
            deliveredText: deliveryText,
            // 2026-08-27 sweep — what a correction needs to edit in place.
            bodyText: rawDeliveryText,
            annotations: annotationFooter,
            hasImages: deliveryFiles.length > 0,
            at: Date.now(),
          });
          // UX-C (2026-08-26) — glanceable trust badge: a hold-mode turn
          // that was verified (clean or corrected pre-delivery) gets ✅
          // on the delivered message. Chunked deliveries (>2000) skip
          // silently — no message ref survives there. Fail-open.
          if (uxCfg?.verdictReactions === true) {
            // 2026-08-27 — one verdict reaction (verified / corrected /
            // unverified) replaces the hold-only badge; precedence decided in
            // decideVerdictMarks. 999.178 R1 — the VerdictReaction TOKEN
            // ("✅" / "✏️" / "⚠️") stays as the logic value; it is mapped to a
            // `cc_*` reaction HERE, at the single point the bot reacts.
            if (verdictReaction) {
              const verdictIcon: IconName =
                verdictReaction === "✏️"
                  ? "pencil"
                  : verdictReaction === "⚠️"
                    ? "warning"
                    : "circle_check";
              const r = icons.reaction(verdictIcon);
              if (r) {
                try {
                  await messageRef.current.react(r);
                } catch {
                  // Observational only.
                }
              }
            }
          } else if (holdVerdict === "clean" || holdVerdict === "corrected") {
            const r = icons.reaction("circle_check");
            if (r) {
              try {
                await messageRef.current.react(r);
              } catch (reactErr) {
                this.log.debug(
                  {
                    agent: sessionName,
                    error:
                      reactErr instanceof Error
                        ? reactErr.message
                        : String(reactErr),
                  },
                  "hold-mode circle_check badge failed (non-fatal)",
                );
              }
            }
          }
        } else {
          // Phase 999.133 — record BEFORE the chunked send so the chunk-ref
          // hook can link the ids and attach the 🧾 button as a follow-up.
          recordLedger([]);
          await this.sendResponse(message, deliveryText, sessionName);
        }
        delivered = true;
        // C — a correction that could not be patched into the delivered
        // text posts as a compact note AFTER the delivery (ordered — never
        // before the answer it corrects). Fire-and-forget, fail-open.
        if (holdFollowUpPost) {
          void this.postFinancialCorrection({
            channelId,
            text: holdFollowUpPost,
          });
        }
      } else if (
        (holdDeliveryActive || streamStatusActive) &&
        !delivered &&
        messageRef.current
      ) {
        // C / 999.63d — an empty final response would orphan the
        // placeholder / status-trail message; remove it.
        try {
          await messageRef.current.delete();
        } catch (err) {
          this.log.debug(
            { error: (err as Error).message },
            "failed to delete hold placeholder message",
          );
        }
      }

      // 2026-08-28 — drafts go out AFTER the analysis, one message each, plain
      // text only (no fence, no header, no annotations), through the delivery
      // queue so they carry the agent identity and retry like any reply.
      if (delivered && pendingDrafts.length > 0) {
        let draftPieces = 0;
        for (const draft of pendingDrafts) {
          // 999.178 R1 — a draft over the Discord limit is split into clean
          // copy-paste pieces (paragraph → sentence → hard) rather than cut at
          // 2000 chars. Each piece ≤2000; sendResponse's own splitter is the
          // safety net if formatting grows one. One draft can now be several
          // consecutive messages.
          for (const piece of splitDraftForDelivery(draft)) {
            draftPieces++;
            try {
              await this.sendResponse(message, piece, sessionName);
            } catch (err) {
              this.log.warn(
                { agent: sessionName, error: err instanceof Error ? err.message : String(err) },
                "draft message delivery failed (non-fatal)",
              );
            }
          }
        }
        this.log.info({ tag: "phase999.63-draft", agent: sessionName, drafts: pendingDrafts.length, pieces: draftPieces }, "drafts posted as separate messages");
      }
      // Settle the separate status message for EVERY exit (including the
      // >2000 branch, which deletes the answer placeholder but leaves the
      // status message standing) and for the empty-response path.
      await settleStatus({ deliveredOk: delivered, footerInAnswer: delivered && verificationLineInAnswer });

      if (delivered) {
        this.log.info(
          {
            agent: sessionName,
            channel: channelId,
            responseLength: response.length,
            // 2026-07-31 — additive delivery-side grep target for the
            // steered-reply indicator runbook.
            ...(steered ? { steeredCount: steered.count } : {}),
          },
          "agent response sent to Discord",
        );
        // Phase 119 A2A-03 — DELIVERED (✅) transition. Only fires if this
        // message rode the queue path (was previously QUEUED → IN_FLIGHT).
        // Cleans up the set membership to bound memory. Runs for the v3
        // streamed path too (delivered via the editor) — Phase 999.82 Plan 02.
        if (this.queuedMessageIds.has(message.id)) {
          void this.transitionIcon(message, "DELIVERED");
          this.queuedMessageIds.delete(message.id);
          // 999.178 R1 — a queued ask (depth-1 slot) was answered: drop it from
          // the count and the durable store so a later restart won't re-drain it.
          this.clearQueuedAsk(sessionName, message.id);
        }
      } else if (!messageRef.current) {
        this.log.warn({ agent: sessionName, channel: channelId }, "agent returned empty response");
        // 999.178 R1 — a queued ask that produced no answer is terminal: resolve
        // its hourglass and leave the count + store (don't re-drain on restart).
        this.terminalizeQueuedAsk(message, sessionName, "FAILED");
        // 999.178 R1 — the dead "react 🔍 to retry" status text is removed (see
        // settleStatus), but a ❌ + Retry button on a no-answer turn is DEFERRED
        // on purpose: `delivered === false` also covers turns that delivered
        // through a tool and ended with empty text (a post_cv2_embed card, a
        // SendUserFile, a spawned subagent, or a HELD financial turn that ran
        // finnhub/DB/market-data before returning no prose). There is no
        // reliable, mode-independent "no tool ran" signal at this call site —
        // `toolCallsSeen` only increments under the stream-status trail, not in
        // hold or plain mode — so a Retry here could re-run a mutating turn.
        // The three THROWN failure modes (wedge, crash, generic) keep their
        // Retry buttons; the no-answer button waits on a turn-level tool-use
        // count threaded from the SDK result / trace collector.
      }

      // Phase 50: end Turn on success after all post-processing completes
      try { turn?.end("success"); } catch { /* non-fatal */ }

      // Phase 65: fire-and-forget conversation capture (SEC-02 instruction detection runs inside)
      try {
        const convStore = this.sessionManager.getConversationStore(sessionName);
        const activeSessionId = this.sessionManager.getActiveConversationSessionId(sessionName);
        if (convStore && activeSessionId) {
          captureDiscordExchange({
            convStore,
            sessionId: activeSessionId,
            userContent: formattedMessage,
            assistantContent: response,
            channelId,
            discordUserId: message.author.id,
            discordMessageId: message.id,
            // Phase 68.1 — SEC-01/CONV-01: by construction, this code path
            // runs only after `checkChannelAccess` (line 441) allowed the
            // message. The early-return at line 447 drops untrusted-channel
            // messages before they ever reach routing, so every captured
            // exchange here originates from an ACL-allowed (trusted) channel.
            isTrustedChannel: true,
            log: this.log,
            // Phase 116-03 F27 — fire the dashboard SSE hook with the
            // resolved agent (sessionName), metadata only.
            agentName: sessionName,
            onTurnRecorded: this.onConversationTurn,
          });
        }
      } catch (err) {
        this.log.warn(
          { agent: sessionName, error: (err as Error).message },
          "conversation capture failed (non-fatal)",
        );
      }

      // Phase 999.100 — success tail: clear this dispatch's trigger record
      // and consume any expected-stop marker (a stop intent whose interrupt
      // raced a natural completion resolves here, not in the catch).
      this.removeInFlightTrigger(sessionName, message.id);
      this.consumeExpectedInterrupt(sessionName);
    } catch (error) {
      if (typingInterval) clearInterval(typingInterval);
      if (editor) editor.dispose();
      // Phase 999.82 Plan 02 — dispose the v3 streaming editor on the error
      // path so a pending throttle timer never fires after the turn failed.
      // (The progress-callback slot is already cleared in the inner finally.)
      if (v3Editor) v3Editor.dispose();

      // Phase 50: end Turn on error before the reaction attempt so the trace
      // records the failure status even if the reaction call itself throws.
      try { turn?.end("error"); } catch { /* non-fatal */ }

      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(
        { agent: sessionName, channel: channelId, error: errorMsg },
        "failed to route message",
      );

      // Phase 999.100 — clear this dispatch's trigger record on the error
      // path, and detect an EXPECTED abort (mid-turn stop intent). An
      // expected stop suppresses the wedge/crash-retry/❌ UX below — the
      // stop message already carries its 🛑 ack — but still falls through
      // to the coalescer drain so messages buffered behind the stopped
      // turn dispatch normally.
      this.removeInFlightTrigger(sessionName, message.id);
      // 2026-07-31 — drop any steered-reply marker armed for THIS dispatch.
      // Every failure exit (expected stop, wedge auto-rerun, crash retry,
      // QUEUE_FULL, terminal ❌) flows through here BEFORE any recursion,
      // so a rerun's delivery can never claim it absorbed the steer (the
      // rerun re-sends the ORIGINAL message; the injected text does not
      // ride it). Fail-quiet: the 🧭 on the steering message remains the
      // durable record.
      this.clearSteeredIntoFlight(sessionName, message.id);
      const expectedStop = this.consumeExpectedInterrupt(sessionName);
      if (expectedStop) {
        this.log.info(
          { agent: sessionName, channel: channelId, error: errorMsg },
          "turn aborted by mid-turn stop intent — suppressing error UX (expected)",
        );
        this.queuedMessageIds.delete(message.id);
        // 999.178 R1 — a stopped queued ask must leave the count + store, or it
        // lingers as "1 queued" and re-drains (re-answers a stopped turn) next boot.
        this.terminalizeQueuedAsk(message, sessionName, "FAILED");
      }

      // Debug session `in-tool-wedge-recovery` work-stream (B) — smart
      // in-tool-wedge recovery. The SDK handle attaches a `wedgeInfo`
      // object to the thrown AbortError when a turn wedged inside a tool
      // (Phase 127 ceiling abort) OR was force-released by the 999.64
      // heartbeat sweep. The user's request is half-finished:
      //   - READ-ONLY in-flight tool (or pure-text hang, no tool) → the
      //     request is idempotent → AUTO RE-RUN it (FORK 7: capped at one
      //     wedge re-run, and bounded by the shared crash-recovery budget).
      //   - MUTATING / unknown in-flight tool → re-running could repeat a
      //     side effect → post a "please resend" NOTICE instead, never
      //     silently re-run.
      // Checked BEFORE the crash-recovery branch — a wedge is a distinct
      // failure mode with its own budget. A non-wedge error has no
      // `wedgeInfo` and falls straight through.
      const wedgeInfo = (error as { wedgeInfo?: WedgeInfo } | null)?.wedgeInfo;
      // Phase 999.100 — `&& !expectedStop`: a deliberate mid-turn stop can
      // surface with wedge metadata attached (interrupt during a tool call);
      // it must not trigger auto-rerun or a "please resend" notice.
      if (wedgeInfo && !expectedStop) {
        // Fetch the SDK's per-MCP-tool annotations ONCE for this wedge —
        // not per turn, not per classification (FORK 6). Best-effort: an
        // empty result degrades the classifier to its static allowlist.
        let mcpSnapshot:
          | Awaited<
              ReturnType<SessionManager["getMcpToolAnnotationsForAgent"]>
            >
          | undefined;
        try {
          mcpSnapshot =
            await this.sessionManager.getMcpToolAnnotationsForAgent(
              sessionName,
            );
        } catch {
          mcpSnapshot = undefined;
        }
        const action = decideWedgeRecovery(wedgeInfo, mcpSnapshot);
        // FORK 7 — the wedge re-run is single-shot AND bounded by the
        // shared crash-recovery budget so crash/wedge alternation cannot
        // loop. Auto-rerun only when the action permits AND both budgets
        // have headroom; otherwise fall through to NOTIFY.
        const canAutoRerun =
          action === "auto-rerun" &&
          wedgeRetryCount < 1 &&
          retryCount < 2;
        this.log.warn(
          {
            agent: sessionName,
            channel: channelId,
            wedgeReason: wedgeInfo.reason,
            inFlightTools: wedgeInfo.inFlightToolNames,
            action,
            canAutoRerun,
            wedgeRetryCount,
            retryCount,
          },
          "in-tool wedge detected — applying smart recovery",
        );
        if (canAutoRerun) {
          // Auto re-run the original request. Re-dispatch via the same
          // recursion the crash-recovery path uses, bumping BOTH the
          // wedge budget and the shared crash-recovery budget so a
          // re-run that wedges or crashes again is bounded.
          this.log.info(
            { agent: sessionName, channel: channelId },
            "wedge recovery — auto re-running the read-only request",
          );
          // Part C (quick task 260714-mkq) — prime the model that its PRIOR
          // turn was aborted mid-flight by the stream-stall watchdog, so it
          // does not report already-started work as finished on the re-run
          // (the 2026-07-14 hallucinated-status symptom). One-line bracketed
          // prepend; immutable (a fresh string — `formattedMessage` untouched).
          const rerunMessage =
            "[System: your previous turn was aborted by the stream-stall watchdog before it finished. Do NOT report prior work as complete — redo it.]\n\n" +
            formattedMessage;
          void this.streamAndPostResponse(
            message,
            sessionName,
            rerunMessage,
            undefined,
            0,
            retryCount + 1,
            wedgeRetryCount + 1,
          );
          this.queuedMessageIds.add(message.id);
          void this.transitionIcon(message, "QUEUED");
          return;
        }
        // NOTIFY — a mutating wedge, or the one-shot re-run budget is
        // spent. Post a clear notice to the agent's main channel and mark
        // the message FAILED. Never silently re-run a mutation.
        //
        // Dedup: this notify path can fire more than once for the SAME user
        // message (an auto-rerun that wedges again, or a double-delivered
        // turn) — which produced DUPLICATE "please resend" notices in the
        // channel. Post the notice AT MOST ONCE per message_id.
        if (this.rememberNoticedOnce(message.id)) {
          // Phase 999.114 — the copy used to say "a tool wedged"
          // UNCONDITIONALLY. `WedgeInfo` documents the opposite:
          // `no-useful-tokens` with an EMPTY `inFlightToolNames` is a
          // pure-text hang with NO tool involved. Every one of the 17
          // no-useful-tokens trips in the 7-day prod sweep had
          // `inFlightTools: []`, so the notice named a cause that was
          // absent in 100% of the cases it fired on, and actively
          // misdirected two separate diagnoses. Say what actually happened.
          // 999.178 R1 — the notice now carries a Retry button so the user taps
          // once instead of retyping; the classifier's wording is the reason.
          await this.postRetryNotice({
            original: message,
            agentName: sessionName,
            channelId,
            reason: describeStallNotice(wedgeInfo),
            replayMessage: formattedMessage,
          });
        } else {
          this.log.info(
            { agent: sessionName, channel: channelId, messageId: message.id },
            "wedge recovery — stall notice already posted for this message; suppressing duplicate",
          );
        }
        this.queuedMessageIds.delete(message.id);
        void this.transitionIcon(message, "FAILED");
        this.clearQueuedAsk(sessionName, message.id); // 999.178 R1 — terminal: leave the count + store.
        return;
      }

      // Crash-recovery retry: the SDK kills idle sessions (exit 143) after
      // ~38min, and a message arriving during the restart window throws
      // "Agent 'X' is not running". Both should retry — losing user messages
      // because the session was rebooting is bad UX.
      //
      // Recovery delay scales with consecutiveFailures: failure 1 → ~2s,
      // 2 → ~4s, 3 → ~8s, plus warmup (~7-12s for MCP init). So worst case
      // for 1-2 consecutive failures is ~17s; 3 consecutive is ~20s.
      //
      // First retry: 20s (covers failure 1-2 cleanly).
      // Second retry: +15s (catches failure 3 if first retry was still early).
      // Retries cap at 2 so we never loop infinitely on a permanently-broken agent.
      const isCrashRecovery = errorMsg.includes("code 143") || errorMsg.includes("is not running");
      // Phase 999.100 — `&& !expectedStop`: never re-dispatch a turn the
      // user explicitly stopped.
      if (isCrashRecovery && !expectedStop && retryCount < 2) {
        const delayMs = retryCount === 0 ? 20_000 : 15_000;
        setTimeout(() => {
          void this.streamAndPostResponse(message, sessionName, formattedMessage, undefined, 0, retryCount + 1);
        }, delayMs);
        // Phase 119 A2A-03 — QUEUED while agent comes back online. Kept
        // (operator-useful signal: fires only on backoff retry, NOT every msg).
        // Hotfix 2026-05-14 — record in queuedMessageIds so the eventual
        // IN_FLIGHT/DELIVERED transitions fire (gated on prior-QUEUED).
        this.queuedMessageIds.add(message.id);
        void this.transitionIcon(message, "QUEUED");
        return;
      }

      // Phase 100-fu — QUEUE_FULL coalescing.
      //
      // SerialTurnQueue is depth-1 (one in-flight + one queued); a 3rd rapid
      // message throws QUEUE_FULL. Operator-reported bug 2026-04-28: bridge
      // used to react U+274C, forcing the operator to track + manually resend.
      // Now: append to per-agent coalescer + react U+23F3 hourglass instead.
      // perAgentCap fall-through still reacts U+274C as last resort.
      const isQueueFull = errorMsg === QUEUE_FULL_ERROR_MESSAGE;
      let coalesced = false;
      if (isQueueFull) {
        coalesced = this.messageCoalescer.addMessage(
          sessionName,
          formattedMessage,
          message.id,
        );
        if (coalesced) this.coalescedChannelById.set(message.id, message.channelId);
      }

      if (coalesced) {
        // Phase 119 A2A-03 \u2014 coalesced into per-agent queue; \u23f3 kept
        // (operator-useful: only fires on QUEUE_FULL, NOT every msg).
        // Hotfix 2026-05-14 \u2014 record so eventual IN_FLIGHT/DELIVERED fire.
        this.queuedMessageIds.add(message.id);
        void this.transitionIcon(message, "QUEUED");
      } else if (!expectedStop) {
        // Phase 119 A2A-03 \u2014 terminal failure; \u274c kept (operator-useful).
        // Hotfix 2026-05-14 \u2014 clean up any queued-tracking for this msg.
        // Phase 999.100 \u2014 skipped on an expected mid-turn stop (the abort is
        // intentional; the trigger message keeps its normal icons and the
        // stop message carries the \ud83d\uded1).
        this.queuedMessageIds.delete(message.id);
        void this.transitionIcon(message, "FAILED");
        this.clearQueuedAsk(sessionName, message.id); // 999.178 R1 — terminal: leave the count + store.
        // 999.178 R1 \u2014 a terminal failure (crash retries spent, queue cap, or a
        // generic error) now says WHY in plain words and offers a Retry button,
        // instead of a bare \u274c the user had to decode. Deduped per message id so
        // an SDK double-delivery can't post two notices; forgetNoticedOnce on a
        // user retry lets a re-failure post a fresh one.
        if (this.rememberNoticedOnce(message.id)) {
          const kind = isCrashRecovery ? "crash" : isQueueFull ? "queue-full" : "generic";
          await this.postRetryNotice({
            original: message,
            agentName: sessionName,
            channelId,
            reason: plainFailureReason(kind),
            replayMessage: formattedMessage,
          });
        }
      }
    } finally {
      // 2026-07-31 — idempotent typing-interval backstop. The success tail
      // and catch head already clear it; this closes the remaining
      // throw/early-return gaps between those sites so no exit path can
      // leak an 8s heartbeat. Scope-honest: a never-settling
      // `await dispatchStream` still parks this invocation (nothing runs
      // until it settles) — the TYPING_MAX_MS self-cap in the interval
      // callback remains that case's backstop.
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = undefined;
      }
      if (trailQuietTimer) {
        clearTimeout(trailQuietTimer);
        trailQuietTimer = undefined;
      }
      liveThinking?.stop();
      // 999.178 R1 — the step label belongs to the turn that just ended.
      this.liveStepLabel.delete(sessionName);
    }

    // Phase 100-fu — drain the per-agent coalescer.
    //
    // The in-flight turn (success OR failure above) has now released the
    // SerialTurnQueue depth-1 slot. Any messages buffered while this turn
    // was running get joined into ONE follow-up dispatch. SerialTurnQueue
    // is once again depth-1 (one in-flight + one queued) so this stays
    // well-behaved.
    //
    // Phase 999.11 — layered defense against the QUEUE_FULL coalescer storm
    // (clawdy 2026-04-30 09:47–09:58 PT trace: ~10 spin-loop iterations adding
    // +54 chars per cycle from nested [Combined:] wrappers). Three guards:
    //   (a) depth cap   — prevent unbounded recursion regardless of root cause
    //   (b) in-flight   — defer drain when sessionManager.hasActiveTurn=true
    //   (c) idempotent  — formatCoalescedPayload skips re-wrap on single-pending
    //                     pre-wrapped content (see formatCoalescedPayload below)
    await this.drainCoalesced(message, sessionName, channelId, drainDepth);
  }

  /**
   * Phase 100-fu drain, extracted (999.155) so the stranded-drain sweep can
   * run it too. Messages buffered with ⏳ used to drain ONLY when a
   * Discord-originated turn for the same agent finished; when the turn that
   * held the queue was self-fired (a transcription summary, a reaction, a send
   * that timed out) nothing ever drained them — state-contract 2026-09-22 sat
   * on three of a user's messages until they happened to send a fourth.
   */
  private async drainCoalesced(
    message: Message,
    sessionName: string,
    channelId: string,
    drainDepth: number,
  ): Promise<void> {
    const pending = this.messageCoalescer.takePending(sessionName);
    if (pending.length === 0) return;

    // (a) Depth cap — cheapest check first. On cap-hit: requeue + warn + return.
    //     The next message-arrival drain (or a real queue-free event) will
    //     pick the pending messages up at depth=0 again.
    if (drainDepth >= DiscordBridge.MAX_DRAIN_DEPTH) {
      this.log.warn(
        { agent: sessionName, channel: channelId, count: pending.length, drainDepth },
        "coalescer drain depth cap reached — leaving messages buffered for next arrival",
      );
      this.messageCoalescer.requeue(sessionName, pending);
      return;
    }

    // (b) hasActiveTurn gate — defer drain if a turn is still occupying the
    //     per-agent queue. The next message-arrival or in-flight settle path
    //     will re-trigger this block.
    if (this.sessionManager.hasActiveTurn(sessionName)) {
      this.log.debug(
        { agent: sessionName, channel: channelId, count: pending.length },
        "coalescer drain deferred — turn still in-flight",
      );
      this.messageCoalescer.requeue(sessionName, pending);
      return;
    }

    // (c) Drain — proceed with combined dispatch.
    const combinedPayload = this.formatCoalescedPayload(pending);
    this.log.info(
      { agent: sessionName, channel: channelId, count: pending.length, drainDepth },
      "draining coalesced messages as combined dispatch",
    );
    // Phase 119 A2A-03 hotfix 2026-05-14 #3 — transition each previously-
    // QUEUED pending message to IN_FLIGHT (👍) BEFORE the recursive
    // dispatch starts. Without this, the IN_FLIGHT site inside
    // streamAndPostResponse checks queuedMessageIds.has(message.id) — but
    // message.id is the trigger's, not the pending messages'. Result was
    // that M2/M3 stayed stuck at ⏳ forever even though their content was
    // delivered (operator pain reported in a fin-client channel:
    // "messages received the hourglass icon, but its never updated when
    // the message moves out of the queue").
    const pendingIds = pending
      .map((p) => p.messageId)
      .filter((id) => this.queuedMessageIds.has(id));
    for (const id of pendingIds) {
      void this.transitionIconByMessageId(message.channel, channelId, id, "IN_FLIGHT");
    }
    // No new Turn — the original Turn already ended. The drain dispatch
    // runs untraced (acceptable: this is the rare-path resend friction
    // fix, and the original turn already captured a failure trace).
    //
    // streamAndPostResponse internally swallows non-fatal errors (reacts
    // ❌ on the trigger for terminal failures, re-coalesces for
    // QUEUE_FULL, retries on crash). It does not throw on the typical
    // failure paths. We still wrap in try/catch for the rare unhandled
    // case (e.g., a future refactor introducing a throw, or the recursive
    // call escaping its own error handler).
    // Phase 999.154 — the coalesced messages' images ride with the combined
    // dispatch (keyed under the trigger id, which is what the dispatch reads).
    this.imageLedger.mergeInto(
      sessionName,
      message.id,
      pending.map((p) => p.messageId),
    );
    try {
      await this.streamAndPostResponse(
        message,
        sessionName,
        combinedPayload,
        undefined,
        drainDepth + 1,
      );
      // Success path: transition each pending to DELIVERED (✅) and clean
      // up the queuedMessageIds tracking to bound memory.
      //
      // Caveat: if the recursive call internally reacted ❌ on the trigger
      // (non-QUEUE_FULL terminal failure), the pending messages are also
      // affected — but we don't have a fine-grained outcome signal from
      // streamAndPostResponse to distinguish. The operator can still tell
      // from the trigger's ❌. Future refactor: have
      // streamAndPostResponse return a success boolean (or thread the
      // pending IDs through so the inner failure path can react on them
      // directly). For now, ✅ on pending after recursive call is the
      // right default — the alternative (leaving ⏳ stuck) is worse.
      for (const id of pendingIds) {
        if (this.queuedMessageIds.has(id)) {
          void this.transitionIconByMessageId(message.channel, channelId, id, "DELIVERED");
          this.queuedMessageIds.delete(id);
        }
      }
      // 999.178 R1 — the combined drain delivered every pending ask (and, on a
      // restore-drain, the trigger is itself one of them). Drop them all from
      // the count and the durable store so a restart won't re-drain them.
      for (const p of pending) this.queuedAskIds.get(sessionName)?.delete(p.messageId);
      void removeQueuedAsks(
        this.coalescedQueueStatePath,
        pending.map((p) => p.messageId),
        this.log,
      ).catch(() => undefined);
    } catch (err) {
      // Unhandled error path (rare — streamAndPostResponse handles its own
      // typical failures without throwing) — transition each pending to FAILED
      // so the operator sees a terminal signal instead of stuck-⏳, then rethrow
      // to preserve caller error handling. 999.178 R1 — leave the store here so
      // a genuinely unexpected drain crash retries once per restart (bounded by
      // the 6h expiry) rather than being lost.
      for (const id of pendingIds) {
        if (this.queuedMessageIds.has(id)) {
          void this.transitionIconByMessageId(message.channel, channelId, id, "FAILED");
          this.queuedMessageIds.delete(id);
          this.queuedAskIds.get(sessionName)?.delete(id);
        }
      }
      throw err;
    }
  }

  /** 999.156 — per-message trace-id override for follow-up turns (see runFollowUpTurn). */
  private readonly turnIdOverrides = new Map<string, string>();

  /**
   * 999.156 — remember which message carried a transcribable file and what
   * its author asked, keyed by the inbox stem the transcription job will be
   * named after. Fire-and-forget; a failure only loses the follow-up's
   * request context (it falls back to a summary).
   */
  private recordTranscriptRequests(
    agentName: string,
    memoryPath: string | undefined,
    downloadResults: readonly DownloadResult[],
    message: Message,
  ): void {
    if (!memoryPath) return;
    for (const r of downloadResults) {
      if (!r.success || !r.path) continue;
      if (!isTranscribable(r.attachmentInfo.contentType, r.attachmentInfo.name)) continue;
      void writeTranscriptRequest(memoryPath, {
        agent: agentName,
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.author.id,
        authorName: message.author.username,
        request: message.content ?? "",
        filename: r.attachmentInfo.name,
        localPath: r.path,
        at: new Date().toISOString(),
      }).catch((err: unknown) => {
        this.log.warn(
          { agent: agentName, file: r.attachmentInfo.name, err: err instanceof Error ? err.message : String(err) },
          "could not record transcript request (follow-up will fall back to a summary)",
        );
      });
    }
  }

  /**
   * 999.156 — run an agent turn that REPLIES to an earlier Discord message
   * (the one that carried an audio file whose transcript just finished).
   * Same path as a live message: typing indicator, streaming, queue slot and
   * delivery owned by the bridge. Returns false when the message or channel
   * can't be fetched so the caller can fall back.
   */
  async runFollowUpTurn(args: {
    readonly agent: string;
    readonly channelId: string;
    readonly messageId: string;
    readonly prompt: string;
    readonly label: string;
  }): Promise<boolean> {
    let trigger: Message | undefined;
    try {
      const channel = await this.client.channels.fetch(args.channelId);
      trigger =
        channel && "messages" in channel
          ? await (channel as { messages: { fetch(id: string): Promise<Message> } }).messages.fetch(args.messageId)
          : undefined;
    } catch {
      trigger = undefined;
    }
    if (!trigger) return false;
    this.turnIdOverrides.set(
      trigger.id,
      `${DISCORD_SNOWFLAKE_PREFIX}${trigger.id}:${args.label}-${Date.now()}`,
    );
    try {
      this.fireTypingIndicator(trigger, undefined);
      await this.streamAndPostResponse(trigger, args.agent, args.prompt);
      return true;
    } finally {
      this.turnIdOverrides.delete(trigger.id);
    }
  }

  /**
   * 999.156 — show "typing…" in the agent's primary channel while `fn` runs
   * (self-fired fallback path, which has no bridge turn behind it).
   */
  async withTypingInAgentChannel<T>(agent: string, fn: () => Promise<T>): Promise<T> {
    const channelId = this.routingTableRef.current.agentToChannels.get(agent)?.[0];
    let timer: ReturnType<typeof setInterval> | undefined;
    if (channelId) {
      const beat = async (): Promise<void> => {
        try {
          const ch = await this.client.channels.fetch(channelId);
          if (ch && "sendTyping" in ch && typeof ch.sendTyping === "function") await ch.sendTyping();
        } catch {
          /* cosmetic */
        }
      };
      void beat();
      timer = setInterval(() => void beat(), 8_000);
      (timer as { unref?: () => void }).unref?.();
    }
    try {
      return await fn();
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  /** 999.155 — sweep cadence for messages stranded behind a self-fired turn. */
  private static readonly STRANDED_DRAIN_SWEEP_MS = 20_000;
  private strandedDrainTimer: ReturnType<typeof setInterval> | null = null;
  private readonly strandedDrainInFlight = new Set<string>();
  /** Channel of each coalesced message id (the coalescer stores content + id only). */
  private readonly coalescedChannelById = new Map<string, string>();

  /**
   * 999.155 — drain agents whose buffered messages have no Discord turn left
   * to release them. Safe to race a live arrival: a drain that loses the
   * queue re-coalesces (QUEUE_FULL path) and the next sweep retries.
   */
  private async sweepStrandedCoalesced(): Promise<void> {
    for (const agent of this.messageCoalescer.agentsWithPending()) {
      if (this.strandedDrainInFlight.has(agent)) continue;
      // 999.178 R1 — an agent that isn't up yet also reports hasActiveTurn:false.
      // Draining to it throws "is not running", burns the crash-recovery retries
      // (~35s) and can mark restored asks FAILED before fleet boot finishes
      // (agents start serially at ~15-30s each). Wait until the agent is running.
      if (!this.sessionManager.isRunning(agent)) continue;
      if (this.sessionManager.hasActiveTurn(agent)) continue;
      const last = this.messageCoalescer.peekLast(agent);
      const channelId = last ? this.coalescedChannelById.get(last.messageId) : undefined;
      if (!last || !channelId) continue;
      this.strandedDrainInFlight.add(agent);
      try {
        const channel = await this.client.channels.fetch(channelId);
        const trigger =
          channel && "messages" in channel
            ? await (channel as { messages: { fetch(id: string): Promise<Message> } }).messages.fetch(last.messageId)
            : undefined;
        if (!trigger) continue;
        this.log.info(
          { agent, channel: channelId, count: this.messageCoalescer.getPendingCount(agent) },
          "stranded coalesced messages — draining (no Discord turn left to release them)",
        );
        await this.drainCoalesced(trigger, agent, channelId, 0);
      } catch (err) {
        this.log.warn(
          { agent, err: err instanceof Error ? err.message : String(err) },
          "stranded coalesced drain failed — will retry next sweep",
        );
      } finally {
        this.strandedDrainInFlight.delete(agent);
      }
    }
    // Bound the id→channel map to ids still buffered.
    if (this.coalescedChannelById.size > 500) {
      const live = new Set<string>();
      for (const a of this.messageCoalescer.agentsWithPending()) {
        const l = this.messageCoalescer.peekLast(a);
        if (l) live.add(l.messageId);
      }
      for (const id of this.coalescedChannelById.keys()) if (!live.has(id)) this.coalescedChannelById.delete(id);
    }
  }

  /**
   * Phase 100-fu — format coalesced messages into a single combined payload.
   *
   * Joins each pending entry with `\n\n---\n\n` and prefixes a header so the
   * agent sees the operator sent multiple thoughts in rapid succession (not
   * one giant blob). Order is FIFO (insertion order from MessageCoalescer).
   *
   * Phase 999.11 — idempotent guard: a single pending entry whose content
   * already starts with COMBINED_PREFIX is returned unchanged. The storm
   * trace from clawdy 2026-04-30 09:47–09:58 PT showed +54 chars per spin-
   * loop iteration from exactly this nesting bug — re-queued coalesced
   * payloads gaining a second [Combined: …] header per cycle.
   *
   * Why `pending.length === 1` specifically: the storm always involves a
   * single re-queued payload sitting alone in the buffer. Multi-pending
   * coalesce of (wrapped + new) correctly preserves the inner [Combined:]
   * as `(1)` body content under a fresh outer header — that's the legitimate
   * "user sent N messages while agent worked" feature and must keep working.
   */
  private formatCoalescedPayload(
    pending: ReadonlyArray<{ readonly content: string; readonly messageId: string }>,
  ): string {
    if (
      pending.length === 1 &&
      pending[0].content.startsWith(DiscordBridge.COMBINED_PREFIX)
    ) {
      return pending[0].content;
    }
    const header = `[Combined: ${pending.length} message${pending.length === 1 ? "" : "s"} received during prior turn]`;
    const body = pending
      .map((m, i) => `(${i + 1}) ${m.content}`)
      .join("\n\n---\n\n");
    return `${header}\n\n${body}`;
  }

  /**
   * Extract the sender agent name from a webhook message's embed footer.
   * Agent-to-agent messages have footer text: "Agent-to-agent message from {agentName}"
   * Returns the sender agent name or undefined if not an agent message.
   */
  private extractAgentSender(message: Message): string | undefined {
    return this.extractAgentEnvelope(message)?.senderName;
  }

  /**
   * Phase 999.117 WS-2 — parse the A2A footer into sender + delivery id.
   *
   * Delegates to `parseAgentMessageFooter` rather than re-implementing the
   * regex here. The builder and the parser were separate literals before; a
   * one-character drift between them would silently stop the bridge from
   * recognising agent messages, turning the webhook rung into a black hole
   * with no error anywhere.
   */
  private extractAgentEnvelope(
    message: Message,
  ): { senderName: string; deliveryId?: string; sig?: string } | undefined {
    if (!message.embeds || message.embeds.length === 0) return undefined;
    return parseAgentMessageFooter(message.embeds[0].footer?.text ?? undefined);
  }

  /**
   * Handle an incoming agent-to-agent webhook message.
   * Extracts content from the embed, prefixes with sender context, and forwards to the bound agent.
   */
  private async handleAgentMessage(message: Message, senderAgent: string): Promise<void> {
    const channelId = message.channelId;
    const agentName = this.routingTableRef.current.channelToAgent.get(channelId);
    if (!agentName) {
      this.log.debug({ channelId, senderAgent }, "agent webhook message in unbound channel -- ignoring");
      return;
    }

    // WS-0 (quick 260716-u5h) — self-exclusion. An agent's own webhook post
    // landing in its own bound channel must never be forwarded back into it:
    // the echo turn produces another response, which posts, which echoes — a
    // self-sustaining loop generating buffered garbage (the 2026-07-16 Admin
    // Clawdy incident class). Guard sits above BOTH forward legs (v2
    // forwardToAgent and the v3 channel push).
    if (senderAgent === agentName) {
      this.log.info(
        { agent: agentName, channel: channelId, messageId: message.id },
        "agent-to-agent self-echo dropped (own webhook post in own channel)",
      );
      return;
    }

    // Extract content from the embed description
    const embedContent = message.embeds[0]?.description ?? message.content ?? "";

    // Format with agent message prefix per user decision (A2A-04)
    const prefixedContent = `[Agent Message from ${senderAgent}]\n${embedContent}`;

    this.log.info(
      { from: senderAgent, to: agentName, channel: channelId, messageId: message.id },
      "routing agent-to-agent message",
    );

    try {
      // Phase 141 (#8) — v3 agents: forwardToAgent → inert handle.send drops the
      // relayed a2a message silently. Route via the live ClawCode channel push
      // (the modern post_to_agent path is already v3-aware; this is the LEGACY
      // webhook-relay straggler that missed the carve-out). v2 → unchanged path.
      const backend =
        this.sessionManager.getAgentConfig?.(agentName)?.llmRuntime?.backend;
      const v3Bridge = resolveV3ChatBridge(backend, this.getBridge, agentName);
      if (v3Bridge) {
        v3Bridge.push({
          type: "a2a",
          message_id: `a2a-relay-${message.id}`,
          content: prefixedContent,
          meta: { source_agent: senderAgent, source_channel: channelId },
        });
        this.log.info(
          { from: senderAgent, to: agentName, via: "v3-channel" },
          "agent-to-agent message forwarded via v3 channel",
        );
      } else {
        await this.sessionManager.forwardToAgent(agentName, prefixedContent);
        this.log.info({ from: senderAgent, to: agentName }, "agent-to-agent message forwarded");
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(
        { from: senderAgent, to: agentName, error: errorMsg },
        "failed to forward agent-to-agent message",
      );
    }
  }

  /**
   * Handle a reaction event (add or remove).
   * Routes to the bound agent in the channel.
   */
  private async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    type: "add" | "remove",
  ): Promise<void> {
    // Ignore bot reactions (prevent feedback loops)
    if (user.bot) {
      return;
    }

    const channelId = reaction.message.channelId;
    // 2026-08-27 — thread-aware: reactions inside subagent threads used to
    // resolve to no agent and were silently dropped.
    const agentName =
      this.routingTableRef.current.channelToAgent.get(channelId) ??
      (await this.threadManager?.routeMessage(channelId));

    if (!agentName) {
      return;
    }

    // Fetch partial reaction if needed
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        this.log.warn({ channelId, type }, "failed to fetch partial reaction");
        return;
      }
    }

    // UX-D (2026-08-26) — a reaction on an older/uncached message arrives
    // with a PARTIAL message object: `reaction.message.content` is empty,
    // so the forwarded event would carry an id and no text — which defeats
    // point-and-verify (the agent needs the claims it is asked to verify).
    // Fetch the message before formatting. A deleted message throws:
    // nothing to forward, return silently.
    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
      } catch {
        this.log.debug(
          { channelId, type },
          "reaction message no longer exists — ignoring",
        );
        return;
      }
    }

    // Phase 999.43 SC-E Plan 04 T02 — operator priority override via
    // 🔴/🟡/🟢 reactions on a Discord attachment message. The branch is
    // ADDITIVE: after firing the set-doc-priority-by-message IPC we
    // FALL THROUGH to the regular reaction-forwarding pipeline below so
    // the agent still sees "🔴 added" too (operator may still want the
    // agent to react to the same emoji semantically).
    //
    // Emoji codepoints (D-03 LOCKED): 🔴 U+1F534 → high,
    //   🟡 U+1F7E1 → medium, 🟢 U+1F7E2 → low.
    // 2026-08-27 verification v2 — 🧾 opens the verification ledger for the
    // message (daemon-side: no model turn, answers from the in-memory store).
    // Never forwarded to the agent. 🔍 keeps its "re-verify" meaning.
    if (type === "add") {
      try {
        const ledgerEmoji =
          this.sessionManager.getAgentConfig(agentName)?.verification?.ux?.ledgerReaction ?? "🧾";
        if (ledgerEmoji.length > 0 && (reaction.emoji.name ?? "") === ledgerEmoji) {
          await this.postLedgerCard({
            channelId,
            replyToMessageId: reaction.message.id,
            ledger: this.ledgerStore.byMessageId(reaction.message.id),
          });
          return;
        }
      } catch (err) {
        this.log.debug(
          { agent: agentName, error: err instanceof Error ? err.message : String(err) },
          "ledger reaction handling failed (non-fatal)",
        );
      }
    }

    if (type === "add") {
      const PRIORITY_EMOJIS: Record<string, "high" | "medium" | "low"> = {
        "🔴": "high",
        "🟡": "medium",
        "🟢": "low",
      };
      const emojiName = reaction.emoji.name ?? "";
      const newLevel = PRIORITY_EMOJIS[emojiName];
      if (newLevel) {
        try {
          const result = await sendIpcRequest(
            SOCKET_PATH,
            "set-doc-priority-by-message",
            {
              agent: agentName,
              message_id: reaction.message.id,
              level: newLevel,
              who: "operator",
              reason: `Discord ${emojiName} reaction by ${user.username ?? user.id}`,
            },
          );
          this.log.info(
            {
              tag: "phase999.43-priority-emoji",
              agent: agentName,
              messageId: reaction.message.id,
              newLevel,
              user: user.username ?? user.id,
              result,
            },
            "phase999.43 emoji-override processed",
          );
        } catch (err) {
          this.log.warn(
            {
              tag: "phase999.43-priority-emoji",
              err: err instanceof Error ? err.message : String(err),
              messageId: reaction.message.id,
              agent: agentName,
            },
            "phase999.43 emoji-override failed",
          );
        }
        // Intentional fall-through to the existing reaction-forwarding
        // pipeline below — both surfaces are additive.
      }
    }

    // Phase 999.127 — weekly memory-digest feedback. A number reaction on a
    // digest message forgets that item; 👍 confirms them all. Handled here
    // (daemon-side, no model turn) and NOT forwarded to the agent.
    if (type === "add" && isDigestMessage(reaction.message.content ?? "")) {
      const handled = await this.handleDigestReaction(agentName, reaction, user);
      if (handled) return;
    }

    const emoji = reaction.emoji.name ?? reaction.emoji.id ?? "unknown";
    const userName = user.username ?? user.id;

    const formatted = formatReactionEvent({
      type,
      emoji,
      userName,
      messageId: reaction.message.id,
      channelId,
      messageContent: reaction.message.content ?? undefined,
    });

    try {
      // Phase 141 (#8) — v3 (claude-code-interactive) agents have an INERT
      // daemon-side handle, so forwardToAgent → handle.send goes nowhere (the
      // agent never sees the reaction — silent drop). Route the reaction event
      // over the live ClawCode channel instead (the same push the modern
      // post_to_agent path uses). v2 agents have no bridge → fall through to the
      // unchanged forwardToAgent path. message_id is `reaction-`-prefixed so it
      // can never collide with the `discord-<id>` chat correlation for the same
      // underlying message.
      const backend =
        this.sessionManager.getAgentConfig?.(agentName)?.llmRuntime?.backend;
      const v3Bridge = resolveV3ChatBridge(backend, this.getBridge, agentName);
      if (v3Bridge) {
        v3Bridge.push({
          type: "a2a",
          message_id: `reaction-${reaction.message.id}`,
          content: formatted,
          meta: { source_agent: "discord", source_channel: channelId },
        });
        this.log.info(
          { agent: agentName, emoji, type, user: userName, via: "v3-channel" },
          "reaction forwarded to agent via v3 channel",
        );
      } else {
        await this.sessionManager.forwardToAgent(agentName, formatted);
        this.log.info(
          { agent: agentName, emoji, type, user: userName },
          "reaction forwarded to agent",
        );
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(
        { agent: agentName, error: errorMsg },
        "failed to forward reaction",
      );
    }
  }

  /**
   * Send a response back to the Discord channel.
   * Handles message length limits (2000 chars) by splitting.
   */
  /**
   * Phase 999.127 — apply a reaction on a memory-digest message. Returns
   * true when the reaction was consumed (a recognised emoji, store present),
   * false to fall through to the regular forwarding pipeline.
   */
  private async handleDigestReaction(
    agentName: string,
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<boolean> {
    const feedback = feedbackForEmoji(reaction.emoji.name ?? "");
    if (!feedback) return false;
    const items = parseDigestMessage(reaction.message.content ?? "") ?? [];
    const getStore = (
      this.sessionManager as {
        getMemoryStore?: (a: string) => import("../memory/store.js").MemoryStore | undefined;
      }
    ).getMemoryStore;
    const store =
      typeof getStore === "function" ? getStore.call(this.sessionManager, agentName) : undefined;
    if (!store) {
      this.log.warn(
        { agent: agentName },
        "memory digest reaction: no memory store (agent not running?) — forwarding instead",
      );
      return false;
    }
    try {
      const result = applyDigestFeedback(store, feedback, items);
      this.log.info(
        { agent: agentName, user: user.username ?? user.id, messageId: reaction.message.id, ...result },
        "memory digest feedback applied",
      );
      try {
        await (reaction.message as { reply: (t: string) => Promise<unknown> }).reply(
          digestReplyText(result),
        );
      } catch (err) {
        this.log.debug(
          { agent: agentName, error: err instanceof Error ? err.message : String(err) },
          "memory digest reply failed (non-fatal)",
        );
      }
      return true;
    } catch (err) {
      this.log.warn(
        { agent: agentName, error: err instanceof Error ? err.message : String(err) },
        "memory digest feedback failed",
      );
      return false;
    }
  }

  /**
   * Resolve the agent name for a channel, checking thread bindings first.
   */
  private resolveAgentForChannel(channelId: string): string | undefined {
    return this.routingTableRef.current.channelToAgent.get(channelId);
  }

  /** 999.101 — per-`agent:author` last-fire stamps for bot-trigger cooldown. */
  private readonly botTriggerLastFired = new Map<string, number>();

  /**
   * 999.101 — allowlisted bot message → automated agent turn. Fire-and-
   * forget: the dispatch runs a FULL agent turn (minutes under load) and
   * handleMessage must never block on it. No typing indicator / steering /
   * prompt-intercept machinery applies.
   *
   * 999.134 (2026-09-06) — the reply is delivered by THIS method through
   * `sendResponse` (delivery queue → webhook/bot, chunked). Until then the
   * dispatched response was discarded (`void dispatch()` with no consumer):
   * the coach ran a full turn for every one of 20 Strava events in 30 days
   * and not one reply reached the channel. Schedules never had this gap —
   * they run through the trigger engine, which owns its own deliveryFn.
   */
  private maybeFireBotTrigger(message: Message): void {
    if (!this.turnDispatcher) return;
    const agentName = this.resolveAgentForChannel(message.channelId);
    if (!agentName) return;
    const cfg = this.sessionManager.getAgentConfig(agentName);

    const triggers = cfg?.botTriggers;
    const decision = decideBotTrigger({
      triggers,
      agentName,
      authorUsername: message.author.username,
      authorId: message.author.id,
      lastFiredAt: this.botTriggerLastFired,
      now: Date.now(),
    });
    if (decision.action === "no-match") return;
    if (decision.action === "cooldown") {
      this.log.info(
        {
          tag: "bot-trigger",
          agent: agentName,
          author: message.author.username,
          action: "cooldown",
          remainingMs: decision.remainingMs,
        },
        "bot-trigger suppressed by cooldown",
      );
      return;
    }
    this.botTriggerLastFired.set(decision.key, Date.now());
    const prompt = buildBotTriggerPrompt({
      author: message.author.username,
      content: message.content,
      embedTexts: message.embeds.map((e) =>
        [e.title ?? "", e.description ?? ""].filter(Boolean).join("\n"),
      ),
    });
    this.log.info(
      {
        tag: "bot-trigger",
        agent: agentName,
        author: message.author.username,
        action: "fired",
        channel: message.channelId,
      },
      "bot-trigger dispatching automated turn",
    );
    this.dispatchAutomatedTurn(
      message,
      agentName,
      prompt,
      `bot:${message.author.username.toLowerCase()}`,
    );
  }

  /**
   * The single automated-turn dispatch+deliver seam, extracted from
   * `maybeFireBotTrigger` (999.101/999.134) so any automated turn
   * reuses the same delivery path (`deliverBotTriggerReply` →
   * `sendResponse` → delivery queue / webhook, chunked). Pure extraction — the
   * generic bot-trigger behaviour is byte-identical (asserted by
   * bot-trigger-delivery.test.ts). Fire-and-forget; a dispatch/delivery throw
   * is warn-logged and swallowed so chat is never blocked.
   */
  private dispatchAutomatedTurn(
    message: Message,
    agentName: string,
    prompt: string,
    originTag: string,
  ): void {
    if (!this.turnDispatcher) return;
    const origin = makeRootOrigin("trigger", originTag);
    void this.turnDispatcher
      .dispatch(origin, agentName, prompt)
      .then((response) => this.deliverBotTriggerReply(message, agentName, response))
      .catch((err) => {
        this.log.warn(
          {
            tag: "bot-trigger",
            agent: agentName,
            author: message.author.username,
            err: err instanceof Error ? err.message : String(err),
          },
          "bot-trigger dispatch failed",
        );
      });
  }

  /**
   * 999.134 — post the automated turn's reply into the channel the bot
   * message arrived in. Blank replies (the agent chose silence) are logged
   * and dropped; everything else goes through the normal delivery path so
   * chunking, webhook identity and retry all apply.
   */
  private async deliverBotTriggerReply(
    message: Message,
    agentName: string,
    response: string,
  ): Promise<void> {
    const text = typeof response === "string" ? response.trim() : "";
    const fields = {
      tag: "bot-trigger",
      agent: agentName,
      author: message.author.username,
      channel: message.channelId,
    };
    // Same silence contract as scheduled turns: blank, `NO_REPORT`, or a
    // short "nothing to report" narration is dropped instead of posted.
    if (isSilentTickResponse(text)) {
      this.log.info(
        { ...fields, action: "silent", chars: text.length },
        "bot-trigger turn produced no reply",
      );
      return;
    }
    await this.sendResponse(message, text, agentName);
    this.log.info(
      { ...fields, action: "delivered", chars: text.length },
      "bot-trigger reply delivered",
    );
  }

  private async sendResponse(
    originalMessage: Message,
    response: string,
    agentName?: string,
  ): Promise<void> {
    // Deduplicate — don't send the same response twice within 5s
    const dedupeKey = `${originalMessage.channelId}:${response.slice(0, 100)}`;
    if (this.recentlySent.has(dedupeKey)) {
      return;
    }
    this.recentlySent.add(dedupeKey);
    setTimeout(() => this.recentlySent.delete(dedupeKey), 5000);

    const resolvedAgent = agentName ?? this.resolveAgentForChannel(originalMessage.channelId);

    // Route through delivery queue if available — queue handles retry on failure
    if (this.deliveryQueue && resolvedAgent) {
      this.deliveryQueue.enqueue(resolvedAgent, originalMessage.channelId, response);
      return;
    }

    // Fallback: direct send (backward compatible when no queue configured)
    await this.sendDirect(originalMessage, response, resolvedAgent);
  }

  /**
   * Phase 135 Plan 03 — public sink for system-originated messages on
   * behalf of an agent (e.g., voice monthly-cap warnings posted by
   * VoiceManager.checkCapAndDisconnectIfNeeded). Tries the per-agent
   * webhook (preserves agent identity); falls back to plain channel.send
   * via the discord.js Client if no webhook is configured.
   *
   * The text is sent verbatim — caller controls voice/wording. Errors
   * propagate so the caller can log + degrade; no defensive swallow
   * here.
   */
  async sendAgentMessageToChannel(
    agentName: string,
    channelId: string,
    text: string,
  ): Promise<void> {
    if (this.webhookManager?.hasWebhook(agentName)) {
      await this.webhookManager.send(agentName, text);
      return;
    }
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("send" in channel) || typeof channel.send !== "function") {
      throw new Error(
        `sendAgentMessageToChannel: channel ${channelId} not sendable`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (channel as any).send(text);
  }

  /**
   * Phase 999.63 Plan 03 D5 (updated 999.63c) — post a labelled
   * financial-verification correction as a standalone message to a
   * channel. Since 999.63c this is the FALLBACK delivery: the preferred
   * path is `applyFinancialCorrection`, which edits the originally
   * delivered message in place when a `deliveredRefs` entry proves that
   * is safe. (The 999.63-era "delivery exits untouched / byte-identical
   * existing path" invariant no longer holds: the v2 final-delivery edit
   * exit now records a DeliveredMessageRef after a successful edit.)
   *
   * Reuses the same `client.channels.fetch` + `channel.send` chain as
   * `sendAgentMessageToChannel` / `sendBudgetAlert`. Plain `channel.send`
   * (not the per-agent webhook) — the `🔎 Correction` prefix signals a
   * system-style correction, not the agent's own voice.
   *
   * 999.63c also fixes the latent >2000-char bug: since the corrective
   * reply is now a full replacement message, the fallback post routinely
   * exceeds one Discord message — chunk via `splitMessage`, sequential
   * sends.
   *
   * Fail-open: a null channelId, an unsendable channel, or a send that
   * throws is a logged no-op. A failed correction post must NEVER throw
   * back to the (fire-and-forget) gate helper.
   */
  async postFinancialCorrection(args: {
    channelId: string | null;
    text: string;
  }): Promise<void> {
    const { channelId, text } = args;
    if (!channelId) {
      this.log.warn(
        {},
        "postFinancialCorrection: no channelId — correction not posted",
      );
      return;
    }
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !("send" in channel) || typeof channel.send !== "function") {
        this.log.warn(
          { channelId },
          "postFinancialCorrection: channel not sendable — correction not posted",
        );
        return;
      }
      for (const chunk of splitMessage(text, 2000)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (channel as any).send(chunk);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(
        { channelId, error: errorMsg },
        "postFinancialCorrection: send failed (non-fatal)",
      );
    }
  }

  /**
   * 999.63c — preferred correction delivery: edit the originally
   * delivered message in place (corrected text + italic footer), falling
   * back to `postFinancialCorrection` whenever the pure decision ladder
   * (`decideCorrectionEdit`) cannot prove the edit is safe, or the edit
   * itself throws (deleted message, missing permissions, rate limit).
   *
   * Returns which path actually delivered — the runner logs it as the
   * `correctionDelivery` telemetry rider.
   *
   * The ref is consumed single-shot BEFORE the ladder runs: whether the
   * edit succeeds or falls back, a later retry against the same turn must
   * not edit stale text.
   *
   * Fail-open discipline matches every other 999.63 surface: nothing
   * here may throw back into the fire-and-forget hop.
   */
  async applyFinancialCorrection(rawArgs: FinancialCorrectionArgs): Promise<"edit" | "chunk-edit" | "post"> {
    // 999.178 R1 — the corrected reply is agent-authored: resolve its
    // `:cc_name:` shortcodes up front so (a) no raw shortcode ships on any
    // correction exit (in-place edit, chunk edit, or fallback post), and
    // (b) the in-place-edit startsWith check matches the delivered text,
    // which was already rewritten at delivery. Idempotent.
    const args0: FinancialCorrectionArgs = {
      ...rawArgs,
      originalResponse: rewriteIconShortcodes(rawArgs.originalResponse, icons),
      correctedText: rewriteIconShortcodes(rawArgs.correctedText, icons),
      fallbackText: rewriteIconShortcodes(rawArgs.fallbackText, icons),
    };
    // 2026-08-28 — replies that shipped a ```draft as its own message: edit
    // the draft message itself and/or hand body-only texts to the path below.
    const prepared = await this.prepareCorrectionForDrafts(args0);
    if (prepared.settled) return prepared.settled;
    const args = prepared.args;
    let fallbackReason: string | null = null;
    try {
      const ref = args.turnId
        ? this.deliveredRefs.consume(args.turnId, Date.now())
        : undefined;
      const decision = decideCorrectionEdit({
        ref,
        originalResponse: args.originalResponse,
        correctedText: args.correctedText,
        footer: args.footer,
      });
      if (decision.kind === "edit") {
        const channel = await this.client.channels.fetch(decision.channelId);
        if (channel && "messages" in channel) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msg = await (channel as any).messages.fetch(decision.messageId);
          if (decision.replan) {
            // 2026-08-28 — table PNG cards: re-plan on the corrected body and
            // replace the old cards (`attachments: []`) in the same edit.
            const plan = await planOutboundTables(decision.replan.body, { log: this.log });
            const content = stripTablePlaceholders(plan.text) + decision.replan.tail;
            if (content.length > MAX_EDIT_LENGTH) throw new Error("replanned correction exceeds the edit limit");
            await msg.edit({
              content,
              files: plan.files.map((f) => ({
                attachment: f.attachment,
                name: f.name,
                ...(f.description ? { description: f.description } : {}),
              })),
              attachments: [],
              ...deliveryFlags(),
            });
          } else {
            await msg.edit(decision.editText);
          }
          // UX-B (2026-08-26) — flag the in-place edit visually. Discord's
          // "(edited)" tag is easy to miss; an operator who already read
          // the wrong version must NOTICE the correction. The search icon
          // matches the correction prefix family. Reaction failure never
          // affects the correction outcome.
          const correctionMark = icons.reaction("search");
          if (correctionMark) {
            try {
              await msg.react(correctionMark);
            } catch (reactErr) {
              this.log.debug(
                {
                  agent: args.agentName,
                  error:
                    reactErr instanceof Error
                      ? reactErr.message
                      : String(reactErr),
                },
                "applyFinancialCorrection: search reaction failed (non-fatal)",
              );
            }
          }
          this.log.info(
            {
              agent: args.agentName,
              channelId: decision.channelId,
              messageId: decision.messageId,
            },
            "applyFinancialCorrection: original message edited in place",
          );
          return "edit";
        }
        this.log.warn(
          { agent: args.agentName, channelId: decision.channelId },
          "applyFinancialCorrection: channel has no messages API — falling back to post",
        );
      } else {
        fallbackReason = decision.reason;
        this.log.debug(
          { agent: args.agentName, reason: decision.reason },
          "applyFinancialCorrection: edit not applicable — falling back",
        );
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.warn(
        { agent: args.agentName, error: errorMsg },
        "applyFinancialCorrection: edit failed — falling back to post (non-fatal)",
      );
    }
    // 999.63d/4 — chunk-edit rung: a chunked (>2000) delivery left no
    // DeliveredMessageRef, but its per-chunk refs may be retained. Only
    // the no-ref reason qualifies (text-mismatch/oversize mean the
    // SINGLE-message ref existed and proved unsafe — chunk refs would be
    // from an older delivery).
    if (fallbackReason === "no-ref") {
      const applied = await this.tryChunkEditCorrection(args);
      if (applied) return "chunk-edit";
    }
    await this.postFinancialCorrection({
      channelId: args.channelId,
      text: args.fallbackText,
    });
    return "post";
  }

  /**
   * 999.63d/4 — execute a planned chunk-level in-place correction.
   * All-or-nothing at PLAN time (pure ladder in chunk-refs.ts); an API
   * error mid-execution logs, returns false, and the caller posts the
   * compact note (which supersedes any partially applied edit). The
   * last edited chunk gets the 🔎 reaction (bot reactions attach to
   * webhook-authored messages fine).
   */
  /**
   * 2026-08-28 — corrections for replies that shipped a draft as its own
   * message (`extractDrafts` at delivery). The corrective hop patches the
   * model's FULL text, so split both texts the same way: each changed draft
   * is edited in place as plain text (no footer — it must stay copy-paste
   * clean); when the analysis body did not change the correction settles
   * with a one-line `-# ✏️ corrected in the draft: …` on the body message;
   * when the body changed too, body-only texts go down the normal path.
   * Fail-open: any throw → the legacy whole-text path.
   */
  private async prepareCorrectionForDrafts(
    raw: FinancialCorrectionArgs,
  ): Promise<{ args: FinancialCorrectionArgs; settled?: "edit" }> {
    try {
      const split = splitCorrectionForDrafts(raw.originalResponse, raw.correctedText);
      if (!split) return { args: raw };
      const changed = split.drafts.filter((d) => d.original !== d.corrected);
      let edited = 0;
      for (const d of changed) {
        // 999.178 R1 — the corrected draft is a client-facing body; strip any
        // icon token before it lands in the draft. Strip `d.original` too so
        // it matches the delivered draft, which was stripped at delivery.
        if (await this.editDraftMessage(raw.agentName, stripIconShortcodes(d.original), stripIconShortcodes(d.corrected))) edited++;
      }
      const bodyChanged = split.body.original.trim() !== split.body.corrected.trim();
      this.log.info(
        { agent: raw.agentName, drafts: split.drafts.length, changed: changed.length, edited, bodyChanged },
        "applyFinancialCorrection: draft-aware split",
      );
      if (!bodyChanged) {
        if (changed.length > 0 && edited === changed.length) {
          await this.annotateDraftCorrection(raw, changed);
          return { args: raw, settled: "edit" };
        }
        return { args: raw };
      }
      return { args: { ...raw, originalResponse: split.body.original, correctedText: split.body.corrected } };
    } catch (error) {
      this.log.warn(
        { agent: raw.agentName, error: error instanceof Error ? error.message : String(error) },
        "applyFinancialCorrection: draft split failed — legacy path (non-fatal)",
      );
      return { args: raw };
    }
  }

  /** Edit the delivered draft message whose text matches `original`. */
  private async editDraftMessage(agentName: string, original: string, corrected: string): Promise<boolean> {
    const refs = this.chunkRefs.refsFor(agentName, Date.now());
    const wanted = new Set([original, original.trim(), formatOutboundText(original), formatOutboundText(original).trim()]);
    const ref = [...refs].reverse().find((r) => wanted.has(r.text) || wanted.has(r.text.trim()));
    if (!ref) return false;
    const text = formatOutboundText(corrected).trim();
    if (text.length === 0 || text.length > MAX_EDIT_LENGTH) return false;
    if (ref.kind === "webhook") {
      if (!this.webhookManager) return false;
      await this.webhookManager.editMessageRaw(agentName, ref.messageId, text);
    } else {
      const channel = await this.client.channels.fetch(ref.channelId);
      if (!channel || !("messages" in channel)) return false;
      const msg = await (channel as any).messages.fetch(ref.messageId);
      await msg.edit(text);
    }
    this.log.info(
      { agent: agentName, messageId: ref.messageId, kind: ref.kind },
      "applyFinancialCorrection: draft message corrected in place",
    );
    return true;
  }

  /** One `-# ✏️` line on the analysis message naming what changed in the draft. */
  private async annotateDraftCorrection(
    raw: FinancialCorrectionArgs,
    changed: ReadonlyArray<{ readonly original: string; readonly corrected: string }>,
  ): Promise<void> {
    const summary = changed
      .map((d) => {
        const sp = diffSpan(d.original, d.corrected);
        const o = sp.old.length > 0 ? sp.old.slice(0, 60) : "(nothing)";
        const n = sp.neu.length > 0 ? sp.neu.slice(0, 60) : "(removed)";
        return `${o} → ${n}${sp.after.length > 0 ? ` ${sp.after}${sp.clippedEnd ? "…" : ""}` : ""}`;
      })
      .join(" · ");
    const line = `-# ${icons.prefix("pencil", `corrected in the draft: ${summary}`)}`;
    const ref = raw.turnId ? this.deliveredRefs.consume(raw.turnId, Date.now()) : undefined;
    if (ref && ref.kind === "bot" && `${ref.deliveredText}\n${line}`.length <= MAX_EDIT_LENGTH) {
      try {
        const channel = await this.client.channels.fetch(ref.channelId);
        if (channel && "messages" in channel) {
          const msg = await (channel as any).messages.fetch(ref.messageId);
          await msg.edit(`${ref.deliveredText}\n${line}`);
          const correctionMark = icons.reaction("search");
          if (correctionMark) {
            try {
              await msg.react(correctionMark);
            } catch {
            }
          }
          return;
        }
      } catch (error) {
        this.log.warn(
          { agent: raw.agentName, error: error instanceof Error ? error.message : String(error) },
          "applyFinancialCorrection: draft annotation edit failed — posting note (non-fatal)",
        );
      }
    }
    await this.postFinancialCorrection({ channelId: raw.channelId, text: raw.fallbackText });
  }

  /** 2026-08-28 — one `🧾 Sources · N` row for the message that carries it (label from sourcesButtonLabel). */
  // ───────────────────── 999.160 v1.2 — icons (application emojis) ─────────────────────
  /** Load the bot's application emojis into the icon registry. Never throws. */
  async loadIcons(): Promise<number> {
    try {
      const app = this.client.application;
      if (!app) return 0;
      const col = await app.emojis.fetch();
      icons.setAll([...col.values()].map((e) => ({ id: e.id, name: e.name ?? "" })));
      this.log.info({ icons: icons.size() }, "icons: application emoji set loaded");
      return icons.size();
    } catch (err) {
      this.log.warn({ error: err instanceof Error ? err.message : String(err) }, "icons: load failed — text-only until the next load");
      return 0;
    }
  }

  /** Upload the missing icons as application emojis (`clawcode icons sync`), then reload the registry. */
  async syncIcons(files: ReadonlyArray<{ readonly name: string; readonly png: string }>): Promise<IconSyncResult> {
    const app = this.client.application;
    if (!app) throw new Error("Discord application not available (bridge not ready)");
    const have = new Set([...(await app.emojis.fetch()).values()].map((e) => e.name));
    const created: string[] = [];
    const existing: string[] = [];
    const failed: { name: string; error: string }[] = [];
    for (const f of files) {
      if (!isIconEmojiName(f.name)) {
        failed.push({ name: f.name, error: "invalid emoji name (cc_[a-z0-9_]{1,29})" });
        continue;
      }
      if (have.has(f.name)) {
        existing.push(f.name);
        continue;
      }
      try {
        await app.emojis.create({ attachment: Buffer.from(f.png, "base64"), name: f.name });
        created.push(f.name);
      } catch (err) {
        failed.push({ name: f.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    await this.loadIcons();
    this.log.info({ created: created.length, existing: existing.length, failed: failed.length }, "icons: sync complete");
    return { created, existing, failed };
  }

  // ───────────────────── Phase 999.160 — reply actions ─────────────────────
  private readonly replyActions = new ReplyActionRegistry();
  /** 999.160 v1.3 — latest delivered reply per channel (typed "shorter" target). */
  private readonly lastReplies = new LastReplyTracker();
  /** 999.178 R1 — Retry buttons on failed-turn notices (own registry + prefix). */
  private readonly retryActions = new RetryActionRegistry();

  /** Evaluate the deterministic triggers for a delivered reply. Never throws. */
  private replyActionsFor(agentName: string, text: string, nSources: number, message: Message, proposed: readonly ReplyAction[] = []): readonly ReplyAction[] {
    try {
      const durationMs = Math.max(0, Date.now() - message.createdTimestamp);
      return evaluateReplyActions({ text, nSources, durationMs, chunked: false, proposed });
    } catch (err) {
      this.log.warn({ agent: agentName, error: err instanceof Error ? err.message : String(err) }, "reply-actions: evaluate failed");
      return [];
    }
  }

  /** Register the shown row (single-use, addressee-only) and schedule its removal after the TTL. */
  private registerReplyActions(
    delivered: Message,
    original: Message,
    agentName: string,
    channelId: string,
    actions: readonly ReplyAction[],
    keepRows: readonly unknown[],
    replyText?: string,
  ): void {
    this.replyActions.register({
      messageId: delivered.id,
      channelId,
      agentName,
      userId: original.author.id,
      originalMessageId: original.id,
      actions,
      keepRows,
      ...(replyText !== undefined ? { replyText } : {}),
    });
    this.log.info(
      { agent: agentName, messageId: delivered.id, kinds: actions.map((a) => a.kind), triggers: actions.map((a) => a.trigger) },
      "reply-actions: shown",
    );
    const timer = setTimeout(() => {
      const entry = this.replyActions.expire(delivered.id);
      if (!entry) return; // consumed by a click
      delivered.edit({ components: entry.keepRows as never }).catch(() => {
        /* message deleted or no longer editable — nothing to remove */
      });
    }, REPLY_ACTION_TTL_MS);
    timer.unref?.();
  }

  // ───────────────────── 999.178 R1 — failure Retry button ─────────────────────

  /**
   * Post a failed-turn notice carrying a Retry button, and register it so a
   * click re-dispatches the exact message the model saw. The notice is a fresh
   * bot message — `channel.send` returns the Message to attach the button to,
   * which `sendResponse` cannot (it routes through the delivery queue and
   * returns void). Fire-and-forget: a post failure leaves the FAILED reaction
   * as the durable signal. Skips empty reasons and unsendable channels.
   */
  private async postRetryNotice(args: {
    readonly original: Message;
    readonly agentName: string;
    readonly channelId: string;
    readonly reason: string;
    readonly replayMessage: string;
  }): Promise<void> {
    const reason = args.reason.trim();
    if (reason.length === 0) return;
    const channel = args.original.channel;
    if (!("send" in channel) || typeof channel.send !== "function") return;
    try {
      // The button's custom_id needs the notice message id, which only exists
      // after the send — post the reason (plain text), then edit the button in
      // (the same post-then-attach shape the reply-action rows use).
      const notice = (await channel.send(reason)) as Message;
      const row = buildRetryButtonRow(notice.id);
      await notice.edit({ content: reason, components: [row as never] }).catch(() => {
        /* button attach failed — the plain reason still stands */
      });
      this.registerRetry(notice, args.original, args.agentName, args.channelId, args.replayMessage);
    } catch (err) {
      this.log.warn(
        { agent: args.agentName, error: err instanceof Error ? err.message : String(err) },
        "retry-notice: failed to post failure notice (non-fatal)",
      );
    }
  }

  /** Register a Retry entry and schedule the button's removal after the TTL. */
  private registerRetry(
    notice: Message,
    original: Message,
    agentName: string,
    channelId: string,
    replayMessage: string,
  ): void {
    this.retryActions.register({
      noticeMessageId: notice.id,
      channelId,
      agentName,
      userId: original.author.id,
      originalMessageId: original.id,
      replayMessage,
    });
    const timer = setTimeout(() => {
      const entry = this.retryActions.forget(notice.id);
      if (!entry) return; // consumed by a click
      notice.edit({ components: [] }).catch(() => {
        /* message deleted or no longer editable */
      });
    }, RETRY_ACTION_TTL_MS);
    timer.unref?.();
  }

  /**
   * Handle a Retry button click. Auth = the original author or a configured
   * admin id (the router passes the operator allowlist). Single-use: the
   * click consumes the entry and the button is removed. Re-dispatches the
   * ORIGINAL turn with the message the model saw — exactly as the crash-
   * recovery path re-invokes streamAndPostResponse — after clearing the
   * noticed-once mark so a re-failure can post a fresh notice.
   */
  async handleRetryButton(
    interaction: import("discord.js").MessageComponentInteraction,
    adminIds: readonly string[] = [],
  ): Promise<void> {
    // Validate WITHOUT consuming, so a click that lands while the agent is busy
    // keeps its button for later.
    const outcome = this.retryActions.peek(interaction.customId, interaction.user.id, adminIds);
    if (outcome.kind !== "ok") {
      const text =
        outcome.kind === "not-yours"
          ? "Only the person who sent that message can retry it."
          : outcome.kind === "expired"
            ? "That retry is no longer available — send the message again."
            : "Unknown button.";
      await interaction.reply({ content: text, flags: 64 as never }).catch(() => {});
      return;
    }
    const { entry } = outcome;
    // Busy-guard: never re-dispatch while the agent still has a turn running
    // (another message, or an auto-rerun of THIS one). Keep the button + entry;
    // the user can tap again once it settles.
    if (this.sessionManager.hasActiveTurn(entry.agentName)) {
      await interaction.reply({ content: "Still working on it — try again when it finishes.", flags: 64 as never }).catch(() => {});
      return;
    }
    // Dedupe: a second click on the same notice while its retry is dispatching
    // is a no-op (guards the window before the agent registers the new turn).
    if (!this.retryActions.beginRetry(entry.noticeMessageId)) {
      await interaction.reply({ content: "Already retrying that one…", flags: 64 as never }).catch(() => {});
      return;
    }
    try {
      try {
        await interaction.deferUpdate();
      } catch {
        /* already acknowledged */
      }
      // Single-use: drop the button and consume the entry so it can't be reused.
      await interaction.message.edit({ components: [] }).catch(() => {});
      this.retryActions.consume(entry.noticeMessageId);
      const channel = interaction.channel;
      if (!channel || !("messages" in channel)) return;
      let original: Message;
      try {
        original = (await channel.messages.fetch(entry.originalMessageId)) as Message;
      } catch (err) {
        this.log.warn(
          { agent: entry.agentName, error: err instanceof Error ? err.message : String(err) },
          "retry-button: original message gone — cannot re-dispatch",
        );
        await interaction.followUp({ content: "That message is gone — send it again.", flags: 64 as never }).catch(() => {});
        return;
      }
      // A re-failure must be able to post a fresh notice for the same message id.
      this.forgetNoticedOnce(entry.originalMessageId);
      // The failure path left ❌ on the original message and dropped it from the
      // queued set; re-arm it (❌ → ⏳ → 👍 → ✅ as the retry runs) exactly as the
      // crash-recovery / wedge auto-rerun paths do before re-dispatching.
      this.queuedMessageIds.add(original.id);
      void this.transitionIcon(original, "QUEUED");
      const collector = this.sessionManager.getTraceCollector(entry.agentName);
      const turn = collector?.startTurn(
        `${DISCORD_SNOWFLAKE_PREFIX}${entry.originalMessageId}:retry`,
        entry.agentName,
        entry.channelId,
      );
      this.log.info(
        { agent: entry.agentName, originalMessageId: entry.originalMessageId, clicker: interaction.user.id },
        "retry-button: re-dispatching failed turn",
      );
      await this.streamAndPostResponse(original, entry.agentName, entry.replayMessage, turn);
    } finally {
      this.retryActions.endRetry(entry.noticeMessageId);
    }
  }

  /**
   * Phase 999.172 — offer a delivered reply to the prompt-suggestion sink. Only
   * when the agent's suggestions are on (override beats yaml; a thread session
   * reads its parent's). The attach runs when (if) the stream side delivers a
   * suggestion for the same turn id — see attachPromptSuggestion.
   */
  private registerSuggestionTarget(args: {
    readonly turnId: string;
    readonly delivered: Message;
    readonly original: Message;
    readonly agentName: string;
    readonly channelId: string;
    readonly shownActions: readonly ReplyAction[];
    readonly ledgerRow: unknown;
    readonly replyText: string;
  }): void {
    try {
      if (!this.promptSuggestionsOn(args.original, args.agentName)) return;
      registerSuggestionReply(args.turnId, {
        agentName: args.agentName,
        messageId: args.delivered.id,
        attach: (suggestion) => this.attachPromptSuggestion(args, suggestion),
      });
    } catch (err) {
      this.log.warn(
        { agent: args.agentName, error: err instanceof Error ? err.message : String(err) },
        "prompt-suggestion: could not register the reply",
      );
    }
  }

  /** 999.172 — suggestions render gate, read per message like live thinking. */
  private promptSuggestionsOn(message: Message, sessionName: string): boolean {
    const uxAgent = this.uxFeatureAgentFor(message, sessionName);
    const cfg = this.sessionManager.getAgentConfig(uxAgent);
    return resolveUxFeature(uxAgent, "promptSuggestions", cfg?.uxFeatures).enabled;
  }

  /**
   * 999.172 — append the suggestion as one button under the delivered reply.
   * Existing buttons keep their positions (customIds are positional); the
   * row's expiry is unchanged; a full row, a consumed row, or a duplicate is
   * skipped. A reply that had no buttons gets a suggestion-only row with the
   * normal TTL. Journaled as `prompt-suggestion: shown|dropped(<reason>)`.
   */
  private async attachPromptSuggestion(
    args: {
      readonly turnId: string;
      readonly delivered: Message;
      readonly original: Message;
      readonly agentName: string;
      readonly channelId: string;
      readonly shownActions: readonly ReplyAction[];
      readonly ledgerRow: unknown;
      readonly replyText: string;
    },
    suggestion: string,
  ): Promise<void> {
    const drop = (reason: string): void => {
      this.log.info({ agent: args.agentName, turnId: args.turnId, messageId: args.delivered.id, reason }, `prompt-suggestion: dropped(${reason})`);
    };
    // Render gate re-checked at attach time: a toggle-off in the meantime wins.
    if (!this.promptSuggestionsOn(args.original, args.agentName)) return drop("toggled-off");
    const built = suggestionAction(suggestion);
    if (built.kind === "drop") return drop(built.reason);
    const action = built.action;
    let actions: readonly ReplyAction[];
    if (args.shownActions.length > 0) {
      const out = this.replyActions.append(args.delivered.id, action);
      if (out.kind !== "ok") return drop(out.kind === "missing" ? "row-consumed" : out.kind === "full" ? "row-full" : out.kind);
      actions = out.entry.actions;
    } else {
      this.registerReplyActions(
        args.delivered,
        args.original,
        args.agentName,
        args.channelId,
        [action],
        args.ledgerRow ? [args.ledgerRow] : [],
        args.replyText,
      );
      actions = [action];
    }
    const rows = [args.ledgerRow, buildReplyActionRow(args.delivered.id, actions)].filter((r) => r !== undefined);
    try {
      await args.delivered.edit({ components: rows as never });
    } catch (err) {
      this.log.warn(
        { agent: args.agentName, turnId: args.turnId, error: err instanceof Error ? err.message : String(err) },
        "prompt-suggestion: dropped(edit-failed)",
      );
      return;
    }
    this.log.info(
      { agent: args.agentName, turnId: args.turnId, messageId: args.delivered.id, label: action.label, chars: action.message.length },
      "prompt-suggestion: shown",
    );
  }

  /**
   * A reply-action click. Gated to the addressee; single-use; the row is removed
   * first so a double-tap cannot dispatch twice. The canonical message then
   * re-enters the ORDINARY turn pipeline as a synthetic user message on the
   * original user message — typing, streaming, memory, footers and the next
   * set of buttons all happen exactly as if the user had typed it.
   */
  async handleReplyActionButton(interaction: MessageComponentInteraction): Promise<void> {
    const outcome = this.replyActions.click(interaction.customId, interaction.user.id);
    if (outcome.kind !== "ok") {
      const text =
        outcome.kind === "not-yours"
          ? "Those buttons belong to the person the reply was for."
          : outcome.kind === "expired"
            ? "That button has expired — just tell me in words."
            : "Unknown button.";
      await interaction.reply({ content: text, flags: 64 as never }).catch(() => {});
      return;
    }
    const { entry, action } = outcome;
    try {
      await interaction.deferUpdate();
    } catch {
      /* already acknowledged */
    }
    await interaction.message.edit({ components: entry.keepRows as never }).catch(() => {});
    this.log.info(
      { agent: entry.agentName, messageId: entry.messageId, kind: action.kind, trigger: action.trigger, latencyMs: Date.now() - entry.shownAt },
      "reply-actions: clicked",
    );
    if (action.kind === "suggestion") {
      this.log.info({ agent: entry.agentName, messageId: entry.messageId, latencyMs: Date.now() - entry.shownAt }, "prompt-suggestion: clicked");
    }
    // v1.3 — Shorter replaces the reply in place (haiku rewrite + edit); any
    // failure falls through to the ordinary synthetic turn below.
    if (action.kind === "shorter" && entry.replyText !== undefined) {
      const done = await this.shortenInPlace({
        channelId: entry.channelId,
        agentName: entry.agentName,
        userId: entry.userId,
        text: entry.replyText,
        target: interaction.message as Message,
        keepRows: entry.keepRows,
        source: "button",
      });
      if (done) return;
    }
    const channel = interaction.channel;
    if (!channel || !("messages" in channel)) return;
    let original: Message;
    try {
      original = (await channel.messages.fetch(entry.originalMessageId)) as Message;
    } catch (err) {
      this.log.warn({ agent: entry.agentName, error: err instanceof Error ? err.message : String(err) }, "reply-actions: original message gone");
      await interaction.followUp({ content: `Say "${action.message}" and I'll do it.`, flags: 64 as never }).catch(() => {});
      return;
    }
    await this.dispatchSyntheticUserTurn(original, entry.agentName, action.message, action.kind);
  }

  /**
   * Dispatch `text` as if `original`'s author had sent it. The synthetic message
   * inherits everything from the real one (author, channel, reactions, reply
   * target) except its content; attachments and reply-reference are cleared so
   * nothing is re-ingested. Same tail as the channel route: prepare → trace →
   * streamAndPostResponse.
   */
  private async dispatchSyntheticUserTurn(original: Message, agentName: string, text: string, kind: string): Promise<void> {
    const synthetic = Object.create(original, {
      content: { value: text, enumerable: true },
      attachments: { value: new Map(), enumerable: true },
      reference: { value: null, enumerable: true },
    }) as Message;
    const inbound = await this.prepareInboundMessage(synthetic, agentName);
    if (inbound.kind === "folded") return;
    const collector = this.sessionManager.getTraceCollector(agentName);
    const turn = collector?.startTurn(`${DISCORD_SNOWFLAKE_PREFIX}${original.id}:ra-${kind}`, agentName, original.channelId);
    await this.streamAndPostResponse(synthetic, agentName, inbound.formattedMessage, turn);
  }

  /** Fetch a message in the same channel as `like`, or null when it is gone. */
  private async fetchMessageOrNull(like: Message, messageId: string): Promise<Message | null> {
    try {
      const channel = like.channel;
      if (!("messages" in channel)) return null;
      return (await channel.messages.fetch(messageId)) as Message;
    } catch {
      return null;
    }
  }

  /**
   * 999.160 v1.3 — rewrite a delivered reply shorter and edit it in place.
   * Haiku on the fast lane's trimmed spawn (seconds), then ONE edit of the
   * original message (short text + a "shortened" note, action row dropped,
   * `keepRows` such as the ledger row kept). The short version is captured to
   * the conversation store as its own exchange. Returns false — and changes
   * nothing — whenever the rewrite is unusable, so the caller can fall back.
   */
  private async shortenInPlace(args: {
    readonly channelId: string;
    readonly agentName: string;
    readonly userId: string;
    readonly text: string;
    readonly target: Message;
    readonly keepRows: readonly unknown[];
    readonly source: "button" | "typed";
  }): Promise<boolean> {
    if (args.text.trim().length < SHORTEN_MIN_SOURCE_CHARS) return false;
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let raw = "";
    try {
      raw = await callHaikuDirect(SHORTEN_SYSTEM_PROMPT, buildShortenPrompt(args.text), { signal: controller.signal, maxTokens: 400, trimmedStartup: true }, "fast-lane");
    } catch (err) {
      this.log.warn({ agent: args.agentName, error: err instanceof Error ? err.message : String(err) }, "reply-actions: shorten call failed — falling back");
      return false;
    } finally {
      clearTimeout(timer);
    }
    const parsed = parseShortened(raw, args.text);
    if (parsed.kind !== "ok") {
      this.log.info({ agent: args.agentName, reason: parsed.reason, source: args.source }, "reply-actions: shorten unusable — falling back");
      return false;
    }
    const content = appendAdvisorSubtext(parsed.text, shortenedNote());
    try {
      await args.target.edit({ content, components: args.keepRows as never });
    } catch (err) {
      this.log.warn({ agent: args.agentName, error: err instanceof Error ? err.message : String(err) }, "reply-actions: in-place edit failed — falling back");
      return false;
    }
    const convStore = this.sessionManager.getConversationStore(args.agentName);
    const sessionId = this.sessionManager.getActiveConversationSessionId(args.agentName);
    if (convStore && sessionId) {
      try {
        captureDiscordExchange({
          convStore,
          sessionId,
          userContent: "shorter",
          assistantContent: parsed.text,
          channelId: args.channelId,
          discordUserId: args.userId,
          discordMessageId: args.target.id,
          isTrustedChannel: true,
          log: this.log,
          agentName: args.agentName,
        });
      } catch (err) {
        this.log.warn({ agent: args.agentName, error: err instanceof Error ? err.message : String(err) }, "reply-actions: shorten capture failed");
      }
    }
    this.lastReplies.record({ channelId: args.channelId, messageId: args.target.id, agentName: args.agentName, userId: args.userId, text: parsed.text });
    this.log.info(
      { agent: args.agentName, messageId: args.target.id, source: args.source, durationMs: Date.now() - t0, from: args.text.length, to: parsed.text.length },
      "reply-actions: shortened in place",
    );
    return true;
  }

  private ledgerButtonRow(messageId: string, label: string): unknown {
    const button = new ButtonBuilder()
      .setCustomId(`${VSRC_PREFIX}${messageId}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary);
    // 999.160 v1.2 — icon from the application emoji set; text-only otherwise.
    // Operator (2026-09-23): "receipt" reads as a bill — sources/recall is a book.
    const book = icons.button("book");
    if (book) button.setEmoji({ id: book.id, name: book.name });
    return new ActionRowBuilder<ButtonBuilder>().addComponents(button).toJSON();
  }

  /**
   * Substantial reply = 2+ sources or any recorded claim (operator decision);
   * Phase 999.133 — or any recalled memory on the ledger.
   */
  private ledgerButtonWanted(agentName: string, ledger: TurnLedger): { on: boolean; nSources: number; label: string } {
    const ux = (this.sessionManager.getAgentConfig(agentName) as { verification?: { ux?: { ledgerButton?: boolean } } } | undefined)
      ?.verification?.ux;
    const nSources = selectSources(ledger.evidence, ledger.claims).length;
    const nClaims = ledger.claims.filter((c) => c.effectiveVerdict !== "not-a-claim").length;
    const verificationOn = ux?.ledgerButton === true && (nSources >= 2 || nClaims >= 1);
    const on = verificationOn || ledger.recall !== undefined;
    return { on, nSources, label: sourcesButtonLabel(verificationOn ? nSources : 0, ledger.recall) };
  }

  /** Phase 999.133 — how an agent shows recalled memory: the 🧾 button (default) or the italic footer. */
  private recallDisplayFor(agentName: string): "button" | "footer" {
    try {
      const cfg = (this.sessionManager as { getAgentConfig?: (n: string) => { memoryRecallDisplay?: string } | undefined })
        .getAgentConfig?.(agentName);
      return cfg?.memoryRecallDisplay === "footer" ? "footer" : "button";
    } catch {
      return "button";
    }
  }

  private async attachLedgerButton(
    agentName: string,
    channelId: string,
    kind: "webhook" | "bot",
    messageId: string,
  ): Promise<void> {
    try {
      const ledger = this.ledgerStore.byMessageId(messageId);
      if (!ledger) return;
      const want = this.ledgerButtonWanted(agentName, ledger);
      if (!want.on) return;
      const row = this.ledgerButtonRow(messageId, want.label);
      if (kind === "webhook") {
        if (!this.webhookManager) return;
        await this.webhookManager.editMessageComponents(agentName, messageId, [row]);
      } else {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel || !("messages" in channel)) return;
        const msg = await (channel as any).messages.fetch(messageId);
        await msg.edit({ components: [row] });
      }
      this.log.info({ tag: "phase999.63-ledger-button", agent: agentName, messageId, kind, sources: want.nSources }, "ledger button attached (follow-up edit)");
    } catch (err) {
      this.log.debug(
        { agent: agentName, messageId, kind, error: err instanceof Error ? err.message : String(err) },
        "ledger button follow-up edit failed (non-fatal)",
      );
    }
  }

  private async tryChunkEditCorrection(args: {
    agentName: string;
    originalResponse: string;
    correctedText: string;
    footer: string;
  }): Promise<boolean> {
    try {
      const plan = planChunkEdits({
        refs: this.chunkRefs.refsFor(args.agentName, Date.now()),
        originalResponse: args.originalResponse,
        correctedText: args.correctedText,
        footer: args.footer,
      });
      if (!plan) return false;
      if (
        plan.edits.some((e) => e.kind === "webhook") &&
        !this.webhookManager
      ) {
        return false;
      }
      for (const e of plan.edits) {
        if (e.kind === "webhook") {
          await this.webhookManager!.editMessageRaw(
            args.agentName,
            e.messageId,
            e.text,
          );
        } else {
          const channel = await this.client.channels.fetch(e.channelId);
          if (!channel || !("messages" in channel)) return false;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msg = await (channel as any).messages.fetch(e.messageId);
          await msg.edit(e.text);
        }
      }
      try {
        const channel = await this.client.channels.fetch(plan.reactChannelId);
        if (channel && "messages" in channel) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msg = await (channel as any).messages.fetch(
            plan.reactMessageId,
          );
          const correctionMark = icons.reaction("search");
          if (correctionMark) await msg.react(correctionMark);
        }
      } catch {
        // Reaction is cosmetic.
      }
      this.log.info(
        { agent: args.agentName, chunkEdits: plan.edits.length },
        "applyFinancialCorrection: chunk-level in-place correction applied",
      );
      return true;
    } catch (error) {
      this.log.warn(
        {
          agent: args.agentName,
          error: error instanceof Error ? error.message : String(error),
        },
        "applyFinancialCorrection: chunk-edit failed — falling back to note post (non-fatal)",
      );
      return false;
    }
  }

  /**
   * 999.63d/4 — record the per-chunk message refs of a chunked delivery
   * (called by the daemon's deliverFn after a successful webhook send).
   * Skips silently when ids and chunks desynced (uncertain mapping is
   * worse than no mapping — the correction path then falls back to the
   * compact note, today's behaviour).
   */
  recordChunkedDelivery(args: {
    agentName: string;
    channelId: string;
    kind: "webhook" | "bot";
    chunks: readonly string[];
    messageIds: readonly string[];
  }): void {
    try {
      if (
        args.chunks.length === 0 ||
        args.chunks.length !== args.messageIds.length
      ) {
        return;
      }
      const at = Date.now();
      const refs: ChunkRef[] = args.chunks.map((text, i) => ({
        messageId: args.messageIds[i]!,
        channelId: args.channelId,
        kind: args.kind,
        text,
        at,
      }));
      this.chunkRefs.record(args.agentName, refs);
      const linked = this.ledgerStore.linkLatest(args.agentName, args.messageIds);
      // 2026-08-28 — the 🧾 button used to exist only on the bot edit-in-place
      // exit; chunked / webhook / thread deliveries get it as a follow-up edit
      // of the LAST chunk once the ids are known. Fail-open, misses logged.
      if (linked) {
        const lastId = args.messageIds[args.messageIds.length - 1]!;
        void this.attachLedgerButton(args.agentName, args.channelId, args.kind, lastId);
      }
    } catch {
      // Observational only.
    }
  }

  /**
   * 999.63d — append the "-# Verifying…" pending marker to the
   * delivered message while the corrective hop runs behind it. Uses
   * `peek` (NON-consuming — `applyFinancialCorrection` still owns the
   * single-shot `consume`). Returns the message coordinates for the
   * later `removeFinancialPendingMarker` call, or null when the marker
   * could not (safely) be appended. Fully fail-open.
   */
  async appendFinancialPendingMarker(args: {
    agentName: string;
    turnId: string | null;
  }): Promise<{ messageId: string; channelId: string } | null> {
    try {
      if (!args.turnId) return null;
      const ref = this.deliveredRefs.peek(args.turnId, Date.now());
      if (!ref) return null;
      const channel = await this.client.channels.fetch(ref.channelId);
      if (!channel || !("messages" in channel)) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = await (channel as any).messages.fetch(ref.messageId);
      const decision = decidePendingMarkerAppend({
        ref,
        liveContent: typeof msg.content === "string" ? msg.content : "",
      });
      if (decision.kind !== "append") {
        this.log.debug(
          { agent: args.agentName, reason: decision.reason },
          "appendFinancialPendingMarker: skipped",
        );
        return null;
      }
      await msg.edit(decision.editText);
      return { messageId: decision.messageId, channelId: decision.channelId };
    } catch (error) {
      this.log.debug(
        {
          agent: args.agentName,
          error: error instanceof Error ? error.message : String(error),
        },
        "appendFinancialPendingMarker: failed (non-fatal)",
      );
      return null;
    }
  }

  /**
   * 999.63d — strip the pending marker after the hop settles. Stateless
   * and idempotent: only edits when the live content still ENDS WITH the
   * marker (a correction edit that already replaced the content makes
   * this a no-op). `verified: true` additionally reacts ✅ (the hop
   * confirmed the claims — the false-positive cost converts into a
   * visible "checked" signal). Fully fail-open.
   */
  async removeFinancialPendingMarker(args: {
    agentName: string;
    messageId: string;
    channelId: string;
    verified: boolean;
  }): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(args.channelId);
      if (!channel || !("messages" in channel)) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = await (channel as any).messages.fetch(args.messageId);
      const content = typeof msg.content === "string" ? msg.content : "";
      let next = content.endsWith(PENDING_MARKER) ? content.slice(0, -PENDING_MARKER.length) : content;
      // 2026-08-28 — a late verified verdict upgrades the merged footer line.
      // 999.151 — word-led heads (the glyph alternative covers messages
      // delivered before that change).
      if (args.verified) {
        next = replaceVerificationLine(next, (l) =>
          l.replace(/^-# (?:Checked|🔎 checked)\b/u, "-# Re-checked"),
        );
      }
      if (next !== content) {
        await msg.edit(next);
      }
      // 2026-08-28 — the post-hoc hop's verify_claim records landed on the
      // ended turn (claims lookback); refresh the persisted ledger so the 🧾
      // card shows them.
      try {
        const ledger = this.ledgerStore.byMessageId(args.messageId);
        if (ledger && this.turnDispatcher) {
          const snap = this.turnDispatcher.getLedgerSnapshot(args.agentName);
          if (snap.claims.length > 0) this.ledgerStore.updateClaims(ledger.turnId, snap.claims);
        }
      } catch {
      }
      if (args.verified && !this.verdictReactionsOwnBadges(args.agentName)) {
        const verifiedMark = icons.reaction("circle_check");
        if (verifiedMark) {
          try {
            await msg.react(verifiedMark);
          } catch {
            // Reaction is cosmetic — never escalate.
          }
        }
      }
    } catch (error) {
      this.log.debug(
        {
          agent: args.agentName,
          error: error instanceof Error ? error.message : String(error),
        },
        "removeFinancialPendingMarker: failed (non-fatal)",
      );
    }
  }

  /**
   * 999.63d — ✅ verified-inline badge: reacts on the delivered message
   * when the gate saw positive verification evidence (cited rule claims
   * / tool-verified figures) and nothing was flagged. `peek` — the ref
   * stays available for any later machinery. Fail-open.
   */
  async applyVerifiedBadge(args: {
    agentName: string;
    turnId: string | null;
  }): Promise<void> {
    try {
      if (!args.turnId) return;
      const ref = this.deliveredRefs.peek(args.turnId, Date.now());
      if (!ref || ref.kind !== "bot") return;
      if (this.verdictReactionsOwnBadges(args.agentName)) return;
      const channel = await this.client.channels.fetch(ref.channelId);
      if (!channel || !("messages" in channel)) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = await (channel as any).messages.fetch(ref.messageId);
      const verifiedMark = icons.reaction("circle_check");
      if (verifiedMark) await msg.react(verifiedMark);
    } catch (error) {
      this.log.debug(
        {
          agent: args.agentName,
          error: error instanceof Error ? error.message : String(error),
        },
        "applyVerifiedBadge: failed (non-fatal)",
      );
    }
  }

  /**
   * Quick task 260521-5gh Gap 2 — deliver an agent crash alert to a Discord
   * channel as a plain standalone message.
   *
   * Mirrors {@link postFinancialCorrection}: reuses the same
   * `client.channels.fetch` + `channel.send` chain. The caller builds the
   * alert text (a non-terminal "crashed (attempt N)" line, or a louder
   * terminal "FAILED after max retries" line) — the bridge just delivers it.
   *
   * Fail-open: a null channelId, an unsendable channel, or a `send` that
   * throws is a logged no-op. A failed crash alert must NEVER throw back
   * into the (fire-and-forget) recovery path.
   */
  async sendCrashAlert(args: {
    channelId: string | null;
    text: string;
  }): Promise<void> {
    const { channelId, text } = args;
    if (!channelId) {
      this.log.warn(
        {},
        "sendCrashAlert: no channelId — crash alert not posted",
      );
      return;
    }
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !("send" in channel) || typeof channel.send !== "function") {
        this.log.warn(
          { channelId },
          "sendCrashAlert: channel not sendable — crash alert not posted",
        );
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (channel as any).send(text);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(
        { channelId, error: errorMsg },
        "sendCrashAlert: send failed (non-fatal)",
      );
    }
  }

  /**
   * Phase 135.5 — resolve a Discord user's display name from a guild
   * member cache (preferred) or via members.fetch (fallback). Returns
   * the userId as a last resort so the caller always has a usable
   * string. Never throws.
   */
  private async resolveVoiceDisplayName(
    userId: string,
    guildId: string,
  ): Promise<string> {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) return userId;
      const cached = guild.members.cache.get(userId);
      if (cached) {
        return cached.displayName ?? cached.user.username ?? userId;
      }
      const fetched = await guild.members.fetch(userId).catch(() => undefined);
      return fetched?.displayName ?? fetched?.user.username ?? userId;
    } catch {
      return userId;
    }
  }

  /**
   * Phase 135.5 — send a plain text line to a channel with a hard
   * timeout. Used for the USER-HALF voice transcript post so a slow
   * Discord API call never lets the fire-and-forget promise dangle past
   * the next turn. Throws on timeout or non-sendable channel — caller
   * is responsible for catch+warn.
   */
  private async postWithTimeout(
    channelId: string,
    text: string,
    timeoutMs: number,
  ): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("send" in channel) || typeof channel.send !== "function") {
      throw new Error(`postWithTimeout: channel ${channelId} not sendable`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendPromise = (channel as any).send(text) as Promise<unknown>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sendPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`post timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Phase 135.5 — post a paired user/agent voice-turn transcript to the
   * agent's primary text channel. Failures are caught + logged at warn.
   * NEVER throws — voice flow continues regardless.
   *
   * Posted ONLY when:
   *  - voice.transcriptToChannel === true on the agent's voiceCfg
   *  - agentConfig.channels[0] exists
   *
   * The agent-half is skipped when session.fallbackSpoken is true (the
   * agent's reply was suppressed to avoid talking over Haiku — posting
   * it would mislead the reader). The agent-half is also skipped when
   * the response is empty.
   *
   * The user-half is fire-and-forget at the API level (wrapped in a
   * detached `void (async () => ...)()`) so the caller in
   * handleVoiceTranscript never waits on a Discord API call. The
   * detached promise is given a 5s timeout + .catch so it can't dangle
   * or surface as an unhandled rejection.
   */
  private async postVoiceTurnTranscript(args: {
    readonly agentName: string;
    readonly voiceSession: import("./voice/session.js").VoiceSession;
    readonly voiceUserId: string;
    readonly transcript: string;
    readonly agentResponse: string | undefined;
    readonly fallbackSpoken: boolean;
  }): Promise<void> {
    // Fast-path: feature disabled. Same shape as the early-return in
    // checkChannelAccess — single resolver, exit early.
    const agentCfg = this.sessionManager.getAgentConfig(args.agentName);
    if (!agentCfg?.voice?.transcriptToChannel) return;

    const channels = agentCfg.channels ?? [];
    if (channels.length === 0) {
      if (!this.voiceTranscriptToChannelWarnedAgents.has(args.agentName)) {
        this.voiceTranscriptToChannelWarnedAgents.add(args.agentName);
        this.log.info(
          { agent: args.agentName },
          "voice.transcriptToChannel=true but agent has no text channels — skipping voice transcript posts",
        );
      }
      return;
    }

    const targetChannel = channels[0]!;

    if (args.agentResponse === undefined) {
      // USER-HALF: fire-and-forget. The detached IIFE wrapper means
      // this function returns immediately; the Discord API call runs
      // off the voice-turn critical path.
      void (async () => {
        try {
          const displayName = await this.resolveVoiceDisplayName(
            args.voiceUserId,
            args.voiceSession.guildId,
          );
          const userLine = `🎙️ **${displayName}:** ${args.transcript}`;
          await this.postWithTimeout(targetChannel, userLine, 5000);
        } catch (err) {
          this.log.warn(
            {
              agent: args.agentName,
              error: err instanceof Error ? err.message : String(err),
            },
            "voice user-half post failed",
          );
        }
      })();
      return;
    }

    // AGENT-HALF.
    if (args.fallbackSpoken || args.agentResponse.trim().length === 0) {
      this.log.debug(
        {
          agent: args.agentName,
          fallbackSpoken: args.fallbackSpoken,
          responseLen: args.agentResponse.length,
        },
        "voice agent-half post suppressed (fallback fired or empty response)",
      );
      return;
    }

    const agentLine = `💬 **${args.agentName}:** ${args.agentResponse}`;
    try {
      await this.sendAgentMessageToChannel(
        args.agentName,
        targetChannel,
        agentLine,
      );
    } catch (err) {
      this.log.warn(
        {
          agent: args.agentName,
          error: err instanceof Error ? err.message : String(err),
        },
        "voice agent-half post failed",
      );
    }
  }

  /**
   * Send a response directly to Discord without the delivery queue.
   * Tries webhook first, then falls back to channel.send with splitting.
   */
  private async sendDirect(
    originalMessage: Message,
    response: string,
    resolvedAgent?: string,
  ): Promise<void> {
    // Try webhook delivery if agent has a webhook configured. WebhookManager.send
    // wraps internally — caller does not pre-wrap. Pass raw response through.
    if (resolvedAgent && this.webhookManager?.hasWebhook(resolvedAgent)) {
      await this.webhookManager.send(resolvedAgent, response);
      return;
    }

    // Phase 122 — channel.send fallback (no webhook). Wrap once at the
    // chokepoint so both the single-message and chunked branches inherit
    // the wrap. Idempotent under repeat application.
    const wrapped = formatOutboundText(response);

    const MAX_LENGTH = 2000;
    const channel = originalMessage.channel;

    if (!("send" in channel) || typeof channel.send !== "function") {
      return;
    }

    if (wrapped.length <= MAX_LENGTH) {
      await channel.send(wrapped);
      return;
    }

    const chunks = splitMessage(wrapped, MAX_LENGTH);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  }
}

/**
 * Format a Discord message for the agent, including metadata.
 * When downloadResults are provided, replaces the simple attachment listing
 * with structured metadata from formatAttachmentMetadata, plus multimodal
 * hints for image attachments.
 *
 * Phase 999.13 TZ-04 — `agentTz` (optional) controls the operator-local
 * TZ used in `<channel>` and `<replying-to>` `ts` attributes. When omitted,
 * the renderAgentVisibleTimestamp helper falls back to host TZ (process.env.TZ
 * → Intl.DateTimeFormat().resolvedOptions().timeZone) which is correct on
 * the single-host single-TZ clawdy deployment per RESEARCH.md Pitfall 3.
 *
 * Exported for testing.
 */
/**
 * P1-TOKENCAP — per-turn budget (chars) for injected vision analysis text.
 * ~6000 chars ≈ ~1500 tokens. Bounds injected vision TOKENS per turn,
 * orthogonal to the COUNT cap (P1-EAGERCAP); overflow collapses into one
 * <vision-summary> block.
 */
const MAX_VISION_ANALYSIS_CHARS = 6000;

/** Phase 999.154 — successfully downloaded image attachments, in upload order. */
export function turnImageSourcesFrom(
  downloadResults: readonly DownloadResult[] | undefined,
): TurnImageSource[] {
  if (!downloadResults) return [];
  return downloadResults
    .filter(
      (r): r is DownloadResult & { path: string } =>
        r.success && r.path !== null && isImageAttachment(r.attachmentInfo.contentType),
    )
    .map((r) => ({
      path: r.path,
      filename: r.attachmentInfo.name,
      mimeType: r.attachmentInfo.contentType,
    }));
}

export function formatDiscordMessage(
  message: Message,
  downloadResults?: readonly DownloadResult[],
  referencedMessage?: Message,
  agentTz?: string,
  visionAnalyses?: ReadonlyMap<string, string>,
  opts?: {
    /**
     * Phase 999.154 — images travel as native blocks + a numbered manifest
     * appended at dispatch, so the per-image analysis / path-hint / deferred
     * lines are omitted here (the manifest supersedes them).
     */
    readonly inlineImages?: boolean;
  },
): string {
  const parts = [
    `<channel source="discord" chat_id="${message.channelId}" message_id="${message.id}" user="${message.author.username}" ts="${renderAgentVisibleTimestamp(message.createdAt, agentTz)}">`,
    message.content,
    `</channel>`,
  ];

  // Include attachments: use structured metadata if download results provided
  if (downloadResults && downloadResults.length > 0) {
    const metadata = formatAttachmentMetadata(downloadResults);
    if (metadata) {
      parts.push(`\n${metadata}`);
    }

    // Add vision analysis or a truthful fallback for each downloaded image.
    // P1-EAGERCAP: only the first MAX_EAGER_IMAGES images are analyzed eagerly
    // (vision-pre-pass slices to the same count, so images beyond it are simply
    // absent from the map). P1-TOKENCAP: injected analysis text is bounded to
    // MAX_VISION_ANALYSIS_CHARS per turn; the remainder collapses into one
    // <vision-summary>. The deferred-tail stub is TRUTHFUL — at format time the
    // image has only been QUEUED for ingest (fire-and-forget dispatch runs after
    // this function), so it must NEVER claim "ingested to memory".
    if (opts?.inlineImages !== true) {
    let imageIndex = 0;
    let visionCharsUsed = 0;
    let overflowAnalyses = 0;
    let deferredImages = 0;
    for (const result of downloadResults) {
      if (
        result.success &&
        result.path !== null &&
        isImageAttachment(result.attachmentInfo.contentType)
      ) {
        const analysis = visionAnalyses?.get(result.path);
        if (analysis) {
          if (visionCharsUsed + analysis.length <= MAX_VISION_ANALYSIS_CHARS) {
            parts.push(
              `<screenshot-analysis>\n${analysis}\n</screenshot-analysis>`,
            );
            visionCharsUsed += analysis.length;
          } else {
            // P1-TOKENCAP — budget spent; summarize instead of injecting.
            overflowAnalyses++;
          }
        } else if (imageIndex >= MAX_EAGER_IMAGES) {
          // P1-EAGERCAP — beyond the eager cap; not analyzed this turn.
          deferredImages++;
        } else {
          // Within the eager window but vision missing/failed — keep the
          // existing truthful downloaded-file hint.
          parts.push(
            `(Image downloaded -- read the file at ${result.path} to see its contents)`,
          );
        }
        imageIndex++;
      }
    }
    if (deferredImages > 0) {
      parts.push(
        `[vision deferred — ${deferredImages} more image(s) received this turn, not analyzed — read each one at its local_path above to see it]`,
      );
    }
    if (overflowAnalyses > 0) {
      parts.push(
        `<vision-summary>${overflowAnalyses} additional image analysis/analyses omitted to bound turn context</vision-summary>`,
      );
    }
    }
  } else if (message.attachments.size > 0) {
    // Fallback: simple attachment listing (backward compatible)
    const attachmentList = [...message.attachments.values()]
      .map((a) => `  - ${a.name} (${a.contentType ?? "unknown"}, ${a.size} bytes): ${a.url}`)
      .join("\n");
    parts.push(`\nAttachments:\n${attachmentList}`);
  }

  // Include reply context if this is a reply
  if (message.reference?.messageId) {
    if (referencedMessage) {
      const refUser = referencedMessage.author.username;
      const refContent = referencedMessage.content || "(no text content)";
      const refTs = renderAgentVisibleTimestamp(
        referencedMessage.createdAt,
        agentTz,
      );
      parts.unshift(
        `<replying-to message_id="${message.reference.messageId}" user="${refUser}" ts="${refTs}">\n${refContent}\n</replying-to>`,
      );
    } else {
      // Fallback: ID only when fetch failed or wasn't attempted
      parts.unshift(`(replying to message ${message.reference.messageId})`);
    }
  }

  return parts.join("\n");
}

/**
 * Split a long message into chunks respecting the max length.
 * Tries to split on newlines, falls back to hard split.
 */
function splitMessage(text: string, maxLength: number): readonly string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Try to split at a newline
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex <= 0 || splitIndex < maxLength / 2) {
      // No good newline — try space
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex <= 0 || splitIndex < maxLength / 2) {
      // Hard split
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/** 2026-08-28 — `applyFinancialCorrection` input (was an inline type). */
interface FinancialCorrectionArgs {
  readonly agentName: string;
  readonly channelId: string | null;
  readonly turnId: string | null;
  readonly originalResponse: string;
  readonly correctedText: string;
  readonly fallbackText: string;
  readonly footer: string;
}
