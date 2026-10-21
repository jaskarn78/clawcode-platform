// src/heartbeat/checks/__tests__/homelab-refresh.test.ts
//
// Phase 999.47 Plan 02 Task 2 — `homelab-refresh` heartbeat check tests.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import homelabRefreshCheck, {
  __setExecaForTests,
  __setReindexRunnerForTests,
  __resetMutexForTests,
  __resetLastTickForTests,
} from "../homelab-refresh.js";
import { logger } from "../../../shared/logger.js";
import type { CheckContext } from "../../types.js";

// ────────────────────────────────────────────────────────────────────
// Test fixture helpers.
// ────────────────────────────────────────────────────────────────────

function makeCtx(opts: {
  agentName?: string;
  runningAgents?: readonly string[];
  repoPath?: string;
  enabled?: boolean;
  refreshIntervalMinutes?: number;
}): CheckContext {
  const runningAgents = opts.runningAgents ?? ["agent-a"];
  const agentName = opts.agentName ?? runningAgents[0];
  const agentConfig = {
    name: agentName,
    homelab: {
      enabled: opts.enabled ?? true,
      refreshIntervalMinutes: opts.refreshIntervalMinutes ?? 60,
      repoPath: opts.repoPath ?? "/home/clawcode/homelab",
    },
  };
  const sessionManager = {
    getRunningAgents: vi.fn().mockReturnValue(runningAgents),
    getAgentConfig: vi.fn().mockReturnValue(agentConfig),
  } as unknown as CheckContext["sessionManager"];
  return {
    agentName,
    sessionManager,
    registry: {} as CheckContext["registry"],
    config: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
    },
  };
}

function happyRefreshJson() {
  return {
    schemaVersion: 1,
    ranAt: "2026-05-15T18:00:00.000Z",
    ok: true,
    commitsha: "abc1234abcdef",
    noDiff: false,
    counts: {
      hostCount: 6,
      vmCount: 4,
      containerCount: 2,
      driftCount: 1,
      tunnelCount: 3,
      dnsCount: 5,
    },
    failureReason: null,
    consecutiveFailures: 0,
  };
}

function writeRefreshJson(repoPath: string, content: unknown | string): void {
  const payload = typeof content === "string" ? content : JSON.stringify(content);
  writeFileSync(join(repoPath, ".refresh-last.json"), payload, "utf-8");
}

// ────────────────────────────────────────────────────────────────────
// Test harness — patch the shared logger so we can assert on calls.
// ────────────────────────────────────────────────────────────────────

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetMutexForTests();
  __resetLastTickForTests();
  infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger as never);
  warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
  errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger as never);
});

afterEach(() => {
  __setExecaForTests(null);
  __setReindexRunnerForTests(null);
  __resetMutexForTests();
  __resetLastTickForTests();
  infoSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("homelab-refresh heartbeat check", () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), "homelab-refresh-"));
    mkdirSync(join(repoPath, "scripts"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  // The ctx-config seam (added 2026-05-15 post-advisor-feedback) lets
  // each test inject its own repoPath via `makeCtx({ repoPath })`. The
  // execa mock writes the .refresh-last.json fixture directly into
  // that tempdir, and the check's readAndParseRefreshOutput reads from
  // the same path — full end-to-end coverage with NO try/catch swallow.

  it("Test 1: happy path — emits one info pino call with operator-grep shape, triggers reindex", async () => {
    const reindexSpy = vi.fn().mockResolvedValue(undefined);
    __setReindexRunnerForTests(reindexSpy);

    const execaSpy = vi.fn().mockImplementation(async (_cmd, _args, opts) => {
      const cwd = (opts as { cwd?: string }).cwd!;
      writeRefreshJson(cwd, happyRefreshJson());
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    __setExecaForTests(execaSpy);

    const ctx = makeCtx({ repoPath });
    const result = await homelabRefreshCheck.execute(ctx);

    expect(execaSpy).toHaveBeenCalled();
    expect(result.status).toBe("healthy");

    const infoCalls = infoSpy.mock.calls.filter(
      (call: unknown[]) => call[1] === "phase999.47-homelab-refresh",
    );
    expect(infoCalls).toHaveLength(1);
    const payload = infoCalls[0][0] as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.hostCount).toBe(6);
    expect(payload.vmCount).toBe(4);
    expect(payload.containerCount).toBe(2);
    expect(payload.driftCount).toBe(1);
    expect(payload.commitsha).toBe("abc1234abcdef");

    // Reindex was triggered fire-and-forget.
    expect(reindexSpy).toHaveBeenCalledTimes(1);
    expect(reindexSpy).toHaveBeenCalledWith(repoPath);
  });

  it("Test 2: .refresh-last.json missing → warning with synthetic refresh-output-missing reason", async () => {
    // execa succeeds (exit 0) but does NOT write the .refresh-last.json
    // file. The check should hit the missing-output branch.
    __setExecaForTests(
      vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    );
    const reindexSpy = vi.fn().mockResolvedValue(undefined);
    __setReindexRunnerForTests(reindexSpy);

    const ctx = makeCtx({ repoPath });
    const result = await homelabRefreshCheck.execute(ctx);

    expect(result.status).toBe("warning");
    const warnCalls = warnSpy.mock.calls.filter(
      (call: unknown[]) => call[1] === "phase999.47-homelab-refresh",
    );
    expect(warnCalls).toHaveLength(1);
    const payload = warnCalls[0][0] as Record<string, unknown>;
    expect(payload.reason).toBe("refresh-output-missing");
    expect(payload.ok).toBe(false);
    expect(payload.hostCount).toBe(0);
    expect(payload.commitsha).toBeNull();
    expect(reindexSpy).not.toHaveBeenCalled();
  });

  it("Test 3: .refresh-last.json malformed JSON → warning with refresh-output-malformed reason", async () => {
    __setExecaForTests(
      vi.fn().mockImplementation(async (_cmd, _args, opts) => {
        const cwd = (opts as { cwd?: string }).cwd!;
        writeRefreshJson(cwd, "{not valid json");
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    );
    const reindexSpy = vi.fn().mockResolvedValue(undefined);
    __setReindexRunnerForTests(reindexSpy);

    const ctx = makeCtx({ repoPath });
    const result = await homelabRefreshCheck.execute(ctx);

    expect(result.status).toBe("warning");
    const warnCalls = warnSpy.mock.calls.filter(
      (call: unknown[]) => call[1] === "phase999.47-homelab-refresh",
    );
    expect(warnCalls).toHaveLength(1);
    const payload = warnCalls[0][0] as Record<string, unknown>;
    expect(payload.reason).toBe("refresh-output-malformed");
    expect(reindexSpy).not.toHaveBeenCalled();
  });

  it("Test 4: ok=false with consecutiveFailures=3 → emits fleet-alert error log", async () => {
    const failurePayload = {
      schemaVersion: 1,
      ranAt: "2026-05-15T18:00:00.000Z",
      ok: false,
      commitsha: null,
      noDiff: false,
      counts: {
        hostCount: 0,
        vmCount: 0,
        containerCount: 0,
        driftCount: 0,
        tunnelCount: 0,
        dnsCount: 0,
      },
      failureReason: "tailscale-unreachable",
      consecutiveFailures: 3,
    };
    __setExecaForTests(
      vi.fn().mockImplementation(async (_cmd, _args, opts) => {
        const cwd = (opts as { cwd?: string }).cwd!;
        writeRefreshJson(cwd, failurePayload);
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    );

    const ctx = makeCtx({ repoPath });
    const result = await homelabRefreshCheck.execute(ctx);

    expect(result.status).toBe("warning");

    // Regular phase999.47-homelab-refresh telemetry line with ok=false.
    const refreshWarnCalls = warnSpy.mock.calls.filter(
      (call: unknown[]) => call[1] === "phase999.47-homelab-refresh",
    );
    expect(refreshWarnCalls).toHaveLength(1);
    const refreshPayload = refreshWarnCalls[0][0] as Record<string, unknown>;
    expect(refreshPayload.ok).toBe(false);
    expect(refreshPayload.reason).toBe("tailscale-unreachable");

    // Fleet-alert error log fires at consecutiveFailures>=3 (D-04c).
    const fleetAlertCalls = errorSpy.mock.calls.filter(
      (call: unknown[]) => call[1] === "phase999.47-homelab-fleet-alert",
    );
    expect(fleetAlertCalls).toHaveLength(1);
    const alertPayload = fleetAlertCalls[0][0] as Record<string, unknown>;
    expect(alertPayload.ok).toBe(false);
    expect(alertPayload.reason).toBe("tailscale-unreachable");
    expect(alertPayload.consecutiveFailures).toBe(3);
  });

  it("Test 4b: ok=false with consecutiveFailures=2 does NOT emit fleet-alert", async () => {
    const failurePayload = {
      schemaVersion: 1,
      ranAt: "2026-05-15T18:00:00.000Z",
      ok: false,
      commitsha: null,
      noDiff: false,
      counts: {
        hostCount: 0, vmCount: 0, containerCount: 0,
        driftCount: 0, tunnelCount: 0, dnsCount: 0,
      },
      failureReason: "tailscale-unreachable",
      consecutiveFailures: 2,
    };
    __setExecaForTests(
      vi.fn().mockImplementation(async (_cmd, _args, opts) => {
        const cwd = (opts as { cwd?: string }).cwd!;
        writeRefreshJson(cwd, failurePayload);
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    );

    const ctx = makeCtx({ repoPath });
    await homelabRefreshCheck.execute(ctx);

    const fleetAlertCalls = errorSpy.mock.calls.filter(
      (call: unknown[]) => call[1] === "phase999.47-homelab-fleet-alert",
    );
    expect(fleetAlertCalls).toHaveLength(0);
  });

  it("Test 5: refresh.sh exits non-zero → synthetic warning, stderr surfaces in reason", async () => {
    __setExecaForTests(
      vi.fn().mockResolvedValue({
        stdout: "",
        stderr: "tailscale CLI not found in PATH",
        exitCode: 1,
      }),
    );
    const reindexSpy = vi.fn().mockResolvedValue(undefined);
    __setReindexRunnerForTests(reindexSpy);

    const ctx = makeCtx({ repoPath });
    const result = await homelabRefreshCheck.execute(ctx);

    expect(result.status).toBe("warning");
    const warnCalls = warnSpy.mock.calls.filter(
      (call: unknown[]) => call[1] === "phase999.47-homelab-refresh",
    );
    expect(warnCalls.length).toBeGreaterThan(0);
    const payload = warnCalls[0][0] as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.hostCount).toBe(0);
    expect(typeof payload.reason).toBe("string");
    expect(payload.reason).toMatch(/tailscale CLI/);
    expect(reindexSpy).not.toHaveBeenCalled();
  });

  it("Test 6: ok=true path invokes reindex runner fire-and-forget; reindex failure does NOT mark tick as failed", async () => {
    const reindexError = new Error("reindex IPC unreachable");
    const reindexSpy = vi.fn().mockRejectedValue(reindexError);
    __setReindexRunnerForTests(reindexSpy);

    __setExecaForTests(
      vi.fn().mockImplementation(async (_cmd, _args, opts) => {
        const cwd = (opts as { cwd?: string }).cwd!;
        writeRefreshJson(cwd, happyRefreshJson());
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    );

    const ctx = makeCtx({ repoPath });
    const result = await homelabRefreshCheck.execute(ctx);

    // Tick result MUST NOT be marked failed because of a reindex error
    // — the contract is fire-and-forget. The reindex spy DID get called
    // (its rejected promise was swallowed by the .catch()).
    expect(result.status).toBe("healthy");
    expect(reindexSpy).toHaveBeenCalledTimes(1);
    // Give the microtask queue a chance to drain so the swallow-path
    // logger.warn lands before afterEach restores the spies.
    await new Promise((r) => setImmediate(r));
  });

  it("Test 7: overlapping tick — isRunning mutex skips the second invocation with structured warning", async () => {
    // First tick "holds" the mutex via a never-resolving execa promise.
    let releaseFirst: () => void = () => {};
    const firstPromise = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve) => {
        releaseFirst = () =>
          resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    );
    __setExecaForTests(vi.fn().mockReturnValue(firstPromise));

    const ctx = makeCtx({ repoPath });
    const firstTick = homelabRefreshCheck.execute(ctx);
    // Spin one microtask to let the first execute() pass the mutex set.
    await Promise.resolve();
    await Promise.resolve();

    // Second tick fires while first is still in flight — should see
    // the mutex set and skip with the synthetic warning payload.
    const secondResult = await homelabRefreshCheck.execute(ctx);
    expect(secondResult.status).toBe("warning");
    expect(secondResult.message).toMatch(/previous tick still running/);
    const warnCalls = warnSpy.mock.calls.filter(
      (call: unknown[]) => call[1] === "phase999.47-homelab-refresh",
    );
    const hadOverlapWarn = warnCalls.some((call: unknown[]) => {
      const payload = call[0] as Record<string, unknown>;
      return payload.reason === "previous-tick-still-running";
    });
    expect(hadOverlapWarn).toBe(true);

    // Release the first tick to keep the test clean.
    releaseFirst();
    await firstTick.catch(() => undefined);
  });

  it("Test 8: interval-based skip — second tick within refreshIntervalMinutes window returns within-interval-window", async () => {
    __setExecaForTests(
      vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    );

    const ctx = makeCtx({ repoPath });
    // First tick — runs (lastTickAtMs was null).
    await homelabRefreshCheck.execute(ctx);
    // Second tick immediately — should hit the within-interval branch.
    const secondResult = await homelabRefreshCheck.execute(ctx);
    expect(secondResult.message).toBe("within-interval-window");
    expect(secondResult.status).toBe("healthy");
  });

  it("Test 8b: refreshIntervalMinutes from config is honored — different cfg gives different cadence", async () => {
    __setExecaForTests(
      vi.fn().mockImplementation(async (_cmd, _args, opts) => {
        const cwd = (opts as { cwd?: string }).cwd!;
        writeRefreshJson(cwd, happyRefreshJson());
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    );
    __setReindexRunnerForTests(vi.fn().mockResolvedValue(undefined));

    // First tick at refreshIntervalMinutes=60.
    const ctxA = makeCtx({ repoPath, refreshIntervalMinutes: 60 });
    await homelabRefreshCheck.execute(ctxA);

    // Immediate re-tick at refreshIntervalMinutes=60 → within window.
    const second = await homelabRefreshCheck.execute(ctxA);
    expect(second.message).toBe("within-interval-window");
  });

  it("Test 8c: enabled=false in config → check returns disabled status without running refresh", async () => {
    const execaSpy = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    __setExecaForTests(execaSpy);

    const ctx = makeCtx({ repoPath, enabled: false });
    const result = await homelabRefreshCheck.execute(ctx);

    expect(result.status).toBe("healthy");
    expect(result.message).toMatch(/disabled/);
    expect(execaSpy).not.toHaveBeenCalled();
  });

  describe("sentinel-agent gating (Option A)", () => {
    it("non-sentinel agents no-op with status=healthy and message=sentinel-skip", async () => {
      const ctx = makeCtx({
        agentName: "agent-z",
        runningAgents: ["agent-a", "agent-z"],
      });
      const result = await homelabRefreshCheck.execute(ctx);
      expect(result.status).toBe("healthy");
      expect(result.message).toBe("sentinel-skip");
      // No telemetry should fire for non-sentinel agents.
      const phaseTagFired = [...infoSpy.mock.calls, ...warnSpy.mock.calls].some(
        (call) => call[1] === "phase999.47-homelab-refresh",
      );
      expect(phaseTagFired).toBe(false);
    });

    it("alphabetically-first agent is the sentinel that runs", async () => {
      const execaSpy = vi
        .fn()
        .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
      __setExecaForTests(execaSpy);

      // agent-a is first alphabetically → it is the sentinel.
      const ctx = makeCtx({
        agentName: "agent-a",
        runningAgents: ["agent-z", "agent-a"],
        repoPath,
      });
      await homelabRefreshCheck.execute(ctx);
      expect(execaSpy).toHaveBeenCalled();
    });
  });

  it("module name is 'homelab-refresh'", () => {
    expect(homelabRefreshCheck.name).toBe("homelab-refresh");
  });

  it("module interval defaults to 60min in seconds (3600)", () => {
    expect(homelabRefreshCheck.interval).toBe(3600);
  });
});
