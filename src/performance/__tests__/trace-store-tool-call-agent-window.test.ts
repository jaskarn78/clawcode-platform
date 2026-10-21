/**
 * Phase 132-fu T06 — `TraceStore.getToolCallSpansForAgentWindow` reader.
 *
 * Multi-turn variant of `getToolCallSpansForTurn`. Aggregates `tool_call.*`
 * spans across all `traces` rows where `agent = ?` AND `started_at` ∈
 * [since, until]. Used for the subagent-session case where a single binding
 * spans multiple Discord message-reply turns inside a thread.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceStore } from "../trace-store.js";
import type { TurnRecord, SpanRecord } from "../types.js";

function span(name: string, startedAt: string): SpanRecord {
  return Object.freeze({
    name,
    startedAt,
    durationMs: 10,
    metadata: Object.freeze({}),
  });
}

function buildTurn(
  id: string,
  agent: string,
  startedAt: string,
  spans: readonly SpanRecord[],
  totalMs = 1000,
): TurnRecord {
  return Object.freeze({
    id,
    agent,
    channelId: null,
    startedAt,
    endedAt: startedAt,
    totalMs,
    status: "success" as const,
    spans: Object.freeze([...spans]),
  });
}

describe("TraceStore.getToolCallSpansForAgentWindow", () => {
  let store: TraceStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trace-store-agent-window-test-"));
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

  it("returns [] for an agent with no traces", () => {
    const result = store.getToolCallSpansForAgentWindow(
      "agent-x",
      "2026-05-17T12:00:00.000Z",
      "2026-05-17T13:00:00.000Z",
    );
    expect(result).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("aggregates tool calls across multiple turns in window", () => {
    // Three turns of one subagent's work, each with a couple tool calls.
    store.writeTurn(
      buildTurn("discord:111111111111", "sub-1", "2026-05-17T12:00:00.000Z", [
        span("tool_call.Read", "2026-05-17T12:00:00.500Z"),
        span("tool_call.Grep", "2026-05-17T12:00:01.000Z"),
      ]),
    );
    store.writeTurn(
      buildTurn("discord:222222222222", "sub-1", "2026-05-17T12:01:00.000Z", [
        span("tool_call.Edit", "2026-05-17T12:01:00.500Z"),
        span("tool_call.Bash", "2026-05-17T12:01:01.000Z"),
      ]),
    );
    store.writeTurn(
      buildTurn("discord:333333333333", "sub-1", "2026-05-17T12:02:00.000Z", [
        span("tool_call.Write", "2026-05-17T12:02:00.500Z"),
        span("tool_call.Read", "2026-05-17T12:02:01.000Z"),
      ]),
    );

    const result = store.getToolCallSpansForAgentWindow(
      "sub-1",
      "2026-05-17T12:00:00.000Z",
      "2026-05-17T12:03:00.000Z",
    );
    expect(result.map((r) => r.tool)).toEqual([
      "Read",
      "Grep",
      "Edit",
      "Bash",
      "Write",
      "Read",
    ]);
  });

  it("scopes results to the requested agent — does not bleed across agents", () => {
    store.writeTurn(
      buildTurn("discord:aaa1111", "sub-a", "2026-05-17T12:00:00.000Z", [
        span("tool_call.A1", "2026-05-17T12:00:00.500Z"),
      ]),
    );
    store.writeTurn(
      buildTurn("discord:bbb2222", "sub-b", "2026-05-17T12:00:30.000Z", [
        span("tool_call.B1", "2026-05-17T12:00:30.500Z"),
      ]),
    );

    const a = store.getToolCallSpansForAgentWindow(
      "sub-a",
      "2026-05-17T12:00:00.000Z",
      "2026-05-17T13:00:00.000Z",
    );
    const b = store.getToolCallSpansForAgentWindow(
      "sub-b",
      "2026-05-17T12:00:00.000Z",
      "2026-05-17T13:00:00.000Z",
    );
    expect(a.map((r) => r.tool)).toEqual(["A1"]);
    expect(b.map((r) => r.tool)).toEqual(["B1"]);
  });

  it("scopes results to the time window — excludes turns outside [since,until]", () => {
    // 3 turns spanning ~5 minutes; query a 2-minute window in the middle.
    store.writeTurn(
      buildTurn("discord:111", "sub-x", "2026-05-17T12:00:00.000Z", [
        span("tool_call.OutsideEarly", "2026-05-17T12:00:00.500Z"),
      ]),
    );
    store.writeTurn(
      buildTurn("discord:222", "sub-x", "2026-05-17T12:02:00.000Z", [
        span("tool_call.InWindow1", "2026-05-17T12:02:00.500Z"),
        span("tool_call.InWindow2", "2026-05-17T12:02:30.000Z"),
      ]),
    );
    store.writeTurn(
      buildTurn("discord:333", "sub-x", "2026-05-17T12:05:00.000Z", [
        span("tool_call.OutsideLate", "2026-05-17T12:05:00.500Z"),
      ]),
    );

    const result = store.getToolCallSpansForAgentWindow(
      "sub-x",
      "2026-05-17T12:01:00.000Z",
      "2026-05-17T12:04:00.000Z",
    );
    expect(result.map((r) => r.tool)).toEqual(["InWindow1", "InWindow2"]);
  });

  it("excludes non-tool spans interleaved with tool calls", () => {
    store.writeTurn(
      buildTurn("discord:int1", "sub-int", "2026-05-17T12:00:00.000Z", [
        span("receive", "2026-05-17T12:00:00.000Z"),
        span("tool_call.Read", "2026-05-17T12:00:00.500Z"),
        span("first_token", "2026-05-17T12:00:01.000Z"),
        span("tool_call.Write", "2026-05-17T12:00:02.000Z"),
        span("respond", "2026-05-17T12:00:03.000Z"),
      ]),
    );
    const result = store.getToolCallSpansForAgentWindow(
      "sub-int",
      "2026-05-17T12:00:00.000Z",
      "2026-05-17T13:00:00.000Z",
    );
    expect(result.map((r) => r.tool)).toEqual(["Read", "Write"]);
  });

  it("preserves chronological order across multi-turn aggregation", () => {
    // Insert turns OUT-OF-ORDER chronologically — verify ORDER BY normalises.
    store.writeTurn(
      buildTurn("discord:late", "sub-y", "2026-05-17T12:05:00.000Z", [
        span("tool_call.Last", "2026-05-17T12:05:00.500Z"),
      ]),
    );
    store.writeTurn(
      buildTurn("discord:early", "sub-y", "2026-05-17T12:00:00.000Z", [
        span("tool_call.First", "2026-05-17T12:00:00.500Z"),
      ]),
    );
    store.writeTurn(
      buildTurn("discord:mid", "sub-y", "2026-05-17T12:02:00.000Z", [
        span("tool_call.Middle", "2026-05-17T12:02:00.500Z"),
      ]),
    );

    const result = store.getToolCallSpansForAgentWindow(
      "sub-y",
      "2026-05-17T12:00:00.000Z",
      "2026-05-17T13:00:00.000Z",
    );
    expect(result.map((r) => r.tool)).toEqual(["First", "Middle", "Last"]);
  });
});
