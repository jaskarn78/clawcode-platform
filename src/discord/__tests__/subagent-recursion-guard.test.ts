import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SubagentThreadSpawner } from "../subagent-thread-spawner.js";
import type { SubagentThreadConfig } from "../subagent-thread-types.js";
import type { SessionManager } from "../../manager/session-manager.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { AgentSessionConfig } from "../../manager/types.js";

/**
 * Phase 99 sub-scope N (2026-04-26) — recursion-guard regression suite.
 *
 * Bug surfaced: an Admin Clawdy subagent inherited the parent's "delegate, do
 * not execute" soul, so when given a task it ALSO called
 * `spawn_subagent_thread` and chained 5+ Admin Clawdy clones before the
 * operator caught it. Default `maxThreadSessions: 10` was too high to cap the
 * blast radius.
 *
 * Fix lives in two layers:
 *   - Layer 1: `SubagentThreadSpawner.spawnInThread` injects
 *     `disallowedTools: ["mcp__clawcode__spawn_subagent_thread"]` on the
 *     subagent's `ResolvedAgentConfig`, which propagates through
 *     `buildSessionConfig → AgentSessionConfig → SDK baseOptions` so the
 *     LLM physically cannot invoke the recursion tool.
 *   - Layer 2: lower the default `maxThreadSessions` from 10 → 3 so the
 *     blast radius is capped if Layer 1 is somehow bypassed.
 *
 * The MCP server is registered as `clawcode` (src/mcp/server.ts:232) and the
 * tool itself as `spawn_subagent_thread` (src/mcp/server.ts:334), giving the
 * SDK-visible name `mcp__clawcode__spawn_subagent_thread` (verified at
 * node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:50,1023,2709).
 */

const RECURSION_TOOL = "mcp__clawcode__spawn_subagent_thread";

/**
 * Build a minimal ResolvedAgentConfig fixture mirroring
 * src/discord/subagent-thread-spawner.test.ts.
 */
function makeAgentConfig(
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    name: "agent-a",
    workspace: "/tmp/agent-a",
    memoryPath: "/tmp/agent-a",
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
    // Phase 999.99 — a REAL resolved primary agent now carries the fleet-wide
    // SDK deny-list (loader.ts resolveAgentConfig surfaces
    // defaults.disallowedTools onto every ResolvedAgentConfig). Mirror that on
    // the fixture so the spawner's UNION has a realistic inherited default to
    // union against — proving a subagent ends up with BOTH the fleet block AND
    // the recursion guard (not the old clobber). The recursion tool itself is
    // NEVER on a primary — it is subagent-scoped only (RG2 pins that).
    disallowedTools: ["ScheduleWakeup", "CronCreate"],
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
    id: "thread-rg",
    name: "test-thread",
    send: vi.fn(),
  };
  const mockChannel = {
    id: "channel-1",
    threads: { create: vi.fn(async () => mockThread) },
    isTextBased: () => true,
  };
  const client = { channels: { fetch: vi.fn(async () => mockChannel) } };
  return {
    client,
    mockChannel,
    mockThread,
    setThreadId(id: string) {
      mockThread.id = id;
    },
  };
}

describe("Phase 99-N — subagent recursion guard (Layer 1: disallowedTools)", () => {
  let tmpDir: string;
  let registryPath: string;
  let sessionManager: ReturnType<typeof makeMockSessionManager>;
  let discordMock: ReturnType<typeof makeMockDiscordClient>;
  let spawner: SubagentThreadSpawner;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "subagent-recursion-guard-"));
    registryPath = join(tmpDir, "thread-bindings.json");
    sessionManager = makeMockSessionManager();
    discordMock = makeMockDiscordClient();

    sessionManager._setConfig("agent-a", makeAgentConfig());

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

  it("RG1: spawnInThread sets disallowedTools containing the recursion tool on the subagent ResolvedAgentConfig handed to startAgent", async () => {
    const config: SubagentThreadConfig = {
      parentAgentName: "agent-a",
      threadName: "rg1-task",
    };

    await spawner.spawnInThread(config);

    expect(sessionManager.startAgent).toHaveBeenCalledOnce();
    const callArgs = sessionManager.startAgent.mock.calls[0]!;
    const subagentConfig = callArgs[1] as ResolvedAgentConfig & {
      disallowedTools?: readonly string[];
    };

    expect(subagentConfig.disallowedTools).toBeDefined();
    expect(subagentConfig.disallowedTools).toContain(RECURSION_TOOL);
    // Phase 999.99 — UNION proof (not clobber): the spawner now UNIONs the
    // inherited fleet default with the recursion guard, so the subagent carries
    // BOTH. Per-member `.toContain` (NOT toEqual/toHaveLength) — union ORDER is
    // an implementation detail and an exact pin would be brittle + flagged by
    // the Task-3 exact-pin grep gate. Before the union this would FAIL: the old
    // clobber overwrote the inherited default, dropping the fleet poll block.
    expect(subagentConfig.disallowedTools).toContain("ScheduleWakeup");
    expect(subagentConfig.disallowedTools).toContain("CronCreate");
    // Finding 3 (260714-mkq review) — start_workflow is ALSO blocked for
    // channel-less subagent-thread sessions: with channels: [], a workflow's
    // postToBoundChannel delivery is dropped by the daemon (no bound channel),
    // so the tool would consume admission-gate slots for a silent result
    // black hole. Same constant the workflow-orchestrator unions into its own
    // workers' disallowedTools.
    expect(subagentConfig.disallowedTools).toContain(
      "mcp__clawcode__start_workflow",
    );
    // Quick 260715-j1j review CR-03 — the NATIVE Workflow tool is blocked on
    // every subagent-thread too (channel-less; stall-kill exposure).
    expect(subagentConfig.disallowedTools).toContain("Workflow");
  });

  it("CR-03 (260715-j1j): subagent of an OPTED-IN (nativeWorkflow) parent has the native Workflow tool blocked and the opt-in flag stripped", async () => {
    // An opted-in parent's resolved list had "Workflow" SUBTRACTED (D5) —
    // simulate that post-subtraction shape plus the opt-in flag.
    sessionManager._setConfig(
      "opted-parent",
      makeAgentConfig({
        name: "opted-parent",
        nativeWorkflow: true,
        disallowedTools: ["ScheduleWakeup", "CronCreate", "AskUserQuestion"],
      } as Partial<ResolvedAgentConfig>),
    );
    const config: SubagentThreadConfig = {
      parentAgentName: "opted-parent",
      threadName: "cr03-task",
    };

    await spawner.spawnInThread(config);

    expect(sessionManager.startAgent).toHaveBeenCalledOnce();
    const callArgs = sessionManager.startAgent.mock.calls[0]!;
    const subagentConfig = callArgs[1] as ResolvedAgentConfig & {
      disallowedTools?: readonly string[];
      nativeWorkflow?: boolean;
    };

    // Tool quarantine: native "Workflow" unioned back despite the parent's
    // D5 subtraction; inherited entries survive (union, not clobber).
    expect(subagentConfig.disallowedTools).toContain("Workflow");
    expect(subagentConfig.disallowedTools).toContain("ScheduleWakeup");
    expect(subagentConfig.disallowedTools).toContain("AskUserQuestion");
    // Flag quarantine: the steer prompt must never claim Workflow is
    // PERMITTED while the deny-list blocks it.
    expect(subagentConfig.nativeWorkflow).not.toBe(true);
  });

  it("RG2: parent agent ResolvedAgentConfig carries EXACTLY the fleet default (ScheduleWakeup+CronCreate) and NOT the recursion tool — the guard is subagent-scoped only", () => {
    // Phase 999.99 — INTENDED pin flip. Before this phase the guard was
    // subagent-scoped only and RG2 pinned "parent has NO disallowedTools".
    // The whole point of Phase 999.99 is that fleet PRIMARY agents now carry a
    // default SDK block (the leaky self-fire tools ScheduleWakeup/CronCreate),
    // surfaced by loader.ts resolveAgentConfig onto every ResolvedAgentConfig.
    // So the parent now carries EXACTLY the fleet default — but STILL NOT the
    // recursion tool, which stays subagent-only (injected by the spawner's
    // union). A primary keeps its full toolbox MINUS the two leaky poll tools.
    const parent = sessionManager.getAgentConfig("agent-a") as ResolvedAgentConfig & {
      disallowedTools?: readonly string[];
    };
    expect(parent.disallowedTools).toEqual(["ScheduleWakeup", "CronCreate"]);
    expect(parent.disallowedTools).not.toContain(RECURSION_TOOL);
  });

  it("RG5: spawnInThread always sets disallowedTools regardless of parent agent identity (Admin Clawdy, fin-client, etc.)", async () => {
    // Admin Clawdy parent
    sessionManager._setConfig(
      "admin-clawdy",
      makeAgentConfig({
        name: "admin-clawdy",
        soul: "Delegate, do not execute. Spawn subagents for any task.",
      }),
    );
    await spawner.spawnInThread({
      parentAgentName: "admin-clawdy",
      threadName: "rg5-admin-task",
    });

    const adminCall = sessionManager.startAgent.mock.calls[0]!;
    const adminSubagentConfig = adminCall[1] as ResolvedAgentConfig & {
      disallowedTools?: readonly string[];
    };
    expect(adminSubagentConfig.disallowedTools).toContain(RECURSION_TOOL);

    // fin-client parent
    discordMock.setThreadId("thread-rg5-fin");
    sessionManager._setConfig(
      "fin-client",
      makeAgentConfig({
        name: "fin-client",
        soul: "Research M&A targets in the financial sector.",
      }),
    );
    await spawner.spawnInThread({
      parentAgentName: "fin-client",
      threadName: "rg5-fin-task",
    });

    const finCall = sessionManager.startAgent.mock.calls[1]!;
    const finSubagentConfig = finCall[1] as ResolvedAgentConfig & {
      disallowedTools?: readonly string[];
    };
    expect(finSubagentConfig.disallowedTools).toContain(RECURSION_TOOL);
  });
});

// -----------------------------------------------------------------------------
// RG3: SDK baseOptions transformation symmetry
// -----------------------------------------------------------------------------
//
// Verifies the SDK-level edit: when AgentSessionConfig carries
// disallowedTools, both `createSession` and `resumeSession` forward it into
// the SDK's baseOptions verbatim. Mirrors the Phase 100 SA1..SA10 pattern at
// src/manager/__tests__/session-adapter.test.ts:1191+ — same vi.mock SDK
// setup, same captured-options assertions.
//
// IMPORTANT: this is a SEPARATE module-load to avoid colliding with the
// existing `vi.mock("@anthropic-ai/claude-agent-sdk")` already declared in
// session-adapter.test.ts. We declare it again here so this test file is
// self-contained.

const mockSdkQuery = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockSdkQuery,
}));

import { SdkSessionAdapter } from "../../manager/session-adapter.js";

function makeSdkConfig(
  overrides: Partial<
    AgentSessionConfig & { disallowedTools?: readonly string[] }
  > = {},
): AgentSessionConfig {
  return {
    name: "test-subagent",
    model: "sonnet",
    effort: "low",
    workspace: "/tmp/sub-workspace",
    systemPrompt: "subagent-stable-prefix",
    channels: [],
    ...overrides,
  } as AgentSessionConfig;
}

function makeMockSdkStream(sessionId: string) {
  async function* gen() {
    yield {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: "ok",
    };
  }
  const query: any = gen();
  query.interrupt = vi.fn();
  query.close = vi.fn();
  query.streamInput = vi.fn();
  query.mcpServerStatus = vi.fn();
  query.setMcpServers = vi.fn();
  return query;
}

describe("Phase 99-N — disallowedTools survives SDK baseOptions transformation", () => {
  let adapter: SdkSessionAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSdkQuery.mockReset();
    adapter = new SdkSessionAdapter();
  });

  it("RG3a: createSession forwards disallowedTools into SDK baseOptions verbatim", async () => {
    mockSdkQuery
      .mockReturnValueOnce(makeMockSdkStream("sess-rg3a"))
      .mockReturnValueOnce(makeMockSdkStream("sess-rg3a"));

    const config = makeSdkConfig({
      disallowedTools: [RECURSION_TOOL],
    });

    await adapter.createSession(config);

    const firstCallOptions = mockSdkQuery.mock.calls[0]![0].options;
    expect(firstCallOptions.disallowedTools).toEqual([RECURSION_TOOL]);
  });

  it("RG3b: resumeSession forwards disallowedTools into SDK baseOptions verbatim (symmetric-edits Rule 3)", async () => {
    mockSdkQuery.mockReturnValueOnce(makeMockSdkStream("sess-rg3b"));

    const config = makeSdkConfig({
      disallowedTools: [RECURSION_TOOL],
    });

    await adapter.resumeSession("existing-sess-rg3b", config);

    const callOptions = mockSdkQuery.mock.calls[0]![0].options;
    expect(callOptions.disallowedTools).toEqual([RECURSION_TOOL]);
  });

  it("RG3c: createSession omits disallowedTools from baseOptions when AgentSessionConfig has none — back-compat for existing fleet (no behavior change for the 15+ agents)", async () => {
    mockSdkQuery
      .mockReturnValueOnce(makeMockSdkStream("sess-rg3c"))
      .mockReturnValueOnce(makeMockSdkStream("sess-rg3c"));

    const config = makeSdkConfig(); // no disallowedTools

    await adapter.createSession(config);

    const firstCallOptions = mockSdkQuery.mock.calls[0]![0].options;
    expect(firstCallOptions.disallowedTools).toBeUndefined();
  });

  it("RG3d: resumeSession omits disallowedTools from baseOptions when AgentSessionConfig has none (mirror of RG3c)", async () => {
    mockSdkQuery.mockReturnValueOnce(makeMockSdkStream("sess-rg3d"));

    const config = makeSdkConfig(); // no disallowedTools

    await adapter.resumeSession("existing-sess-rg3d", config);

    const callOptions = mockSdkQuery.mock.calls[0]![0].options;
    expect(callOptions.disallowedTools).toBeUndefined();
  });

  it("RG3e: createSession omits disallowedTools when the array is explicitly empty — empty-list guard parity with mutableSuffix/settingSources spread-conditional", async () => {
    mockSdkQuery
      .mockReturnValueOnce(makeMockSdkStream("sess-rg3e"))
      .mockReturnValueOnce(makeMockSdkStream("sess-rg3e"));

    const config = makeSdkConfig({ disallowedTools: [] });

    await adapter.createSession(config);

    const firstCallOptions = mockSdkQuery.mock.calls[0]![0].options;
    expect(firstCallOptions.disallowedTools).toBeUndefined();
  });
});
