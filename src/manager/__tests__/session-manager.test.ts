import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createMockAdapter, MockSessionHandle } from "../session-adapter.js";
import type { MockSessionAdapter } from "../session-adapter.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { BackoffConfig, Registry } from "../types.js";
import { writeRegistry, readRegistry } from "../registry.js";
import { SessionManager } from "../session-manager.js";

const TEST_BACKOFF: BackoffConfig = {
  baseMs: 100,
  maxMs: 1000,
  maxRetries: 3,
  stableAfterMs: 500,
};

function makeConfig(name: string): ResolvedAgentConfig {
  return {
    name,
    workspace: "/tmp/test-workspace",
    memoryPath: "/tmp/test-workspace", // Phase 75 SHARED-01
    channels: ["#general"],
    model: "sonnet",
    effort: "low",
    allowedModels: ["haiku", "sonnet", "opus"], // Phase 86 MODEL-01
    greetOnRestart: true, // Phase 89 GREET-07
    greetCoolDownMs: 300_000, // Phase 89 GREET-10
    autoCompactAt: 0.7, // Phase 124 D-06
    memoryAutoLoad: true, // Phase 90 MEM-01
    memoryRetrievalTopK: 5, // Phase 90 MEM-03
    memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"], // Phase 100 GSD-02
    autoStart: true, // Phase 100 follow-up
    skills: [],
    soul: undefined,
    identity: undefined,
    memory: { compactionThreshold: 0.75, searchTopK: 10, consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" }, decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 }, deduplication: { enabled: true, similarityThreshold: 0.85 } },
    schedules: [],
    heartbeat: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: {
        warningThreshold: 0.6,
        criticalThreshold: 0.75,
      },
    },
    skillsPath: "/tmp/skills",
    admin: false,
    sandbox: { enabled: false, allowRuntimeOp: false },
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
    reactions: false,
    mcpServers: [],
    slashCommands: [],
  };
}

describe("SessionManager", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    vi.useFakeTimers();
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "sm-test-"));
    registryPath = join(tmpDir, "registry.json");
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
    });
  });

  afterEach(async () => {
    // Stop all agents to clean up pending timers
    try {
      await manager.stopAll();
    } catch {
      // Ignore errors during cleanup
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("startAgent", () => {
    it("transitions agent from stopped to running and creates session", async () => {
      const config = makeConfig("agent-a");
      await manager.startAgent("agent-a", config);

      const registry = await readRegistry(registryPath);
      const entry = registry.entries.find((e) => e.name === "agent-a");
      expect(entry).toBeDefined();
      expect(entry!.status).toBe("running");
      expect(entry!.sessionId).toMatch(/^mock-agent-a-/);
      expect(entry!.startedAt).toBeTypeOf("number");
    });

    it("throws SessionError when agent is already running", async () => {
      const config = makeConfig("agent-a");
      await manager.startAgent("agent-a", config);
      await expect(manager.startAgent("agent-a", config)).rejects.toThrow(
        /already running/i,
      );
    });

    // Regression — workflow fanOut worker-spawn race (handoff §2/§5.1).
    // fanOut spawns workers via Promise.all → two distinct-name startAgent
    // calls run concurrently. They never share the per-NAME withLifecycleLock,
    // so before the atomic mutateRegistry RMW one of the two file writes
    // clobbered the other's entry and the clobbered start threw "Agent '<name>'
    // not found in registry" (~1-of-2 failures). This exercises the real
    // startAgent → mutateRegistry wiring (the unit tests in registry.test.ts
    // only cover the helper in isolation), so it also fails if any startAgent
    // registry write is ever reverted to a raw read/writeRegistry.
    it("two concurrent startAgent calls (distinct names) both survive in the registry", async () => {
      await Promise.all([
        manager.startAgent("race-a", makeConfig("race-a")),
        manager.startAgent("race-b", makeConfig("race-b")),
      ]);

      const registry = await readRegistry(registryPath);
      const names = registry.entries.map((e) => e.name).sort();
      expect(names).toEqual(["race-a", "race-b"]);
      for (const name of ["race-a", "race-b"]) {
        const entry = registry.entries.find((e) => e.name === name);
        expect(entry, `${name} must survive concurrent startAgent`).toBeDefined();
        expect(entry!.status).toBe("running");
      }
    });
  });

  describe("stopAgent", () => {
    it("transitions running agent to stopped and closes session", async () => {
      const config = makeConfig("agent-b");
      await manager.startAgent("agent-b", config);
      await manager.stopAgent("agent-b");

      const registry = await readRegistry(registryPath);
      const entry = registry.entries.find((e) => e.name === "agent-b");
      expect(entry).toBeDefined();
      expect(entry!.status).toBe("stopped");
      expect(entry!.sessionId).toBeNull();
    });

    it("throws SessionError when agent is not running", async () => {
      await expect(manager.stopAgent("nonexistent")).rejects.toThrow(
        /not running/i,
      );
    });
  });

  describe("restartAgent", () => {
    it("stops then starts the agent, incrementing restartCount", async () => {
      const config = makeConfig("agent-c");
      await manager.startAgent("agent-c", config);
      await manager.restartAgent("agent-c", config);

      const registry = await readRegistry(registryPath);
      const entry = registry.entries.find((e) => e.name === "agent-c");
      expect(entry).toBeDefined();
      expect(entry!.status).toBe("running");
      expect(entry!.restartCount).toBe(1);
    });
  });

  describe("startAll", () => {
    it("starts all agents from resolved configs", async () => {
      const configs = [
        makeConfig("agent-1"),
        makeConfig("agent-2"),
        makeConfig("agent-3"),
      ];
      await manager.startAll(configs);

      const registry = await readRegistry(registryPath);
      expect(registry.entries).toHaveLength(3);
      for (const entry of registry.entries) {
        expect(entry.status).toBe("running");
      }
    });

    it("continues starting other agents when one fails", async () => {
      const origCreate = adapter.createSession.bind(adapter);
      adapter.createSession = async (config) => {
        if (config.name === "fail-agent") {
          throw new Error("Simulated failure");
        }
        return origCreate(config);
      };

      const configs = [
        makeConfig("good-1"),
        makeConfig("fail-agent"),
        makeConfig("good-2"),
      ];
      await manager.startAll(configs);

      const registry = await readRegistry(registryPath);
      const running = registry.entries.filter((e) => e.status === "running");
      expect(running).toHaveLength(2);
    });
  });

  describe("stopAll", () => {
    it("stops all running agents", async () => {
      const configs = [makeConfig("s-1"), makeConfig("s-2")];
      await manager.startAll(configs);
      await manager.stopAll();

      const registry = await readRegistry(registryPath);
      for (const entry of registry.entries) {
        expect(entry.status).toBe("stopped");
      }
    });
  });

  describe("crash recovery", () => {
    it("detects crash and restarts with backoff", async () => {
      const config = makeConfig("crash-agent");
      await manager.startAgent("crash-agent", config);

      // Get the mock handle and simulate crash
      const registry1 = await readRegistry(registryPath);
      const sessionId = registry1.entries[0]!.sessionId!;
      const handle = adapter.sessions.get(sessionId) as MockSessionHandle;
      handle.simulateCrash(new Error("boom"));

      // Wait for the async crash handler to complete
      await manager._lastCrashPromise;

      // After crash, registry should show crashed
      const registry2 = await readRegistry(registryPath);
      const entry2 = registry2.entries.find((e) => e.name === "crash-agent");
      expect(entry2!.status).toBe("crashed");
      expect(entry2!.consecutiveFailures).toBe(1);

      // Advance timers past backoff delay to trigger restart
      await vi.advanceTimersByTimeAsync(TEST_BACKOFF.maxMs + 100);
      // Wait for the restart promise to resolve
      await manager._lastRestartPromise;

      const registry3 = await readRegistry(registryPath);
      const entry3 = registry3.entries.find((e) => e.name === "crash-agent");
      expect(entry3!.status).toBe("running");
      // Quick task 260521-xas — crash-recovery tests drive multiple
      // backoff-scheduled restarts, each re-entering the full
      // memory/embedder/session warmup. Under suite-wide load the real
      // async settling between fake-timer advances can exceed the 5000ms
      // vitest default and flake (a different test in this block fails
      // per run). Raise all three crash-recovery tests to 30s — matches
      // the timeout most other tests in this file already carry.
    }, 30_000);

    it("enters failed state after max retries", async () => {
      const config = makeConfig("fail-max");
      await manager.startAgent("fail-max", config);

      // Crash maxRetries times
      for (let i = 0; i < TEST_BACKOFF.maxRetries; i++) {
        const reg = await readRegistry(registryPath);
        const entry = reg.entries.find((e) => e.name === "fail-max");
        if (!entry || entry.status !== "running") {
          break;
        }
        const sid = entry.sessionId!;
        const h = adapter.sessions.get(sid) as MockSessionHandle;
        h.simulateCrash(new Error(`crash-${i}`));

        // Wait for crash handler and any scheduled restart/markFailed
        await manager._lastCrashPromise;
        await manager._lastRestartPromise;

        if (i < TEST_BACKOFF.maxRetries - 1) {
          // Advance past backoff to trigger restart
          await vi.advanceTimersByTimeAsync(TEST_BACKOFF.maxMs + 500);
          // Wait for restart to complete
          await manager._lastRestartPromise;
        }
      }

      const finalReg = await readRegistry(registryPath);
      const finalEntry = finalReg.entries.find((e) => e.name === "fail-max");
      expect(finalEntry!.status).toBe("failed");
    }, 30_000);

    it("resets consecutiveFailures after stable period", async () => {
      const config = makeConfig("stable-agent");
      await manager.startAgent("stable-agent", config);

      // Crash once to get consecutiveFailures to 1
      const reg1 = await readRegistry(registryPath);
      const sid1 = reg1.entries[0]!.sessionId!;
      const h1 = adapter.sessions.get(sid1) as MockSessionHandle;
      h1.simulateCrash(new Error("crash-1"));

      // Wait for crash handler
      await manager._lastCrashPromise;

      // Advance past backoff to restart
      await vi.advanceTimersByTimeAsync(TEST_BACKOFF.maxMs + 100);
      await manager._lastRestartPromise;

      // Verify it restarted with consecutiveFailures=1
      const reg2 = await readRegistry(registryPath);
      expect(reg2.entries[0]!.consecutiveFailures).toBe(1);

      // Now advance past stability window
      await vi.advanceTimersByTimeAsync(TEST_BACKOFF.stableAfterMs + 100);
      await manager._lastStabilityPromise;

      // After stable period, consecutiveFailures should be reset
      const reg3 = await readRegistry(registryPath);
      expect(reg3.entries[0]!.consecutiveFailures).toBe(0);
    }, 30_000);
  });

  describe("reconcileRegistry", () => {
    it("resumes running sessions from existing registry", async () => {
      // Seed a registry with a running entry
      const seededRegistry: Registry = {
        entries: [
          {
            name: "resume-agent",
            status: "running",
            sessionId: "existing-session-1",
            startedAt: Date.now() - 60000,
            restartCount: 0,
            consecutiveFailures: 0,
            lastError: null,
            lastStableAt: null,
          },
        ],
        updatedAt: Date.now(),
      };
      await writeRegistry(registryPath, seededRegistry);

      const configs = [makeConfig("resume-agent")];
      await manager.reconcileRegistry(configs);

      // Session should be tracked
      const reg = await readRegistry(registryPath);
      const entry = reg.entries.find((e) => e.name === "resume-agent");
      expect(entry!.status).toBe("running");
      expect(entry!.sessionId).toBe("existing-session-1");
    });

    it("marks crashed when resume fails and applies restart policy", async () => {
      // Make resume fail
      adapter.resumeSession = async () => {
        throw new Error("Session not found");
      };

      const seededRegistry: Registry = {
        entries: [
          {
            name: "stale-agent",
            status: "running",
            sessionId: "stale-session-1",
            startedAt: Date.now() - 60000,
            restartCount: 0,
            consecutiveFailures: 0,
            lastError: null,
            lastStableAt: null,
          },
        ],
        updatedAt: Date.now(),
      };
      await writeRegistry(registryPath, seededRegistry);

      const configs = [makeConfig("stale-agent")];
      await manager.reconcileRegistry(configs);

      const reg = await readRegistry(registryPath);
      const entry = reg.entries.find((e) => e.name === "stale-agent");
      expect(entry!.status).toBe("crashed");
      expect(entry!.consecutiveFailures).toBe(1);
      expect(entry!.lastError).toMatch(/session not found/i);

      // Restore normal adapter behavior so restart works
      const freshAdapter = createMockAdapter();
      adapter.createSession = freshAdapter.createSession.bind(freshAdapter);

      // Advance past backoff to verify restart attempt
      await vi.advanceTimersByTimeAsync(TEST_BACKOFF.maxMs + 100);
      await manager._lastRestartPromise;

      const reg2 = await readRegistry(registryPath);
      const entry2 = reg2.entries.find((e) => e.name === "stale-agent");
      expect(entry2!.status).toBe("running");
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 56 Plan 02 — warm-path ready gate
// ---------------------------------------------------------------------------

// Spy on runWarmPathCheck so we can force ready/failed/timeout shapes without
// needing real SQLite / embedder plumbing. The test-facing signature mirrors
// the module contract (WarmPathResult frozen object). vi.mock is hoisted to
// the top of this file, so it applies to EVERY describe block — earlier
// tests (startAgent / crash recovery / startAll / reconcileRegistry) still
// get a ready result by default via the global beforeEach below.
vi.mock("../warm-path-check.js", async () => {
  const actual = await vi.importActual<typeof import("../warm-path-check.js")>(
    "../warm-path-check.js",
  );
  return {
    ...actual,
    runWarmPathCheck: vi.fn(),
  };
});

import { runWarmPathCheck, WARM_PATH_TIMEOUT_MS } from "../warm-path-check.js";
import type { WarmPathResult } from "../warm-path-check.js";

const mockedRunWarmPathCheck = vi.mocked(runWarmPathCheck);

// Global default — every test starts with warm-path check succeeding so
// pre-Phase-56 tests keep seeing `status === "running"`. Individual tests
// override via `mockResolvedValueOnce(...)` for failure + timeout paths.
beforeEach(() => {
  mockedRunWarmPathCheck.mockReset();
  mockedRunWarmPathCheck.mockResolvedValue(
    // WarmPathResult has mutable fields; Object.freeze produces Readonly<T>.
    // Recover the declared shape via cast — runtime immutability is preserved
    // by the freeze, the consumer only reads.
    Object.freeze({
      ready: true,
      durations_ms: Object.freeze({ sqlite: 50, embedder: 80, session: 1, browser: 0 }),
      total_ms: 131,
      errors: Object.freeze([]) as readonly string[],
    }) as unknown as WarmPathResult,
  );
});

function makeReadyResult(totalMs = 131): WarmPathResult {
  return Object.freeze({
    ready: true,
    durations_ms: Object.freeze({ sqlite: 50, embedder: 80, session: 1, browser: 0 }),
    total_ms: totalMs,
    errors: Object.freeze([]) as readonly string[],
  }) as unknown as WarmPathResult;
}

function makeFailureResult(errors: readonly string[], totalMs = 85): WarmPathResult {
  return Object.freeze({
    ready: false,
    durations_ms: Object.freeze({ sqlite: 20, embedder: 65, session: 0, browser: 0 }),
    total_ms: totalMs,
    errors: Object.freeze([...errors]) as readonly string[],
  }) as unknown as WarmPathResult;
}

describe("startAgent warm-path gate (Phase 56)", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Global beforeEach already reset + set a ready default; tests that need
    // failure shapes use mockResolvedValueOnce.
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "sm-warm-"));
    registryPath = join(tmpDir, "registry.json");
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
    });
  });

  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {
      /* cleanup */
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("happy path: registry flips to running + warm_path_ready=true + readiness_ms in one atomic write", async () => {
    const config = makeConfig("warm-ok");
    mockedRunWarmPathCheck.mockResolvedValueOnce(makeReadyResult(131));

    await manager.startAgent("warm-ok", config);

    const registry = await readRegistry(registryPath);
    const entry = registry.entries.find((e) => e.name === "warm-ok");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("running");
    expect(entry!.warm_path_ready).toBe(true);
    expect(entry!.warm_path_readiness_ms).toBe(131);
    expect(entry!.sessionId).toMatch(/^mock-warm-ok-/);
  });

  it("failure path: ready=false routes through recovery ('crashed') with lastError prefix and removes session", async () => {
    // Quick task 260521-5gh Gap 1 — a warm-path failure no longer marks the
    // agent terminally 'failed' on the first failure; it routes through
    // recovery.handleCrash, which writes 'crashed' and schedules a backoff
    // restart. The registry write lands in the _lastCrashPromise chain.
    const config = makeConfig("warm-fail");
    mockedRunWarmPathCheck.mockResolvedValueOnce(
      makeFailureResult(["embedder: not ready"]),
    );

    await manager.startAgent("warm-fail", config);
    await manager._lastCrashPromise;

    const registry = await readRegistry(registryPath);
    const entry = registry.entries.find((e) => e.name === "warm-fail");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("crashed");
    expect(entry!.lastError).toBe("warm-path: embedder: not ready");
    expect(entry!.warm_path_ready).toBe(false);
    expect(entry!.warm_path_readiness_ms).toBe(85);

    // Session map must NOT retain the crashed agent.
    expect(manager.getRunningAgents()).not.toContain("warm-fail");
  });

  it("timeout path: warm-path timeout surfaces as lastError 'warm-path: timeout after 10000ms'", async () => {
    const config = makeConfig("warm-timeout");
    mockedRunWarmPathCheck.mockResolvedValueOnce(
      makeFailureResult(["timeout after 10000ms"], 10_000),
    );

    await manager.startAgent("warm-timeout", config);
    await manager._lastCrashPromise;

    const registry = await readRegistry(registryPath);
    const entry = registry.entries.find((e) => e.name === "warm-timeout");
    // Quick task 260521-5gh Gap 1 — routes through recovery; first failure
    // is 'crashed' (not terminal 'failed') with the warm-path lastError.
    expect(entry!.status).toBe("crashed");
    expect(entry!.lastError).toBe("warm-path: timeout after 10000ms");
    expect(entry!.warm_path_readiness_ms).toBe(10_000);
  });

  it("warm-path runs AFTER createSession (session probe verifies handle)", async () => {
    const config = makeConfig("warm-order");
    let sawSessionInProbe = false;
    mockedRunWarmPathCheck.mockImplementationOnce(async (deps) => {
      // When wired, the sessionProbe depends on the already-created handle
      // being non-empty. Simulate that by calling the probe and observing
      // it resolves without throwing.
      if (deps.sessionProbe) {
        await deps.sessionProbe();
        sawSessionInProbe = true;
      }
      return makeReadyResult(120);
    });

    await manager.startAgent("warm-order", config);
    expect(sawSessionInProbe).toBe(true);
  });

  it("sqliteWarm delegates to AgentMemoryManager.warmSqliteStores with the agent name", async () => {
    const config = makeConfig("warm-sqlite");
    let sqliteWarmCalledWith: string | undefined;
    mockedRunWarmPathCheck.mockImplementationOnce(async (deps) => {
      // Call it through — but replace the body so we don't need real DBs.
      // (In production it calls this.memory.warmSqliteStores; the mock
      // simply verifies the agent name is threaded through.)
      sqliteWarmCalledWith = deps.agent;
      return makeReadyResult(90);
    });

    await manager.startAgent("warm-sqlite", config);
    expect(sqliteWarmCalledWith).toBe("warm-sqlite");
  });

  it("calls runWarmPathCheck with timeoutMs=WARM_PATH_TIMEOUT_MS", async () => {
    const config = makeConfig("warm-timeout-arg");
    mockedRunWarmPathCheck.mockResolvedValueOnce(makeReadyResult(50));

    await manager.startAgent("warm-timeout-arg", config);
    expect(mockedRunWarmPathCheck).toHaveBeenCalled();
    const args = mockedRunWarmPathCheck.mock.calls[0]![0];
    expect(args.timeoutMs).toBe(WARM_PATH_TIMEOUT_MS);
  });

  it("emits 'warm-path ready' log line with agent + total_ms + durations", async () => {
    const infoCalls: Array<{ obj: unknown; msg: string }> = [];
    const testLogger = {
      info: (obj: unknown, msg?: string) => {
        infoCalls.push({ obj, msg: msg ?? "" });
      },
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      child: () => testLogger,
    };
    const m = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      log: testLogger as any,
    });

    mockedRunWarmPathCheck.mockResolvedValueOnce(makeReadyResult(142));
    await m.startAgent("warm-log", makeConfig("warm-log"));

    const readyLog = infoCalls.find((c) => c.msg.includes("warm-path ready"));
    expect(readyLog).toBeDefined();
    const payload = readyLog!.obj as {
      agent: string;
      total_ms: number;
      durations_ms: { sqlite: number; embedder: number; session: number; browser: number };
    };
    expect(payload.agent).toBe("warm-log");
    expect(payload.total_ms).toBe(142);
    expect(payload.durations_ms).toEqual({
      sqlite: 50,
      embedder: 80,
      session: 1,
      browser: 0,
    });

    await m.stopAll();
  });
});

// ---------------------------------------------------------------------------
// Phase 66 Plan 03 — session-boundary summarization wiring
// ---------------------------------------------------------------------------
import type { SummarizeFn } from "../../memory/session-summarizer.types.js";
import { EmbeddingService } from "../../memory/embedder.js";

// Pre-warm the embedding model ONCE for the Phase 66 block so the first
// test doesn't pay the ~3-5s cold-start cost inside its 5s timeout. The
// @huggingface/transformers module caches pipelines, so subsequent
// EmbeddingService instances constructed by AgentMemoryManager reuse the
// already-loaded ONNX model from the module cache.
beforeAll(async () => {
  const warmer = new EmbeddingService();
  await warmer.warmup();
}, 60_000);

describe("SessionManager session-boundary summarization (Phase 66)", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;
  let mockSummarize: ReturnType<typeof vi.fn>;

  // Per-test unique workspace so each agent gets a fresh memories.db and
  // ConversationStore. Shared /tmp/test-workspace across tests would mean
  // a previous test's sessions persist, inflating turn counts.
  function makeIsolatedConfig(name: string): ResolvedAgentConfig {
    return { ...makeConfig(name), workspace: tmpDir, memoryPath: tmpDir };
  }

  beforeEach(async () => {
    // Use REAL timers for these tests. The crash-path test awaits a real
    // promise released via releaseSummarize(), so fake timers would hang.
    vi.useRealTimers();
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "sm-p66-"));
    registryPath = join(tmpDir, "registry.json");
    // Default mock returns a well-formed markdown summary synchronously.
    mockSummarize = vi.fn().mockResolvedValue(
      "## User Preferences\n- mock pref\n\n## Decisions\n(none)\n\n## Open Threads\n(none)\n\n## Commitments\n(none)\n",
    );
    // Warm-path check is mocked module-wide from earlier; default from the
    // outer beforeEach already returns ready=true.
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
      summarizeFn: mockSummarize as unknown as SummarizeFn,
    });
  });

  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {
      /* ignore */
    }
    // The crash-path test leaves a detached summarize promise that writes
    // to memories.db after the test body returns. Give it a beat to settle
    // before rm so we don't race open SQLite handles against directory
    // removal (ENOTEMPTY on Linux when a *.db-journal sibling lingers).
    await new Promise((r) => setTimeout(r, 100));
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* directory may still contain open DB handles -- non-fatal for tests */
    }
  });

  it("stopAgent with >=3 turns triggers summarize and inserts a session-summary memory", async () => {
    const config = makeIsolatedConfig("stop-summarize");
    await manager.startAgent("stop-summarize", config);

    const convStore = manager.getConversationStore("stop-summarize")!;
    const convSessionId = manager.getActiveConversationSessionId(
      "stop-summarize",
    )!;
    expect(convStore).toBeDefined();
    expect(convSessionId).toBeTruthy();

    // Seed 4 turns (above the minTurns=3 threshold)
    for (let i = 0; i < 4; i++) {
      convStore.recordTurn({
        sessionId: convSessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i} content with enough text`,
      });
    }

    // Spy on memoryStore.insert BEFORE stopAgent (cleanupMemory closes the store).
    const memStore = manager.getMemoryStore("stop-summarize")!;
    const insertSpy = vi.spyOn(memStore, "insert");

    await manager.stopAgent("stop-summarize");

    // summarize was invoked exactly once with the agent-facing prompt
    expect(mockSummarize).toHaveBeenCalledTimes(1);
    const [prompt, opts] = mockSummarize.mock.calls[0]!;
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("## User Preferences");
    expect(opts).toHaveProperty("signal");

    // memoryStore.insert called with a session-summary entry
    const sessionSummaryCall = insertSpy.mock.calls.find(
      (call) =>
        (call[0] as { tags?: readonly string[] }).tags?.includes(
          "session-summary",
        ) ?? false,
    );
    expect(sessionSummaryCall).toBeDefined();
    const input = sessionSummaryCall![0] as {
      source: string;
      tags: readonly string[];
      sourceTurnIds?: readonly string[];
    };
    expect(input.source).toBe("conversation");
    expect(input.tags).toContain("session-summary");
    expect(input.tags).toContain(`session:${convSessionId}`);
    expect(input.sourceTurnIds).toBeDefined();
    expect(input.sourceTurnIds!.length).toBe(4);
  }, 30_000);

  it("stopAgent with <3 turns skips summarize (minTurns guard)", async () => {
    const config = makeIsolatedConfig("stop-skip");
    await manager.startAgent("stop-skip", config);

    const convStore = manager.getConversationStore("stop-skip")!;
    const convSessionId = manager.getActiveConversationSessionId(
      "stop-skip",
    )!;

    // Seed only 2 turns — below minTurns=3
    convStore.recordTurn({
      sessionId: convSessionId,
      role: "user",
      content: "first",
    });
    convStore.recordTurn({
      sessionId: convSessionId,
      role: "assistant",
      content: "second",
    });

    await manager.stopAgent("stop-skip");

    expect(mockSummarize).not.toHaveBeenCalled();
  }, 30_000);

  it("onError (crash) schedules summarize fire-and-forget: crashSession transitions state synchronously, summarize completes asynchronously", async () => {
    const config = makeIsolatedConfig("crash-summarize");
    await manager.startAgent("crash-summarize", config);

    const convStore = manager.getConversationStore("crash-summarize")!;
    const convSessionId = manager.getActiveConversationSessionId(
      "crash-summarize",
    )!;

    // Seed 4 turns so summarize will actually run (>= minTurns)
    for (let i = 0; i < 4; i++) {
      convStore.recordTurn({
        sessionId: convSessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `crash turn ${i}`,
      });
    }

    // Make summarize HANG until we release it — lets us observe that crash
    // handler returns synchronously while summarize is still pending.
    let releaseSummarize: ((value: string) => void) | null = null;
    const summarizePromise = new Promise<string>((resolve) => {
      releaseSummarize = resolve;
    });
    mockSummarize.mockReturnValue(summarizePromise);

    // Get the MockSessionHandle via the existing harness pattern
    const registry = await readRegistry(registryPath);
    const entry = registry.entries.find((e) => e.name === "crash-summarize")!;
    const sessionId = entry.sessionId!;
    const handle = adapter.sessions.get(sessionId) as MockSessionHandle;
    expect(handle).toBeDefined();

    // Trigger crash — this calls onError synchronously inside MockSessionHandle
    handle.simulateCrash(new Error("simulated crash"));

    // Wait for the crash handler to complete (awaits crashSession sync work
    // + recovery.handleCrash; leaves summarize detached).
    await manager._lastCrashPromise;

    // ASSERT 1: session status transitioned to "crashed" synchronously,
    // BEFORE we release the hung summarize promise.
    const sessionAfterCrash = convStore.getSession(convSessionId);
    expect(sessionAfterCrash).not.toBeNull();
    expect(sessionAfterCrash!.status).toBe("crashed");

    // ASSERT 2: summarize was SCHEDULED (called) but has not yet resolved.
    expect(mockSummarize).toHaveBeenCalledTimes(1);

    // Now release summarize so the detached promise can complete.
    releaseSummarize!(
      "## User Preferences\n(none)\n\n## Decisions\n(none)\n\n## Open Threads\n(none)\n\n## Commitments\n(none)\n",
    );

    // Give the detached promise a few macrotasks to resolve + run markSummarized.
    await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 50));

    // ASSERT 3: summarize was called with correct prompt.
    expect(mockSummarize).toHaveBeenCalledTimes(1);
    const [prompt] = mockSummarize.mock.calls[0]!;
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("## User Preferences");

    // Manually close the memory store — crash recovery doesn't call
    // cleanupMemory, so without this the better-sqlite3 handle stays open
    // and ENOTEMPTY trips during tmpDir rm in afterEach.
    const memStore = manager.getMemoryStore("crash-summarize");
    if (memStore) {
      try { memStore.close(); } catch { /* already closed */ }
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Gap 1 (memory-persistence-gaps) — reconcileRegistry must populate the
  // conversation-session tracking so a later stopAgent (e.g. dashboard restart
  // after daemon reboot) actually writes a session summary.
  // ---------------------------------------------------------------------------
  it("reconcileRegistry initializes memory and starts a conversation session for resumed agents", async () => {
    const agentName = "reconcile-conv";
    const config = makeIsolatedConfig(agentName);
    // Seed a registry as if a prior daemon left the agent 'running'.
    const seeded: Registry = {
      entries: [
        {
          name: agentName,
          status: "running",
          sessionId: "prior-session-xyz",
          startedAt: Date.now() - 60000,
          restartCount: 0,
          consecutiveFailures: 0,
          lastError: null,
          lastStableAt: null,
        },
      ],
      updatedAt: Date.now(),
    };
    await writeRegistry(registryPath, seeded);

    await manager.reconcileRegistry([config]);

    // Memory + ConversationStore must now exist for the resumed agent.
    expect(manager.getMemoryStore(agentName)).toBeDefined();
    expect(manager.getConversationStore(agentName)).toBeDefined();
    // activeConversationSessionIds must carry a fresh conversation session.
    const convSessionId = manager.getActiveConversationSessionId(agentName);
    expect(convSessionId).toBeTruthy();
  }, 30_000);

  it("stopAgent after reconcile-resume writes a session summary (Gap 1 end-to-end)", async () => {
    const agentName = "reconcile-stop-summary";
    const config = makeIsolatedConfig(agentName);
    const seeded: Registry = {
      entries: [
        {
          name: agentName,
          status: "running",
          sessionId: "prior-session-abc",
          startedAt: Date.now() - 60000,
          restartCount: 0,
          consecutiveFailures: 0,
          lastError: null,
          lastStableAt: null,
        },
      ],
      updatedAt: Date.now(),
    };
    await writeRegistry(registryPath, seeded);

    await manager.reconcileRegistry([config]);

    const convStore = manager.getConversationStore(agentName)!;
    const convSessionId = manager.getActiveConversationSessionId(agentName)!;
    expect(convStore).toBeDefined();
    expect(convSessionId).toBeTruthy();

    // Seed turns above the minTurns=3 threshold so summarize hits the
    // Haiku path and calls our mockSummarize.
    for (let i = 0; i < 4; i++) {
      convStore.recordTurn({
        sessionId: convSessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `reconciled turn ${i} content`,
      });
    }

    const memStore = manager.getMemoryStore(agentName)!;
    const insertSpy = vi.spyOn(memStore, "insert");

    await manager.stopAgent(agentName);

    expect(mockSummarize).toHaveBeenCalledTimes(1);
    const summaryCall = insertSpy.mock.calls.find((call) =>
      (call[0] as { tags?: readonly string[] }).tags?.includes("session-summary"),
    );
    expect(summaryCall).toBeDefined();
    const input = summaryCall![0] as {
      source: string;
      tags: readonly string[];
    };
    expect(input.source).toBe("conversation");
    expect(input.tags).toContain(`session:${convSessionId}`);
  }, 30_000);

  it("startAll after reconcile is a no-op for agents already resumed (no 'already running' errors)", async () => {
    const agentName = "reconcile-startall-race";
    const config = makeIsolatedConfig(agentName);
    const seeded: Registry = {
      entries: [
        {
          name: agentName,
          status: "running",
          sessionId: "prior-session-race",
          startedAt: Date.now() - 60000,
          restartCount: 0,
          consecutiveFailures: 0,
          lastError: null,
          lastStableAt: null,
        },
      ],
      updatedAt: Date.now(),
    };
    await writeRegistry(registryPath, seeded);

    await manager.reconcileRegistry([config]);

    // startAll must NOT throw "already running" internally for the resumed
    // agent. startAll swallows per-agent errors so this mainly asserts no
    // duplicate registry write / silent log, which we verify by ensuring
    // activeConversationSessionIds is stable across startAll.
    const before = manager.getActiveConversationSessionId(agentName);
    await manager.startAll([config]);
    const after = manager.getActiveConversationSessionId(agentName);

    expect(after).toBe(before);
  }, 30_000);

  // ── Phase 99-C: pending-summary backlog drain ──────────────────────────────
  // summarizePendingSessions should pick up sessions that ended/crashed
  // without ever being summarized (status='ended' OR 'crashed' AND
  // summary_memory_id IS NULL with at least one turn) and run summarizeSession
  // on each via the same wiring the stop-path / crash-path use.
  it("summarizePendingSessions drains the backlog and writes summary memories", async () => {
    const agentName = "summarize-pending";
    const config = makeIsolatedConfig(agentName);
    await manager.startAgent(agentName, config);

    const convStore = manager.getConversationStore(agentName)!;
    const memStore = manager.getMemoryStore(agentName)!;

    // Seed 3 ended-no-summary sessions (each with 4 turns to exceed minTurns=3).
    const seeded: string[] = [];
    for (let s = 0; s < 3; s++) {
      const session = convStore.startSession(agentName);
      seeded.push(session.id);
      for (let i = 0; i < 4; i++) {
        convStore.recordTurn({
          sessionId: session.id,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `pending session ${s} turn ${i} body`,
        });
      }
      convStore.endSession(session.id);
    }

    // Sanity: the backlog query sees the 3 seeded sessions.
    expect(
      convStore.listPendingSummarySessions(agentName, 10).map((x) => x.id),
    ).toEqual(expect.arrayContaining(seeded));

    const insertSpy = vi.spyOn(memStore, "insert");
    const result = await manager.summarizePendingSessions(agentName, 10);

    expect(result.attempted).toBe(3);
    expect(result.summarized).toBe(3);
    expect(result.skipped).toBe(0);

    // Each session got a session-summary memory entry.
    const summaryInserts = insertSpy.mock.calls.filter((c) =>
      (c[0] as { tags?: readonly string[] }).tags?.includes(
        "session-summary",
      ),
    );
    expect(summaryInserts.length).toBe(3);

    // After draining, every seeded session is now status='summarized' with
    // a summary_memory_id populated.
    for (const id of seeded) {
      const after = convStore.getSession(id)!;
      expect(after.status).toBe("summarized");
      expect(after.summaryMemoryId).toBeTruthy();
    }
    // Backlog is now empty.
    expect(convStore.listPendingSummarySessions(agentName, 10)).toHaveLength(0);
  }, 30_000);

  it("summarizePendingSessions returns zeroed counts when stores aren't open", async () => {
    // No startAgent — memoryStore / conversationStore not in the maps.
    const r = await manager.summarizePendingSessions("never-started", 5);
    expect(r).toEqual({ attempted: 0, summarized: 0, skipped: 0 });
  });

  it("summarizePendingSessions respects the limit argument", async () => {
    const agentName = "summarize-pending-limit";
    const config = makeIsolatedConfig(agentName);
    await manager.startAgent(agentName, config);

    const convStore = manager.getConversationStore(agentName)!;
    for (let s = 0; s < 5; s++) {
      const session = convStore.startSession(agentName);
      for (let i = 0; i < 4; i++) {
        convStore.recordTurn({
          sessionId: session.id,
          role: "user",
          content: `lim ${s}.${i}`,
        });
      }
      convStore.endSession(session.id);
    }

    const r = await manager.summarizePendingSessions(agentName, 2);
    expect(r.attempted).toBe(2);
    // 3 sessions remain pending after the capped tick.
    expect(
      convStore.listPendingSummarySessions(agentName, 10).length,
    ).toBe(3);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Gap 3 (memory-persistence-gaps) — periodic mid-session flush
// ---------------------------------------------------------------------------

describe("SessionManager periodic mid-session flush (Gap 3)", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;
  let mockSummarize: ReturnType<typeof vi.fn>;

  function makeFlushConfig(name: string, flushIntervalMinutes: number): ResolvedAgentConfig {
    const base = makeConfig(name);
    return {
      ...base,
      workspace: tmpDir,
      memoryPath: tmpDir,
      memory: {
        ...base.memory,
        conversation: {
          enabled: true,
          turnRetentionDays: 90,
          resumeSessionCount: 3,
          resumeGapThresholdHours: 4,
          conversationContextBudget: 2000,
          retrievalHalfLifeDays: 14,
          flushIntervalMinutes,
        },
      },
    } as ResolvedAgentConfig;
  }

  /**
   * Wait for an assertion to become true, polling on real time. Preferred
   * over fixed setTimeout waits because the actual flush completion time
   * depends on the real embedder's pipeline latency (a few tens of ms in
   * steady state, but variable on cold start).
   */
  async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
  }

  beforeEach(async () => {
    vi.useRealTimers();
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "sm-flush-"));
    registryPath = join(tmpDir, "registry.json");
    mockSummarize = vi.fn().mockResolvedValue(
      "## User Preferences\n- mock\n\n## Decisions\n(none)\n\n## Open Threads\n(none)\n\n## Commitments\n(none)\n",
    );
    // flushIntervalMsOverride keeps the tick fast so tests don't wait
    // 15 real minutes. Config minutes value still must pass schema validation
    // (>0 means "enabled") — the override wins at timer-start time.
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
      summarizeFn: mockSummarize as unknown as SummarizeFn,
      flushIntervalMsOverride: 100,
    });
  });

  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 50));
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  });

  it("writes a mid-session memory row with mid-session+flush:1 tags and leaves the session active", async () => {
    const agentName = "flush-basic";
    const config = makeFlushConfig(agentName, 15);
    await manager.startAgent(agentName, config);

    const convStore = manager.getConversationStore(agentName)!;
    const convSessionId = manager.getActiveConversationSessionId(agentName)!;

    // Seed 4 turns so the flush hits the Haiku path (minTurns=3).
    for (let i = 0; i < 4; i++) {
      convStore.recordTurn({
        sessionId: convSessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `flush turn ${i} content with some substance`,
      });
    }

    const memStore = manager.getMemoryStore(agentName)!;
    const insertSpy = vi.spyOn(memStore, "insert");

    // Wait for the flush to complete — override interval is 100ms, plus
    // embedder + insert time.
    await waitFor(() =>
      insertSpy.mock.calls.some((call) =>
        (call[0] as { tags?: readonly string[] }).tags?.includes("mid-session"),
      ),
    );

    const midSessionCall = insertSpy.mock.calls.find((call) =>
      (call[0] as { tags?: readonly string[] }).tags?.includes("mid-session"),
    );
    expect(midSessionCall).toBeDefined();
    const input = midSessionCall![0] as {
      source: string;
      tags: readonly string[];
    };
    expect(input.source).toBe("conversation");
    expect(input.tags).toContain("mid-session");
    expect(input.tags).toContain(`session:${convSessionId}`);
    expect(input.tags).toContain("flush:1");
    expect(input.tags).not.toContain("session-summary");

    // Session still active; raw turns still present.
    const session = convStore.getSession(convSessionId);
    expect(session!.status).toBe("active");
    expect(convStore.getTurnsForSession(convSessionId)).toHaveLength(4);
  }, 15_000);

  // WP1 (memory overhaul 2026-10-25): the flush is incremental, so flush:2
  // needs 4 more turns after flush:1. The pre-WP1 version of this test
  // waited for two rows over the same 4 turns.
  it("increments flush sequence tag across consecutive intervals (flush:1 then flush:2)", async () => {
    const agentName = "flush-seq";
    const config = makeFlushConfig(agentName, 15);
    await manager.startAgent(agentName, config);

    const convStore = manager.getConversationStore(agentName)!;
    const convSessionId = manager.getActiveConversationSessionId(agentName)!;
    const recordTurns = (from: number): void => {
      for (let i = from; i < from + 4; i++) {
        convStore.recordTurn({
          sessionId: convSessionId,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `turn ${i} content`,
        });
      }
    };

    const memStore = manager.getMemoryStore(agentName)!;
    const insertSpy = vi.spyOn(memStore, "insert");
    const midSessionTags = (): Array<readonly string[]> =>
      insertSpy.mock.calls
        .map((call) => (call[0] as { tags?: readonly string[] }).tags ?? [])
        .filter((tags) => tags.includes("mid-session"));

    recordTurns(0);
    await waitFor(() => midSessionTags().length >= 1, 5000);
    recordTurns(4);
    await waitFor(() => midSessionTags().length >= 2, 5000);

    const allTags = midSessionTags();
    expect(allTags[0]).toContain("flush:1");
    expect(allTags[1]).toContain("flush:2");
  }, 15_000);

  it("WP1: ticks without 4 new turns write nothing and do not consume a flush number", async () => {
    const agentName = "flush-idle";
    const config = makeFlushConfig(agentName, 15);
    await manager.startAgent(agentName, config);

    const convStore = manager.getConversationStore(agentName)!;
    const convSessionId = manager.getActiveConversationSessionId(agentName)!;
    const recordTurns = (from: number, count: number): void => {
      for (let i = from; i < from + count; i++) {
        convStore.recordTurn({
          sessionId: convSessionId,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `idle turn ${i} content`,
        });
      }
    };
    const memStore = manager.getMemoryStore(agentName)!;
    const insertSpy = vi.spyOn(memStore, "insert");
    const midSessionTags = (): Array<readonly string[]> =>
      insertSpy.mock.calls
        .map((call) => (call[0] as { tags?: readonly string[] }).tags ?? [])
        .filter((tags) => tags.includes("mid-session"));

    recordTurns(0, 4);
    await waitFor(() => midSessionTags().length >= 1, 5000);
    const summarizeCalls = mockSummarize.mock.calls.length;

    // ~5 ticks with only 3 new turns: no Haiku call, no row.
    recordTurns(4, 3);
    await new Promise((r) => setTimeout(r, 500));
    expect(midSessionTags()).toHaveLength(1);
    expect(mockSummarize.mock.calls.length).toBe(summarizeCalls);

    // The fourth new turn releases the next flush, numbered 2 (not 6).
    recordTurns(7, 1);
    await waitFor(() => midSessionTags().length >= 2, 5000);
    expect(midSessionTags()[1]).toContain("flush:2");
  }, 15_000);

  it("WP1: only one flush runs at a time per agent", async () => {
    // Only the first call blocks; later ones (the stop-path session summary
    // in afterEach) resolve at once.
    let release: (() => void) | undefined;
    mockSummarize.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("## Decisions\n- slow\n");
        }),
    );
    const agentName = "flush-inflight";
    const config = makeFlushConfig(agentName, 15);
    await manager.startAgent(agentName, config);

    const convStore = manager.getConversationStore(agentName)!;
    const convSessionId = manager.getActiveConversationSessionId(agentName)!;
    for (let i = 0; i < 4; i++) {
      convStore.recordTurn({
        sessionId: convSessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `in-flight turn ${i} content`,
      });
    }

    await waitFor(() => mockSummarize.mock.calls.length >= 1, 5000);
    // Several more ticks land while the first flush is still summarizing.
    await new Promise((r) => setTimeout(r, 400));
    expect(mockSummarize).toHaveBeenCalledTimes(1);

    const memStore = manager.getMemoryStore(agentName)!;
    release?.();
    await waitFor(() => memStore.findByTag("mid-session").length >= 1, 5000);
    await new Promise((r) => setTimeout(r, 300));
    expect(memStore.findByTag("mid-session")).toHaveLength(1);
    expect(mockSummarize).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("does not start a flush timer when flushIntervalMinutes is 0 and override is not set", async () => {
    const localAdapter = createMockAdapter();
    const localDir = await mkdtemp(join(tmpdir(), "sm-flush-off-"));
    const localRegistry = join(localDir, "registry.json");
    // No flushIntervalMsOverride → agent config's 0 wins → timer disabled.
    const localManager = new SessionManager({
      adapter: localAdapter,
      registryPath: localRegistry,
      backoffConfig: TEST_BACKOFF,
      summarizeFn: mockSummarize as unknown as SummarizeFn,
    });

    const agentName = "flush-disabled";
    const base = makeConfig(agentName);
    const config: ResolvedAgentConfig = {
      ...base,
      workspace: localDir,
      memoryPath: localDir,
      memory: {
        ...base.memory,
        conversation: {
          enabled: true,
          turnRetentionDays: 90,
          resumeSessionCount: 3,
          resumeGapThresholdHours: 4,
          conversationContextBudget: 2000,
          retrievalHalfLifeDays: 14,
          flushIntervalMinutes: 0,
        },
      },
    } as ResolvedAgentConfig;

    await localManager.startAgent(agentName, config);

    // Wait 300ms — if a timer were erroneously registered at 100ms cadence
    // we would see an insert by now.
    await new Promise((r) => setTimeout(r, 300));

    const memStore = localManager.getMemoryStore(agentName)!;
    const spy = vi.spyOn(memStore, "insert");
    await new Promise((r) => setTimeout(r, 150));

    const midSessionCalls = spy.mock.calls.filter((call) =>
      (call[0] as { tags?: readonly string[] }).tags?.includes("mid-session"),
    );
    expect(midSessionCalls).toHaveLength(0);

    try { await localManager.stopAll(); } catch { /* cleanup */ }
    await new Promise((r) => setTimeout(r, 50));
    await rm(localDir, { recursive: true, force: true });
  }, 15_000);

  it("stopAgent clears the flush timer so no post-stop mid-session writes land", async () => {
    const agentName = "flush-stop";
    const config = makeFlushConfig(agentName, 15);
    await manager.startAgent(agentName, config);

    const memStore = manager.getMemoryStore(agentName)!;
    const insertSpy = vi.spyOn(memStore, "insert");

    await manager.stopAgent(agentName);

    const callCountAfterStop = insertSpy.mock.calls.filter((call) =>
      (call[0] as { tags?: readonly string[] }).tags?.includes("mid-session"),
    ).length;

    // Wait 300ms (~3 flush intervals at 100ms) — no additional mid-session
    // inserts should appear because stopAgent cleared the interval.
    await new Promise((r) => setTimeout(r, 300));

    const callCountLater = insertSpy.mock.calls.filter((call) =>
      (call[0] as { tags?: readonly string[] }).tags?.includes("mid-session"),
    ).length;

    expect(callCountLater).toBe(callCountAfterStop);
  }, 15_000);

  it("resets the flush sequence counter after stopAgent so restart begins at flush:1", async () => {
    const agentName = "flush-counter-reset";
    const config = makeFlushConfig(agentName, 15);

    await manager.startAgent(agentName, config);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const counters = (manager as any).flushSequenceByAgent as Map<string, number>;
    expect(counters.get(agentName)).toBe(0);

    await manager.stopAgent(agentName);
    expect(counters.get(agentName)).toBeUndefined();

    await manager.startAgent(agentName, config);
    expect(counters.get(agentName)).toBe(0);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Phase 67 Plan 03 — configDeps wiring gap-closure
// ---------------------------------------------------------------------------

// Wrap buildSessionConfig with a vi.fn that forwards to the actual impl so
// every pre-existing test keeps its real behavior (systemPrompt, hotStableToken,
// etc.). The new test below inspects mock.calls to prove that configDeps() now
// threads conversationStores + memoryStores through to the build call.
vi.mock("../session-config.js", async () => {
  const actual = await vi.importActual<typeof import("../session-config.js")>(
    "../session-config.js",
  );
  return {
    ...actual,
    buildSessionConfig: vi.fn(actual.buildSessionConfig),
  };
});

import { buildSessionConfig as _buildSessionConfigForMock } from "../session-config.js";
const mockedBuildSessionConfig = vi.mocked(_buildSessionConfigForMock);

describe("configDeps wiring — Phase 67 gap-closure", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    vi.useRealTimers();
    // Keep the forwarding impl; only clear call history so this test's
    // assertions are isolated from prior suites' startAgent invocations.
    mockedBuildSessionConfig.mockClear();
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "sm-p67-03-"));
    registryPath = join(tmpDir, "registry.json");
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
    });
  });

  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 50));
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* non-fatal — DB handles may linger briefly */
    }
  });

  it("configDeps passes conversationStores and memoryStores", async () => {
    const agentName = "agent-wire-test";
    // Per-agent workspace so AgentMemoryManager.initMemory creates a real
    // memories.db and ConversationStore for this agent.
    const config: ResolvedAgentConfig = {
      ...makeConfig(agentName),
      workspace: tmpDir,
      memoryPath: tmpDir,
    };

    await manager.startAgent(agentName, config);

    // Exactly one buildSessionConfig call for this agent start.
    expect(mockedBuildSessionConfig).toHaveBeenCalledTimes(1);
    const [, deps] = mockedBuildSessionConfig.mock.calls[0]!;

    // 1+2: Both Maps are present and are actual Map instances.
    expect(deps.conversationStores).toBeInstanceOf(Map);
    expect(deps.memoryStores).toBeInstanceOf(Map);

    // 3+4: Reference-equality against the SessionManager's AgentMemoryManager
    // — proves configDeps passes the reference, not a copy/wrap.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const memoryMgr = (manager as any).memory as {
      conversationStores: Map<string, unknown>;
      memoryStores: Map<string, unknown>;
    };
    expect(deps.conversationStores).toBe(memoryMgr.conversationStores);
    expect(deps.memoryStores).toBe(memoryMgr.memoryStores);

    // 5+6: Populated stores — startAgent initializes both for this agent.
    expect(deps.conversationStores!.get(agentName)).toBeTruthy();
    expect(deps.memoryStores!.get(agentName)).toBeTruthy();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Phase 73 Plan 02 — brief cache invalidation on stop + crash (LAT-02)
// ---------------------------------------------------------------------------

import { ConversationBriefCache } from "../conversation-brief-cache.js";

describe("brief cache invalidation", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useRealTimers();
    mockedBuildSessionConfig.mockClear();
    // Spy on the prototype so every ConversationBriefCache instance (including
    // the one SessionManager owns privately) reports calls through this mock.
    invalidateSpy = vi.spyOn(ConversationBriefCache.prototype, "invalidate");
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "sm-p73-brief-"));
    registryPath = join(tmpDir, "registry.json");
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
    });
  });

  afterEach(async () => {
    invalidateSpy.mockRestore();
    try {
      await manager.stopAll();
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 50));
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  });

  it("stopAgent invalidates brief cache entry", async () => {
    const agentName = "agent-cache-stop";
    const config: ResolvedAgentConfig = {
      ...makeConfig(agentName),
      workspace: tmpDir,
      memoryPath: tmpDir,
    };

    await manager.startAgent(agentName, config);
    invalidateSpy.mockClear(); // ignore any warm-path invalidations

    await manager.stopAgent(agentName);

    // stopAgent MUST have invalidated the cache for this agent name.
    const calls = invalidateSpy.mock.calls as Array<[string]>;
    expect(calls.some((c) => c[0] === agentName)).toBe(true);
  }, 30_000);

  it("crash invalidates brief cache entry", async () => {
    const agentName = "agent-cache-crash";
    const config: ResolvedAgentConfig = {
      ...makeConfig(agentName),
      workspace: tmpDir,
      memoryPath: tmpDir,
    };

    await manager.startAgent(agentName, config);
    // MockSessionAdapter.sessions is keyed by sessionId (mock-<agent>-<n>),
    // not by agent name. Grab the handle whichever mock ID it was given.
    const handle = [...adapter.sessions.values()].find(
      (h) => h !== undefined,
    );
    expect(handle).toBeDefined();

    invalidateSpy.mockClear();

    handle!.simulateCrash(new Error("boom"));
    // simulateCrash fires the onError handler synchronously; recovery
    // scheduling is async but the invalidate fires BEFORE handleCrash.

    const calls = invalidateSpy.mock.calls as Array<[string]>;
    expect(calls.some((c) => c[0] === agentName)).toBe(true);
  }, 30_000);

  it("invalidateBriefCache(agent) is the public API and fires invalidate", async () => {
    const agentName = "agent-cache-public";
    const config: ResolvedAgentConfig = {
      ...makeConfig(agentName),
      workspace: tmpDir,
      memoryPath: tmpDir,
    };

    await manager.startAgent(agentName, config);
    invalidateSpy.mockClear();

    // Smoke: public method exists and delegates to the private cache.
    expect(() => manager.invalidateBriefCache(agentName)).not.toThrow();

    const calls = invalidateSpy.mock.calls as Array<[string]>;
    expect(calls.some((c) => c[0] === agentName)).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Quick task 260419-nic — SessionManager.interruptAgent primitive
// ---------------------------------------------------------------------------

describe("interruptAgent", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;
  let infoLogs: Array<{ obj: unknown; msg: string }>;
  let warnLogs: Array<{ obj: unknown; msg: string }>;
  let testLogger: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: () => void;
    debug: () => void;
    child: () => unknown;
  };

  beforeEach(async () => {
    vi.useRealTimers();
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "sm-interrupt-"));
    registryPath = join(tmpDir, "registry.json");
    infoLogs = [];
    warnLogs = [];
    testLogger = {
      info: (obj, msg) => infoLogs.push({ obj, msg: msg ?? "" }),
      warn: (obj, msg) => warnLogs.push({ obj, msg: msg ?? "" }),
      error: () => undefined,
      debug: () => undefined,
      child: () => testLogger,
    };
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      log: testLogger as any,
    });
  });

  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {
      /* ignore */
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("Test 1: unknown agent → returns {interrupted:false, hadActiveTurn:false}, no throw", async () => {
    const sessionsBefore = adapter.sessions.size;
    const result = await manager.interruptAgent("nonexistent-agent");
    expect(result).toEqual({ interrupted: false, hadActiveTurn: false });
    expect(adapter.sessions.size).toBe(sessionsBefore);
  });

  it("Test 2: agent running but no active turn → {interrupted:false, hadActiveTurn:false}", async () => {
    const config = makeConfig("idle-agent");
    await manager.startAgent("idle-agent", config);
    const handle = [...adapter.sessions.values()][0] as MockSessionHandle;
    expect(handle.hasActiveTurn()).toBe(false);

    const result = await manager.interruptAgent("idle-agent");
    expect(result).toEqual({ interrupted: false, hadActiveTurn: false });
  });

  it("Test 3: agent with active turn → calls handle.interrupt(), returns {interrupted:true, hadActiveTurn:true}, logs info event:'agent_interrupted'", async () => {
    const config = makeConfig("active-agent");
    await manager.startAgent("active-agent", config);
    const handle = [...adapter.sessions.values()][0] as MockSessionHandle;

    // Flip activeTurn flag so interruptAgent takes the positive path.
    handle.__testSetActiveTurn(true);
    const interruptSpy = vi.spyOn(handle, "interrupt");

    const result = await manager.interruptAgent("active-agent");
    expect(result).toEqual({ interrupted: true, hadActiveTurn: true });
    expect(interruptSpy).toHaveBeenCalledTimes(1);

    const infoMsg = infoLogs.find(
      (l) => (l.obj as { event?: string }).event === "agent_interrupted",
    );
    expect(infoMsg).toBeDefined();
    expect((infoMsg!.obj as { agent: string }).agent).toBe("active-agent");
  });

  it("Test 4: handle.interrupt() throws → re-throws and log.warn captures the failure", async () => {
    const config = makeConfig("boom-agent");
    await manager.startAgent("boom-agent", config);
    const handle = [...adapter.sessions.values()][0] as MockSessionHandle;
    handle.__testSetActiveTurn(true);
    handle.interrupt = () => {
      throw new Error("interrupt boom");
    };

    await expect(manager.interruptAgent("boom-agent")).rejects.toThrow(
      /interrupt boom/,
    );

    const warnMsg = warnLogs.find(
      (l) => (l.obj as { error?: string }).error === "interrupt boom",
    );
    expect(warnMsg).toBeDefined();
    expect((warnMsg!.obj as { agent: string }).agent).toBe("boom-agent");
  });

  // Phase 141 (#13) — NOTE: the v3 interrupt branch (interruptAgent →
  // debugWriteToPtyForAgent(name, "\x03") for claude-code-interactive agents) is
  // NOT unit-tested here. SessionManager.startAgent's v3 path needs real channel
  // wiring and HANGS under the mock-adapter harness, so the v2-oriented fixtures
  // above can't register a v3 session cleanly. The wiring is typecheck-pinned and
  // mechanical; its efficacy (does \x03 abort a `claude --channels` turn?) is a
  // live canary regardless. A dedicated v3 harness that injects a session without
  // startAgent's v3 path is the follow-up. See 141-HANDOFF.
});

// ---------------------------------------------------------------------------
// Phase 89 Plan 02 — restartAgent greeting emission integration tests
// ---------------------------------------------------------------------------
//
// Pins the D-01 contract (GREET-01) at SessionManager integration level:
// restartAgent emits exactly one greeting; startAgent / startAll /
// performRestart (crash-recovery) / IPC fallback emit zero. Pins D-16
// (GREET-09): fire-and-forget — restart succeeds even when webhook rejects.
// Pins D-14 (GREET-10): cool-down Map cleared on stopAgent + each successful
// restart produces a fresh messageId.
//
// Fixtures:
//   - A tmpdir-backed workspace so AgentMemoryManager.initMemory creates a
//     real ConversationStore per agent.
//   - `ConversationStore.prototype.listRecentTerminatedSessions` +
//     `getTurnsForSession` are spied-on at the PROTOTYPE level (mirroring the
//     Phase 73 `ConversationBriefCache.prototype.invalidate` pattern in this
//     file). The spies return canned data, so the greeting helper sees
//     deterministic history regardless of the stop-path session-summarizer's
//     turn pruning (Gap 2, session-summarizer.ts:365). Prototype-scope keeps
//     the production ConversationStore created by startAgent fully functional
//     (stop-path summarization still runs) while isolating the greeting test
//     from the pruning side-effect.
//   - A stub WebhookManager with `sendAsAgent` spy + `hasWebhook` returning
//     true. The `sendAsAgent` implementation resolves with a predictable
//     messageId and records every call for assertion.
//   - An injected summarizeFn that returns a fixed non-empty summary string
//     — bypasses the real SDK / Haiku call for determinism.
// ---------------------------------------------------------------------------
import type { WebhookManager } from "../../discord/webhook-manager.js";
import type { ConversationSession, ConversationTurn } from "../../memory/conversation-types.js";
import { ConversationStore } from "../../memory/conversation-store.js";

describe("restartAgent greeting emission (Phase 89)", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;
  let sendAsAgentSpy: ReturnType<typeof vi.fn>;
  let hasWebhookSpy: ReturnType<typeof vi.fn>;
  let stubWebhook: { sendAsAgent: ReturnType<typeof vi.fn>; hasWebhook: ReturnType<typeof vi.fn> };
  let warnLogs: Array<{ obj: unknown; msg: string }>;
  let infoLogs: Array<{ obj: unknown; msg: string }>;
  let testLogger: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: () => void;
    debug: () => void;
    child: () => unknown;
  };
  let summarizeFn: ReturnType<typeof vi.fn>;

  // Helper — build a config with greetOnRestart true + a webhook identity +
  // a workspace under tmpDir so the ConversationStore is real.
  function makeGreetableConfig(
    name: string,
    overrides?: Partial<ResolvedAgentConfig>,
  ): ResolvedAgentConfig {
    return {
      ...makeConfig(name),
      workspace: tmpDir,
      memoryPath: tmpDir,
      webhook: { displayName: "Clawdy", avatarUrl: "https://av/clawdy.png" },
      greetOnRestart: true,
      greetCoolDownMs: 300_000,
      memoryAutoLoad: true, // Phase 90 MEM-01
      memoryRetrievalTopK: 5, // Phase 90 MEM-03
      memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"], // Phase 100 GSD-02
    autoStart: true, // Phase 100 follow-up
      ...overrides,
    };
  }

  // Helper — arm prototype-level spies so the greeting helper sees canned
  // history regardless of the stop-path session-summarizer's turn pruning.
  // Returns both spies so individual tests can customize canned data or
  // override implementation (e.g. return [] to force skipped-empty-state).
  //
  // Pattern lifted from the Phase 73 `brief cache invalidation` suite above
  // (vi.spyOn(ConversationBriefCache.prototype, "invalidate")). Scope is
  // cleared by vi's spy auto-restore in afterEach via vi.restoreAllMocks().
  function armConvStoreSpies(
    agentName: string,
    opts?: {
      terminatedSessions?: readonly ConversationSession[];
      turns?: readonly ConversationTurn[];
    },
  ): {
    listSpy: ReturnType<typeof vi.spyOn>;
    turnsSpy: ReturnType<typeof vi.spyOn>;
  } {
    const now = new Date().toISOString();
    const sessionId = "stub-sess-1";
    const sessions: readonly ConversationSession[] = opts?.terminatedSessions ?? [
      Object.freeze({
        id: sessionId,
        agentName,
        startedAt: now,
        endedAt: now,
        turnCount: 2,
        totalTokens: 0,
        summaryMemoryId: null,
        status: "ended" as const,
      }),
    ];
    const turns: readonly ConversationTurn[] = opts?.turns ?? [
      Object.freeze({
        id: "t1",
        sessionId,
        turnIndex: 0,
        role: "user" as const,
        content: "What's the status of the migration plan?",
        tokenCount: null,
        channelId: null,
        discordUserId: null,
        discordMessageId: null,
        isTrustedChannel: false,
        origin: null,
        instructionFlags: null,
        createdAt: now,
      }),
      Object.freeze({
        id: "t2",
        sessionId,
        turnIndex: 1,
        role: "assistant" as const,
        content: "Working on it — v2.1 fleet migrated, 15 agents online.",
        tokenCount: null,
        channelId: null,
        discordUserId: null,
        discordMessageId: null,
        isTrustedChannel: false,
        origin: null,
        instructionFlags: null,
        createdAt: now,
      }),
    ];
    const listSpy = vi
      .spyOn(ConversationStore.prototype, "listRecentTerminatedSessions")
      .mockReturnValue(sessions as readonly ConversationSession[]);
    const turnsSpy = vi
      .spyOn(ConversationStore.prototype, "getTurnsForSession")
      .mockReturnValue(turns as readonly ConversationTurn[]);
    return { listSpy, turnsSpy };
  }

  // Drain microtasks so the fire-and-forget greeting chain runs before
  // assertions execute.
  async function drainMicrotasks(): Promise<void> {
    await new Promise((r) => setImmediate(r));
    await Promise.resolve();
    await Promise.resolve();
  }

  beforeEach(async () => {
    vi.useRealTimers();
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "sm-greet-"));
    registryPath = join(tmpDir, "registry.json");
    infoLogs = [];
    warnLogs = [];
    testLogger = {
      info: (obj, msg) => infoLogs.push({ obj, msg: msg ?? "" }),
      warn: (obj, msg) => warnLogs.push({ obj, msg: msg ?? "" }),
      error: () => undefined,
      debug: () => undefined,
      child: () => testLogger,
    };

    // Stub WebhookManager with spies. sendAsAgent returns predictable,
    // monotonic message IDs so tests can assert fresh-per-restart semantics.
    let callIdx = 0;
    sendAsAgentSpy = vi.fn(async () => {
      const id = `msg-${callIdx + 1}`;
      callIdx += 1;
      return id;
    });
    hasWebhookSpy = vi.fn(() => true);
    stubWebhook = { sendAsAgent: sendAsAgentSpy, hasWebhook: hasWebhookSpy };

    summarizeFn = vi.fn().mockResolvedValue(
      "I was working on the v2.1 migration plan — 15 agents online and the greeting helper just landed.",
    );

    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      log: testLogger as any,
      summarizeFn: summarizeFn as never,
    });
  });

  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {
      /* ignore */
    }
    vi.restoreAllMocks(); // tear down prototype spies from armConvStoreSpies
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("I1 (happy path): restartAgent emits exactly one greeting via sendAsAgent", async () => {
    const name = "clawdy";
    const config = makeGreetableConfig(name);
    manager.setWebhookManager(stubWebhook as unknown as WebhookManager);
    armConvStoreSpies(name);

    await manager.startAgent(name, config);
    await manager.restartAgent(name, config);
    // Greeting chain has 2 awaits before sendAsAgent (summarize, then
    // sendAsAgent). Drain several microtask rounds to let the chain settle.
    for (let i = 0; i < 10; i++) {
      await drainMicrotasks();
    }

    expect(sendAsAgentSpy).toHaveBeenCalledTimes(1);
    const [targetAgent, displayName, avatarUrl, embed] =
      sendAsAgentSpy.mock.calls[0]!;
    expect(targetAgent).toBe(name);
    expect(displayName).toBe("Clawdy");
    expect(avatarUrl).toBe("https://av/clawdy.png");
    // EmbedBuilder carries our summary in .data.description
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((embed as any).data.description).toContain("migration plan");
    // Summarize was invoked exactly once (happy path hits Haiku).
    expect(summarizeFn).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("I2 (startAgent path): startAgent on a fresh agent emits zero greetings", async () => {
    const name = "clawdy-fresh";
    const config = makeGreetableConfig(name);
    manager.setWebhookManager(stubWebhook as unknown as WebhookManager);

    await manager.startAgent(name, config);
    await drainMicrotasks();

    expect(sendAsAgentSpy).toHaveBeenCalledTimes(0);
  }, 15_000);

  it("I3 (startAll path): startAll emits zero greetings across all agents", async () => {
    const configs = [
      makeGreetableConfig("a1"),
      makeGreetableConfig("a2"),
      makeGreetableConfig("a3"),
    ];
    manager.setWebhookManager(stubWebhook as unknown as WebhookManager);

    await manager.startAll(configs);
    await drainMicrotasks();

    expect(sendAsAgentSpy).toHaveBeenCalledTimes(0);
  }, 15_000);

  it("I4 (crash-restart path / performRestart): crash + auto-restart emits zero greetings", async () => {
    const name = "clawdy-crash";
    const config = makeGreetableConfig(name);
    manager.setWebhookManager(stubWebhook as unknown as WebhookManager);
    armConvStoreSpies(name); // even with history present, crash path must NOT greet

    await manager.startAgent(name, config);

    // Simulate a crash — SessionRecoveryManager will invoke performRestart,
    // which calls startAgent (NOT restartAgent), so the greeting hook is
    // bypassed by construction (D-01 literal reading, RESEARCH Finding 1).
    const handle = [...adapter.sessions.values()][0] as MockSessionHandle;
    handle.simulateCrash(new Error("boom"));

    await manager._lastCrashPromise;
    // Give the backoff timer room to fire the restart and for startAgent to
    // complete before we drain microtasks. TEST_BACKOFF.maxMs = 1000ms.
    await new Promise((r) => setTimeout(r, TEST_BACKOFF.maxMs + 200));
    await manager._lastRestartPromise;
    await drainMicrotasks();

    expect(sendAsAgentSpy).toHaveBeenCalledTimes(0);
  }, 15_000);

  it("I5 (fire-and-forget): restartAgent resolves successfully when sendAsAgent rejects, log.warn captures it", async () => {
    const name = "clawdy-webhook-fail";
    const config = makeGreetableConfig(name);
    sendAsAgentSpy.mockRejectedValueOnce(new Error("webhook 401"));
    manager.setWebhookManager(stubWebhook as unknown as WebhookManager);
    armConvStoreSpies(name);

    await manager.startAgent(name, config);

    // The critical assertion: even though sendAsAgent rejects, restartAgent
    // MUST resolve normally (D-16 — restart success is independent of Discord).
    // Note: sendRestartGreeting catches the sendAsAgent reject internally and
    // returns { kind: "send-failed" }, so the outer .catch in SessionManager
    // does NOT trigger — restart-greeting is robust to webhook rejection.
    // This test still pins the invariant: restart does NOT throw.
    await expect(manager.restartAgent(name, config)).resolves.toBeUndefined();
    await drainMicrotasks();

    // Agent is still running post-restart (core D-16 guarantee).
    const registry = await readRegistry(registryPath);
    const entry = registry.entries.find((e) => e.name === name);
    expect(entry!.status).toBe("running");
  }, 15_000);

  it("I5b (fire-and-forget) restartAgent survives a thrown greeting via outer .catch log-and-swallow", async () => {
    // Second fire-and-forget test: the helper itself rejects (not just
    // sendAsAgent). Exercises the OUTER `.catch` on the `void
    // sendRestartGreeting(...).catch(...)` in SessionManager.restartAgent.
    //
    // We force an outright throw by passing a summarizeFn that throws
    // synchronously via the underlying promise — but sendRestartGreeting
    // catches that too. So instead we corrupt the conversationStore surface
    // to force the helper to throw synchronously on access.
    const name = "clawdy-helper-throw";
    const config = makeGreetableConfig(name);

    // Route the inner call to a webhook whose hasWebhook throws — this is
    // called directly inside sendRestartGreeting before any try/catch, so
    // it propagates OUT of the helper and hits our outer `.catch`.
    const throwingWebhook = {
      sendAsAgent: vi.fn(),
      hasWebhook: vi.fn(() => {
        throw new Error("synthetic-helper-throw");
      }),
    };
    manager.setWebhookManager(throwingWebhook as unknown as WebhookManager);
    armConvStoreSpies(name);

    await manager.startAgent(name, config);

    await expect(manager.restartAgent(name, config)).resolves.toBeUndefined();
    await drainMicrotasks();

    // Our outer `.catch` must have logged with the verbatim prefix.
    const greetingWarn = warnLogs.find((l) =>
      l.msg.includes("[greeting] sendRestartGreeting threw"),
    );
    expect(greetingWarn).toBeDefined();
    expect((greetingWarn!.obj as { agent: string }).agent).toBe(name);
    expect((greetingWarn!.obj as { error: string }).error).toBe(
      "synthetic-helper-throw",
    );
  }, 15_000);

  it("I6 (cool-down cleared on stopAgent): successful greeting populates map, stopAgent deletes the entry", async () => {
    const name = "clawdy-cool-down";
    const config = makeGreetableConfig(name);
    manager.setWebhookManager(stubWebhook as unknown as WebhookManager);
    armConvStoreSpies(name);

    await manager.startAgent(name, config);
    await manager.restartAgent(name, config);
    for (let i = 0; i < 10; i++) {
      await drainMicrotasks();
    }

    // After a successful send, the cool-down map must carry this agent.
    expect(sendAsAgentSpy).toHaveBeenCalledTimes(1);
    expect(manager._greetCoolDownByAgent.has(name)).toBe(true);

    // stopAgent MUST drop the entry (D-14 — operator stop + restart is a
    // clean restart by intent, not a crash loop).
    await manager.stopAgent(name);
    expect(manager._greetCoolDownByAgent.has(name)).toBe(false);
  }, 15_000);

  it("I7-alt (GREET-10 new message per restart): two restarts separated by cool-down bypass produce two distinct message IDs", async () => {
    const name = "clawdy-two-restarts";
    // Tiny cool-down so the second restart bypasses it. Real timers are
    // already in use for this suite so a short sleep clears the window.
    const config = makeGreetableConfig(name, { greetCoolDownMs: 1 });
    manager.setWebhookManager(stubWebhook as unknown as WebhookManager);
    armConvStoreSpies(name);

    await manager.startAgent(name, config);

    await manager.restartAgent(name, config);
    for (let i = 0; i < 10; i++) {
      await drainMicrotasks();
    }

    await new Promise((r) => setTimeout(r, 5)); // bypass the 1-ms cool-down
    await manager.restartAgent(name, config);
    for (let i = 0; i < 10; i++) {
      await drainMicrotasks();
    }

    expect(sendAsAgentSpy).toHaveBeenCalledTimes(2);
    const firstId = await sendAsAgentSpy.mock.results[0]!.value;
    const secondId = await sendAsAgentSpy.mock.results[1]!.value;
    expect(firstId).not.toBe(secondId); // GREET-10 / D-15 — fresh messageId
  }, 15_000);

  it("I8 (IPC fallback): startAgent when agent is not running (mirrors daemon.ts 'restart' case fallback) emits zero greetings", async () => {
    // The daemon.ts IPC 'restart' handler calls `manager.restartAgent(name,
    // config)` first; when that throws with /not running|no such session/,
    // the handler falls back to `manager.startAgent(name, config)`. This
    // test directly exercises the fallback leg (startAgent on a not-running
    // agent) and pins D-01 literal reading: only restartAgent greets.
    const name = "clawdy-ipc-fallback";
    const config = makeGreetableConfig(name);
    manager.setWebhookManager(stubWebhook as unknown as WebhookManager);

    // Mirror the fallback path: agent was not running, so the daemon falls
    // through to startAgent. (restartAgent would throw from its inner
    // stopAgent when the agent isn't running — which is exactly the
    // /not running/ regex the daemon catches.)
    await manager.startAgent(name, config);
    await drainMicrotasks();

    expect(sendAsAgentSpy).toHaveBeenCalledTimes(0);
  }, 15_000);
});

// Phase 90 MEM-02 / MEM-03 — setMemoryScanner DI + getMemoryRetrieverForAgent
describe("SessionManager — memory scanner + retriever DI (Phase 90 MEM-02/MEM-03)", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    vi.useRealTimers();
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "sm-mem-"));
    registryPath = join(tmpDir, "registry.json");
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
    });
  });

  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {
      /* cleanup */
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("MEM-03-SM1: setMemoryScanner stores the reference, accessible via internal view", () => {
    const stopSpy = vi.fn(async () => {});
    const startSpy = vi.fn(async () => {});
    const stub = {
      start: startSpy,
      stop: stopSpy,
      backfill: vi.fn(async () => ({ indexed: 0, chunks: 0, skipped: 0 })),
    };
    manager.setMemoryScanner("alice", stub as never);
    expect(manager._memoryScanners.get("alice")).toBe(stub);
  });

  it("MEM-03-SM2: stopAgent calls scanner.stop() and drops the reference", async () => {
    const config = makeConfig("alice-mem");
    const stopSpy = vi.fn(async () => {});
    const stub = {
      start: vi.fn(async () => {}),
      stop: stopSpy,
      backfill: vi.fn(async () => ({ indexed: 0, chunks: 0, skipped: 0 })),
    };
    await manager.startAgent("alice-mem", config);
    manager.setMemoryScanner("alice-mem", stub as never);
    await manager.stopAgent("alice-mem");
    // stop is fire-and-forget — give the microtask queue a beat
    await new Promise((r) => setImmediate(r));
    expect(stopSpy).toHaveBeenCalled();
    expect(manager._memoryScanners.get("alice-mem")).toBeUndefined();
  });

  it("MEM-03-SM3: getMemoryRetrieverForAgent returns undefined when no MemoryStore", () => {
    // Agent never started → no MemoryStore → retriever is undefined
    const retriever = manager.getMemoryRetrieverForAgent("ghost-agent");
    expect(retriever).toBeUndefined();
  });

  it("MEM-03-SM4: getMemoryRetrieverForAgent returns a function when agent running", async () => {
    const config = makeConfig("bob-mem");
    await manager.startAgent("bob-mem", config);
    const retriever = manager.getMemoryRetrieverForAgent("bob-mem");
    expect(retriever).toBeDefined();
    expect(typeof retriever).toBe("function");
    // Empty store → zero results, no throw
    const results = await retriever!("anything");
    expect(results).toEqual([]);
  });
});

// Phase 90 MEM-04 — MemoryFlushTimer wiring at the SessionManager layer.
describe("SessionManager — memory-file flush timer (Phase 90 MEM-04)", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    vi.useRealTimers();
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "sm-memflush-"));
    registryPath = join(tmpDir, "registry.json");
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
    });
  });

  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {
      /* cleanup */
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("MEM-04-SM2: startAgent constructs a MemoryFlushTimer entry in the per-agent map", async () => {
    const config = {
      ...makeConfig("mf-start"),
      workspace: tmpDir,
      memoryPath: tmpDir,
      // very long interval so the timer never fires during the test; we
      // only assert construction here, not behavior.
      memoryFlushIntervalMs: 60 * 60 * 1000,
    };
    await manager.startAgent("mf-start", config);
    // _memoryFileFlushTimers is a readonly view exposed for integration
    // tests (mirrors _memoryScanners / _greetCoolDownByAgent)
    const timers = (manager as unknown as {
      _memoryFileFlushTimers: ReadonlyMap<string, unknown>;
    })._memoryFileFlushTimers;
    expect(timers.has("mf-start")).toBe(true);
  });

  it("MEM-04-SM1: stopAgent awaits final flush then removes the timer entry", async () => {
    const config = {
      ...makeConfig("mf-stop"),
      workspace: tmpDir,
      memoryPath: tmpDir,
      memoryFlushIntervalMs: 60 * 60 * 1000,
    };
    await manager.startAgent("mf-stop", config);
    await manager.stopAgent("mf-stop");
    const timers = (manager as unknown as {
      _memoryFileFlushTimers: ReadonlyMap<string, unknown>;
    })._memoryFileFlushTimers;
    expect(timers.has("mf-stop")).toBe(false);
  });
});

/* =========================================================================
 *  Phase 999.15 polled discovery (TRACK-02 + TRACK-08 #1).
 *
 *  All cases below FAIL at Wave 0 because:
 *    - The current MCP discovery block in session-manager.ts:721-766 is the
 *      fire-and-forget "1s settle + single attempt" form. Plan 02 replaces
 *      it with a polled wait (6 attempts × 5s, minAge=5s).
 *    - tracker.register signature changes to (name, claudePid, mcpPids).
 *    - SessionManager constructor learns about an mcpTracker test injection.
 *
 *  Tests rely on vi.useFakeTimers (already enabled in beforeEach above).
 *  No 999.14 cases above are modified — strict append.
 * =======================================================================*/

import { McpProcessTracker } from "../../mcp/process-tracker.js";

describe("Phase 999.15 polled discovery (TRACK-02)", () => {
  let adapter2: MockSessionAdapter;
  let tmpDir2: string;
  let registryPath2: string;
  let mgr: SessionManager;
  let trackerRegisterSpy: ReturnType<typeof vi.fn>;

  // Mock proc-scan so polled-discovery sees scripted PIDs across attempts.
  beforeEach(async () => {
    vi.useFakeTimers();
    adapter2 = createMockAdapter();
    tmpDir2 = await mkdtemp(join(tmpdir(), "sm-test-pd-"));
    registryPath2 = join(tmpDir2, "registry.json");

    // Build a tracker fake (we don't need real /proc walking; we pin call shape).
    trackerRegisterSpy = vi.fn(async () => {});
    const trackerFake = {
      patterns: /mcp-server/,
      register: trackerRegisterSpy,
      killAgentGroup: vi.fn(async () => {}),
      killAll: vi.fn(async () => {}),
      list: vi.fn(() => []),
      listForAgent: vi.fn(() => []),
      unregister: vi.fn(() => []),
    } as unknown as McpProcessTracker;

    mgr = new SessionManager({
      adapter: adapter2,
      registryPath: registryPath2,
      backoffConfig: TEST_BACKOFF,
      mcpTracker: trackerFake,
    });
  });

  afterEach(async () => {
    try {
      await mgr.stopAll();
    } catch {
      /* tests may not have started agents */
    }
    await rm(tmpDir2, { recursive: true, force: true });
    vi.useRealTimers();
    // Tear down per-test vi.spyOn installations on shared procScan module so
    // SM-{1..4} cases don't leak call history into one another (Wave 0 plumbing
    // gap — fixed at Plan 02 GREEN per Rule 1: broken test mock state).
    vi.restoreAllMocks();
  });

  it("SM-1 (T-04): sink-based discovery registers tracker once sink populates", async () => {
    // FIND-123-A.next T-04 — the /proc-walk has been replaced by reading
    // handle.getClaudePid() from the per-agent sink populated by
    // makeDetachedSpawn. The mock simulates the SDK callback by flipping
    // claudePidValue mid-poll via __testSetClaudePid.
    const procScan = await import("../../mcp/proc-scan.js");
    vi.spyOn(procScan, "discoverAgentMcpPids").mockResolvedValue([201, 202]);

    const config = { ...makeConfig("agent-poll"), workspace: tmpDir2, memoryPath: tmpDir2 };
    await mgr.startAgent("agent-poll", config);

    // Sink stays null for the first 2 polling slices (SDK hasn't emitted
    // a spawn callback yet); flip on the 3rd slice to a stable PID.
    const handle = mgr.getSessionHandle("agent-poll") as unknown as {
      __testSetClaudePid: (pid: number | null) => void;
    };
    await vi.advanceTimersByTimeAsync(5_000); // attempt 1 — null
    await vi.advanceTimersByTimeAsync(5_000); // attempt 2 — null
    handle.__testSetClaudePid(200);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await vi.runOnlyPendingTimersAsync();

    // tracker.register MUST be called once with the 3-arg signature
    // (name, claudePid, mcpPids); claudePid sourced from the sink.
    expect(trackerRegisterSpy).toHaveBeenCalledTimes(1);
    const args = trackerRegisterSpy.mock.calls[0]!;
    expect(args[0]).toBe("agent-poll");
    expect(args[1]).toBe(200);
    expect([...(args[2] as number[])].sort()).toEqual([201, 202]);
  });

  it("SM-2 (T-04): sink-based discovery aborts when agent is disposed mid-wait", async () => {
    const procScan = await import("../../mcp/proc-scan.js");
    vi.spyOn(procScan, "discoverAgentMcpPids").mockResolvedValue([201]);

    const config = { ...makeConfig("agent-dispose"), workspace: tmpDir2, memoryPath: tmpDir2 };
    await mgr.startAgent("agent-dispose", config);
    // Sink intentionally stays null — simulates an SDK spawn that is
    // slower than the operator stop. The polled loop iterates with no PID
    // until sessions.has(name) flips false on stopAgent, then exits.

    // First polling slice elapses with null sink (no register yet).
    await vi.advanceTimersByTimeAsync(5_000);
    expect(trackerRegisterSpy).not.toHaveBeenCalled();

    // Operator stop during the wait. AFTER stop, simulate the SDK finally
    // spawning — the loop's sessions.has check must short-circuit so the
    // PID never lands in the tracker for an already-stopped agent.
    await mgr.stopAgent("agent-dispose");
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await vi.runOnlyPendingTimersAsync();

    expect(trackerRegisterSpy).not.toHaveBeenCalled();
  });

  it("SM-3 (T-04): after 30s (6 attempts) with sink still null, exits without register", async () => {
    // FIND-123-A.next T-04 — sink never populated (SDK spawn failed or
    // delayed past the 30s budget) means the polled loop exits gracefully
    // and the periodic reaper takes over.
    const config = { ...makeConfig("agent-budget"), workspace: tmpDir2, memoryPath: tmpDir2 };
    await mgr.startAgent("agent-budget", config);
    // Do NOT call __testSetClaudePid — sink stays null for the full budget.

    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await vi.runOnlyPendingTimersAsync();

    // No register because no PID ever appeared in the sink.
    expect(trackerRegisterSpy).not.toHaveBeenCalled();
  });

  it("SM-4 (260714-mkq): reconcileRegistry BOOT-RESUME registers the resumed main's claudePid", async () => {
    // 2026-07-14 prod incident: the boot-resume path (reconcileRegistry) never
    // registered the resumed main with the McpProcessTracker, so
    // scanForOrphanClaudes saw every boot-resumed fleet main as untracked and
    // the orphan-claude reaper alerted the whole fleet each tick. This proves
    // the resume path now registers via the SAME sink-poll as the create path
    // (SM-1) — closing the gap reconcileAllAgents could never self-heal (it
    // only touches already-registered agents).
    const procScan = await import("../../mcp/proc-scan.js");
    vi.spyOn(procScan, "discoverAgentMcpPids").mockResolvedValue([301, 302]);

    const seededRegistry: Registry = {
      entries: [
        {
          name: "resume-poll",
          status: "running",
          sessionId: "resume-session-1",
          startedAt: Date.now() - 60_000,
          restartCount: 0,
          consecutiveFailures: 0,
          lastError: null,
          lastStableAt: null,
        },
      ],
      updatedAt: Date.now(),
    };
    await writeRegistry(registryPath2, seededRegistry);

    const config = {
      ...makeConfig("resume-poll"),
      workspace: tmpDir2,
      memoryPath: tmpDir2,
    };
    await mgr.reconcileRegistry([config]);

    // The resume path populated `sessions` with the resumed handle; flip its
    // sink as the SDK spawn callback would, then let the poll loop register.
    const handle = mgr.getSessionHandle("resume-poll") as unknown as {
      __testSetClaudePid: (pid: number | null) => void;
    };
    expect(handle).toBeTruthy();
    handle.__testSetClaudePid(300);
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await vi.runOnlyPendingTimersAsync();

    // Registered with the resumed pid — so the reaper's snapshot now contains
    // this live main and will NOT flag it as an orphan.
    expect(trackerRegisterSpy).toHaveBeenCalledTimes(1);
    const args = trackerRegisterSpy.mock.calls[0]!;
    expect(args[0]).toBe("resume-poll");
    expect(args[1]).toBe(300);
    expect([...(args[2] as number[])].sort()).toEqual([301, 302]);
  });
});

/**
 * Phase 138 Plan 01 T-04 — phase138-usage hook wiring (integration).
 *
 * The hook-logic unit tests live in
 * `src/usage/__tests__/provider-usage-hook.test.ts`. This block proves
 * the SEAM: that the hook is actually wired into the per-turn usage
 * callback SessionManager builds and hands to the adapter. Without this
 * test, "the hook fires on a real turn" rests on an unverified
 * transitive argument (silent-path-bifurcation risk class).
 *
 * Mechanism: MockSessionAdapter captures the `usageCallback` it
 * receives in `createSession` (keyed by sessionId in
 * `adapter.usageCallbacks`). We start an agent, retrieve that captured
 * callback, invoke it with synthetic turn-usage data, and assert (a)
 * the `phase138-usage` log line fired and (b) a `provider_usage` row
 * was written to the agent's shared usage.db.
 */
describe("SessionManager — phase138-usage hook wiring (Phase 138 T-04)", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;
  let logInfoSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "sm-p138-test-"));
    registryPath = join(tmpDir, "registry.json");
    logInfoSpy = vi.fn();
    const log = {
      info: logInfoSpy,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: () => log,
    };
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      log: log as any,
    });
  });

  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {
      /* ignore cleanup errors */
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("wires the phase138-usage hook into the per-turn usage callback (codex-cli → openai)", async () => {
    const config: ResolvedAgentConfig = {
      ...makeConfig("p138-agent"),
      workspace: tmpDir,
      memoryPath: tmpDir,
      llmRuntime: { backend: "codex-cli", failoverChain: [] },
    };
    await manager.startAgent("p138-agent", config);

    // The MockSessionAdapter captured the usageCallback SessionManager
    // built. Retrieve it and fire one synthetic turn-completion.
    const callbacks = Array.from(adapter.usageCallbacks.values());
    expect(callbacks.length).toBeGreaterThan(0);
    const usageCallback = callbacks[0]!;

    logInfoSpy.mockClear();
    usageCallback({
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
      cost_usd: 11.25,
      turns: 1,
      model: "gpt-5-codex",
      duration_ms: 1234,
    });

    // (a) the phase138-usage log line fired with the codex provider.
    const phase138Calls = logInfoSpy.mock.calls.filter(
      (c) => c[1] === "phase138-usage",
    );
    expect(phase138Calls.length).toBe(1);
    const payload = phase138Calls[0]![0] as Record<string, unknown>;
    expect(payload.agent).toBe("p138-agent");
    expect(payload.provider).toBe("openai");
    expect(payload.model).toBe("gpt-5-codex");
    expect(payload.turn_count).toBe(1);
    // gpt-5-codex 1M-in (1.25) + 1M-out (10.0) = 11.25
    expect(payload.cost_usd).toBeCloseTo(11.25, 6);
    // No secrets in the payload.
    expect(payload).not.toHaveProperty("apiKeyPath");
    expect(payload).not.toHaveProperty("OPENAI_API_KEY");

    // (b) a provider_usage row was written to the shared usage.db.
    const usageTracker = manager.getUsageTracker("p138-agent");
    expect(usageTracker).toBeDefined();
    const row = usageTracker!
      .getDatabase()
      .prepare(
        "SELECT provider, model, tokens_in, turn_count FROM provider_usage WHERE provider = 'openai'",
      )
      .get() as
      | { provider: string; model: string; tokens_in: number; turn_count: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.model).toBe("gpt-5-codex");
    expect(row!.tokens_in).toBe(1_000_000);
    expect(row!.turn_count).toBe(1);
  });

  it("attributes the anthropic backend to provider 'anthropic'", async () => {
    const config: ResolvedAgentConfig = {
      ...makeConfig("p138-anthropic"),
      workspace: tmpDir,
      memoryPath: tmpDir,
      llmRuntime: { backend: "anthropic-agent-sdk", failoverChain: [] },
    };
    await manager.startAgent("p138-anthropic", config);

    const usageCallback = Array.from(adapter.usageCallbacks.values())[0]!;
    logInfoSpy.mockClear();
    usageCallback({
      tokens_in: 100,
      tokens_out: 100,
      cost_usd: 0,
      turns: 1,
      model: "sonnet",
      duration_ms: 1,
    });

    const phase138Calls = logInfoSpy.mock.calls.filter(
      (c) => c[1] === "phase138-usage",
    );
    expect(phase138Calls.length).toBe(1);
    expect(
      (phase138Calls[0]![0] as Record<string, unknown>).provider,
    ).toBe("anthropic");
  });
});
