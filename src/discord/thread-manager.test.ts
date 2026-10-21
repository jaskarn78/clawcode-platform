import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ThreadManager } from "./thread-manager.js";
import type { RoutingTable } from "./types.js";
import type { SessionManager } from "../manager/session-manager.js";
import type { ResolvedAgentConfig } from "../shared/types.js";
import {
  readThreadRegistry,
  EMPTY_THREAD_REGISTRY,
} from "./thread-registry.js";
import { DEFAULT_THREAD_CONFIG } from "./thread-types.js";

/**
 * Create a minimal mock ResolvedAgentConfig for testing.
 */
function makeAgentConfig(
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    name: "agent-a",
    workspace: "/tmp/agent-a",
    memoryPath: "/tmp/agent-a", // Phase 75 SHARED-01
    channels: ["channel-1"],
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
    soul: "You are a test agent.",
    identity: "Test identity.",
    memory: {
      compactionThreshold: 80,
      searchTopK: 10,
      consolidation: {
        enabled: false,
        weeklyThreshold: 7,
        monthlyThreshold: 4,
        schedule: "0 3 * * *",
      },
      decay: {
        halfLifeDays: 30,
        semanticWeight: 0.7,
        decayWeight: 0.3,
      },
      deduplication: {
        enabled: false,
        similarityThreshold: 0.9,
      },
    },
    heartbeat: {
      enabled: false,
      intervalSeconds: 60,
      checkTimeoutSeconds: 30,
      contextFill: {
        warningThreshold: 70,
        criticalThreshold: 90,
      },
    },
    skillsPath: "/tmp/skills",
    schedules: [],
    admin: false,
    sandbox: { enabled: false, allowRuntimeOp: false },
    subagentModel: undefined,
    threads: {
      idleTimeoutMinutes: 1440,
      maxThreadSessions: 10,
    },
    slashCommands: [],
    reactions: false,
    mcpServers: [],
    ...overrides,
  };
}

/**
 * Create a mock SessionManager with just the methods ThreadManager needs.
 */
function makeMockSessionManager() {
  const configs = new Map<string, ResolvedAgentConfig>();
  const running = new Set<string>();

  const mock = {
    startAgent: vi.fn(async (name: string, _config: ResolvedAgentConfig) => {
      running.add(name);
    }),
    stopAgent: vi.fn(async (name: string) => {
      running.delete(name);
    }),
    forwardToAgent: vi.fn(async (_name: string, _message: string) => {}),
    getAgentConfig: vi.fn((agentName: string) => configs.get(agentName)),
    getRunningAgents: vi.fn(() => [...running]),
    dispatchTurn: vi.fn(),
    streamFromAgent: vi.fn(),
    forkSession: vi.fn(),
    restartAgent: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
    reconcileRegistry: vi.fn(),
    getMemoryStore: vi.fn(),
    getCompactionManager: vi.fn(),
    getContextFillProvider: vi.fn(),
    getEmbedder: vi.fn(),
    getSessionLogger: vi.fn(),
    getTierManager: vi.fn(),
    getUsageTracker: vi.fn(),
    saveContextSummary: vi.fn(),
    warmupEmbeddings: vi.fn(),
    setSkillsCatalog: vi.fn(),
    setAllAgentConfigs: vi.fn(),
    // Test helper to pre-populate configs
    _setConfig(name: string, config: ResolvedAgentConfig) {
      configs.set(name, config);
    },
  };

  return mock as unknown as SessionManager & {
    startAgent: ReturnType<typeof vi.fn>;
    stopAgent: ReturnType<typeof vi.fn>;
    forwardToAgent: ReturnType<typeof vi.fn>;
    getAgentConfig: ReturnType<typeof vi.fn>;
    getRunningAgents: ReturnType<typeof vi.fn>;
    _setConfig: (name: string, config: ResolvedAgentConfig) => void;
  };
}

/**
 * Create a routing table with a single channel->agent mapping.
 */
function makeRoutingTable(
  channelToAgent: Record<string, string> = { "channel-1": "agent-a" },
): RoutingTable {
  return {
    channelToAgent: new Map(Object.entries(channelToAgent)),
    agentToChannels: new Map(
      Object.entries(
        Object.entries(channelToAgent).reduce(
          (acc, [ch, agent]) => {
            if (!acc[agent]) acc[agent] = [];
            acc[agent].push(ch);
            return acc;
          },
          {} as Record<string, string[]>,
        ),
      ),
    ),
  };
}

describe("ThreadManager", () => {
  let tmpDir: string;
  let registryPath: string;
  let sessionManager: ReturnType<typeof makeMockSessionManager>;
  let routingTable: RoutingTable;
  let threadManager: ThreadManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "thread-mgr-"));
    registryPath = join(tmpDir, "thread-bindings.json");
    sessionManager = makeMockSessionManager();
    routingTable = makeRoutingTable();

    const agentConfig = makeAgentConfig();
    sessionManager._setConfig("agent-a", agentConfig);

    threadManager = new ThreadManager({
      sessionManager,
      routingTable,
      registryPath,
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("handleThreadCreate", () => {
    it("spawns a thread session when parent channel is bound to an agent", async () => {
      const result = await threadManager.handleThreadCreate(
        "thread-100",
        "my-thread",
        "channel-1",
      );

      expect(result).toBe(true);
      expect(sessionManager.startAgent).toHaveBeenCalledOnce();

      // Session name should follow the pattern: {agentName}-thread-{threadId}
      const callArgs = sessionManager.startAgent.mock.calls[0];
      expect(callArgs[0]).toBe("agent-a-thread-thread-100");
    });

    it("does NOT spawn if parent channel is not in routingTable", async () => {
      const result = await threadManager.handleThreadCreate(
        "thread-100",
        "my-thread",
        "unbound-channel",
      );

      expect(result).toBe(false);
      expect(sessionManager.startAgent).not.toHaveBeenCalled();
    });

    it("does NOT spawn if agent already has maxThreadSessions active threads", async () => {
      // Configure agent with max 2 threads
      const config = makeAgentConfig({
        threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 2 },
      });
      sessionManager._setConfig("agent-a", config);

      // Spawn 2 threads
      await threadManager.handleThreadCreate("thread-1", "t1", "channel-1");
      await threadManager.handleThreadCreate("thread-2", "t2", "channel-1");

      // Third should be rejected
      const result = await threadManager.handleThreadCreate(
        "thread-3",
        "t3",
        "channel-1",
      );

      expect(result).toBe(false);
      expect(sessionManager.startAgent).toHaveBeenCalledTimes(2);
    });

    it("creates a ThreadBinding and persists it to the registry", async () => {
      await threadManager.handleThreadCreate(
        "thread-100",
        "my-thread",
        "channel-1",
      );

      const registry = await readThreadRegistry(registryPath);
      expect(registry.bindings).toHaveLength(1);
      expect(registry.bindings[0].threadId).toBe("thread-100");
      expect(registry.bindings[0].agentName).toBe("agent-a");
      expect(registry.bindings[0].sessionName).toBe("agent-a-thread-thread-100");
      expect(registry.bindings[0].parentChannelId).toBe("channel-1");
    });

    it("thread session config inherits parent agent model, soul, identity", async () => {
      await threadManager.handleThreadCreate(
        "thread-100",
        "my-thread",
        "channel-1",
      );

      const callArgs = sessionManager.startAgent.mock.calls[0];
      const threadConfig = callArgs[1] as ResolvedAgentConfig;

      expect(threadConfig.model).toBe("sonnet");
      expect(threadConfig.soul).toContain("You are a test agent.");
      expect(threadConfig.identity).toBe("Test identity.");
    });

    it("thread system prompt includes thread name, parent channel, and parent agent name", async () => {
      await threadManager.handleThreadCreate(
        "thread-100",
        "my-thread",
        "channel-1",
      );

      const callArgs = sessionManager.startAgent.mock.calls[0];
      const threadConfig = callArgs[1] as ResolvedAgentConfig;

      // The soul field should have thread context prepended
      expect(threadConfig.soul).toContain("my-thread");
      expect(threadConfig.soul).toContain("channel-1");
      expect(threadConfig.soul).toContain("agent-a");
      expect(threadConfig.soul).toContain("Thread Context");
    });
  });

  describe("routeMessage", () => {
    it("returns the binding sessionName if threadId has a binding", async () => {
      await threadManager.handleThreadCreate(
        "thread-100",
        "my-thread",
        "channel-1",
      );

      const sessionName = await threadManager.routeMessage("thread-100");
      expect(sessionName).toBe("agent-a-thread-thread-100");
    });

    it("returns undefined if threadId has no binding", async () => {
      const sessionName = await threadManager.routeMessage("nonexistent-thread");
      expect(sessionName).toBeUndefined();
    });

    it("updates lastActivity on the binding when routing", async () => {
      await threadManager.handleThreadCreate(
        "thread-100",
        "my-thread",
        "channel-1",
      );

      const beforeRegistry = await readThreadRegistry(registryPath);
      const beforeActivity = beforeRegistry.bindings[0].lastActivity;

      // Wait a tiny bit so timestamps differ
      await new Promise((r) => setTimeout(r, 10));

      await threadManager.routeMessage("thread-100");

      const afterRegistry = await readThreadRegistry(registryPath);
      expect(afterRegistry.bindings[0].lastActivity).toBeGreaterThan(
        beforeActivity,
      );
    });
  });

  describe("removeThreadSession", () => {
    it("stops the session and removes the binding from registry", async () => {
      await threadManager.handleThreadCreate(
        "thread-100",
        "my-thread",
        "channel-1",
      );

      await threadManager.removeThreadSession("thread-100");

      expect(sessionManager.stopAgent).toHaveBeenCalledWith(
        "agent-a-thread-thread-100",
      );

      const registry = await readThreadRegistry(registryPath);
      expect(registry.bindings).toHaveLength(0);
    });

    it("does nothing if threadId has no binding", async () => {
      // Should not throw
      await threadManager.removeThreadSession("nonexistent-thread");
      expect(sessionManager.stopAgent).not.toHaveBeenCalled();
    });
  });

  describe("getActiveBindings", () => {
    it("returns all current bindings from registry", async () => {
      await threadManager.handleThreadCreate(
        "thread-1",
        "t1",
        "channel-1",
      );
      await threadManager.handleThreadCreate(
        "thread-2",
        "t2",
        "channel-1",
      );

      const bindings = await threadManager.getActiveBindings();
      expect(bindings).toHaveLength(2);
      expect(bindings[0].threadId).toBe("thread-1");
      expect(bindings[1].threadId).toBe("thread-2");
    });

    it("returns empty array when no bindings exist", async () => {
      const bindings = await threadManager.getActiveBindings();
      expect(bindings).toHaveLength(0);
    });
  });
});
