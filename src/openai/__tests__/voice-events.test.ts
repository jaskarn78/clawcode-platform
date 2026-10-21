import { describe, it, expect } from "vitest";

import {
  createVoiceEventClassifier,
  labelForTool,
  sanitizeToolName,
} from "../voice-events.js";
import type { SdkStreamEvent } from "../types.js";

function textStart(): SdkStreamEvent {
  return {
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
  };
}
function toolStart(name: string, id = "tu_1"): SdkStreamEvent {
  return {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id, name },
    },
  };
}
function textDelta(text: string): SdkStreamEvent {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  };
}

describe("voice-events classifier", () => {
  it("initial frame is status:thinking", () => {
    const c = createVoiceEventClassifier();
    expect(c.initial).toEqual({ event: "status", data: { state: "thinking" } });
  });

  it("first text block → status:generating (once)", () => {
    const c = createVoiceEventClassifier();
    expect(c.onEvent(textStart())).toEqual([
      { event: "status", data: { state: "generating" } },
    ]);
    // A second text block (no intervening tool) → no duplicate status.
    expect(c.onEvent(textStart())).toEqual([]);
  });

  it("tool_use → tool:start (with label) + status:tool", () => {
    const c = createVoiceEventClassifier();
    c.onEvent(textStart());
    expect(c.onEvent(toolStart("WebSearch"))).toEqual([
      {
        event: "tool",
        data: { phase: "start", name: "WebSearch", label: "Searching the web…" },
      },
      { event: "status", data: { state: "tool" } },
    ]);
  });

  it("text resuming after a tool → tool:end + status:generating", () => {
    const c = createVoiceEventClassifier();
    c.onEvent(textStart()); // generating
    c.onEvent(toolStart("Bash")); // tool
    expect(c.onEvent(textStart())).toEqual([
      { event: "tool", data: { phase: "end", name: "Bash", ok: true } },
      { event: "status", data: { state: "generating" } },
    ]);
  });

  it("voice_tool event → tool:start + status:tool (server-side tool surfacing)", () => {
    const c = createVoiceEventClassifier();
    c.onEvent(textStart()); // generating
    expect(
      c.onEvent({ type: "voice_tool", name: "web_search" } as SdkStreamEvent),
    ).toEqual([
      { event: "tool", data: { phase: "start", name: "web_search", label: "Searching the web…" } },
      { event: "status", data: { state: "tool" } },
    ]);
    // Text resuming after the server tool → inferred tool:end.
    expect(c.onEvent(textStart())).toEqual([
      { event: "tool", data: { phase: "end", name: "web_search", ok: true } },
      { event: "status", data: { state: "generating" } },
    ]);
  });

  it("voice_tool sanitizes the mcp namespace too", () => {
    const c = createVoiceEventClassifier();
    const out = c.onEvent({
      type: "voice_tool",
      name: "mcp__acme-db__execute_query",
    } as SdkStreamEvent);
    expect(out[0]).toEqual({
      event: "tool",
      data: { phase: "start", name: "execute_query", label: "Working on it…" },
    });
  });

  it("ignores non-content_block_start events (deltas, assistant, result)", () => {
    const c = createVoiceEventClassifier();
    expect(c.onEvent(textDelta("hi"))).toEqual([]);
    expect(c.onEvent({ type: "result", session_id: "s" } as SdkStreamEvent)).toEqual([]);
  });

  it("unknown tools get a generic label (no machine name leak)", () => {
    expect(labelForTool("some_custom_mcp_tool")).toBe("Working on it…");
    expect(labelForTool("WebSearch")).toBe("Searching the web…");
  });

  it("sanitizeToolName strips the mcp__<server>__ namespace (no internal server leak)", () => {
    expect(sanitizeToolName("mcp__acme-db__execute_query")).toBe("execute_query");
    expect(sanitizeToolName("mcp__smarthome__control_device")).toBe("control_device");
    expect(sanitizeToolName("Bash")).toBe("Bash"); // built-in unchanged
    expect(sanitizeToolName("WebSearch")).toBe("WebSearch");
  });

  it("emitted tool frame uses the sanitized name (mcp namespace not leaked)", () => {
    const c = createVoiceEventClassifier();
    const out = c.onEvent({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "mcp__acme-db__execute_query" },
      },
    });
    expect(out[0]).toEqual({
      event: "tool",
      data: { phase: "start", name: "execute_query", label: "Working on it…" },
    });
  });
});
