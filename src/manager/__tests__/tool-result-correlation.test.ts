/**
 * INC-2026-06-05 — the tool_result→pause correlation fix.
 *
 * The stall tracker's resume() was gated on the message-level
 * `parent_tool_use_id`, which the `inc-260605-resume-probe` proved is `null`
 * for top-level tool results — so resume() never fired, the tracker stayed
 * paused for the whole tool turn, and the 180s no-useful-tokens detector was
 * effectively disabled fleet-wide. The fix correlates on each `tool_result`
 * CONTENT block's `tool_use_id` instead. These shapes are the GROUND TRUTH
 * captured from the live probe (parent_tool_use_id:null + content-block ids),
 * NOT mocked from memory.
 */
import { describe, it, expect } from "vitest";
import { toolResultIdsFromMessage } from "../persistent-session-handle.js";

// Exact shape the probe captured on fin-playground (parent null, id on block).
const userMsg = (toolUseIds: string[], parentToolUseId: string | null = null) => ({
  type: "user",
  parent_tool_use_id: parentToolUseId,
  message: {
    role: "user",
    content: toolUseIds.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content: [{ type: "text", text: "ok" }],
    })),
  },
});

describe("toolResultIdsFromMessage — INC-2026-06-05 correlation", () => {
  it("extracts the single top-level tool_result id (parent_tool_use_id is null — the bug case)", () => {
    expect(toolResultIdsFromMessage(userMsg(["toolu_01DeMeCz"]))).toEqual(["toolu_01DeMeCz"]);
  });

  it("extracts ALL ids from a parallel batch (multiple tool_results in one message)", () => {
    const ids = ["toolu_a", "toolu_b", "toolu_c"];
    expect(toolResultIdsFromMessage(userMsg(ids))).toEqual(ids);
  });

  it("ignores parent_tool_use_id entirely — correlation is the content block id", () => {
    // Even when parent is set (subagent-style), the returned ids come ONLY from
    // the content blocks; the matching against pausedToolUseIds (top-level ids
    // only) is what preserves subagent-immunity at the call site.
    expect(toolResultIdsFromMessage(userMsg(["toolu_x"], "toolu_subagent_parent"))).toEqual([
      "toolu_x",
    ]);
  });

  it("ignores text and tool_use blocks; only tool_result blocks count", () => {
    const msg = {
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", id: "toolu_NOT_A_RESULT", name: "Bash" },
          { type: "tool_result", tool_use_id: "toolu_real", content: "ok" },
        ],
      },
    };
    expect(toolResultIdsFromMessage(msg)).toEqual(["toolu_real"]);
  });

  it("is tolerant of malformed / empty / non-user shapes", () => {
    expect(toolResultIdsFromMessage(undefined)).toEqual([]);
    expect(toolResultIdsFromMessage(null)).toEqual([]);
    expect(toolResultIdsFromMessage({})).toEqual([]);
    expect(toolResultIdsFromMessage({ message: {} })).toEqual([]);
    expect(toolResultIdsFromMessage({ message: { content: [] } })).toEqual([]);
    // tool_result block missing/empty tool_use_id is skipped (never matches a pause)
    expect(
      toolResultIdsFromMessage({
        message: { content: [{ type: "tool_result", tool_use_id: "" }, { type: "tool_result" }] },
      }),
    ).toEqual([]);
  });
});
