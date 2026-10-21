/**
 * Phase 132 Plan 02 T-01 — emitTaskCompletedEvent single-pathway tests.
 *
 * Verifies the single source-of-truth event emitter:
 *   - TE-01: eligible event → dispatchDistiller called once + phase132-task-completed log.
 *   - TE-02: ineligible event (too few tool calls) → no dispatch + reason field.
 *   - TE-03: autonomousSkillDrafting disabled → no dispatch + reason "disabled".
 *   - TE-04: dispatchDistiller throws → emitter swallows + logs at error level (D-01 out-of-band).
 *   - TE-05: telemetry log key is EXACTLY phase132-task-completed (D-09 grep-checkable).
 *   - TE-06: log payload carries agent, sessionId, toolCallCount, durationMs, outcome, eligible, optional reason.
 */
import { describe, it, expect, vi } from "vitest";
import { emitTaskCompletedEvent } from "../skill-distiller-task-event.js";
import type { TaskCompletedEvent } from "../skill-distiller-eligibility.js";

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function eligibleEvent(): TaskCompletedEvent {
  return {
    agent: "Admin Clawdy",
    sessionId: "sess-1",
    trajectory: Array.from({ length: 8 }, (_, i) => ({ tool: "bash", ts: i })),
    durationMs: 240_000,
    toolCallCount: 8,
    outcome: "success",
  };
}

function ineligibleEvent(): TaskCompletedEvent {
  return {
    agent: "Admin Clawdy",
    sessionId: "sess-2",
    trajectory: Array.from({ length: 3 }, (_, i) => ({ tool: "bash", ts: i })),
    durationMs: 240_000,
    toolCallCount: 3,
    outcome: "success",
  };
}

function makeAgentConfig(opts: { enabled: boolean }) {
  return {
    name: "Admin Clawdy",
    autonomousSkillDrafting: opts.enabled,
    skillDistiller: {
      minToolCalls: 6,
      minDurationMs: 180_000,
      outcomeFilter: ["success" as const],
    },
  } as unknown as Parameters<
    Parameters<typeof emitTaskCompletedEvent>[0]["getAgentConfig"]
  > extends [string]
    ? ReturnType<Parameters<typeof emitTaskCompletedEvent>[0]["getAgentConfig"]>
    : never;
}

describe("emitTaskCompletedEvent — single-pathway emitter (T-01)", () => {
  it("TE-01: eligible event invokes dispatchDistiller once and logs phase132-task-completed", () => {
    const log = makeLog();
    const dispatch = vi.fn();
    const event = eligibleEvent();
    emitTaskCompletedEvent(
      {
        log: log as unknown as import("pino").Logger,
        getAgentConfig: () => makeAgentConfig({ enabled: true }),
        dispatchDistiller: dispatch,
        now: () => 0,
      },
      event,
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(event);
    expect(log.info).toHaveBeenCalledTimes(1);
    const [payload, msg] = log.info.mock.calls[0];
    expect(msg).toBe("phase132-task-completed");
    expect(payload.eligible).toBe(true);
  });

  it("TE-02: ineligible event (too few tool calls) skips dispatch and logs reason", () => {
    const log = makeLog();
    const dispatch = vi.fn();
    emitTaskCompletedEvent(
      {
        log: log as unknown as import("pino").Logger,
        getAgentConfig: () => makeAgentConfig({ enabled: true }),
        dispatchDistiller: dispatch,
        now: () => 0,
      },
      ineligibleEvent(),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    const [payload] = log.info.mock.calls[0];
    expect(payload.eligible).toBe(false);
    expect(payload.reason).toBe("too-few-tool-calls");
  });

  it("TE-03: autonomousSkillDrafting false skips dispatch and logs reason disabled", () => {
    const log = makeLog();
    const dispatch = vi.fn();
    emitTaskCompletedEvent(
      {
        log: log as unknown as import("pino").Logger,
        getAgentConfig: () => makeAgentConfig({ enabled: false }),
        dispatchDistiller: dispatch,
        now: () => 0,
      },
      eligibleEvent(),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    const [payload] = log.info.mock.calls[0];
    expect(payload.eligible).toBe(false);
    expect(payload.reason).toBe("disabled");
  });

  it("TE-04: emitter swallows and logs at error level if dispatchDistiller throws", async () => {
    const log = makeLog();
    const dispatch = vi.fn().mockRejectedValue(new Error("boom"));
    emitTaskCompletedEvent(
      {
        log: log as unknown as import("pino").Logger,
        getAgentConfig: () => makeAgentConfig({ enabled: true }),
        dispatchDistiller: dispatch,
        now: () => 0,
      },
      eligibleEvent(),
    );
    // Out-of-band: emitter returned synchronously even though dispatch rejects.
    // Let the rejection settle then verify error log.
    await new Promise((r) => setImmediate(r));
    expect(log.error).toHaveBeenCalledTimes(1);
    const [errPayload, errMsg] = log.error.mock.calls[0];
    expect(errMsg).toBe("phase132-task-completed");
    expect(errPayload.dispatchError).toBeDefined();
  });

  it("TE-05: telemetry log msg is EXACTLY phase132-task-completed (D-09)", () => {
    const log = makeLog();
    const dispatch = vi.fn();
    emitTaskCompletedEvent(
      {
        log: log as unknown as import("pino").Logger,
        getAgentConfig: () => makeAgentConfig({ enabled: true }),
        dispatchDistiller: dispatch,
        now: () => 0,
      },
      eligibleEvent(),
    );
    const [, msg] = log.info.mock.calls[0];
    expect(msg).toBe("phase132-task-completed");
  });

  it("TE-06: log payload includes agent, sessionId, toolCallCount, durationMs, outcome, eligible", () => {
    const log = makeLog();
    const dispatch = vi.fn();
    const event = eligibleEvent();
    emitTaskCompletedEvent(
      {
        log: log as unknown as import("pino").Logger,
        getAgentConfig: () => makeAgentConfig({ enabled: true }),
        dispatchDistiller: dispatch,
        now: () => 0,
      },
      event,
    );
    const [payload] = log.info.mock.calls[0];
    expect(payload.agent).toBe(event.agent);
    expect(payload.sessionId).toBe(event.sessionId);
    expect(payload.toolCallCount).toBe(event.toolCallCount);
    expect(payload.durationMs).toBe(event.durationMs);
    expect(payload.outcome).toBe(event.outcome);
    expect(payload.eligible).toBe(true);
  });

  it("TE-07 (extra): missing agent config logs warn with reason agent-config-missing", () => {
    const log = makeLog();
    const dispatch = vi.fn();
    emitTaskCompletedEvent(
      {
        log: log as unknown as import("pino").Logger,
        getAgentConfig: () => undefined,
        dispatchDistiller: dispatch,
        now: () => 0,
      },
      eligibleEvent(),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [payload, msg] = log.warn.mock.calls[0];
    expect(msg).toBe("phase132-task-completed");
    expect(payload.reason).toBe("agent-config-missing");
  });
});
