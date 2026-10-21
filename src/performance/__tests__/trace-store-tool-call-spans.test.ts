/**
 * Phase 132-fu T01 — `TraceStore.getToolCallSpansForTurn(turnId)` reader.
 *
 * Returns the tool-call trajectory for a single turn (`traces.id`):
 *   - reads `trace_spans` rows where `name LIKE 'tool_call.%'`
 *   - strips the `tool_call.` prefix (11 chars) via SUBSTR(s.name, 11)
 *   - preserves invocation order via ORDER BY started_at, rowid
 *   - returns `[]` (frozen) when the trace row is missing or has no tool spans
 *
 * Phase 132-fu replaces the empty-trajectory stub at the two daemon emit sites
 * (subagent-complete + delegate-task). The trace_spans store is the only
 * production-side source-of-truth for per-turn tool-call names; ConversationStore
 * content is plain text with no tool markers (verified before Plan rewrite).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceStore } from "../trace-store.js";
import type { TurnRecord, SpanRecord } from "../types.js";

function span(name: string, startedAt: string, durationMs = 10): SpanRecord {
  return Object.freeze({
    name,
    startedAt,
    durationMs,
    metadata: Object.freeze({}),
  });
}

function buildTurn(
  id: string,
  spans: readonly SpanRecord[],
  agent = "agent-x",
): TurnRecord {
  return Object.freeze({
    id,
    agent,
    channelId: null,
    startedAt: "2026-05-17T12:00:00.000Z",
    endedAt: "2026-05-17T12:03:00.000Z",
    totalMs: 180000,
    status: "success" as const,
    spans: Object.freeze([...spans]),
  });
}

describe("TraceStore.getToolCallSpansForTurn", () => {
  let store: TraceStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trace-store-tool-spans-test-"));
    store = new TraceStore(join(tempDir, "traces.db"));
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns [] for a turn id that has no trace row", () => {
    const result = store.getToolCallSpansForTurn("missing-id");
    expect(result).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("returns [] for a turn with only non-tool spans", () => {
    store.writeTurn(
      buildTurn("turn-no-tools", [
        span("receive", "2026-05-17T12:00:00.000Z"),
        span("context_assemble", "2026-05-17T12:00:00.100Z"),
        span("first_token", "2026-05-17T12:00:00.200Z"),
      ]),
    );
    const result = store.getToolCallSpansForTurn("turn-no-tools");
    expect(result).toEqual([]);
  });

  it("extracts tool name after the `tool_call.` prefix", () => {
    store.writeTurn(
      buildTurn("turn-one-tool", [
        span("receive", "2026-05-17T12:00:00.000Z"),
        span("tool_call.Read", "2026-05-17T12:00:00.500Z", 20),
      ]),
    );
    const result = store.getToolCallSpansForTurn("turn-one-tool");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ tool: "Read" });
    expect(typeof result[0]!.ts).toBe("number");
  });

  it("preserves invocation order across multiple tool calls", () => {
    store.writeTurn(
      buildTurn("turn-multi", [
        span("receive", "2026-05-17T12:00:00.000Z"),
        span("tool_call.Read", "2026-05-17T12:00:00.500Z"),
        span("tool_call.Grep", "2026-05-17T12:00:01.000Z"),
        span("tool_call.Edit", "2026-05-17T12:00:02.000Z"),
        span("tool_call.Bash", "2026-05-17T12:00:03.000Z"),
        span("tool_call.Write", "2026-05-17T12:00:04.000Z"),
        span("tool_call.Read", "2026-05-17T12:00:05.000Z"),
      ]),
    );
    const result = store.getToolCallSpansForTurn("turn-multi");
    expect(result.map((s) => s.tool)).toEqual([
      "Read",
      "Grep",
      "Edit",
      "Bash",
      "Write",
      "Read",
    ]);
  });

  it("ignores non-tool_call spans interleaved with tool calls", () => {
    store.writeTurn(
      buildTurn("turn-interleaved", [
        span("receive", "2026-05-17T12:00:00.000Z"),
        span("tool_call.Read", "2026-05-17T12:00:00.500Z"),
        span("first_token", "2026-05-17T12:00:01.000Z"),
        span("tool_call.Write", "2026-05-17T12:00:02.000Z"),
        span("respond", "2026-05-17T12:00:03.000Z"),
      ]),
    );
    const result = store.getToolCallSpansForTurn("turn-interleaved");
    expect(result.map((s) => s.tool)).toEqual(["Read", "Write"]);
  });

  it("handles MCP-style dotted tool names without truncation past first dot", () => {
    // The SUBSTR(s.name, 11) strips ONLY the leading `tool_call.` prefix.
    // MCP tools (e.g. `mcp__discord__send`) keep their full name. Tool names
    // that happen to contain dots downstream (rare) also pass through whole.
    store.writeTurn(
      buildTurn("turn-mcp", [
        span("tool_call.mcp__discord__send", "2026-05-17T12:00:00.500Z"),
        span("tool_call.mcp__memory__recall", "2026-05-17T12:00:01.000Z"),
      ]),
    );
    const result = store.getToolCallSpansForTurn("turn-mcp");
    expect(result.map((s) => s.tool)).toEqual([
      "mcp__discord__send",
      "mcp__memory__recall",
    ]);
  });

  it("scopes results to the requested turn — does not bleed across turns", () => {
    store.writeTurn(
      buildTurn("turn-a", [
        span("tool_call.Read", "2026-05-17T12:00:00.500Z"),
        span("tool_call.Grep", "2026-05-17T12:00:01.000Z"),
      ]),
    );
    store.writeTurn(
      buildTurn("turn-b", [
        span("tool_call.Bash", "2026-05-17T12:00:02.000Z"),
      ]),
    );
    expect(store.getToolCallSpansForTurn("turn-a").map((s) => s.tool)).toEqual([
      "Read",
      "Grep",
    ]);
    expect(store.getToolCallSpansForTurn("turn-b").map((s) => s.tool)).toEqual([
      "Bash",
    ]);
  });

  it("returned array and elements are frozen (immutability convention)", () => {
    store.writeTurn(
      buildTurn("turn-frozen", [
        span("tool_call.Read", "2026-05-17T12:00:00.500Z"),
      ]),
    );
    const result = store.getToolCallSpansForTurn("turn-frozen");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
  });
});
