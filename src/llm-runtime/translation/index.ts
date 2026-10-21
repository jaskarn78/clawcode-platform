/**
 * Phase 137 Plan 02 — Translation layer barrel.
 *
 * Single import surface for the Anthropic-block ↔ OpenAI
 * function-calling translation primitives. Plan 03
 * (`CodexAgentCli`) and Plan 05 (streaming normalisation) import
 * everything from this file — they MUST NOT reach into individual
 * module files. Mirrors the Phase 136 `src/llm-runtime/index.ts`
 * discipline.
 *
 * Named re-exports are spelled explicitly so this barrel is also a
 * discoverable inventory of the public translation surface — every
 * function the rest of the codebase may consume appears here by
 * name.
 */

export {
  translateToolsToOpenAI,
  translateToolUseToOpenAI,
  translateToolUseFromOpenAI,
  translateToolResultToOpenAI,
  translateToolResultFromOpenAI,
  translateMessageToOpenAI,
  translateMessageFromOpenAI,
} from "./anthropic-openai.js";

export { IS_ERROR_PREFIX, OPENAI_FIELD_NAMES } from "./constants.js";
export type { OpenAiFieldName } from "./constants.js";

export { normaliseOpenAiSseChunks } from "./streaming.js";
export type {
  NormalisedSseEvent,
  NormalisedContentBlock,
  NormalisedContentDelta,
  StreamingLogger,
} from "./streaming.js";

export type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicTextBlock,
  AnthropicToolBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  JsonSchema,
  OpenAIAssistantMessage,
  OpenAIMessage,
  OpenAIToolCall,
  OpenAIToolFunction,
  OpenAIToolMessage,
  OpenAIUserMessage,
} from "./types.js";
