/**
 * Phase 115 Plan 03 sub-scope 9 — Phase 1 (no-LLM) tool-output prune tests.
 *
 * Pins the response-path compaction primitive: replace old tool outputs
 * with 1-line `[tool output pruned: <name> @ <ts>]` markers, leave the
 * most-recent N turns alone, never call an LLM, never mutate the input.
 */

import { describe, it, expect } from "vitest";
import {
  pruneToolOutputs,
  pruneSavingsPct,
  type ToolOutputTurn,
} from "../tool-output-prune.js";

function bigBody(prefix: string, kb: number = 2): string {
  // ~kb KB of repeating content so the prune shrinks the turn meaningfully.
  return `<tool_use_result>${prefix}: ${"x".repeat(kb * 1024)}</tool_use_result>`;
}

function turn(
  i: number,
  options: Partial<ToolOutputTurn> = {},
): ToolOutputTurn {
  return Object.freeze({
    role: "assistant" as const,
    content: bigBody(`output-${i}`),
    timestamp: `2026-05-08T10:${String(i).padStart(2, "0")}:00Z`,
    isToolOutput: true,
    toolName: `tool_${i}`,
    ...options,
  });
}

describe("pruneToolOutputs — basic prune behavior", () => {
  it("prunes old outputs, keeps the most-recent N (default 3) verbatim", () => {
    const turns: ToolOutputTurn[] = Array.from({ length: 10 }, (_, i) => turn(i));
    const out = pruneToolOutputs(turns);

    // First 7 should be pruned (10 - 3 = 7), last 3 untouched.
    for (let i = 0; i < 7; i++) {
      expect(out[i]?.content.startsWith("[tool output pruned:")).toBe(true);
    }
    for (let i = 7; i < 10; i++) {
      expect(out[i]).toBe(turns[i]); // same reference — pass-through
      expect(out[i]?.content.length).toBeGreaterThan(1000);
    }
  });

  it("1-line summary format matches `[tool output pruned: <tool_name> @ <timestamp>]`", () => {
    const turns: ToolOutputTurn[] = [
      turn(0, { toolName: "web_search", timestamp: "2026-05-08T09:00:00Z" }),
      turn(1, { toolName: "Read", timestamp: "2026-05-08T09:01:00Z" }),
      turn(2),
      turn(3),
      turn(4),
    ];

    const out = pruneToolOutputs(turns);

    // Index 0 + 1 are outside the keep-recent window; indices 2..4 are
    // inside the protected tail (default keepRecentN=3).
    expect(out[0]?.content).toBe(
      "[tool output pruned: web_search @ 2026-05-08T09:00:00Z]",
    );
    expect(out[1]?.content).toBe(
      "[tool output pruned: Read @ 2026-05-08T09:01:00Z]",
    );
  });

  it("empty turns array → empty result, no error", () => {
    expect(pruneToolOutputs([])).toEqual([]);
  });

  it("respects custom keepRecentN", () => {
    const turns: ToolOutputTurn[] = Array.from({ length: 5 }, (_, i) => turn(i));
    const out = pruneToolOutputs(turns, { keepRecentN: 1 });

    // Only the LAST turn is preserved.
    for (let i = 0; i < 4; i++) {
      expect(out[i]?.content.startsWith("[tool output pruned:")).toBe(true);
    }
    expect(out[4]?.content.length).toBeGreaterThan(1000);
  });
});

describe("pruneToolOutputs — safety properties", () => {
  it("does NOT call any LLM (purely synchronous, no await needed)", () => {
    const turns: ToolOutputTurn[] = Array.from({ length: 6 }, (_, i) => turn(i));
    const before = Date.now();
    const out = pruneToolOutputs(turns);
    const elapsed = Date.now() - before;
    // Sanity: a real LLM call would take >50ms minimum. <50ms = synchronous.
    expect(elapsed).toBeLessThan(50);
    expect(out).toHaveLength(turns.length);
  });

  it("does not mutate the input array", () => {
    const turns: ToolOutputTurn[] = [turn(0), turn(1), turn(2), turn(3), turn(4)];
    const before = turns.map((t) => t.content);
    pruneToolOutputs(turns);
    const after = turns.map((t) => t.content);
    expect(after).toEqual(before);
  });

  it("does not prune turns smaller than minBytesToPrune (default 200)", () => {
    const tiny: ToolOutputTurn = Object.freeze({
      role: "assistant",
      content: "<tool_use_result>tiny</tool_use_result>",
      timestamp: "2026-05-08T10:00:00Z",
      isToolOutput: true,
      toolName: "tiny_tool",
    });
    const turns: ToolOutputTurn[] = [
      tiny,
      tiny,
      tiny,
      tiny,
      tiny,
    ];
    const out = pruneToolOutputs(turns);
    // All five should pass through verbatim (content < 200 bytes).
    for (let i = 0; i < 5; i++) {
      expect(out[i]).toBe(turns[i]);
    }
  });

  it("does not touch non-tool-output turns even when they're large", () => {
    const userTurn: ToolOutputTurn = Object.freeze({
      role: "user",
      content: "long user message ".repeat(500), // big, but not a tool output
      timestamp: "2026-05-08T10:00:00Z",
      isToolOutput: false,
    });
    const turns: ToolOutputTurn[] = [
      userTurn,
      userTurn,
      userTurn,
      userTurn,
      userTurn,
    ];
    const out = pruneToolOutputs(turns);
    for (let i = 0; i < 5; i++) {
      expect(out[i]).toBe(turns[i]); // same reference
      expect(out[i]?.content.length).toBeGreaterThan(1000);
    }
  });

  it("uses '<unknown>' when toolName is absent", () => {
    const turns: ToolOutputTurn[] = [
      Object.freeze({
        role: "assistant" as const,
        content: bigBody("anonymous"),
        timestamp: "2026-05-08T10:00:00Z",
        isToolOutput: true,
        // toolName intentionally omitted
      }),
      turn(1),
      turn(2),
      turn(3),
    ];
    const out = pruneToolOutputs(turns);
    expect(out[0]?.content).toBe(
      "[tool output pruned: <unknown> @ 2026-05-08T10:00:00Z]",
    );
  });

  it("detects tool outputs via XML envelope when isToolOutput flag is absent", () => {
    const turns: ToolOutputTurn[] = [
      Object.freeze({
        role: "assistant" as const,
        content: bigBody("xml-only"),
        timestamp: "2026-05-08T10:00:00Z",
        toolName: "fallback_detection",
      }),
      turn(1),
      turn(2),
      turn(3),
    ];
    const out = pruneToolOutputs(turns);
    expect(out[0]?.content).toBe(
      "[tool output pruned: fallback_detection @ 2026-05-08T10:00:00Z]",
    );
  });
});

describe("pruneSavingsPct", () => {
  it("returns 0 when input had no content", () => {
    expect(pruneSavingsPct([], [])).toBe(0);
  });

  it("computes a meaningful savings percent on a real pass", () => {
    const turns: ToolOutputTurn[] = Array.from({ length: 10 }, (_, i) => turn(i));
    const out = pruneToolOutputs(turns);
    const savedPct = pruneSavingsPct(turns, out);
    // 7 of 10 turns shrink from ~2KB to ~50 chars — should save >>10%.
    expect(savedPct).toBeGreaterThan(50);
  });

  it("returns 0 when no prune happens (preserve-tail covers everything)", () => {
    const turns: ToolOutputTurn[] = [turn(0), turn(1), turn(2)];
    const out = pruneToolOutputs(turns); // keepRecentN=3 ≥ length
    expect(pruneSavingsPct(turns, out)).toBe(0);
  });
});
