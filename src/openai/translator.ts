/**
 * Phase 69 Plan 02 — Bidirectional OpenAI ↔ Claude translator (pure functions).
 *
 * This module contains ONLY pure functions. No I/O, no timers, no SDK calls.
 * The server (`src/openai/server.ts`) drives the Claude Agent SDK; this module
 * shapes the wire between OpenAI JSON and what the driver expects + emits.
 *
 * Four surfaces:
 *
 *   1. `translateRequest` — walks the OpenAI `messages[]` + `tools`/`tool_choice`
 *      and returns the five fields a Claude turn needs: the last user
 *      message, the optional system-prompt APPEND (Pitfall 8 — NEVER override
 *      the stable prefix — prompt-cache preservation), the Claude tools,
 *      tool_choice, and any trailing tool_result blocks.
 *
 *   2. Response builders (`makeNonStreamResponse`, `makeChunk`,
 *      `translateClaudeToolUseToOpenAi`, `translateToolResult`,
 *      `newChatCompletionId`) — create final OpenAI wire objects.
 *
 *   3. `createStreamingTranslator` — a stateful factory that consumes
 *      `SdkStreamEvent` and emits `ChatCompletionChunk[]`. Maintains the
 *      Map<tool_use_id, openaiIndex> accumulator (Pitfall 1) and the
 *      `firstDeltaSent` flag (Pitfall 3 — role on first chunk only).
 *
 *   4. Identity helper `newChatCompletionId` — `chatcmpl-<nanoid(16)>` is the
 *      stable id used for every chunk in a single turn.
 *
 * Caller (server.ts) is responsible for:
 *   - Emitting the literal `data: [DONE]\n\n` SSE terminator after the final
 *     chunk — translator produces chunks only, stream.ts does framing.
 *   - Building the OpenAI error chunk when the driver errors mid-stream —
 *     stream.ts has the `emitError` method for that.
 *
 * Pitfalls guarded here (see 69-RESEARCH.md):
 *   - Pitfall 1: parallel tool_use Map → sequential openaiIndex.
 *   - Pitfall 2: `created` is epoch SECONDS (not ms); `content` null when
 *     tool_calls present and text empty.
 *   - Pitfall 3: role emitted on first chunk only (tracked via state).
 *   - Pitfall 8: `systemPrompt.append` — client `role:"system"` NEVER
 *     overrides; the translator's output names it `clientSystemAppend` to
 *     make that obvious at every call site.
 */

import { nanoid } from "nanoid";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionToolCall,
  ChatCompletionToolCallDelta,
  ChatCompletionUsage,
  ClaudeToolChoice,
  ClaudeToolDef,
  ClaudeToolResultBlock,
  ClaudeUsage,
  ChatMessage,
  OpenAiImageInput,
  SdkStreamEvent,
  ToolChoice,
  ToolDef,
} from "./types.js";

// ---------------------------------------------------------------------------
// Section 1: translateRequest (OpenAI → Claude)
// ---------------------------------------------------------------------------

/**
 * CAM-01/02 (Phase 6 multimodal vision) — inline image attachment limits.
 *
 * Only base64 `data:` URLs of these MIME types become inline Claude `image`
 * blocks. `http(s)`/`file`/other URLs are NEVER fetched (SSRF-safe) — they are
 * silently skipped, exactly like any unrecognized content part. The iOS client
 * pre-reduces a capture burst to <=3 downscaled images; we cap higher for
 * headroom. Oversize images are skipped (the server-level
 * `maxRequestBodyBytes` is the hard wire cap).
 */
const MAX_USER_IMAGES = 8;
const SUPPORTED_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
/** ~5 MiB of base64 (~3.7 MiB decoded) per image. */
const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024;

/**
 * Parse + validate a single OpenAI `image_url` URL into an inline image, or
 * return `null` to skip it. ONLY accepts `data:<mime>;base64,<data>` URLs of a
 * supported MIME type — any non-data URL (http/https/file/etc.) returns null
 * and is NEVER fetched. Whitespace inside the base64 payload is stripped (some
 * encoders line-wrap); empty or oversize payloads are rejected.
 */
function parseInlineImage(url: string): OpenAiImageInput | null {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  if (!match) return null; // not a base64 data URL — do NOT fetch remote URLs
  const mediaType = match[1].trim().toLowerCase();
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) return null;
  const data = match[2].replace(/\s/g, "");
  if (data.length === 0 || data.length > MAX_IMAGE_BASE64_CHARS) return null;
  return { mediaType, data };
}

/**
 * Shape returned by `translateRequest`.
 *
 * `clientSystemAppend` is the string that flows into `systemPrompt.append` on
 * the SDK query — it's the CONCATENATED body of every `role:"system"` message
 * in the request, joined by `\n\n`. The consuming driver MUST append it to
 * the agent's stablePrefix — NEVER override (Pitfall 8 — prompt-cache
 * preservation). We name the field `clientSystemAppend` to make the NEVER-
 * override rule obvious at call sites. `null` when no system messages.
 */
export interface TranslatedRequest {
  lastUserMessage: string;
  /**
   * CAM-01/02 — inline image attachments extracted from the LAST user
   * message's `image_url` parts (data-URLs only). Empty array when none.
   * Threaded to the session handle as Anthropic `image` content blocks; the
   * text in `lastUserMessage` no longer carries an `![image]()` placeholder
   * for these (the bytes go inline instead).
   */
  lastUserImages: OpenAiImageInput[];
  clientSystemAppend: string | null;
  tools: ClaudeToolDef[] | null;
  toolChoice: ClaudeToolChoice | null;
  toolResults: ClaudeToolResultBlock[];
}

/** Thrown by `translateRequest` when no user message is present. */
export class NoUserMessageError extends Error {
  constructor() {
    super("chat completion request has no user message");
    this.name = "NoUserMessageError";
  }
}

/**
 * Walk the OpenAI request body and produce the five fields a Claude turn
 * needs.
 *
 * Rules:
 *   - `lastUserMessage` — the CONTENT of the LAST `role:"user"` message in
 *     `body.messages`. Throws `NoUserMessageError` if none.
 *   - `clientSystemAppend` — all `role:"system"` contents joined by `\n\n`
 *     (order preserved). `null` if zero system messages. This string flows
 *     into `systemPrompt.append` — NEVER into an override (Pitfall 8).
 *   - `toolResults` — every `role:"tool"` message that appears AFTER the last
 *     assistant's `tool_calls`, shaped as `ClaudeToolResultBlock[]`. Keeps
 *     order (OpenAI clients may send them out of order; we preserve the
 *     client's order so the agent's tool-loop sees the same sequence).
 *   - `tools` / `toolChoice` — 1:1 translation per Pattern 4 in 69-RESEARCH.md.
 */
export function translateRequest(body: ChatCompletionRequest): TranslatedRequest {
  const messages = body.messages;

  const lastUser = findLastUserContent(messages);
  if (lastUser === null) throw new NoUserMessageError();

  const clientSystemAppend = collectSystemAppend(messages);
  const toolResults = collectTrailingToolResults(messages);
  const tools = body.tools ? body.tools.map(translateToolDef) : null;
  const toolChoice = body.tool_choice ? translateToolChoice(body.tool_choice) : null;

  return {
    lastUserMessage: lastUser.text,
    lastUserImages: lastUser.images,
    clientSystemAppend,
    tools,
    toolChoice,
    toolResults,
  };
}

/**
 * Normalize OpenAI message content (string | array<ContentPart> | null) to a
 * single string. OpenClaw and most modern clients send multi-part arrays —
 * we concatenate `text` parts with "\n\n" and render `image_url` as a
 * markdown-style link so the textual model still receives context. Future
 * work: proper vision wiring for image parts via Claude's native image block.
 */
function contentToString(
  content:
    | string
    | null
    | ReadonlyArray<{ type: string } & Record<string, unknown>>,
): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const p of content) {
    if (p.type === "text" && typeof p.text === "string") {
      parts.push(p.text);
    } else if (p.type === "image_url") {
      const iu = p.image_url as unknown;
      const url = typeof iu === "string" ? iu : (iu as { url?: string })?.url;
      if (typeof url === "string" && url.length > 0) {
        parts.push(`![image](${url})`);
      }
    }
    // Other part types silently skipped — tolerate future OpenAI additions.
  }
  return parts.join("\n\n");
}

/**
 * Extracted content of a single user message: the concatenated text plus any
 * inline images. CAM-01/02 — used ONLY for the last user message (the vision
 * path). Kept separate from `contentToString` (which is shared with
 * `collectSystemAppend`) so extracting images + dropping the markdown
 * placeholder NEVER changes system-message handling.
 */
interface ExtractedUserContent {
  readonly text: string;
  readonly images: OpenAiImageInput[];
}

/**
 * Split a user message's content into text + inline images. `text` parts are
 * concatenated with "\n\n" (matching `contentToString`). `image_url` parts
 * that are valid, supported, base64 data-URLs become structured image
 * attachments (NOT `![image]()` text). Non-data URLs and unsupported types
 * are silently skipped — never fetched. Capped at MAX_USER_IMAGES.
 */
function extractUserContent(
  content: string | null | ReadonlyArray<{ type: string } & Record<string, unknown>>,
): ExtractedUserContent {
  if (content === null || content === undefined) return { text: "", images: [] };
  if (typeof content === "string") return { text: content, images: [] };
  const textParts: string[] = [];
  const images: OpenAiImageInput[] = [];
  for (const p of content) {
    if (p.type === "text" && typeof p.text === "string") {
      textParts.push(p.text);
    } else if (p.type === "image_url") {
      const iu = p.image_url as unknown;
      const url = typeof iu === "string" ? iu : (iu as { url?: string })?.url;
      if (typeof url === "string" && url.length > 0) {
        const img = images.length < MAX_USER_IMAGES ? parseInlineImage(url) : null;
        if (img) {
          images.push(img);
        } else if (!url.startsWith("data:")) {
          // Remote ref (http/https/file/…) — NOT inlined and NEVER fetched
          // (SSRF-safe). Preserve the legacy `contentToString` behavior on this
          // SHARED endpoint: surface it as a markdown link so the model still
          // sees the reference rather than silently losing it.
          textParts.push(`![image](${url})`);
        } else {
          // A data-URL we can't inline (unsupported MIME, oversize, or over the
          // MAX_USER_IMAGES cap). Don't dump the multi-MB base64 into the text;
          // note it instead so the drop is never silent.
          textParts.push("[image omitted: unsupported type or too large]");
        }
      }
    }
    // Other part types silently skipped — tolerate future OpenAI additions.
  }
  return { text: textParts.join("\n\n"), images };
}

/** Walk `messages` from the tail and return the most recent user content, or null. */
function findLastUserContent(messages: ReadonlyArray<ChatMessage>): ExtractedUserContent | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      return extractUserContent(m.content as Parameters<typeof extractUserContent>[0]);
    }
  }
  return null;
}

/** Concatenate every `role:"system"` content with `\n\n`, preserving order. */
function collectSystemAppend(messages: ReadonlyArray<ChatMessage>): string | null {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      parts.push(contentToString(m.content as Parameters<typeof contentToString>[0]));
    }
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

/**
 * Collect `role:"tool"` messages that appear AFTER the last assistant
 * message with `tool_calls`. If no such assistant turn exists, collect every
 * `role:"tool"` in the whole history. Returned in the order they appear.
 */
function collectTrailingToolResults(
  messages: ReadonlyArray<ChatMessage>,
): ClaudeToolResultBlock[] {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      lastAssistantIdx = i;
      break;
    }
  }
  const start = lastAssistantIdx + 1;
  const results: ClaudeToolResultBlock[] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (m && m.role === "tool") {
      results.push({
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: contentToString(m.content as Parameters<typeof contentToString>[0]),
      });
    }
  }
  return results;
}

/** OpenAI `{type:"function", function:{...}}` → Claude `{name, description, input_schema}`. */
function translateToolDef(def: ToolDef): ClaudeToolDef {
  return {
    name: def.function.name,
    description: def.function.description ?? "",
    input_schema: (def.function.parameters ?? {}) as Record<string, unknown>,
  };
}

/**
 * OpenAI `tool_choice` (string literals or `{type:"function",function:{name}}`)
 * → Claude `{type:"auto"|"none"|"any"|"tool", name?}`.
 */
function translateToolChoice(choice: ToolChoice): ClaudeToolChoice {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.function.name };
}

/**
 * Translate a single client `role:"tool"` message into a Claude tool_result.
 * Exported for fine-grained unit testing; `translateRequest` already uses
 * this behavior via `collectTrailingToolResults`.
 */
export function translateToolResult(msg: {
  tool_call_id: string;
  content:
    | string
    | ReadonlyArray<{ type: string } & Record<string, unknown>>;
}): ClaudeToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: msg.tool_call_id,
    content: contentToString(msg.content),
  };
}

// ---------------------------------------------------------------------------
// Section 2: Response builders (Claude → OpenAI)
// ---------------------------------------------------------------------------

/** Build a new chatcmpl id — stable across every chunk of a single turn. */
export function newChatCompletionId(): string {
  return `chatcmpl-${nanoid(16)}`;
}

/** Epoch SECONDS (Pitfall 2 — strict field type; never milliseconds). */
function epochSeconds(now: number = Date.now()): number {
  return Math.floor(now / 1000);
}

/**
 * Translate a single Claude `tool_use` content block into a full OpenAI
 * `tool_calls[i]` entry for non-streaming responses. `arguments` is the
 * JSON-stringified `input` (OpenAI spec: arguments is always a JSON STRING).
 */
export function translateClaudeToolUseToOpenAi(block: {
  id: string;
  name: string;
  input: unknown;
}): ChatCompletionToolCall {
  return {
    id: block.id,
    type: "function",
    function: {
      name: block.name,
      arguments: JSON.stringify(block.input ?? {}),
    },
  };
}

/**
 * Derive OpenAI `usage` from Claude's `result.usage`.
 *
 * Mapping:
 *   prompt_tokens     = input_tokens + cache_read_input_tokens
 *   completion_tokens = output_tokens
 *   total_tokens      = prompt + completion
 *
 * Missing fields default to 0 (Pitfall 2 — never emit `{}`; always emit
 * the full object shape on non-stream responses).
 */
export function deriveUsage(claude: ClaudeUsage | undefined): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const inputTokens = claude?.input_tokens ?? 0;
  const cacheRead = claude?.cache_read_input_tokens ?? 0;
  const outputTokens = claude?.output_tokens ?? 0;
  const promptTokens = inputTokens + cacheRead;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: outputTokens,
    total_tokens: promptTokens + outputTokens,
  };
}

/**
 * Build a full non-streaming `ChatCompletionResponse`.
 *
 * Rules:
 *   - `id` ALWAYS has `chatcmpl-` prefix (or the caller-provided id — used
 *     so streaming + final response can share the id).
 *   - `created` is epoch SECONDS.
 *   - `content` is `null` when `toolCalls` is non-empty AND `text` is empty
 *     (Pitfall 2 — OpenAI convention for a tool-call-only assistant turn).
 *   - `finish_reason` defaults to `"tool_calls"` when any toolCalls are
 *     present, else `"stop"`. Callers may override via `finishReason`.
 *   - `logprobs` and `system_fingerprint` are explicit `null` (Pitfall 2 —
 *     present-but-null, never omitted).
 */
export function makeNonStreamResponse(params: {
  id?: string;
  model: string;
  text: string;
  toolCalls: ReadonlyArray<ChatCompletionToolCall>;
  usage: ClaudeUsage | undefined;
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter";
  created?: number;
}): ChatCompletionResponse {
  const id = params.id ?? newChatCompletionId();
  const created = params.created ?? epochSeconds();
  const hasToolCalls = params.toolCalls.length > 0;
  const finishReason =
    params.finishReason ?? (hasToolCalls ? "tool_calls" : "stop");
  const content = hasToolCalls && params.text.length === 0 ? null : params.text;
  const message: ChatCompletionResponse["choices"][number]["message"] = {
    role: "assistant",
    content,
  };
  if (hasToolCalls) {
    message.tool_calls = [...params.toolCalls];
  }
  return {
    id,
    object: "chat.completion",
    created,
    model: params.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: deriveUsage(params.usage),
    system_fingerprint: null,
  };
}

/**
 * Build the OpenAI `stream_options.include_usage` trailing chunk:
 *
 *   { id, object:"chat.completion.chunk", created, model,
 *     choices: [],
 *     usage: { prompt_tokens, completion_tokens, total_tokens } }
 *
 * Spec: https://platform.openai.com/docs/api-reference/chat/streaming
 * `choices` is intentionally the empty array on this final usage chunk —
 * clients that opted into `stream_options.include_usage` expect exactly this
 * shape after the terminal finish_reason chunk, before the [DONE] sentinel.
 *
 * Module-private — one-call primitive owned by `createStreamingTranslator`.
 */
function makeUsageChunk(params: {
  id: string;
  model: string;
  usage: ChatCompletionUsage;
  created?: number;
}): ChatCompletionChunk {
  return {
    id: params.id,
    object: "chat.completion.chunk",
    created: params.created ?? epochSeconds(),
    model: params.model,
    choices: [],
    usage: params.usage,
  };
}

/**
 * Build a streaming chunk with the given delta and finish_reason. Pure
 * record builder — no state. `role` is a property of the caller-provided
 * delta; the streaming translator controls when to set it (Pitfall 3).
 */
export function makeChunk(params: {
  id: string;
  model: string;
  delta: ChatCompletionChunk["choices"][number]["delta"];
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"];
  created?: number;
}): ChatCompletionChunk {
  return {
    id: params.id,
    object: "chat.completion.chunk",
    created: params.created ?? epochSeconds(),
    model: params.model,
    choices: [
      {
        index: 0,
        delta: params.delta,
        finish_reason: params.finishReason,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Section 3: createStreamingTranslator (stateful)
// ---------------------------------------------------------------------------

/**
 * Public contract of a streaming translator instance.
 *
 * `onEvent(event)` may emit 0-or-more OpenAI chunks per SDK event:
 *   - first text → 1 chunk (`role:"assistant"`, empty content) + 1 chunk (delta text)
 *     NOTE: only the very FIRST text-or-tool-use event in the turn triggers the
 *     role chunk; subsequent events emit 1 chunk each.
 *   - text_delta → 1 chunk (content delta)
 *   - tool_use content_block_start → 1 chunk (tool_calls delta with id+type+name)
 *   - input_json_delta → 1 chunk (tool_calls delta with arguments partial)
 *   - content_block_stop, assistant, result → 0 chunks (state-only updates)
 *
 * `finalize()` emits the final chunk with `delta:{}` and the chosen
 * finish_reason. `hadToolUse`, `collectedText`, and `collectedToolCalls` are
 * read-only snapshots — useful for callers that also want to produce a
 * non-streaming response in the same flow.
 */
/**
 * Options for `StreamingTranslator.finalize()`.
 *
 * `includeUsage` controls whether the OpenAI `stream_options.include_usage`
 * trailing chunk is emitted AFTER the terminal `delta:{}` chunk.
 *
 * Contract:
 *   - `includeUsage === true` AND we captured a `result` event → return
 *     `[terminalChunk, usageChunk]`. The usage chunk has `choices:[]` and
 *     the same id/object/model/created as the terminal chunk.
 *   - `includeUsage === true` BUT no `result` event was observed (usage is
 *     undefined) → return `[terminalChunk]` only. We deliberately OMIT the
 *     usage chunk rather than emit `{0,0,0}` — OpenAI spec allows absence
 *     and emitting zeros misleads clients building token-cost reports.
 *   - `includeUsage !== true` (default) → behaviour is identical to today:
 *     exactly one terminal chunk, no usage trailer.
 */
export interface FinalizeOptions {
  finishReason?: "stop" | "tool_calls" | "length";
  includeUsage?: boolean;
}

export interface StreamingTranslator {
  onEvent(event: SdkStreamEvent): ChatCompletionChunk[];
  /**
   * Emit terminal + optional usage-trailer chunks.
   *
   * Two call shapes supported:
   *   - Object form (preferred): `finalize({ finishReason, includeUsage })`.
   *   - Legacy positional string form: `finalize("stop" | "tool_calls" | "length")`
   *     — kept for backward compatibility with Plan 02 tests and callers.
   *     New code SHOULD use the object form.
   *
   * See `FinalizeOptions` for the full `includeUsage` contract, including
   * the "omit usage chunk when usage was never captured" rule.
   */
  finalize(
    options?: "stop" | "tool_calls" | "length" | FinalizeOptions,
  ): ChatCompletionChunk[];
  readonly hadToolUse: boolean;
  readonly collectedText: string;
  readonly collectedToolCalls: ReadonlyArray<ChatCompletionToolCall>;
  readonly usage: ClaudeUsage | undefined;
}

/**
 * Create a fresh streaming translator instance for one turn.
 *
 * State maintained:
 *   - `id` + `model` — constants for every emitted chunk.
 *   - `firstDeltaSent` — gates the role-carrying first chunk (Pitfall 3).
 *   - `toolUseIndexById: Map<tool_use_id, openaiIndex>` — the Pitfall-1 guard.
 *   - `toolUseByIndex` — parallel array of accumulated `{id, name, args}` for
 *     building the non-streaming `collectedToolCalls` snapshot.
 *   - `collectedText` — concatenated text_delta strings.
 *   - `hadToolUse` — set on any `content_block_start` of type `tool_use`.
 *   - `usage` — captured from the `result` event so callers can build a
 *     non-streaming response even after consuming the stream.
 */
export function createStreamingTranslator(params: {
  id: string;
  model: string;
}): StreamingTranslator {
  const { id, model } = params;
  let firstDeltaSent = false;

  // Primary Pitfall-1 guard: tool_use_id → openai tool_calls[] index.
  // Assignment order is stable (next sequential index on first sighting).
  const toolUseIndexById = new Map<string, number>();

  // Reverse mapping from SDK content-block index → openai tool_calls[] index.
  // Needed because `input_json_delta` events identify the block by SDK index,
  // NOT by tool_use_id. We record this association at content_block_start
  // time so we never have to search retrospectively (which would be fragile
  // if two tool_use blocks ever reused the same SDK index after a stop).
  const sdkBlockIndexToOpenaiIndex = new Map<number, number>();

  // Parallel snapshot for `collectedToolCalls`: one entry per openaiIndex.
  const toolUseByIndex: Array<{ id: string; name: string; args: string }> = [];

  let collectedText = "";
  let hadToolUse = false;
  let usage: ClaudeUsage | undefined = undefined;

  /**
   * Ensure the first emitted chunk carries `role:"assistant"` + empty content.
   * Returns the priming chunk or null if already sent. Pitfall 3.
   */
  function maybeEmitRolePrimer(): ChatCompletionChunk | null {
    if (firstDeltaSent) return null;
    firstDeltaSent = true;
    return makeChunk({
      id,
      model,
      delta: { role: "assistant", content: "" },
      finishReason: null,
    });
  }

  /**
   * Assign the next sequential openaiIndex to a fresh tool_use id and record
   * the SDK-block → openai-index mapping. Pitfall 1.
   */
  function assignToolIndex(sdkBlockIndex: number, toolUseId: string, name: string): number {
    const existing = toolUseIndexById.get(toolUseId);
    if (existing !== undefined) {
      sdkBlockIndexToOpenaiIndex.set(sdkBlockIndex, existing);
      return existing;
    }
    const openaiIndex = toolUseByIndex.length;
    toolUseIndexById.set(toolUseId, openaiIndex);
    sdkBlockIndexToOpenaiIndex.set(sdkBlockIndex, openaiIndex);
    toolUseByIndex.push({ id: toolUseId, name, args: "" });
    return openaiIndex;
  }

  return {
    onEvent(event: SdkStreamEvent): ChatCompletionChunk[] {
      if (event.type === "result") {
        usage = event.usage;
        return [];
      }

      if (event.type === "assistant") {
        // Assistant message boundary — the stream_event deltas above already
        // emitted the real chunks. Capture text content for the collected
        // snapshot as a belt-and-suspenders fallback for harnesses that
        // drive the translator from non-streaming fixtures.
        for (const block of event.message.content) {
          if (block.type === "text" && collectedText.length === 0) {
            collectedText = block.text;
          }
        }
        return [];
      }

      if (event.type !== "stream_event") return [];

      const inner = event.event;

      if (inner.type === "content_block_start") {
        if (inner.content_block.type === "text") {
          // Prime role on first event; no content emit yet (text_delta will
          // carry real tokens).
          const primer = maybeEmitRolePrimer();
          return primer ? [primer] : [];
        }
        if (inner.content_block.type === "tool_use") {
          hadToolUse = true;
          const toolUse = inner.content_block;
          const primer = maybeEmitRolePrimer();
          const openaiIndex = assignToolIndex(inner.index, toolUse.id, toolUse.name);
          const toolCallDelta: ChatCompletionToolCallDelta = {
            index: openaiIndex,
            id: toolUse.id,
            type: "function",
            function: { name: toolUse.name, arguments: "" },
          };
          const startChunk = makeChunk({
            id,
            model,
            delta: { tool_calls: [toolCallDelta] },
            finishReason: null,
          });
          return primer ? [primer, startChunk] : [startChunk];
        }
        return [];
      }

      if (inner.type === "content_block_delta") {
        if (inner.delta.type === "text_delta") {
          const text = inner.delta.text;
          collectedText += text;
          const primer = maybeEmitRolePrimer();
          const textChunk = makeChunk({
            id,
            model,
            delta: { content: text },
            finishReason: null,
          });
          return primer ? [primer, textChunk] : [textChunk];
        }
        if (inner.delta.type === "input_json_delta") {
          const openaiIndex = sdkBlockIndexToOpenaiIndex.get(inner.index);
          if (openaiIndex === undefined) return [];
          const entry = toolUseByIndex[openaiIndex];
          if (entry) entry.args += inner.delta.partial_json;
          const argChunkDelta: ChatCompletionToolCallDelta = {
            index: openaiIndex,
            function: { arguments: inner.delta.partial_json },
          };
          return [
            makeChunk({
              id,
              model,
              delta: { tool_calls: [argChunkDelta] },
              finishReason: null,
            }),
          ];
        }
        return [];
      }

      if (inner.type === "content_block_stop") {
        // Boundary only — no emit.
        return [];
      }

      return [];
    },

    finalize(options): ChatCompletionChunk[] {
      // Normalize legacy positional string form into the object shape. Both
      // call styles remain supported — see `FinalizeOptions` JSDoc.
      const normalized: FinalizeOptions =
        typeof options === "string"
          ? { finishReason: options }
          : options ?? {};
      const finishReason =
        normalized.finishReason ?? (hadToolUse ? "tool_calls" : "stop");
      const terminal = makeChunk({
        id,
        model,
        delta: {},
        finishReason,
      });
      if (!normalized.includeUsage) return [terminal];
      // Post-v2.0 hardening: emit OpenAI `stream_options.include_usage`
      // trailing chunk. If we never saw a `result` event, omit rather than
      // emit `{0,0,0}` (spec allows absence; zeros mislead token-cost UI).
      if (usage === undefined) return [terminal];
      const usageChunk = makeUsageChunk({
        id,
        model,
        usage: deriveUsage(usage),
      });
      return [terminal, usageChunk];
    },

    get hadToolUse(): boolean {
      return hadToolUse;
    },
    get collectedText(): string {
      return collectedText;
    },
    get collectedToolCalls(): ReadonlyArray<ChatCompletionToolCall> {
      return toolUseByIndex.map((e) => ({
        id: e.id,
        type: "function" as const,
        function: { name: e.name, arguments: e.args },
      }));
    },
    get usage(): ClaudeUsage | undefined {
      return usage;
    },
  };
}

// The closure above references `sdkBlockIndexToOpenaiIndex` — declare it here
// at module scope to avoid TDZ. Wait — that won't work per-instance. Move
// into the factory. Done in the refactor below.
