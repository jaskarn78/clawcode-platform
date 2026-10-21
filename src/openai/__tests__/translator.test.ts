/**
 * Phase 69 Plan 02 — unit tests for src/openai/translator.ts (OPENAI-06).
 *
 * Covers every row of 69-VALIDATION.md task 69-02-02 plus Pitfalls 1, 2, 3, 8:
 *   - translateRequest (last-user extraction, systemPrompt APPEND NEVER
 *     OVERRIDE — Pitfall 8, tool translation, tool_choice translation,
 *     tool_result collection, NoUserMessageError).
 *   - makeNonStreamResponse (chatcmpl- prefix, epoch-seconds created,
 *     content-null when tool_calls present, usage mapping, finish_reason
 *     derivation — Pitfall 2).
 *   - translateClaudeToolUseToOpenAi (JSON.stringify arguments).
 *   - createStreamingTranslator on the text fixture: role on first chunk only
 *     (Pitfall 3), text deltas, final chunk with delta:{} and finish_reason:stop.
 *   - createStreamingTranslator on the tool-use fixture: Map<tool_use_id,
 *     openaiIndex> produces sequential indices (Pitfall 1), first chunk per
 *     tool index carries id+type+function.name+arguments:"", subsequent
 *     chunks carry only {index, function:{arguments}}, arguments concatenation
 *     yields valid JSON, finish_reason:"tool_calls" on finalize.
 *   - Parallel tool-call ordering preserved.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  translateRequest,
  translateClaudeToolUseToOpenAi,
  translateToolResult,
  makeNonStreamResponse,
  makeChunk,
  newChatCompletionId,
  createStreamingTranslator,
  deriveUsage,
  NoUserMessageError,
} from "../translator.js";
import type {
  ChatCompletionRequest,
  SdkStreamEvent,
} from "../types.js";

// Fixture loading -----------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");
const textStreamFixture: SdkStreamEvent[] = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "sdk-stream-text.json"), "utf8"),
);
const toolUseStreamFixture: SdkStreamEvent[] = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "sdk-stream-tool-use.json"), "utf8"),
);

// Tiny helper so tests can build a minimal valid request body without
// restating every passthrough field.
function req(overrides: Partial<ChatCompletionRequest> & Pick<ChatCompletionRequest, "messages" | "model">): ChatCompletionRequest {
  return {
    stream: false,
    ...overrides,
  } as ChatCompletionRequest;
}

// ---------------------------------------------------------------------------
// translateRequest
// ---------------------------------------------------------------------------

describe("translateRequest", () => {
  it("extracts the last user message as lastUserMessage", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [
          { role: "system", content: "stay on topic" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "bye" },
        ],
      }),
    );
    expect(result.lastUserMessage).toBe("bye");
  });

  it("concatenates all system messages into clientSystemAppend (Pitfall 8 — APPEND, never OVERRIDE)", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [
          { role: "system", content: "sys-1" },
          { role: "system", content: "sys-2" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    expect(result.clientSystemAppend).toBe("sys-1\n\nsys-2");
  });

  it("returns clientSystemAppend === null when no system messages", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(result.clientSystemAppend).toBeNull();
  });

  it("translates tools: OpenAI {type:function, function:{name, description, parameters}} → Claude {name, description, input_schema}", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "lookup weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      }),
    );
    expect(result.tools).toEqual([
      {
        name: "get_weather",
        description: "lookup weather",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
  });

  it("tolerates missing description and parameters on tool def (description becomes '', input_schema becomes {})", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "noop" } }],
      }),
    );
    expect(result.tools).toEqual([
      { name: "noop", description: "", input_schema: {} },
    ]);
  });

  it("translates tool_choice: 'auto' → {type:'auto'}", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: "auto",
      }),
    );
    expect(result.toolChoice).toEqual({ type: "auto" });
  });

  it("translates tool_choice: 'none' → {type:'none'}", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: "none",
      }),
    );
    expect(result.toolChoice).toEqual({ type: "none" });
  });

  it("translates tool_choice: 'required' → {type:'any'}", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: "required",
      }),
    );
    expect(result.toolChoice).toEqual({ type: "any" });
  });

  it("translates tool_choice: {type:'function', function:{name}} → {type:'tool', name}", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: { type: "function", function: { name: "get_weather" } },
      }),
    );
    expect(result.toolChoice).toEqual({ type: "tool", name: "get_weather" });
  });

  it("returns toolChoice === null when the client omits tool_choice", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(result.toolChoice).toBeNull();
  });

  it("collects a single role:'tool' message into toolResults with matching tool_call_id → tool_use_id", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_x", type: "function", function: { name: "get_weather", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "call_x", content: "72F" },
          { role: "user", content: "thanks" },
        ],
      }),
    );
    expect(result.toolResults).toEqual([
      { type: "tool_result", tool_use_id: "call_x", content: "72F" },
    ]);
  });

  it("collects multiple role:'tool' messages preserving client order", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [
          { role: "user", content: "weather + time?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_a", type: "function", function: { name: "get_weather", arguments: "{}" } },
              { id: "call_b", type: "function", function: { name: "get_time", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "call_a", content: "72F" },
          { role: "tool", tool_call_id: "call_b", content: "15:30" },
          { role: "user", content: "thanks" },
        ],
      }),
    );
    expect(result.toolResults).toEqual([
      { type: "tool_result", tool_use_id: "call_a", content: "72F" },
      { type: "tool_result", tool_use_id: "call_b", content: "15:30" },
    ]);
  });

  it("throws NoUserMessageError when no user message present", () => {
    expect(() =>
      translateRequest(
        req({
          model: "clawdy",
          // Only a system message — no user message.
          messages: [{ role: "system", content: "alone" }] as never,
        }),
      ),
    ).toThrowError(NoUserMessageError);
  });
});

// ---------------------------------------------------------------------------
// translateRequest — vision / inline images (CAM-01/02)
// ---------------------------------------------------------------------------

/** Build a multipart user message with the given content parts. */
function userParts(parts: unknown[]) {
  return { role: "user", content: parts } as never;
}
const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgg=";
const imgPart = (url: string) => ({ type: "image_url", image_url: { url } });
const textPart = (text: string) => ({ type: "text", text });

describe("translateRequest — vision (CAM-01/02)", () => {
  it("extracts a base64 data-URL image into lastUserImages (mediaType + raw base64)", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [userParts([imgPart(`data:image/png;base64,${PNG_DATA}`)])],
      }),
    );
    expect(result.lastUserImages).toEqual([{ mediaType: "image/png", data: PNG_DATA }]);
  });

  it("keeps text in lastUserMessage and image in lastUserImages (no ![image]() placeholder)", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [
          userParts([
            textPart("what is this?"),
            imgPart(`data:image/jpeg;base64,${PNG_DATA}`),
          ]),
        ],
      }),
    );
    expect(result.lastUserMessage).toBe("what is this?");
    expect(result.lastUserMessage).not.toContain("![image]");
    expect(result.lastUserImages).toEqual([{ mediaType: "image/jpeg", data: PNG_DATA }]);
  });

  it("accepts an image-only message (empty text, one image, no NoUserMessageError)", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [userParts([imgPart(`data:image/webp;base64,${PNG_DATA}`)])],
      }),
    );
    expect(result.lastUserMessage).toBe("");
    expect(result.lastUserImages).toHaveLength(1);
    expect(result.lastUserImages[0].mediaType).toBe("image/webp");
  });

  it("SSRF-safe: remote (http/https/file) URLs are NEVER inlined or fetched, but surfaced as text placeholders (back-compat on the shared endpoint)", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [
          userParts([
            textPart("look"),
            imgPart("https://evil.example.com/a.png"),
            imgPart("file:///etc/passwd"),
            imgPart("http://169.254.169.254/latest/meta-data/"),
          ]),
        ],
      }),
    );
    // Never inlined as image content (the bytes are never fetched)...
    expect(result.lastUserImages).toEqual([]);
    // ...but preserved as markdown links so the model still sees the reference
    // (matches the legacy contentToString behavior — text only, never a fetch).
    expect(result.lastUserMessage).toContain("look");
    expect(result.lastUserMessage).toContain("![image](https://evil.example.com/a.png)");
    expect(result.lastUserMessage).toContain("![image](file:///etc/passwd)");
    expect(result.lastUserMessage).toContain("![image](http://169.254.169.254/latest/meta-data/)");
  });

  it("unsupported-MIME data-URLs (svg, tiff) are not inlined and their base64 is NOT dumped into text", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [
          userParts([
            imgPart(`data:image/svg+xml;base64,${PNG_DATA}`),
            imgPart(`data:image/tiff;base64,${PNG_DATA}`),
            imgPart(`data:image/png;base64,${PNG_DATA}`),
          ]),
        ],
      }),
    );
    expect(result.lastUserImages).toEqual([{ mediaType: "image/png", data: PNG_DATA }]);
    // The two unsupported data-URLs are noted, NOT dumped as raw base64 blobs.
    expect(result.lastUserMessage).toContain("[image omitted");
    expect(result.lastUserMessage).not.toContain(PNG_DATA);
  });

  it("strips whitespace from line-wrapped base64 payloads", () => {
    const wrapped = `data:image/png;base64,${PNG_DATA.slice(0, 8)}\n  ${PNG_DATA.slice(8)}`;
    const result = translateRequest(
      req({ model: "clawdy", messages: [userParts([imgPart(wrapped)])] }),
    );
    expect(result.lastUserImages).toEqual([{ mediaType: "image/png", data: PNG_DATA }]);
  });

  it("caps inline images at 8 (MAX_USER_IMAGES)", () => {
    const parts = Array.from({ length: 12 }, () =>
      imgPart(`data:image/png;base64,${PNG_DATA}`),
    );
    const result = translateRequest(
      req({ model: "clawdy", messages: [userParts(parts)] }),
    );
    expect(result.lastUserImages).toHaveLength(8);
  });

  it("text-only and string-content messages yield an empty lastUserImages (no regression)", () => {
    const multipart = translateRequest(
      req({ model: "clawdy", messages: [userParts([textPart("just text")])] }),
    );
    expect(multipart.lastUserImages).toEqual([]);
    const stringContent = translateRequest(
      req({ model: "clawdy", messages: [{ role: "user", content: "plain" }] }),
    );
    expect(stringContent.lastUserImages).toEqual([]);
  });

  it("only the LAST user message's images are extracted", () => {
    const result = translateRequest(
      req({
        model: "clawdy",
        messages: [
          userParts([imgPart(`data:image/png;base64,${PNG_DATA}`)]),
          { role: "assistant", content: "ok" } as never,
          userParts([textPart("now this"), imgPart(`data:image/gif;base64,${PNG_DATA}`)]),
        ],
      }),
    );
    expect(result.lastUserMessage).toBe("now this");
    expect(result.lastUserImages).toEqual([{ mediaType: "image/gif", data: PNG_DATA }]);
  });
});

// ---------------------------------------------------------------------------
// translateToolResult (exported helper)
// ---------------------------------------------------------------------------

describe("translateToolResult", () => {
  it("shapes a Claude tool_result block", () => {
    expect(translateToolResult({ tool_call_id: "call_z", content: "ok" })).toEqual({
      type: "tool_result",
      tool_use_id: "call_z",
      content: "ok",
    });
  });
});

// ---------------------------------------------------------------------------
// newChatCompletionId
// ---------------------------------------------------------------------------

describe("newChatCompletionId", () => {
  it("returns an id with 'chatcmpl-' prefix", () => {
    const id = newChatCompletionId();
    expect(id.startsWith("chatcmpl-")).toBe(true);
    expect(id.length).toBeGreaterThan("chatcmpl-".length);
  });

  it("returns distinct ids on successive calls", () => {
    const a = newChatCompletionId();
    const b = newChatCompletionId();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// deriveUsage
// ---------------------------------------------------------------------------

describe("deriveUsage", () => {
  it("maps input+cache_read → prompt_tokens, output → completion_tokens, sum → total_tokens", () => {
    expect(
      deriveUsage({ input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5 }),
    ).toEqual({ prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 });
  });

  it("defaults missing fields to 0 (Pitfall 2 — never emit {} )", () => {
    expect(deriveUsage(undefined)).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// makeNonStreamResponse
// ---------------------------------------------------------------------------

describe("makeNonStreamResponse", () => {
  it("produces id with 'chatcmpl-' prefix", () => {
    const r = makeNonStreamResponse({
      model: "clawdy",
      text: "hi",
      toolCalls: [],
      usage: undefined,
    });
    expect(r.id.startsWith("chatcmpl-")).toBe(true);
  });

  it("reuses caller-provided id when given (for stream ↔ final-response id alignment)", () => {
    const r = makeNonStreamResponse({
      id: "chatcmpl-fixed-xyz",
      model: "clawdy",
      text: "hi",
      toolCalls: [],
      usage: undefined,
    });
    expect(r.id).toBe("chatcmpl-fixed-xyz");
  });

  it("created is seconds since epoch — not milliseconds (Pitfall 2 strict field)", () => {
    const r = makeNonStreamResponse({
      model: "clawdy",
      text: "hi",
      toolCalls: [],
      usage: undefined,
    });
    // 2026-04-18 in seconds ~ 1.77e9. In ms it would be 1.77e12.
    expect(r.created).toBeGreaterThan(1_700_000_000);
    expect(r.created).toBeLessThan(2_000_000_000);
  });

  it("content is null when tool_calls present and text empty (Pitfall 2)", () => {
    const r = makeNonStreamResponse({
      model: "clawdy",
      text: "",
      toolCalls: [
        { id: "call_a", type: "function", function: { name: "get_weather", arguments: "{}" } },
      ],
      usage: undefined,
    });
    expect(r.choices[0]!.message.content).toBeNull();
  });

  it("content is the text when no tool_calls", () => {
    const r = makeNonStreamResponse({
      model: "clawdy",
      text: "hi there",
      toolCalls: [],
      usage: undefined,
    });
    expect(r.choices[0]!.message.content).toBe("hi there");
  });

  it("populates usage from Claude input/output/cache_read tokens", () => {
    const r = makeNonStreamResponse({
      model: "clawdy",
      text: "hi",
      toolCalls: [],
      usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5 },
    });
    expect(r.usage).toEqual({ prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 });
  });

  it("finish_reason is 'tool_calls' when tool_calls non-empty", () => {
    const r = makeNonStreamResponse({
      model: "clawdy",
      text: "",
      toolCalls: [
        { id: "call_a", type: "function", function: { name: "f", arguments: "{}" } },
      ],
      usage: undefined,
    });
    expect(r.choices[0]!.finish_reason).toBe("tool_calls");
  });

  it("finish_reason is 'stop' when no tool_calls", () => {
    const r = makeNonStreamResponse({
      model: "clawdy",
      text: "hi",
      toolCalls: [],
      usage: undefined,
    });
    expect(r.choices[0]!.finish_reason).toBe("stop");
  });

  it("emits system_fingerprint: null and logprobs: null (Pitfall 2 — present-but-null)", () => {
    const r = makeNonStreamResponse({
      model: "clawdy",
      text: "hi",
      toolCalls: [],
      usage: undefined,
    });
    expect(r.system_fingerprint).toBeNull();
    expect(r.choices[0]!.logprobs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// translateClaudeToolUseToOpenAi
// ---------------------------------------------------------------------------

describe("translateClaudeToolUseToOpenAi", () => {
  it("serializes input via JSON.stringify into function.arguments string", () => {
    expect(
      translateClaudeToolUseToOpenAi({ id: "tu_x", name: "get_weather", input: { city: "NYC" } }),
    ).toEqual({
      id: "tu_x",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"NYC"}' },
    });
  });

  it("handles null/undefined input as '{}'", () => {
    expect(
      translateClaudeToolUseToOpenAi({ id: "tu_x", name: "f", input: null as unknown }),
    ).toEqual({
      id: "tu_x",
      type: "function",
      function: { name: "f", arguments: "{}" },
    });
  });
});

// ---------------------------------------------------------------------------
// createStreamingTranslator — text stream fixture
// ---------------------------------------------------------------------------

describe("createStreamingTranslator (text stream)", () => {
  it("first chunk carries role:'assistant' exactly once, content:'' (Pitfall 3)", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-t1", model: "clawdy" });
    const emitted = textStreamFixture.flatMap((e) => t.onEvent(e));
    const primer = emitted[0]!;
    expect(primer.choices[0]!.delta.role).toBe("assistant");
    expect(primer.choices[0]!.delta.content).toBe("");
    // Subsequent chunks must not carry role.
    for (let i = 1; i < emitted.length; i++) {
      expect(emitted[i]!.choices[0]!.delta.role).toBeUndefined();
    }
  });

  it("subsequent text_delta chunks carry content but NO role", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-t2", model: "clawdy" });
    const emitted = textStreamFixture.flatMap((e) => t.onEvent(e));
    const textChunks = emitted.filter((c) => c.choices[0]!.delta.content !== undefined && c.choices[0]!.delta.content !== "");
    expect(textChunks.length).toBeGreaterThan(0);
    for (const c of textChunks) {
      expect(c.choices[0]!.delta.role).toBeUndefined();
      expect(typeof c.choices[0]!.delta.content).toBe("string");
    }
  });

  it("concatenated content equals the recorded message text 'Hello, human.'", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-t3", model: "clawdy" });
    const emitted = textStreamFixture.flatMap((e) => t.onEvent(e));
    const concat = emitted
      .map((c) => c.choices[0]!.delta.content ?? "")
      .join("");
    expect(concat).toBe("Hello, human.");
    expect(t.collectedText).toBe("Hello, human.");
  });

  it("finalize() emits a final chunk with delta:{} and finish_reason:'stop'", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-t4", model: "clawdy" });
    for (const e of textStreamFixture) t.onEvent(e);
    const finals = t.finalize();
    expect(finals).toHaveLength(1);
    expect(finals[0]!.choices[0]!.delta).toEqual({});
    expect(finals[0]!.choices[0]!.finish_reason).toBe("stop");
  });

  it("every emitted chunk shares the turn id and object 'chat.completion.chunk'", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-t5", model: "clawdy" });
    const emitted = [
      ...textStreamFixture.flatMap((e) => t.onEvent(e)),
      ...t.finalize(),
    ];
    for (const c of emitted) {
      expect(c.id).toBe("chatcmpl-t5");
      expect(c.object).toBe("chat.completion.chunk");
      expect(c.model).toBe("clawdy");
    }
  });

  it("hadToolUse is false for a text-only turn", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-t6", model: "clawdy" });
    for (const e of textStreamFixture) t.onEvent(e);
    expect(t.hadToolUse).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createStreamingTranslator — tool-use stream fixture (Pitfall 1)
// ---------------------------------------------------------------------------

describe("createStreamingTranslator (tool-use stream — Pitfall 1)", () => {
  it("each tool_use block is assigned a distinct sequential openai index (0, 1) via Map<id, openaiIndex>", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-u1", model: "clawdy" });
    const emitted = toolUseStreamFixture.flatMap((e) => t.onEvent(e));
    const toolStartChunks = emitted.filter(
      (c) => c.choices[0]!.delta.tool_calls?.[0]?.id !== undefined,
    );
    expect(toolStartChunks).toHaveLength(2);
    // First start — tu_aaa at openaiIndex 0
    expect(toolStartChunks[0]!.choices[0]!.delta.tool_calls![0]).toMatchObject({
      index: 0,
      id: "tu_aaa",
      type: "function",
      function: { name: "get_weather", arguments: "" },
    });
    // Second start — tu_bbb at openaiIndex 1
    expect(toolStartChunks[1]!.choices[0]!.delta.tool_calls![0]).toMatchObject({
      index: 1,
      id: "tu_bbb",
      type: "function",
      function: { name: "get_time", arguments: "" },
    });
  });

  it("the role primer chunk is emitted BEFORE the first tool_calls chunk", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-u2", model: "clawdy" });
    const emitted = toolUseStreamFixture.flatMap((e) => t.onEvent(e));
    // First chunk should be the role primer with empty content.
    expect(emitted[0]!.choices[0]!.delta).toEqual({ role: "assistant", content: "" });
    // Second chunk should be the first tool_calls start.
    expect(emitted[1]!.choices[0]!.delta.tool_calls?.[0]).toMatchObject({
      index: 0,
      id: "tu_aaa",
    });
  });

  it("subsequent input_json_delta events carry ONLY {index, function:{arguments}} — no id, no type", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-u3", model: "clawdy" });
    const emitted = toolUseStreamFixture.flatMap((e) => t.onEvent(e));
    const argChunks = emitted.filter(
      (c) =>
        c.choices[0]!.delta.tool_calls?.[0]?.function?.arguments !== undefined &&
        c.choices[0]!.delta.tool_calls?.[0]?.id === undefined,
    );
    expect(argChunks.length).toBeGreaterThan(0);
    for (const c of argChunks) {
      const tc = c.choices[0]!.delta.tool_calls![0]!;
      expect(tc.id).toBeUndefined();
      expect(tc.type).toBeUndefined();
      expect(typeof tc.index).toBe("number");
      expect(typeof tc.function?.arguments).toBe("string");
    }
  });

  it("concatenated arguments per openai index yield valid JSON after all deltas", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-u4", model: "clawdy" });
    const emitted = toolUseStreamFixture.flatMap((e) => t.onEvent(e));
    const perIndex = new Map<number, string>();
    for (const c of emitted) {
      const tc = c.choices[0]!.delta.tool_calls?.[0];
      if (!tc) continue;
      const existing = perIndex.get(tc.index) ?? "";
      perIndex.set(tc.index, existing + (tc.function?.arguments ?? ""));
    }
    expect(perIndex.get(0)).toBe('{"city":"NYC"}');
    expect(perIndex.get(1)).toBe('{"tz":"ET"}');
    expect(() => JSON.parse(perIndex.get(0)!)).not.toThrow();
    expect(() => JSON.parse(perIndex.get(1)!)).not.toThrow();
  });

  it("finalize() emits final chunk with finish_reason:'tool_calls' when hadToolUse is true", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-u5", model: "clawdy" });
    for (const e of toolUseStreamFixture) t.onEvent(e);
    expect(t.hadToolUse).toBe(true);
    const finals = t.finalize();
    expect(finals).toHaveLength(1);
    expect(finals[0]!.choices[0]!.delta).toEqual({});
    expect(finals[0]!.choices[0]!.finish_reason).toBe("tool_calls");
  });

  it("interleaved deltas across indices preserve per-index correctness (Pitfall 1)", () => {
    // The fixture is already interleaved — block 0 start, block 0 delta,
    // block 1 start, block 0 delta, block 1 delta. If index assignment were
    // position-based instead of id-based, the args would get crossed.
    const t = createStreamingTranslator({ id: "chatcmpl-u6", model: "clawdy" });
    for (const e of toolUseStreamFixture) t.onEvent(e);
    const collected = t.collectedToolCalls;
    expect(collected).toHaveLength(2);
    expect(collected[0]!).toEqual({
      id: "tu_aaa",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"NYC"}' },
    });
    expect(collected[1]!).toEqual({
      id: "tu_bbb",
      type: "function",
      function: { name: "get_time", arguments: '{"tz":"ET"}' },
    });
  });

  it("collectedToolCalls reflects the per-index snapshot for a final non-stream response", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-u7", model: "clawdy" });
    for (const e of toolUseStreamFixture) t.onEvent(e);
    const calls = t.collectedToolCalls;
    // Usable directly by makeNonStreamResponse for a tool-calls-only turn.
    const resp = makeNonStreamResponse({
      id: "chatcmpl-u7",
      model: "clawdy",
      text: "",
      toolCalls: calls,
      usage: t.usage,
    });
    expect(resp.choices[0]!.message.content).toBeNull();
    expect(resp.choices[0]!.finish_reason).toBe("tool_calls");
    expect(resp.choices[0]!.message.tool_calls).toHaveLength(2);
  });

  it("usage is captured from the result event", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-u8", model: "clawdy" });
    for (const e of toolUseStreamFixture) t.onEvent(e);
    expect(t.usage).toEqual({
      input_tokens: 20,
      output_tokens: 10,
      cache_read_input_tokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// createStreamingTranslator — parallel tool calls preserve order
// ---------------------------------------------------------------------------

describe("createStreamingTranslator — parallel tool calls preserve order", () => {
  it("tu_aaa is always openaiIndex 0 and tu_bbb is always 1 regardless of interleave", () => {
    // Same fixture — this test documents the contract explicitly.
    const t = createStreamingTranslator({ id: "chatcmpl-p1", model: "clawdy" });
    for (const e of toolUseStreamFixture) t.onEvent(e);
    const collected = t.collectedToolCalls;
    const aaaIndex = collected.findIndex((c) => c.id === "tu_aaa");
    const bbbIndex = collected.findIndex((c) => c.id === "tu_bbb");
    expect(aaaIndex).toBe(0);
    expect(bbbIndex).toBe(1);
  });

  it("re-ordered starts — tu_zzz first then tu_aaa — map to index 0 and 1 in assignment order", () => {
    // Synthesize a small fixture: start tu_zzz @ sdk-index 0, then tu_aaa @
    // sdk-index 1, interleave their json deltas, stop them. Expect openaiIndex
    // of tu_zzz === 0 (because it started first), tu_aaa === 1.
    const events: SdkStreamEvent[] = [
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_zzz", name: "alpha" } } },
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_aaa", name: "beta" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"b\":1}" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"a\":2}" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
      { type: "result", session_id: "s", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } },
    ];
    const t = createStreamingTranslator({ id: "chatcmpl-p2", model: "clawdy" });
    for (const e of events) t.onEvent(e);
    const collected = t.collectedToolCalls;
    expect(collected[0]!.id).toBe("tu_zzz");
    expect(collected[1]!.id).toBe("tu_aaa");
    expect(collected[0]!.function.arguments).toBe('{"a":2}');
    expect(collected[1]!.function.arguments).toBe('{"b":1}');
  });
});

// ---------------------------------------------------------------------------
// createStreamingTranslator — usage trailer (stream_options.include_usage)
// ---------------------------------------------------------------------------

describe("createStreamingTranslator — usage trailer (stream_options.include_usage)", () => {
  // U1: legacy no-arg form — one terminal chunk, derived finish_reason.
  it("finalize() with no arg returns 1 chunk with delta:{} (regression guard)", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-usage-1", model: "clawdy" });
    for (const e of textStreamFixture) t.onEvent(e);
    const out = t.finalize();
    expect(out).toHaveLength(1);
    expect(out[0]!.choices[0]!.delta).toEqual({});
    expect(out[0]!.choices[0]!.finish_reason).toBe("stop");
    expect(out[0]!.usage).toBeUndefined();
  });

  // U2: legacy positional string form — backward compat.
  it("finalize('stop') positional arg still works (backward compat with Plan 02 tests)", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-usage-2", model: "clawdy" });
    for (const e of textStreamFixture) t.onEvent(e);
    const out = t.finalize("stop");
    expect(out).toHaveLength(1);
    expect(out[0]!.choices[0]!.finish_reason).toBe("stop");
    expect(out[0]!.usage).toBeUndefined();
  });

  // U3: object form with includeUsage:false — identical to no-flag.
  it("finalize({ includeUsage: false }) returns 1 chunk, no usage trailer", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-usage-3", model: "clawdy" });
    for (const e of textStreamFixture) t.onEvent(e);
    const out = t.finalize({ includeUsage: false });
    expect(out).toHaveLength(1);
    expect(out[0]!.choices[0]!.delta).toEqual({});
    expect(out[0]!.choices[0]!.finish_reason).toBe("stop");
    expect(out[0]!.usage).toBeUndefined();
  });

  // U4: tool-use fixture with includeUsage:true → terminal + usage chunk.
  it("finalize({ includeUsage: true }) on tool-use stream emits terminal + usage chunk", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-usage-4", model: "clawdy" });
    for (const e of toolUseStreamFixture) t.onEvent(e);
    const out = t.finalize({ includeUsage: true });
    expect(out).toHaveLength(2);
    // Terminal chunk: unchanged
    expect(out[0]!.choices[0]!.delta).toEqual({});
    expect(out[0]!.choices[0]!.finish_reason).toBe("tool_calls");
    expect(out[0]!.usage).toBeUndefined();
    // Usage chunk: choices:[] (NOT choices[0]), has usage object.
    expect(out[1]!.choices).toEqual([]);
    expect(out[1]!.usage).toBeDefined();
    // tool-use fixture: input_tokens:20, output_tokens:10, cache_read:0
    expect(out[1]!.usage!.prompt_tokens).toBe(20);
    expect(out[1]!.usage!.completion_tokens).toBe(10);
    expect(out[1]!.usage!.total_tokens).toBe(30);
  });

  // U5: text fixture with includeUsage:true → terminal + usage with text fixture numbers.
  it("finalize({ includeUsage: true }) on text stream emits terminal + usage chunk with text numbers", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-usage-5", model: "clawdy" });
    for (const e of textStreamFixture) t.onEvent(e);
    const out = t.finalize({ includeUsage: true });
    expect(out).toHaveLength(2);
    expect(out[0]!.choices[0]!.finish_reason).toBe("stop");
    // text fixture: input_tokens:12, output_tokens:3, cache_read:0
    expect(out[1]!.choices).toEqual([]);
    expect(out[1]!.usage!.prompt_tokens).toBe(12);
    expect(out[1]!.usage!.completion_tokens).toBe(3);
    expect(out[1]!.usage!.total_tokens).toBe(15);
  });

  // U6: no result event → terminal only, NO usage chunk even when flag true.
  it("finalize({ includeUsage: true }) with no result event emits terminal ONLY (no usage chunk)", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-usage-6", model: "clawdy" });
    // Synthesize: content_block_start(text) + text_delta + content_block_stop.
    // No `result` event — so usage stays undefined.
    const noResult: SdkStreamEvent[] = [
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    ];
    for (const e of noResult) t.onEvent(e);
    expect(t.usage).toBeUndefined();
    const out = t.finalize({ includeUsage: true });
    expect(out).toHaveLength(1);
    expect(out[0]!.choices[0]!.delta).toEqual({});
    expect(out[0]!.choices[0]!.finish_reason).toBe("stop");
  });

  // U7: both params — finishReason override + includeUsage.
  it("finalize({ finishReason: 'length', includeUsage: true }) honors both args", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-usage-7", model: "clawdy" });
    for (const e of textStreamFixture) t.onEvent(e);
    const out = t.finalize({ finishReason: "length", includeUsage: true });
    expect(out).toHaveLength(2);
    expect(out[0]!.choices[0]!.finish_reason).toBe("length");
    expect(out[1]!.choices).toEqual([]);
    expect(out[1]!.usage).toBeDefined();
  });

  // U8: load-bearing same-id/object/model invariant across terminal + usage chunks.
  it("terminal chunk and usage chunk share id, object, model (OpenAI clients group by id)", () => {
    const t = createStreamingTranslator({ id: "chatcmpl-usage-8", model: "clawdy" });
    for (const e of textStreamFixture) t.onEvent(e);
    const out = t.finalize({ includeUsage: true });
    expect(out).toHaveLength(2);
    expect(out[0]!.id).toBe("chatcmpl-usage-8");
    expect(out[1]!.id).toBe("chatcmpl-usage-8");
    expect(out[0]!.object).toBe("chat.completion.chunk");
    expect(out[1]!.object).toBe("chat.completion.chunk");
    expect(out[0]!.model).toBe("clawdy");
    expect(out[1]!.model).toBe("clawdy");
    // `created` is epoch seconds on both (Pitfall 2 — same-turn timing).
    expect(typeof out[0]!.created).toBe("number");
    expect(typeof out[1]!.created).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// makeChunk (primitive)
// ---------------------------------------------------------------------------

describe("makeChunk", () => {
  it("produces a ChatCompletionChunk with object='chat.completion.chunk' and the given delta", () => {
    const c = makeChunk({
      id: "chatcmpl-x",
      model: "clawdy",
      delta: { content: "hi" },
      finishReason: null,
    });
    expect(c.object).toBe("chat.completion.chunk");
    expect(c.id).toBe("chatcmpl-x");
    expect(c.model).toBe("clawdy");
    expect(c.choices[0]!.delta).toEqual({ content: "hi" });
    expect(c.choices[0]!.finish_reason).toBeNull();
  });
});
