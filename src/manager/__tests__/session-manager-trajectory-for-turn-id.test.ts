/**
 * Phase 132-fu T02 — SessionManager.getTrajectoryForTurnId integration tests.
 *
 * Exercises the thin wrapper that reads the per-agent TraceStore and returns
 * a normalized `{trajectory, durationMs}` shape ready to splice into the
 * `TaskCompletedEvent` payload at the two daemon emit sites.
 *
 * Uses a minimal SessionManager-shaped fixture (not the full constructor) —
 * the heavy startup machinery is not relevant here. The accessor's only
 * inputs are the per-agent TraceStore map and the turn id.
 *
 * Coverage:
 *   - TJ-01 returns undefined when the agent has no TraceStore (unknown agent)
 *   - TJ-02 returns {trajectory:[], durationMs:0} when the trace row is missing
 *   - TJ-03 returns the full trajectory + duration for a 6-tool-call turn
 *   - TJ-04 preserves tool-call invocation order
 *   - TJ-05 returns durationMs from traces.total_ms verbatim (not recomputed)
 *   - TJ-06 scopes results to (agent, turnId) — bleed-protection across agents
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceStore } from "../../performance/trace-store.js";
import type { TurnRecord, SpanRecord } from "../../performance/types.js";
import {
  getTrajectoryForTurnId,
  getTrajectoryForSubagent,
} from "../session-manager-trajectory.js";

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
  totalMs: number,
  agent = "agent-x",
): TurnRecord {
  return Object.freeze({
    id,
    agent,
    channelId: null,
    startedAt: "2026-05-17T12:00:00.000Z",
    endedAt: "2026-05-17T12:03:00.000Z",
    totalMs,
    status: "success" as const,
    spans: Object.freeze([...spans]),
  });
}

describe("SessionManager.getTrajectoryForTurnId", () => {
  let tempDir: string;
  let storeA: TraceStore;
  let storeB: TraceStore;
  let stores: Map<string, TraceStore>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "session-mgr-trajectory-test-"));
    storeA = new TraceStore(join(tempDir, "trace-a.db"));
    storeB = new TraceStore(join(tempDir, "trace-b.db"));
    stores = new Map<string, TraceStore>([
      ["agent-a", storeA],
      ["agent-b", storeB],
    ]);
  });

  afterEach(() => {
    try {
      storeA.close();
    } catch {
      // ignore
    }
    try {
      storeB.close();
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("TJ-01: returns undefined when the agent has no TraceStore", () => {
    const result = getTrajectoryForTurnId(stores, "agent-missing", "turn-1");
    expect(result).toBeUndefined();
  });

  it("TJ-02: returns {trajectory:[], durationMs:0} when trace row missing", () => {
    const result = getTrajectoryForTurnId(stores, "agent-a", "missing-turn");
    expect(result).toEqual({ trajectory: [], durationMs: 0 });
  });

  it("TJ-03: returns full trajectory + duration for a 6-tool-call turn", () => {
    storeA.writeTurn(
      buildTurn(
        "turn-six",
        [
          span("receive", "2026-05-17T12:00:00.000Z"),
          span("tool_call.Read", "2026-05-17T12:00:00.500Z"),
          span("tool_call.Grep", "2026-05-17T12:00:01.000Z"),
          span("tool_call.Edit", "2026-05-17T12:00:30.000Z"),
          span("tool_call.Bash", "2026-05-17T12:01:00.000Z"),
          span("tool_call.Write", "2026-05-17T12:02:00.000Z"),
          span("tool_call.Read", "2026-05-17T12:02:30.000Z"),
        ],
        185_000,
        "agent-a",
      ),
    );

    const result = getTrajectoryForTurnId(stores, "agent-a", "turn-six");
    expect(result).toBeDefined();
    expect(result!.trajectory).toHaveLength(6);
    expect(result!.durationMs).toBe(185_000);
  });

  it("TJ-04: preserves tool-call invocation order", () => {
    storeA.writeTurn(
      buildTurn(
        "turn-order",
        [
          span("tool_call.A", "2026-05-17T12:00:00.500Z"),
          span("tool_call.B", "2026-05-17T12:00:01.000Z"),
          span("tool_call.C", "2026-05-17T12:00:02.000Z"),
        ],
        1000,
        "agent-a",
      ),
    );

    const result = getTrajectoryForTurnId(stores, "agent-a", "turn-order");
    expect(result!.trajectory.map((t) => t.tool)).toEqual(["A", "B", "C"]);
  });

  it("TJ-05: returns durationMs from traces.total_ms verbatim", () => {
    // traces.total_ms is the source-of-truth (writer in trace-collector.ts).
    // Confirm we do NOT recompute from started_at/ended_at — totalMs as
    // stored is what the eligibility filter sees.
    storeA.writeTurn(
      buildTurn(
        "turn-duration",
        [span("tool_call.Read", "2026-05-17T12:00:00.500Z")],
        273_456, // arbitrary literal — verifies pass-through
        "agent-a",
      ),
    );

    const result = getTrajectoryForTurnId(stores, "agent-a", "turn-duration");
    expect(result!.durationMs).toBe(273_456);
  });

  it("TJ-06: scopes results to (agent, turnId) — no bleed across agents", () => {
    storeA.writeTurn(
      buildTurn(
        "shared-id",
        [
          span("tool_call.Read", "2026-05-17T12:00:00.500Z"),
          span("tool_call.Grep", "2026-05-17T12:00:01.000Z"),
        ],
        5_000,
        "agent-a",
      ),
    );
    storeB.writeTurn(
      buildTurn(
        "shared-id",
        [span("tool_call.Bash", "2026-05-17T12:00:00.500Z")],
        9_000,
        "agent-b",
      ),
    );

    const a = getTrajectoryForTurnId(stores, "agent-a", "shared-id");
    const b = getTrajectoryForTurnId(stores, "agent-b", "shared-id");
    expect(a!.trajectory.map((t) => t.tool)).toEqual(["Read", "Grep"]);
    expect(a!.durationMs).toBe(5_000);
    expect(b!.trajectory.map((t) => t.tool)).toEqual(["Bash"]);
    expect(b!.durationMs).toBe(9_000);
  });

  it("TJ-06b: getTrajectoryForSubagent — undefined for unknown agent", () => {
    const result = getTrajectoryForSubagent(
      stores,
      "agent-missing",
      Date.parse("2026-05-17T12:00:00.000Z"),
      Date.parse("2026-05-17T12:05:00.000Z"),
    );
    expect(result).toBeUndefined();
  });

  it("TJ-06c: getTrajectoryForSubagent — aggregates across multiple turns in window", () => {
    // Three Discord-keyed turns for one subagent session.
    const ms = (iso: string) => Date.parse(iso);
    storeA.writeTurn({
      id: "discord:111",
      agent: "agent-a",
      channelId: null,
      startedAt: "2026-05-17T12:00:00.000Z",
      endedAt: "2026-05-17T12:00:30.000Z",
      totalMs: 30_000,
      status: "success" as const,
      spans: Object.freeze([
        span("tool_call.Read", "2026-05-17T12:00:00.500Z"),
        span("tool_call.Grep", "2026-05-17T12:00:01.000Z"),
      ]),
    });
    storeA.writeTurn({
      id: "discord:222",
      agent: "agent-a",
      channelId: null,
      startedAt: "2026-05-17T12:01:00.000Z",
      endedAt: "2026-05-17T12:01:30.000Z",
      totalMs: 30_000,
      status: "success" as const,
      spans: Object.freeze([
        span("tool_call.Edit", "2026-05-17T12:01:00.500Z"),
        span("tool_call.Bash", "2026-05-17T12:01:01.000Z"),
      ]),
    });
    storeA.writeTurn({
      id: "discord:333",
      agent: "agent-a",
      channelId: null,
      startedAt: "2026-05-17T12:02:00.000Z",
      endedAt: "2026-05-17T12:02:30.000Z",
      totalMs: 30_000,
      status: "success" as const,
      spans: Object.freeze([
        span("tool_call.Write", "2026-05-17T12:02:00.500Z"),
        span("tool_call.Read", "2026-05-17T12:02:01.000Z"),
      ]),
    });

    const result = getTrajectoryForSubagent(
      stores,
      "agent-a",
      ms("2026-05-17T11:59:00.000Z"),
      ms("2026-05-17T12:05:00.000Z"),
    );
    expect(result).toBeDefined();
    expect(result!.trajectory.map((t) => t.tool)).toEqual([
      "Read",
      "Grep",
      "Edit",
      "Bash",
      "Write",
      "Read",
    ]);
    // durationMs = completedAt - createdAt (wall-clock window from binding,
    // NOT sum of trace total_ms).
    expect(result!.durationMs).toBe(6 * 60 * 1000); // 6 minutes
  });

  it("TJ-06d: getTrajectoryForSubagent — empty trajectory when window has no traces", () => {
    const ms = (iso: string) => Date.parse(iso);
    const result = getTrajectoryForSubagent(
      stores,
      "agent-a",
      ms("2026-05-17T20:00:00.000Z"),
      ms("2026-05-17T20:05:00.000Z"),
    );
    // Agent has a TraceStore (defined in beforeEach) but no traces in the
    // window — returns {trajectory:[], durationMs:5min}.
    expect(result).toEqual({ trajectory: [], durationMs: 5 * 60 * 1000 });
  });

  it("TJ-07: turn with zero tool calls returns empty trajectory + real duration", () => {
    // A long agent turn (3 min wall-clock) but zero tool calls — eligibility
    // filter rejects on too-few-tool-calls. Confirms duration is still
    // surfaced so log telemetry sees the real wall-clock at the rejection
    // branch.
    storeA.writeTurn(
      buildTurn(
        "turn-no-tools",
        [
          span("receive", "2026-05-17T12:00:00.000Z"),
          span("respond", "2026-05-17T12:03:00.000Z"),
        ],
        180_500,
        "agent-a",
      ),
    );

    const result = getTrajectoryForTurnId(stores, "agent-a", "turn-no-tools");
    expect(result!.trajectory).toEqual([]);
    expect(result!.durationMs).toBe(180_500);
  });
});
