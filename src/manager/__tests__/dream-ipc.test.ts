/**
 * Phase 95 Plan 03 Task 1 (RED) — daemon IPC `run-dream-pass` handler tests.
 *
 * Drives the to-be-extracted `handleRunDreamPassIpc` pure function. Mirrors
 * the Phase 86-02 `handleSetModelIpc` + Phase 94-01 `mcp-probe` handler
 * shapes — pure DI, no SessionManager spinup, no real socket.
 *
 * Pins:
 *   IPC1: idle-bypass=true + force=true → calls runDreamPass + applyDreamResult,
 *         returns {outcome, applied, agent, startedAt}
 *   IPC2: idle-bypass=false + agent active (idle:false) → SHORT-CIRCUITS to
 *         skipped(agent-active) WITHOUT invoking runDreamPass
 *   IPC3: idle-bypass=true + agent active → STILL fires runDreamPass
 *   IPC4: dream.enabled=false (config) + force=false → SHORT-CIRCUITS to
 *         skipped(disabled)
 *   IPC5: dream.enabled=false + force=true → fires with synthesized
 *         resolvedDreamConfig.enabled=true
 *   IPC6: --model=sonnet override → resolvedDreamConfig.model=sonnet wins
 *         over agent default
 *   IPC7: agent not in registry → throws ManagerError with code -32602
 *   IPC8: runDreamPass throws unexpectedly → throws ManagerError (does NOT
 *         crash daemon)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  handleRunDreamPassIpc,
  type RunDreamPassIpcDeps,
  type RunDreamPassRequest,
} from "../daemon.js";
import type { DreamPassOutcome } from "../dream-pass.js";
import type { DreamApplyOutcome } from "../dream-auto-apply.js";
import { ManagerError } from "../../shared/errors.js";

const FIXED_NOW = new Date("2026-04-25T12:00:00Z");

function silentLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function completedOutcome(model: string): DreamPassOutcome {
  return {
    kind: "completed",
    result: {
      newWikilinks: [],
      promotionCandidates: [],
      themedReflection: "stub reflection",
      suggestedConsolidations: [],
    },
    durationMs: 1234,
    tokensIn: 100,
    tokensOut: 50,
    model,
  };
}

function appliedApply(): DreamApplyOutcome {
  return {
    kind: "applied",
    appliedWikilinkCount: 0,
    surfacedPromotionCount: 0,
    surfacedConsolidationCount: 0,
    logPath: "/tmp/dreams/2026-04-25.md",
  };
}

function makeDeps(opts: {
  runDreamPassImpl?: (
    agent: string,
    model: string,
  ) => Promise<DreamPassOutcome>;
  applyImpl?: (
    agent: string,
    outcome: DreamPassOutcome,
  ) => Promise<DreamApplyOutcome>;
  isAgentIdleImpl?: (agent: string) => { idle: boolean; reason: string };
  resolvedConfig?:
    | { enabled: boolean; idleMinutes: number; model: string }
    | null;
  agents?: readonly string[];
}): RunDreamPassIpcDeps {
  return {
    runDreamPass:
      opts.runDreamPassImpl ??
      (async (_a, m) => completedOutcome(m ?? "haiku")),
    applyDreamResult: opts.applyImpl ?? (async () => appliedApply()),
    isAgentIdle:
      opts.isAgentIdleImpl ??
      (() => ({ idle: true, reason: "idle-threshold-met" })),
    getResolvedDreamConfig: () =>
      opts.resolvedConfig ?? {
        enabled: true,
        idleMinutes: 30,
        model: "haiku",
      },
    knownAgents: () => opts.agents ?? ["fin-client"],
    now: () => FIXED_NOW,
    log: silentLog(),
  };
}

describe("handleRunDreamPassIpc — Phase 95 Plan 03 (IPC1-IPC8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("IPC1: idle-bypass=true + force=true → calls runDreamPass + applyDreamResult, returns full response", async () => {
    const runDreamPass = vi.fn(async (_a, m) => completedOutcome(m));
    const applyDreamResult = vi.fn(async () => appliedApply());
    const deps = makeDeps({
      runDreamPassImpl: runDreamPass,
      applyImpl: applyDreamResult,
    });

    const req: RunDreamPassRequest = {
      agent: "fin-client",
      idleBypass: true,
      force: true,
    };
    const resp = await handleRunDreamPassIpc(req, deps);

    expect(runDreamPass).toHaveBeenCalledTimes(1);
    expect(applyDreamResult).toHaveBeenCalledTimes(1);
    expect(resp.agent).toBe("fin-client");
    expect(resp.startedAt).toBe(FIXED_NOW.toISOString());
    expect(resp.outcome.kind).toBe("completed");
    expect(resp.applied.kind).toBe("applied");
  });

  it("IPC2: --idle-bypass=false + agent active → short-circuits to skipped(agent-active) WITHOUT calling runDreamPass", async () => {
    const runDreamPass = vi.fn(async (_a, m) => completedOutcome(m));
    const applyDreamResult = vi.fn(async () => appliedApply());
    const deps = makeDeps({
      runDreamPassImpl: runDreamPass,
      applyImpl: applyDreamResult,
      isAgentIdleImpl: () => ({ idle: false, reason: "active" }),
    });

    const req: RunDreamPassRequest = {
      agent: "fin-client",
      idleBypass: false,
    };
    const resp = await handleRunDreamPassIpc(req, deps);

    expect(runDreamPass).not.toHaveBeenCalled();
    expect(applyDreamResult).not.toHaveBeenCalled();
    expect(resp.outcome.kind).toBe("skipped");
    if (resp.outcome.kind === "skipped") {
      expect(resp.outcome.reason).toBe("agent-active");
    }
    expect(resp.applied.kind).toBe("skipped");
  });

  it("IPC3: --idle-bypass=true + agent active → STILL fires runDreamPass", async () => {
    const runDreamPass = vi.fn(async (_a, m) => completedOutcome(m));
    const deps = makeDeps({
      runDreamPassImpl: runDreamPass,
      isAgentIdleImpl: () => ({ idle: false, reason: "active" }),
    });

    const req: RunDreamPassRequest = {
      agent: "fin-client",
      idleBypass: true,
    };
    const resp = await handleRunDreamPassIpc(req, deps);

    expect(runDreamPass).toHaveBeenCalledTimes(1);
    expect(resp.outcome.kind).toBe("completed");
  });

  it("IPC4: dream.enabled=false + force=false → short-circuits to skipped(disabled)", async () => {
    const runDreamPass = vi.fn(async (_a, m) => completedOutcome(m));
    const deps = makeDeps({
      runDreamPassImpl: runDreamPass,
      resolvedConfig: { enabled: false, idleMinutes: 30, model: "haiku" },
    });

    const req: RunDreamPassRequest = {
      agent: "fin-client",
      idleBypass: true,
      force: false,
    };
    const resp = await handleRunDreamPassIpc(req, deps);

    expect(runDreamPass).not.toHaveBeenCalled();
    expect(resp.outcome.kind).toBe("skipped");
    if (resp.outcome.kind === "skipped") {
      expect(resp.outcome.reason).toBe("disabled");
    }
  });

  it("IPC5: dream.enabled=false + force=true → fires runDreamPass with synthesized enabled=true", async () => {
    const runDreamPass = vi.fn(async (_a, m) => completedOutcome(m));
    const deps = makeDeps({
      runDreamPassImpl: runDreamPass,
      resolvedConfig: { enabled: false, idleMinutes: 30, model: "haiku" },
    });

    const req: RunDreamPassRequest = {
      agent: "fin-client",
      idleBypass: true,
      force: true,
    };
    const resp = await handleRunDreamPassIpc(req, deps);

    expect(runDreamPass).toHaveBeenCalledTimes(1);
    expect(resp.outcome.kind).toBe("completed");
  });

  it("IPC6: --model=sonnet override → passed to runDreamPass over agent default", async () => {
    const runDreamPass = vi.fn(async (_a, m) => completedOutcome(m));
    const deps = makeDeps({
      runDreamPassImpl: runDreamPass,
      resolvedConfig: { enabled: true, idleMinutes: 30, model: "haiku" },
    });

    const req: RunDreamPassRequest = {
      agent: "fin-client",
      idleBypass: true,
      modelOverride: "sonnet",
    };
    const resp = await handleRunDreamPassIpc(req, deps);

    expect(runDreamPass).toHaveBeenCalledTimes(1);
    const call = runDreamPass.mock.calls[0]!;
    // Second arg is the model the daemon passes to runDreamPass
    expect(call[1]).toBe("sonnet");
    if (resp.outcome.kind === "completed") {
      expect(resp.outcome.model).toBe("sonnet");
    }
  });

  it("IPC7: agent not in registry → throws ManagerError with code -32602", async () => {
    const deps = makeDeps({
      agents: ["other-agent"],
    });

    const req: RunDreamPassRequest = {
      agent: "fin-client",
      idleBypass: true,
    };

    await expect(handleRunDreamPassIpc(req, deps)).rejects.toMatchObject({
      message: expect.stringContaining("fin-client"),
    });
    try {
      await handleRunDreamPassIpc(req, deps);
    } catch (err) {
      expect(err).toBeInstanceOf(ManagerError);
      const code = (err as ManagerError & { code?: number }).code;
      expect(code).toBe(-32602);
    }
  });

  it("IPC8: runDreamPass throws unexpectedly → propagates as ManagerError without crashing", async () => {
    const deps = makeDeps({
      runDreamPassImpl: async () => {
        throw new Error("dispatch infrastructure exploded");
      },
    });

    const req: RunDreamPassRequest = {
      agent: "fin-client",
      idleBypass: true,
    };

    await expect(handleRunDreamPassIpc(req, deps)).rejects.toThrow(
      /dispatch infrastructure exploded/,
    );
  });
});
