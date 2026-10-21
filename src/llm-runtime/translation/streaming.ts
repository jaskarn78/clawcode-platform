/**
 * Phase 137 Plan 05 T-01 — Streaming SSE normalisation.
 *
 * Maps OpenAI Chat Completions SSE chunks (`data: <json>\n` lines
 * terminated by `data: [DONE]`) into Anthropic-shaped typed events
 * (`message_start`, `content_block_start`, `content_block_delta`,
 * `content_block_stop`, `message_delta`, `message_stop`).
 *
 * ── Design note — local typed event union (Deviation #1) ────────────
 *
 * The plan's `<interfaces>` block claims `SdkStreamMessage` is the
 * Anthropic typed-event union. That is NOT what the codebase
 * actually exports — `src/manager/sdk-types.ts:245` defines
 * `SdkStreamMessage = SdkAssistantMessage | SdkResultMessage` (a
 * narrower projection used by the session-adapter). To avoid
 * fabricating SDK types we don't own, this module defines a LOCAL
 * `NormalisedSseEvent` union with the idealised Anthropic typed-
 * event shape. `CodexQuery` (T-03) consumes these and collapses them
 * back into the real `SdkStreamMessage` shape the daemon's
 * session-adapter actually reads. This mirrors Plan 03's Deviation
 * #1 (SdkQueryOptions idealisation) — surface the idealisation, keep
 * the consumer surface honest.
 *
 * ── Pure-function discipline ────────────────────────────────────────
 *
 * No I/O, no global state. The exported helper is a single
 * `AsyncIterable<string> → AsyncIterable<NormalisedSseEvent>`
 * transformer driven by an internal state machine. A pino-shaped
 * `logger` is optional — when omitted, parse errors and per-event
 * telemetry are silently dropped (test isolation).
 *
 * ── Telemetry tags (operator-greppable) ─────────────────────────────
 *
 *   - `phase137-codex-sse-event`     one per yielded normalised event
 *   - `phase137-codex-parse-error`   one per malformed `data:` chunk
 *
 * ── Tool-call ordering (researcher_todo #4) ─────────────────────────
 *
 * OpenAI streams tool_call deltas incrementally and emits the final
 * `finish_reason: "tool_calls"` chunk only after all deltas. Our
 * state machine buffers tool_call deltas keyed by `tool_calls[].index`
 * then, on the finish_reason boundary, emits the equivalent Anthropic
 * `content_block_start` + `content_block_delta` + `content_block_stop`
 * sequence per index. The Plan-02 `translateToolUseFromOpenAI` helper
 * is invoked once per consolidated tool_call to convert the OpenAI
 * shape into the Anthropic `tool_use` shape.
 *
 * See:
 *   - `./index.ts` — barrel re-export.
 *   - `./anthropic-openai.ts` — Plan 02 translation primitives.
 *   - `./__tests__/streaming.test.ts` — ≥10 behavioural assertions.
 */

import { translateToolUseFromOpenAI } from "./anthropic-openai.js";
import type {
  AnthropicToolUseBlock,
  OpenAIToolCall,
} from "./types.js";

/**
 * Optional pino-shaped logger surface. Same minimal shape used by
 * `CodexQuery` / `CodexAgentCli` — duplicated locally so the
 * translation layer remains import-free of pino as a value.
 */
export interface StreamingLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

/**
 * Anthropic-shaped content block payloads emitted on
 * `content_block_start`. Either a plain text block (initially empty)
 * or a fully-formed tool_use block (consolidated from buffered
 * deltas).
 */
export type NormalisedContentBlock =
  | { readonly type: "text"; readonly text: string }
  | AnthropicToolUseBlock;

/**
 * Anthropic-shaped delta payloads emitted on
 * `content_block_delta`. Text-deltas carry incremental content;
 * tool-call deltas carry the (already-consolidated) input.
 */
export type NormalisedContentDelta =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "input_json_delta"; readonly partial_json: string };

/**
 * Anthropic-shaped typed events the normaliser yields. Idealised
 * surface — see file header Deviation #1.
 */
export type NormalisedSseEvent =
  | {
      readonly type: "message_start";
      readonly message: {
        readonly id?: string;
        readonly model?: string;
        readonly role: "assistant";
      };
    }
  | {
      readonly type: "content_block_start";
      readonly index: number;
      readonly content_block: NormalisedContentBlock;
    }
  | {
      readonly type: "content_block_delta";
      readonly index: number;
      readonly delta: NormalisedContentDelta;
    }
  | {
      readonly type: "content_block_stop";
      readonly index: number;
    }
  | {
      readonly type: "message_delta";
      readonly delta: { readonly stop_reason?: string };
      readonly usage?: {
        readonly input_tokens?: number;
        readonly output_tokens?: number;
      };
    }
  | { readonly type: "message_stop" };

/**
 * Subset of the OpenAI Chat Completions streaming chunk shape we
 * touch. Conservative shape — extra fields are ignored.
 */
interface OpenAiStreamChunk {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: ReadonlyArray<{
    readonly index?: number;
    readonly delta?: {
      readonly role?: string;
      readonly content?: string | null;
      readonly tool_calls?: ReadonlyArray<{
        readonly index?: number;
        readonly id?: string;
        readonly type?: string;
        readonly function?: {
          readonly name?: string;
          readonly arguments?: string;
        };
      }>;
    };
    readonly finish_reason?: string | null;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}

/**
 * Buffered tool-call accumulator keyed by `tool_calls[].index`. The
 * first delta usually carries `id` + `function.name`; subsequent
 * deltas append to `function.arguments`. We emit the consolidated
 * block on the finish_reason boundary.
 */
interface ToolCallBuffer {
  id: string;
  name: string;
  argumentsJson: string;
}

/**
 * Map an Anthropic OpenAI `finish_reason` string to the Anthropic-
 * canonical `stop_reason` value used in `message_delta`. Conservative
 * — unrecognised values pass through verbatim so operators can debug
 * future protocol additions.
 */
function mapStopReason(openAiReason: string): string {
  switch (openAiReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "stop_sequence";
    default:
      return openAiReason;
  }
}

/**
 * `normaliseOpenAiSseChunks` — the public surface.
 *
 * Consumes line-delimited SSE input (each item is one line of the
 * underlying `text/event-stream` body — caller has already done line
 * splitting). Yields Anthropic-shaped typed events in protocol
 * order.
 *
 * Filter rules (defensive):
 *   - Empty / whitespace-only lines: skipped.
 *   - Lines not starting with `data:` (SSE comments `:keep-alive`,
 *     `event:` markers, etc.): skipped.
 *   - `data: [DONE]`: special-cased as the message_stop trigger;
 *     NEVER JSON-parsed.
 *   - Other `data:` payloads: JSON-parsed inside a try/catch. Parse
 *     errors fire `phase137-codex-parse-error` and skip; the stream
 *     stays alive for subsequent valid chunks (T-137-05-01).
 *
 * Text content rules:
 *   - First non-empty `delta.content` opens a text content block
 *     (index 0 by convention) via `content_block_start`.
 *   - Each subsequent `delta.content` emits `content_block_delta`.
 *   - On finish_reason boundary, the open text block closes via
 *     `content_block_stop`.
 *
 * Tool-call rules:
 *   - Each `delta.tool_calls[i]` accumulates into the buffer keyed
 *     by `i`. `id` / `name` from any chunk overwrite (first wins by
 *     OpenAI convention; we tolerate later overwrites).
 *     `function.arguments` strings concatenate.
 *   - On `finish_reason: "tool_calls"` (or any finish_reason while
 *     the buffer is non-empty), each buffered entry emits
 *     `content_block_start` + a single consolidated
 *     `content_block_delta` + `content_block_stop`. Indices are
 *     allocated in buffer-insertion order starting AFTER the text
 *     block index (if any).
 *
 * Usage rules:
 *   - If a chunk carries a top-level `usage` field, it's folded into
 *     the `message_delta` event emitted at finish_reason.
 *
 * Terminal:
 *   - `data: [DONE]` (or end of input) → `message_stop`.
 */
export async function* normaliseOpenAiSseChunks(
  rawLines: AsyncIterable<string>,
  options?: { readonly logger?: StreamingLogger },
): AsyncIterable<NormalisedSseEvent> {
  const logger = options?.logger;

  let messageStartEmitted = false;
  let textBlockOpen = false;
  let textBlockEverOpened = false;
  let textBlockIndex = 0;
  let finishReason: string | null = null;
  let usage: OpenAiStreamChunk["usage"] | undefined;
  const toolCallBuffers = new Map<number, ToolCallBuffer>();
  // Insertion-order preservation — Map iteration is already insertion-
  // ordered in JS; this is just documentation.

  const emit = (event: NormalisedSseEvent): NormalisedSseEvent => {
    if (logger) {
      logger.info({ eventType: event.type }, "phase137-codex-sse-event");
    }
    return event;
  };

  function* flushTerminalEvents(
    sentinelStopReason: string | null,
  ): IterableIterator<NormalisedSseEvent> {
    // Close the text block (if any) BEFORE flushing tool_calls — keeps
    // the wire ordering "text first, tools second" parallel to the
    // OpenAI emission order.
    if (textBlockOpen) {
      yield emit({ type: "content_block_stop", index: textBlockIndex });
      textBlockOpen = false;
    }

    // Flush buffered tool_calls. Tool blocks live AFTER the text
    // block (if any) in the wire ordering; index 0 if no text block
    // ever opened, else textBlockIndex + 1.
    let toolStartIndex = textBlockEverOpened ? textBlockIndex + 1 : 0;

    for (const [, buf] of toolCallBuffers) {
      // Convert OpenAI tool_call → Anthropic tool_use via Plan 02
      // primitive. Parse errors here surface as a parse-error log +
      // skipped tool block; the rest of the stream proceeds.
      let toolUseBlock: AnthropicToolUseBlock | null = null;
      try {
        const call: OpenAIToolCall = {
          id: buf.id,
          type: "function",
          function: {
            name: buf.name,
            // Empty argumentsJson → `{}` so translateToolUseFromOpenAI
            // can JSON.parse it; the model produces zero-arg tool
            // calls in practice.
            arguments: buf.argumentsJson.length > 0 ? buf.argumentsJson : "{}",
          },
        };
        toolUseBlock = translateToolUseFromOpenAI(call);
      } catch (err) {
        if (logger) {
          logger.warn(
            {
              error: err instanceof Error ? err.message : String(err),
              toolName: buf.name,
            },
            "phase137-codex-parse-error",
          );
        }
        continue;
      }

      yield emit({
        type: "content_block_start",
        index: toolStartIndex,
        content_block: toolUseBlock,
      });
      yield emit({
        type: "content_block_delta",
        index: toolStartIndex,
        delta: {
          type: "input_json_delta",
          partial_json: buf.argumentsJson.length > 0 ? buf.argumentsJson : "{}",
        },
      });
      yield emit({ type: "content_block_stop", index: toolStartIndex });
      toolStartIndex += 1;
    }
    toolCallBuffers.clear();

    // Emit message_delta carrying the stop_reason + usage if either
    // is present. The plan's wire shape calls for ONE message_delta
    // at the end; we honour that.
    if (sentinelStopReason !== null || usage !== undefined) {
      yield emit({
        type: "message_delta",
        delta:
          sentinelStopReason !== null
            ? { stop_reason: mapStopReason(sentinelStopReason) }
            : {},
        usage: usage
          ? {
              input_tokens: usage.prompt_tokens,
              output_tokens: usage.completion_tokens,
            }
          : undefined,
      });
    }

    yield emit({ type: "message_stop" });
  }

  for await (const rawLine of rawLines) {
    const line = rawLine.replace(/\r$/, ""); // tolerate CRLF
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith("data:")) continue;

    // Strip exactly the `data:` prefix + optional single space per
    // SSE spec. Multiple-space prefixes are rare in practice but
    // tolerated.
    const afterPrefix = trimmed.slice(5).replace(/^\s+/, "");

    if (afterPrefix === "[DONE]") {
      // Terminator — flush any pending state then close the stream.
      if (!messageStartEmitted) {
        // Empty stream (just `[DONE]`) — still emit a minimal
        // message_start so consumers can rely on the boundary
        // marker. The plan's test #4 asserts this shape.
        yield emit({
          type: "message_start",
          message: { role: "assistant" },
        });
        messageStartEmitted = true;
      }
      yield* flushTerminalEvents(finishReason);
      return;
    }

    let chunk: OpenAiStreamChunk;
    try {
      chunk = JSON.parse(afterPrefix) as OpenAiStreamChunk;
    } catch (err) {
      if (logger) {
        logger.warn(
          {
            error: err instanceof Error ? err.message : String(err),
            line: afterPrefix.slice(0, 200),
          },
          "phase137-codex-parse-error",
        );
      }
      continue;
    }

    // First valid chunk → message_start.
    if (!messageStartEmitted) {
      yield emit({
        type: "message_start",
        message: {
          id: chunk.id,
          model: chunk.model,
          role: "assistant",
        },
      });
      messageStartEmitted = true;
    }

    // Fold top-level usage when present (OpenAI sends it in a final
    // standalone chunk; we accumulate so flushTerminalEvents emits
    // it on message_delta).
    if (chunk.usage) {
      usage = chunk.usage;
    }

    // Process choices[0] — Chat Completions streams a single choice
    // per chunk in practice; we read [0] defensively.
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta;

      // Text content delta.
      if (delta && typeof delta.content === "string" && delta.content.length > 0) {
        if (!textBlockOpen) {
          textBlockIndex = 0; // text block always lives at index 0
          textBlockEverOpened = true;
          yield emit({
            type: "content_block_start",
            index: textBlockIndex,
            content_block: { type: "text", text: "" },
          });
          textBlockOpen = true;
        }
        yield emit({
          type: "content_block_delta",
          index: textBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      // Tool-call deltas — accumulate into the index-keyed buffer.
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (typeof tc.index !== "number") continue;
          let buf = toolCallBuffers.get(tc.index);
          if (!buf) {
            buf = { id: "", name: "", argumentsJson: "" };
            toolCallBuffers.set(tc.index, buf);
          }
          if (typeof tc.id === "string" && tc.id.length > 0) {
            buf.id = tc.id;
          }
          const fn = tc.function;
          if (fn) {
            if (typeof fn.name === "string" && fn.name.length > 0) {
              buf.name = fn.name;
            }
            if (typeof fn.arguments === "string") {
              buf.argumentsJson += fn.arguments;
            }
          }
        }
      }

      // finish_reason — captured for the eventual flush. We do NOT
      // flush mid-stream; the [DONE] sentinel (or end-of-input)
      // triggers the flush so callers get a single terminal sequence.
      if (typeof choice.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
    }
  }

  // End of input WITHOUT a `[DONE]` sentinel — defensive flush. The
  // upstream Codex CLI may close stdout before emitting `[DONE]` on
  // error paths; we still want consumers to see a clean terminal
  // sequence.
  if (messageStartEmitted) {
    yield* flushTerminalEvents(finishReason);
  } else {
    // Truly empty input — emit the minimal boundary pair so consumers
    // don't see an empty iterator.
    yield emit({ type: "message_start", message: { role: "assistant" } });
    yield emit({ type: "message_stop" });
  }
}
