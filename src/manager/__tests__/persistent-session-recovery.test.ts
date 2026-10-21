import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Logger } from "pino";

/**
 * Phase 73 Plan 01 Task 3 — persistent session recovery integration test.
 *
 * Verifies the crash-recovery wiring path end-to-end:
 *   1. Acquire a SessionHandle from MockSessionAdapter.createSession.
 *   2. Register handle.onError → SessionRecoveryManager.handleCrash.
 *   3. simulateCrash → crash handler fires → registry updated to crashed.
 *   4. Subsequent adapter.resumeSession yields a fresh handle.
 *   5. The fresh handle's sendAndStream resolves normally.
 *
 * This exercises the exact wiring pattern session-manager.ts:290 uses for
 * production crash detection. We keep the harness focused — no full
 * SessionManager boot — so we're testing the recovery seam, not the
 * startAgent lifecycle.
 */

import {
  createMockAdapter,
  type MockSessionAdapter,
  type MockSessionHandle,
  type SessionHandle,
} from "../session-adapter.js";
import { SessionRecoveryManager } from "../session-recovery.js";
import { readRegistry, writeRegistry } from "../registry.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { AgentSessionConfig, BackoffConfig } from "../types.js";

const BACKOFF: BackoffConfig = {
  baseMs: 50,
  maxMs: 500,
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
    memory: {
      compactionThreshold: 0.75,
      searchTopK: 10,
      consolidation: {
        enabled: true,
        weeklyThreshold: 7,
        monthlyThreshold: 4,
        schedule: "0 3 * * *",
      },
      decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 },
      deduplication: { enabled: true, similarityThreshold: 0.85 },
    },
    schedules: [],
    heartbeat: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
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

function makeSessionConfig(name: string): AgentSessionConfig {
  return {
    name,
    model: "sonnet",
    effort: "low",
    workspace: "/tmp/test-workspace",
    systemPrompt: "",
    channels: ["#general"],
  };
}

function makeSilentLogger(): Logger {
  const noop = () => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    level: "silent",
    child: () => makeSilentLogger(),
  } as unknown as Logger;
}

describe("persistent session recovery", () => {
  it("generator-death → handleCrash triggers → resumeSession yields fresh handle → next turn succeeds", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "persistent-recovery-"));
    const registryPath = join(tmpDir, "registry.json");
    try {
      // Seed registry with a running entry for agent-a.
      await writeRegistry(registryPath, {
        entries: [
          {
            name: "agent-a",
            status: "running",
            sessionId: null,
            startedAt: Date.now(),
            restartCount: 0,
            consecutiveFailures: 0,
            lastError: null,
            lastStableAt: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      const adapter: MockSessionAdapter = createMockAdapter();
      const resolvedConfig = makeConfig("agent-a");
      const sessionConfig = makeSessionConfig("agent-a");

      // Shared sessions map matching SessionManager's own map.
      const sessions = new Map<string, SessionHandle>();

      // performRestartFn: simulate SessionManager re-creating a fresh session
      // via the adapter after a crash. In production SessionManager bridges
      // ResolvedAgentConfig → AgentSessionConfig via buildSessionConfig.
      const performRestartFn = vi.fn(async (name: string, _cfg: ResolvedAgentConfig) => {
        const fresh = await adapter.resumeSession(
          sessions.get(name)?.sessionId ?? "lost",
          sessionConfig,
        );
        sessions.set(name, fresh);
      });

      const recovery = new SessionRecoveryManager(
        registryPath,
        BACKOFF,
        makeSilentLogger(),
        performRestartFn,
      );

      // Create the initial handle and wire onError → handleCrash (session-manager.ts:290 pattern).
      const handle = (await adapter.createSession(sessionConfig)) as MockSessionHandle;
      sessions.set("agent-a", handle);
      const crashSpy = vi.spyOn(recovery, "handleCrash");
      handle.onError((err) => {
        recovery.handleCrash("agent-a", resolvedConfig, err, sessions);
      });

      // Simulate a generator death.
      handle.simulateCrash(new Error("boom"));

      // Wait for crash bookkeeping to complete.
      await recovery._lastCrashPromise;
      expect(crashSpy).toHaveBeenCalledTimes(1);

      // Registry should now show crashed status.
      const reg = await readRegistry(registryPath);
      const entry = reg.entries.find((e) => e.name === "agent-a")!;
      expect(entry.status).toBe("crashed");
      expect(entry.consecutiveFailures).toBe(1);

      // Wait for the scheduled restart to fire (backoff baseMs + margin).
      await new Promise((r) => setTimeout(r, BACKOFF.baseMs * 2 + 100));
      await recovery._lastRestartPromise;
      // performRestartFn itself is async — await it completing.
      expect(performRestartFn).toHaveBeenCalledTimes(1);

      // Fresh handle exists in sessions map.
      const fresh = sessions.get("agent-a")!;
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(handle);

      // Subsequent sendAndStream succeeds on the fresh handle.
      const onChunk = vi.fn();
      const result = await fresh.sendAndStream("hello", onChunk);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);

      recovery.clearAllTimers();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("in-flight send during crash rejects with a session-closed error", async () => {
    const adapter: MockSessionAdapter = createMockAdapter();
    const sessionConfig = makeSessionConfig("agent-b");
    const handle = (await adapter.createSession(sessionConfig)) as MockSessionHandle;

    const errorHandler = vi.fn();
    handle.onError(errorHandler);

    // Simulate a crash mid-turn. MockSessionHandle.simulateCrash closes the
    // handle synchronously and fires errorHandler. Subsequent sends must throw.
    handle.simulateCrash(new Error("generator-dead"));
    expect(errorHandler).toHaveBeenCalledTimes(1);

    await expect(handle.sendAndStream("post-crash", () => undefined)).rejects.toThrow(
      /closed/i,
    );
  });
});
