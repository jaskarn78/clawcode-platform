import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SubagentThreadSpawner } from "../subagent-thread-spawner.js";
import type { SubagentThreadConfig } from "../subagent-thread-types.js";
import type { SessionManager } from "../../manager/session-manager.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

/**
 * Phase 106 DSCOPE-02 / DSCOPE-03 — RED tests for delegate-scope leak.
 *
 * Bug surfaced 2026-04-30 ~15:13 PT: after 999.13 deploy with
 * `delegates: { research: research-agent }` on fin-client, when fin-client
 * spawned a research-agent subagent thread, research-agent-as-spawned-subagent
 * emitted "I'll spawn a focused research agent to handle this" — tried to
 * recursively call itself. SDK recursion guard (Phase 99-N
 * `disallowedTools: ["mcp__clawcode__spawn_subagent_thread"]`) blocked the
 * actual spawn, but the agent stalled instead of pivoting because the
 * directive text was still in its system prompt.
 *
 * Root cause (verified by direct file inspection at
 * src/discord/subagent-thread-spawner.ts:454-465): the `subagentConfig`
 * spreads `...sourceConfig` verbatim, which carries the parent's
 * `delegates` field into the subagent's ResolvedAgentConfig. The downstream
 * `buildSessionConfig` → `renderDelegatesBlock(config.delegates)` chain then
 * injects the "## Specialist Delegation" block into the subagent's stable
 * prefix. Subagents must NEVER orchestrate further subagents.
 *
 * Fix lands in Wave 1: caller-side strip in `subagent-thread-spawner.ts` —
 * destructure `delegates` out of `sourceConfig` before the spread. Renderer
 * stays pure (no `isSubagent` flag pollution).
 *
 * These RED tests pin:
 *   - DSCOPE-02: subagentConfig handed to startAgent has `delegates: undefined`
 *   - DSCOPE-03: parent's sourceConfig is NOT mutated by the strip
 *     (destructure-only operation, no in-place delete)
 */

/**
 * Build a minimal ResolvedAgentConfig fixture mirroring
 * src/discord/__tests__/subagent-recursion-guard.test.ts.
 */
function makeAgentConfig(
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    name: "fin-client",
    workspace: "/tmp/fin-client",
    memoryPath: "/tmp/fin-client",
    channels: ["channel-1"],
    model: "sonnet",
    effort: "low",
    allowedModels: ["haiku", "sonnet", "opus"],
    greetOnRestart: true,
    greetCoolDownMs: 300_000,
    memoryAutoLoad: true,
    memoryRetrievalTopK: 5,
    memoryScannerEnabled: true,
    memoryFlushIntervalMs: 900_000,
    memoryCueEmoji: "✅",
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"],
    skills: [],
    soul: "You are fin-client.",
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
      decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 },
      deduplication: { enabled: false, similarityThreshold: 0.9 },
    },
    heartbeat: {
      enabled: false,
      intervalSeconds: 60,
      checkTimeoutSeconds: 30,
      contextFill: { warningThreshold: 70, criticalThreshold: 90 },
    },
    skillsPath: "/tmp/skills",
    schedules: [],
    admin: false,
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
    slashCommands: [],
    reactions: false,
    mcpServers: [],
    ...overrides,
  } as ResolvedAgentConfig;
}

/**
 * Phase 999.57 — minimal HeartbeatRunner mock for spawner ctor.
 */
function makeMockHeartbeatRunner() {
  const mock = {
    setAgentConfigs: vi.fn(),
  };
  return mock as unknown as import("../../heartbeat/runner.js").HeartbeatRunner;
}

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
    getAgentConfig: vi.fn((agentName: string) => configs.get(agentName)),
    getRunningAgents: vi.fn(() => [...running]),
    forwardToAgent: vi.fn(),
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
    getEpisodeStore: vi.fn(),
    saveContextSummary: vi.fn(),
    warmupEmbeddings: vi.fn(),
    setSkillsCatalog: vi.fn(),
    setAllAgentConfigs: vi.fn(),
    _setConfig(name: string, config: ResolvedAgentConfig) {
      configs.set(name, config);
    },
  };

  return mock as unknown as SessionManager & {
    startAgent: ReturnType<typeof vi.fn>;
    stopAgent: ReturnType<typeof vi.fn>;
    getAgentConfig: ReturnType<typeof vi.fn>;
    _setConfig: (name: string, config: ResolvedAgentConfig) => void;
  };
}

function makeMockDiscordClient() {
  const mockThread = {
    id: "thread-dscope",
    name: "test-thread",
    send: vi.fn(),
  };
  const mockChannel = {
    id: "channel-1",
    threads: { create: vi.fn(async () => mockThread) },
    isTextBased: () => true,
  };
  const client = { channels: { fetch: vi.fn(async () => mockChannel) } };
  return { client, mockChannel, mockThread };
}

describe("Phase 106 DSCOPE — subagent config strips `delegates`", () => {
  let tmpDir: string;
  let registryPath: string;
  let sessionManager: ReturnType<typeof makeMockSessionManager>;
  let discordMock: ReturnType<typeof makeMockDiscordClient>;
  let spawner: SubagentThreadSpawner;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "subagent-dscope-"));
    registryPath = join(tmpDir, "thread-bindings.json");
    sessionManager = makeMockSessionManager();
    discordMock = makeMockDiscordClient();
    spawner = new SubagentThreadSpawner({
      sessionManager,
      heartbeatRunner: makeMockHeartbeatRunner(),
      // Quick task 260520-qo5 — required DI dep; no-op here (no
      // LlmRuntime assertions in this suite).
      registerLlmRuntime: () => {},
      registryPath,
      discordClient: discordMock.client as any,
    });
  });

  afterEach(async () => {
    // Phase 999.36 sub-bug D — postInitialMessage now stamps lastDeliveryAt
    // via fs I/O in the fire-and-forget `void` chain; settle before rm to
    // avoid an ENOTEMPTY race when writeThreadRegistry's mkdir recreates
    // the parent directory after rm starts.
    await new Promise((r) => setTimeout(r, 50));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("DSCOPE-02: spawned subagent config does NOT carry `delegates` field even when sourceConfig has it", async () => {
    // Parent (fin-client) has `delegates: { research: research-agent }`
    // — exactly the production yaml shape that triggered the recursion bug.
    const parentConfig = makeAgentConfig({
      name: "fin-client",
      delegates: { research: "research-agent" },
    } as Partial<ResolvedAgentConfig>);
    sessionManager._setConfig("fin-client", parentConfig);

    const config: SubagentThreadConfig = {
      parentAgentName: "fin-client",
      threadName: "dscope-task-no-delegate",
    };

    await spawner.spawnInThread(config);

    expect(sessionManager.startAgent).toHaveBeenCalledOnce();
    const callArgs = sessionManager.startAgent.mock.calls[0]!;
    const subagentConfig = callArgs[1] as ResolvedAgentConfig & {
      delegates?: Readonly<Record<string, string>>;
    };

    // RED today: spread carries `delegates` verbatim → directive injects.
    // GREEN after Wave 1: caller-side strip → field is absent.
    expect(subagentConfig.delegates).toBeUndefined();
  });

  it("DSCOPE-03: sourceConfig.delegates remain unmodified after spawn (destructure-only, no in-place mutation)", async () => {
    const originalDelegates = { research: "research-agent" } as const;
    const parentConfig = makeAgentConfig({
      name: "fin-client",
      delegates: { ...originalDelegates },
    } as Partial<ResolvedAgentConfig>);
    sessionManager._setConfig("fin-client", parentConfig);

    const config: SubagentThreadConfig = {
      parentAgentName: "fin-client",
      threadName: "dscope-task-purity",
    };

    await spawner.spawnInThread(config);

    // Parent config — fetched back from the session manager — must still
    // carry its delegates verbatim. The strip must be destructure-only;
    // any in-place `delete sourceConfig.delegates` would mutate the parent.
    const parentAfter = sessionManager.getAgentConfig(
      "fin-client",
    ) as ResolvedAgentConfig & {
      delegates?: Readonly<Record<string, string>>;
    };
    expect(parentAfter.delegates).toEqual(originalDelegates);
  });

  it("DSCOPE-02 (delegateTo path): when delegating to research-agent, the spawned subagent config does NOT carry the delegate's `delegates` field either", async () => {
    // Defense-in-depth: even when the caller passes `delegateTo: "research-agent"`,
    // the delegate's own delegates (if any) must not flow into the subagent.
    // Here: research itself has `delegates: { writeup: "writer" }` and is
    // delegated to via fin-client's spawn — strip applies regardless of which
    // sourceConfig branch is selected.
    const parentConfig = makeAgentConfig({
      name: "fin-client",
      delegates: { research: "research-agent" },
    } as Partial<ResolvedAgentConfig>);
    const delegateConfig = makeAgentConfig({
      name: "research-agent",
      soul: "You are research-agent.",
      delegates: { writeup: "writer" },
    } as Partial<ResolvedAgentConfig>);
    sessionManager._setConfig("fin-client", parentConfig);
    sessionManager._setConfig("research-agent", delegateConfig);

    const config: SubagentThreadConfig = {
      parentAgentName: "fin-client",
      threadName: "dscope-delegateTo-task",
      delegateTo: "research-agent",
    };

    await spawner.spawnInThread(config);

    const callArgs = sessionManager.startAgent.mock.calls[0]!;
    const subagentConfig = callArgs[1] as ResolvedAgentConfig & {
      delegates?: Readonly<Record<string, string>>;
    };

    expect(subagentConfig.delegates).toBeUndefined();
  });
});
