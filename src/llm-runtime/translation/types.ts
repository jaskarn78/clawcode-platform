/**
 * Phase 137 Plan 02 — Translation layer types.
 *
 * Provider-shape types for the Anthropic block-typed ↔ OpenAI
 * function-calling translation layer. Isolated here so Plan 03
 * (`CodexAgentCli` wire calls) and Plan 05 (streaming
 * normalisation) import a stable, single-file surface.
 *
 * Canonical decision: 137-CONTEXT.md §D2 — auto-translate at the
 * runtime boundary. `cache_control` (Anthropic-only) is dropped on
 * the OpenAI side. Tool-result content arrays collapse to a single
 * string on the OpenAI side. `is_error` is encoded via a
 * `[error] ` prefix sentinel (round-tripped by the reverse helper).
 *
 * Zero runtime dependencies — these are pure structural types.
 */

/**
 * Minimal JSON Schema shape we touch. Translation does NOT validate
 * the schema; it passes the payload through as `parameters` on the
 * OpenAI side. The shape stays `Record<string, unknown>` so we
 * don't accidentally narrow.
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * Anthropic block-typed tool definition — current clawcode shape.
 * `cache_control` is the only Anthropic-only field and is dropped
 * on outbound translation (CONTEXT D2 — "no OpenAI equivalent,
 * safe to drop").
 */
export interface AnthropicToolBlock {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonSchema;
  readonly cache_control?: { readonly type: "ephemeral" };
}

/**
 * Anthropic `tool_use` content block — emitted by the model when
 * it decides to call a tool. The `input` is a structured object;
 * OpenAI receives it as a JSON-stringified wire payload.
 */
export interface AnthropicToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/**
 * Anthropic `tool_result` content block — the harness's reply to a
 * tool_use. Anthropic accepts BOTH string and array-of-text-blocks
 * for `content`; OpenAI accepts only a single string, so the
 * translation collapses the array form by joining on `\n`
 * (documented asymmetric loss — see PLAN T-02 + researcher_todo
 * #5).
 */
export interface AnthropicToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string | ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly is_error?: boolean;
}

/**
 * Plain-text content block. Translation passes these through
 * unchanged on both directions.
 */
export interface AnthropicTextBlock {
  readonly type: "text";
  readonly text: string;
}

/** Union of all content blocks the translation layer handles. */
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

/**
 * Top-level Anthropic message — what `translateMessageToOpenAI`
 * consumes / `translateMessageFromOpenAI` produces.
 */
export interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: ReadonlyArray<AnthropicContentBlock>;
}

/**
 * OpenAI Chat Completions function-calling tool definition.
 * CONTEXT D2 — outbound translation produces this from the
 * Anthropic block; `cache_control` is dropped because the
 * OpenAI API exposes no equivalent prompt-cache hook at the
 * tool-definition layer (researcher_todo #3 verifies on every
 * OpenAI-Version bump).
 */
export interface OpenAIToolFunction {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonSchema;
  };
}

/**
 * OpenAI `tool_call` — appears inside an assistant message's
 * `tool_calls` array. `arguments` is a JSON string (not a parsed
 * object) per the OpenAI wire format.
 */
export interface OpenAIToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

/**
 * OpenAI tool-result message — the harness's reply when a
 * `tool_call` resolves. `tool_call_id` links it back to the
 * originating `tool_call.id`. `content` is always a string on
 * OpenAI's side (the array shape Anthropic supports is collapsed
 * during translation).
 */
export interface OpenAIToolMessage {
  readonly role: "tool";
  readonly tool_call_id: string;
  readonly content: string;
}

/**
 * OpenAI assistant message — may carry `tool_calls` (when the
 * model invoked tools) and/or text `content`. Translation
 * produces this from an Anthropic assistant message containing
 * mixed text + tool_use blocks.
 */
export interface OpenAIAssistantMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly tool_calls?: ReadonlyArray<OpenAIToolCall>;
}

/**
 * OpenAI user message — plain text. Translation produces this
 * from an Anthropic user message containing text blocks.
 */
export interface OpenAIUserMessage {
  readonly role: "user";
  readonly content: string;
}

/**
 * Union of all top-level OpenAI message shapes the translation
 * layer emits / consumes.
 */
export type OpenAIMessage =
  | OpenAIUserMessage
  | OpenAIAssistantMessage
  | OpenAIToolMessage;
