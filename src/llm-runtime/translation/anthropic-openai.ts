/**
 * Phase 137 Plan 02 — Anthropic block-typed ↔ OpenAI function-
 * calling translation primitives.
 *
 * Pure functions only — no I/O, no logging, no global state.
 * Every helper is `(input) → output` and deterministic. Consumed
 * by Plan 03 (`CodexAgentCli` wire calls) and Plan 05 (streaming
 * normalisation) via the `../translation/index.js` barrel.
 *
 * Documented asymmetric losses (CONTEXT D2 + researcher_todo #3 /
 * #5):
 *   - `cache_control` (Anthropic-only) dropped on outbound; not
 *     reconstructed on inbound.
 *   - `tool_result.content: Array<{type:"text",text}>` collapses
 *     to a single `\n`-joined string on the OpenAI side; the
 *     reverse helper reconstructs the string shape only.
 *   - `is_error: true` is encoded by prefixing tool-result content
 *     with `IS_ERROR_PREFIX` (`[error] `); reverse helper strips
 *     and re-emits `is_error: true`. Round-trips cleanly only when
 *     the source content did not itself begin with the sentinel.
 *
 * Every OpenAI wire field-name reference routes through
 * `OPENAI_FIELD_NAMES` — the static-grep regression in
 * `__tests__/static-grep-translation-constants.test.ts` enforces
 * zero bare-string drift.
 */

import { IS_ERROR_PREFIX, OPENAI_FIELD_NAMES } from "./constants.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicTextBlock,
  AnthropicToolBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  OpenAIAssistantMessage,
  OpenAIMessage,
  OpenAIToolCall,
  OpenAIToolFunction,
  OpenAIToolMessage,
  OpenAIUserMessage,
} from "./types.js";

// -------------------------------------------------------------
// Tool definition translation
// -------------------------------------------------------------

/**
 * Wrap each Anthropic block-typed tool in the OpenAI function-
 * calling envelope. `cache_control` is intentionally dropped on
 * the OpenAI side per CONTEXT D2 — no OpenAI equivalent exists
 * at the tool-definition layer.
 */
export function translateToolsToOpenAI(
  tools: ReadonlyArray<AnthropicToolBlock>,
): OpenAIToolFunction[] {
  return tools.map((tool) => ({
    type: OPENAI_FIELD_NAMES.FUNCTION_TYPE,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

// -------------------------------------------------------------
// tool_use ↔ tool_call
// -------------------------------------------------------------

/**
 * Convert an Anthropic `tool_use` block to an OpenAI `tool_call`.
 * `arguments` is JSON-stringified (no pretty-print — wire format).
 */
export function translateToolUseToOpenAI(
  block: AnthropicToolUseBlock,
): OpenAIToolCall {
  return {
    id: block.id,
    type: OPENAI_FIELD_NAMES.FUNCTION_TYPE,
    function: {
      name: block.name,
      arguments: JSON.stringify(block.input),
    },
  };
}

/**
 * Convert an OpenAI `tool_call` back into an Anthropic `tool_use`
 * block. Throws a documented error on malformed `arguments` JSON
 * — Plan 03 + Plan 05 catch this and surface as a turn error.
 */
export function translateToolUseFromOpenAI(
  call: OpenAIToolCall,
): AnthropicToolUseBlock {
  let input: Record<string, unknown>;
  try {
    const parsed = JSON.parse(call.function.arguments);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        "translateToolUseFromOpenAI: malformed arguments JSON",
      );
    }
    input = parsed as Record<string, unknown>;
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "translateToolUseFromOpenAI: malformed arguments JSON"
    ) {
      throw err;
    }
    throw new Error("translateToolUseFromOpenAI: malformed arguments JSON");
  }
  return {
    type: "tool_use",
    id: call.id,
    name: call.function.name,
    input,
  };
}

// -------------------------------------------------------------
// tool_result ↔ OpenAI tool message
// -------------------------------------------------------------

/**
 * Collapse an Anthropic tool-result content payload to a single
 * string. Anthropic accepts either `string` or
 * `Array<{type:"text",text}>`; OpenAI accepts only a single
 * string. Multi-block arrays are `\n`-joined.
 */
type AnthropicToolResultContent = AnthropicToolResultBlock extends {
  content: infer C;
}
  ? C
  : never;

function normaliseToolResultContent(
  content: AnthropicToolResultContent,
): string {
  if (typeof content === "string") return content;
  return content.map((block) => block.text).join("\n");
}

/**
 * Convert an Anthropic `tool_result` block to an OpenAI tool
 * message. `is_error: true` is encoded by prefixing the content
 * with `IS_ERROR_PREFIX` so the reverse direction can reconstruct
 * the flag.
 */
export function translateToolResultToOpenAI(
  block: AnthropicToolResultBlock,
): OpenAIToolMessage {
  const base = normaliseToolResultContent(block.content);
  const content = block.is_error === true ? `${IS_ERROR_PREFIX}${base}` : base;
  return {
    role: OPENAI_FIELD_NAMES.TOOL_ROLE,
    tool_call_id: block.tool_use_id,
    content,
  };
}

/**
 * Convert an OpenAI tool message back into an Anthropic
 * `tool_result` block. Strips the `IS_ERROR_PREFIX` sentinel and
 * re-emits `is_error: true` when present. Content is reconstructed
 * as `string` only — the array-of-text-blocks shape is NOT
 * recovered (documented asymmetric loss).
 */
export function translateToolResultFromOpenAI(
  msg: OpenAIToolMessage,
): AnthropicToolResultBlock {
  const isError = msg.content.startsWith(IS_ERROR_PREFIX);
  const content = isError
    ? msg.content.slice(IS_ERROR_PREFIX.length)
    : msg.content;
  const base: AnthropicToolResultBlock = {
    type: "tool_result",
    tool_use_id: msg.tool_call_id,
    content,
  };
  return isError ? { ...base, is_error: true } : base;
}

// -------------------------------------------------------------
// Top-level message translation
// -------------------------------------------------------------

/**
 * Convert an Anthropic message into ONE OR MORE OpenAI messages.
 *
 * - A `user`-role Anthropic message with text + tool_result blocks
 *   becomes: optional user text message + one OpenAI tool message
 *   per tool_result.
 * - An `assistant`-role Anthropic message with text + tool_use
 *   blocks becomes: a single assistant message carrying both the
 *   joined text content AND a `tool_calls` array.
 *
 * Returns an array because Anthropic's mixed-content user messages
 * fan out to N OpenAI messages (one per tool_result + optional
 * preamble).
 */
export function translateMessageToOpenAI(
  msg: AnthropicMessage,
): OpenAIMessage[] {
  const textParts: string[] = [];
  const toolUseBlocks: AnthropicToolUseBlock[] = [];
  const toolResultBlocks: AnthropicToolResultBlock[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolUseBlocks.push(block);
    } else if (block.type === "tool_result") {
      toolResultBlocks.push(block);
    }
  }

  const joinedText = textParts.join("\n");

  if (msg.role === "assistant") {
    const assistantMsg: OpenAIAssistantMessage = {
      role: OPENAI_FIELD_NAMES.ASSISTANT_ROLE,
      content: joinedText.length > 0 ? joinedText : null,
      ...(toolUseBlocks.length > 0
        ? { tool_calls: toolUseBlocks.map(translateToolUseToOpenAI) }
        : {}),
    };
    return [assistantMsg];
  }

  // role === "user"
  const out: OpenAIMessage[] = [];
  if (joinedText.length > 0) {
    const userMsg: OpenAIUserMessage = {
      role: OPENAI_FIELD_NAMES.USER_ROLE,
      content: joinedText,
    };
    out.push(userMsg);
  }
  for (const tr of toolResultBlocks) {
    out.push(translateToolResultToOpenAI(tr));
  }
  return out;
}

/**
 * Fold a sequence of OpenAI messages into a single Anthropic
 * message with mixed content blocks. Inverse of
 * `translateMessageToOpenAI`.
 *
 * The role of the resulting message is inferred from the input:
 *   - If any message has `role: "assistant"`, the output is
 *     assistant-role.
 *   - Otherwise the output is user-role.
 *
 * Throws on an empty input array (no message to reconstruct).
 */
export function translateMessageFromOpenAI(
  msgs: ReadonlyArray<OpenAIMessage>,
): AnthropicMessage {
  if (msgs.length === 0) {
    throw new Error(
      "translateMessageFromOpenAI: empty input — nothing to reconstruct",
    );
  }

  const content: AnthropicContentBlock[] = [];
  let role: "user" | "assistant" = "user";

  for (const m of msgs) {
    if (m.role === OPENAI_FIELD_NAMES.ASSISTANT_ROLE) {
      role = "assistant";
      const asst = m as OpenAIAssistantMessage;
      if (typeof asst.content === "string" && asst.content.length > 0) {
        const text: AnthropicTextBlock = { type: "text", text: asst.content };
        content.push(text);
      }
      if (asst.tool_calls) {
        for (const call of asst.tool_calls) {
          content.push(translateToolUseFromOpenAI(call));
        }
      }
    } else if (m.role === OPENAI_FIELD_NAMES.USER_ROLE) {
      const usr = m as OpenAIUserMessage;
      if (usr.content.length > 0) {
        const text: AnthropicTextBlock = { type: "text", text: usr.content };
        content.push(text);
      }
    } else if (m.role === OPENAI_FIELD_NAMES.TOOL_ROLE) {
      const toolMsg = m as OpenAIToolMessage;
      content.push(translateToolResultFromOpenAI(toolMsg));
    }
  }

  return { role, content };
}
