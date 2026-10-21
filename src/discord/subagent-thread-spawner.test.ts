import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  SubagentThreadSpawner,
  resolveArtifactRoot,
  discoverArtifactPaths,
  isRealSubagentContent,
  SUBAGENT_WORKING_PLACEHOLDER,
} from "./subagent-thread-spawner.js";
import type { SubagentThreadConfig } from "./subagent-thread-types.js";
import type { SessionManager } from "../manager/session-manager.js";
import type { ResolvedAgentConfig } from "../shared/types.js";
import { readThreadRegistry, writeThreadRegistry } from "./thread-registry.js";
import { ChannelReplyTimeoutError } from "../manager/agent-channel-bridge.js";
import type {
  AckInput,
  DaemonChannelMessage,
} from "../channels/clawcode-channel-server.js";

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
 * Create a mock SessionManager with the methods SubagentThreadSpawner needs.
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
    // Phase 999.19 — delegated-work consolidation embeds via this accessor.
    embedText: vi.fn(async () => new Float32Array(384)),
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

/**
 * Phase 999.57 — minimal HeartbeatRunner mock. The spawner's only contact
 * with the runner is `setAgentConfigs([subagentConfig])` immediately after
 * `sessionManager.startAgent`. We spy on that call so behavior tests can
 * assert the subagent's heartbeat-disabled config was registered.
 */
function makeMockHeartbeatRunner() {
  const mock = {
    setAgentConfigs: vi.fn(),
  };
  return mock as unknown as import("../heartbeat/runner.js").HeartbeatRunner & {
    setAgentConfigs: ReturnType<typeof vi.fn>;
  };
}

/**
 * Quick task 260520-qo5 — minimal registerLlmRuntime mock. The spawner
 * invokes this callback with the generated subagent session name, the
 * subagent ResolvedAgentConfig, and the parent agent name, immediately
 * BEFORE `sessionManager.startAgent`. We spy on the call so behavior
 * tests can assert (a) it was invoked with the right args and (b) it
 * ran before startAgent (the 138-04 regression ordering contract).
 */
function makeMockRegisterLlmRuntime() {
  return vi.fn<
    (
      sessionName: string,
      subagentConfig: ResolvedAgentConfig,
      parentAgentName: string,
      // Phase 999.83-02 (Fix A) — optional first-turn input (the subagent's
      // task). Spawner passes `{ firstTurnInput: config.task }` only for a v3
      // subagent with a non-empty task; absent otherwise.
      opts?: { firstTurnInput?: string },
    ) => void
  >();
}

/**
 * Create a mock Discord client with channels.fetch returning a mock channel.
 */
function makeMockDiscordClient() {
  const mockThread = {
    id: "thread-123",
    name: "test-thread",
    send: vi.fn(),
  };

  const mockChannel = {
    id: "channel-1",
    threads: {
      create: vi.fn(async () => mockThread),
    },
    isTextBased: () => true,
  };

  const client = {
    channels: {
      fetch: vi.fn(async () => mockChannel),
    },
  };

  return {
    client,
    mockChannel,
    mockThread,
    setThreadId(id: string) {
      mockThread.id = id;
    },
  };
}

describe("SubagentThreadSpawner", () => {
  let tmpDir: string;
  let registryPath: string;
  let sessionManager: ReturnType<typeof makeMockSessionManager>;
  let discordMock: ReturnType<typeof makeMockDiscordClient>;
  let spawner: SubagentThreadSpawner;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "subagent-spawner-"));
    registryPath = join(tmpDir, "thread-bindings.json");
    sessionManager = makeMockSessionManager();
    discordMock = makeMockDiscordClient();

    const agentConfig = makeAgentConfig({
      webhook: {
        displayName: "Agent A",
        avatarUrl: "https://example.com/avatar.png",
        webhookUrl: "https://discord.com/api/webhooks/123/abc",
      },
    });
    sessionManager._setConfig("agent-a", agentConfig);

    spawner = new SubagentThreadSpawner({
      sessionManager,
      heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
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

  describe("spawnInThread", () => {
    it("creates a Discord thread, starts subagent session, persists binding, and returns SubagentSpawnResult", async () => {
      const config: SubagentThreadConfig = {
        parentAgentName: "agent-a",
        threadName: "research-task",
      };

      const result = await spawner.spawnInThread(config);

      // Discord thread was created
      expect(discordMock.mockChannel.threads.create).toHaveBeenCalledOnce();
      expect(discordMock.mockChannel.threads.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "research-task",
          autoArchiveDuration: 1440,
        }),
      );

      // Session was started
      expect(sessionManager.startAgent).toHaveBeenCalledOnce();

      // Result has correct shape
      expect(result.threadId).toBe("thread-123");
      expect(result.parentAgent).toBe("agent-a");
      expect(result.channelId).toBe("channel-1");
      expect(result.sessionName).toMatch(/^agent-a-sub-/);

      // Binding was persisted
      const registry = await readThreadRegistry(registryPath);
      expect(registry.bindings).toHaveLength(1);
      expect(registry.bindings[0].threadId).toBe("thread-123");
      expect(registry.bindings[0].agentName).toBe("agent-a");
      expect(registry.bindings[0].sessionName).toBe(result.sessionName);
    });

    it("registers an LlmRuntime resolver for the subagent session name BEFORE startAgent (qo5 / 138-04 regression)", async () => {
      // Quick task 260520-qo5 — 138-04 (commit 0be63e0) made daemon.ts
      // getLlmRuntime() throw for unregistered agent names. Subagent
      // session names are never in the boot-populated llmRuntimeRegistry,
      // so the spawner must register a resolver for the session name
      // before startAgent triggers the SdkSessionAdapter -> getLlmRuntime
      // lookup. This test pins both the invocation args and the ordering.
      const registerLlmRuntime = makeMockRegisterLlmRuntime();
      const localSpawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime,
        registryPath,
        discordClient: discordMock.client as any,
      });

      const result = await localSpawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "qo5-task",
      });

      // (a) Invoked exactly once with the subagent session name, the
      // subagent config, and the parent agent name.
      expect(registerLlmRuntime).toHaveBeenCalledOnce();
      const [sessionName, subagentConfig, parentAgentName] =
        registerLlmRuntime.mock.calls[0];
      expect(sessionName).toBe(result.sessionName);
      expect(parentAgentName).toBe("agent-a");
      // The config passed to registerLlmRuntime is the same object handed
      // to startAgent (referential identity) and carries the session name.
      const startedConfig = sessionManager.startAgent.mock
        .calls[0][1] as ResolvedAgentConfig;
      expect(subagentConfig).toBe(startedConfig);
      expect((subagentConfig as ResolvedAgentConfig).name).toBe(
        result.sessionName,
      );

      // (b) registerLlmRuntime ran BEFORE startAgent — the resolver must
      // already exist when SdkSessionAdapter.loadSdkModule() resolves the
      // runtime. Compare vi.fn invocationCallOrder.
      const registerOrder = registerLlmRuntime.mock.invocationCallOrder[0];
      const startOrder =
        sessionManager.startAgent.mock.invocationCallOrder[0];
      expect(registerOrder).toBeLessThan(startOrder);
    });

    // ── Phase 999.82-03: dynamic subagent channel lifecycle ──────────────────

    it("wires the subagent channel BEFORE startAgent (999.82-03 ordering)", async () => {
      // The subagent's Stop/PostToolUse hooks must find a listening socket the
      // moment its session boots — so the wire MUST happen before startAgent.
      const wireChannelForSubagent = vi.fn((_cfg: ResolvedAgentConfig) => ({}));
      const localSpawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordMock.client as any,
        wireChannelForSubagent,
      });

      await localSpawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "wire-order-task",
      });

      expect(wireChannelForSubagent).toHaveBeenCalledOnce();
      // The wired config is the SAME object handed to startAgent and carries
      // the subagent session name (so CLAWCODE_AGENT_NAME routes to it).
      const wiredConfig = wireChannelForSubagent.mock
        .calls[0][0] as ResolvedAgentConfig;
      const startedConfig = sessionManager.startAgent.mock
        .calls[0][1] as ResolvedAgentConfig;
      expect(wiredConfig).toBe(startedConfig);

      // Ordering: wire ran BEFORE startAgent.
      const wireOrder = wireChannelForSubagent.mock.invocationCallOrder[0];
      const startOrder =
        sessionManager.startAgent.mock.invocationCallOrder[0];
      expect(wireOrder).toBeLessThan(startOrder);
    });

    it("sets CLAWCODE_AGENT_NAME routing identity = subagent session name (subagentConfig.name)", async () => {
      // The v3 backend derives CLAWCODE_AGENT_NAME from config.name
      // (buildV3SpawnEnv(stateDir, this.config.name)). Pin that the spawner
      // hands startAgent a config whose .name IS the subagent session name, so
      // its hook frames route to the subagent bridge, not the parent.
      const result = await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "hook-routing-task",
      });
      const startedConfig = sessionManager.startAgent.mock
        .calls[0][1] as ResolvedAgentConfig;
      expect(startedConfig.name).toBe(result.sessionName);
      expect(result.sessionName).not.toBe("agent-a"); // not the parent
    });

    it("does not blow up when wire/unwire callbacks are omitted (v2 / test compat)", async () => {
      // The 86 scar-tissue tests construct the spawner without the callbacks;
      // a guarded `?.()` call must be a clean no-op.
      const result = await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "no-callbacks-task",
      });
      expect(result.sessionName).toMatch(/^agent-a-sub-/);
      expect(sessionManager.startAgent).toHaveBeenCalledOnce();
    });

    it("tears down the subagent channel on cleanup (once, with the session name)", async () => {
      const unwireChannelForSubagent = vi.fn(async (_name: string) => {});
      const localSpawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordMock.client as any,
        unwireChannelForSubagent,
      });

      const result = await localSpawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "teardown-task",
      });
      await new Promise((r) => setTimeout(r, 50));

      await localSpawner.cleanupSubagentThread(result.threadId);

      expect(unwireChannelForSubagent).toHaveBeenCalledOnce();
      expect(unwireChannelForSubagent).toHaveBeenCalledWith(result.sessionName);

      // A second cleanup (binding already removed) is a clean no-op — the
      // teardown does not re-fire, and the spawner does not throw. Combined
      // with the registry's idempotent unwireForAgent, this is the
      // double-teardown safety the lifecycle pinch depends on (the
      // auto-archive stop path + a later cleanup can both target one name).
      await localSpawner.cleanupSubagentThread(result.threadId);
      expect(unwireChannelForSubagent).toHaveBeenCalledOnce();
    });

    it("999.98-fu — accepts model: 'fable' for the subagent thread (Category C widen)", async () => {
      // The spawn `model` param wins over subagentModel/parent model (spawner:1279).
      const config = makeAgentConfig({ model: "sonnet", subagentModel: undefined });
      sessionManager._setConfig("agent-a", config);

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "fable-task",
        model: "fable",
      });

      const sessionConfig = sessionManager.startAgent.mock.calls[0][1] as ResolvedAgentConfig;
      expect(sessionConfig.model).toBe("fable");
    });

    it("uses parent's subagentModel for session config, defaulting to parent model if not set", async () => {
      // First: with subagentModel set
      const configWithSubmodel = makeAgentConfig({
        subagentModel: "haiku",
      });
      sessionManager._setConfig("agent-a", configWithSubmodel);

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "task-1",
      });

      const callArgs1 = sessionManager.startAgent.mock.calls[0];
      const sessionConfig1 = callArgs1[1] as ResolvedAgentConfig;
      expect(sessionConfig1.model).toBe("haiku");

      // Reset and test without subagentModel
      vi.mocked(sessionManager.startAgent).mockClear();
      const configNoSubmodel = makeAgentConfig({
        subagentModel: undefined,
        model: "opus",
      });
      sessionManager._setConfig("agent-a", configNoSubmodel);

      discordMock.setThreadId("thread-456");

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "task-2",
      });

      const callArgs2 = sessionManager.startAgent.mock.calls[0];
      const sessionConfig2 = callArgs2[1] as ResolvedAgentConfig;
      expect(sessionConfig2.model).toBe("opus");
    });

    it("injects thread context into subagent soul including threadId, threadName, parentChannelId, and parentAgent", async () => {
      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "research-task",
      });

      const callArgs = sessionManager.startAgent.mock.calls[0];
      const sessionConfig = callArgs[1] as ResolvedAgentConfig;

      expect(sessionConfig.soul).toContain("thread-123");
      expect(sessionConfig.soul).toContain("research-task");
      expect(sessionConfig.soul).toContain("channel-1");
      expect(sessionConfig.soul).toContain("agent-a");
      expect(sessionConfig.soul).toContain("Subagent Thread Context");
    });

    it("respects maxThreadSessions limit from parent config and throws when exceeded", async () => {
      const config = makeAgentConfig({
        threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 1 },
        webhook: {
          displayName: "Agent A",
          webhookUrl: "https://discord.com/api/webhooks/123/abc",
        },
      });
      sessionManager._setConfig("agent-a", config);

      // First spawn succeeds
      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "task-1",
      });

      // Second spawn should throw
      discordMock.setThreadId("thread-456");
      await expect(
        spawner.spawnInThread({
          parentAgentName: "agent-a",
          threadName: "task-2",
        }),
      ).rejects.toThrow(/max.*thread.*sessions/i);
    });

    it("creates webhook identity with display name '{parentAgent}-sub-{shortId}' when parent has webhookUrl", async () => {
      const result = await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "research-task",
      });

      const callArgs = sessionManager.startAgent.mock.calls[0];
      const sessionConfig = callArgs[1] as ResolvedAgentConfig;

      // Webhook identity should be set with a subagent-specific display name
      expect(sessionConfig.webhook).toBeDefined();
      expect(sessionConfig.webhook?.displayName).toMatch(/^agent-a-sub-/);
      expect(sessionConfig.webhook?.webhookUrl).toBe(
        "https://discord.com/api/webhooks/123/abc",
      );
    });
  });

  // ── Phase 999.82-04: v3 subagent channel dispatch ────────────────────────
  //
  // A v3 (`claude-code-interactive`) subagent's turn runs in its OWN
  // `claude --channels` process; the spawner can no longer drive it via the
  // v2 `streamFromAgent` SDK iterate (an inert v3 Query → no tokens → Phase 127
  // stall false-trip → "wedge", SPEC §Root cause). Instead it dispatches over
  // the subagent's ClawCode channel exactly like the parent chat: push the task
  // with a reply_correlation_id, register a thread-bound progress callback, then
  // awaitReply for the final string (resolved by clawcode_ack OR the Stop-hook
  // turn_complete fallback). These tests pin that branch + prove the v2 path is
  // untouched + the reply flows through the 999.36/999.59 machinery.
  describe("v3 channel dispatch (999.82-04)", () => {
    /**
     * A minimal v3 channel bridge stub. `awaitReply` is a controllable deferred
     * so a test can stream progress frames BEFORE the final reply resolves.
     */
    function makeBridgeStub(opts?: { result?: string; reject?: Error }) {
      let progressCb: ((text: string) => void) | undefined;
      let resolveReply: ((v: AckInput) => void) | undefined;
      let rejectReply: ((e: Error) => void) | undefined;
      const replyPromise = new Promise<AckInput>((res, rej) => {
        resolveReply = res;
        rejectReply = rej;
      });
      const bridge = {
        push: vi.fn((_msg: DaemonChannelMessage) => {}),
        awaitReply: vi.fn(
          (_correlationId: string, _timeoutMs?: number) => replyPromise,
        ),
        registerProgressCallback: vi.fn((cb: (text: string) => void) => {
          progressCb = cb;
        }),
        clearProgressCallback: vi.fn(() => {
          progressCb = undefined;
        }),
      };
      return {
        bridge,
        emitProgress: (text: string) => progressCb?.(text),
        settle: () => {
          if (opts?.reject) rejectReply?.(opts.reject);
          else
            resolveReply?.({
              message_id: "ack-msg",
              status: "processed",
              result: opts?.result ?? "",
            });
        },
        currentProgressCb: () => progressCb,
      };
    }

    /**
     * Phase 999.82-04 (live-canary fix) — a channel listener stub whose
     * `isConnected()` is controllable. `connectedAfter` polls of false, then
     * true; or `never: true` to stay disconnected forever (ceiling-hit case).
     */
    function makeListenerStub(opts?: { connectedAfter?: number; never?: boolean }) {
      let calls = 0;
      const isConnected = vi.fn(() => {
        calls++;
        if (opts?.never) return false;
        return calls > (opts?.connectedAfter ?? 0);
      });
      return { listener: { isConnected }, isConnected };
    }

    /** An edit-capable Discord thread surface (canEdit=true). */
    function makeEditableThread(id = "thread-v3") {
      const sent: string[] = [];
      const edits: string[] = [];
      const placeholder = {
        id: "msg-placeholder",
        edit: vi.fn(async (content: string) => {
          edits.push(content);
        }),
      };
      const mockThread = {
        id,
        send: vi.fn(async (content: string) => {
          sent.push(content);
          return placeholder;
        }),
      };
      const mockChannel = {
        id: "channel-1",
        threads: { create: vi.fn(async () => mockThread) },
        isTextBased: () => true,
      };
      return {
        client: { channels: { fetch: vi.fn(async () => mockChannel) } },
        mockThread,
        placeholder,
        sent,
        edits,
      };
    }

    function makeV3SessionManager() {
      const sm = makeMockSessionManager();
      sm._setConfig(
        "agent-a",
        makeAgentConfig({
          webhook: {
            displayName: "Agent A",
            avatarUrl: "https://example.com/a.png",
            webhookUrl: "https://discord.com/api/webhooks/123/abc",
          },
        }),
      );
      return sm;
    }

    it("DISP-1 — v3 subagent dispatches over the channel (push + awaitReply), NOT streamFromAgent", async () => {
      const { bridge, settle } = makeBridgeStub({ result: "v3 deliverable" });
      const { client, mockThread } = makeEditableThread();
      const sm = makeV3SessionManager();

      const spawner = new SubagentThreadSpawner({
        sessionManager: sm,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: client as any,
        // The registry's backend gate returns the wired channel (with .bridge)
        // for a v3 config — here we simulate that with the stub bridge.
        wireChannelForSubagent: () => ({ bridge }),
      });

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "v3-dispatch",
        task: "do the thing",
        autoRelay: false,
      });

      // Let postInitialMessage reach the push + awaitReply, then resolve.
      await new Promise((r) => setTimeout(r, 20));
      settle();
      await new Promise((r) => setTimeout(r, 50));

      // Channel dispatch fired: push once with a reply_correlation_id, awaited.
      expect(bridge.push).toHaveBeenCalledOnce();
      const pushed = bridge.push.mock.calls[0][0] as {
        type: string;
        message_id: string;
        content: string;
        meta?: { reply_correlation_id?: string };
      };
      expect(pushed.type).toBe("a2a");
      // Phase 999.83-02 (Fix A + T-999.83-02-DBL) — the task is delivered as the
      // PTY input, so the channel push is correlation-only. 141-FIX (2026-06-02):
      // content is a non-empty HOLD notice (not "") so an a2a turn can never read
      // as an empty "no task"; it still carries NO task text → no double-run.
      // (Detailed pin below in "push content suppressed under firstTurnInput".)
      expect(pushed.content).toContain("Correlation handle only");
      expect(pushed.meta?.reply_correlation_id).toBe(pushed.message_id);
      expect(bridge.awaitReply).toHaveBeenCalledOnce();
      expect(bridge.awaitReply.mock.calls[0][0]).toBe(pushed.message_id);
      // Generous deadline (the timeout that replaces the wedge class).
      expect(bridge.awaitReply.mock.calls[0][1]).toBe(600_000);

      // The v2 SDK iterate path is NOT used on the v3 branch.
      expect(sm.streamFromAgent).not.toHaveBeenCalled();

      // The reply reached the thread (backstop edit of the placeholder).
      const edits = mockThread.send.mock.results.length;
      expect(edits).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // Phase 999.83-02 (Fix A + Fix B) — the task is delivered as the backend's
    // first-turn PTY input; the channel push is correlation-only.
    // -----------------------------------------------------------------------
    it("DISP-8 (999.83-02) — threads the task to the runtime registration as firstTurnInput", async () => {
      const { bridge } = makeBridgeStub({ result: "ok" });
      const { client } = makeEditableThread();
      const sm = makeV3SessionManager();
      const registerLlmRuntime = makeMockRegisterLlmRuntime();

      const spawner = new SubagentThreadSpawner({
        sessionManager: sm,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime,
        registryPath,
        discordClient: client as any,
        wireChannelForSubagent: () => ({ bridge }),
      });

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "v3-firstturn",
        task: "publish the release notes",
        autoRelay: false,
      });

      // The 4th arg carries the RAW task as firstTurnInput so the backend
      // delivers it as the agent's first real PTY turn-trigger.
      expect(registerLlmRuntime).toHaveBeenCalledOnce();
      const fourthArg = registerLlmRuntime.mock.calls[0]?.[3];
      expect(fourthArg).toEqual({ firstTurnInput: "publish the release notes" });
    });

    it("DISP-9 (999.83-02) — reply path preserved: push (a2a) + awaitReply(…, 600_000) still fire", async () => {
      const { bridge, settle } = makeBridgeStub({ result: "done" });
      const { client } = makeEditableThread();
      const sm = makeV3SessionManager();

      const spawner = new SubagentThreadSpawner({
        sessionManager: sm,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: client as any,
        wireChannelForSubagent: () => ({ bridge }),
      });

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "v3-reply-preserved",
        task: "do work",
        autoRelay: false,
      });
      await new Promise((r) => setTimeout(r, 20));
      settle();
      await new Promise((r) => setTimeout(r, 50));

      // Fix A does NOT remove the channel reply correlation.
      expect(bridge.push).toHaveBeenCalledOnce();
      expect(bridge.push.mock.calls[0][0].type).toBe("a2a");
      expect(bridge.awaitReply).toHaveBeenCalledOnce();
      expect(bridge.awaitReply.mock.calls[0][1]).toBe(600_000);
    });

    it("DISP-10 (999.83-02) — push content suppressed under firstTurnInput (T-999.83-02-DBL)", async () => {
      const { bridge, settle } = makeBridgeStub({ result: "done" });
      const { client } = makeEditableThread();
      const sm = makeV3SessionManager();

      const spawner = new SubagentThreadSpawner({
        sessionManager: sm,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: client as any,
        wireChannelForSubagent: () => ({ bridge }),
      });

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "v3-dbl-safety",
        task: "gh pr create --title x",
        autoRelay: false,
      });
      await new Promise((r) => setTimeout(r, 20));
      settle();
      await new Promise((r) => setTimeout(r, 50));

      const pushed = bridge.push.mock.calls[0][0] as {
        content: string;
        message_id: string;
        meta?: { reply_correlation_id?: string };
      };
      // The task text is NOT in the push content — the PTY input is the sole
      // task carrier; a notification that surfaces a turn cannot re-run it.
      // 141-FIX (2026-06-02): the push carries a non-empty HOLD notice (not "")
      // so an a2a turn can never read as an empty "no task" — but it still
      // carries NO task text, preserving the no-double-run guarantee.
      expect(pushed.content).toContain("Correlation handle only");
      expect(pushed.content).not.toContain("gh pr create");
      // …but correlation is intact (ack / awaitReply still resolve).
      expect(pushed.message_id.length).toBeGreaterThan(0);
      expect(pushed.meta?.reply_correlation_id).toBe(pushed.message_id);
    });

    it("DISP-11 (999.83-02) — a no-task subagent omits firstTurnInput", async () => {
      const { bridge } = makeBridgeStub({ result: "hi" });
      const { client } = makeEditableThread();
      const sm = makeV3SessionManager();
      const registerLlmRuntime = makeMockRegisterLlmRuntime();

      const spawner = new SubagentThreadSpawner({
        sessionManager: sm,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime,
        registryPath,
        discordClient: client as any,
        wireChannelForSubagent: () => ({ bridge }),
      });

      // No `task` → the self-introduction prompt path; the backend keeps the
      // default \r warm-nudge (no PTY task delivery).
      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "v3-no-task",
        autoRelay: false,
      });

      expect(registerLlmRuntime).toHaveBeenCalledOnce();
      const fourthArg = registerLlmRuntime.mock.calls[0]?.[3];
      // Either the 4th arg is absent OR firstTurnInput is undefined.
      expect(fourthArg?.firstTurnInput).toBeUndefined();
    });

    it("DISP-2 — registers a progress callback BEFORE push; a tool-using turn streams into the placeholder editor", async () => {
      const { bridge, emitProgress, settle, currentProgressCb } =
        makeBridgeStub({ result: "final answer" });
      const { client, placeholder } = makeEditableThread();
      const sm = makeV3SessionManager();

      const spawner = new SubagentThreadSpawner({
        sessionManager: sm,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: client as any,
        wireChannelForSubagent: () => ({ bridge }),
      });

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "v3-stream",
        task: "stream me",
        autoRelay: false,
      });
      await new Promise((r) => setTimeout(r, 20));

      // Callback registered BEFORE push (frames arriving pre-registration lost).
      expect(bridge.registerProgressCallback).toHaveBeenCalledOnce();
      const regOrder =
        bridge.registerProgressCallback.mock.invocationCallOrder[0];
      const pushOrder = bridge.push.mock.invocationCallOrder[0];
      expect(regOrder).toBeLessThan(pushOrder);
      expect(currentProgressCb()).toBeTypeOf("function");

      // A tool-using turn emits progress frames → the placeholder editor edits.
      emitProgress("partial progress text from a tool-using turn");
      // ProgressiveMessageEditor holds the first edit for firstEditMinDelayMs
      // (1500ms); wait past it so the edit lands.
      await new Promise((r) => setTimeout(r, 1700));
      expect(placeholder.edit).toHaveBeenCalled();

      settle();
      await new Promise((r) => setTimeout(r, 50));

      // Cleared in finally (no stale closure across turns).
      expect(bridge.clearProgressCallback).toHaveBeenCalled();
      expect(currentProgressCb()).toBeUndefined();
    });

    it("DISP-3 — a tool-less turn (no progress frames) degrades to one final reply via the backstop edit", async () => {
      const { bridge, settle } = makeBridgeStub({
        result: "single final reply, no tools",
      });
      const { client, placeholder } = makeEditableThread();
      const sm = makeV3SessionManager();

      const spawner = new SubagentThreadSpawner({
        sessionManager: sm,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: client as any,
        wireChannelForSubagent: () => ({ bridge }),
      });

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "v3-toolless",
        task: "answer quickly",
        autoRelay: false,
      });
      await new Promise((r) => setTimeout(r, 20));
      // NO emitProgress — tool-less turn.
      settle();
      await new Promise((r) => setTimeout(r, 50));

      // The editor never fired (no progress frames) → backstop edit writes the
      // final reply into the placeholder (the 999.36 buffered-reply guarantee).
      expect(placeholder.edit).toHaveBeenCalledOnce();
      expect(placeholder.edit.mock.calls[0][0]).toContain(
        "single final reply, no tools",
      );
      expect(sm.streamFromAgent).not.toHaveBeenCalled();
    });

    it("DISP-4 — a >2000-char channel reply flows through the overflow chunker (999.59 deliverable-loss guard)", async () => {
      const big = "Y".repeat(5000);
      const { bridge, settle } = makeBridgeStub({ result: big });
      const { client, mockThread, placeholder } = makeEditableThread(
        "thread-v3-overflow",
      );
      const sm = makeV3SessionManager();

      const spawner = new SubagentThreadSpawner({
        sessionManager: sm,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: client as any,
        wireChannelForSubagent: () => ({ bridge }),
      });

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "v3-overflow",
        task: "produce a big table",
        autoRelay: false,
      });
      await new Promise((r) => setTimeout(r, 20));
      settle();
      await new Promise((r) => setTimeout(r, 60));

      // Placeholder holds the first 2000; the tail rides thread.send chunks.
      expect(placeholder.edit).toHaveBeenCalled();
      // mockThread.send: 1 for the placeholder + N overflow chunks. >2000 reply
      // must produce at least one overflow chunk beyond the placeholder send.
      expect(mockThread.send.mock.calls.length).toBeGreaterThan(1);
    });

    it("DISP-7 — 999.59 invariant on the channel path: a LONG mid-stream progress block then a SHORT final reply still delivers the full stream", async () => {
      // 999.59 production failure: a research subagent emitted a long table
      // mid-stream then closed with a short "Research complete." final block.
      // `fullContent = longer(accumulatedSeen, reply)` must pick the LONG
      // accumulated stream, not the short final, so the overflow chunker fires
      // and the deliverable is not silently truncated. This pins that the
      // longer-of-two logic survives on the channel-reply source.
      const longProgress = "Z".repeat(3500); // > 2000 → must overflow-chunk
      const { bridge, emitProgress, settle } = makeBridgeStub({
        result: "Research complete.", // short final block
      });
      const { client, mockThread, placeholder } = makeEditableThread(
        "thread-v3-959",
      );
      const sm = makeV3SessionManager();

      const spawner = new SubagentThreadSpawner({
        sessionManager: sm,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: client as any,
        wireChannelForSubagent: () => ({ bridge }),
      });

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "v3-959",
        task: "produce a long table then a short closer",
        autoRelay: false,
      });
      await new Promise((r) => setTimeout(r, 20));
      // Long mid-stream block accumulates...
      emitProgress(longProgress);
      // ...then the channel reply resolves with a SHORT final string.
      settle();
      await new Promise((r) => setTimeout(r, 60));

      // fullContent picks the LONG accumulated stream → overflow chunker fires
      // (placeholder + tail chunks). The short final block did NOT shrink the
      // delivered content (the 999.59 guarantee).
      expect(placeholder.edit).toHaveBeenCalled();
      // Overflow tail chunks were sent (placeholder send + ≥1 overflow chunk).
      expect(mockThread.send.mock.calls.length).toBeGreaterThan(1);
      // The total Z volume delivered to the thread (placeholder edit + overflow
      // tail chunks) reflects the LONG accumulated stream (3500 Z), not the
      // short "Research complete." final. If `fullContent` had picked the short
      // reply, the overflow chunker would not have fired and only ~18 chars
      // would have reached the thread.
      const deliveredZ = [
        ...placeholder.edit.mock.calls.map((c) => c[0] as string),
        ...mockThread.send.mock.calls.map((c) => c[0] as string),
      ]
        .join("")
        .split("")
        .filter((ch) => ch === "Z").length;
      // Allow for editor truncation of the placeholder (1997) but require that
      // the full 3500-Z stream's overflow tail was delivered (well over the
      // 2000 single-message ceiling).
      expect(deliveredZ).toBeGreaterThanOrEqual(3500);
    });

    it("DISP-8 — live-canary fix: dispatch WAITS for listener.isConnected() before push (cold-channel race)", async () => {
      // The live gate3 canary failure: the subagent's channel connects lazily
      // (~6s post-spawn). Pushing before then hits a cold DaemonSocketListener
      // whose send() drops silently → awaitReply times out at 600s. The fix
      // polls isConnected() until true, THEN pushes.
      const { bridge, settle } = makeBridgeStub({ result: "connected reply" });
      // Disconnected for the first 2 polls, then connected.
      const { listener, isConnected } = makeListenerStub({ connectedAfter: 2 });
      const { client } = makeEditableThread("thread-v3-connect");
      const sm = makeV3SessionManager();

      const spawner = new SubagentThreadSpawner({
        sessionManager: sm,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: client as any,
        wireChannelForSubagent: () => ({ bridge, listener }),
        // Fast poll so the test doesn't sit on real 250ms ticks.
        connectPollMs: 5,
        connectCeilingMs: 2000,
      });

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "v3-connect-wait",
        task: "wait for connect then dispatch",
        autoRelay: false,
      });
      // Let the poll loop run past the 2 disconnected polls + connect.
      await new Promise((r) => setTimeout(r, 60));

      // isConnected() was polled (not connected immediately) and push fired
      // ONLY AFTER it flipped — register + push happen after the wait.
      expect(isConnected.mock.calls.length).toBeGreaterThan(1);
      expect(bridge.push).toHaveBeenCalledOnce();
      const regOrder =
        bridge.registerProgressCallback.mock.invocationCallOrder[0];
      const lastConnectOrder =
        isConnected.mock.invocationCallOrder[
          isConnected.mock.invocationCallOrder.length - 1
        ];
      // The connect check that returned true ran BEFORE register+push.
      expect(lastConnectOrder).toBeLessThan(regOrder);

      settle();
      await new Promise((r) => setTimeout(r, 30));
    });

    it("DISP-9 — live-canary fix: channel that never connects fails the dispatch (push NOT called, parent notified, no crash)", async () => {
      const { bridge } = makeBridgeStub({ result: "never reached" });
      const { listener, isConnected } = makeListenerStub({ never: true });
      // Parent channel the failed-turn notice posts to.
      const parentSend = vi.fn(async (_c: string) => {});
      const parentChannel = { id: "parent-chan", send: parentSend };
      const placeholder = { id: "msg-ph", edit: vi.fn(async () => {}) };
      const mockThread = {
        id: "thread-v3-noconnect",
        send: vi.fn(async () => placeholder),
      };
      const mockChannel = {
        id: "channel-1",
        threads: { create: vi.fn(async () => mockThread) },
        isTextBased: () => true,
      };
      const client = {
        channels: {
          fetch: vi.fn(async (id: string) =>
            id === "parent-chan" ? parentChannel : mockChannel,
          ),
        },
      };
      const sm = makeV3SessionManager();

      const spawner = new SubagentThreadSpawner({
        sessionManager: sm,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: client as any,
        wireChannelForSubagent: () => ({ bridge, listener }),
        connectPollMs: 5,
        connectCeilingMs: 40, // hit the ceiling fast (a few polls)
      });

      const result = await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "v3-noconnect",
        task: "this channel never connects",
        autoRelay: false,
      });
      const reg = await readThreadRegistry(registryPath);
      await writeThreadRegistry(registryPath, {
        ...reg,
        bindings: reg.bindings.map((b) =>
          b.threadId === result.threadId
            ? { ...b, parentChannelId: "parent-chan" }
            : b,
        ),
      });
      // Wait past the ceiling so the connect-wait fails and the catch runs.
      await new Promise((r) => setTimeout(r, 120));

      // The ceiling was hit (polled) and the task was NEVER pushed into the void.
      expect(isConnected).toHaveBeenCalled();
      expect(bridge.push).not.toHaveBeenCalled();
      expect(bridge.awaitReply).not.toHaveBeenCalled();
      // No progress callback registered for a turn that never dispatched.
      expect(bridge.registerProgressCallback).not.toHaveBeenCalled();
      // Handled as a failed turn: parent notified, no crash.
      expect(parentSend).toHaveBeenCalled();
      expect(parentSend.mock.calls[0][0]).toMatch(/did not respond within/i);
    });

    it("DISP-5 — a v2 subagent (no bridge) keeps the streamFromAgent path UNCHANGED", async () => {
      const { client } = makeEditableThread("thread-v2");
      const sm = makeV3SessionManager();
      vi.mocked(sm.streamFromAgent).mockResolvedValue("v2 reply" as any);

      const spawner = new SubagentThreadSpawner({
        sessionManager: sm,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: client as any,
        // Registry's backend gate returns null for a v2 config → no .bridge.
        wireChannelForSubagent: () => null,
      });

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "v2-path",
        task: "v2 work",
        autoRelay: false,
      });
      await new Promise((r) => setTimeout(r, 50));

      // The v2 SDK iterate path IS used; no channel dispatch.
      expect(sm.streamFromAgent).toHaveBeenCalledOnce();
    });

    it("DISP-6 — a channel awaitReply timeout is handled as a failed turn (parent notified, no crash)", async () => {
      const { bridge, settle } = makeBridgeStub({
        reject: new ChannelReplyTimeoutError("subdispatch-x", 600_000),
      });
      // Build a parent channel the failed-turn notice can post to.
      const parentSend = vi.fn(async (_c: string) => {});
      const parentChannel = { id: "parent-chan", send: parentSend };
      const placeholder = {
        id: "msg-ph",
        edit: vi.fn(async () => {}),
      };
      const mockThread = {
        id: "thread-v3-timeout",
        send: vi.fn(async () => placeholder),
      };
      const mockChannel = {
        id: "channel-1",
        threads: { create: vi.fn(async () => mockThread) },
        isTextBased: () => true,
      };
      const client = {
        channels: {
          fetch: vi.fn(async (id: string) =>
            id === "parent-chan" ? parentChannel : mockChannel,
          ),
        },
      };
      const sm = makeV3SessionManager();

      const spawner = new SubagentThreadSpawner({
        sessionManager: sm,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: client as any,
        wireChannelForSubagent: () => ({ bridge }),
      });

      const result = await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "v3-timeout",
        task: "this will time out",
        autoRelay: false,
      });
      // The thread binding's parentChannelId is the spawn channel; force it to
      // the parent-chan id so the notify path resolves a sendable channel.
      const reg = await readThreadRegistry(registryPath);
      await writeThreadRegistry(registryPath, {
        ...reg,
        bindings: reg.bindings.map((b) =>
          b.threadId === result.threadId
            ? { ...b, parentChannelId: "parent-chan" }
            : b,
        ),
      });

      await new Promise((r) => setTimeout(r, 20));
      settle(); // rejects awaitReply with ChannelReplyTimeoutError
      await new Promise((r) => setTimeout(r, 60));

      // The progress callback was still cleared (finally ran — no leak, no crash).
      expect(bridge.clearProgressCallback).toHaveBeenCalled();
      // The parent was notified of the failed turn (timeout-specific wording).
      expect(parentSend).toHaveBeenCalled();
      expect(parentSend.mock.calls[0][0]).toMatch(/did not respond within/i);
    });
  });

  describe("cleanupSubagentThread", () => {
    it("stops the subagent session, removes the binding, but does NOT delete the Discord thread", async () => {
      const result = await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "task-to-cleanup",
      });

      // Phase 999.36 sub-bug D — settle the void postInitialMessage chain
      // (which now writes lastDeliveryAt) BEFORE cleanup so the stamp's
      // read-modify-write doesn't race cleanup's removeBinding write.
      await new Promise((r) => setTimeout(r, 50));

      await spawner.cleanupSubagentThread(result.threadId);

      // Session was stopped
      expect(sessionManager.stopAgent).toHaveBeenCalledWith(
        result.sessionName,
      );

      // Binding was removed
      const registry = await readThreadRegistry(registryPath);
      expect(registry.bindings).toHaveLength(0);

      // Discord thread was NOT deleted (no thread.delete call)
      // This is implicit -- there's no delete mock to check
    });

    it("is a no-op when the threadId has no binding", async () => {
      // Should not throw
      await spawner.cleanupSubagentThread("nonexistent-thread");
      expect(sessionManager.stopAgent).not.toHaveBeenCalled();
    });
  });

  /**
   * Phase 100-fu — overflow chunk diagnostics. The pre-fu code chunked
   * overflow with no aggregate "summary" log line, so the next time
   * Discord silently dropped chunks, there was no breadcrumb to debug
   * from. Add structured logging that captures totalLength + chunksSent
   * + fullySent so the failure mode is observable in production.
   */
  describe("postInitialMessage overflow diagnostics (Phase 100-fu)", () => {
    it("OF-LOG-1 — emits 'subagent overflow chunks summary' log line with chunksSent + fullySent fields", async () => {
      // Build a fake logger that records every log call
      const logCalls: { level: string; obj: any; msg: string }[] = [];
      const fakeLog = {
        info: vi.fn((obj: any, msg: string) => {
          logCalls.push({ level: "info", obj, msg });
        }),
        warn: vi.fn((obj: any, msg: string) => {
          logCalls.push({ level: "warn", obj, msg });
        }),
        debug: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(() => fakeLog),
      };

      // Build a mock thread surface with edit support so canEdit=true.
      const sentChunks: string[] = [];
      const placeholder = {
        id: "msg-placeholder",
        edit: vi.fn(async (_content: string) => undefined),
      };
      const mockThread = {
        id: "thread-overflow",
        send: vi.fn(async (content: string) => {
          sentChunks.push(content);
          return placeholder;
        }),
      };

      // Mock channel + client just enough for the spawner to fetch.
      const mockChannel = {
        id: "channel-1",
        threads: { create: vi.fn(async () => mockThread) },
        isTextBased: () => true,
      };
      const localDiscordClient = {
        channels: { fetch: vi.fn(async () => mockChannel) },
      };

      // Reply text > 2000 chars (5000 chars → 3 chunks of 2000 + tail of <2000)
      const bigReply = "X".repeat(5000);
      const localSessionManager = makeMockSessionManager();
      localSessionManager._setConfig(
        "agent-a",
        makeAgentConfig({
          webhook: {
            displayName: "Agent A",
            avatarUrl: "https://example.com/a.png",
            webhookUrl: "https://discord.com/api/webhooks/123/abc",
          },
        }),
      );
      vi.mocked(localSessionManager.streamFromAgent).mockResolvedValue(
        bigReply as any,
      );

      const spawner = new SubagentThreadSpawner({
        sessionManager: localSessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: localDiscordClient as any,
        log: fakeLog as any,
      });

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "overflow-test",
        autoRelay: false, // skip relay path — we're testing overflow logging only
      });

      // Wait a tick so the deliberately-not-awaited postInitialMessage runs.
      // It uses placeholder.edit + thread.send for tail chunks.
      await new Promise((r) => setTimeout(r, 50));

      // Assert: a structured "summary" log captures chunksSent + fullySent.
      const summaryLog = logCalls.find((c) =>
        c.msg.includes("subagent overflow chunks summary"),
      );
      expect(summaryLog).toBeDefined();
      expect(summaryLog!.obj).toMatchObject({
        totalLength: 5000,
        chunksSent: expect.any(Number),
        fullySent: expect.any(Boolean),
      });
      // For a 5000-char reply: 2000 in placeholder + 2 tail chunks of 2000
      // + final chunk of 1000 = 3 tail chunks. fullySent must be true.
      expect(summaryLog!.obj.fullySent).toBe(true);
      expect(summaryLog!.obj.chunksSent).toBeGreaterThanOrEqual(2);
    });

    it("999.36-A1 — typing loop fires sendTyping AND chunk-boundary diag log carries editorCutoffIndex/overflowStartCursor/seamGapBytes (sub-bug A wiring + sub-bug B diag)", async () => {
      // Phase 999.36 Plan 00 Task 5 — smoke test that:
      //   (1) spawnInThread → postInitialMessage starts the typing loop
      //       (sendTyping called at t=0 per startTypingLoop's eager fire,
      //       Plan 00 Task 1)
      //   (2) chunk-boundary diag fields are present on the
      //       'subagent overflow chunks summary' log line (Plan 00 Task 3)
      //
      // Both behaviors live on the postInitialMessage path; reusing the
      // OF-LOG-1 scaffolding above (5000-char reply triggers overflow).
      const logCalls: { level: string; obj: any; msg: string }[] = [];
      const fakeLog = {
        info: vi.fn((obj: any, msg: string) => {
          logCalls.push({ level: "info", obj, msg });
        }),
        warn: vi.fn((obj: any, msg: string) => {
          logCalls.push({ level: "warn", obj, msg });
        }),
        debug: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(() => fakeLog),
      };

      const sentChunks: string[] = [];
      const placeholder = {
        id: "msg-placeholder",
        edit: vi.fn(async (_content: string) => undefined),
      };
      // Mock thread surface with sendTyping spy — startTypingLoop calls
      // this on entry (eager fire, t=0) per Plan 00 Task 1's contract.
      const sendTyping = vi.fn(async () => undefined);
      const mockThread = {
        id: "thread-A1",
        sendTyping,
        send: vi.fn(async (content: string) => {
          sentChunks.push(content);
          return placeholder;
        }),
      };
      const mockChannel = {
        id: "channel-1",
        threads: { create: vi.fn(async () => mockThread) },
        isTextBased: () => true,
      };
      const localDiscordClient = {
        channels: { fetch: vi.fn(async () => mockChannel) },
      };

      const bigReply = "X".repeat(5000);
      const localSessionManager = makeMockSessionManager();
      localSessionManager._setConfig(
        "agent-a",
        makeAgentConfig({
          webhook: {
            displayName: "Agent A",
            avatarUrl: "https://example.com/a.png",
            webhookUrl: "https://discord.com/api/webhooks/123/abc",
          },
        }),
      );
      vi.mocked(localSessionManager.streamFromAgent).mockResolvedValue(
        bigReply as any,
      );

      const spawner = new SubagentThreadSpawner({
        sessionManager: localSessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: localDiscordClient as any,
        log: fakeLog as any,
      });

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "A1-typing-and-diag",
        autoRelay: false,
      });

      await new Promise((r) => setTimeout(r, 50));

      // Sub-bug A wiring assertion — the eager t=0 fire from startTypingLoop
      // must have hit the thread's sendTyping spy at least once. We don't
      // try to wait for the 8s heartbeat (test runs in <1s), the eager
      // fire is sufficient evidence the loop was wired.
      expect(sendTyping).toHaveBeenCalled();

      // Sub-bug B diag assertion — the chunk-boundary fields must be
      // present on the 'subagent overflow chunks summary' info log so a
      // grep on prod logs surfaces editorCutoffIndex/overflowStartCursor/
      // seamGapBytes for D-08 hypothesis confirmation.
      const summaryLog = logCalls.find((c) =>
        c.msg.includes("subagent overflow chunks summary"),
      );
      expect(summaryLog).toBeDefined();
      // Phase 121-02 sub-bug B fix (D-07) — overflowStartCursor now aligns
      // with editorCutoffIndex (1997), and seamGapBytes is 0. Pre-fix
      // values (cursor=2000, gap=3) confirmed the seam was real (Plan
      // 121-01 diagnostic cycle); post-fix the seam is closed.
      expect(summaryLog!.obj).toMatchObject({
        totalLength: 5000,
        editorCutoffIndex: 1997,
        overflowStartCursor: 1997,
        seamGapBytes: 0,
        endReason: "drained",
      });
    });

    it("999.36-A2 — typingHandle.stop() called even when streamFromAgent rejects (sub-bug A finally-block invariant)", async () => {
      // Phase 999.36 Plan 00 Task 5 — invariant: when streamFromAgent
      // throws, the finally block in postInitialMessage must still call
      // typingHandle.stop() so the 8s setInterval doesn't leak. We can't
      // peek the interval handle from the test surface, but we CAN assert
      // that no further sendTyping fires happen after the test wait,
      // which is the operator-visible failure mode.
      const fakeLog = {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
      };
      fakeLog.child.mockReturnValue(fakeLog);

      const sendTyping = vi.fn(async () => undefined);
      const mockThread = {
        id: "thread-A2",
        sendTyping,
        send: vi.fn(async () => ({ id: "p", edit: vi.fn() })),
      };
      const mockChannel = {
        id: "channel-1",
        threads: { create: vi.fn(async () => mockThread) },
        isTextBased: () => true,
      };
      const localDiscordClient = {
        channels: { fetch: vi.fn(async () => mockChannel) },
      };

      const localSessionManager = makeMockSessionManager();
      localSessionManager._setConfig(
        "agent-a",
        makeAgentConfig({
          webhook: {
            displayName: "Agent A",
            avatarUrl: "https://example.com/a.png",
            webhookUrl: "https://discord.com/api/webhooks/123/abc",
          },
        }),
      );
      // streamFromAgent rejects — emulates a mid-turn SDK failure.
      vi.mocked(localSessionManager.streamFromAgent).mockRejectedValue(
        new Error("synthetic stream-from-agent failure"),
      );

      const spawner = new SubagentThreadSpawner({
        sessionManager: localSessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: localDiscordClient as any,
        log: fakeLog as any,
      });

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "A2-stream-rejects",
        autoRelay: false,
      });

      // Allow the deliberately-not-awaited postInitialMessage to settle:
      // catch logs the warn, finally clears the interval.
      await new Promise((r) => setTimeout(r, 100));

      // Eager fire happened before the rejection.
      expect(sendTyping).toHaveBeenCalled();
      const earlyCount = sendTyping.mock.calls.length;

      // Wait LONGER than one 8s tick. If the interval wasn't cleared by
      // the finally block, sendTyping would fire again. Use fake timers
      // to advance instantly without making the test suite slow.
      vi.useFakeTimers({ now: Date.now() });
      try {
        await vi.advanceTimersByTimeAsync(20_000);
      } finally {
        vi.useRealTimers();
      }
      // Note: the interval may have been cleared BEFORE we engaged fake
      // timers (real-timer ticks during the 100ms settle above don't fire
      // because 100ms < 8000ms). The contract is: post-finally, no more
      // fires. earlyCount === current count proves the interval is dead.
      expect(sendTyping.mock.calls.length).toBe(earlyCount);
    });
  });

  describe("stopTypingForSession — stale-turn-watchdog-miss gap #3", () => {
    it("stops the typing loop for a wedged subagent whose SDK turn never settled", async () => {
      // Debug session `stale-turn-watchdog-miss` (999.64 RECURRENCE) gap #3.
      // When the SDK turn hangs forever, postInitialMessage's `finally`
      // never runs — the typing loop's setInterval re-fires for the
      // daemon's life. The heartbeat stale-turn sweep force-releases the
      // turn and then calls stopTypingForSession (wired in daemon.ts) to
      // clear the indicator. This pins that stopTypingForSession actually
      // stops the registered loop.
      const fakeLog = {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
      };
      fakeLog.child.mockReturnValue(fakeLog);

      const sendTyping = vi.fn(async () => undefined);
      const mockThread = {
        id: "thread-hang",
        sendTyping,
        send: vi.fn(async () => ({ id: "p", edit: vi.fn() })),
      };
      const mockChannel = {
        id: "channel-1",
        threads: { create: vi.fn(async () => mockThread) },
        isTextBased: () => true,
      };
      const localDiscordClient = {
        channels: { fetch: vi.fn(async () => mockChannel) },
      };

      const localSessionManager = makeMockSessionManager();
      localSessionManager._setConfig(
        "agent-a",
        makeAgentConfig({
          webhook: {
            displayName: "Agent A",
            avatarUrl: "https://example.com/a.png",
            webhookUrl: "https://discord.com/api/webhooks/123/abc",
          },
        }),
      );
      // streamFromAgent NEVER resolves — emulates the wedged SDK turn
      // (next() never resolves). postInitialMessage's await hangs, so its
      // `finally` (which would normally stop the typing loop) never runs.
      vi.mocked(localSessionManager.streamFromAgent).mockReturnValue(
        new Promise<string>(() => {
          /* never resolves */
        }),
      );

      const localSpawner = new SubagentThreadSpawner({
        sessionManager: localSessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: localDiscordClient as any,
        log: fakeLog as any,
      });

      const result = await localSpawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "hung-turn",
        autoRelay: false,
      });
      const sessionName = result.sessionName;

      // Let postInitialMessage start the typing loop (it then hangs on the
      // never-resolving streamFromAgent).
      await new Promise((r) => setTimeout(r, 50));
      expect(sendTyping).toHaveBeenCalled();
      const countAfterStart = sendTyping.mock.calls.length;

      // The sweep's callback fires — stop the indicator for this session.
      localSpawner.stopTypingForSession(sessionName);

      // After stop, the 8s setInterval must never fire again.
      vi.useFakeTimers({ now: Date.now() });
      try {
        await vi.advanceTimersByTimeAsync(20_000);
      } finally {
        vi.useRealTimers();
      }
      expect(sendTyping.mock.calls.length).toBe(countAfterStart);

      // Idempotent — a second call is a harmless no-op.
      expect(() => localSpawner.stopTypingForSession(sessionName)).not.toThrow();
    });

    it("is a no-op for an unknown session name", () => {
      expect(() =>
        spawner.stopTypingForSession("no-such-session"),
      ).not.toThrow();
    });

    it("deregisters the typing cleanup on the normal (settled) turn path — no Map leak", async () => {
      // On the normal path streamFromAgent resolves, postInitialMessage's
      // `finally` runs, the loop is stopped AND the Map entry dropped. A
      // post-settle stopTypingForSession call must therefore be a no-op
      // (entry already gone) — proving no unbounded closure leak.
      const result = await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "normal-turn",
        autoRelay: false,
      });
      // Settle the deliberately-not-awaited postInitialMessage chain.
      await new Promise((r) => setTimeout(r, 80));
      // The `finally` ran (turn settled) and deregistered the entry — the
      // internal Map must no longer hold this session (no closure leak).
      const cleanups = (
        spawner as unknown as { typingCleanups: Map<string, () => void> }
      ).typingCleanups;
      expect(cleanups.has(result.sessionName)).toBe(false);
      // And a post-settle stopTypingForSession is a harmless no-op.
      expect(() =>
        spawner.stopTypingForSession(result.sessionName),
      ).not.toThrow();
    });
  });

  describe("getSubagentBindings", () => {
    it("returns all bindings from the registry", async () => {
      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "task-1",
      });

      discordMock.setThreadId("thread-456");
      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "task-2",
      });

      const bindings = await spawner.getSubagentBindings();
      expect(bindings).toHaveLength(2);
    });
  });
});

/**
 * Phase 100 — relay prompt artifact-paths extension (Plan 100-05 / GSD-06).
 *
 * Phase 99-M's `relayCompletionToParent` (shipped 2026-04-26) summarizes the
 * subagent's last assistant message into a parent-agent turn. Phase 100
 * extends the prompt with discovered artifact paths so the parent's
 * main-channel summary mentions the `.planning/phases/<phase>/` dirs the
 * subagent created/touched.
 *
 * Two new exported pure helpers:
 *   - resolveArtifactRoot(parentConfig?) — extracts gsd.projectDir or undefined
 *   - discoverArtifactPaths({readdir,stat}, root, taskHint?) — lists relative
 *     paths under <root>/.planning/phases/, filtered by 24h mtime window,
 *     prioritized by phase-number prefix matching the task hint, capped at 5.
 *     Failures resolve to []. Pure DI so tests don't touch real filesystem.
 *
 * Plus an integration test asserting `relayCompletionToParent` appends an
 * "Artifacts written: ..." line when the parent has gsd.projectDir set.
 */
describe("Phase 100 — relay prompt artifact-paths extension", () => {
  // Helper — build a Dirent-shaped object with isDirectory()/isFile().
  function makeDirent(
    name: string,
    isDir = true,
  ): { name: string; isDirectory: () => boolean; isFile: () => boolean } {
    return {
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
    };
  }

  describe("resolveArtifactRoot", () => {
    it("AP7 — returns gsd.projectDir when set on parentConfig", () => {
      const parent = {
        gsd: { projectDir: "/opt/clawcode-projects/sandbox" },
      } as ResolvedAgentConfig;
      expect(resolveArtifactRoot(parent)).toBe("/opt/clawcode-projects/sandbox");
    });

    it("AP8 — returns undefined when parentConfig.gsd is absent", () => {
      // Cast minimally — gsd is optional on ResolvedAgentConfig, so {} is allowed
      // by the type system from the consumer's perspective.
      const parent = {} as ResolvedAgentConfig;
      expect(resolveArtifactRoot(parent)).toBeUndefined();
    });

    it("AP9 — returns undefined when parentConfig itself is undefined", () => {
      expect(resolveArtifactRoot(undefined)).toBeUndefined();
    });
  });

  describe("discoverArtifactPaths", () => {
    let mockReaddir: ReturnType<typeof vi.fn>;
    let mockStat: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockReaddir = vi.fn();
      mockStat = vi.fn();
    });

    it("AP1 — happy path: 3 phase dirs in window returns 3 relative paths", async () => {
      const now = Date.now();
      // Root exists
      mockStat.mockImplementation(async (p: string) => {
        if (p.endsWith(".planning/phases")) return { mtimeMs: now } as any;
        // Each phase dir entry — all within 24h window
        return { mtimeMs: now - 60_000 } as any;
      });
      mockReaddir.mockResolvedValue([
        makeDirent("100-foo"),
        makeDirent("99-bar"),
        makeDirent("101-baz"),
      ] as any);

      const out = await discoverArtifactPaths(
        { readdir: mockReaddir as any, stat: mockStat as any },
        "/proj",
        "/gsd:plan-phase 100",
      );
      expect(out.length).toBe(3);
      // All paths are RELATIVE (no leading slash, start with .planning/phases/)
      for (const p of out) {
        expect(p.startsWith(".planning/phases/")).toBe(true);
        expect(p.startsWith("/")).toBe(false);
      }
      // Each contains one of the three dir names
      const joined = out.join("|");
      expect(joined).toContain("100-foo");
      expect(joined).toContain("99-bar");
      expect(joined).toContain("101-baz");
    });

    it("AP2 — mtime filter: dirs older than 24h excluded", async () => {
      const now = Date.now();
      const TWO_DAYS_AGO = now - 2 * 24 * 60 * 60 * 1000;
      mockStat.mockImplementation(async (p: string) => {
        if (p.endsWith(".planning/phases")) return { mtimeMs: now } as any;
        if (p.includes("recent")) return { mtimeMs: now - 60_000 } as any;
        if (p.includes("stale")) return { mtimeMs: TWO_DAYS_AGO } as any;
        return { mtimeMs: now - 60_000 } as any;
      });
      mockReaddir.mockResolvedValue([
        makeDirent("recent-1"),
        makeDirent("stale-1"),
        makeDirent("recent-2"),
        makeDirent("stale-2"),
      ] as any);

      const out = await discoverArtifactPaths(
        { readdir: mockReaddir as any, stat: mockStat as any },
        "/proj",
      );
      expect(out.length).toBe(2);
      const joined = out.join("|");
      expect(joined).toContain("recent-1");
      expect(joined).toContain("recent-2");
      expect(joined).not.toContain("stale");
    });

    it("AP3 — max-5 cap: 7 dirs in window returns exactly 5", async () => {
      const now = Date.now();
      mockStat.mockImplementation(async (p: string) => {
        if (p.endsWith(".planning/phases")) return { mtimeMs: now } as any;
        return { mtimeMs: now - 60_000 } as any;
      });
      mockReaddir.mockResolvedValue([
        makeDirent("a"),
        makeDirent("b"),
        makeDirent("c"),
        makeDirent("d"),
        makeDirent("e"),
        makeDirent("f"),
        makeDirent("g"),
      ] as any);

      const out = await discoverArtifactPaths(
        { readdir: mockReaddir as any, stat: mockStat as any },
        "/proj",
      );
      expect(out.length).toBe(5);
    });

    it("AP4 — phase-prefix priority: matching phase number sorts first", async () => {
      const now = Date.now();
      // Make NON-matching dirs more recent so default mtime sort would surface them first.
      // Phase-prefix priority must override the recency sort.
      mockStat.mockImplementation(async (p: string) => {
        if (p.endsWith(".planning/phases")) return { mtimeMs: now } as any;
        if (p.includes("100-bar")) return { mtimeMs: now - 60 * 60 * 1000 } as any; // 1h ago
        if (p.includes("99-x")) return { mtimeMs: now - 1000 } as any; // very recent
        if (p.includes("101-y")) return { mtimeMs: now - 2000 } as any;
        return { mtimeMs: now } as any;
      });
      mockReaddir.mockResolvedValue([
        makeDirent("99-x"),
        makeDirent("100-bar"),
        makeDirent("101-y"),
      ] as any);

      const out = await discoverArtifactPaths(
        { readdir: mockReaddir as any, stat: mockStat as any },
        "/proj",
        "/gsd:plan-phase 100",
      );
      expect(out.length).toBe(3);
      // FIRST entry must be the phase-100 match despite being older than 99-x
      expect(out[0]).toContain("100-bar");
    });

    it("AP5 — readdir failure returns empty array (failures-swallow contract)", async () => {
      const now = Date.now();
      // Root stat succeeds...
      mockStat.mockResolvedValue({ mtimeMs: now } as any);
      // ...but readdir blows up.
      mockReaddir.mockRejectedValue(new Error("ENOENT: no such file"));

      const out = await discoverArtifactPaths(
        { readdir: mockReaddir as any, stat: mockStat as any },
        "/proj",
      );
      expect(out).toEqual([]);
    });

    it("AP6 — root .planning/phases doesn't exist returns []", async () => {
      // Stat on the root throws (ENOENT)
      mockStat.mockImplementation(async () => {
        throw new Error("ENOENT");
      });
      mockReaddir.mockResolvedValue([] as any);

      const out = await discoverArtifactPaths(
        { readdir: mockReaddir as any, stat: mockStat as any },
        "/nope",
      );
      expect(out).toEqual([]);
      // readdir should NOT have been called when stat fails
      expect(mockReaddir).not.toHaveBeenCalled();
    });

    it("AP6b — non-directory entries are filtered out (only isDirectory()==true)", async () => {
      const now = Date.now();
      mockStat.mockImplementation(async (p: string) => {
        if (p.endsWith(".planning/phases")) return { mtimeMs: now } as any;
        return { mtimeMs: now - 60_000 } as any;
      });
      mockReaddir.mockResolvedValue([
        makeDirent("100-real-dir", true),
        makeDirent("README.md", false), // file, not dir
        makeDirent("101-also-real", true),
      ] as any);

      const out = await discoverArtifactPaths(
        { readdir: mockReaddir as any, stat: mockStat as any },
        "/proj",
      );
      expect(out.length).toBe(2);
      expect(out.join("|")).not.toContain("README");
    });

    it("AP6c — per-entry stat failures are silently skipped", async () => {
      const now = Date.now();
      mockStat.mockImplementation(async (p: string) => {
        if (p.endsWith(".planning/phases")) return { mtimeMs: now } as any;
        if (p.includes("good")) return { mtimeMs: now - 60_000 } as any;
        if (p.includes("broken")) throw new Error("EACCES");
        return { mtimeMs: now - 60_000 } as any;
      });
      mockReaddir.mockResolvedValue([
        makeDirent("good-1"),
        makeDirent("broken-1"),
        makeDirent("good-2"),
      ] as any);

      const out = await discoverArtifactPaths(
        { readdir: mockReaddir as any, stat: mockStat as any },
        "/proj",
      );
      expect(out.length).toBe(2);
      expect(out.join("|")).not.toContain("broken");
    });
  });

  describe("relayCompletionToParent integration", () => {
    let tmpDir: string;
    let registryPath: string;
    let sessionManager: ReturnType<typeof makeMockSessionManager>;
    // Quick task 260501-nfe — relay now uses dispatchStream + ProgressiveMessageEditor
    // posting to the parent's main channel via channel.send. Mock returns a non-empty
    // string so the post happens (mirrors bridge.ts:585-665 user-message path).
    let turnDispatcher: { dispatchStream: ReturnType<typeof vi.fn> };
    // Spy for the parent channel's `send` — the assertion that proves the bug fix:
    // before quick task 260501-nfe this was never invoked.
    let parentChannelSendSpy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "relay-artifact-test-"));
      registryPath = join(tmpDir, "thread-bindings.json");
      sessionManager = makeMockSessionManager();
      turnDispatcher = {
        dispatchStream: vi.fn(async (_origin, _agent, _prompt, onChunk) => {
          onChunk?.("OK summary");
          return "OK summary";
        }),
      };
      parentChannelSendSpy = vi.fn(async () => ({
        edit: vi.fn(async () => {}),
        id: "msg-1",
      }));
    });

    /**
     * Build a discordClient mock that routes channels.fetch:
     *   - parentChannelId → fake parent channel exposing `send` spy
     *   - any other id (the threadId) → the supplied thread channel
     */
    function buildDiscordClient(
      threadChannel: unknown,
      parentChannelId: string,
    ) {
      const parentChannel = { send: parentChannelSendSpy };
      return {
        channels: {
          fetch: vi.fn(async (id: string) =>
            id === parentChannelId ? parentChannel : threadChannel,
          ),
        },
      };
    }

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    /**
     * AP10 — integration test asserting the full relay flow appends an
     * Artifacts: line when the parent has gsd.projectDir AND the discovery
     * helper returns non-empty paths.
     *
     * We can't easily DI discoverArtifactPaths through the spawner constructor
     * (it's used directly), so we use a real-on-disk tempDir as gsd.projectDir
     * and create a recently-mtime'd phase directory under it. That exercises
     * the live fs path end-to-end.
     */
    it("AP10 — appends 'Artifacts written:' line when parent has gsd.projectDir AND a recent phase dir exists", async () => {
      // Set up a real fake project root with a recent .planning/phases/100-foo/ dir
      const projectDir = join(tmpDir, "fake-project");
      const phasesDir = join(projectDir, ".planning", "phases");
      const recentPhase = join(phasesDir, "100-fake-phase");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(recentPhase, { recursive: true });

      // Bind parent agent to thread-id-A, with gsd.projectDir set
      const parentConfig = makeAgentConfig({
        gsd: { projectDir: projectDir },
      });
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-id-A",
            parentChannelId: "channel-X",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-abc",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      // Mock Discord client with a thread that has a single subagent message
      const subagentMessage = {
        author: { bot: true },
        webhookId: "webhook-123",
        content: "All work done.",
      };
      const fetched = new Map([["m1", subagentMessage]]);
      const mockChannel = {
        id: "thread-id-A",
        name: "gsd:plan:100",
        messages: {
          fetch: vi.fn(async () => fetched),
        },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-X");

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
      });

      await spawner.relayCompletionToParent("thread-id-A");

      expect(turnDispatcher.dispatchStream).toHaveBeenCalledTimes(1);
      const dispatchCall = turnDispatcher.dispatchStream.mock.calls[0];
      // dispatchStream(origin, agentName, prompt, onChunk, options)
      const prompt: string = dispatchCall[2];
      // Base Phase 99-M shape preserved
      expect(prompt).toContain("[SUBAGENT_COMPLETION]");
      expect(prompt).toContain("All work done.");
      expect(prompt).toContain("thread-id-A");
      // Phase 100 extension
      expect(prompt).toContain("Artifacts written:");
      expect(prompt).toContain(".planning/phases/100-fake-phase/");
    });

    /**
     * Phase 100-fu — relay must walk back through CONSECUTIVE bot messages
     * (newest→oldest) and concatenate them oldest-first, stopping at the
     * first operator (non-bot) message OR the start of the thread. This
     * fixes the silent-truncation bug where a multi-chunk subagent reply
     * (>2000 chars split across N thread.send() calls) was relayed to the
     * parent using only the LAST chunk — losing chunks 1..N-1.
     */
    it("REL-MULTI-1 — concatenates multiple consecutive bot messages oldest-first", async () => {
      const parentConfig = makeAgentConfig({});
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-multi",
            parentChannelId: "channel-X",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-multi",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      // Discord fetch returns newest-first. Three consecutive bot messages.
      const fetched = new Map<string, any>([
        ["m3", { author: { bot: true }, webhookId: "wh", content: "CHUNK_THREE" }],
        ["m2", { author: { bot: true }, webhookId: "wh", content: "CHUNK_TWO" }],
        ["m1", { author: { bot: true }, webhookId: "wh", content: "CHUNK_ONE" }],
      ]);
      const mockChannel = {
        id: "thread-multi",
        name: "research-task",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-X");

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
      });

      await spawner.relayCompletionToParent("thread-multi");

      expect(turnDispatcher.dispatchStream).toHaveBeenCalledTimes(1);
      const prompt: string = turnDispatcher.dispatchStream.mock.calls[0][2];
      // All three chunks present, oldest→newest order
      const idxOne = prompt.indexOf("CHUNK_ONE");
      const idxTwo = prompt.indexOf("CHUNK_TWO");
      const idxThree = prompt.indexOf("CHUNK_THREE");
      expect(idxOne).toBeGreaterThan(-1);
      expect(idxTwo).toBeGreaterThan(idxOne);
      expect(idxThree).toBeGreaterThan(idxTwo);
    });

    it("REL-MULTI-2 — stops at first operator (non-bot) message", async () => {
      const parentConfig = makeAgentConfig({});
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-stop",
            parentChannelId: "channel-X",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-stop",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      // Newest first: bot, bot, OPERATOR, bot. Walk back from newest should
      // pick up the two recent bot messages then STOP at the operator —
      // the older bot message must NOT be included.
      const fetched = new Map<string, any>([
        ["m4", { author: { bot: true }, webhookId: "wh", content: "AFTER_OP_TWO" }],
        ["m3", { author: { bot: true }, webhookId: "wh", content: "AFTER_OP_ONE" }],
        ["m2", { author: { bot: false }, webhookId: null, content: "operator follow-up" }],
        ["m1", { author: { bot: true }, webhookId: "wh", content: "OLD_BOT_REPLY" }],
      ]);
      const mockChannel = {
        id: "thread-stop",
        name: "research-task",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-X");

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
      });

      await spawner.relayCompletionToParent("thread-stop");

      expect(turnDispatcher.dispatchStream).toHaveBeenCalledTimes(1);
      const prompt: string = turnDispatcher.dispatchStream.mock.calls[0][2];
      expect(prompt).toContain("AFTER_OP_ONE");
      expect(prompt).toContain("AFTER_OP_TWO");
      expect(prompt).not.toContain("OLD_BOT_REPLY");
      expect(prompt).not.toContain("operator follow-up");
    });

    it("REL-MULTI-3 — empty bot messages are skipped", async () => {
      const parentConfig = makeAgentConfig({});
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-empty",
            parentChannelId: "channel-X",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-empty",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      const fetched = new Map<string, any>([
        ["m3", { author: { bot: true }, webhookId: "wh", content: "REAL_CONTENT" }],
        ["m2", { author: { bot: true }, webhookId: "wh", content: "   " }], // whitespace only
        ["m1", { author: { bot: true }, webhookId: "wh", content: "" }], // empty (e.g. embed-only)
      ]);
      const mockChannel = {
        id: "thread-empty",
        name: "research-task",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-X");

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
      });

      await spawner.relayCompletionToParent("thread-empty");

      expect(turnDispatcher.dispatchStream).toHaveBeenCalledTimes(1);
      const prompt: string = turnDispatcher.dispatchStream.mock.calls[0][2];
      expect(prompt).toContain("REAL_CONTENT");
    });

    it("REL-MULTI-4 — single bot message: behavior identical to prior single-message logic", async () => {
      const parentConfig = makeAgentConfig({});
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-single",
            parentChannelId: "channel-X",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-single",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      const fetched = new Map<string, any>([
        ["m1", { author: { bot: true }, webhookId: "wh", content: "Just one reply." }],
      ]);
      const mockChannel = {
        id: "thread-single",
        name: "research-task",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-X");

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
      });

      await spawner.relayCompletionToParent("thread-single");

      expect(turnDispatcher.dispatchStream).toHaveBeenCalledTimes(1);
      const prompt: string = turnDispatcher.dispatchStream.mock.calls[0][2];
      expect(prompt).toContain("Just one reply.");
      expect(prompt).toContain("[SUBAGENT_COMPLETION]");
    });

    // ──────────────────────────────────────────────────────────────
    // Inline-relay (2026-05-23) — when the subagent's verbatim final
    // reply fits in a single Discord message, post directly to the
    // parent's main channel and skip the dispatch-summary turn.
    // ──────────────────────────────────────────────────────────────

    it("IR-1 — short reply with no artifacts: posts verbatim inline + footer, dispatchStream NOT called", async () => {
      // Default parent config (no gsd.projectDir → artifacts = []).
      const parentConfig = makeAgentConfig({});
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-inline-1",
            parentChannelId: "channel-X",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-inline1",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      const replyText = "Quick answer: the meeting is at 3pm PT on Friday.";
      const fetched = new Map<string, any>([
        [
          "m1",
          { author: { bot: true }, webhookId: "wh", content: replyText },
        ],
      ]);
      const mockChannel = {
        id: "thread-inline-1",
        name: "scheduling",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-X");

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
        inlineRelayEnabled: true,
      });

      await spawner.relayCompletionToParent("thread-inline-1");

      // Inline-relay path → dispatchStream NEVER called.
      expect(turnDispatcher.dispatchStream).not.toHaveBeenCalled();
      // Parent channel received the verbatim reply + footer in one send.
      expect(parentChannelSendSpy).toHaveBeenCalledTimes(1);
      const posted: string = parentChannelSendSpy.mock.calls[0]![0];
      expect(posted).toContain(replyText);
      // Footer uses <#threadId> mention syntax (Discord clickable) +
      // italic "via subagent" wording with NO em-dash (the strip rules
      // ban em-dashes in our own output, footer included).
      expect(posted).toContain("*via subagent <#thread-inline-1>*");
      expect(posted).not.toContain("—");
    });

    it("IR-2 — reply exceeds the inline budget: falls through to dispatch-summary path", async () => {
      const parentConfig = makeAgentConfig({});
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-inline-2",
            parentChannelId: "channel-X",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-inline2",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      // 2100 chars — over the 2000-char Discord cap even before adding
      // the footer. Forces fall-through to dispatch.
      const longReply = "A".repeat(2100);
      const fetched = new Map<string, any>([
        [
          "m1",
          { author: { bot: true }, webhookId: "wh", content: longReply },
        ],
      ]);
      const mockChannel = {
        id: "thread-inline-2",
        name: "long-deliverable",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-X");

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
        inlineRelayEnabled: true,
      });

      await spawner.relayCompletionToParent("thread-inline-2");

      // Long content → dispatch path fires, summarizes via parent turn.
      expect(turnDispatcher.dispatchStream).toHaveBeenCalledTimes(1);
    });

    it("IR-3 — parent has gsd.projectDir with recent phase dir: artifacts force dispatch path (preserves AP10 artifact-line behavior)", async () => {
      // Set up a real fake gsd.projectDir with a recent phase dir so
      // discoverArtifactPaths returns non-empty. Inline-relay refuses
      // when artifacts > 0 so the dispatch path's relayPrompt can
      // mention them in the parent's summary.
      const projectDir = join(tmpDir, "fake-project-IR3");
      const phasesDir = join(projectDir, ".planning", "phases");
      const recentPhase = join(phasesDir, "100-inline-relay-fu");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(recentPhase, { recursive: true });

      const parentConfig = makeAgentConfig({
        gsd: { projectDir },
      });
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-inline-3",
            parentChannelId: "channel-X",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-inline3",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      // Short content — would otherwise be inline-relayed if not for
      // the artifacts gate.
      const fetched = new Map<string, any>([
        [
          "m1",
          {
            author: { bot: true },
            webhookId: "wh",
            content: "Done — see the new phase dir.",
          },
        ],
      ]);
      const mockChannel = {
        id: "thread-inline-3",
        name: "gsd:plan:100",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-X");

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
        inlineRelayEnabled: true,
      });

      await spawner.relayCompletionToParent("thread-inline-3");

      // Artifacts > 0 → dispatch path fires (NOT inline).
      expect(turnDispatcher.dispatchStream).toHaveBeenCalledTimes(1);
      const prompt: string = turnDispatcher.dispatchStream.mock.calls[0]![2];
      expect(prompt).toContain("Artifacts written:");
      expect(prompt).toContain(".planning/phases/100-inline-relay-fu/");
    });

    it("IR-4 — attachment-only sentinel: falls through to dispatch path so operator gets file-context summary", async () => {
      const parentConfig = makeAgentConfig({});
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-inline-4",
            parentChannelId: "channel-X",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-inline4",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      // Empty bot message with an attachment → subagentChunks ends up
      // with the sentinel string after the attachment-only branch.
      const fetched = new Map<string, any>([
        [
          "m1",
          {
            author: { bot: true },
            webhookId: "wh",
            content: "",
            attachments: new Map([
              [
                "a1",
                {
                  url: "https://cdn.discord/file.pdf",
                  name: "report.pdf",
                  size: 50_000,
                  contentType: "application/pdf",
                },
              ],
            ]),
          },
        ],
      ]);
      const mockChannel = {
        id: "thread-inline-4",
        name: "report-task",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-X");

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
        inlineRelayEnabled: true,
      });

      await spawner.relayCompletionToParent("thread-inline-4");

      // Sentinel → dispatch path fires (operator gets a file-aware
      // summary turn, not a verbatim sentinel post).
      expect(turnDispatcher.dispatchStream).toHaveBeenCalledTimes(1);
    });

    it("IR-5 — opt-out (inlineRelayEnabled: false, the test default): never takes inline path even for short content", async () => {
      const parentConfig = makeAgentConfig({});
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-inline-5",
            parentChannelId: "channel-X",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-inline5",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      const fetched = new Map<string, any>([
        [
          "m1",
          {
            author: { bot: true },
            webhookId: "wh",
            content: "Short reply that would normally inline.",
          },
        ],
      ]);
      const mockChannel = {
        id: "thread-inline-5",
        name: "opt-out-test",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-X");

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
        // inlineRelayEnabled omitted → defaults to false.
      });

      await spawner.relayCompletionToParent("thread-inline-5");

      // Opt-out → dispatch path always fires regardless of fit.
      expect(turnDispatcher.dispatchStream).toHaveBeenCalledTimes(1);
    });

    it("IR-6 — inline-post failure falls back to dispatch path (degraded UX > drop)", async () => {
      const parentConfig = makeAgentConfig({});
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-inline-6",
            parentChannelId: "channel-X",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-inline6",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      // First parentSendable.send call (inline-post) throws; second
      // call (editor's first chunk) succeeds. Verifies the fallback.
      let sendCallCount = 0;
      const failOnceThenOk = vi.fn(async (_content: string) => {
        sendCallCount += 1;
        if (sendCallCount === 1) {
          throw new Error("Discord 503 — service unavailable");
        }
        return { edit: vi.fn(async () => {}), id: "msg-fallback" };
      });
      parentChannelSendSpy = failOnceThenOk as any;

      const fetched = new Map<string, any>([
        [
          "m1",
          {
            author: { bot: true },
            webhookId: "wh",
            content: "Short content that would inline-relay.",
          },
        ],
      ]);
      const mockChannel = {
        id: "thread-inline-6",
        name: "fallback-test",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-X");

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
        inlineRelayEnabled: true,
      });

      await spawner.relayCompletionToParent("thread-inline-6");

      // Inline-post threw → fell through to dispatch.
      expect(turnDispatcher.dispatchStream).toHaveBeenCalledTimes(1);
    });

    it("AP10b — no Artifacts line when parent has no gsd.projectDir (Phase 99-M base behavior preserved)", async () => {
      // Bind parent agent — NO gsd field set
      const parentConfig = makeAgentConfig({});
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-id-B",
            parentChannelId: "channel-X",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-xyz",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      const subagentMessage = {
        author: { bot: true },
        webhookId: "webhook-123",
        content: "Done with the non-GSD task.",
      };
      const fetched = new Map([["m1", subagentMessage]]);
      const mockChannel = {
        id: "thread-id-B",
        name: "research-task",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-X");

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
      });

      await spawner.relayCompletionToParent("thread-id-B");

      expect(turnDispatcher.dispatchStream).toHaveBeenCalledTimes(1);
      const prompt: string = turnDispatcher.dispatchStream.mock.calls[0][2];
      // Phase 99-M base shape preserved
      expect(prompt).toContain("[SUBAGENT_COMPLETION]");
      expect(prompt).toContain("Done with the non-GSD task.");
      // Crucially — NO Artifacts line for non-GSD subthreads
      expect(prompt).not.toContain("Artifacts written:");
    });

    /**
     * Quick task 260501-nfe — REGRESSION TEST FOR THE ROOT-CAUSE BUG.
     *
     * Before the fix, `relayCompletionToParent` called `turnDispatcher.dispatch(...)`
     * and discarded the returned response. The parent generated a summary but
     * it never reached Discord. This test pins the fix: a successful relay
     * MUST invoke `parentChannel.send(...)` with the streamed content.
     */
    it("posts the parent's summary to the parent's main channel via channel.send", async () => {
      const parentConfig = makeAgentConfig({});
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-id-relay",
            parentChannelId: "parent-chan-1",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-relay",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      const fetched = new Map<string, any>([
        ["m1", { author: { bot: true }, webhookId: "wh", content: "Subagent finished work." }],
      ]);
      const mockThreadChannel = {
        id: "thread-id-relay",
        name: "research-task",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockThreadChannel, "parent-chan-1");

      // Override default mock so dispatchStream emits a distinctive token via onChunk.
      turnDispatcher.dispatchStream = vi.fn(async (_origin, _agent, _prompt, onChunk) => {
        onChunk?.("Brief summary");
        return "Brief summary";
      });

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
      });

      await spawner.relayCompletionToParent("thread-id-relay");

      // The bug was: dispatch returned, value discarded, no send. The fix
      // streams onChunk into a ProgressiveMessageEditor that calls channel.send
      // for the first chunk. Assertion: send invoked with content containing
      // the summary string.
      expect(parentChannelSendSpy).toHaveBeenCalled();
      const sendArgs = parentChannelSendSpy.mock.calls.flat();
      const anyContainsSummary = sendArgs.some(
        (arg) => typeof arg === "string" && arg.includes("Brief summary"),
      );
      expect(anyContainsSummary).toBe(true);
    });

    /**
     * Quick task 260501-nfe — failure-mode regression: when channels.fetch
     * returns null for the parent channel, relay must log a structured
     * relay-skipped reason and return without dispatching.
     */
    it("logs relay-skipped reason=parent-channel-fetch-failed when channels.fetch returns null", async () => {
      const parentConfig = makeAgentConfig({});
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-id-fetchfail",
            parentChannelId: "parent-chan-missing",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-fetchfail",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      // Thread fetch returns a normal channel; parent fetch returns null.
      const fetched = new Map<string, any>([
        ["m1", { author: { bot: true }, webhookId: "wh", content: "Work done." }],
      ]);
      const mockThreadChannel = {
        id: "thread-id-fetchfail",
        name: "research-task",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = {
        channels: {
          fetch: vi.fn(async (id: string) =>
            id === "parent-chan-missing" ? null : mockThreadChannel,
          ),
        },
      };

      const logInfo = vi.fn();
      const log = {
        info: logInfo,
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(() => log),
      } as any;

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
        log,
      });

      await spawner.relayCompletionToParent("thread-id-fetchfail");

      // Structured log line emitted with the new reason tag
      const skippedCalls = logInfo.mock.calls.filter(
        (c) =>
          typeof c[1] === "string" && c[1].includes("subagent relay skipped"),
      );
      const fetchFailedCall = skippedCalls.find(
        (c) =>
          c[0] &&
          typeof c[0] === "object" &&
          c[0].reason === "parent-channel-fetch-failed",
      );
      expect(fetchFailedCall).toBeDefined();
      // Dispatch was NOT called — short-circuit before streaming.
      expect(turnDispatcher.dispatchStream).not.toHaveBeenCalled();
    });

    /**
     * Quick task 260501-nfe — failure-mode regression: when dispatchStream
     * resolves with empty content AND no chunk fired (so messageRef is still
     * null), relay must log relay-skipped reason=empty-response-from-parent
     * and avoid posting anything.
     */
    it("logs relay-skipped reason=empty-response-from-parent when dispatchStream resolves empty", async () => {
      const parentConfig = makeAgentConfig({});
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-id-empty-resp",
            parentChannelId: "parent-chan-2",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-empty-resp",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      const fetched = new Map<string, any>([
        ["m1", { author: { bot: true }, webhookId: "wh", content: "Subagent finished." }],
      ]);
      const mockThreadChannel = {
        id: "thread-id-empty-resp",
        name: "research-task",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockThreadChannel, "parent-chan-2");

      // dispatchStream resolves with empty string and never invokes onChunk.
      turnDispatcher.dispatchStream = vi.fn(async () => "");

      const logInfo = vi.fn();
      const log = {
        info: logInfo,
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(() => log),
      } as any;

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
        log,
      });

      await spawner.relayCompletionToParent("thread-id-empty-resp");

      const skippedCalls = logInfo.mock.calls.filter(
        (c) =>
          typeof c[1] === "string" && c[1].includes("subagent relay skipped"),
      );
      const emptyCall = skippedCalls.find(
        (c) =>
          c[0] &&
          typeof c[0] === "object" &&
          c[0].reason === "empty-response-from-parent",
      );
      expect(emptyCall).toBeDefined();
      // No content was sent to the parent channel.
      expect(parentChannelSendSpy).not.toHaveBeenCalled();
    });

    // Phase 999.60 (2026-05-15) — auto-dump subagent attachments into parent
    // channel. Production: research subagent shared its capability-gap table
    // via clawcode_share_file (Discord attachment); pre-999.60 relay walked
    // text-only and admin-clawdy received "subagent done" without content.
    // Operator had to manually ask for the file's contents.
    it("AD20 (999.60) — text attachment from subagent is auto-fetched + chunked + posted to parent channel BEFORE admin-clawdy relay summary", async () => {
      const parentConfig = makeAgentConfig({});
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-ad20",
            parentChannelId: "channel-ad20",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-ad20",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      // Subagent thread: one bot message with a .md attachment + brief text
      const longContent = "# OpenClaw Capability Gaps\n\n| Gap | Severity |\n|---|---|\n" + "| /subagents | high |\n".repeat(50);
      const subagentMessage = {
        author: { bot: true },
        webhookId: "webhook-123",
        content: "See attached.",
        attachments: {
          values: () => [
            {
              url: "https://cdn.discordapp.com/attachments/x/y/openclaw-gaps.md",
              name: "openclaw-gaps.md",
              size: longContent.length,
              contentType: "text/markdown",
            },
          ][Symbol.iterator](),
          size: 1,
        },
      };
      const fetched = new Map([["m1", subagentMessage]]);
      const mockChannel = {
        id: "thread-ad20",
        name: "openclaw-agent-capability-gaps",
        messages: {
          fetch: vi.fn(async () => fetched),
        },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-ad20");

      // Stub global fetch — relay calls fetch(a.url) to retrieve CDN content.
      const origFetch = (globalThis as any).fetch;
      (globalThis as any).fetch = vi.fn(async (_url: string) => ({
        ok: true,
        status: 200,
        text: async () => longContent,
      }));

      try {
        const spawner = new SubagentThreadSpawner({
          sessionManager,
          heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
          registryPath,
          discordClient: discordClient as any,
          turnDispatcher: turnDispatcher as any,
        });

        await spawner.relayCompletionToParent("thread-ad20");

        // Auto-dump sent at least one parent.send() with the attachment header.
        const sendCalls = parentChannelSendSpy.mock.calls.map((c) => c[0] as string);
        const headerCall = sendCalls.find((s) => s.includes("openclaw-gaps.md") && s.includes("auto-dumped"));
        expect(headerCall).toBeDefined();
        // Total auto-dump volume covers the full content (header + content > 2 chunks).
        const dumpedText = sendCalls
          .filter((s) => s.includes("openclaw-gaps.md") || s.includes("/subagents"))
          .join("");
        expect(dumpedText.length).toBeGreaterThan(longContent.length / 2);
        // admin-clawdy's summary turn also fired (the OK summary mock).
        expect(turnDispatcher.dispatchStream).toHaveBeenCalled();
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });

    it("AD21 (999.60) — binary/oversized attachment falls back to URL announcement (no inline fetch)", async () => {
      const parentConfig = makeAgentConfig({});
      sessionManager._setConfig("admin-clawdy", parentConfig);
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-ad21",
            parentChannelId: "channel-ad21",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-ad21",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      const subagentMessage = {
        author: { bot: true },
        webhookId: "webhook-123",
        content: "Generated chart.",
        attachments: {
          values: () => [
            {
              url: "https://cdn.discordapp.com/attachments/x/y/chart.png",
              name: "chart.png",
              size: 2_000_000, // 2MB, well over inline cap
              contentType: "image/png",
            },
          ][Symbol.iterator](),
          size: 1,
        },
      };
      const fetched = new Map([["m1", subagentMessage]]);
      const mockChannel = {
        id: "thread-ad21",
        name: "chart-gen",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-ad21");

      const origFetch = (globalThis as any).fetch;
      const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, text: async () => "(should not be reached)" }));
      (globalThis as any).fetch = fetchSpy;

      try {
        const spawner = new SubagentThreadSpawner({
          sessionManager,
          heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
          registryPath,
          discordClient: discordClient as any,
          turnDispatcher: turnDispatcher as any,
        });

        await spawner.relayCompletionToParent("thread-ad21");

        // Did NOT fetch the binary content.
        expect(fetchSpy).not.toHaveBeenCalled();
        // DID announce the URL.
        const sendCalls = parentChannelSendSpy.mock.calls.map((c) => c[0] as string);
        const announce = sendCalls.find((s) => s.includes("chart.png") && s.includes("cdn.discordapp.com"));
        expect(announce).toBeDefined();
      } finally {
        (globalThis as any).fetch = origFetch;
      }
    });

    // ── Phase 999.82-04 Task 2: relay-back fires for v3-channel-dispatched subagents ──
    //
    // A v3 subagent's turn is now dispatched over its channel (Task 1, not
    // streamFromAgent), and the channel reply is written to the thread by the
    // SAME backstop/overflow path the v2 reply used. `relayCompletionToParent`
    // reads the deliverable from that thread write, so when the PARENT is v3
    // (getParentChannelBridge resolves a bridge), the completion summary is
    // PUSHED over the parent's channel — unaffected by how the subagent's reply
    // arrived. These tests pin that the relay-back still fires.
    it("RELAY-V3-1 — v3 parent: relay PUSHES the subagent deliverable over the parent's channel bridge", async () => {
      const parentBridgePush = vi.fn((_msg: DaemonChannelMessage) => {});
      sessionManager._setConfig("admin-clawdy", makeAgentConfig());
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-v3-relay",
            parentChannelId: "channel-X",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-v3",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });

      // The thread carries the subagent's channel-dispatched reply (written by
      // Task 1's backstop edit — a bot message, exactly what relay reads).
      const fetched = new Map([
        [
          "m1",
          {
            author: { bot: true },
            webhookId: "wh",
            content: "V3 subagent deliverable from the channel reply.",
          },
        ],
      ]);
      const mockChannel = {
        id: "thread-v3-relay",
        name: "v3-relay-thread",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-X");

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
        // Parent is v3 → relay PUSHES over the channel instead of dispatching.
        getParentChannelBridge: (agent: string) =>
          agent === "admin-clawdy" ? { push: parentBridgePush } : undefined,
      });

      const relayed = await spawner.relayCompletionToParent("thread-v3-relay");

      // The relay-back PUSHED over the v3 parent's channel bridge (Plan-09),
      // NOT the v2 dispatchStream path.
      expect(parentBridgePush).toHaveBeenCalledOnce();
      expect(turnDispatcher.dispatchStream).not.toHaveBeenCalled();
      const pushed = parentBridgePush.mock.calls[0][0];
      expect(pushed.type).toBe("a2a");
      // The deliverable (the subagent's thread reply) is carried in the push.
      expect(pushed.content).toContain("V3 subagent deliverable");
      expect(pushed.meta?.source_agent).toBe("admin-clawdy-sub-v3");
      expect(pushed.meta?.subagent_thread).toBe("thread-v3-relay");
      // relay returns the subagent's verbatim reply for consolidation.
      expect(relayed).toContain("V3 subagent deliverable");
    });

    it("RELAY-V3-2 — v2 parent (no bridge): relay keeps the dispatchStream summary path UNCHANGED", async () => {
      sessionManager._setConfig("admin-clawdy", makeAgentConfig());
      await writeThreadRegistry(registryPath, {
        bindings: [
          {
            threadId: "thread-v2-relay",
            parentChannelId: "channel-X",
            agentName: "admin-clawdy",
            sessionName: "admin-clawdy-sub-v2",
            createdAt: Date.now(),
            lastActivity: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });
      const fetched = new Map([
        ["m1", { author: { bot: true }, webhookId: "wh", content: "V2 deliverable." }],
      ]);
      const mockChannel = {
        id: "thread-v2-relay",
        name: "v2-relay-thread",
        messages: { fetch: vi.fn(async () => fetched) },
      };
      const discordClient = buildDiscordClient(mockChannel, "channel-X");

      const spawner = new SubagentThreadSpawner({
        sessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: discordClient as any,
        turnDispatcher: turnDispatcher as any,
        // Parent is v2 → no channel bridge → unchanged dispatchStream summary.
        getParentChannelBridge: () => undefined,
      });

      await spawner.relayCompletionToParent("thread-v2-relay");

      // v2 relay unchanged: dispatchStream fired, no channel push.
      expect(turnDispatcher.dispatchStream).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Phase 999.3 — DEL-01..DEL-10 — delegateTo behavior pins.
 *
 * When the caller passes `delegateTo: <name>` to spawn_subagent_thread, the
 * spawned subagent inherits the DELEGATE's identity (model/soul/skills/
 * subagentModel/mcpServers) but lands in the CALLER's channel. See
 * .planning/phases/999.3-.../999.3-CONTEXT.md for D-INH-01..03, D-NAM-01..03,
 * D-TCX-01..03, D-EDG-01..05.
 */
describe("spawnInThread with delegateTo", () => {
  let tmpDir: string;
  let registryPath: string;
  let sessionManager: ReturnType<typeof makeMockSessionManager>;
  let discordMock: ReturnType<typeof makeMockDiscordClient>;
  let spawner: SubagentThreadSpawner;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "subagent-delegate-"));
    registryPath = join(tmpDir, "thread-bindings.json");
    sessionManager = makeMockSessionManager();
    discordMock = makeMockDiscordClient();

    // Caller "agent-a": haiku model, plain soul, caller-side webhook
    const callerConfig = makeAgentConfig({
      name: "agent-a",
      model: "haiku",
      soul: "caller soul",
      skills: [],
      mcpServers: [],
      threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 3 },
      webhook: {
        displayName: "Agent A",
        avatarUrl: "https://example.com/agent-a.png",
        webhookUrl: "https://discord.com/api/webhooks/CALLER_URL",
      },
    });
    sessionManager._setConfig("agent-a", callerConfig);

    // Delegate "research": opus model, research soul, opus skills + mcp
    const delegateConfig = makeAgentConfig({
      name: "research",
      model: "opus",
      soul: "research soul",
      identity: "research identity",
      skills: ["search-first", "market-research"],
      mcpServers: [
        { name: "exa", command: "exa", args: [], env: {}, optional: false },
      ],
      subagentModel: "sonnet",
      threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 99 },
      webhook: {
        displayName: "Research",
        avatarUrl: "https://example.com/research.png",
        webhookUrl: "https://discord.com/api/webhooks/DELEGATE_URL",
      },
    });
    sessionManager._setConfig("research", delegateConfig);

    spawner = new SubagentThreadSpawner({
      sessionManager,
      heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
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

  it("DEL-01: subagent inherits delegate's model/soul/skills/mcpServers/subagentModel (D-INH-01)", async () => {
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "research-task",
      delegateTo: "research",
    });

    const startedConfig = sessionManager.startAgent.mock.calls[0][1] as ResolvedAgentConfig;
    // delegate.subagentModel ("sonnet") wins over delegate.model ("opus")
    expect(startedConfig.model).toBe("sonnet");
    // soul carries delegate's content (then threadContext is appended)
    expect(startedConfig.soul).toContain("research soul");
    // skills and mcpServers come from delegate
    expect(startedConfig.skills).toEqual(["search-first", "market-research"]);
    expect(startedConfig.mcpServers).toHaveLength(1);
    expect(startedConfig.mcpServers[0].name).toBe("exa");
    // identity carried from delegate via spread
    expect(startedConfig.identity).toBe("research identity");
  });

  it("DEL-02: session name uses ${parent}-via-${delegate}-${shortId} (D-NAM-01)", async () => {
    const result = await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "research-task",
      delegateTo: "research",
    });
    expect(result.sessionName).toMatch(/^agent-a-via-research-[A-Za-z0-9_-]{6}$/);
  });

  it("DEL-03: threadContext appends Delegation Context block w/ canonical 'acting on behalf of' phrase (D-TCX-01)", async () => {
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "research-task",
      delegateTo: "research",
    });
    const startedConfig = sessionManager.startAgent.mock.calls[0][1] as ResolvedAgentConfig;
    expect(startedConfig.soul).toContain("## Delegation Context");
    expect(startedConfig.soul).toContain("acting on behalf of");
    // Parent agent name surfaces in the delegation block
    expect(startedConfig.soul).toContain("agent-a");
  });

  it("DEL-04: webhook = caller's URL + delegate's displayName + delegate's avatar (D-INH-03)", async () => {
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "research-task",
      delegateTo: "research",
    });
    const startedConfig = sessionManager.startAgent.mock.calls[0][1] as ResolvedAgentConfig;
    expect(startedConfig.webhook).toBeDefined();
    // CALLER's webhookUrl (channel-bound)
    expect(startedConfig.webhook?.webhookUrl).toBe(
      "https://discord.com/api/webhooks/CALLER_URL",
    );
    // DELEGATE's displayName + avatar (per-message overrides)
    expect(startedConfig.webhook?.displayName).toBe("Research");
    expect(startedConfig.webhook?.avatarUrl).toBe(
      "https://example.com/research.png",
    );
  });

  it("DEL-05: recursion guard regression — disallowedTools set even when delegateTo is provided (D-TCX-03)", async () => {
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "research-task",
      delegateTo: "research",
    });
    const startedConfig = sessionManager.startAgent.mock.calls[0][1] as ResolvedAgentConfig;
    expect(startedConfig.disallowedTools).toContain(
      "mcp__clawcode__spawn_subagent_thread",
    );
  });

  it("DEL-06: caller's threads.maxThreadSessions wins over delegate's (D-INH-02)", async () => {
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "research-task",
      delegateTo: "research",
    });
    const startedConfig = sessionManager.startAgent.mock.calls[0][1] as ResolvedAgentConfig;
    // Caller's quota (3) wins, NOT delegate's (99)
    expect(startedConfig.threads.maxThreadSessions).toBe(3);
  });

  it("DEL-07: dormant delegate (autoStart=false) is allowed — config read regardless of running state (D-EDG-02)", async () => {
    // Replace research with an autoStart=false (dormant) variant.
    const dormantDelegate = makeAgentConfig({
      name: "research",
      model: "opus",
      soul: "research soul",
      autoStart: false,
      threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 99 },
      webhook: {
        displayName: "Research",
        avatarUrl: "https://example.com/research.png",
        webhookUrl: "https://discord.com/api/webhooks/DELEGATE_URL",
      },
    });
    sessionManager._setConfig("research", dormantDelegate);

    await expect(
      spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "research-task",
        delegateTo: "research",
      }),
    ).resolves.toBeDefined();
  });

  it("DEL-08: self-delegation allowed; sessionName retains -via- infix (D-EDG-03)", async () => {
    const result = await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "self-task",
      delegateTo: "agent-a",
    });
    expect(result.sessionName).toMatch(/^agent-a-via-agent-a-[A-Za-z0-9_-]{6}$/);
  });

  it("DEL-09: back-compat — no delegateTo → sessionName uses -sub- infix (NOT -via-) (SPEC-07 / D-EDG-04)", async () => {
    const result = await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "no-delegate-task",
    });
    expect(result.sessionName).toMatch(/^agent-a-sub-[A-Za-z0-9_-]{6}$/);
    expect(result.sessionName).not.toContain("-via-");
  });

  it("DEL-10: defense-in-depth — delegate not found throws ManagerError verbatim at spawner level (D-EDG-05)", async () => {
    await expect(
      spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "ghost-task",
        delegateTo: "ghost-agent",
      }),
    ).rejects.toThrow(/Delegate agent 'ghost-agent' not found/);
  });

  // Phase 999.57 (2026-05-15) — delegated spawns must NOT auto-relay on the
  // subagent's first-message-stream-end. The subagent must call
  // `subagent_complete` to fire the relay. Pre-999.57 the relay grabbed
  // turn-1 ack text (or memory-leaked content) as "final response" and
  // archived the thread in 5-10s (production failures, admin-clawdy →
  // research, 2026-05-15 18:04 + 18:09).
  it("DEL-11 (999.57): delegated spawn does NOT auto-relay by default — relay is gated on subagent_complete", async () => {
    const spy = vi.spyOn(spawner, "relayCompletionToParent").mockResolvedValue(null);
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "research-task",
      delegateTo: "research",
      task: "look up cool features openclaw has that we don't",
      // Phase 999.19 D2 — delegated spawns now default autoArchive: true
      // (and autoArchive implies autoRelay). This test pins the 999.57
      // relay-gating behavior, which only applies when autoArchive is NOT
      // engaged; pass autoArchive: false explicitly so the gate-on-
      // subagent_complete path is exercised (caller opt-out preserved).
      autoArchive: false,
    });
    // Allow the fire-and-forget postInitialMessage chain to settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(spy).not.toHaveBeenCalled();
  });

  it("DEL-12 (999.57): delegated spawn WITH explicit autoRelay: true bypasses the gate (legacy one-shot path)", async () => {
    // Debug session `autorelay-placeholder-misfire` (2026-05-22) — this test
    // pins the 999.57 delegateTo-based relay gate, NOT the new content gate.
    // streamFromAgent must produce real content so the autoRelay content
    // gate does not (correctly) suppress the relay; the assertion below is
    // about the delegateTo+autoRelay path reaching relayCompletionToParent.
    vi.mocked(sessionManager.streamFromAgent).mockResolvedValue(
      "BTC is currently around $X. (real subagent reply)",
    );
    const spy = vi.spyOn(spawner, "relayCompletionToParent").mockResolvedValue(null);
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "quick-lookup",
      delegateTo: "research",
      task: "what's the current btc price",
      autoRelay: true,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(spy).toHaveBeenCalled();
  });

  it("DEL-13 (999.57): non-delegated spawn keeps legacy auto-relay-by-default behavior (back-compat pin)", async () => {
    // Debug session `autorelay-placeholder-misfire` (2026-05-22) — real
    // content so the content gate does not suppress; this pins the
    // non-delegated auto-relay-by-default behavior, a separate concern.
    vi.mocked(sessionManager.streamFromAgent).mockResolvedValue(
      "Quick thing done — here is the real result.",
    );
    const spy = vi.spyOn(spawner, "relayCompletionToParent").mockResolvedValue(null);
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "self-spawn",
      task: "do a quick thing",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(spy).toHaveBeenCalled();
  });

  it("DEL-14 (999.57): subagent threadContext instructs delegate to call subagent_complete", async () => {
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "research-task",
      delegateTo: "research",
    });
    const startedConfig = sessionManager.startAgent.mock.calls[0][1] as ResolvedAgentConfig;
    expect(startedConfig.soul).toContain("subagent_complete");
    // Production-failure language carried through so future maintainers
    // understand why this instruction exists.
    expect(startedConfig.soul).toContain("ack-and-wait");
  });

  // Phase 999.58 (2026-05-15) — long-deliverable contract. Production
  // failure: research subagent's capability-gap table hit Discord's 2000-char
  // cap mid-row at BOOTSTRAP.md. The relay summarized truncated content
  // because no file artifact was shared. Pin: subagents must be told to
  // use clawcode_share_file for long/structured deliverables.
  it("DEL-15 (999.58): subagent threadContext instructs use of clawcode_share_file for long deliverables", async () => {
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "research-task",
      delegateTo: "research",
    });
    const startedConfig = sessionManager.startAgent.mock.calls[0][1] as ResolvedAgentConfig;
    // The instruction mentions the share tool.
    expect(startedConfig.soul).toContain("clawcode_share_file");
    // The threshold guidance is present (1500 chars or structured content).
    expect(startedConfig.soul).toMatch(/1500|structured/);
    // The failure-mode reasoning is captured so the prompt isn't fragile —
    // a future maintainer who reads it understands the 2000-char Discord cap.
    expect(startedConfig.soul).toContain("2000");
  });

  it("DEL-16 (999.58): non-delegated subagent ALSO gets the long-deliverable instruction (baseContext, not delegationContext)", async () => {
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "self-spawn",
    });
    const startedConfig = sessionManager.startAgent.mock.calls[0][1] as ResolvedAgentConfig;
    expect(startedConfig.soul).toContain("clawcode_share_file");
    expect(startedConfig.soul).toMatch(/1500|structured/);
  });

  // Phase 999.61 (2026-05-15) — system-reminder discrimination. Production:
  // research subagent saw a Claude Code runtime <system-reminder> and replied
  // "Ignoring the reminder — current task is a focused Q&A, no todo list
  // needed" instead of executing the delegated task. Two-pronged fix pinned
  // by DEL-17 and DEL-18 below: (1) threadContext instructs the subagent to
  // distinguish reminders from task; (2) postInitialMessage wraps `task`
  // with an explicit YOUR TASK header + ignore-reminders directive.
  it("DEL-17 (999.61): subagent threadContext instructs distinguishing TASK from <system-reminder> tags", async () => {
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "research-task",
      delegateTo: "research",
    });
    const startedConfig = sessionManager.startAgent.mock.calls[0][1] as ResolvedAgentConfig;
    // The instruction names the system-reminder tag explicitly.
    expect(startedConfig.soul).toContain("system-reminder");
    // The contract is stated: task is the initial user message; reminders are
    // runtime nudges, not work.
    expect(startedConfig.soul).toMatch(/runtime nudge|harness/);
    // The negative path is also covered: if the first user message looks
    // suspicious, ask the parent — never silently ack-and-stop.
    expect(startedConfig.soul).toContain("ack-and-stop");
  });

  it("DEL-18 (999.61): postInitialMessage wraps task with YOUR TASK header + ignore-reminders directive", async () => {
    const localSessionManager = makeMockSessionManager();
    localSessionManager._setConfig(
      "agent-a",
      makeAgentConfig({
        webhook: {
          displayName: "Agent A",
          avatarUrl: "https://example.com/a.png",
          webhookUrl: "https://discord.com/api/webhooks/123/abc",
        },
      }),
    );
    // Capture the prompt passed into streamFromAgent.
    let capturedPrompt = "";
    vi.mocked(localSessionManager.streamFromAgent).mockImplementation(
      async (_name, msg, _onChunk) => {
        capturedPrompt = msg;
        return "ok";
      },
    );

    const placeholder = {
      id: "msg-placeholder",
      edit: vi.fn(async (_content: string) => undefined),
    };
    const mockThread = {
      id: "thread-del-18",
      sendTyping: vi.fn(async () => undefined),
      send: vi.fn(async () => placeholder),
    };
    const mockChannel = {
      id: "channel-del-18",
      threads: { create: vi.fn(async () => mockThread) },
      isTextBased: () => true,
    };
    const localDiscordClient = {
      channels: { fetch: vi.fn(async () => mockChannel) },
      user: { id: "bot-user-id" },
    };

    const localSpawner = new SubagentThreadSpawner({
      sessionManager: localSessionManager,
      heartbeatRunner: makeMockHeartbeatRunner() as any,
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
      registryPath,
      discordClient: localDiscordClient as any,
    });

    await localSpawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "task-frame-test",
      task: "investigate openclaw vs clawcode on GitHub",
    });
    await new Promise((r) => setTimeout(r, 50));

    // The task itself appears in the prompt.
    expect(capturedPrompt).toContain("investigate openclaw vs clawcode on GitHub");
    // The directive frame is present.
    expect(capturedPrompt).toContain("# YOUR TASK");
    expect(capturedPrompt).toContain("system-reminder");
    // The instruction to ignore runtime reminders is explicit.
    expect(capturedPrompt).toMatch(/runtime nudges?|NOT your task/);
  });

  // ------------------------------------------------------------------
  // Phase 126 (originally Phase 999.57) — Plan 02 regression tests
  // ------------------------------------------------------------------
  // DEL-15..DEL-19 from the original plan are renumbered to DEL-20..DEL-24
  // because DEL-15..DEL-18 already exist above (filed by 999.58/999.61
  // hotfix work before Plan 02 executed).
  //
  // These tests pin the Plan 01 production wiring: heartbeat override +
  // heartbeatRunner.setAgentConfigs() upsert + memory-retrieval suppression
  // + defensive markers + no-upward-leakage. A future refactor that
  // removes the factory call OR drops the runner registration OR weakens
  // a field default will fail at least one of these tests.
  // ------------------------------------------------------------------

  it("DEL-20-delegated (Phase 126 / D-01): subagent inherits heartbeat.enabled=false AND heartbeatRunner.setAgentConfigs is called with the subagent config", async () => {
    // Phase 999.57 / D-01 (corrected per RESEARCH Finding 1) — heartbeat
    // override AND runner registration together close the gate at
    // runner.ts:271. The override field alone is dead code (agentConfigs
    // map populated once at boot); the setAgentConfigs upsert is what
    // makes the existing gate fire.
    const heartbeatRunner = makeMockHeartbeatRunner();
    const sourceConfigSnapshot = structuredClone(
      sessionManager.getAgentConfig("research"),
    );

    const localSpawner = new SubagentThreadSpawner({
      sessionManager,
      heartbeatRunner,
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
      registryPath,
      discordClient: discordMock.client as any,
    });

    await localSpawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "del-20-delegated",
      delegateTo: "research",
    });

    const startedConfig = sessionManager.startAgent.mock
      .calls[0][1] as ResolvedAgentConfig;
    expect(startedConfig.heartbeat.enabled).toBe(false);

    // setAgentConfigs invoked exactly once with [subagentConfig]
    const setCalls = (heartbeatRunner as any).setAgentConfigs.mock.calls;
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0][0]).toHaveLength(1);
    const registeredConfig = setCalls[0][0][0];
    expect(registeredConfig.heartbeat.enabled).toBe(false);

    // The two paths converge on the same config object (referential identity)
    expect(registeredConfig).toBe(startedConfig);

    // No upward mutation: source `research` config unchanged
    expect(sessionManager.getAgentConfig("research")).toEqual(
      sourceConfigSnapshot,
    );
  });

  it("DEL-21-delegated (Phase 126 / D-02+D-04+Finding 4): memory retrieval, MEMORY.md auto-load, and conversation flush all suppressed for subagent", async () => {
    // Phase 999.57 / D-02 + D-04 + Finding 4 — memoryAutoLoad, topK,
    // tokenBudget, and memory.conversation.flushIntervalMinutes all zero.
    // Conditional spread (per Pitfall 3) preserves other conversation
    // block fields if the source supplied them.
    sessionManager._setConfig(
      "research",
      makeAgentConfig({
        name: "research",
        memoryAutoLoad: true,
        memoryRetrievalTopK: 8,
        memoryRetrievalTokenBudget: 2000,
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
          conversation: {
            flushIntervalMinutes: 15,
          },
        } as any,
      }),
    );

    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "del-21-delegated",
      delegateTo: "research",
    });

    const startedConfig = sessionManager.startAgent.mock
      .calls[0][1] as ResolvedAgentConfig;
    expect(startedConfig.memoryAutoLoad).toBe(false);
    expect(startedConfig.memoryRetrievalTopK).toBe(0);
    expect((startedConfig as any).memoryRetrievalTokenBudget).toBe(0);
    expect((startedConfig.memory as any).conversation?.flushIntervalMinutes).toBe(0);
  });

  it("DEL-22-delegated (Phase 126 / D-03 — Correction 3 per RESEARCH Finding 3): defensive markers — memoryScannerEnabled=false + memoryFlushIntervalMs=900_000 (schema default no-op)", async () => {
    // Phase 999.57 / D-03 — set-membership defensive markers. memoryScannerEnabled
    // has no runtime consumer for subagents (daemon-boot-only registration
    // at daemon.ts:3239-3274 iterates resolvedAgents, not subagents); test
    // pins the field as documentation-of-intent so a future refactor that
    // wires per-session scanners cannot silently leak.
    sessionManager._setConfig(
      "research",
      makeAgentConfig({
        name: "research",
        memoryScannerEnabled: true,
        memoryFlushIntervalMs: 60_000,
      }),
    );

    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "del-22-delegated",
      delegateTo: "research",
    });

    const startedConfig = sessionManager.startAgent.mock
      .calls[0][1] as ResolvedAgentConfig;
    expect(startedConfig.memoryScannerEnabled).toBe(false);
    expect(startedConfig.memoryFlushIntervalMs).toBe(900_000);
  });

  it("DEL-23-delegated (Phase 126 / D-05 — reframed per RESEARCH Finding 2): heartbeat-gate skip via registered subagent config (combined contract)", async () => {
    // Phase 999.57 / D-05 — no `inboxEnabled` field exists on
    // ResolvedAgentConfig (grep-confirmed in RESEARCH Finding 2). The
    // inbox heartbeat-check leak is closed transitively via
    // heartbeatRunner.setAgentConfigs registration: the runner gate at
    // runner.ts:271 finds the subagent's config with heartbeat.enabled=false
    // and short-circuits the tick. Live runner.tick() integration check
    // runs in Plan 03 on clawdy.
    const heartbeatRunner = makeMockHeartbeatRunner();

    const localSpawner = new SubagentThreadSpawner({
      sessionManager,
      heartbeatRunner,
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
      registryPath,
      discordClient: discordMock.client as any,
    });

    const result = await localSpawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "del-23-delegated",
      delegateTo: "research",
    });

    const setCalls = (heartbeatRunner as any).setAgentConfigs.mock.calls;
    expect(setCalls).toHaveLength(1);
    const registeredConfig = setCalls[0][0][0];
    expect(registeredConfig.heartbeat.enabled).toBe(false);
    // The registered config carries the subagent's session name — NOT the
    // source agent's name. The gate at runner.ts:271 must find this entry
    // when its tick fires for the subagent session.
    expect(registeredConfig.name).toBe(result.sessionName);
  });

  it("DEL-24-delegated (Phase 126 / D-09): no upward leakage — parent and source agent configs immutable across spawn", async () => {
    // Phase 999.57 / D-09 — no upward leakage. Parent and source agent
    // configs must remain immutable across spawn. structuredClone snapshot
    // before; toEqual compare after.
    const parentConfigBefore = structuredClone(
      sessionManager.getAgentConfig("agent-a"),
    );
    const sourceConfigBefore = structuredClone(
      sessionManager.getAgentConfig("research"),
    );

    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "del-24-delegated",
      delegateTo: "research",
    });

    expect(sessionManager.getAgentConfig("agent-a")).toEqual(parentConfigBefore);
    expect(sessionManager.getAgentConfig("research")).toEqual(sourceConfigBefore);
  });

  it("DEL-CHANNEL-REVERT (2026-05-21): delegated spawn creates its thread in the PARENT's channel, not the delegate's — Phase 999.19 T-03 routing reverted", async () => {
    // 2026-05-21 operator-requested revert of Phase 999.19 Plan 01 Task T-03
    // (commit 39c71a7) delegate-aware thread-creation routing. The subagent
    // thread must ALWAYS be created in the PARENT (spawning) agent's channel,
    // regardless of `delegateTo`. Under the 999.19 routing this test would
    // FAIL — `channels.fetch` was called with the delegate's channel.
    //
    // The shared `spawner`/`discordMock` for this describe block builds both
    // agents with the `makeAgentConfig` default `channels: ["channel-1"]`, so
    // every other DEL-* test passes under either the 999.19 routing OR the
    // revert. This test pins the behaviour by giving parent and delegate
    // DISTINCT channels — scoped locally so the shared fixtures are unaffected.
    const parentConfig = makeAgentConfig({
      name: "agent-a",
      model: "haiku",
      soul: "caller soul",
      skills: [],
      mcpServers: [],
      channels: ["channel-parent"],
      threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 3 },
      webhook: {
        displayName: "Agent A",
        avatarUrl: "https://example.com/agent-a.png",
        webhookUrl: "https://discord.com/api/webhooks/CALLER_URL",
      },
    });
    const delegateConfig = makeAgentConfig({
      name: "research",
      model: "opus",
      soul: "research soul",
      identity: "research identity",
      skills: ["search-first"],
      mcpServers: [],
      subagentModel: "sonnet",
      channels: ["channel-delegate"],
      threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 99 },
      webhook: {
        displayName: "Research",
        avatarUrl: "https://example.com/research.png",
        webhookUrl: "https://discord.com/api/webhooks/DELEGATE_URL",
      },
    });

    const localSessionManager = makeMockSessionManager();
    localSessionManager._setConfig("agent-a", parentConfig);
    localSessionManager._setConfig("research", delegateConfig);

    // Discord client whose channels.fetch resolves BOTH the parent's and the
    // delegate's channel ids — mirrors the multi-channel mock pattern used by
    // the `relayCompletionToParent integration` block.
    const mockThread = { id: "thread-revert-1", name: "del-channel-revert", send: vi.fn() };
    const fetchSpy = vi.fn(async (id: string) => ({
      id,
      threads: { create: vi.fn(async () => mockThread) },
      isTextBased: () => true,
    }));
    const localDiscordClient = { channels: { fetch: fetchSpy } };

    const localRegistryPath = join(tmpDir, "thread-bindings-revert.json");
    const localSpawner = new SubagentThreadSpawner({
      sessionManager: localSessionManager,
      heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
      registryPath: localRegistryPath,
      discordClient: localDiscordClient as any,
    });

    const result = await localSpawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "del-channel-revert",
      delegateTo: "research",
    });

    // The thread is created in the PARENT's channel — channels.fetch called
    // with "channel-parent" and NEVER with "channel-delegate".
    const fetchedIds = fetchSpy.mock.calls.map((c) => c[0]);
    expect(fetchedIds).toContain("channel-parent");
    expect(fetchedIds).not.toContain("channel-delegate");

    // The completion-relay target is the parent's channel.
    expect(result.channelId).toBe("channel-parent");
    const registry = await readThreadRegistry(localRegistryPath);
    const binding = registry.bindings.find((b) => b.threadId === mockThread.id);
    expect(binding?.parentChannelId).toBe("channel-parent");
  });
});

// ------------------------------------------------------------------
// Phase 126 / Plan 02 — non-delegated (D-06) regression tests
// ------------------------------------------------------------------
// D-06 requires the inheritance overrides apply to BOTH spawn paths
// (delegated and non-delegated). The delegated path has dense existing
// tests above; this sibling describe block adds D-06 coverage for the
// non-delegated path: a subagent spawned from agent-a's own identity
// (no delegateTo) gets the same heartbeat + memory suppression slice.
// ------------------------------------------------------------------
describe("spawnInThread without delegateTo (non-delegated) — Phase 126 D-06 inheritance overrides", () => {
  let tmpDir: string;
  let registryPath: string;
  let sessionManager: ReturnType<typeof makeMockSessionManager>;
  let discordMock: ReturnType<typeof makeMockDiscordClient>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "subagent-nondelegate-"));
    registryPath = join(tmpDir, "thread-bindings.json");
    sessionManager = makeMockSessionManager();
    discordMock = makeMockDiscordClient();

    sessionManager._setConfig(
      "agent-a",
      makeAgentConfig({
        name: "agent-a",
        memoryAutoLoad: true,
        memoryRetrievalTopK: 8,
        memoryRetrievalTokenBudget: 2000,
        heartbeat: {
          enabled: true,
          intervalSeconds: 60,
          checkTimeoutSeconds: 30,
          contextFill: { warningThreshold: 70, criticalThreshold: 90 },
        },
      }),
    );
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("DEL-20-non-delegated (Phase 126 / D-01+D-06): non-delegated subagent inherits heartbeat.enabled=false AND heartbeatRunner.setAgentConfigs is called", async () => {
    const heartbeatRunner = makeMockHeartbeatRunner();
    const spawner = new SubagentThreadSpawner({
      sessionManager,
      heartbeatRunner,
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
      registryPath,
      discordClient: discordMock.client as any,
    });

    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "del-20-non-delegated",
      // NOTE: no delegateTo
    });

    const startedConfig = sessionManager.startAgent.mock
      .calls[0][1] as ResolvedAgentConfig;
    expect(startedConfig.heartbeat.enabled).toBe(false);

    const setCalls = (heartbeatRunner as any).setAgentConfigs.mock.calls;
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0][0][0].heartbeat.enabled).toBe(false);
  });

  it("DEL-21-non-delegated (Phase 126 / D-02+D-04+D-06): non-delegated subagent has memoryAutoLoad=false + memoryRetrievalTopK=0 + memoryRetrievalTokenBudget=0", async () => {
    const spawner = new SubagentThreadSpawner({
      sessionManager,
      heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
      registryPath,
      discordClient: discordMock.client as any,
    });

    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "del-21-non-delegated",
    });

    const startedConfig = sessionManager.startAgent.mock
      .calls[0][1] as ResolvedAgentConfig;
    expect(startedConfig.memoryAutoLoad).toBe(false);
    expect(startedConfig.memoryRetrievalTopK).toBe(0);
    expect((startedConfig as any).memoryRetrievalTokenBudget).toBe(0);
  });
});

// Phase 999.59 (2026-05-15) — overflow chunking trigger uses
// accumulatedSeen (longest stream content) instead of just the SDK final
// reply. Pre-999.59 production failure: subagent emitted a long table
// mid-stream then closed with a short "Research complete." final block
// (responseLength: 254). The overflow handler's `text.length > 2000`
// check evaluated against 254 chars and never fired, so the editor-
// truncated placeholder was the only artifact and the deliverable was
// silently lost mid-row.
describe("postInitialMessage overflow trigger (Phase 999.59)", () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "subagent-overflow-trigger-"));
    registryPath = join(tmpDir, "thread-bindings.json");
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("OF-TRIG-1 (999.59): multi-block stream where final reply is short but accumulated > 2000 chars still triggers overflow chunks", async () => {
    const logCalls: { level: string; obj: any; msg: string }[] = [];
    const fakeLog = {
      info: vi.fn((obj: any, msg: string) => {
        logCalls.push({ level: "info", obj, msg });
      }),
      warn: vi.fn((obj: any, msg: string) => {
        logCalls.push({ level: "warn", obj, msg });
      }),
      debug: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(() => fakeLog),
    };

    const sentChunks: string[] = [];
    const placeholder = {
      id: "msg-placeholder",
      edit: vi.fn(async (_content: string) => undefined),
    };
    const sendTyping = vi.fn(async () => undefined);
    const mockThread = {
      id: "thread-of-trig-1",
      sendTyping,
      send: vi.fn(async (content: string) => {
        sentChunks.push(content);
        return placeholder;
      }),
    };
    const mockChannel = {
      id: "channel-of-trig-1",
      threads: { create: vi.fn(async () => mockThread) },
      isTextBased: () => true,
    };
    const localDiscordClient = {
      channels: { fetch: vi.fn(async () => mockChannel) },
      // Phase 999.36 sub-bug C: webhook send mock used by postInitialMessage
      // pipeline. Not exercised in this test but needs to exist.
      user: { id: "bot-user-id" },
    };

    const localSessionManager = makeMockSessionManager();
    localSessionManager._setConfig(
      "agent-a",
      makeAgentConfig({
        webhook: {
          displayName: "Agent A",
          avatarUrl: "https://example.com/a.png",
          webhookUrl: "https://discord.com/api/webhooks/999/abc",
        },
      }),
    );

    // The production failure pattern: SDK emits a long block during the
    // stream (via the onChunk callback's `accumulated`) but the SDK's
    // returned reply value is the short final-block text only.
    const longAccumulated = "Y".repeat(5000); // mid-stream table content
    const shortFinalReply = "Research complete. See deliverable above."; // ~42 chars
    vi.mocked(localSessionManager.streamFromAgent).mockImplementation(
      async (_name, _msg, onChunk) => {
        if (onChunk) onChunk(longAccumulated);
        return shortFinalReply;
      },
    );

    const spawner = new SubagentThreadSpawner({
      sessionManager: localSessionManager,
      heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
      registryPath,
      discordClient: localDiscordClient as any,
      log: fakeLog as any,
    });

    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "overflow-trigger-test",
      autoRelay: false,
    });

    await new Promise((r) => setTimeout(r, 50));

    // The overflow handler must have fired despite the short final reply.
    const summaryLog = logCalls.find((c) =>
      c.msg.includes("subagent overflow chunks summary"),
    );
    expect(summaryLog).toBeDefined();
    expect(summaryLog!.obj.fullySent).toBe(true);
    // totalLength should reflect accumulatedSeen (5000), not the short final
    // reply (~42) — proves the fix uses the longer of the two.
    expect(summaryLog!.obj.totalLength).toBeGreaterThan(2000);
    expect(summaryLog!.obj.chunksSent).toBeGreaterThanOrEqual(1);
  });

  it("OF-TRIG-2 (999.59): when final reply IS the full content (single-block turn), overflow still works correctly (back-compat with OF-LOG-1)", async () => {
    const logCalls: { level: string; obj: any; msg: string }[] = [];
    const fakeLog = {
      info: vi.fn((obj: any, msg: string) => {
        logCalls.push({ level: "info", obj, msg });
      }),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(() => fakeLog),
    };

    const sentChunks: string[] = [];
    const placeholder = {
      id: "msg-placeholder",
      edit: vi.fn(async (_content: string) => undefined),
    };
    const mockThread = {
      id: "thread-of-trig-2",
      sendTyping: vi.fn(async () => undefined),
      send: vi.fn(async (content: string) => {
        sentChunks.push(content);
        return placeholder;
      }),
    };
    const mockChannel = {
      id: "channel-of-trig-2",
      threads: { create: vi.fn(async () => mockThread) },
      isTextBased: () => true,
    };
    const localDiscordClient = {
      channels: { fetch: vi.fn(async () => mockChannel) },
      user: { id: "bot-user-id" },
    };

    const localSessionManager = makeMockSessionManager();
    localSessionManager._setConfig(
      "agent-a",
      makeAgentConfig({
        webhook: {
          displayName: "Agent A",
          avatarUrl: "https://example.com/a.png",
          webhookUrl: "https://discord.com/api/webhooks/999/abc",
        },
      }),
    );

    // Single-block: accumulated == reply (5000 chars in both).
    const big = "Z".repeat(5000);
    vi.mocked(localSessionManager.streamFromAgent).mockImplementation(
      async (_name, _msg, onChunk) => {
        if (onChunk) onChunk(big);
        return big;
      },
    );

    const spawner = new SubagentThreadSpawner({
      sessionManager: localSessionManager,
      heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
      registryPath,
      discordClient: localDiscordClient as any,
      log: fakeLog as any,
    });

    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "overflow-trigger-test-back-compat",
      autoRelay: false,
    });
    await new Promise((r) => setTimeout(r, 50));

    const summaryLog = logCalls.find((c) =>
      c.msg.includes("subagent overflow chunks summary"),
    );
    expect(summaryLog).toBeDefined();
    expect(summaryLog!.obj.fullySent).toBe(true);
    expect(summaryLog!.obj.totalLength).toBe(5000);
  });

  // Debug session `in-tool-wedge-recovery` work-stream (B), FORK 1 —
  // a wedged delegated subagent turn is NEVER auto re-run; it posts a
  // notify-only notice to the PARENT agent's channel. Gated on `wedgeInfo`
  // presence so ordinary subagent failures do not spam the parent channel.
  describe("subagent wedge recovery (work-stream B, FORK 1)", () => {
    /** Build an AbortError carrying a WedgeInfo, mirroring the SDK handle. */
    function wedgeAbortError(toolNames: readonly string[]): Error {
      const err = new Error("Aborted: interrupt deadline exceeded");
      err.name = "AbortError";
      (err as Error & { wedgeInfo?: unknown }).wedgeInfo = {
        reason: "sweep-force-release",
        inFlightToolNames: toolNames,
      };
      return err;
    }

    /**
     * Build a Discord client whose `channels.fetch` returns ONE channel
     * that doubles as the thread-creation surface AND the parent channel
     * (`send`). The `send` spy is returned so the test can assert the
     * wedge notice landed.
     */
    function makeWedgeDiscordClient(): {
      client: unknown;
      parentSend: ReturnType<typeof vi.fn>;
    } {
      const mockThread = {
        id: "thread-wedge",
        sendTyping: vi.fn(async () => undefined),
        send: vi.fn(async () => ({ id: "p", edit: vi.fn() })),
      };
      const parentSend = vi.fn(async () => ({ id: "notice" }));
      const mockChannel = {
        id: "channel-1",
        threads: { create: vi.fn(async () => mockThread) },
        isTextBased: () => true,
        send: parentSend,
      };
      return {
        client: { channels: { fetch: vi.fn(async () => mockChannel) } },
        parentSend,
      };
    }

    function makeSpawner(
      localSessionManager: ReturnType<typeof makeMockSessionManager>,
      client: unknown,
    ): SubagentThreadSpawner {
      localSessionManager._setConfig(
        "agent-a",
        makeAgentConfig({
          webhook: {
            displayName: "Agent A",
            avatarUrl: "https://example.com/a.png",
            webhookUrl: "https://discord.com/api/webhooks/123/abc",
          },
        }),
      );
      return new SubagentThreadSpawner({
        sessionManager: localSessionManager,
        heartbeatRunner: makeMockHeartbeatRunner(),
        registerLlmRuntime: makeMockRegisterLlmRuntime(),
        registryPath,
        discordClient: client as any,
      });
    }

    it("posts a notify-only notice to the parent channel when a subagent turn wedges", async () => {
      const { client, parentSend } = makeWedgeDiscordClient();
      const localSessionManager = makeMockSessionManager();
      // The subagent's turn wedges on a tool — the SDK handle attaches
      // wedgeInfo to the rejected AbortError.
      vi.mocked(localSessionManager.streamFromAgent).mockRejectedValue(
        wedgeAbortError(["mcp__clawcode__memory_lookup"]),
      );
      const spawner = makeSpawner(localSessionManager, client);

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "wedge-notify",
        autoRelay: false,
      });
      // Settle the deliberately-not-awaited postInitialMessage.
      await new Promise((r) => setTimeout(r, 100));

      // A notice was posted to the parent channel naming the stall.
      const noticeCall = parentSend.mock.calls.find((c) =>
        String(c[0]).includes("stalled"),
      );
      expect(noticeCall).toBeDefined();
      // FORK 1 — the subagent's own turn is NEVER re-run: streamFromAgent
      // was called exactly once.
      expect(localSessionManager.streamFromAgent).toHaveBeenCalledTimes(1);
    });

    it("does NOT post a parent notice for an ordinary (non-wedge) subagent failure", async () => {
      const { client, parentSend } = makeWedgeDiscordClient();
      const localSessionManager = makeMockSessionManager();
      // A plain error — no wedgeInfo. Must NOT trigger the parent notice
      // (otherwise every unrelated subagent failure would spam the parent).
      vi.mocked(localSessionManager.streamFromAgent).mockRejectedValue(
        new Error("ordinary subagent failure"),
      );
      const spawner = makeSpawner(localSessionManager, client);

      await spawner.spawnInThread({
        parentAgentName: "agent-a",
        threadName: "non-wedge-failure",
        autoRelay: false,
      });
      await new Promise((r) => setTimeout(r, 100));

      const noticeCall = parentSend.mock.calls.find((c) =>
        String(c[0]).includes("stalled"),
      );
      expect(noticeCall).toBeUndefined();
    });
  });
});

/**
 * Debug session `autorelay-placeholder-misfire` (2026-05-22) — REGRESSION
 * TESTS for the clawdy incident where a non-delegated subagent's autoRelay
 * fired on turn-1 stream-end and relayed the unedited 13-char "🔄 Working..."
 * placeholder to the parent as a completed result.
 *
 * Root cause (two parts, both in subagent-thread-spawner.ts):
 *   1. The ProgressiveMessageEditor edits the placeholder ONLY when its
 *      `onChunk` callback fires; `onChunk` fires ONLY on incremental SDK
 *      `text_delta` events. A buffered SDK reply (final text with no
 *      incremental deltas) → `onChunk` never fires → `editor.flush()` is a
 *      no-op → the placeholder is never edited.
 *   2. autoRelay then walks the thread and relays the lone unedited
 *      placeholder.
 *
 * These tests drive the REAL ProgressiveMessageEditor through the real
 * `spawnInThread` → `postInitialMessage` path. The mock `streamFromAgent`
 * resolves WITHOUT invoking `onChunk` — exactly the incident's SDK shape.
 * A test that stubbed the editor would pass before and after the fix and
 * prove nothing (cf. knowledge-base `reelforge-cmd-not-registered`).
 *
 * The placeholder literal is imported from the production module
 * (`SUBAGENT_WORKING_PLACEHOLDER`) — re-declaring it here would let the
 * production constant drift without these tests noticing.
 */
const WORKING_PLACEHOLDER = SUBAGENT_WORKING_PLACEHOLDER;

describe("autorelay-placeholder-misfire — regression", () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "autorelay-placeholder-"));
    registryPath = join(tmpDir, "thread-bindings.json");
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Build a fake editable thread + discord client. The thread's `send`
   * returns a placeholder object with an `edit` spy, so the production code
   * sees `canEdit === true` (the incident logged `canEdit:true`).
   */
  function buildEditableThread(threadId: string) {
    const editCalls: string[] = [];
    const sentMessages: string[] = [];
    const placeholder = {
      id: "msg-placeholder",
      edit: vi.fn(async (content: string) => {
        editCalls.push(content);
      }),
    };
    const mockThread = {
      id: threadId,
      sendTyping: vi.fn(async () => undefined),
      send: vi.fn(async (content: string) => {
        sentMessages.push(content);
        return placeholder;
      }),
    };
    const mockChannel = {
      id: `channel-${threadId}`,
      threads: { create: vi.fn(async () => mockThread) },
      isTextBased: () => true,
    };
    const client = {
      channels: { fetch: vi.fn(async () => mockChannel) },
      user: { id: "bot-user-id" },
    };
    return { client, mockThread, placeholder, editCalls, sentMessages };
  }

  it("APM-1: SDK reply without incremental deltas — placeholder is backstop-edited to the real content", async () => {
    // The incident's exact SDK shape: streamFromAgent resolves with a
    // 753-char reply but NEVER invokes onChunk (buffered, no text_delta).
    const realReply = "R".repeat(753);
    const sessionManager = makeMockSessionManager();
    sessionManager._setConfig(
      "agent-a",
      makeAgentConfig({
        webhook: {
          displayName: "Agent A",
          avatarUrl: "https://example.com/a.png",
          webhookUrl: "https://discord.com/api/webhooks/1/abc",
        },
      }),
    );
    vi.mocked(sessionManager.streamFromAgent).mockImplementation(
      // NB: third arg `onChunk` is deliberately NOT called.
      async (_name, _msg, _onChunk) => realReply,
    );

    const { client, placeholder, editCalls } = buildEditableThread("thread-apm-1");

    const spawner = new SubagentThreadSpawner({
      sessionManager,
      heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
      registryPath,
      discordClient: client as any,
    });

    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "sdd-build-phase-0",
      task: "do a multi-turn build",
      autoRelay: false, // isolate the backstop-edit behavior from the relay
    });
    await new Promise((r) => setTimeout(r, 80));

    // The placeholder must have been edited to the REAL reply — not left as
    // the 13-char "🔄 Working..." placeholder. The editor itself never fired
    // (onChunk was never called); the backstop write is what edited it.
    expect(placeholder.edit).toHaveBeenCalled();
    const lastEdit = editCalls[editCalls.length - 1];
    expect(lastEdit).toContain("R".repeat(100));
    expect(lastEdit).not.toBe(WORKING_PLACEHOLDER);
  });

  it("APM-2: autoRelay relays the REAL reply (not the placeholder) when the SDK skips incremental deltas", async () => {
    const realReply = "Final build result: phase 0 complete. ".repeat(10);
    const sessionManager = makeMockSessionManager();
    sessionManager._setConfig(
      "agent-a",
      makeAgentConfig({
        webhook: {
          displayName: "Agent A",
          avatarUrl: "https://example.com/a.png",
          webhookUrl: "https://discord.com/api/webhooks/1/abc",
        },
      }),
    );
    vi.mocked(sessionManager.streamFromAgent).mockImplementation(
      async (_name, _msg, _onChunk) => realReply,
    );

    const { client } = buildEditableThread("thread-apm-2");

    const spawner = new SubagentThreadSpawner({
      sessionManager,
      heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
      registryPath,
      discordClient: client as any,
    });

    // Spy relayCompletionToParent — assert it is called because the content
    // gate let the relay through (real content was produced).
    const relaySpy = vi
      .spyOn(spawner, "relayCompletionToParent")
      .mockResolvedValue(null);

    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "sdd-build-relay",
      task: "do a multi-turn build",
      autoRelay: true,
    });
    await new Promise((r) => setTimeout(r, 80));

    // producedRealContent === true → the relay fires.
    expect(relaySpy).toHaveBeenCalledWith("thread-apm-2");
  });

  it("APM-3: autoRelay is SKIPPED (placeholder never relayed) when the subagent produced no real content", async () => {
    // streamFromAgent resolves with undefined and never invokes onChunk —
    // the placeholder stays as "🔄 Working...". Pre-fix this is exactly the
    // state that produced relayLen:13 on clawdy. The content gate must skip
    // the relay entirely rather than relay the placeholder.
    const logCalls: { obj: any; msg: string }[] = [];
    const fakeLog: any = {
      info: vi.fn((obj: any, msg: string) => logCalls.push({ obj, msg })),
      warn: vi.fn((obj: any, msg: string) => logCalls.push({ obj, msg })),
      debug: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    };
    fakeLog.child = vi.fn(() => fakeLog);

    const sessionManager = makeMockSessionManager();
    sessionManager._setConfig(
      "agent-a",
      makeAgentConfig({
        webhook: {
          displayName: "Agent A",
          avatarUrl: "https://example.com/a.png",
          webhookUrl: "https://discord.com/api/webhooks/1/abc",
        },
      }),
    );
    // No content → resolves undefined, onChunk never invoked.
    vi.mocked(sessionManager.streamFromAgent).mockResolvedValue(
      undefined as unknown as string,
    );

    const { client } = buildEditableThread("thread-apm-3");

    const spawner = new SubagentThreadSpawner({
      sessionManager,
      heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
      registryPath,
      discordClient: client as any,
      log: fakeLog,
    });

    const relaySpy = vi
      .spyOn(spawner, "relayCompletionToParent")
      .mockResolvedValue(null);

    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "sdd-build-nocontent",
      task: "do a multi-turn build",
      autoRelay: true,
    });
    await new Promise((r) => setTimeout(r, 80));

    // The relay must NOT have fired — there is only a placeholder to relay.
    expect(relaySpy).not.toHaveBeenCalled();
    // ...and the skip must be logged so the failure mode is observable.
    const skipLog = logCalls.find((c) =>
      c.msg.includes("auto-relay skipped — subagent produced no real content"),
    );
    expect(skipLog).toBeDefined();
    // ...and the misleading "auto-relayed to parent" log must NOT fire —
    // logging both "skipped" and "auto-relayed" would mislead an operator
    // into thinking the relay succeeded (the same silent-wrong-result class
    // this debug session fixed). Guards the `else if` log gate.
    const misleadingLog = logCalls.find((c) =>
      c.msg.includes("subagent auto-relayed to parent"),
    );
    expect(misleadingLog).toBeUndefined();
  });

  it("APM-4: relayCompletionToParent defense-in-depth — skips the 'Working...' placeholder during the history walk", async () => {
    // Directly exercise relayCompletionToParent against a thread whose ONLY
    // bot message is the unedited placeholder. The walk must skip-continue
    // past it, find no real content, and skip the relay (the
    // `no-bot-messages-or-attachments` early return).
    const sessionManager = makeMockSessionManager();
    sessionManager._setConfig("admin-clawdy", makeAgentConfig({}));
    await writeThreadRegistry(registryPath, {
      bindings: [
        {
          threadId: "thread-apm-4",
          parentChannelId: "channel-X",
          agentName: "admin-clawdy",
          sessionName: "admin-clawdy-sub-JmugB4",
          createdAt: Date.now(),
          lastActivity: Date.now(),
        },
      ],
      updatedAt: Date.now(),
    });

    // The thread holds exactly the placeholder — a bot message with the
    // "🔄 Working..." content, no attachments.
    const fetched = new Map<string, any>([
      ["m1", { author: { bot: true }, webhookId: "wh", content: WORKING_PLACEHOLDER }],
    ]);
    const mockChannel = {
      id: "thread-apm-4",
      name: "sdd-build-phase-0",
      messages: { fetch: vi.fn(async () => fetched) },
    };
    const parentChannelSendSpy = vi.fn(async () => ({
      edit: vi.fn(async () => {}),
      id: "msg-1",
    }));
    const dispatchStream = vi.fn(async () => "summary");
    const discordClient = {
      channels: {
        fetch: vi.fn(async (id: string) =>
          id === "channel-X" ? { send: parentChannelSendSpy } : mockChannel,
        ),
      },
    };

    const spawner = new SubagentThreadSpawner({
      sessionManager,
      heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
      registryPath,
      discordClient: discordClient as any,
      turnDispatcher: { dispatchStream } as any,
    });

    const relayed = await spawner.relayCompletionToParent("thread-apm-4");

    // The placeholder was skip-continued → no real content → relay skipped.
    expect(relayed).toBeNull();
    expect(dispatchStream).not.toHaveBeenCalled();
    expect(parentChannelSendSpy).not.toHaveBeenCalled();
  });

  it("APM-5: relayCompletionToParent still relays a REAL message that follows the placeholder in history", async () => {
    // The placeholder filter must skip-continue, NOT break — a real message
    // older-in-fetch-order than the placeholder must still be relayed.
    // Discord fetch is newest-first; put the placeholder newest, the real
    // reply older, both from the bot.
    const sessionManager = makeMockSessionManager();
    sessionManager._setConfig("admin-clawdy", makeAgentConfig({}));
    await writeThreadRegistry(registryPath, {
      bindings: [
        {
          threadId: "thread-apm-5",
          parentChannelId: "channel-X",
          agentName: "admin-clawdy",
          sessionName: "admin-clawdy-sub-real",
          createdAt: Date.now(),
          lastActivity: Date.now(),
        },
      ],
      updatedAt: Date.now(),
    });

    // newest-first: [placeholder, real-reply]
    const fetched = new Map<string, any>([
      ["m2", { author: { bot: true }, webhookId: "wh", content: WORKING_PLACEHOLDER }],
      ["m1", { author: { bot: true }, webhookId: "wh", content: "The real deliverable text." }],
    ]);
    const mockChannel = {
      id: "thread-apm-5",
      name: "sdd-build-phase-0",
      messages: { fetch: vi.fn(async () => fetched) },
    };
    const parentChannelSendSpy = vi.fn(async () => ({
      edit: vi.fn(async () => {}),
      id: "msg-1",
    }));
    const dispatchStream = vi.fn(
      async (_o: any, _a: any, _p: string) => "summary",
    );
    const discordClient = {
      channels: {
        fetch: vi.fn(async (id: string) =>
          id === "channel-X" ? { send: parentChannelSendSpy } : mockChannel,
        ),
      },
    };

    const spawner = new SubagentThreadSpawner({
      sessionManager,
      heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
      registryPath,
      discordClient: discordClient as any,
      turnDispatcher: { dispatchStream } as any,
    });

    const relayed = await spawner.relayCompletionToParent("thread-apm-5");

    // The real message is relayed; the placeholder was skipped, not a stop.
    expect(dispatchStream).toHaveBeenCalledTimes(1);
    const prompt: string = dispatchStream.mock.calls[0][2];
    expect(prompt).toContain("The real deliverable text.");
    expect(prompt).not.toContain(WORKING_PLACEHOLDER);
    expect(relayed).toContain("The real deliverable text.");
  });

  describe("isRealSubagentContent — predicate", () => {
    it("rejects empty string", () => {
      expect(isRealSubagentContent("")).toBe(false);
    });

    it("rejects the exact streaming placeholder", () => {
      expect(isRealSubagentContent(WORKING_PLACEHOLDER)).toBe(false);
    });

    it("accepts a short genuine reply (no length floor — 'Done.' is real content)", () => {
      expect(isRealSubagentContent("Done.")).toBe(true);
      expect(isRealSubagentContent("OK")).toBe(true);
      expect(isRealSubagentContent("Confirmed.")).toBe(true);
    });

    it("accepts a long genuine reply", () => {
      expect(isRealSubagentContent("R".repeat(753))).toBe(true);
    });
  });
});

/**
 * Debug session `autorelay-fires-after-turn-1` (2026-05-22) — option C
 * regression suite.
 *
 * THE BUG. `postInitialMessage` awaits exactly ONE SDK turn, then fires
 * `relayCompletionToParent` when `autoRelay` is true. Non-delegated `-sub-`
 * spawns default `autoRelay: true`, so a non-delegated MULTI-TURN subagent
 * (e.g. a `/gsd:*` phase build doing "Phase 0" of a multi-phase task) had
 * its turn-1 output relayed to the parent's main channel as the finished
 * deliverable.
 *
 * THE FIX (option C). Multi-turn is now a non-delegated explicit
 * `autoRelay: false` opt-in. The non-delegated DEFAULT stays `true` — a
 * one-shot Q&A subagent (whose first reply IS the deliverable) is
 * completely untouched and still relays after turn-1. A multi-turn caller
 * (the `/gsd:*` slash path; any MCP caller per the `spawn_subagent_thread`
 * tool description) passes `autoRelay: false`; the subagent then signals
 * genuine completion via the `subagent_complete` MCP tool.
 *
 * Two load-bearing regression properties pinned here:
 *   AR1-A — a MULTI-TURN non-delegated spawn (`autoRelay: false`) does NOT
 *           relay on turn-1 (the bug is fixed).
 *   AR1-B — a ONE-SHOT non-delegated spawn (autoRelay default) STILL
 *           relays after turn-1 (option C did not strand one-shot — the
 *           entire reason C was chosen over the contract-change option A).
 */
describe("autorelay-fires-after-turn-1 — option C regression", () => {
  let tmpDir: string;
  let registryPath: string;
  let sessionManager: ReturnType<typeof makeMockSessionManager>;
  let discordMock: ReturnType<typeof makeMockDiscordClient>;
  let spawner: SubagentThreadSpawner;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "autorelay-turn1-"));
    registryPath = join(tmpDir, "thread-bindings.json");
    sessionManager = makeMockSessionManager();
    discordMock = makeMockDiscordClient();

    sessionManager._setConfig(
      "agent-a",
      makeAgentConfig({
        webhook: {
          displayName: "Agent A",
          avatarUrl: "https://example.com/avatar.png",
          webhookUrl: "https://discord.com/api/webhooks/123/abc",
        },
      }),
    );

    spawner = new SubagentThreadSpawner({
      sessionManager,
      heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
      registryPath,
      discordClient: discordMock.client as any,
    });
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("AR1-A: a MULTI-TURN non-delegated spawn (autoRelay:false) does NOT relay on turn-1", async () => {
    // The reported repro: a non-delegated subagent doing multi-phase work.
    // streamFromAgent resolves with real turn-1 content (an ack / a
    // tool-use prelude — NOT the final deliverable). With autoRelay:false
    // the turn-1 relay must be suppressed; completion will instead flow
    // through the explicit `subagent_complete` IPC when the work is done.
    vi.mocked(sessionManager.streamFromAgent).mockResolvedValue(
      "Phase 0: starting — reading the codebase now. (turn-1 prelude, not the deliverable)",
    );
    const spy = vi
      .spyOn(spawner, "relayCompletionToParent")
      .mockResolvedValue(null);

    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "sdd-multi-phase-build",
      task: "execute the multi-phase build, Phase 0 through Phase 3",
      // The option-C opt-in — the slash `/gsd:*` path and MCP multi-turn
      // callers pass this explicitly.
      autoRelay: false,
    });

    // Settle the deliberately-not-awaited postInitialMessage chain.
    await new Promise((r) => setTimeout(r, 100));

    // The relay must NOT have fired on turn-1 — this is the bug fix.
    expect(spy).not.toHaveBeenCalled();
  });

  it("AR1-B: a ONE-SHOT non-delegated spawn (autoRelay default) STILL relays after turn-1 (no strand)", async () => {
    // Option C preserves the non-delegated `autoRelay: true` DEFAULT. A
    // one-shot Q&A subagent — whose first reply IS the complete deliverable
    // — must still relay after turn-1 exactly as before the fix. This is
    // the safety property that made C preferable to the fleet-wide
    // contract-change option A: one-shot subagents are not stranded.
    vi.mocked(sessionManager.streamFromAgent).mockResolvedValue(
      "The answer is 42 — here is the complete one-shot deliverable.",
    );
    const spy = vi
      .spyOn(spawner, "relayCompletionToParent")
      .mockResolvedValue(null);

    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "quick-qa",
      task: "what is the answer",
      // NO autoRelay passed — exercises the non-delegated default (true).
    });

    await new Promise((r) => setTimeout(r, 100));

    // The relay STILL fires on turn-1 for a one-shot spawn — unchanged.
    expect(spy).toHaveBeenCalled();
  });

  it("AR1-C: a multi-turn non-delegated spawn (autoRelay:false) is instructed to call subagent_complete", async () => {
    // When the turn-1 relay is suppressed (autoRelay:false), the subagent
    // MUST be told to signal completion via `subagent_complete` — otherwise
    // its parent is never notified. Pre-fix the threadContext instruction
    // was gated on the word "delegated", so a non-delegated multi-turn
    // subagent read it as not-applicable. The instruction is now
    // relay-mode-aware (REQUIRED branch when autoRelay is false).
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "multi-phase-build",
      task: "execute the multi-phase build",
      autoRelay: false,
    });

    const startedConfig = sessionManager.startAgent.mock
      .calls[0][1] as ResolvedAgentConfig;
    // The non-delegated multi-turn subagent IS told to call the tool.
    expect(startedConfig.soul).toContain("subagent_complete");
    // The REQUIRED-branch framing is present (not the "automatic" wording).
    expect(startedConfig.soul).toContain("Completion signal");
  });

  it("AR1-D: a one-shot non-delegated spawn (autoRelay default) is told completion is automatic — need NOT call subagent_complete", async () => {
    // The mirror of AR1-C: a one-shot non-delegated spawn keeps the
    // turn-1 auto-relay, so it must NOT be told to call `subagent_complete`
    // (calling it would be a no-op at best, confusing at worst). The
    // relay-mode-aware instruction emits the "automatic" branch here.
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "quick-qa",
      task: "what is the answer",
    });

    const startedConfig = sessionManager.startAgent.mock
      .calls[0][1] as ResolvedAgentConfig;
    // The "automatic" branch is present.
    expect(startedConfig.soul).toContain("Completion — automatic");
    // And it explicitly tells the one-shot subagent it need not call the tool.
    expect(startedConfig.soul).toMatch(
      /do NOT need to call .?subagent_complete/i,
    );
  });

  it("QU5-A: the automatic branch (default spawn) forcefully requires the deliverable as the FINAL plain-text message and does NOT instruct calling subagent_complete", async () => {
    // 260610-qu5 CHANGE #1 — the relay scrapes posted thread messages, so a
    // subagent that ends its turn on a bare tool call delivers nothing. The
    // automatic branch must forcefully state the deliverable is the FINAL
    // plain-text message AND must still NOT tell the subagent to call the
    // payload-less `subagent_complete` (the turn-1 relay fires for it).
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "quick-qa",
      task: "what is the answer",
      // NO autoRelay passed — non-delegated default (true) → automatic branch.
    });

    const startedConfig = sessionManager.startAgent.mock
      .calls[0][1] as ResolvedAgentConfig;
    const soul = startedConfig.soul as string;

    // The automatic branch is the one emitted.
    expect(soul).toContain("Completion — automatic");
    // Forceful framing: relay scrapes posted messages; bare tool call delivers
    // nothing; deliverable must be the FINAL plain-text message.
    expect(soul).toContain("the relay scrapes the messages you POSTED");
    expect(soul).toContain("FINAL plain-text message");
    expect(soul).toContain("ends on a bare tool call delivers NOTHING");
    // It must STILL tell the one-shot subagent it need NOT call the tool —
    // the automatic branch does not instruct calling subagent_complete.
    expect(soul).toMatch(/do NOT need to call .?subagent_complete/i);
  });

  it("QU5-B: the completion-signal branch (autoRelay:false) forcefully requires posting the deliverable as plain text FIRST, THEN calling subagent_complete", async () => {
    // 260610-qu5 CHANGE #1 — the completion-signal branch must state that
    // subagent_complete carries NO content, that the deliverable must be
    // POSTED as plain text in the thread FIRST, and only THEN signalled with
    // exactly one subagent_complete call (post first, signal second).
    await spawner.spawnInThread({
      parentAgentName: "agent-a",
      threadName: "multi-phase-build",
      task: "execute the multi-phase build",
      autoRelay: false,
    });

    const startedConfig = sessionManager.startAgent.mock
      .calls[0][1] as ResolvedAgentConfig;
    const soul = startedConfig.soul as string;

    // The completion-signal branch is the one emitted.
    expect(soul).toContain("Completion signal");
    // Forceful framing: tool carries no content; post plain text FIRST.
    expect(soul).toContain("carries NO content");
    expect(soul).toContain("plain-text message in this thread FIRST");
    expect(soul).toContain("Post first, signal second");
    // It still instructs the deferred-relay subagent to call the tool once.
    expect(soul).toMatch(/call the .?subagent_complete.? MCP tool exactly ONCE/i);
  });
});

describe("M2 — relayCompletionToParent exactly-once across concurrent paths", () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "relay-once-"));
    registryPath = join(tmpDir, "thread-bindings.json");
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 30));
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Build a spawner whose Discord + dispatcher mocks let
   * relayCompletionToParent reach the parent-summary dispatch. The thread
   * channel exposes one bot message (so the relay has content); the parent
   * channel exposes `send`; the turnDispatcher records each dispatchStream.
   */
  function makeRelaySpawner() {
    const dispatchStream = vi.fn(async () => "parent summary text");
    const parentSend = vi.fn(async () => ({ edit: vi.fn(async () => {}) }));

    const threadChannel = {
      id: "thread-once",
      messages: {
        fetch: vi.fn(async () => ({
          values: () => [
            {
              author: { bot: true },
              content: "the subagent's real answer",
              attachments: { values: () => [] as unknown[] },
            },
          ],
        })),
      },
    };
    const parentChannel = { id: "parent-ch", send: parentSend };

    const discordClient = {
      channels: {
        fetch: vi.fn(async (id: string) =>
          id === "thread-once" ? threadChannel : parentChannel,
        ),
      },
    };

    const sessionManager = makeMockSessionManager();
    const agentConfig = makeAgentConfig({});
    sessionManager._setConfig("agent-a", agentConfig);

    const spawner = new SubagentThreadSpawner({
      sessionManager,
      heartbeatRunner: makeMockHeartbeatRunner(),
      registerLlmRuntime: makeMockRegisterLlmRuntime(),
      registryPath,
      discordClient: discordClient as never,
      turnDispatcher: { dispatchStream } as never,
    });

    return { spawner, dispatchStream, parentSend };
  }

  it("two concurrent relays for the same thread dispatch the parent summary AT MOST ONCE", async () => {
    await writeThreadRegistry(registryPath, {
      bindings: [
        {
          threadId: "thread-once",
          parentChannelId: "parent-ch",
          agentName: "agent-a",
          sessionName: "agent-a-sub-Once11",
          createdAt: Date.now() - 60_000,
          lastActivity: Date.now() - 10_000,
          lastDeliveryAt: Date.now() - 5_000,
        },
      ],
      updatedAt: Date.now(),
    });

    const { spawner, dispatchStream } = makeRelaySpawner();

    // Fire the IPC-style relay and a direct (session-end/auto-relay-style)
    // relay concurrently for the SAME thread.
    await Promise.all([
      spawner.relayCompletionToParent("thread-once"),
      spawner.relayCompletionToParent("thread-once"),
    ]);

    // The per-thread relay lock + in-lock completedAt dedupe must collapse
    // these to a single parent-summary dispatch (no double-post).
    expect(dispatchStream.mock.calls.length).toBeLessThanOrEqual(1);

    // completedAt is stamped exactly once → the binding is terminal.
    const reg = await readThreadRegistry(registryPath);
    const b = reg.bindings.find((x) => x.threadId === "thread-once");
    expect(b?.completedAt).toBeTypeOf("number");
  });

  it("a relay after completion is a no-op (dedupe holds across sequential calls)", async () => {
    await writeThreadRegistry(registryPath, {
      bindings: [
        {
          threadId: "thread-once",
          parentChannelId: "parent-ch",
          agentName: "agent-a",
          sessionName: "agent-a-sub-Once22",
          createdAt: Date.now() - 60_000,
          lastActivity: Date.now() - 10_000,
          lastDeliveryAt: Date.now() - 5_000,
        },
      ],
      updatedAt: Date.now(),
    });

    const { spawner, dispatchStream } = makeRelaySpawner();

    await spawner.relayCompletionToParent("thread-once");
    const afterFirst = dispatchStream.mock.calls.length;
    await spawner.relayCompletionToParent("thread-once");

    // The second call observes completedAt and skips — no additional dispatch.
    expect(dispatchStream.mock.calls.length).toBe(afterFirst);
  });
});
