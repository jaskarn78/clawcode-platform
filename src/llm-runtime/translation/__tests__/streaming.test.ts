/**
 * Phase 137 Plan 05 T-01 — streaming SSE normalisation tests.
 *
 * Ten + cases from PLAN T-01 `<behavior>`:
 *  (1) Simple text-only stream.
 *  (2) Tool-call stream — deltas accumulate, finish_reason triggers
 *      consolidated content_block emission.
 *  (3) Mixed text + tool_call stream — ordering preserved.
 *  (4) Empty stream (just `[DONE]`) — minimal boundary pair.
 *  (5) Malformed JSON line — logged + skipped; subsequent valid
 *      chunks still emit.
 *  (6) `[DONE]` sentinel is NOT JSON-parsed.
 *  (7) Non-`data:` lines filtered (SSE comments, keep-alives, blank
 *      lines).
 *  (8) Usage propagation — token counts appear in `message_delta`.
 *  (9) Multiple parallel tool_calls (different indices) emit as
 *      separate content blocks.
 * (10) Plan 02 translation primitives invoked — assert the
 *      consolidated tool_use block matches what
 *      `translateToolUseFromOpenAI` produces.
 *
 * Plus defensive cases:
 *  - CRLF tolerance.
 *  - stop_reason mapping (stop → end_turn, length → max_tokens,
 *    tool_calls → tool_use).
 *  - End-of-input without explicit `[DONE]` still flushes terminal
 *    events.
 *  - Parse-error log fires with the correct phase tag.
 */

import { describe, it, expect, vi } from "vitest";

import {
  normaliseOpenAiSseChunks,
  type NormalisedSseEvent,
  type StreamingLogger,
} from "../streaming.js";

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

async function* fromArray(lines: readonly string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

async function collect(
  events: AsyncIterable<NormalisedSseEvent>,
): Promise<NormalisedSseEvent[]> {
  const out: NormalisedSseEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

function makeLogger() {
  const info = vi.fn<(obj: unknown, msg?: string) => void>();
  const warn = vi.fn<(obj: unknown, msg?: string) => void>();
  const logger: StreamingLogger = { info, warn };
  return Object.assign(logger, { info, warn });
}

function sseDataLine(payload: object | string): string {
  if (typeof payload === "string") return `data: ${payload}`;
  return `data: ${JSON.stringify(payload)}`;
}

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

describe("normaliseOpenAiSseChunks", () => {
  it("(1) simple text-only stream → expected Anthropic event sequence", async () => {
    const lines = [
      sseDataLine({
        id: "chatcmpl-1",
        model: "gpt-5-codex",
        choices: [{ delta: { role: "assistant", content: "Hello" } }],
      }),
      sseDataLine({
        choices: [{ delta: { content: " world" } }],
      }),
      sseDataLine({
        choices: [{ delta: {}, finish_reason: "stop" }],
      }),
      "data: [DONE]",
    ];
    const events = await collect(normaliseOpenAiSseChunks(fromArray(lines)));

    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const start = events[0] as Extract<NormalisedSseEvent, { type: "message_start" }>;
    expect(start.message.id).toBe("chatcmpl-1");
    expect(start.message.model).toBe("gpt-5-codex");
    expect(start.message.role).toBe("assistant");

    const blockStart = events[1] as Extract<
      NormalisedSseEvent,
      { type: "content_block_start" }
    >;
    expect(blockStart.index).toBe(0);
    expect(blockStart.content_block).toEqual({ type: "text", text: "" });

    const delta1 = events[2] as Extract<
      NormalisedSseEvent,
      { type: "content_block_delta" }
    >;
    expect(delta1.delta).toEqual({ type: "text_delta", text: "Hello" });

    const delta2 = events[3] as Extract<
      NormalisedSseEvent,
      { type: "content_block_delta" }
    >;
    expect(delta2.delta).toEqual({ type: "text_delta", text: " world" });

    const stop = events[4] as Extract<
      NormalisedSseEvent,
      { type: "content_block_stop" }
    >;
    expect(stop.index).toBe(0);

    const msgDelta = events[5] as Extract<
      NormalisedSseEvent,
      { type: "message_delta" }
    >;
    expect(msgDelta.delta.stop_reason).toBe("end_turn");
  });

  it("(2) tool-call stream — deltas accumulate, finish_reason triggers consolidated block", async () => {
    const lines = [
      sseDataLine({
        id: "chatcmpl-2",
        model: "gpt-5-codex",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  type: "function",
                  function: { name: "read_file", arguments: '{"pa' },
                },
              ],
            },
          },
        ],
      }),
      sseDataLine({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'th":"/tmp/x"}' },
                },
              ],
            },
          },
        ],
      }),
      sseDataLine({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }),
      "data: [DONE]",
    ];
    const events = await collect(normaliseOpenAiSseChunks(fromArray(lines)));

    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const blockStart = events[1] as Extract<
      NormalisedSseEvent,
      { type: "content_block_start" }
    >;
    expect(blockStart.index).toBe(0); // no text block — tool block lives at 0
    expect(blockStart.content_block).toEqual({
      type: "tool_use",
      id: "call_abc",
      name: "read_file",
      input: { path: "/tmp/x" },
    });

    const msgDelta = events[4] as Extract<
      NormalisedSseEvent,
      { type: "message_delta" }
    >;
    expect(msgDelta.delta.stop_reason).toBe("tool_use");
  });

  it("(3) mixed text + tool_call — text at index 0, tool at index 1", async () => {
    const lines = [
      sseDataLine({
        choices: [{ delta: { role: "assistant", content: "Sure, reading " } }],
      }),
      sseDataLine({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_xyz",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"x"}' },
                },
              ],
            },
          },
        ],
      }),
      sseDataLine({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }),
      "data: [DONE]",
    ];
    const events = await collect(normaliseOpenAiSseChunks(fromArray(lines)));

    // Text block (index 0): start + delta + stop
    // Tool block (index 1): start + delta + stop
    // Terminal: message_delta + message_stop
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "message_start",
      "content_block_start", // text
      "content_block_delta", // text "Sure, reading "
      "content_block_stop",  // close text
      "content_block_start", // tool
      "content_block_delta", // tool input
      "content_block_stop",  // close tool
      "message_delta",
      "message_stop",
    ]);

    const textStart = events[1] as Extract<
      NormalisedSseEvent,
      { type: "content_block_start" }
    >;
    expect(textStart.index).toBe(0);
    expect(textStart.content_block.type).toBe("text");

    const toolStart = events[4] as Extract<
      NormalisedSseEvent,
      { type: "content_block_start" }
    >;
    expect(toolStart.index).toBe(1);
    expect(toolStart.content_block.type).toBe("tool_use");
  });

  it("(4) empty stream (just [DONE]) → minimal message_start + message_stop", async () => {
    const events = await collect(
      normaliseOpenAiSseChunks(fromArray(["data: [DONE]"])),
    );
    expect(events.map((e) => e.type)).toEqual(["message_start", "message_stop"]);
  });

  it("(5) malformed JSON line is skipped, subsequent valid chunks still emit", async () => {
    const logger = makeLogger();
    const lines = [
      "data: {not valid json",
      sseDataLine({
        id: "chatcmpl-x",
        choices: [{ delta: { role: "assistant", content: "ok" } }],
      }),
      sseDataLine({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      "data: [DONE]",
    ];
    const events = await collect(
      normaliseOpenAiSseChunks(fromArray(lines), { logger }),
    );

    // The malformed line was skipped — events look like a 1-chunk
    // text stream.
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    // Parse-error log fired exactly once.
    const parseErrors = logger.warn.mock.calls.filter(
      (c) => c[1] === "phase137-codex-parse-error",
    );
    expect(parseErrors).toHaveLength(1);
  });

  it("(6) `[DONE]` sentinel is NEVER JSON-parsed (no parse-error log)", async () => {
    const logger = makeLogger();
    await collect(
      normaliseOpenAiSseChunks(fromArray(["data: [DONE]"]), { logger }),
    );
    const parseErrors = logger.warn.mock.calls.filter(
      (c) => c[1] === "phase137-codex-parse-error",
    );
    expect(parseErrors).toHaveLength(0);
  });

  it("(7) non-`data:` lines are filtered (SSE comments, blank lines, event:)", async () => {
    const lines = [
      "", // blank
      ":keepalive", // SSE comment
      "event: message", // SSE event-type marker
      sseDataLine({
        choices: [{ delta: { content: "x" }, finish_reason: "stop" }],
      }),
      "data: [DONE]",
    ];
    const events = await collect(normaliseOpenAiSseChunks(fromArray(lines)));
    // The filtered lines didn't break anything — we get a normal text
    // stream.
    expect(events.map((e) => e.type)).toContain("content_block_start");
    expect(events.map((e) => e.type)).toContain("message_stop");
  });

  it("(8) usage propagation — input_tokens/output_tokens in message_delta", async () => {
    const lines = [
      sseDataLine({
        choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
      }),
      sseDataLine({
        usage: {
          prompt_tokens: 42,
          completion_tokens: 7,
          total_tokens: 49,
        },
      }),
      "data: [DONE]",
    ];
    const events = await collect(normaliseOpenAiSseChunks(fromArray(lines)));
    const msgDelta = events.find((e) => e.type === "message_delta") as
      | Extract<NormalisedSseEvent, { type: "message_delta" }>
      | undefined;
    expect(msgDelta).toBeDefined();
    expect(msgDelta?.usage).toEqual({ input_tokens: 42, output_tokens: 7 });
  });

  it("(9) multiple parallel tool_calls emit as separate content blocks (insertion order)", async () => {
    const lines = [
      sseDataLine({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_a",
                  type: "function",
                  function: { name: "tool_a", arguments: '{"x":1}' },
                },
                {
                  index: 1,
                  id: "call_b",
                  type: "function",
                  function: { name: "tool_b", arguments: '{"y":2}' },
                },
              ],
            },
          },
        ],
      }),
      sseDataLine({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }),
      "data: [DONE]",
    ];
    const events = await collect(normaliseOpenAiSseChunks(fromArray(lines)));

    const starts = events.filter(
      (e) => e.type === "content_block_start",
    ) as Extract<NormalisedSseEvent, { type: "content_block_start" }>[];
    expect(starts).toHaveLength(2);
    expect(starts[0]!.index).toBe(0);
    expect(starts[1]!.index).toBe(1);
    expect((starts[0]!.content_block as { name: string }).name).toBe("tool_a");
    expect((starts[1]!.content_block as { name: string }).name).toBe("tool_b");
  });

  it("(10) Plan 02 translation primitive (translateToolUseFromOpenAI) produces the tool_use block", async () => {
    // The consolidated tool_use block must match exactly what the
    // Plan-02 helper produces from the same OpenAI call shape — we
    // assert structural equality rather than spying on the call site
    // (the helper is pure; same input → same output is the
    // observable behaviour).
    const lines = [
      sseDataLine({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_assert",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: '{"path":"/x","content":"hello"}',
                  },
                },
              ],
            },
          },
        ],
      }),
      sseDataLine({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }),
      "data: [DONE]",
    ];
    const events = await collect(normaliseOpenAiSseChunks(fromArray(lines)));
    const start = events.find((e) => e.type === "content_block_start") as
      | Extract<NormalisedSseEvent, { type: "content_block_start" }>
      | undefined;
    expect(start?.content_block).toEqual({
      type: "tool_use",
      id: "call_assert",
      name: "write_file",
      input: { path: "/x", content: "hello" },
    });
  });

  // --- Defensive cases ---

  it("CRLF tolerance — `data: {...}\\r\\n`-style lines parse cleanly", async () => {
    const lines = [
      `${sseDataLine({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\r`,
      "data: [DONE]\r",
    ];
    const events = await collect(normaliseOpenAiSseChunks(fromArray(lines)));
    expect(events.map((e) => e.type)).toContain("message_stop");
    const delta = events.find((e) => e.type === "content_block_delta") as
      | Extract<NormalisedSseEvent, { type: "content_block_delta" }>
      | undefined;
    expect((delta?.delta as { text: string }).text).toBe("hi");
  });

  it("finish_reason: length → stop_reason: max_tokens", async () => {
    const lines = [
      sseDataLine({
        choices: [{ delta: { content: "..." }, finish_reason: "length" }],
      }),
      "data: [DONE]",
    ];
    const events = await collect(normaliseOpenAiSseChunks(fromArray(lines)));
    const msgDelta = events.find((e) => e.type === "message_delta") as
      | Extract<NormalisedSseEvent, { type: "message_delta" }>
      | undefined;
    expect(msgDelta?.delta.stop_reason).toBe("max_tokens");
  });

  it("end-of-input without [DONE] still flushes terminal events", async () => {
    const lines = [
      sseDataLine({
        choices: [{ delta: { content: "abrupt" }, finish_reason: "stop" }],
      }),
      // No [DONE] sentinel — stream ends.
    ];
    const events = await collect(normaliseOpenAiSseChunks(fromArray(lines)));
    expect(events.map((e) => e.type)).toContain("message_stop");
    expect(events.map((e) => e.type)).toContain("content_block_stop");
  });

  it("logger emits phase137-codex-sse-event per yielded event", async () => {
    const logger = makeLogger();
    const lines = [
      sseDataLine({
        choices: [{ delta: { content: "x" }, finish_reason: "stop" }],
      }),
      "data: [DONE]",
    ];
    const events = await collect(
      normaliseOpenAiSseChunks(fromArray(lines), { logger }),
    );
    const sseLogs = logger.info.mock.calls.filter(
      (c) => c[1] === "phase137-codex-sse-event",
    );
    // One log per yielded event.
    expect(sseLogs.length).toBe(events.length);
  });
});
