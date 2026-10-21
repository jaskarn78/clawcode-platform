/**
 * Phase 87 Plan 02 Task 1 — SessionManager.setPermissionModeForAgent integration tests.
 *
 * Mirrors the Phase 86 session-manager-set-model test shape but drops the
 * per-agent allowlist: PermissionMode is a STATIC 6-value union by design
 * (every agent can set every mode). M2 asserts invalid-mode rejection via a
 * plain Error (not a typed policy error).
 *
 * Verifies:
 *   - M1: setPermissionModeForAgent('acceptEdits') invokes handle.setPermissionMode
 *         spy once with 'acceptEdits'.
 *   - M2: Invalid mode 'invalid-mode' throws Error mentioning valid modes list;
 *         handle spy NEVER called.
 *   - M3: getPermissionModeForAgent round-trips to handle.getPermissionMode.
 *   - M4: Unknown agent name throws SessionError (preserves requireSession guard).
 *   - M5: Each valid PermissionMode value (6 total) accepted individually
 *         (parametrized loop asserting one dispatch per mode).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { createMockAdapter, type MockSessionAdapter } from "../session-adapter.js";
import { SessionManager } from "../session-manager.js";
import { SessionError } from "../../shared/errors.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { BackoffConfig } from "../types.js";
import type { PermissionMode } from "../sdk-types.js";

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
    allowedModels: ["haiku", "sonnet", "opus"],
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

describe("SessionManager.setPermissionModeForAgent (Phase 87 CMD-02)", () => {
  // Longer timeout — integration tests do real memory init + warm-path gate.
  const INTEGRATION_TIMEOUT_MS = 15_000;
  let tmpDir: string;
  let registryPath: string;
  let adapter: MockSessionAdapter;
  let manager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), `sm-setperm-${nanoid(6)}-`));
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
    "M1: setPermissionModeForAgent('acceptEdits') invokes handle.setPermissionMode once with 'acceptEdits'",
    async () => {
      const agent = `m1-${nanoid(4)}`;
      const cfg = makeConfig(agent, tmpDir);
      await manager.startAgent(agent, cfg);

      const handle = [...adapter.sessions.values()].find((h) =>
        h.sessionId.includes(agent),
      );
      expect(handle).toBeDefined();
      const spy = vi.spyOn(handle!, "setPermissionMode");

      manager.setPermissionModeForAgent(agent, "acceptEdits");

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("acceptEdits");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "M2: setPermissionModeForAgent('invalid-mode') throws Error mentioning valid modes; handle.setPermissionMode NOT called",
    async () => {
      const agent = `m2-${nanoid(4)}`;
      const cfg = makeConfig(agent, tmpDir);
      await manager.startAgent(agent, cfg);

      const handle = [...adapter.sessions.values()].find((h) =>
        h.sessionId.includes(agent),
      );
      expect(handle).toBeDefined();
      const spy = vi.spyOn(handle!, "setPermissionMode");

      let caught: unknown;
      try {
        manager.setPermissionModeForAgent(agent, "invalid-mode");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const msg = (caught as Error).message;
      expect(msg).toMatch(/invalid permission mode/i);
      expect(msg).toMatch(/default/);
      expect(msg).toMatch(/acceptEdits/);
      expect(msg).toMatch(/bypassPermissions/);
      // Handle must not have been called with the invalid mode.
      expect(spy).not.toHaveBeenCalled();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "M3: getPermissionModeForAgent round-trips to handle.getPermissionMode",
    async () => {
      const agent = `m3-${nanoid(4)}`;
      const cfg = makeConfig(agent, tmpDir);
      await manager.startAgent(agent, cfg);

      manager.setPermissionModeForAgent(agent, "plan");
      const live = manager.getPermissionModeForAgent(agent);
      expect(live).toBe("plan");

      manager.setPermissionModeForAgent(agent, "bypassPermissions");
      expect(manager.getPermissionModeForAgent(agent)).toBe("bypassPermissions");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "M4: setPermissionModeForAgent with unknown agent name throws SessionError",
    async () => {
      let caught: unknown;
      try {
        manager.setPermissionModeForAgent("nonexistent-agent", "acceptEdits");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SessionError);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "M5: Every valid PermissionMode value (6 total) is accepted; each dispatches exactly once",
    async () => {
      const agent = `m5-${nanoid(4)}`;
      const cfg = makeConfig(agent, tmpDir);
      await manager.startAgent(agent, cfg);

      const handle = [...adapter.sessions.values()].find((h) =>
        h.sessionId.includes(agent),
      );
      expect(handle).toBeDefined();
      const spy = vi.spyOn(handle!, "setPermissionMode");

      const validModes: readonly PermissionMode[] = [
        "default",
        "acceptEdits",
        "bypassPermissions",
        "plan",
        "dontAsk",
        "auto",
      ];

      for (const mode of validModes) {
        manager.setPermissionModeForAgent(agent, mode);
      }

      expect(spy).toHaveBeenCalledTimes(validModes.length);
      expect(spy.mock.calls.map((c) => c[0])).toEqual([...validModes]);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
