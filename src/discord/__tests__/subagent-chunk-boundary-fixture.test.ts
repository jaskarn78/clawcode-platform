import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SubagentThreadSpawner } from "../subagent-thread-spawner.js";
import type { SessionManager } from "../../manager/session-manager.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import { wrapMarkdownTablesInCodeFence } from "../markdown-table-wrap.js";
import { splitMessage } from "../webhook-manager.js";

/**
 * Phase 121-02 / Phase 999.36 sub-bug B — chunk-boundary completeness.
 *
 * Pre-fix: editor truncates at slice(0, 1997) + "..." while overflow loop
 * starts at cursor = 2000. Bytes 1997..1999 of the wrapped reply are silently
 * dropped at every chunk seam. This file pins the load-bearing
 * `reconstructed === expected` byte-for-byte invariant so the off-by-3 seam
 * cannot regress.
 */

function makeAgentConfig(): ResolvedAgentConfig {
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
    autoCompactAt: 0.7, // Phase 124 D-06
    memoryAutoLoad: true,
    memoryRetrievalTopK: 5,
    memoryScannerEnabled: true,
    memoryFlushIntervalMs: 900_000,
    memoryCueEmoji: "✅",
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"],
    autoStart: true,
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
    sandbox: { enabled: false, allowRuntimeOp: false },
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
    slashCommands: [],
    reactions: false,
    mcpServers: [],
    webhook: {
      displayName: "Agent A",
      avatarUrl: "https://example.com/a.png",
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
    },
  };
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
    startAgent: vi.fn(async (name: string) => {
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
    _setConfig: (name: string, config: ResolvedAgentConfig) => void;
    streamFromAgent: ReturnType<typeof vi.fn>;
  };
}

type CapturedDiscord = {
  sends: string[];
  edits: string[];
  thread: {
    id: string;
    sendTyping: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
  channel: { id: string; threads: { create: ReturnType<typeof vi.fn> }; isTextBased: () => boolean };
  client: { channels: { fetch: ReturnType<typeof vi.fn> } };
};

function makeCapturingDiscord(): CapturedDiscord {
  const sends: string[] = [];
  const edits: string[] = [];
  const thread = {
    id: "thread-fixture",
    sendTyping: vi.fn(async () => undefined),
    send: vi.fn(async (content: string) => {
      sends.push(content);
      return {
        id: "msg-" + sends.length,
        edit: vi.fn(async (c: string) => {
          edits.push(c);
        }),
      };
    }),
  };
  const channel = {
    id: "channel-1",
    threads: { create: vi.fn(async () => thread) },
    isTextBased: () => true,
  };
  const client = { channels: { fetch: vi.fn(async () => channel) } };
  return { sends, edits, thread, channel, client };
}

async function runSpawn(
  fixture: string,
  registryPath: string,
): Promise<CapturedDiscord> {
  const discord = makeCapturingDiscord();
  const sm = makeMockSessionManager();
  sm._setConfig("agent-a", makeAgentConfig());
  sm.streamFromAgent.mockImplementation(
    async (
      _name: string,
      _prompt: string,
      onChunk: (text: string) => void,
    ) => {
      onChunk(fixture);
      return fixture;
    },
  );

  const spawner = new SubagentThreadSpawner({
    sessionManager: sm,
    heartbeatRunner: makeMockHeartbeatRunner(),
    // Quick task 260520-qo5 — required DI dep; no-op in this fixture
    // test (no LlmRuntime assertions here).
    registerLlmRuntime: () => {},
    registryPath,
    discordClient: discord.client as any,
  });

  await spawner.spawnInThread({
    parentAgentName: "agent-a",
    threadName: "chunk-boundary-fixture",
    autoRelay: false,
  });

  await new Promise((r) => setTimeout(r, 100));
  return discord;
}

describe("subagent chunk-boundary completeness (Phase 121-02 / 999.36 sub-bug B)", () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "chunk-boundary-"));
    registryPath = join(tmpDir, "thread-bindings.json");
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("Test 1 — 4500-char fixture reconstructs byte-for-byte (load-bearing)", async () => {
    const FIXTURE_4500 = "abcdefghij".repeat(450);
    expect(FIXTURE_4500.length).toBe(4500);

    const discord = await runSpawn(FIXTURE_4500, registryPath);

    const finalEdit = discord.edits[discord.edits.length - 1];
    expect(finalEdit).toBeDefined();
    const editorVisible = finalEdit.endsWith("...")
      ? finalEdit.slice(0, -3)
      : finalEdit;

    const overflowChunks = discord.sends.slice(1);
    const reconstructed = editorVisible + overflowChunks.join("");

    const expected = wrapMarkdownTablesInCodeFence(FIXTURE_4500.trim());
    expect(reconstructed).toBe(expected);
  });

  it("Test 2 — 2003-char fixture: exact off-by-3 detector", async () => {
    const FIXTURE_2003 = "x".repeat(2003);

    const discord = await runSpawn(FIXTURE_2003, registryPath);

    const finalEdit = discord.edits[discord.edits.length - 1];
    expect(finalEdit).toBeDefined();
    expect(finalEdit.endsWith("...")).toBe(true);
    const editorVisible = finalEdit.slice(0, -3);
    expect(editorVisible).toBe("x".repeat(1997));

    const overflowChunks = discord.sends.slice(1);
    expect(overflowChunks).toHaveLength(1);
    expect(overflowChunks[0]).toBe("x".repeat(6));

    const reconstructed = editorVisible + overflowChunks.join("");
    expect(reconstructed).toBe("x".repeat(2003));
  });

  it("Test 3 — 1500-char fixture: no overflow path exercised", async () => {
    const FIXTURE_1500 = "y".repeat(1500);

    const discord = await runSpawn(FIXTURE_1500, registryPath);

    const finalEdit = discord.edits[discord.edits.length - 1];
    expect(finalEdit).toBeDefined();
    expect(finalEdit).toBe(FIXTURE_1500);
    expect(finalEdit.endsWith("...")).toBe(false);

    const overflowChunks = discord.sends.slice(1);
    expect(overflowChunks).toHaveLength(0);
  });

  it("SC-4 sibling audit — webhook-manager splitMessage has no off-by-3 seam at the 2003-char boundary", () => {
    const FIXTURE_2003 = "x".repeat(2003);
    const chunks = splitMessage(FIXTURE_2003, 2000);
    const reconstructed = chunks.join("");
    expect(reconstructed).toBe(FIXTURE_2003);
    expect(reconstructed.length).toBe(2003);
  });
});
