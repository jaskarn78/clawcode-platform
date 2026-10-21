/**
 * Phase 999.82 — current-turn text accumulation (the progress hook's brain).
 *
 * The turn-boundary logic is the riskiest part of the streaming transport:
 * `tool_result` blocks arrive as `type:"user"` records, so a naive "stop at the
 * first user record" walk fragments the stream (only the latest text block
 * survives). These tests pin the ACCUMULATED-text contract (must-have truth #1)
 * against the live transcript shape verified on-box.
 */

import { describe, it, expect } from "vitest";

import {
  accumulateTurnText,
  accumulateTurnProgress,
  renderToolActivity,
  renderActivity,
  stripToolActivity,
} from "../progress-turn-text.js";

/** Build a JSONL record line for the transcript (string or block-array content). */
function rec(
  type: "user" | "assistant" | "system",
  content: unknown,
): string {
  return JSON.stringify({ type, message: { role: type, content } });
}

const userText = (t: string): string => rec("user", [{ type: "text", text: t }]);
const userString = (t: string): string => rec("user", t);
const asstText = (t: string): string =>
  rec("assistant", [{ type: "text", text: t }]);
const asstToolUse = (name: string): string =>
  rec("assistant", [{ type: "tool_use", id: "tu_1", name, input: {} }]);
const toolResult = (id: string): string =>
  rec("user", [{ type: "tool_result", tool_use_id: id, content: "ok" }]);

describe("accumulateTurnText", () => {
  it("returns the single assistant text block of a trivial turn", () => {
    const t = [userText("hello"), asstText("hi there")].join("\n");
    expect(accumulateTurnText(t)).toBe("hi there");
  });

  it("ACCUMULATES across a multi-tool turn (tool_result user records are NOT the boundary)", () => {
    // The fragmentation regression: user → assistant(text_a) → tool_result →
    // assistant(text_b). A naive "first user record = boundary" walk would
    // return only "text_b"; the correct accumulation is "text_atext_b".
    const t = [
      userText("the real prompt"),
      asstText("text_a"),
      asstToolUse("Read"),
      toolResult("tu_1"),
      asstText("text_b"),
    ].join("\n");
    expect(accumulateTurnText(t)).toBe("text_atext_b");
  });

  it("accumulates across TWO tool calls (still one turn)", () => {
    const t = [
      userText("prompt"),
      asstText("a"),
      asstToolUse("Read"),
      toolResult("tu_1"),
      asstText("b"),
      asstToolUse("Bash"),
      toolResult("tu_2"),
      asstText("c"),
    ].join("\n");
    expect(accumulateTurnText(t)).toBe("abc");
  });

  it("stops at the REAL user prompt — excludes the PREVIOUS turn's text", () => {
    const t = [
      userText("turn 1 prompt"),
      asstText("turn 1 answer"),
      userText("turn 2 prompt"),
      asstText("turn 2 answer"),
    ].join("\n");
    expect(accumulateTurnText(t)).toBe("turn 2 answer");
  });

  it("treats a string-content user record as a real prompt boundary", () => {
    const t = [
      userString("turn 1"),
      asstText("answer 1"),
      userString("turn 2"),
      asstText("answer 2"),
    ].join("\n");
    expect(accumulateTurnText(t)).toBe("answer 2");
  });

  it("returns '' for an empty transcript", () => {
    expect(accumulateTurnText("")).toBe("");
  });

  it("returns '' when the current turn has no assistant text yet (tool-only)", () => {
    const t = [userText("prompt"), asstToolUse("Read"), toolResult("tu_1")].join(
      "\n",
    );
    expect(accumulateTurnText(t)).toBe("");
  });

  it("drops a leading partial line (bounded tail-read slice) without faulting", () => {
    // Simulate the 256KB window slicing mid-record: a garbage leading line.
    const t = [
      '{"type":"assistant","message":{"con',
      userText("prompt"),
      asstText("clean answer"),
    ].join("\n");
    expect(accumulateTurnText(t)).toBe("clean answer");
  });

  it("ignores non-text assistant blocks (thinking, tool_use)", () => {
    const t = [
      userText("prompt"),
      rec("assistant", [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "visible" },
        { type: "tool_use", id: "x", name: "Read", input: {} },
      ]),
    ].join("\n");
    expect(accumulateTurnText(t)).toBe("visible");
  });
});

// Phase 141 (B) — tool-activity streaming.
describe("accumulateTurnProgress (tools)", () => {
  it("collects tool_use names for the current turn in document order", () => {
    const t = [
      userText("prompt"),
      asstText("a"),
      asstToolUse("WebSearch"),
      toolResult("tu_1"),
      asstText("b"),
      asstToolUse("WebFetch"),
      toolResult("tu_2"),
    ].join("\n");
    const p = accumulateTurnProgress(t);
    expect(p.text).toBe("ab");
    expect(p.tools).toEqual(["WebSearch", "WebFetch"]);
  });

  it("captures tools even when the turn has produced NO prose yet (dead-channel case)", () => {
    const t = [userText("prompt"), asstToolUse("WebSearch")].join("\n");
    const p = accumulateTurnProgress(t);
    expect(p.text).toBe("");
    expect(p.tools).toEqual(["WebSearch"]);
  });

  it("does not bleed tools from the previous turn", () => {
    const t = [
      userText("turn 1"),
      asstToolUse("Bash"),
      toolResult("tu_1"),
      asstText("done 1"),
      userText("turn 2"),
      asstToolUse("Read"),
    ].join("\n");
    expect(accumulateTurnProgress(t).tools).toEqual(["Read"]);
  });
});

describe("renderToolActivity", () => {
  it("renders known tools with emoji, joined by ·", () => {
    expect(renderToolActivity(["WebSearch", "WebFetch"])).toBe(
      "🔍 WebSearch · 🌐 WebFetch",
    );
  });

  it("collapses consecutive duplicates to ×N", () => {
    expect(renderToolActivity(["WebSearch", "WebSearch", "WebFetch"])).toBe(
      "🔍 WebSearch ×2 · 🌐 WebFetch",
    );
  });

  it("strips the mcp__server__ prefix and hides ack/ToolSearch machinery", () => {
    expect(
      renderToolActivity([
        "ToolSearch",
        "mcp__clawcode__memory_lookup",
        "mcp__clawcode-channel__clawcode_ack",
      ]),
    ).toBe("🧠 memory_lookup");
  });

  it("returns '' when only hidden tools are present", () => {
    expect(renderToolActivity(["ToolSearch", "clawcode_ack"])).toBe("");
  });

  it("falls back to 🔧 for unknown tools", () => {
    expect(renderToolActivity(["SomeCustomTool"])).toBe("🔧 SomeCustomTool");
  });
});

describe("stripToolActivity (verbose gate)", () => {
  it("strips a leading marker line, keeping the prose", () => {
    expect(stripToolActivity("🔍 WebSearch ×2 · 🌐 WebFetch\n\nHere is the answer.")).toBe(
      "Here is the answer.",
    );
  });

  it("returns '' for a markers-only frame", () => {
    expect(stripToolActivity("🔍 WebSearch")).toBe("");
  });

  it("leaves plain prose (no markers) unchanged", () => {
    expect(stripToolActivity("just the streamed answer")).toBe(
      "just the streamed answer",
    );
  });

  it("does not strip prose that merely contains an emoji mid-text", () => {
    expect(stripToolActivity("the result is 🔍 lens-shaped")).toBe(
      "the result is 🔍 lens-shaped",
    );
  });

  // bug_007 — prose OPENING with a tool emoji must not be mistaken for a marker
  // line (only the full `<emoji> <ToolName>[ ×N]( · …)` grammar is stripped).
  it("does not strip multi-word prose that opens with a tool emoji", () => {
    expect(stripToolActivity("🔍 I searched for X.\n\nHere are the results.")).toBe(
      "🔍 I searched for X.\n\nHere are the results.",
    );
    expect(stripToolActivity("🧠 Recalling from memory now")).toBe(
      "🧠 Recalling from memory now",
    );
    expect(stripToolActivity("🔧 Fix-it suggestion: do X")).toBe(
      "🔧 Fix-it suggestion: do X",
    );
  });
});

describe("renderActivity (Phase 141 — humanized activity levels)", () => {
  it("natural: humanizes the CURRENT (last visible) tool, no ×N / no list", () => {
    expect(renderActivity(["WebSearch", "WebFetch"], "natural")).toBe(
      "🌐 Reading a page…",
    );
    expect(renderActivity(["Bash"], "natural")).toBe("💻 Running a command…");
    expect(renderActivity(["WebSearch", "WebSearch"], "natural")).toBe(
      "🔍 Searching the web…",
    );
  });

  it("natural: ignores hidden machinery tools when picking the current tool", () => {
    expect(renderActivity(["WebSearch", "clawcode_ack"], "natural")).toBe(
      "🔍 Searching the web…",
    );
    // mcp__server__ prefix is stripped before the phrase lookup
    expect(renderActivity(["mcp__search__WebSearch"], "natural")).toBe(
      "🔍 Searching the web…",
    );
  });

  it("natural: empty / all-hidden → ''", () => {
    expect(renderActivity([], "natural")).toBe("");
    expect(renderActivity(["clawcode_ack", "ToolSearch"], "natural")).toBe("");
  });

  it("natural: unknown tool → generic '🔧 Working…'", () => {
    expect(renderActivity(["SomeNewTool"], "natural")).toBe("🔧 Working…");
  });

  it("raw: delegates to renderToolActivity (machinery format)", () => {
    expect(
      renderActivity(["WebSearch", "WebSearch", "WebFetch"], "raw"),
    ).toBe("🔍 WebSearch ×2 · 🌐 WebFetch");
  });

  it("off: always '' regardless of tools", () => {
    expect(renderActivity(["WebSearch", "Bash"], "off")).toBe("");
    expect(renderActivity([], "off")).toBe("");
  });
});
