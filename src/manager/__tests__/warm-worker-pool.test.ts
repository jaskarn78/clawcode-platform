/**
 * Phase 999.86 — WarmWorkerPool unit pins.
 *
 * Scope: the pool's lifecycle invariants — pre-spawn count, dispatch
 * pop-then-refill, PTY-write shape, teardown ordering. Real
 * `claude --channels`, real PTY, and real Discord are NOT exercised
 * here; the live canary in `999.86-CANARY.md` covers them.
 *
 * The fakes match the shapes the daemon injects in production:
 *   - `sessionManager` exposes startAgent/stopAgent + getAgentConfig
 *   - `registerLlmRuntime` is the daemon callback at daemon.ts:9042
 *   - `wireChannelForSubagent` mirrors agentChannelRegistry.wireForConfig
 *   - `liveSupervisorByAgent` is the module-level map populated by
 *     ClaudeCodeInteractiveBackend.loadSdkModule.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Logger } from "pino";

import {
  WarmWorkerPool,
  buildWorkerConfig,
  type WarmWorkerPoolDeps,
} from "../warm-worker-pool.js";
import { ChannelReplyTimeoutError } from "../agent-channel-bridge.js";
import type { ChannelSpawnSeam } from "../../llm-runtime/backends/claude-code-interactive.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { AckInput } from "../../channels/clawcode-channel-server.js";

/** Discard-everything logger. */
const silentLogger: Logger = {
  level: "silent",
  silent: () => undefined,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

function makeParentConfig(
  name: string,
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    name,
    workspace: `/tmp/${name}`,
    memoryPath: `/tmp/${name}`,
    channels: ["channel-1"],
    model: "sonnet",
    effort: "low",
    allowedModels: ["haiku", "sonnet", "opus"],
    greetOnRestart: true,
    greetCoolDownMs: 300_000,
    autoCompactAt: 0.7,
    memoryAutoLoad: true,
    memoryRetrievalTopK: 5,
    memoryScannerEnabled: true,
    memoryFlushIntervalMs: 900_000,
    memoryCueEmoji: "✅",
    autoIngestAttachments: false,
    ingestionPriority: "medium" as const,
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
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
    slashCommands: [],
    reactions: false,
    mcpServers: [],
    llmRuntime: { backend: "claude-code-interactive" },
    ...overrides,
  } as ResolvedAgentConfig;
}

interface BridgeStub {
  push: ReturnType<typeof vi.fn>;
  awaitReply: ReturnType<typeof vi.fn>;
  registerProgressCallback: ReturnType<typeof vi.fn>;
  clearProgressCallback: ReturnType<typeof vi.fn>;
  emitProgress(text: string): void;
  resolveReply(result?: string): void;
  rejectReply(err: Error): void;
}

function makeBridgeStub(): BridgeStub {
  let progressCb: ((text: string) => void) | undefined;
  let resolveReply: ((v: AckInput) => void) | undefined;
  let rejectReply: ((e: Error) => void) | undefined;
  const replyPromise = new Promise<AckInput>((res, rej) => {
    resolveReply = res;
    rejectReply = rej;
  });
  const bridge: BridgeStub = {
    push: vi.fn(),
    awaitReply: vi.fn(() => replyPromise),
    registerProgressCallback: vi.fn((cb: (text: string) => void) => {
      progressCb = cb;
    }),
    clearProgressCallback: vi.fn(() => {
      progressCb = undefined;
    }),
    emitProgress: (text: string) => progressCb?.(text),
    resolveReply: (result?: string) =>
      resolveReply?.({
        message_id: "ack-msg",
        status: "processed",
        result: result ?? "ok",
      }),
    rejectReply: (err: Error) => rejectReply?.(err),
  };
  return bridge;
}

interface PoolFixture {
  pool: WarmWorkerPool;
  liveSupervisorByAgent: Map<string, ChannelSpawnSeam>;
  wireCalls: ResolvedAgentConfig[];
  unwireCalls: string[];
  startedSessions: string[];
  stoppedSessions: string[];
  bridges: Map<string, BridgeStub>;
  listeners: Map<string, { isConnected: () => boolean; markConnected: () => void }>;
  // Manually trigger a worker's PTY-write capture.
  writesFor(sessionName: string): string[];
  idCounter: { value: number };
}

function makeFixture(
  parent: string,
  poolAgents: { name: string; warmSize: number; maxConcurrent?: number }[],
  opts: {
    /** Auto-flip listener.isConnected() to true (default). When false, callers must
        flip via the listener stub returned in `listeners`. */
    autoConnect?: boolean;
    /** Phase 141 WS-1 (1B) — opt into worker reuse (default off, as in prod the
        daemon gates it behind CLAWCODE_WARM_POOL_REUSE). */
    reuseWorkers?: boolean;
  } = { autoConnect: true },
): PoolFixture {
  const liveSupervisorByAgent = new Map<string, ChannelSpawnSeam>();
  const wireCalls: ResolvedAgentConfig[] = [];
  const unwireCalls: string[] = [];
  const startedSessions: string[] = [];
  const stoppedSessions: string[] = [];
  const bridges = new Map<string, BridgeStub>();
  const listeners = new Map<
    string,
    { isConnected: () => boolean; markConnected: () => void }
  >();
  const writeBuffersBySession = new Map<string, string[]>();
  const parentConfig = makeParentConfig(parent);
  const idCounter = { value: 0 };

  const deps: WarmWorkerPoolDeps = {
    sessionManager: {
      startAgent: vi.fn(async (name: string, _cfg: ResolvedAgentConfig) => {
        startedSessions.push(name);
        // Register a fake supervisor whose `write` records into the buffer.
        const writes: string[] = [];
        writeBuffersBySession.set(name, writes);
        liveSupervisorByAgent.set(name, {
          spawn: async () => undefined,
          write: (data: string) => {
            writes.push(data);
          },
        });
      }),
      stopAgent: vi.fn(async (name: string) => {
        stoppedSessions.push(name);
      }),
    } as unknown as WarmWorkerPoolDeps["sessionManager"],
    registerLlmRuntime: vi.fn(),
    wireChannelForSubagent: ((cfg: ResolvedAgentConfig) => {
      wireCalls.push(cfg);
      const bridge = makeBridgeStub();
      bridges.set(cfg.name, bridge);
      let connected = opts.autoConnect ?? true;
      const listener = {
        isConnected: () => connected,
        markConnected: () => {
          connected = true;
        },
      };
      listeners.set(cfg.name, listener);
      return { bridge, listener };
    }) as unknown as WarmWorkerPoolDeps["wireChannelForSubagent"],
    unwireChannelForSubagent: vi.fn(async (name: string) => {
      unwireCalls.push(name);
    }),
    getParentConfig: (n: string) => (n === parent ? parentConfig : undefined),
    liveSupervisorByAgent,
    logger: silentLogger,
    connectPollMs: 1,
    connectCeilingMs: 100,
    generateId: () => {
      idCounter.value += 1;
      return `id${idCounter.value}`;
    },
    reuseWorkers: opts.reuseWorkers ?? false,
  };

  const pool = new WarmWorkerPool(deps, poolAgents);
  return {
    pool,
    liveSupervisorByAgent,
    wireCalls,
    unwireCalls,
    startedSessions,
    stoppedSessions,
    bridges,
    listeners,
    writesFor: (sessionName: string) => writeBuffersBySession.get(sessionName) ?? [],
    idCounter,
  };
}

describe("WarmWorkerPool — start() pre-spawns workers per configured agent", () => {
  it("with warmSize=2 pre-spawns 2 workers and the queue size reflects it", async () => {
    const fx = makeFixture("test-agent", [{ name: "test-agent", warmSize: 2 }]);
    await fx.pool.start();

    expect(fx.startedSessions).toHaveLength(2);
    expect(fx.wireCalls).toHaveLength(2);
    const sizes = fx.pool.size("test-agent");
    expect(sizes.warm).toBe(2);
    expect(sizes.spawning).toBe(0);
    expect(sizes.inFlight).toBe(0);
  });

  it("with warmSize=0 pre-spawns nothing", async () => {
    const fx = makeFixture("test-agent", [{ name: "test-agent", warmSize: 0 }]);
    await fx.pool.start();
    expect(fx.startedSessions).toHaveLength(0);
    expect(fx.pool.size("test-agent").warm).toBe(0);
  });
});

describe("WarmWorkerPool — dispatch() happy path", () => {
  it("pops a warm worker, writes the bare message (menu already dismissed at warm), awaits reply, tears down", async () => {
    const fx = makeFixture("test-agent", [{ name: "test-agent", warmSize: 1 }]);
    await fx.pool.start();
    const [workerName] = fx.startedSessions;
    expect(workerName).toMatch(/^test-agent-pool-id1$/);

    const dispatchPromise = fx.pool.dispatch("test-agent", "hello agent", {
      correlationId: "discord-msg-1",
    });
    // Phase 141 WS-1 — dispatch delivers via a CHANNEL PUSH over the worker's
    // connected channel (not a PTY write). No PTY writes here (autoConnect=true →
    // the warm nudge loop returned on the first isConnected() check).
    await new Promise((r) => setImmediate(r));
    expect(fx.bridges.get(workerName)!.push).toHaveBeenCalledWith(
      expect.objectContaining({ content: "hello agent", message_id: "discord-msg-1" }),
    );
    expect(fx.writesFor(workerName)).toEqual([]);

    // Settle the bridge reply with a known result.
    fx.bridges.get(workerName)!.resolveReply("agent reply text");
    const result = await dispatchPromise;
    expect(result.result).toBe("agent reply text");
    expect(result.wasWarm).toBe(true);

    // Teardown happened (stopAgent + unwireChannelForSubagent on the
    // CONSUMED worker name, not a refill name).
    expect(fx.stoppedSessions).toContain(workerName);
    expect(fx.unwireCalls).toContain(workerName);
    expect(fx.liveSupervisorByAgent.has(workerName)).toBe(false);
  });

  it("when the pool is empty, dispatch cold-spawns inline and reports wasWarm=false", async () => {
    const fx = makeFixture("test-agent", [{ name: "test-agent", warmSize: 0 }]);
    await fx.pool.start(); // no-op: warmSize=0
    expect(fx.pool.size("test-agent").warm).toBe(0);

    const dispatchPromise = fx.pool.dispatch("test-agent", "msg", {
      correlationId: "discord-msg-2",
    });
    // Spawn ran inline → 1 startedSession.
    await new Promise((r) => setImmediate(r));
    expect(fx.startedSessions).toHaveLength(1);
    const [workerName] = fx.startedSessions;
    fx.bridges.get(workerName)!.resolveReply("cold reply");
    const result = await dispatchPromise;
    expect(result.wasWarm).toBe(false);
    expect(result.result).toBe("cold reply");
  });
});

describe("WarmWorkerPool — menu-dismiss nudge (Phase 141 WS-1 fix)", () => {
  it("drives the menu-dismiss \\r while the channel is still connecting, then warms the worker", async () => {
    // autoConnect:false → the worker stays 'on the menu' until we flip it, so
    // spawnWorker must nudge \r to get it to connect (the 2.1.158 deadlock fix).
    const fx = makeFixture(
      "test-agent",
      [{ name: "test-agent", warmSize: 1 }],
      { autoConnect: false, reuseWorkers: true },
    );
    const startP = fx.pool.start();
    // Worker spawns (startAgent registers its supervisor), then the connect-wait
    // loop fires the menu-dismiss \r.
    for (let i = 0; i < 200 && fx.startedSessions.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const [w] = fx.startedSessions;
    for (let i = 0; i < 50 && fx.writesFor(w).length < 1; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(fx.writesFor(w)).toContain("\r"); // menu-dismiss nudge fired
    // Channel connects → spawnWorker completes → worker is warm + menu-dismissed.
    fx.listeners.get(w)!.markConnected();
    await startP;
    expect(fx.pool.size("test-agent").warm).toBe(1);

    // The warm nudge wrote ONLY menu-dismiss `\r` to the PTY (no message); the
    // dispatch delivers the message via a channel push, not the PTY.
    expect(fx.writesFor(w).every((x) => x === "\r")).toBe(true);
    const d = fx.pool.dispatch("test-agent", "hi", { correlationId: "c1" });
    await new Promise((r) => setImmediate(r));
    fx.bridges.get(w)!.resolveReply("ok");
    await d;
    expect(fx.bridges.get(w)!.push).toHaveBeenCalledWith(
      expect.objectContaining({ content: "hi", message_id: "c1" }),
    );
  });
});

describe("WarmWorkerPool — refill behavior", () => {
  it("consuming a warm worker triggers an async refill that lands on the queue", async () => {
    const fx = makeFixture("test-agent", [{ name: "test-agent", warmSize: 1 }]);
    await fx.pool.start();
    expect(fx.pool.size("test-agent").warm).toBe(1);
    const [warmWorker] = fx.startedSessions;

    const dispatchPromise = fx.pool.dispatch("test-agent", "hi", {
      correlationId: "discord-msg-3",
    });
    fx.bridges.get(warmWorker)!.resolveReply("ok");
    await dispatchPromise;

    // The refill is async; flush microtasks until it lands or timeout.
    for (let i = 0; i < 50 && fx.pool.size("test-agent").warm < 1; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(fx.pool.size("test-agent").warm).toBe(1);
    // Two distinct workers spawned: the original + the refill.
    expect(fx.startedSessions.length).toBeGreaterThanOrEqual(2);
    expect(new Set(fx.startedSessions).size).toBe(fx.startedSessions.length);
  });
});

describe("WarmWorkerPool — worker reuse (Phase 141 WS-1 / 1B)", () => {
  it("returns the worker to the warm set and reuses it — no cold-start, no refill, and no leading \\r on the 2nd turn", async () => {
    const fx = makeFixture(
      "test-agent",
      [{ name: "test-agent", warmSize: 1 }],
      { autoConnect: true, reuseWorkers: true },
    );
    await fx.pool.start();
    expect(fx.startedSessions).toHaveLength(1);
    const [w] = fx.startedSessions;

    // Turn 1 — dismisses the menu with \r, then awaits + returns the worker.
    const d1 = fx.pool.dispatch("test-agent", "hello", { correlationId: "c1" });
    await new Promise((r) => setImmediate(r));
    fx.bridges.get(w)!.resolveReply("r1");
    await d1;

    // Worker RETURNED to warm (not torn down), and maybeRefill did NOT
    // double-provision (the in-flight worker counts toward warmSize under reuse).
    expect(fx.pool.size("test-agent").warm).toBe(1);
    expect(fx.stoppedSessions).not.toContain(w);
    expect(fx.startedSessions).toHaveLength(1);

    // Turn 2 reuses the SAME worker (the stub's reply promise is already
    // settled from turn 1, so awaitReply resolves immediately).
    const d2 = fx.pool.dispatch("test-agent", "second", { correlationId: "c2" });
    await d2;
    expect(fx.startedSessions).toHaveLength(1); // still the one worker
    // Both turns were delivered as channel pushes to the SAME worker's bridge.
    const pushed = (fx.bridges.get(w)!.push.mock.calls as unknown[][]).map(
      (c) => (c[0] as { content: string }).content,
    );
    expect(pushed).toEqual(["hello", "second"]);
    // And it is back in the warm set, ready for a 3rd turn.
    expect(fx.pool.size("test-agent").warm).toBe(1);
  });

  it("caps reuse at warmSize — the survivor is kept warm, the excess (burst) worker is torn down", async () => {
    const fx = makeFixture(
      "test-agent",
      [{ name: "test-agent", warmSize: 1 }],
      { autoConnect: true, reuseWorkers: true },
    );
    await fx.pool.start();
    const [w1] = fx.startedSessions; // pre-warmed

    // Two overlapping dispatches: d1 pops w1; d2 finds the pool empty and
    // cold-spawns w2. Wait until BOTH are fully in-flight (inFlight===2) before
    // resolving — the cold spawn settles a few microtasks after dispatch().
    const d1 = fx.pool.dispatch("test-agent", "m1", { correlationId: "c1" });
    const d2 = fx.pool.dispatch("test-agent", "m2", { correlationId: "c2" });
    for (let i = 0; i < 100 && fx.pool.size("test-agent").inFlight < 2; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(fx.pool.size("test-agent").inFlight).toBe(2);
    expect(fx.startedSessions).toHaveLength(2);
    const w2 = fx.startedSessions[1]!;
    expect(w2).not.toBe(w1);

    // d1 finishes first → w1 returns to warm (warm=1, at cap).
    fx.bridges.get(w1)!.resolveReply("r1");
    await d1;
    expect(fx.pool.size("test-agent").warm).toBe(1);
    expect(fx.stoppedSessions).not.toContain(w1);

    // d2 finishes → warm is already at the cap → w2 is torn down, not pooled.
    fx.bridges.get(w2)!.resolveReply("r2");
    await d2;
    expect(fx.stoppedSessions).toContain(w2);
    expect(fx.stoppedSessions).not.toContain(w1);
    expect(fx.pool.size("test-agent").warm).toBe(1); // still just w1
  });

  it("with reuse OFF (default) it still tears the worker down after each reply (999.86 parity)", async () => {
    const fx = makeFixture("test-agent", [{ name: "test-agent", warmSize: 1 }]);
    await fx.pool.start();
    const [w] = fx.startedSessions;
    const d = fx.pool.dispatch("test-agent", "hi", { correlationId: "c1" });
    await new Promise((r) => setImmediate(r));
    fx.bridges.get(w)!.resolveReply("ok");
    await d;
    expect(fx.stoppedSessions).toContain(w);
  });
});

describe("WarmWorkerPool — error & teardown invariants", () => {
  it("when the bridge rejects, dispatch surfaces the error AND still tears the worker down", async () => {
    const fx = makeFixture("test-agent", [{ name: "test-agent", warmSize: 1 }]);
    await fx.pool.start();
    const [worker] = fx.startedSessions;

    const dispatchPromise = fx.pool.dispatch("test-agent", "msg", {
      correlationId: "discord-msg-4",
      timeoutMs: 10,
    });
    fx.bridges
      .get(worker)!
      .rejectReply(new ChannelReplyTimeoutError("discord-msg-4", 10));

    await expect(dispatchPromise).rejects.toThrow(/discord-msg-4/);
    // Teardown still ran (no leak).
    expect(fx.stoppedSessions).toContain(worker);
    expect(fx.unwireCalls).toContain(worker);
  });

  it("dispatch on an unconfigured parent throws synchronously", async () => {
    const fx = makeFixture("test-agent", [{ name: "test-agent", warmSize: 0 }]);
    await fx.pool.start();
    await expect(
      fx.pool.dispatch("unconfigured-agent", "msg", {
        correlationId: "discord-msg-5",
      }),
    ).rejects.toThrow(/is not configured for pooling/);
  });

  it("stop() drains warm workers and rejects subsequent dispatch", async () => {
    const fx = makeFixture("test-agent", [{ name: "test-agent", warmSize: 2 }]);
    await fx.pool.start();
    expect(fx.pool.size("test-agent").warm).toBe(2);

    await fx.pool.stop();
    expect(fx.pool.size("test-agent").warm).toBe(0);
    // Both pre-warmed workers were torn down.
    expect(fx.stoppedSessions).toHaveLength(2);

    await expect(
      fx.pool.dispatch("test-agent", "msg", {
        correlationId: "discord-msg-6",
      }),
    ).rejects.toThrow(/dispatch after stop\(\)/);
  });
});

describe("WarmWorkerPool — registers deferFirstTurn so the worker parks on the menu", () => {
  it("registerLlmRuntime is called with { deferFirstTurn: true } for every worker spawn", async () => {
    const fx = makeFixture("test-agent", [{ name: "test-agent", warmSize: 2 }]);
    await fx.pool.start();
    const mock = (fx.pool as unknown as { deps: WarmWorkerPoolDeps }).deps
      .registerLlmRuntime as unknown as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(2);
    for (const call of mock.mock.calls) {
      // call shape: (sessionName, workerConfig, parent, opts)
      expect(call[3]).toEqual({ deferFirstTurn: true });
    }
  });
});

describe("WarmWorkerPool — onProgress wiring", () => {
  it("forwards onProgress callback through to the worker's bridge during dispatch", async () => {
    const fx = makeFixture("test-agent", [{ name: "test-agent", warmSize: 1 }]);
    await fx.pool.start();
    const [worker] = fx.startedSessions;
    const accumulated: string[] = [];

    const dispatchPromise = fx.pool.dispatch("test-agent", "msg", {
      correlationId: "discord-msg-7",
      onProgress: (text) => accumulated.push(text),
    });
    // Allow the synchronous bridge registerProgressCallback path to run.
    await new Promise((r) => setImmediate(r));
    fx.bridges.get(worker)!.emitProgress("partial 1");
    fx.bridges.get(worker)!.emitProgress("partial 1 + 2");
    fx.bridges.get(worker)!.resolveReply("final");
    await dispatchPromise;

    expect(accumulated).toEqual(["partial 1", "partial 1 + 2"]);
    // clearProgressCallback ran in finally — no late progress leaks past dispatch.
    expect(fx.bridges.get(worker)!.clearProgressCallback).toHaveBeenCalled();
  });
});

describe("buildWorkerConfig — derives the worker's ResolvedAgentConfig", () => {
  it("strips channels/schedules/slashCommands and disallows nested spawn", () => {
    const parent = makeParentConfig("test-agent");
    const worker = buildWorkerConfig(parent, "test-agent-pool-abc123");
    expect(worker.name).toBe("test-agent-pool-abc123");
    expect(worker.channels).toEqual([]);
    expect(worker.schedules).toEqual([]);
    expect(worker.slashCommands).toEqual([]);
    expect(worker.disallowedTools).toContain(
      "mcp__clawcode__spawn_subagent_thread",
    );
  });

  it("MERGES the parent's disallowedTools with the nested-spawn block (keeps the Layer-1 blocklist)", () => {
    const parent = makeParentConfig("test-agent", {
      disallowedTools: ["WebFetch", "Bash"],
    } as Partial<ResolvedAgentConfig>);
    const worker = buildWorkerConfig(parent, "test-agent-pool-lock");
    // parent's blocklist survives...
    expect(worker.disallowedTools).toContain("WebFetch");
    expect(worker.disallowedTools).toContain("Bash");
    // ...AND the worker still can't nest subagents...
    expect(worker.disallowedTools).toContain("mcp__clawcode__spawn_subagent_thread");
    // ...with no duplicates.
    const dt = worker.disallowedTools ?? [];
    expect(dt.length).toBe(new Set(dt).size);
  });

  it("forces llmRuntime.backend to claude-code-interactive", () => {
    const parent = makeParentConfig("test-agent", {
      llmRuntime: { backend: "anthropic-agent-sdk" } as ResolvedAgentConfig["llmRuntime"],
    });
    const worker = buildWorkerConfig(parent, "test-agent-pool-abc");
    expect(worker.llmRuntime?.backend).toBe("claude-code-interactive");
  });

  it("inherits parent soul/identity/model verbatim", () => {
    const parent = makeParentConfig("test-agent", {
      soul: "custom soul",
      identity: "custom identity",
      model: "opus",
    });
    const worker = buildWorkerConfig(parent, "test-agent-pool-xyz");
    expect(worker.soul).toBe("custom soul");
    expect(worker.identity).toBe("custom identity");
    expect(worker.model).toBe("opus");
  });
});
