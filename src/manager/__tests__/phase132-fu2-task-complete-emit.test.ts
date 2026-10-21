/**
 * Phase 132-fu2 — task-complete emit-site regression.
 *
 * Pins the fu2 fix: the `emitTaskCompletedEvent` call for the cross-agent
 * delegate-task path now lives at the `task-complete` IPC handler
 * (daemon.ts case "task-complete"), NOT the delegate-task DISPATCH site.
 *
 * Pre-fix (132-02 + 132-fu T04 wiring): emit fired at delegate DISPATCH —
 * before the target agent's Turn had started. The trajectory accessor
 * returned `{trajectory:[], durationMs:0}` and the eligibility filter
 * always rejected on `too-few-tool-calls`. The distiller never activated
 * on the cross-agent task path.
 *
 * Post-fix (this plan): emit fires from the MCP `task_complete` IPC
 * handler, which B's own `Turn.end()` precedes. The target's TraceStore
 * now has the per-turn trace row keyed by `task:<nanoid>` (== task_id,
 * verified against TURN_ID_REGEX in src/manager/turn-origin.ts:60).
 *
 * Two-axis assertion:
 *
 *   1. POSITIVE — when the post-fix data shape arrives at
 *      emitTaskCompletedEvent (real 6+ tool-call trajectory keyed by
 *      task_id), the dispatcher fires with outcome=success.
 *
 *   2. NEGATIVE — silent-path-bifurcation invariant: exactly TWO
 *      `emitTaskCompletedEvent(` invocations at line-start in
 *      src/manager/daemon.ts. The dispatch-site emit is GONE.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { TraceStore } from "../../performance/trace-store.js";
import type { TurnRecord, SpanRecord } from "../../performance/types.js";
import { getTrajectoryForTurnId } from "../session-manager-trajectory.js";
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

describe("Phase 132-fu2 — task-complete emit-site regression", () => {
  let tempDir: string;
  let traceStores: Map<string, TraceStore>;
  let targetStore: TraceStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "phase132-fu2-"));
    targetStore = new TraceStore(join(tempDir, "target-trace.db"));
    // The target agent of a delegated task ("Worker Agent") has its own
    // TraceStore. The daemon's `manager.getTrajectoryForTurnId(target, taskId)`
    // resolves to this store.
    traceStores = new Map([["Worker Agent", targetStore]]);
  });

  afterEach(() => {
    try {
      targetStore.close();
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("POSITIVE: real task:<nanoid> turn with 6 tool calls → eligible:true + emit reflects actual outcome", () => {
    // Mirror the daemon site at case "task-complete":
    //   - target agent runs the delegated turn (writes trace keyed by taskId)
    //   - operator calls MCP `task_complete` → IPC `task-complete` →
    //     completeTask() runs, then the emit fires AFTER completion
    //   - accessor `getTrajectoryForTurnId(target, task_id)` returns the
    //     real trajectory (6 tool calls, 185s duration)
    //   - emitTaskCompletedEvent dispatches the distiller
    const taskId = "task:abc1234567"; // shape from src/tasks/task-manager.ts:242
    targetStore.writeTurn(
      Object.freeze({
        id: taskId,
        agent: "Worker Agent",
        channelId: null,
        startedAt: "2026-05-17T12:00:00.000Z",
        endedAt: "2026-05-17T12:03:05.000Z",
        totalMs: 185_000,
        status: "success" as const,
        spans: Object.freeze([
          span("tool_call.Grep", "2026-05-17T12:00:00.500Z"),
          span("tool_call.Read", "2026-05-17T12:00:01.000Z"),
          span("tool_call.Read", "2026-05-17T12:00:30.000Z"),
          span("tool_call.Edit", "2026-05-17T12:01:00.000Z"),
          span("tool_call.Bash", "2026-05-17T12:02:00.000Z"),
          span("tool_call.Write", "2026-05-17T12:02:30.000Z"),
        ]) as readonly SpanRecord[],
      }) as TurnRecord,
    );

    const view = getTrajectoryForTurnId(traceStores, "Worker Agent", taskId);
    expect(view).toBeDefined();
    expect(view!.trajectory).toHaveLength(6);
    expect(view!.durationMs).toBe(185_000);

    const event: TaskCompletedEvent = {
      agent: "Worker Agent",
      sessionId: taskId,
      trajectory: view!.trajectory,
      toolCallCount: view!.trajectory.length,
      durationMs: view!.durationMs,
      outcome: "success",
    };

    // Eligibility gate
    const eligibility = isEligibleForDistillation(event, D3_DEFAULTS);
    expect(eligibility.eligible).toBe(true);

    // Emit-site dispatch
    let dispatched = false;
    let dispatchedEvent: TaskCompletedEvent | null = null;
    const deps: TaskCompletedEventDeps = {
      log: SILENT_LOG,
      getAgentConfig: () => buildEnabledAgentConfig("Worker Agent"),
      dispatchDistiller: (e) => {
        dispatched = true;
        dispatchedEvent = e;
      },
      now: () => 0,
    };
    emitTaskCompletedEvent(deps, event);
    expect(dispatched).toBe(true);
    expect(dispatchedEvent).not.toBeNull();
    expect(dispatchedEvent!.outcome).toBe("success");
    expect(dispatchedEvent!.toolCallCount).toBe(6);
    expect(dispatchedEvent!.durationMs).toBe(185_000);
    expect(dispatchedEvent!.sessionId).toBe(taskId);
  });

  it("PRE-FIX SIMULATION: dispatch-time emit (no trace yet) is REJECTED on too-few-tool-calls", () => {
    // Reproduce what happened at the dispatch site before fu2: the target
    // agent's TraceStore exists but has no trace row yet for this taskId
    // (Turn hasn't started). Accessor returns the empty fallback view.
    const taskId = "task:never-ran01";
    const view = getTrajectoryForTurnId(traceStores, "Worker Agent", taskId);
    // Accessor's contract: returns {trajectory:[], durationMs:0} for an
    // unknown trace (cold-cache path).
    expect(view).toEqual({ trajectory: [], durationMs: 0 });

    const event: TaskCompletedEvent = {
      agent: "Worker Agent",
      sessionId: taskId,
      trajectory: view!.trajectory,
      toolCallCount: 0,
      durationMs: 0,
      outcome: "success",
    };
    const eligibility = isEligibleForDistillation(event, D3_DEFAULTS);
    expect(eligibility.eligible).toBe(false);
    if (!eligibility.eligible) {
      expect(eligibility.reason).toBe("too-few-tool-calls");
    }
  });

  it("INVARIANT (grep): exactly 2 emitTaskCompletedEvent invocations at line-start in daemon.ts", () => {
    // Silent-path-bifurcation invariant: the silent-path-bifurcation pattern
    // MEMORY.md flags. Post-fu2 the two emit sites are subagent-complete
    // (~line 6319) and task-complete (~line 12490). The dispatch-site emit
    // is GONE.
    //
    // This is a structural-grep assertion, not a runtime assertion — it
    // catches regressions where a future plan accidentally adds a third
    // emit site (e.g., copies the pattern into a new IPC handler) or
    // re-introduces the dispatch-site emit.
    //
    // We match line-start (^[[:space:]]*) so the comment text "exactly 2
    // emitTaskCompletedEvent(...) call sites" inside the fu2 comment block
    // does NOT count as an invocation.
    const daemonSrc = readFileSync(
      join(__dirname, "../daemon.ts"),
      "utf-8",
    );
    const callSiteRegex = /^[ \t]*emitTaskCompletedEvent\(/gm;
    const matches = daemonSrc.match(callSiteRegex) ?? [];
    expect(matches).toHaveLength(2);
  });

  it("INVARIANT (grep): no emit invocation remains inside the delegate-task case body", () => {
    // Stronger structural test: the dispatch-site emit must NOT live inside
    // the `case "delegate-task":` block. We scan the slice from
    // `case "delegate-task":` up to (but not including) the next `case "`
    // boundary, and assert zero call-site invocations.
    const daemonSrc = readFileSync(
      join(__dirname, "../daemon.ts"),
      "utf-8",
    );
    const delegateStart = daemonSrc.indexOf('case "delegate-task":');
    expect(delegateStart).toBeGreaterThan(0);
    // Find the next `case "` after delegateStart (the next IPC handler).
    const nextCaseFromDelegate = daemonSrc.indexOf(
      'case "',
      delegateStart + 'case "delegate-task":'.length,
    );
    expect(nextCaseFromDelegate).toBeGreaterThan(delegateStart);
    const delegateBlock = daemonSrc.slice(delegateStart, nextCaseFromDelegate);
    const callSiteRegex = /^[ \t]*emitTaskCompletedEvent\(/gm;
    const matches = delegateBlock.match(callSiteRegex) ?? [];
    expect(matches).toHaveLength(0);
  });

  it("INVARIANT (grep): task-complete case body DOES contain an emit invocation", () => {
    // Positive structural test: the emit now lives in the `case "task-complete":`
    // body. Catches the regression where someone deletes the emit entirely
    // (e.g., during a refactor) without realizing it was the live emit site.
    const daemonSrc = readFileSync(
      join(__dirname, "../daemon.ts"),
      "utf-8",
    );
    const tcStart = daemonSrc.indexOf('case "task-complete":');
    expect(tcStart).toBeGreaterThan(0);
    const nextCaseFromTc = daemonSrc.indexOf(
      'case "',
      tcStart + 'case "task-complete":'.length,
    );
    expect(nextCaseFromTc).toBeGreaterThan(tcStart);
    const tcBlock = daemonSrc.slice(tcStart, nextCaseFromTc);
    const callSiteRegex = /^[ \t]*emitTaskCompletedEvent\(/gm;
    const matches = tcBlock.match(callSiteRegex) ?? [];
    expect(matches).toHaveLength(1);
  });
});
