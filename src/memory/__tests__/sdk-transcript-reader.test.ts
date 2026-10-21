/**
 * Phase 999.75 Part A (A2/A3) — tests for the tool-aware compaction reader.
 *
 * Covers:
 *   - content-block → ToolOutputTurn conversion (text / tool_use / tool_result)
 *   - tool_use_id → tool-name resolution (incl. out-of-order arrival)
 *   - the isToolOutput flag
 *   - malformed individual blocks are skipped, the rest survive
 *   - fail-open: throw / empty transcript / no usable turns → null
 *   - toolAwareTurnsToText round-trips through turnsFromConcatenatedText
 *     with tool markers intact (tier3/tier4 regexes still match).
 */
import { describe, it, expect, vi } from "vitest";
import type { SessionMessage } from "../../manager/sdk-types.js";
import {
  readToolAwareTurns,
  toolAwareTurnsToText,
  type SdkTranscriptReaderLog,
} from "../sdk-transcript-reader.js";

function makeLog(): SdkTranscriptReaderLog & { warns: unknown[] } {
  const warns: unknown[] = [];
  return {
    warns,
    warn: (obj: unknown) => warns.push(obj),
  };
}

/** Build a SessionMessage with a raw `message` carrying a content block array. */
function msg(
  type: "user" | "assistant" | "system",
  content: unknown,
  uuid = "u-0",
): SessionMessage {
  return {
    type,
    uuid,
    session_id: "sess-1",
    message: { role: type, content },
    parent_tool_use_id: null,
  };
}

function makeDeps(
  messages: readonly SessionMessage[] | (() => Promise<never>),
): Parameters<typeof readToolAwareTurns>[0] & {
  log: SdkTranscriptReaderLog & { warns: unknown[] };
} {
  const log = makeLog();
  const getSessionMessages =
    typeof messages === "function"
      ? vi.fn(messages)
      : vi.fn(async () => messages);
  return {
    sessionId: "sess-1",
    dir: "/tmp/project",
    getSessionMessages,
    agentName: "test-agent",
    log,
  };
}

describe("readToolAwareTurns — block conversion", () => {
  it("converts a text block to a non-tool-output turn", async () => {
    const deps = makeDeps([
      msg("assistant", [{ type: "text", text: "hello operator" }]),
    ]);
    const turns = await readToolAwareTurns(deps);
    expect(turns).not.toBeNull();
    expect(turns).toEqual([
      { role: "assistant", content: "hello operator", timestamp: "", isToolOutput: false },
    ]);
  });

  it("converts a string-form message content to a single text turn", async () => {
    const deps = makeDeps([msg("user", "plain string content")]);
    const turns = await readToolAwareTurns(deps);
    expect(turns).toEqual([
      { role: "user", content: "plain string content", timestamp: "", isToolOutput: false },
    ]);
  });

  it("converts a tool_use block to the tier-parsable marker format", async () => {
    const deps = makeDeps([
      msg("assistant", [
        { type: "tool_use", id: "tu-1", name: "Read", input: { file: "a.ts" } },
      ]),
    ]);
    const turns = await readToolAwareTurns(deps);
    expect(turns).toEqual([
      {
        role: "assistant",
        content: 'tool_use: Read args: {"file":"a.ts"}',
        timestamp: "",
        toolName: "Read",
        isToolOutput: false,
      },
    ]);
  });

  it("converts a tool_result block with ok status and string body", async () => {
    const deps = makeDeps([
      msg("assistant", [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }]),
      msg("user", [
        { type: "tool_result", tool_use_id: "tu-1", content: "exit 0" },
      ]),
    ]);
    const turns = await readToolAwareTurns(deps);
    expect(turns?.[1]).toEqual({
      role: "user",
      content: "tool_result: Bash ok exit 0",
      timestamp: "",
      toolName: "Bash",
      isToolOutput: true,
    });
  });

  it("renders a tool_result with is_error true as 'error' status", async () => {
    const deps = makeDeps([
      msg("assistant", [{ type: "tool_use", id: "tu-9", name: "fetch_url", input: {} }]),
      msg("user", [
        {
          type: "tool_result",
          tool_use_id: "tu-9",
          is_error: true,
          content: "connection refused",
        },
      ]),
    ]);
    const turns = await readToolAwareTurns(deps);
    expect(turns?.[1].content).toBe(
      "tool_result: fetch_url error connection refused",
    );
    expect(turns?.[1].isToolOutput).toBe(true);
  });

  it("flattens an array-form tool_result body of text blocks", async () => {
    const deps = makeDeps([
      msg("assistant", [{ type: "tool_use", id: "tu-2", name: "Grep", input: {} }]),
      msg("user", [
        {
          type: "tool_result",
          tool_use_id: "tu-2",
          content: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        },
      ]),
    ]);
    const turns = await readToolAwareTurns(deps);
    expect(turns?.[1].content).toBe("tool_result: Grep ok line one line two");
  });
});

describe("readToolAwareTurns — tool_use_id → name map", () => {
  it("resolves a tool_result name even when the tool_use arrives later", async () => {
    // tool_result block appears BEFORE its tool_use — the first pass still
    // builds the full id→name map so resolution succeeds.
    const deps = makeDeps([
      msg("user", [
        { type: "tool_result", tool_use_id: "late-1", content: "done" },
      ]),
      msg("assistant", [
        { type: "tool_use", id: "late-1", name: "DelayedTool", input: {} },
      ]),
    ]);
    const turns = await readToolAwareTurns(deps);
    expect(turns?.[0].content).toBe("tool_result: DelayedTool ok done");
    expect(turns?.[0].toolName).toBe("DelayedTool");
  });

  it("falls back to the tool_use_id when no matching tool_use exists", async () => {
    const deps = makeDeps([
      msg("user", [
        { type: "tool_result", tool_use_id: "orphan_99", content: "x" },
      ]),
    ]);
    const turns = await readToolAwareTurns(deps);
    // The id itself is a tier-parsable [A-Za-z0-9_.-]+ token.
    expect(turns?.[0].content).toBe("tool_result: orphan_99 ok x");
  });
});

describe("readToolAwareTurns — isToolOutput flag", () => {
  it("sets isToolOutput true only for tool_result turns", async () => {
    const deps = makeDeps([
      msg("assistant", [
        { type: "text", text: "thinking" },
        { type: "tool_use", id: "t", name: "Read", input: {} },
      ]),
      msg("user", [{ type: "tool_result", tool_use_id: "t", content: "ok" }]),
    ]);
    const turns = await readToolAwareTurns(deps);
    expect(turns?.map((t) => t.isToolOutput)).toEqual([false, false, true]);
  });
});

describe("readToolAwareTurns — malformed-block skip", () => {
  it("skips a malformed block but keeps the valid ones, and logs", async () => {
    const deps = makeDeps([
      msg("assistant", [
        { type: "text", text: "good" },
        { type: "tool_use", id: "x" /* missing name */ },
        { type: "unknown_block_type", data: 1 },
        { type: "tool_use", id: "y", name: "Write", input: { path: "b" } },
      ]),
    ]);
    const turns = await readToolAwareTurns(deps);
    expect(turns).toHaveLength(2);
    expect(turns?.[0].content).toBe("good");
    expect(turns?.[1].content).toBe('tool_use: Write args: {"path":"b"}');
    // skipped-blocks sentinel logged.
    expect(
      deps.log.warns.some(
        (w) =>
          typeof w === "object" &&
          w !== null &&
          (w as { skippedBlocks?: number }).skippedBlocks === 2,
      ),
    ).toBe(true);
  });

  it("skips a message whose content is neither string nor array", async () => {
    const deps = makeDeps([
      msg("assistant", 12345),
      msg("user", [{ type: "text", text: "survivor" }]),
    ]);
    const turns = await readToolAwareTurns(deps);
    expect(turns).toEqual([
      { role: "user", content: "survivor", timestamp: "", isToolOutput: false },
    ]);
  });

  it("skips system messages entirely", async () => {
    const deps = makeDeps([
      msg("system", [{ type: "text", text: "compact boundary" }]),
      msg("assistant", [{ type: "text", text: "real turn" }]),
    ]);
    const turns = await readToolAwareTurns(deps);
    expect(turns).toEqual([
      { role: "assistant", content: "real turn", timestamp: "", isToolOutput: false },
    ]);
  });
});

describe("readToolAwareTurns — fail-open", () => {
  it("returns null when getSessionMessages throws", async () => {
    const deps = makeDeps(async () => {
      throw new Error("disk error");
    });
    const turns = await readToolAwareTurns(deps);
    expect(turns).toBeNull();
    expect(
      deps.log.warns.some(
        (w) =>
          typeof w === "object" &&
          w !== null &&
          (w as { error?: string }).error === "disk error",
      ),
    ).toBe(true);
  });

  it("returns null on an empty transcript (session not found / Codex stub)", async () => {
    const deps = makeDeps([]);
    const turns = await readToolAwareTurns(deps);
    expect(turns).toBeNull();
  });

  it("returns null when no usable turns are produced", async () => {
    // A message that exists but yields zero convertible blocks.
    const deps = makeDeps([msg("assistant", [{ type: "unknown_only" }])]);
    const turns = await readToolAwareTurns(deps);
    expect(turns).toBeNull();
  });
});

describe("toolAwareTurnsToText — round-trip", () => {
  it("renders [role]: content lines", () => {
    const text = toolAwareTurnsToText([
      { role: "user", content: "hi", timestamp: "", isToolOutput: false },
      {
        role: "assistant",
        content: 'tool_use: Read args: {"f":"a"}',
        timestamp: "",
        toolName: "Read",
        isToolOutput: false,
      },
    ]);
    expect(text).toBe('[user]: hi\n[assistant]: tool_use: Read args: {"f":"a"}');
  });

  it("tool markers survive the round-trip through turnsFromConcatenatedText", async () => {
    // Build tool-aware turns, render to text, parse back through the
    // extractor seam — the tool_use/tool_result markers must still match the
    // tier3/tier4 regexes after the round-trip.
    const deps = makeDeps([
      msg("assistant", [
        { type: "tool_use", id: "r1", name: "Read", input: { file: "x.ts" } },
      ]),
      msg("user", [
        { type: "tool_result", tool_use_id: "r1", is_error: true, content: "ENOENT" },
      ]),
      msg("assistant", [
        { type: "tool_use", id: "r2", name: "Read", input: { file: "x.ts" } },
      ]),
      msg("user", [
        { type: "tool_result", tool_use_id: "r2", content: "file body" },
      ]),
    ]);
    const turns = await readToolAwareTurns(deps);
    expect(turns).not.toBeNull();
    const text = toolAwareTurnsToText(turns!);

    // Reuse the extractor seam's own parser via the public tier modules.
    const { truncateLargePayloads } = await import(
      "../../manager/compact-extractors/tier3-payload-truncator.js"
    );
    const { dropNoiseTurns, resetTier4SentinelTracking } = await import(
      "../../manager/compact-extractors/tier4-drop.js"
    );
    resetTier4SentinelTracking();

    // Parse text back into ConversationTurn[] the same way index.ts does.
    const TURN_LINE_RE = /^\[(user|assistant)\]:\s?(.*)$/;
    const parsed: { role: "user" | "assistant"; content: string; timestamp: string }[] = [];
    for (const line of text.split("\n")) {
      const m = TURN_LINE_RE.exec(line);
      if (m) {
        parsed.push({ role: m[1] as "user" | "assistant", content: m[2], timestamp: "" });
      }
    }
    expect(parsed).toHaveLength(4);

    // tier4 drop should remove the failed-then-retried tool_result pair
    // (failed read result followed by an ok read result within 4 turns).
    const log = { info: () => {}, warn: () => {} };
    const dropped = dropNoiseTurns(parsed, {
      preserveLastTurns: 0,
      preserveVerbatimPatterns: [],
      clock: () => new Date(0),
      log: log as never,
      agentName: "roundtrip-agent",
    });
    expect(
      dropped.some((t) => /tool_result: Read error/.test(t.content)),
    ).toBe(false);
    expect(
      dropped.some((t) => /tool_result: Read ok/.test(t.content)),
    ).toBe(true);

    // tier3 still sees the tool_use markers (small payload — untouched).
    const truncated = truncateLargePayloads(dropped);
    expect(truncated.some((t) => /^tool_use: Read/.test(t.content))).toBe(true);
  });
});
