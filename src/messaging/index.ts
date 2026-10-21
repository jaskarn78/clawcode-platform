/**
 * Multi-platform messaging — public surface.
 *
 * See .planning/multi-platform-messaging-PLAN.md for the architecture.
 */
export type {
  PlatformKind,
  InboundMessage,
  InboundAttachment,
  AgentIdentity,
  OutboundOptions,
  MessageHandle,
  TurnStatus,
  PlatformCapabilities,
  MessagingPlatform,
  // Phase 145 WS3 — platform-neutral ask_user_question shapes (Plan 04/06
  // import these to build the Discord/Slack renderers + text fallback).
  NeutralQuestion,
  NeutralQuestionOption,
  NeutralAnswer,
  NeutralAnswers,
  AskQuestionOpts,
} from "./types.js";
export { formatAgentMessage } from "./format.js";
export { splitMessage } from "./split.js";
export {
  buildPlatformRoutingTable,
  getAgentForChannel,
  type PlatformRoutingTable,
  type PlatformBindingEntry,
} from "./router.js";
export { MessagingBridge, type MessagingBridgeConfig } from "./bridge.js";
export { SlackAdapter, type SlackAdapterConfig } from "./slack/adapter.js";
// Phase 145 WS3 (Plan 04) — the shared pending-prompt registry singleton +
// pure helpers. The Discord bridge (Plan 04) and the Slack adapter (Plan 07)
// import the SAME `pendingPromptRegistry` instance so a text-fallback reply on
// either platform resolves the same blocked ask_user_question tool call.
export {
  pendingPromptRegistry,
  PendingPromptRegistry,
  parseTextReply,
  decideRenderMode,
  isOperator,
  type PendingPromptEntry,
  type RegisterArgs,
  type TryResolveResult,
} from "./pending-prompt-registry.js";
