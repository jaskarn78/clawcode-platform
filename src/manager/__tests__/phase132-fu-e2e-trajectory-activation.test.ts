/**
 * Phase 132-fu T05 — end-to-end activation regression.
 *
 * Pins the full functional path that 132-fu unblocks:
 *
 *   real TraceStore + 6 tool_call.* spans
 *     → SessionManager.getTrajectoryForTurnId (T02)
 *       → TaskCompletedEvent {trajectory, toolCallCount, durationMs}
 *         → emitTaskCompletedEvent (Plan 02 T-01)
 *           → isEligibleForDistillation (Plan 01 T-03)
 *             → `eligible: true`
 *
 * Pre-fix (Plan 02 v1 stub: trajectory=[], toolCallCount=0, durationMs=0)
 * the eligibility filter ALWAYS rejected on `too-few-tool-calls` — the
 * distiller never fired on real turns. This test directly contrasts the
 * pre-fix path (empty stub) against the post-fix path (real accessor) and
 * asserts the regression-protection.
 *
 * Scope: targets the SUBAGENT-COMPLETE path. The delegate-task site fires
 * at dispatch (not completion) so its trajectory is still empty by design —
 * see Plan SUMMARY's "Known Limitations" section (Phase 132-fu2 candidate).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { TraceStore } from "../../performance/trace-store.js";
import type { TurnRecord, SpanRecord } from "../../performance/types.js";
import {
  getTrajectoryForTurnId,
  getTrajectoryForSubagent,
} from "../session-manager-trajectory.js";
import {
  emitTaskCompletedEvent,
  type EmitterAgentConfigView,
  type TaskCompletedEventDeps,
} from "../skill-distiller-task-event.js";
import {
  isEligibleForDistillation,
  type SkillDistillerConfig,
  type TaskCompletedEvent,
} from "../skill-distiller-eligibility.js";

const SILENT_LOG = pino({ level: "silent" });

function span(name: string, startedAt: string): SpanRecord {
  return Object.freeze({
    name,
    startedAt,
    durationMs: 10,
    metadata: Object.freeze({}),
  });
}

function buildEnabledAgentConfig(name: string): EmitterAgentConfigView {
  return {
    name,
    autonomousSkillDrafting: true,
    skillDistiller: {
      // D-03 defaults
      minToolCalls: 6,
      minDurationMs: 180_000,
      outcomeFilter: ["success"],
      distillerModel: "haiku",
    },
  };
}

const D3_DEFAULTS: SkillDistillerConfig = {
  enabled: true,
  minToolCalls: 6,
  minDurationMs: 180_000,
  outcomeFilter: ["success"],
  distillerModel: "haiku",
};

describe("Phase 132-fu e2e — trajectory activation across the full pipeline", () => {
  let tempDir: string;
  let store: TraceStore;
  let traceStores: Map<string, TraceStore>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "phase132-fu-e2e-"));
    store = new TraceStore(join(tempDir, "trace.db"));
    traceStores = new Map([["Admin Clawdy", store]]);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("E2E-1: pre-fix stub (empty trajectory) is REJECTED by eligibility filter", () => {
    // Reproduce the Plan 02 v1 stub emission:
    //   sessionId: "", trajectory: [], toolCallCount: 0, durationMs: 0
    // Confirms what the v1 wiring produced before this plan landed.
    const preFixEvent: TaskCompletedEvent = {
      agent: "Admin Clawdy",
      sessionId: "",
      trajectory: [],
      toolCallCount: 0,
      durationMs: 0,
      outcome: "success",
    };
    const result = isEligibleForDistillation(preFixEvent, D3_DEFAULTS);
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("too-few-tool-calls");
    }
  });

  it("E2E-2: post-fix — 6-tool-call turn → real accessor → eligible:true", () => {
    // 6 tool calls + 185_000ms duration (≥ D-03 thresholds) + outcome=success.
    const turnId = "subagent:thread-abc123";
    store.writeTurn(
      Object.freeze({
        id: turnId,
        agent: "Admin Clawdy",
        channelId: null,
        startedAt: "2026-05-17T12:00:00.000Z",
        endedAt: "2026-05-17T12:03:05.000Z",
        totalMs: 185_000,
        status: "success" as const,
        spans: Object.freeze([
          span("receive", "2026-05-17T12:00:00.000Z"),
          span("tool_call.Grep", "2026-05-17T12:00:00.500Z"),
          span("tool_call.Read", "2026-05-17T12:00:01.000Z"),
          span("tool_call.Read", "2026-05-17T12:00:30.000Z"),
          span("tool_call.Edit", "2026-05-17T12:01:00.000Z"),
          span("tool_call.Bash", "2026-05-17T12:02:00.000Z"),
          span("tool_call.Write", "2026-05-17T12:02:30.000Z"),
        ]) as readonly SpanRecord[],
      }) as TurnRecord,
    );

    // Step 1: SessionManager accessor (T02)
    const view = getTrajectoryForTurnId(traceStores, "Admin Clawdy", turnId);
    expect(view).toBeDefined();
    expect(view!.trajectory).toHaveLength(6);
    expect(view!.durationMs).toBe(185_000);

    // Step 2: assemble the TaskCompletedEvent at the emit site
    const postFixEvent: TaskCompletedEvent = {
      agent: "Admin Clawdy",
      sessionId: turnId,
      trajectory: view!.trajectory,
      toolCallCount: view!.trajectory.length,
      durationMs: view!.durationMs,
      outcome: "success",
    };

    // Step 3: eligibility filter
    const eligibilityResult = isEligibleForDistillation(
      postFixEvent,
      D3_DEFAULTS,
    );
    expect(eligibilityResult.eligible).toBe(true);

    // Step 4: full emitter path — confirm dispatchDistiller fires on eligible
    let dispatched = false;
    let dispatchedEvent: TaskCompletedEvent | null = null;
    const deps: TaskCompletedEventDeps = {
      log: SILENT_LOG,
      getAgentConfig: () => buildEnabledAgentConfig("Admin Clawdy"),
      dispatchDistiller: (e) => {
        dispatched = true;
        dispatchedEvent = e;
      },
      now: () => 0,
    };
    emitTaskCompletedEvent(deps, postFixEvent);
    expect(dispatched).toBe(true);
    expect(dispatchedEvent).not.toBeNull();
    expect(dispatchedEvent!.trajectory.map((t) => t.tool)).toEqual([
      "Grep",
      "Read",
      "Read",
      "Edit",
      "Bash",
      "Write",
    ]);
    expect(dispatchedEvent!.toolCallCount).toBe(6);
    expect(dispatchedEvent!.durationMs).toBe(185_000);
  });

  it("E2E-3: short-turn (5 tool calls) still rejected — eligibility gate intact", () => {
    // Sanity that the gate isn't broken — a turn with only 5 tool calls
    // should still reject. Confirms the threshold semantics are preserved.
    const turnId = "subagent:short-turn";
    store.writeTurn(
      Object.freeze({
        id: turnId,
        agent: "Admin Clawdy",
        channelId: null,
        startedAt: "2026-05-17T12:00:00.000Z",
        endedAt: "2026-05-17T12:03:05.000Z",
        totalMs: 185_000,
        status: "success" as const,
        spans: Object.freeze([
          span("tool_call.A", "2026-05-17T12:00:00.500Z"),
          span("tool_call.B", "2026-05-17T12:00:01.000Z"),
          span("tool_call.C", "2026-05-17T12:00:02.000Z"),
          span("tool_call.D", "2026-05-17T12:00:03.000Z"),
          span("tool_call.E", "2026-05-17T12:00:04.000Z"),
        ]) as readonly SpanRecord[],
      }) as TurnRecord,
    );

    const view = getTrajectoryForTurnId(traceStores, "Admin Clawdy", turnId);
    const event: TaskCompletedEvent = {
      agent: "Admin Clawdy",
      sessionId: turnId,
      trajectory: view!.trajectory,
      toolCallCount: view!.trajectory.length,
      durationMs: view!.durationMs,
      outcome: "success",
    };

    const result = isEligibleForDistillation(event, D3_DEFAULTS);
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("too-few-tool-calls");
      if (result.reason === "too-few-tool-calls") {
        expect(result.actual).toBe(5);
        expect(result.threshold).toBe(6);
      }
    }
  });

  it("E2E-4: short-duration (<3 min) — eligibility rejected on duration", () => {
    // 6+ tool calls but only 2 minutes — should reject on too-short-duration.
    // Confirms the durationMs from `traces.total_ms` flows through correctly.
    const turnId = "subagent:fast-turn";
    store.writeTurn(
      Object.freeze({
        id: turnId,
        agent: "Admin Clawdy",
        channelId: null,
        startedAt: "2026-05-17T12:00:00.000Z",
        endedAt: "2026-05-17T12:02:00.000Z",
        totalMs: 120_000, // 2 min — below D-03 minDurationMs=180_000
        status: "success" as const,
        spans: Object.freeze([
          span("tool_call.A", "2026-05-17T12:00:00.500Z"),
          span("tool_call.B", "2026-05-17T12:00:01.000Z"),
          span("tool_call.C", "2026-05-17T12:00:02.000Z"),
          span("tool_call.D", "2026-05-17T12:00:03.000Z"),
          span("tool_call.E", "2026-05-17T12:00:04.000Z"),
          span("tool_call.F", "2026-05-17T12:00:05.000Z"),
        ]) as readonly SpanRecord[],
      }) as TurnRecord,
    );

    const view = getTrajectoryForTurnId(traceStores, "Admin Clawdy", turnId);
    const event: TaskCompletedEvent = {
      agent: "Admin Clawdy",
      sessionId: turnId,
      trajectory: view!.trajectory,
      toolCallCount: view!.trajectory.length,
      durationMs: view!.durationMs,
      outcome: "success",
    };

    const result = isEligibleForDistillation(event, D3_DEFAULTS);
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("too-short-duration");
      if (result.reason === "too-short-duration") {
        expect(result.actual).toBe(120_000);
        expect(result.threshold).toBe(180_000);
      }
    }
  });

  it("E2E-5: missing trace (unknown turnId) — accessor + emitter handle gracefully", () => {
    // Turn id that has no `traces` row — accessor returns empty fallback,
    // eligibility filter rejects on too-few-tool-calls. Confirms no throw on
    // the cold-cache path.
    const view = getTrajectoryForTurnId(
      traceStores,
      "Admin Clawdy",
      "subagent:never-existed",
    );
    expect(view).toEqual({ trajectory: [], durationMs: 0 });

    const event: TaskCompletedEvent = {
      agent: "Admin Clawdy",
      sessionId: "subagent:never-existed",
      trajectory: view!.trajectory,
      toolCallCount: 0,
      durationMs: 0,
      outcome: "success",
    };

    let dispatched = false;
    const deps: TaskCompletedEventDeps = {
      log: SILENT_LOG,
      getAgentConfig: () => buildEnabledAgentConfig("Admin Clawdy"),
      dispatchDistiller: () => {
        dispatched = true;
      },
      now: () => 0,
    };
    emitTaskCompletedEvent(deps, event);
    expect(dispatched).toBe(false);
  });

  it("E2E-7: multi-turn subagent path — production pathway end-to-end", () => {
    // The CORRECT production wiring for the subagent-complete IPC handler.
    // Single subagent session spans 3 Discord message-reply turns. Each
    // turn is its own `traces.id = discord:<snowflake>`. The accessor
    // aggregates across all of them via `getToolCallSpansForAgentWindow`.
    //
    // Window: binding.createdAt → binding.completedAt (ms-epoch).
    // Mimics what the daemon site at daemon.ts:6296 does after the relay
    // stamps completedAt.
    const sessionName = "Admin Clawdy-sub-abc123";
    const subagentStore = new TraceStore(join(tempDir, "sub-trace.db"));
    traceStores.set(sessionName, subagentStore);

    const createdAtMs = Date.parse("2026-05-17T12:00:00.000Z");
    const completedAtMs = Date.parse("2026-05-17T12:03:30.000Z"); // 3.5 min wall-clock

    subagentStore.writeTurn(
      Object.freeze({
        id: "discord:000000000000000102",
        agent: sessionName,
        channelId: null,
        startedAt: "2026-05-17T12:00:30.000Z",
        endedAt: "2026-05-17T12:01:00.000Z",
        totalMs: 30_000,
        status: "success" as const,
        spans: Object.freeze([
          span("tool_call.Grep", "2026-05-17T12:00:31.000Z"),
          span("tool_call.Read", "2026-05-17T12:00:35.000Z"),
        ]) as readonly SpanRecord[],
      }) as TurnRecord,
    );
    subagentStore.writeTurn(
      Object.freeze({
        id: "discord:000000000000000122",
        agent: sessionName,
        channelId: null,
        startedAt: "2026-05-17T12:01:30.000Z",
        endedAt: "2026-05-17T12:02:00.000Z",
        totalMs: 30_000,
        status: "success" as const,
        spans: Object.freeze([
          span("tool_call.Edit", "2026-05-17T12:01:31.000Z"),
          span("tool_call.Bash", "2026-05-17T12:01:45.000Z"),
        ]) as readonly SpanRecord[],
      }) as TurnRecord,
    );
    subagentStore.writeTurn(
      Object.freeze({
        id: "discord:000000000000000123",
        agent: sessionName,
        channelId: null,
        startedAt: "2026-05-17T12:02:30.000Z",
        endedAt: "2026-05-17T12:03:00.000Z",
        totalMs: 30_000,
        status: "success" as const,
        spans: Object.freeze([
          span("tool_call.Write", "2026-05-17T12:02:31.000Z"),
          span("tool_call.Read", "2026-05-17T12:02:45.000Z"),
        ]) as readonly SpanRecord[],
      }) as TurnRecord,
    );

    const view = getTrajectoryForSubagent(
      traceStores,
      sessionName,
      createdAtMs,
      completedAtMs,
    );
    expect(view).toBeDefined();
    expect(view!.trajectory).toHaveLength(6);
    expect(view!.trajectory.map((t) => t.tool)).toEqual([
      "Grep",
      "Read",
      "Edit",
      "Bash",
      "Write",
      "Read",
    ]);
    // Wall-clock window: 12:03:30 - 12:00:00 = 210_000ms (3.5 min).
    expect(view!.durationMs).toBe(210_000);

    const event: TaskCompletedEvent = {
      agent: sessionName,
      sessionId: "thread-abc",
      trajectory: view!.trajectory,
      toolCallCount: view!.trajectory.length,
      durationMs: view!.durationMs,
      outcome: "success",
    };

    let dispatched = false;
    const deps: TaskCompletedEventDeps = {
      log: SILENT_LOG,
      getAgentConfig: () => buildEnabledAgentConfig(sessionName),
      dispatchDistiller: () => {
        dispatched = true;
      },
      now: () => 0,
    };
    emitTaskCompletedEvent(deps, event);
    expect(dispatched).toBe(true);

    subagentStore.close();
  });

  it("E2E-6: unknown agent — accessor returns undefined; emit-site callers should skip", () => {
    // The two daemon emit sites have `view?.trajectory ?? []` fallback,
    // so an unknown-agent emit still flows through (with empty trajectory
    // and outcome=success → eligibility rejects). This isolates the
    // accessor's contract.
    const view = getTrajectoryForTurnId(
      traceStores,
      "Unknown Agent",
      "subagent:abc",
    );
    expect(view).toBeUndefined();
  });
});
