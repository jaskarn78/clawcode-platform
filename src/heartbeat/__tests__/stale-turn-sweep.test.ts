/**
 * Debug session `stale-turn-watchdog-miss` (999.64 RECURRENCE) — regression
 * tests for the heartbeat runner's fleet-wide stale-turn sweep.
 *
 * Root cause being pinned: the original quick-260521-4sa watchdog lives
 * inside the heartbeat `inbox` check. Phase 999.57 registers every subagent
 * session's config with `heartbeat.enabled: false`, so the per-agent gate
 * in `tick()` skips the WHOLE agent — including the `inbox` check — for
 * subagent threads. The 4sa watchdog therefore could never fire for a
 * subagent, the exact session class that wedged in production (both
 * 2026-05-21 fin-client recurrences were subagent threads).
 *
 * The fix: `HeartbeatRunner.sweepStaleTurns()` runs for EVERY running
 * session BEFORE the heartbeat-disabled gate. These tests pin:
 *   - a `heartbeat.enabled: false` session stale past the force-release
 *     threshold IS swept (the 4sa-miss regression);
 *   - the sweep clears the stuck typing indicator via the release callback
 *     (gap #3);
 *   - a session stale BELOW the threshold is left untouched;
 *   - the sweep degrades gracefully when SessionManager lacks the
 *     turn-lifecycle methods (legacy / partial stubs).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HeartbeatRunner } from "../runner.js";
import { TURN_FORCE_RELEASE_THRESHOLD_MS } from "../stale-turn-thresholds.js";
import type { HeartbeatConfig } from "../types.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

type TurnState = {
  hasActiveTurn: boolean;
  lastActivityAt: number | null;
  turnStartedAt: number | null;
};

function createMockSessionManager(
  agents: string[],
  turnStates: Record<string, TurnState>,
) {
  return {
    getRunningAgents: vi.fn().mockReturnValue(agents),
    hasActiveTurn: vi.fn(
      (n: string) => turnStates[n]?.hasActiveTurn ?? false,
    ),
    getLastTurnActivityAt: vi.fn(
      (n: string) => turnStates[n]?.lastActivityAt ?? null,
    ),
    getTurnStartedAt: vi.fn(
      (n: string) => turnStates[n]?.turnStartedAt ?? null,
    ),
    forceReleaseTurn: vi.fn().mockReturnValue(true),
    getContextFillProvider: vi.fn().mockReturnValue(undefined),
    getCompactionManager: vi.fn().mockReturnValue(undefined),
    getMemoryStore: vi.fn().mockReturnValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function createConfig(): HeartbeatConfig {
  return {
    enabled: true,
    intervalSeconds: 60,
    checkTimeoutSeconds: 10,
    contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
  };
}

/**
 * A subagent-shaped config — the field that matters is
 * `heartbeat.enabled: false` (Phase 999.57 sets exactly this on every
 * subagent session). Other fields are filled to satisfy the type.
 */
function subagentConfig(name: string, tempDir: string): ResolvedAgentConfig {
  return {
    name,
    workspace: join(tempDir, name),
    memoryPath: join(tempDir, name),
    channels: [],
    model: "sonnet",
    effort: "low",
    allowedModels: ["haiku", "sonnet", "opus"],
    greetOnRestart: true,
    greetCoolDownMs: 300_000,
    autoCompactAt: 0.7,
    memoryAutoLoad: false,
    memoryRetrievalTopK: 0,
    memoryScannerEnabled: false,
    memoryFlushIntervalMs: 900_000,
    memoryCueEmoji: "✅",
    autoIngestAttachments: false,
    // Phase 999.57 — the load-bearing field for this regression.
    heartbeat: { enabled: false } as ResolvedAgentConfig["heartbeat"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HeartbeatRunner — fleet-wide stale-turn sweep (999.64 recurrence)", () => {
  let tempDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    tempDir = mkdtempSync(join(tmpdir(), "stale-turn-sweep-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("force-releases a heartbeat-DISABLED (subagent) session wedged past the threshold — the 4sa-miss regression", async () => {
    const name = "fin-client-via-fin-research-rtG1Y5";
    const sessionManager = createMockSessionManager([name], {
      [name]: {
        hasActiveTurn: true,
        lastActivityAt: NOW - 6 * 60_000, // 6 min stale > 5 min threshold
        turnStartedAt: NOW - 7 * 60_000,
      },
    });
    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config: createConfig(),
      checksDir: join(tempDir, "checks"),
      log: createMockLogger(),
    });
    // Subagent config: heartbeat.enabled === false. The per-agent gate in
    // tick() will skip the check loop for it — but the sweep must NOT.
    runner.setAgentConfigs([subagentConfig(name, tempDir)]);
    // No checks injected; the sweep runs independent of check modules.

    await runner.tick();
    // Defensive flush — `sweepStaleTurns` is fire-and-forget inside
    // tick(); flush microtasks so a future `await` added to the sweep's
    // legacy path cannot make this assertion silently race.
    await vi.advanceTimersByTimeAsync(0);

    // The sweep force-released the wedged subagent turn despite
    // heartbeat.enabled:false.
    expect(sessionManager.forceReleaseTurn).toHaveBeenCalledTimes(1);
    expect(sessionManager.forceReleaseTurn).toHaveBeenCalledWith(name);
    // Forensic log line emitted with the sweep-specific label.
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toBe(
      "phase999.64-stale-turn-sweep-force-release",
    );
    const payload = JSON.parse(warnSpy.mock.calls[0][1] as string);
    expect(payload.agent).toBe(name);
    expect(payload.staleMs).toBe(6 * 60_000);
    expect(payload.forceReleaseThresholdMs).toBe(
      TURN_FORCE_RELEASE_THRESHOLD_MS,
    );
  });

  it("999.99 review — DEFERS force-release while a self-fired (orphan) turn is streaming", async () => {
    const name = "fin-client";
    const sessionManager = createMockSessionManager([name], {
      [name]: {
        hasActiveTurn: true,
        lastActivityAt: NOW - 6 * 60_000, // 6 min stale > 5 min threshold
        turnStartedAt: NOW - 7 * 60_000,
      },
    });
    // Attributed-stream session: an orphan (background) turn is running, so
    // the waiting daemon turn's silence is HEALTHY — the sweep must not
    // force-release it (the interrupt would land on the foreign turn).
    sessionManager.isOrphanTurnOpen = vi.fn().mockReturnValue(true);

    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config: createConfig(),
      checksDir: join(tempDir, "checks"),
      log: createMockLogger(),
    });
    runner.setAgentConfigs([subagentConfig(name, tempDir)]);

    await runner.tick();
    await vi.advanceTimersByTimeAsync(0);

    // No force-release: the orphan-open probe deferred the sweep.
    expect(sessionManager.forceReleaseTurn).not.toHaveBeenCalled();
    expect(sessionManager.isOrphanTurnOpen).toHaveBeenCalledWith(name);
  });

  it("invokes the stale-turn release callback (typing-indicator cleanup) after force-release — gap #3", async () => {
    const name = "fin-client-via-fin-research-rtG1Y5";
    const sessionManager = createMockSessionManager([name], {
      [name]: {
        hasActiveTurn: true,
        lastActivityAt: NOW - 6 * 60_000,
        turnStartedAt: NOW - 7 * 60_000,
      },
    });
    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config: createConfig(),
      checksDir: join(tempDir, "checks"),
      log: createMockLogger(),
    });
    runner.setAgentConfigs([subagentConfig(name, tempDir)]);

    const releaseCallback = vi.fn();
    runner.setStaleTurnReleaseCallback(releaseCallback);

    await runner.tick();
    // Defensive flush — `sweepStaleTurns` is fire-and-forget inside
    // tick(); flush microtasks so a future `await` added to the sweep's
    // legacy path cannot make this assertion silently race.
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionManager.forceReleaseTurn).toHaveBeenCalledTimes(1);
    // The typing-indicator cleanup fired for the released session.
    expect(releaseCallback).toHaveBeenCalledTimes(1);
    expect(releaseCallback).toHaveBeenCalledWith(name);
  });

  it("does NOT release (or fire the callback) for a turn stale BELOW the threshold", async () => {
    const name = "fin-client-sub-abc123";
    const sessionManager = createMockSessionManager([name], {
      [name]: {
        hasActiveTurn: true,
        lastActivityAt: NOW - 30_000, // 30s — well below 5 min
        turnStartedAt: NOW - 30_000,
      },
    });
    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config: createConfig(),
      checksDir: join(tempDir, "checks"),
      log: createMockLogger(),
    });
    runner.setAgentConfigs([subagentConfig(name, tempDir)]);

    const releaseCallback = vi.fn();
    runner.setStaleTurnReleaseCallback(releaseCallback);

    await runner.tick();
    // Defensive flush — `sweepStaleTurns` is fire-and-forget inside
    // tick(); flush microtasks so a future `await` added to the sweep's
    // legacy path cannot make this assertion silently race.
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionManager.forceReleaseTurn).not.toHaveBeenCalled();
    expect(releaseCallback).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT release a session with no active turn", async () => {
    const name = "agent-idle";
    const sessionManager = createMockSessionManager([name], {
      [name]: {
        hasActiveTurn: false,
        lastActivityAt: null,
        turnStartedAt: null,
      },
    });
    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config: createConfig(),
      checksDir: join(tempDir, "checks"),
      log: createMockLogger(),
    });
    runner.setAgentConfigs([subagentConfig(name, tempDir)]);

    await runner.tick();
    // Defensive flush — `sweepStaleTurns` is fire-and-forget inside
    // tick(); flush microtasks so a future `await` added to the sweep's
    // legacy path cannot make this assertion silently race.
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionManager.forceReleaseTurn).not.toHaveBeenCalled();
  });

  it("a throwing release callback does not abort the sweep for other sessions", async () => {
    const wedged1 = "subagent-one";
    const wedged2 = "subagent-two";
    const sessionManager = createMockSessionManager([wedged1, wedged2], {
      [wedged1]: {
        hasActiveTurn: true,
        lastActivityAt: NOW - 6 * 60_000,
        turnStartedAt: NOW - 7 * 60_000,
      },
      [wedged2]: {
        hasActiveTurn: true,
        lastActivityAt: NOW - 6 * 60_000,
        turnStartedAt: NOW - 7 * 60_000,
      },
    });
    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config: createConfig(),
      checksDir: join(tempDir, "checks"),
      log: createMockLogger(),
    });
    runner.setAgentConfigs([
      subagentConfig(wedged1, tempDir),
      subagentConfig(wedged2, tempDir),
    ]);

    const releaseCallback = vi.fn().mockImplementation((n: string) => {
      if (n === wedged1) throw new Error("typing stop blew up");
    });
    runner.setStaleTurnReleaseCallback(releaseCallback);

    await runner.tick();
    // Defensive flush — `sweepStaleTurns` is fire-and-forget inside
    // tick(); flush microtasks so a future `await` added to the sweep's
    // legacy path cannot make this assertion silently race.
    await vi.advanceTimersByTimeAsync(0);

    // Both turns force-released despite the first callback throwing.
    expect(sessionManager.forceReleaseTurn).toHaveBeenCalledTimes(2);
    expect(releaseCallback).toHaveBeenCalledTimes(2);
  });

  it("degrades gracefully when SessionManager lacks the turn-lifecycle methods", async () => {
    // Legacy / partial stub: only getRunningAgents present.
    const sessionManager = {
      getRunningAgents: vi.fn().mockReturnValue(["agent-a"]),
      getContextFillProvider: vi.fn().mockReturnValue(undefined),
      getCompactionManager: vi.fn().mockReturnValue(undefined),
      getMemoryStore: vi.fn().mockReturnValue(undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config: createConfig(),
      checksDir: join(tempDir, "checks"),
      log: createMockLogger(),
    });

    // Must not throw — the sweep skips entirely.
    await expect(runner.tick()).resolves.toBeUndefined();
  });
});

// Debug session `in-tool-wedge-recovery` work-stream (C), FORK 8 — the
// sweep now prefers `SessionManager.backgroundOrReleaseStaleTurn`, which
// cleanly DETACHES a wedged Bash/Task tool (turn resumes) or falls back to
// the blunt `forceReleaseTurn`. These tests drive the branch outcomes.
describe("HeartbeatRunner — FORK 8 detach-or-release in the stale-turn sweep", () => {
  let tempDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    tempDir = mkdtempSync(join(tmpdir(), "stale-turn-sweep-c-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Mock SessionManager that exposes the FORK 8 `backgroundOrReleaseStaleTurn`
   * delegator alongside the legacy turn-lifecycle methods. `outcome` drives
   * what the detach-or-release reports.
   */
  function createMockSessionManagerC(
    name: string,
    outcome: "detached" | "released" | "no-turn",
  ) {
    return {
      getRunningAgents: vi.fn().mockReturnValue([name]),
      hasActiveTurn: vi.fn().mockReturnValue(true),
      getLastTurnActivityAt: vi.fn().mockReturnValue(NOW - 6 * 60_000),
      getTurnStartedAt: vi.fn().mockReturnValue(NOW - 7 * 60_000),
      forceReleaseTurn: vi.fn().mockReturnValue(true),
      backgroundOrReleaseStaleTurn: vi.fn().mockResolvedValue(outcome),
      getContextFillProvider: vi.fn().mockReturnValue(undefined),
      getCompactionManager: vi.fn().mockReturnValue(undefined),
      getMemoryStore: vi.fn().mockReturnValue(undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it("DETACH outcome — calls backgroundOrReleaseStaleTurn, NOT forceReleaseTurn, and does NOT fire the typing-cleanup callback", async () => {
    const name = "fin-client-via-fin-research-bash";
    const sessionManager = createMockSessionManagerC(name, "detached");
    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config: createConfig(),
      checksDir: join(tempDir, "checks"),
      log: createMockLogger(),
    });
    const typingCleanup = vi.fn();
    runner.setStaleTurnReleaseCallback(typingCleanup);

    await runner.tick();
    // The sweep is fire-and-forget (NOT awaited inside tick() — see the
    // runner.ts comment). Its FORK 8 detach path is async; flush the
    // microtask queue + 0ms-due timers so the awaited
    // `backgroundOrReleaseStaleTurn` mock + the Promise.race settle before
    // the assertions.
    await vi.advanceTimersByTimeAsync(0);

    // The FORK 8 path ran.
    expect(sessionManager.backgroundOrReleaseStaleTurn).toHaveBeenCalledWith(
      name,
    );
    // A clean detach must NOT fall back to the blunt force-release.
    expect(sessionManager.forceReleaseTurn).not.toHaveBeenCalled();
    // The turn is still alive — the typing indicator must keep spinning,
    // so the cleanup callback must NOT fire on the detach path.
    expect(typingCleanup).not.toHaveBeenCalled();
    // Distinct forensic anchor for the clean detach.
    const detachLog = warnSpy.mock.calls.find(
      (c: unknown[]) => c[0] === "phase999.64-stale-turn-sweep-background-detach",
    );
    expect(detachLog).toBeDefined();
  });

  it("RELEASED outcome — fires the typing-cleanup callback and the force-release forensic line", async () => {
    const name = "agent-mcp-wedge";
    const sessionManager = createMockSessionManagerC(name, "released");
    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config: createConfig(),
      checksDir: join(tempDir, "checks"),
      log: createMockLogger(),
    });
    const typingCleanup = vi.fn();
    runner.setStaleTurnReleaseCallback(typingCleanup);

    await runner.tick();
    // Fire-and-forget sweep — flush the async FORK 8 path (see DETACH test).
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionManager.backgroundOrReleaseStaleTurn).toHaveBeenCalledWith(
      name,
    );
    // The released path aborts the turn → the stuck typing indicator must
    // be cleared.
    expect(typingCleanup).toHaveBeenCalledWith(name);
    const releaseLog = warnSpy.mock.calls.find(
      (c: unknown[]) => c[0] === "phase999.64-stale-turn-sweep-force-release",
    );
    expect(releaseLog).toBeDefined();
  });

  it("legacy SessionManager (no backgroundOrReleaseStaleTurn) — falls back to the plain forceReleaseTurn path", async () => {
    const name = "legacy-agent";
    // A mock WITHOUT the FORK 8 method — the duck-type degrades cleanly.
    const sessionManager = createMockSessionManager([name], {
      [name]: {
        hasActiveTurn: true,
        lastActivityAt: NOW - 6 * 60_000,
        turnStartedAt: NOW - 7 * 60_000,
      },
    });
    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config: createConfig(),
      checksDir: join(tempDir, "checks"),
      log: createMockLogger(),
    });

    await runner.tick();

    // No FORK 8 method → the legacy synchronous force-release path runs.
    expect(sessionManager.forceReleaseTurn).toHaveBeenCalledWith(name);
  });

  it("backgroundOrReleaseStaleTurn that hangs past the timeout does not block the sweep — falls back to release semantics", async () => {
    const name = "agent-sick-sdk";
    const sessionManager = createMockSessionManagerC(name, "detached");
    // Make the detach hang forever — the SWEEP_DETACH_TIMEOUT_MS race must
    // resolve to "released" so the tick still completes.
    sessionManager.backgroundOrReleaseStaleTurn = vi.fn(
      () => new Promise(() => {}),
    );
    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config: createConfig(),
      checksDir: join(tempDir, "checks"),
      log: createMockLogger(),
    });

    // tick() does NOT await the sweep (fire-and-forget) — it resolves
    // immediately. The real assertion is below: the sweep's own
    // SWEEP_DETACH_TIMEOUT_MS race must resolve the hung detach to a
    // "released" outcome. Advance past the 2s timeout so the race settles.
    await runner.tick();
    await vi.advanceTimersByTimeAsync(2_500);
    // The hung detach was raced to a "released" outcome — the force-release
    // forensic line was emitted, proving the timeout fired and the
    // released branch ran (the sweep did not hang).
    const releaseLog = warnSpy.mock.calls.find(
      (c: unknown[]) => c[0] === "phase999.64-stale-turn-sweep-force-release",
    );
    expect(releaseLog).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 999.109 (INC-2026-08-18) — workflow-worker sweep exemption
// ---------------------------------------------------------------------------

describe("HeartbeatRunner — sweep exemption for live workflow workers (999.109)", () => {
  let tempDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    tempDir = mkdtempSync(join(tmpdir(), "sweep-exempt-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * A worker stale well past the threshold — the production shape (staleMs
   * was 303-325s when three fin-client workflows were killed).
   *
   * 999.109 review finding #3: `registerConfig` defaults to FALSE because
   * production never registered a workflow worker with the runner — that
   * missing registration is the whole reason the inbox check's own
   * force-release still reached workers. Registering here by default would
   * model a subagent THREAD and hide the bug.
   */
  function makeRunner(
    name: string,
    exempt: (n: string) => boolean,
    registerConfig = false,
  ) {
    const sessionManager = createMockSessionManager([name], {
      [name]: {
        hasActiveTurn: true,
        lastActivityAt: NOW - 6 * 60_000,
        turnStartedAt: NOW - 12 * 60_000,
      },
    });
    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config: createConfig(),
      checksDir: join(tempDir, "checks"),
      log: createMockLogger(),
    });
    if (registerConfig) {
      runner.setAgentConfigs([subagentConfig(name, tempDir)]);
    }
    runner.setSweepExemptionProbe(exempt);
    return { runner, sessionManager };
  }

  it("REGRESSION: a LIVE workflow worker mid-research is NOT force-released", async () => {
    const name = "fin-client-sub-4gHqDs";
    const { runner, sessionManager } = makeRunner(name, (n) => n === name);

    await runner.tick();
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionManager.forceReleaseTurn).not.toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some(
        (c: unknown[]) => c[0] === "phase999.64-stale-turn-sweep-force-release",
      ),
    ).toBe(false);
  });

  it("a subagent THREAD sharing the -sub- shape is STILL swept (999.64 preserved)", async () => {
    const name = "fin-client-sub-Iw_YWI";
    // Orchestrator does not own it → probe says false.
    const { runner, sessionManager } = makeRunner(name, () => false);

    await runner.tick();
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionManager.forceReleaseTurn).toHaveBeenCalledWith(name);
  });

  it("a worker that has SETTLED (no longer owned) becomes sweepable again", async () => {
    const name = "fin-client-sub-kgXu8y";
    let owned = true;
    const { runner, sessionManager } = makeRunner(name, () => owned);

    await runner.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionManager.forceReleaseTurn).not.toHaveBeenCalled();

    owned = false; // step settled / workflow went terminal
    await runner.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionManager.forceReleaseTurn).toHaveBeenCalledWith(name);
  });

  it("a THROWING probe fails safe — the sweep proceeds as before", async () => {
    const name = "fin-client-sub-boom01";
    const { runner, sessionManager } = makeRunner(name, () => {
      throw new Error("synthetic probe failure");
    });

    await runner.tick();
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionManager.forceReleaseTurn).toHaveBeenCalledWith(name);
  });

  it("with NO probe wired the sweep is byte-identical to pre-999.109", async () => {
    const name = "fin-client-sub-legacy";
    const sessionManager = createMockSessionManager([name], {
      [name]: {
        hasActiveTurn: true,
        lastActivityAt: NOW - 6 * 60_000,
        turnStartedAt: NOW - 7 * 60_000,
      },
    });
    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config: createConfig(),
      checksDir: join(tempDir, "checks"),
      log: createMockLogger(),
    });
    runner.setAgentConfigs([subagentConfig(name, tempDir)]);
    // setSweepExemptionProbe deliberately NOT called.

    await runner.tick();
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionManager.forceReleaseTurn).toHaveBeenCalledWith(name);
  });
});

/**
 * 999.109 review (findings #1/#2/#4/#5) — the sweep exemption alone did NOT
 * close the incident. Workflow workers were never registered with the
 * runner, so `heartbeat.enabled: false` never gated them and the FULL check
 * loop ran: the inbox check's own 5-minute force-release (same threshold as
 * the sweep) kept killing them, and its drain pulled the PARENT's inbox into
 * the worker session. These pin the registration that makes the gate real.
 */
describe("HeartbeatRunner — workflow workers must be GATE-REGISTERED (999.109 review)", () => {
  let tempDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    tempDir = mkdtempSync(join(tmpdir(), "worker-gate-"));
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildRunner(name: string, registerConfig: boolean) {
    const sessionManager = createMockSessionManager([name], {
      [name]: {
        hasActiveTurn: true,
        lastActivityAt: NOW - 6 * 60_000,
        turnStartedAt: NOW - 12 * 60_000,
      },
    });
    const runner = new HeartbeatRunner({
      sessionManager,
      registryPath: join(tempDir, "registry.json"),
      config: createConfig(),
      checksDir: join(tempDir, "checks"),
      log: createMockLogger(),
    });
    // Sweep exemption present in BOTH arms — isolating the gate registration.
    runner.setSweepExemptionProbe(() => true);
    if (registerConfig) runner.setAgentConfigs([subagentConfig(name, tempDir)]);
    return { runner, sessionManager };
  }

  it("a REGISTERED worker (heartbeat.enabled:false) is gated out of the whole check loop", async () => {
    const name = "fin-client-sub-registered";
    const { runner, sessionManager } = buildRunner(name, true);
    await runner.initialize();

    await runner.tick();
    await vi.advanceTimersByTimeAsync(0);

    expect(sessionManager.forceReleaseTurn).not.toHaveBeenCalled();
  });
});
