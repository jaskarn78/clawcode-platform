/**
 * Phase 137 Plan 02 T-02 — translation primitive unit tests.
 *
 * Covers all 7 exported pure functions in `anthropic-openai.ts`
 * with ≥3 cases each (happy path + edge + error where applicable).
 * Per-PLAN target: ≥20 assertions total; this file lands ~30+.
 *
 * Tests assert the documented asymmetric losses (CONTEXT D2 +
 * researcher_todo #5) IS the only loss — anything else fails:
 *   - cache_control dropped outbound, absent inbound.
 *   - tool_result array→string collapse one-way.
 *   - is_error encoded via IS_ERROR_PREFIX sentinel.
 *   - malformed arguments JSON throws the documented error.
 */

import { describe, it, expect } from "vitest";

import {
  translateMessageFromOpenAI,
  translateMessageToOpenAI,
  translateToolResultFromOpenAI,
  translateToolResultToOpenAI,
  translateToolsToOpenAI,
  translateToolUseFromOpenAI,
  translateToolUseToOpenAI,
} from "../anthropic-openai.js";
import { IS_ERROR_PREFIX, OPENAI_FIELD_NAMES } from "../constants.js";
import type {
  AnthropicMessage,
  AnthropicToolBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  OpenAIAssistantMessage,
  OpenAIToolCall,
  OpenAIToolMessage,
  OpenAIUserMessage,
} from "../types.js";

// -----------------------------------------------------------------
// translateToolsToOpenAI
// -----------------------------------------------------------------

describe("translateToolsToOpenAI", () => {
  it("wraps a simple Anthropic tool in the OpenAI function envelope", () => {
    const tools: AnthropicToolBlock[] = [
      {
        name: "read_file",
        description: "Read a file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ];
    const out = translateToolsToOpenAI(tools);
    expect(out).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ]);
  });

  it("translates an array of tools preserving order", () => {
    const tools: AnthropicToolBlock[] = [
      { name: "a", description: "A", input_schema: { type: "object" } },
      { name: "b", description: "B", input_schema: { type: "object" } },
      { name: "c", description: "C", input_schema: { type: "object" } },
    ];
    const out = translateToolsToOpenAI(tools);
    expect(out.map((t) => t.function.name)).toEqual(["a", "b", "c"]);
  });

  it("drops cache_control on the OpenAI side (documented loss)", () => {
    const tools: AnthropicToolBlock[] = [
      {
        name: "x",
        description: "X",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
    ];
    const out = translateToolsToOpenAI(tools);
    // No equivalent field surfaces in the OpenAI envelope.
    expect(JSON.stringify(out)).not.toContain("cache_control");
    expect(JSON.stringify(out)).not.toContain("ephemeral");
  });

  it("returns an empty array when input is empty", () => {
    expect(translateToolsToOpenAI([])).toEqual([]);
  });
});

// -----------------------------------------------------------------
// translateToolUseToOpenAI
// -----------------------------------------------------------------

describe("translateToolUseToOpenAI", () => {
  it("converts a tool_use block to OpenAI tool_call with JSON-stringified args", () => {
    const block: AnthropicToolUseBlock = {
      type: "tool_use",
      id: "tu_abc123",
      name: "read_file",
      input: { path: "/tmp/foo.txt" },
    };
    const out = translateToolUseToOpenAI(block);
    expect(out).toEqual({
      id: "tu_abc123",
      type: "function",
      function: {
        name: "read_file",
        arguments: '{"path":"/tmp/foo.txt"}',
      },
    });
  });

  it("stringifies nested-object input verbatim (no pretty-print)", () => {
    const block: AnthropicToolUseBlock = {
      type: "tool_use",
      id: "tu_1",
      name: "write_file",
      input: { path: "/a", options: { mode: 644, encoding: "utf-8" } },
    };
    const out = translateToolUseToOpenAI(block);
    expect(out.function.arguments).toBe(JSON.stringify(block.input));
    expect(out.function.arguments).not.toContain("\n");
  });

  it("handles empty-object input cleanly", () => {
    const block: AnthropicToolUseBlock = {
      type: "tool_use",
      id: "tu_empty",
      name: "noop",
      input: {},
    };
    const out = translateToolUseToOpenAI(block);
    expect(out.function.arguments).toBe("{}");
  });
});

// -----------------------------------------------------------------
// translateToolUseFromOpenAI
// -----------------------------------------------------------------

describe("translateToolUseFromOpenAI", () => {
  it("converts an OpenAI tool_call back to an Anthropic tool_use block", () => {
    const call: OpenAIToolCall = {
      id: "tu_abc123",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"/tmp/foo.txt"}' },
    };
    const out = translateToolUseFromOpenAI(call);
    expect(out).toEqual({
      type: "tool_use",
      id: "tu_abc123",
      name: "read_file",
      input: { path: "/tmp/foo.txt" },
    });
  });

  it("throws documented error on malformed arguments JSON", () => {
    const call: OpenAIToolCall = {
      id: "tu_bad",
      type: "function",
      function: { name: "x", arguments: "{not valid json" },
    };
    expect(() => translateToolUseFromOpenAI(call)).toThrow(
      "translateToolUseFromOpenAI: malformed arguments JSON",
    );
  });

  it("throws documented error when arguments JSON is not an object", () => {
    // JSON.parse("[1,2,3]") is valid JSON but not an Anthropic input shape.
    const call: OpenAIToolCall = {
      id: "tu_arr",
      type: "function",
      function: { name: "x", arguments: "[1,2,3]" },
    };
    expect(() => translateToolUseFromOpenAI(call)).toThrow(
      "translateToolUseFromOpenAI: malformed arguments JSON",
    );
  });

  it("parses empty-object arguments back to an empty input", () => {
    const call: OpenAIToolCall = {
      id: "tu_empty",
      type: "function",
      function: { name: "noop", arguments: "{}" },
    };
    const out = translateToolUseFromOpenAI(call);
    expect(out.input).toEqual({});
  });
});

// -----------------------------------------------------------------
// translateToolResultToOpenAI
// -----------------------------------------------------------------

describe("translateToolResultToOpenAI", () => {
  it("converts string-content tool_result to OpenAI tool message", () => {
    const block: AnthropicToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "file contents here",
    };
    const out = translateToolResultToOpenAI(block);
    expect(out).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "file contents here",
    });
  });

  it("collapses array-of-text-blocks to newline-joined string", () => {
    const block: AnthropicToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu_2",
      content: [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ],
    };
    const out = translateToolResultToOpenAI(block);
    expect(out.content).toBe("line 1\nline 2");
  });

  it("encodes is_error=true via IS_ERROR_PREFIX sentinel", () => {
    const block: AnthropicToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu_3",
      content: "boom",
      is_error: true,
    };
    const out = translateToolResultToOpenAI(block);
    expect(out.content).toBe(`${IS_ERROR_PREFIX}boom`);
  });

  it("does NOT add prefix when is_error is false or absent", () => {
    const block: AnthropicToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu_4",
      content: "ok",
      is_error: false,
    };
    expect(translateToolResultToOpenAI(block).content).toBe("ok");
  });
});

// -----------------------------------------------------------------
// translateToolResultFromOpenAI
// -----------------------------------------------------------------

describe("translateToolResultFromOpenAI", () => {
  it("converts OpenAI tool message to Anthropic tool_result block", () => {
    const msg: OpenAIToolMessage = {
      role: "tool",
      tool_call_id: "tu_1",
      content: "result text",
    };
    const out = translateToolResultFromOpenAI(msg);
    expect(out).toEqual({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "result text",
    });
  });

  it("strips IS_ERROR_PREFIX and re-emits is_error: true", () => {
    const msg: OpenAIToolMessage = {
      role: "tool",
      tool_call_id: "tu_2",
      content: `${IS_ERROR_PREFIX}boom`,
    };
    const out = translateToolResultFromOpenAI(msg);
    expect(out).toEqual({
      type: "tool_result",
      tool_use_id: "tu_2",
      content: "boom",
      is_error: true,
    });
  });

  it("does NOT set is_error when prefix is absent", () => {
    const msg: OpenAIToolMessage = {
      role: "tool",
      tool_call_id: "tu_3",
      content: "fine",
    };
    const out = translateToolResultFromOpenAI(msg);
    expect(out.is_error).toBeUndefined();
  });
});

// -----------------------------------------------------------------
// translateMessageToOpenAI
// -----------------------------------------------------------------

describe("translateMessageToOpenAI", () => {
  it("converts assistant message with text + tool_use blocks to a single assistant OpenAI message", () => {
    const msg: AnthropicMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "calling read_file" },
        {
          type: "tool_use",
          id: "tu_a",
          name: "read_file",
          input: { path: "/a" },
        },
      ],
    };
    const out = translateMessageToOpenAI(msg);
    expect(out).toHaveLength(1);
    const asst = out[0] as OpenAIAssistantMessage;
    expect(asst.role).toBe("assistant");
    expect(asst.content).toBe("calling read_file");
    expect(asst.tool_calls).toHaveLength(1);
    expect(asst.tool_calls?.[0]?.function.name).toBe("read_file");
  });

  it("assistant message with only tool_use sets content: null", () => {
    const msg: AnthropicMessage = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu_a", name: "x", input: {} },
      ],
    };
    const out = translateMessageToOpenAI(msg);
    const asst = out[0] as OpenAIAssistantMessage;
    expect(asst.content).toBeNull();
    expect(asst.tool_calls).toHaveLength(1);
  });

  it("user message with text + tool_result fans out to user msg + N tool msgs", () => {
    const msg: AnthropicMessage = {
      role: "user",
      content: [
        { type: "text", text: "here is the file" },
        {
          type: "tool_result",
          tool_use_id: "tu_a",
          content: "the contents",
        },
        {
          type: "tool_result",
          tool_use_id: "tu_b",
          content: "more contents",
        },
      ],
    };
    const out = translateMessageToOpenAI(msg);
    expect(out).toHaveLength(3);
    expect((out[0] as OpenAIUserMessage).role).toBe("user");
    expect((out[1] as OpenAIToolMessage).role).toBe("tool");
    expect((out[2] as OpenAIToolMessage).role).toBe("tool");
  });

  it("user message with only tool_result emits NO preamble user msg", () => {
    const msg: AnthropicMessage = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_a", content: "x" },
      ],
    };
    const out = translateMessageToOpenAI(msg);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("tool");
  });
});

// -----------------------------------------------------------------
// translateMessageFromOpenAI
// -----------------------------------------------------------------

describe("translateMessageFromOpenAI", () => {
  it("folds an assistant OpenAI message back to an Anthropic message", () => {
    const msgs: ReadonlyArray<OpenAIAssistantMessage> = [
      {
        role: "assistant",
        content: "hello",
        tool_calls: [
          {
            id: "tu_a",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"/a"}' },
          },
        ],
      },
    ];
    const out = translateMessageFromOpenAI(msgs);
    expect(out.role).toBe("assistant");
    expect(out.content).toHaveLength(2);
    expect(out.content[0]).toEqual({ type: "text", text: "hello" });
    expect(out.content[1]).toEqual({
      type: "tool_use",
      id: "tu_a",
      name: "read_file",
      input: { path: "/a" },
    });
  });

  it("folds N user+tool messages into a single user Anthropic message", () => {
    const msgs: ReadonlyArray<OpenAIUserMessage | OpenAIToolMessage> = [
      { role: "user", content: "here" },
      { role: "tool", tool_call_id: "tu_a", content: "result-a" },
      { role: "tool", tool_call_id: "tu_b", content: "result-b" },
    ];
    const out = translateMessageFromOpenAI(msgs);
    expect(out.role).toBe("user");
    expect(out.content).toHaveLength(3);
    expect(out.content[0]?.type).toBe("text");
    expect(out.content[1]?.type).toBe("tool_result");
    expect(out.content[2]?.type).toBe("tool_result");
  });

  it("throws on empty input", () => {
    expect(() => translateMessageFromOpenAI([])).toThrow(
      "translateMessageFromOpenAI: empty input",
    );
  });

  it("assistant content: null does NOT produce a text block", () => {
    const msgs: ReadonlyArray<OpenAIAssistantMessage> = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tu_a",
            type: "function",
            function: { name: "x", arguments: "{}" },
          },
        ],
      },
    ];
    const out = translateMessageFromOpenAI(msgs);
    expect(out.content).toHaveLength(1);
    expect(out.content[0]?.type).toBe("tool_use");
  });
});

// -----------------------------------------------------------------
// Sanity: OPENAI_FIELD_NAMES surface is what the translation uses
// -----------------------------------------------------------------

describe("OPENAI_FIELD_NAMES sanity", () => {
  it("exposes all wire-critical names", () => {
    expect(OPENAI_FIELD_NAMES.FUNCTION_TYPE).toBe("function");
    expect(OPENAI_FIELD_NAMES.TOOL_ROLE).toBe("tool");
    expect(OPENAI_FIELD_NAMES.TOOL_CALLS).toBe("tool_calls");
    expect(OPENAI_FIELD_NAMES.TOOL_CALL_ID).toBe("tool_call_id");
  });
});
