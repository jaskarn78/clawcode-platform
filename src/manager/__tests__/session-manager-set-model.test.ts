/**
 * Phase 86 Plan 01 Task 2 — SessionManager.setModelForAgent integration tests.
 *
 * Verifies:
 *   - M1: setModelForAgent on an allowed model invokes handle.setModel once.
 *   - M2: setModelForAgent on a disallowed model throws ModelNotAllowedError
 *         with populated agent/attempted/allowed fields; no SDK call fires.
 *   - M3: getModelForAgent returns the id most recently passed (state parity).
 *   - M4: ModelNotAllowedError extends Error + instanceof works + message
 *         contains agent / attempted / allowed list.
 *   - M5: Unknown agent name throws SessionError, NOT ModelNotAllowedError
 *         (existing requireSession guard preserved).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { createMockAdapter, type MockSessionAdapter } from "../session-adapter.js";
import { SessionManager } from "../session-manager.js";
import { ModelNotAllowedError } from "../model-errors.js";
import { SessionError } from "../../shared/errors.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { BackoffConfig } from "../types.js";

// Warm-path mock — same pattern as fork-effort-quarantine.test.ts.
vi.mock("../warm-path-check.js", async () => {
  const actual = await vi.importActual<typeof import("../warm-path-check.js")>(
    "../warm-path-check.js",
  );
  return {
    ...actual,
    runWarmPathCheck: vi.fn(async () => ({
      ready: true,
      durations_ms: { sqlite: 50, embedder: 80, session: 1, browser: 0, mcp: 0 },
      total_ms: 131,
      errors: [],
    })),
  };
});

const TEST_BACKOFF: BackoffConfig = {
  baseMs: 100,
  maxMs: 1000,
  maxRetries: 3,
  stableAfterMs: 500,
};

function makeConfig(
  name: string,
  allowedModels: ("haiku" | "sonnet" | "opus")[] = ["haiku", "sonnet", "opus"],
  workspaceDir?: string,
): ResolvedAgentConfig {
  const ws = workspaceDir ?? "/tmp/test-workspace";
  return {
    name,
    workspace: ws,
    memoryPath: ws,
    channels: [],
    model: "sonnet",
    effort: "low",
    allowedModels,
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
      consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" },
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

describe("SessionManager.setModelForAgent + ModelNotAllowedError (Phase 86 MODEL-03 / MODEL-06)", () => {
  // Longer timeout — integration tests do real memory init + warm-path gate.
  const INTEGRATION_TIMEOUT_MS = 15_000;
  let tmpDir: string;
  let registryPath: string;
  let adapter: MockSessionAdapter;
  let manager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), `sm-setmodel-${nanoid(6)}-`));
    registryPath = join(tmpDir, "registry.json");
    adapter = createMockAdapter();
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
    });
  });

  afterEach(async () => {
    try { await manager.stopAll(); } catch { /* best-effort */ }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it(
    "M1: setModelForAgent('sonnet') on agent allowing sonnet invokes handle.setModel once",
    async () => {
      const agent = `m1-${nanoid(4)}`;
      const cfg = makeConfig(agent, ["haiku", "sonnet"], tmpDir);
      await manager.startAgent(agent, cfg);

      // Spy on the mock handle's setModel BEFORE calling setModelForAgent.
      const handle = [...adapter.sessions.values()].find((h) =>
        h.sessionId.includes(agent),
      );
      expect(handle).toBeDefined();
      const setModelSpy = vi.spyOn(handle!, "setModel");

      manager.setModelForAgent(agent, "sonnet");

      expect(setModelSpy).toHaveBeenCalledTimes(1);
      // Called with the RESOLVED SDK model id (not the raw alias).
      const calledWith = setModelSpy.mock.calls[0]?.[0];
      expect(calledWith).toMatch(/^claude-sonnet-/);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "M2: setModelForAgent('opus') on agent with allowedModels=['haiku','sonnet'] throws ModelNotAllowedError; handle.setModel NOT called",
    async () => {
      const agent = `m2-${nanoid(4)}`;
      const cfg = makeConfig(agent, ["haiku", "sonnet"], tmpDir);
      await manager.startAgent(agent, cfg);

      const handle = [...adapter.sessions.values()].find((h) =>
        h.sessionId.includes(agent),
      );
      expect(handle).toBeDefined();
      const setModelSpy = vi.spyOn(handle!, "setModel");

      let caught: unknown;
      try {
        manager.setModelForAgent(agent, "opus");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ModelNotAllowedError);
      const err = caught as ModelNotAllowedError;
      expect(err.agent).toBe(agent);
      expect(err.attempted).toBe("opus");
      expect(err.allowed).toEqual(["haiku", "sonnet"]);
      // Handle must not have been called with opus.
      expect(setModelSpy).not.toHaveBeenCalled();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "M3: getModelForAgent returns a string after setModelForAgent succeeds",
    async () => {
      const agent = `m3-${nanoid(4)}`;
      const cfg = makeConfig(agent, ["haiku", "sonnet", "opus"], tmpDir);
      await manager.startAgent(agent, cfg);

      manager.setModelForAgent(agent, "opus");
      const live = manager.getModelForAgent(agent);
      // Mock handle.setModel stores the id. Must be the resolved opus id.
      expect(live).toMatch(/^claude-opus-/);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it("M4: ModelNotAllowedError extends Error; instanceof + message shape", () => {
    const err = new ModelNotAllowedError("alice", "opus", ["haiku", "sonnet"]);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ModelNotAllowedError);
    expect(err.name).toBe("ModelNotAllowedError");
    expect(err.message).toContain("alice");
    expect(err.message).toContain("opus");
    expect(err.message).toContain("haiku");
    expect(err.message).toContain("sonnet");
  });

  it(
    "M5: setModelForAgent with unknown agent name throws SessionError (not ModelNotAllowedError)",
    async () => {
      let caught: unknown;
      try {
        manager.setModelForAgent("nonexistent-agent", "sonnet");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SessionError);
      expect(caught).not.toBeInstanceOf(ModelNotAllowedError);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
