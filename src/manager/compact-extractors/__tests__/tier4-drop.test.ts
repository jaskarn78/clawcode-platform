import { describe, it, expect, beforeEach } from "vitest";
import pino from "pino";
import type { ConversationTurn } from "../../../memory/compaction.js";
import {
  dropNoiseTurns,
  resetTier4SentinelTracking,
} from "../tier4-drop.js";
import type { ExtractorDeps } from "../types.js";

function makeDeps(overrides: Partial<ExtractorDeps> = {}): ExtractorDeps {
  const sink: { entries: unknown[] } = { entries: [] };
  const log = pino(
    { level: "info" },
    { write: (s) => sink.entries.push(JSON.parse(s)) },
  ) as unknown as ExtractorDeps["log"];
  return Object.freeze({
    preserveLastTurns: 10,
    preserveVerbatimPatterns: [],
    clock: () => new Date(0),
    log,
    agentName: overrides.agentName ?? "agent-test",
    ...overrides,
  }) as ExtractorDeps;
}

function turn(
  role: "user" | "assistant",
  content: string,
  ts = "2026-05-14T00:00:00Z",
): ConversationTurn {
  return Object.freeze({ role, content, timestamp: ts });
}

describe("dropNoiseTurns (Tier 4)", () => {
  beforeEach(() => resetTier4SentinelTracking());

  it("drops heartbeat probe sentinel turns", () => {
    const deps = makeDeps();
    const input = [
      turn("user", "[125-01-active-state] header: client=Client A"),
      turn("assistant", "Got it"),
      turn("user", "real operator message"),
      turn("assistant", "--- ACTIVE STATE ---\nfield: value"),
    ];
    const out = dropNoiseTurns(input, deps);
    expect(out.map((t) => t.content)).toEqual([
      "Got it",
      "real operator message",
    ]);
  });

  it("does NOT drop operator messages that merely mention 'heartbeat probe'", () => {
    const deps = makeDeps();
    const input = [
      turn("user", "the heartbeat probe broke yesterday, please debug"),
    ];
    const out = dropNoiseTurns(input, deps);
    expect(out.length).toBe(1);
    expect(out[0].content).toContain("the heartbeat probe broke");
  });

  it("collapses repeated identical tool calls and appends marker", () => {
    const deps = makeDeps();
    const input = [
      turn("assistant", "tool_use: read_file args: {\"p\":\"a.ts\"}"),
      turn("assistant", "tool_use: read_file args: {\"p\":\"a.ts\"}"),
      turn("assistant", "tool_use: read_file args: {\"p\":\"a.ts\"}"),
      turn("user", "unrelated"),
    ];
    const out = dropNoiseTurns(input, deps);
    const collapsedMarker = out.find((t) => t.content.includes("[tier4] tool read_file collapsed"));
    expect(collapsedMarker).toBeDefined();
    expect(collapsedMarker?.content).toContain("collapsed across 3 calls");
    const readCalls = out.filter((t) => t.content.startsWith("tool_use: read_file"));
    expect(readCalls.length).toBe(1);
  });

  it("drops failed tool result when same tool succeeds within 3 turns", () => {
    const deps = makeDeps();
    const input = [
      turn("assistant", "tool_result: fetch_url failed"),
      turn("assistant", "tool_use: fetch_url args: retry"),
      turn("assistant", "tool_result: fetch_url ok"),
    ];
    const out = dropNoiseTurns(input, deps);
    expect(out.find((t) => /tool_result: fetch_url fail/.test(t.content))).toBeUndefined();
    expect(out.find((t) => /tool_result: fetch_url ok/.test(t.content))).toBeDefined();
  });

  it("keeps unique non-noise turns unchanged", () => {
    const deps = makeDeps();
    const input = [
      turn("user", "implement feature X"),
      turn("assistant", "ok, doing X"),
      turn("user", "looks good"),
    ];
    const out = dropNoiseTurns(input, deps);
    expect(out).toHaveLength(3);
  });

  it("logs [125-02-tier4-drop] sentinel once per agent across invocations", () => {
    const logged: unknown[] = [];
    const log = pino(
      { level: "info" },
      { write: (s) => logged.push(JSON.parse(s)) },
    ) as unknown as ExtractorDeps["log"];
    const deps: ExtractorDeps = Object.freeze({
      preserveLastTurns: 10,
      preserveVerbatimPatterns: [],
      clock: () => new Date(0),
      log,
      agentName: "agent-sentinel-test",
    });
    dropNoiseTurns([], deps);
    dropNoiseTurns([], deps);
    const sentinelHits = logged.filter(
      (e) => typeof e === "object" && e !== null && (e as { sentinel?: string }).sentinel === "125-02-tier4-drop",
    );
    expect(sentinelHits.length).toBe(1);
  });

  it("handles empty input without throwing", () => {
    const deps = makeDeps();
    expect(() => dropNoiseTurns([], deps)).not.toThrow();
  });
});
