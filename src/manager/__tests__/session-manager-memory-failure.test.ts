/**
 * Quick task 260419-mvh — regression test for the initMemory→warm-path
 * cascade bug.
 *
 * Context:
 *   When `AgentMemoryManager.initMemory(name, config)` fails (SQLite
 *   corruption, bad workspace perms, sqlite-vec load failure, etc.), the
 *   OLD `startAgent` path kept marching forward:
 *     1. initMemory LOGS the error but does NOT throw (session-memory.ts:125)
 *     2. downstream `conversationStores.get(name)` returns undefined, NPE-safe
 *     3. adapter.createSession STILL creates a session for the broken agent
 *     4. runWarmPathCheck calls `warmSqliteStores(name)` → THROWS
 *        `warmSqliteStores: no MemoryStore for agent '${name}'`
 *     5. warm-path records lastError=`warm-path: warmSqliteStores[memories]:
 *        ...` — hiding the REAL root-cause error from Step 1.
 *
 * After the fix:
 *   - `startAgent` wraps initMemory in try/catch AND guards on `!memoryStores.has`
 *   - On failure: registry entry goes 'starting' → 'failed' with the TRUE
 *     error message in lastError
 *   - warm-path + adapter.createSession + conversation session + soul memory
 *     + buildSessionConfig are ALL skipped
 *   - startAgent resolves cleanly (daemon keeps running other agents)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createMockAdapter } from "../session-adapter.js";
import type { MockSessionAdapter } from "../session-adapter.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { BackoffConfig } from "../types.js";
import { readRegistry } from "../registry.js";
import { SessionManager } from "../session-manager.js";

// Mock runWarmPathCheck module-wide — the real warm-path boots the
// embedder + reads SQLite, both of which we don't need here. Every test
// that reaches warm-path wants the happy result; tests that stub
// initMemory should never reach warm-path at all (Test 2).
vi.mock("../warm-path-check.js", async () => {
  const actual = await vi.importActual<typeof import("../warm-path-check.js")>(
    "../warm-path-check.js",
  );
  return {
    ...actual,
    runWarmPathCheck: vi.fn().mockResolvedValue(
      Object.freeze({
        ready: true,
        durations_ms: Object.freeze({ sqlite: 1, embedder: 1, session: 1, browser: 0 }),
        total_ms: 3,
        errors: Object.freeze([]) as readonly string[],
      }),
    ),
  };
});

const TEST_BACKOFF: BackoffConfig = {
  baseMs: 100,
  maxMs: 1000,
  maxRetries: 3,
  stableAfterMs: 500,
};

function makeConfig(name: string, workspace: string): ResolvedAgentConfig {
  return {
    name,
    workspace,
    memoryPath: workspace, // Phase 75 SHARED-01
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

describe("SessionManager startAgent — initMemory failure cascade (quick task 260419-mvh)", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "sm-mem-fail-"));
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
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("Test 1 — initMemory throws → registry goes 'starting' → 'failed' with the real error message", async () => {
    const config = makeConfig("clawdy", tmpDir);
    // Force the initMemory path to THROW. Once the fix lands, startAgent's
    // try/catch captures the message verbatim.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const memory = (manager as any).memory;
    const spy = vi.spyOn(memory, "initMemory").mockImplementation(() => {
      throw new Error("disk full: sqlite-vec load failed");
    });

    await manager.startAgent("clawdy", config);

    const registry = await readRegistry(registryPath);
    const entry = registry.entries.find((e) => e.name === "clawdy");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("failed");
    expect(entry!.lastError ?? "").toContain("disk full: sqlite-vec load failed");
    // The misleading warm-path wrapper must not appear — that's the cascade bug.
    expect(entry!.lastError ?? "").not.toContain("warm-path");
    // warm_path_ready must not be set truthy on initMemory-failure path.
    expect(entry!.warm_path_ready).not.toBe(true);

    spy.mockRestore();
  });

  it("Test 2 — warm-path is NEVER invoked on initMemory failure", async () => {
    const config = makeConfig("clawdy", tmpDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const memory = (manager as any).memory;
    vi.spyOn(memory, "initMemory").mockImplementation(() => {
      throw new Error("init failed");
    });
    const warmSpy = vi
      .spyOn(memory, "warmSqliteStores")
      .mockResolvedValue({ memories_ms: 0, usage_ms: 0, traces_ms: 0 });

    await manager.startAgent("clawdy", config);

    expect(warmSpy).not.toHaveBeenCalled();
  });

  it("Test 3 — adapter.createSession is NEVER invoked on initMemory failure", async () => {
    const config = makeConfig("clawdy", tmpDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const memory = (manager as any).memory;
    vi.spyOn(memory, "initMemory").mockImplementation(() => {
      throw new Error("init failed");
    });
    const createSpy = vi.spyOn(adapter, "createSession");

    await manager.startAgent("clawdy", config);

    expect(createSpy).not.toHaveBeenCalled();
  });

  it("Test 4 — downstream maps are NOT populated on failure", async () => {
    const config = makeConfig("clawdy", tmpDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const memory = (manager as any).memory;
    vi.spyOn(memory, "initMemory").mockImplementation(() => {
      throw new Error("init failed");
    });

    await manager.startAgent("clawdy", config);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mgr = manager as any;
    expect(mgr.sessions.has("clawdy")).toBe(false);
    expect(mgr.activeConversationSessionIds.has("clawdy")).toBe(false);
  });

  it("Test 5 — daemon-equivalent path does not throw (SessionManager contract)", async () => {
    const config = makeConfig("clawdy", tmpDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const memory = (manager as any).memory;
    vi.spyOn(memory, "initMemory").mockImplementation(() => {
      throw new Error("init failed");
    });

    await expect(manager.startAgent("clawdy", config)).resolves.not.toThrow();
  });

  it("Test 6 — existing happy path still passes (no stub)", async () => {
    const config = makeConfig("happy-agent", tmpDir);
    await manager.startAgent("happy-agent", config);

    const registry = await readRegistry(registryPath);
    const entry = registry.entries.find((e) => e.name === "happy-agent");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("running");
  });

  it("Test 7 — silent-swallow case: initMemory logs-and-returns without throwing but leaves no MemoryStore → still marked failed with 'missing after initMemory'", async () => {
    // Matches the CURRENT session-memory.ts behavior where initMemory's own
    // try/catch swallows errors but leaves memoryStores unset. The second
    // guard in the fix (`!memoryStores.has`) must catch this silent-fail path.
    const config = makeConfig("silent-fail", tmpDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const memory = (manager as any).memory;
    // Return without throwing AND without populating memoryStores.
    vi.spyOn(memory, "initMemory").mockImplementation(() => {
      // no-op — mimics the silent-swallow path in session-memory.ts:125-130
    });
    const warmSpy = vi
      .spyOn(memory, "warmSqliteStores")
      .mockResolvedValue({ memories_ms: 0, usage_ms: 0, traces_ms: 0 });
    const createSpy = vi.spyOn(adapter, "createSession");

    await manager.startAgent("silent-fail", config);

    const registry = await readRegistry(registryPath);
    const entry = registry.entries.find((e) => e.name === "silent-fail");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("failed");
    expect(entry!.lastError ?? "").toContain("MemoryStore missing");
    expect(entry!.lastError ?? "").not.toContain("warm-path");
    // Guards must have stopped the cascade before warm-path + adapter.
    expect(warmSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });
});
