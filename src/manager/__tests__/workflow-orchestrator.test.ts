/**
 * Phase 145 WS2 (Plan 05) — workflow-orchestrator fan-out unit pins.
 *
 * Scope: the FAN-OUT half of the daemon-side background workflow orchestrator.
 * What is exercised here (all dependency-injected / synthetic — no real
 * sessions, no real registry, no Discord):
 *   - `launchWorkflow` allocates a `wf_…` id SYNCHRONOUSLY and does NOT await
 *     worker completion (the SC-2 turn-decoupling mechanism: the triggering
 *     turn settles in seconds).
 *   - N parallel steps → N `startAgent` calls, each worker config carrying the
 *     LIFTED `maxTurnDurationMs` ceiling (large finite, > the 20-min default)
 *     so a worker is not killed at 20 min.
 *   - Each worker session name is pre-registered (`registerLlmRuntime`) BEFORE
 *     `startAgent` (mirrors the spawner ordering → no runtime-resolver throw).
 *   - A worker binding is created at spawn (the reaper-survival substrate) and
 *     `refreshWorkerActivity` bumps its `lastActivity` (the Plan-03 contract).
 *   - Per-workflow state is addressable by workflow id.
 *
 * The barrier / result collection / progress posting are NOT exercised — they
 * are Plan 06 (the fan-in half). This plan stops at spawning + tracking.
 *
 * The fakes match the shapes the daemon injects in production (mirrors
 * `warm-worker-pool.test.ts`): `startAgent` / `registerLlmRuntime` / a binding
 * accessor backed by an in-memory map / `getParentConfig`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Logger } from "pino";

import {
  WorkflowOrchestrator,
  buildWorkflowWorkerConfig,
  sanitizeStepFileName,
  WORKFLOW_WORKER_MAX_TURN_DURATION_MS,
  WORKFLOW_PROGRESS_INTERVAL_MS,
  WORKFLOW_STALL_MS,
  WORKFLOW_WALL_CLOCK_MS,
  WORKFLOW_TERMINAL_RETENTION_MS,
  REPORT_STEP_MAX_MS,
  MAX_WORKFLOW_PARALLEL_STEPS,
  // 999.106 W-2 — waved execution.
  MAX_WORKFLOW_TOTAL_STEPS,
  MAX_WORKFLOW_WAVES,
  RESULT_HEAP_CAP,
  PROMPT_TRUNCATION_MARKER,
  normalizeWorkflowSpec,
  type OrchestratorDeps,
  type WorkflowSpec,
} from "../workflow-orchestrator.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import { isSubagentThreadName } from "../subagent-name.js";
// Finding 2 (260714-mkq review) — the chunk-expansion regression asserts every
// posted chunk survives the daemon's per-chunk re-format under the 2000 limit.
import { formatOutboundText } from "../../discord/markdown-table-wrap.js";

/** The 20-min default ceiling the whole current fleet resolves to. */
const DEFAULT_CEILING_MS = 20 * 60_000;

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
    disallowedTools: ["mcp__clawcode__ScheduleWakeup", "AskUserQuestion"],
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
      enabled: true,
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

/** Minimal in-memory binding store mirroring the thread-registry's lastActivity
 *  field, keyed by the synthetic threadId (= worker sessionName). */
interface FakeBinding {
  threadId: string;
  sessionName: string;
  agentName: string;
  lastActivity: number;
}

interface Fixture {
  orch: WorkflowOrchestrator;
  startedSessions: string[];
  startedConfigs: Map<string, ResolvedAgentConfig>;
  registeredBefore: string[];
  bindings: Map<string, FakeBinding>;
  removedBindings: string[];
  /** Session names a binding was added for (survives later removal). */
  addedBindings: string[];
  /** Plan 06 — every dispatchTurn call (worker turn-drive + collection). */
  dispatchedTurns: { session: string; message: string }[];
  /** Plan 06 — the AbortSignal passed to each dispatchTurn (wall-clock backstop). */
  dispatchSignals: (AbortSignal | undefined)[];
  /** Phase 999.165 — the live-status tool callback each dispatch received. */
  dispatchToolUses: (((name: string, input?: unknown) => void) | undefined)[];
  /** Plan 06 — pending dispatch resolvers (mid-flight tests resolve these). */
  dispatchResolvers: Map<string, (v: string) => void>;
  /** Plan 06 — every postToBoundChannel call (progress + final). */
  posts: { agent: string; text: string }[];
  /** INC-2026-08-10 — every postFilesToBoundChannel call (summary + PDFs). */
  filePosts: { agent: string; text: string; names: string[] }[];
  /** 999.149 — every parent ANSWER turn dispatched at fan-in. */
  parentAnswers: { agent: string; prompt: string; workflowId: string }[];
  /** Session names stopAgent was called for (synchronous-teardown contract). */
  stoppedSessions: string[];
  /** Every `logger.error` payload — chunk-failure log-not-swallow assertion. */
  loggedErrors: unknown[];
  /** Every `logger.warn` payload — retry-visibility assertion (INC-2026-07-26). */
  loggedWarns: unknown[];
  /** 2026-07-27 disk persistence — every persistWorkflowArtifact call. */
  persistedArtifacts: {
    agent: string;
    workflowId: string;
    relativePath: string;
    content: string;
  }[];
  /** 999.106 W-2 — start/stop interleaving log (`start:<s>` / `stop:<s>`)
   *  so wave-ordering tests can assert wave K+1's first spawn post-dates
   *  wave K's last teardown. */
  events: string[];
  /** 999.106 W-2 — releases every stopAgent held by opts.holdTeardown. */
  releaseTeardown: () => void;
  clock: { now: number };
}

function makeFixture(
  parent: string,
  opts: {
    /** startAgent rejects for these session-name substrings (failure path). */
    failSessionsMatching?: string;
    /** dispatchTurn never resolves (mid-flight: workers stay "running"). */
    dispatchPending?: boolean;
    /** Phase 999.165 — mid-turn steer injection (absent = always restart). */
    injectMidTurn?: (sessionName: string, text: string) => { injected: boolean; reason?: string };
    /** dispatchTurn rejects for the worker whose turn message equals this. */
    dispatchFailMessage?: string;
    /** INC-2026-07-26 — the error message for `dispatchFailMessage` rejections
     *  (retry classification keys off the message prefix). */
    dispatchFailError?: string;
    /** Admission concurrency cap (default high so existing tests are unbounded). */
    maxConcurrentWorkers?: number;
    /** cgroup memory percent the gate reads (default null → fail-open). */
    memoryPercent?: number | null;
    /** G-2 review — MUTABLE memory percent (takes precedence over
     *  memoryPercent): tests flip the gate between admit and memory-block
     *  mid-run. */
    memoryPercentRef?: { value: number | null };
    /** Admission timeout ms (default short so timeout tests don't hang). */
    admissionTimeoutMs?: number;
    /** dispatchTurn returns THIS text instead of `result:${session}` (chunk tests). */
    dispatchResultText?: string;
    /** postToBoundChannel REJECTS on its Nth call (1-based) — per-chunk failure test. */
    failPostCall?: number;
    /** INC-2026-08-10 — "inline" restores the pre-incident concatenate-every-
     *  worker-result finalize (the chunking path). Default is "summary". */
    outputMode?: "summary" | "inline";
    /** INC-2026-08-10 — enable PDF rendering with a fake browser driver. */
    withReports?: boolean;
    verifyFigures?: boolean;
    /** Phase 999.129 — what readPreviousRun returns (undefined = dep absent). */
    previousRun?: import("../workflow-summary/previous-run.js").PreviousRun | null;
    /** 999.149 — the parent ANSWER turn rejects (report must still post). */
    failParentAnswer?: boolean;
    /** 999.150 — the answer turn runs but its reply never lands (empty / send failed). */
    parentAnswerNotDelivered?: boolean;
    /** 999.150 — wire the parent ANSWER dep (production shape). */
    withParentAnswer?: boolean;
    /** Provide the file-capable post leg. */
    withFileSender?: boolean;
    /** The fake driver's page.pdf() rejects. */
    failRender?: boolean;
    /** postFilesToBoundChannel rejects (the ATTACH_FILES failure mode). */
    failFilePost?: boolean;
    /** INC-2026-07-26 retry tests — dispatchTurn rejects the FIRST call whose
     *  turn message equals this, with `dispatchFailOnceError`; later calls for
     *  the same message succeed. */
    dispatchFailOnceMessage?: string;
    /** The error message for the fail-once rejection (retry classification
     *  keys off the message prefix). */
    dispatchFailOnceError?: string;
    /** INC-2026-07-26 — resolve each dispatchTurn after this many real ms
     *  (bounded-runner starvation pin: slow turns, short admission timeout). */
    dispatchDelayMs?: number;
    /** 2026-07-27 — persistWorkflowArtifact rejects every call (best-effort pin). */
    failPersist?: boolean;
    /** 999.106 QW-2 — fleet MCP ceiling handed out via getWorkflowLimits. */
    workerMcpAllowlist?: readonly string[];
    /** 999.106 QW-2 — the parent's MCP roster (default: empty). */
    parentMcpServers?: ResolvedAgentConfig["mcpServers"];
    /** 999.106 W-2 — stopAgent blocks until fixture.releaseTeardown() (wave-
     *  boundary tests advance the clock while teardown is in flight). */
    holdTeardown?: boolean;
    /** 999.106 W-2 — provide readWorkflowArtifact backed by the persisted-
     *  artifact log (throws for a path never persisted, like a real fs). */
    withArtifactReader?: boolean;
    /** 999.109 review — capture heartbeat gate registrations. */
    registerHeartbeatConfig?: (config: ResolvedAgentConfig) => void;
  } = {},
): Fixture {
  const parentConfig = makeParentConfig(
    parent,
    opts.parentMcpServers !== undefined
      ? { mcpServers: opts.parentMcpServers }
      : {},
  );
  const startedSessions: string[] = [];
  const startedConfigs = new Map<string, ResolvedAgentConfig>();
  const registeredBefore: string[] = [];
  const bindings = new Map<string, FakeBinding>();
  const removedBindings: string[] = [];
  const addedBindings: string[] = [];
  const dispatchedTurns: { session: string; message: string }[] = [];
  const dispatchSignals: (AbortSignal | undefined)[] = [];
  // Phase 999.165 — the live-status tool callback each dispatch receives.
  const dispatchToolUses: (((name: string, input?: unknown) => void) | undefined)[] = [];
  const dispatchResolvers = new Map<string, (v: string) => void>();
  const posts: { agent: string; text: string }[] = [];
  const filePosts: { agent: string; text: string; names: string[] }[] = [];
  const parentAnswers: { agent: string; prompt: string; workflowId: string }[] = [];
  const stoppedSessions: string[] = [];
  const registered = new Set<string>();
  const loggedErrors: unknown[] = [];
  const loggedWarns: unknown[] = [];
  const persistedArtifacts: {
    agent: string;
    workflowId: string;
    relativePath: string;
    content: string;
  }[] = [];
  const clock = { now: 1_000_000 };
  let idSeq = 0;
  let postCallCount = 0;
  const failedOnceMessages = new Set<string>();
  const events: string[] = [];
  // 999.106 W-2 — teardown gate: while opts.holdTeardown, every stopAgent
  // parks on this promise until the test calls releaseTeardown().
  let teardownHeld = opts.holdTeardown === true;
  let teardownWaiters: (() => void)[] = [];
  const releaseTeardown = (): void => {
    teardownHeld = false;
    const waiters = teardownWaiters;
    teardownWaiters = [];
    for (const w of waiters) w();
  };

  const deps: OrchestratorDeps = {
    startAgent: vi.fn(async (name: string, cfg: ResolvedAgentConfig) => {
      // Pre-registration ordering guard: the runtime resolver MUST exist
      // before startAgent constructs the SdkSessionAdapter.
      if (!registered.has(name)) {
        throw new Error(
          `runtime not registered for ${name} before startAgent (ordering bug)`,
        );
      }
      if (
        opts.failSessionsMatching &&
        name.includes(opts.failSessionsMatching)
      ) {
        throw new Error(`synthetic startAgent failure for ${name}`);
      }
      startedSessions.push(name);
      events.push(`start:${name}`);
      startedConfigs.set(name, cfg);
    }),
    stopAgent: vi.fn(async (name: string) => {
      if (teardownHeld) {
        await new Promise<void>((resolve) => teardownWaiters.push(resolve));
      }
      stoppedSessions.push(name);
      events.push(`stop:${name}`);
    }),
    registerLlmRuntime: vi.fn((name: string) => {
      registered.add(name);
      registeredBefore.push(name);
    }),
    addWorkerBinding: vi.fn(
      async (b: {
        threadId: string;
        sessionName: string;
        agentName: string;
        lastActivity: number;
      }) => {
        bindings.set(b.threadId, { ...b });
        addedBindings.push(b.sessionName);
      },
    ),
    refreshWorkerBinding: vi.fn(async (threadId: string, ts: number) => {
      const b = bindings.get(threadId);
      if (b) b.lastActivity = ts;
    }),
    removeWorkerBinding: vi.fn(async (threadId: string) => {
      bindings.delete(threadId);
      removedBindings.push(threadId);
    }),
    getParentConfig: (n: string) => (n === parent ? parentConfig : undefined),
    dispatchTurn: vi.fn(
      async (
        session: string,
        rawMessage: string,
        signal?: AbortSignal,
        onToolUse?: (name: string, input?: unknown) => void,
      ) => {
        // INC-2026-08-14 — production appends STEP_DELIVERY_CONTRACT to every
        // step prompt. Strip it for the fixture's message-keyed matching so
        // the existing per-message fail/pending/resolver machinery keeps
        // working; the contract's presence is asserted by its own test.
        const message = rawMessage.replace(/\n\nDELIVERY CONTRACT:[^]*$/, "");
        dispatchedTurns.push({ session, message });
        dispatchSignals.push(signal);
        dispatchToolUses.push(onToolUse);
        // A corrective re-dispatch (quality gate) is a plain immediate turn -
        // it must not consume the pending/resolver machinery, which several
        // tests drive for FIRST dispatches and resolve with short strings.
        if (rawMessage.startsWith("Your previous message was a summary")) {
          return `corrective:${session} - full findings. ${"Verified detail. ".repeat(20)}`;
        }
        if (opts.dispatchFailMessage && message === opts.dispatchFailMessage) {
          throw new Error(
            opts.dispatchFailError ?? `synthetic dispatch failure for ${session}`,
          );
        }
        // INC-2026-07-26 retry tests — fail exactly the first call per message.
        if (
          opts.dispatchFailOnceMessage &&
          message === opts.dispatchFailOnceMessage &&
          !failedOnceMessages.has(message)
        ) {
          failedOnceMessages.add(message);
          throw new Error(
            opts.dispatchFailOnceError ?? `synthetic one-shot failure for ${session}`,
          );
        }
        if (opts.dispatchPending) {
          return new Promise<string>((resolve, reject) => {
            dispatchResolvers.set(session, resolve);
            // INC-2026-07-26 — mirror production: an aborted wall-clock/sweep
            // signal rejects the in-flight turn so the runner proceeds.
            signal?.addEventListener("abort", () =>
              reject(new Error("dispatch aborted by wall-clock/sweep signal")),
            );
          });
        }
        if (opts.dispatchDelayMs !== undefined) {
          await new Promise((r) => setTimeout(r, opts.dispatchDelayMs));
        }
        // INC-2026-08-14 — long enough to clear the meta-summary quality gate
        // (THIN_RESULT_CHARS), so unrelated tests don't trigger the corrective
        // retry. Retry-specific tests pass a deliberately thin/meta result.
        return (
          opts.dispatchResultText ??
          `result:${session} - substantive findings body. ${"Detail sentence with facts and figures. ".repeat(8)}`
        );
      },
    ),
    ...(opts.withReports
      ? {
          reportDeps: {
            // 999.150 — PDFs are opt-in now; `withReports` means "this test is
            // about the attachment machinery", so it opts in.
            renderPdf: true,
            render: {
              driver: {
                async launch() {
                  return {
                    async newPage() {
                      return {
                        async route() {},
                        async setContent() {},
                        async pdf() {
                          if (opts.failRender) throw new Error("synthetic render failure");
                          return Buffer.alloc(64, 0x41);
                        },
                      };
                    },
                    async close() {},
                  };
                },
              },
            },
          },
        }
      : {}),
    // Phase 999.123 — opt the parent into the reserved verify-figures step.
    ...(opts.verifyFigures ? { verifyFiguresFor: () => true } : {}),
    // Phase 999.129 — previous-run lookup for recurring template runs.
    ...(opts.previousRun !== undefined
      ? { readPreviousRun: vi.fn(async () => opts.previousRun ?? null) }
      : {}),
    ...(opts.withFileSender
      ? {
          postFilesToBoundChannel: vi.fn(
            async (
              agent: string,
              text: string,
              files: readonly { name: string; data: Buffer }[],
            ) => {
              if (opts.failFilePost) throw new Error("Missing Permissions: ATTACH_FILES");
              filePosts.push({ agent, text, names: files.map((f) => f.name) });
            },
          ),
        }
      : {}),
    // 999.150 — OPT-IN in tests. Absent, finalize takes the fallback path, and
    // the fallback is precisely what the pre-999.150 suite below pins: chunking,
    // artifact advertisement, attachment delivery, heap release. Those
    // behaviours did not go away; they became the floor. Tests that care about
    // the ANSWER path pass `withParentAnswer: true`.
    ...(opts.withParentAnswer || opts.failParentAnswer || opts.parentAnswerNotDelivered
      ? {
          dispatchParentAnswer: vi.fn(async (agent: string, prompt: string, workflowId: string) => {
            parentAnswers.push({ agent, prompt, workflowId });
            if (opts.failParentAnswer) throw new Error("QUEUE_FULL");
            return opts.parentAnswerNotDelivered !== true;
          }),
        }
      : {}),
    postToBoundChannel: vi.fn(async (agent: string, text: string) => {
      postCallCount += 1;
      if (opts.failPostCall !== undefined && postCallCount === opts.failPostCall) {
        throw new Error(`synthetic post failure on call ${postCallCount}`);
      }
      posts.push({ agent, text });
    }),
    ...(opts.injectMidTurn ? { injectMidTurn: opts.injectMidTurn } : {}),
    ...(opts.registerHeartbeatConfig
      ? { registerHeartbeatConfig: opts.registerHeartbeatConfig }
      : {}),
    persistWorkflowArtifact: vi.fn(
      async (
        agent: string,
        workflowId: string,
        relativePath: string,
        content: string,
      ) => {
        if (opts.failPersist) {
          throw new Error("synthetic persist failure (disk full)");
        }
        persistedArtifacts.push({ agent, workflowId, relativePath, content });
      },
    ),
    // 999.106 W-2 — disk read-back for the wave-boundary heap cap, backed by
    // the persisted-artifact log (throws for a never-persisted path, like a
    // real fs). Opt-in so pre-W-2 tests exercise the no-reader fallback.
    ...(opts.withArtifactReader
      ? {
          readWorkflowArtifact: vi.fn(
            async (agent: string, workflowId: string, relativePath: string) => {
              const hit = [...persistedArtifacts]
                .reverse()
                .find(
                  (a) =>
                    a.agent === agent &&
                    a.workflowId === workflowId &&
                    a.relativePath === relativePath,
                );
              if (!hit) throw new Error(`ENOENT: ${relativePath}`);
              return hit.content;
            },
          ),
        }
      : {}),
    // 6-char ids — production uses nanoid(6) so the worker session name
    // `${parent}-sub-${id}` matches `isSubagentThreadName`'s trailing-6 regex
    // (the reaper-management contract). A short `id${n}` would silently break
    // the reaper-name-filter assertion below.
    generateId: () => `id${String(++idSeq).padStart(4, "0")}`,
    now: () => clock.now,
    getWorkflowLimits: () => ({
      maxConcurrentWorkers: opts.maxConcurrentWorkers ?? 100,
      memoryHighWatermarkPercent: 85,
      admissionTimeoutMs: opts.admissionTimeoutMs ?? 900_000,
      outputMode: opts.outputMode ?? "summary",
      // 999.106 QW-2 — fleet ceiling; undefined = full inherit.
      ...(opts.workerMcpAllowlist !== undefined
        ? { workerMcpAllowlist: opts.workerMcpAllowlist }
        : {}),
    }),
    readMemoryPercent: async () =>
      opts.memoryPercentRef !== undefined
        ? opts.memoryPercentRef.value
        : opts.memoryPercent === undefined
          ? null
          : opts.memoryPercent,
    // Fast, real-timer yield so the gate's poll loop spins quickly under test
    // without long waits (production uses the default ~500ms timer).
    sleep: (_ms: number) => new Promise((r) => setTimeout(r, 1)),
    // Per-fixture logger: silent for every level EXCEPT error + warn, which we
    // collect so the chunk-failure / step-retry tests can assert the
    // log-not-swallow contracts.
    logger: {
      ...silentLogger,
      error: (obj: unknown) => {
        loggedErrors.push(obj);
      },
      warn: (obj: unknown) => {
        loggedWarns.push(obj);
      },
      child: () => silentLogger,
    } as unknown as Logger,
  };

  return {
    orch: new WorkflowOrchestrator(deps),
    startedSessions,
    startedConfigs,
    registeredBefore,
    bindings,
    removedBindings,
    addedBindings,
    dispatchedTurns,
    dispatchSignals,
    dispatchToolUses,
    dispatchResolvers,
    posts,
    filePosts,
    parentAnswers,
    stoppedSessions,
    loggedErrors,
    loggedWarns,
    persistedArtifacts,
    events,
    releaseTeardown,
    clock,
  };
}

/** Poll a condition across microtasks (the background fan-out + drive run on
 *  their own job; tests that inspect mid-flight state wait for it to settle). */
async function waitFor(cond: () => boolean, max = 300): Promise<void> {
  for (let i = 0; i < max && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

const spec = (n: number): WorkflowSpec => ({
  steps: Array.from({ length: n }, (_, i) => ({
    stepId: `s${i}`,
    prompt: `do step ${i}`,
  })),
});

describe("buildWorkflowWorkerConfig", () => {
  it("sets a LIFTED finite maxTurnDurationMs strictly greater than the 20-min default", () => {
    const parent = makeParentConfig("p");
    const cfg = buildWorkflowWorkerConfig(parent, "p-sub-abc123");
    // The SC-2 heart: the whole fleet resolves to exactly 1_200_000. A worker
    // MUST get a strictly-larger, finite ceiling or a >20-min workflow trips it.
    expect(cfg.maxTurnDurationMs).toBeGreaterThan(DEFAULT_CEILING_MS);
    expect(cfg.maxTurnDurationMs).toBe(WORKFLOW_WORKER_MAX_TURN_DURATION_MS);
    expect(Number.isFinite(cfg.maxTurnDurationMs)).toBe(true);
    // Never disable the ceiling (the tracker throws on 0 / Infinity).
    expect(cfg.maxTurnDurationMs).not.toBe(Infinity);
    // And inside the Plan-01 envelope (max 8h finite).
    expect(cfg.maxTurnDurationMs).toBeLessThanOrEqual(28_800_000);
  });

  it("unions the parent disallowedTools with BOTH recursion guards (spawn + workflow)", () => {
    const parent = makeParentConfig("p", {
      disallowedTools: ["AskUserQuestion", "mcp__clawcode__ScheduleWakeup"],
    });
    const cfg = buildWorkflowWorkerConfig(parent, "p-sub-abc123");
    // Inherited fleet block preserved.
    expect(cfg.disallowedTools).toContain("AskUserQuestion");
    expect(cfg.disallowedTools).toContain("mcp__clawcode__ScheduleWakeup");
    // A worker must not spawn further subagents OR launch nested workflows.
    expect(cfg.disallowedTools).toContain(
      "mcp__clawcode__spawn_subagent_thread",
    );
    expect(cfg.disallowedTools).toContain("mcp__clawcode__start_workflow");
  });

  it("disables the heartbeat on the worker (the ~5min queue-lock sweep must not see it)", () => {
    const parent = makeParentConfig("p", {
      heartbeat: {
        enabled: true,
        intervalSeconds: 60,
        checkTimeoutSeconds: 30,
        contextFill: { warningThreshold: 70, criticalThreshold: 90 },
      },
    });
    const cfg = buildWorkflowWorkerConfig(parent, "p-sub-abc123");
    expect(cfg.heartbeat.enabled).toBe(false);
  });

  it("uses a role-marker soul (NOT the step prompt) + scopes channels/schedules empty", () => {
    const parent = makeParentConfig("p");
    const cfg = buildWorkflowWorkerConfig(parent, "p-sub-abc123");
    // Plan 06: the step prompt is driven as the worker's TURN INPUT
    // (dispatchTurn), never baked into soul — clean system/user split, prompt
    // never carried in two places.
    expect(cfg.soul).toContain("WORKFLOW WORKER");
    expect(cfg.soul).toContain("You are a test agent."); // parent soul preserved
    expect(cfg.channels).toEqual([]);
    expect(cfg.schedules).toEqual([]);
    expect(cfg.name).toBe("p-sub-abc123");
  });
});

describe("WorkflowOrchestrator.launchWorkflow — fan-out", () => {
  it("returns a wf_… id synchronously without awaiting worker completion", () => {
    const f = makeFixture("p");
    const before = f.startedSessions.length;
    const id = f.orch.launchWorkflow("p", spec(3));
    expect(id).toMatch(/^wf_/);
    // The id is allocated synchronously and the fan-out is deferred to a
    // microtask: NO worker side-effect (not even a startAgent invocation) has
    // run on the calling tick. This is the SC-2 turn-decoupling guarantee —
    // the triggering turn settles in seconds, never awaiting worker completion.
    expect(f.startedSessions.length).toBe(before);
    expect(f.registeredBefore.length).toBe(0);
    expect(f.orch.getWorkflowState(id)!.workers.length).toBe(0);
  });

  it("spawns N workers for N parallel steps, each with the lifted ceiling", async () => {
    const f = makeFixture("p");
    f.orch.launchWorkflow("p", spec(3));
    await f.orch.drainForTest();
    expect(f.startedSessions.length).toBe(3);
    for (const [, cfg] of f.startedConfigs) {
      expect(cfg.maxTurnDurationMs).toBe(WORKFLOW_WORKER_MAX_TURN_DURATION_MS);
      expect(cfg.maxTurnDurationMs).toBeGreaterThan(DEFAULT_CEILING_MS);
    }
  });

  it("pre-registers each worker runtime BEFORE startAgent (no ordering race)", async () => {
    const f = makeFixture("p");
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    // The startAgent fake throws if a name was not registered first; reaching
    // here with 2 started sessions proves the ordering held.
    expect(f.startedSessions.length).toBe(2);
    expect(f.registeredBefore.length).toBe(2);
  });

  it("creates a worker binding at spawn (the reaper-survival substrate)", async () => {
    // Pending dispatch keeps workers "running" so the live binding is observable
    // before Plan 06's own-cleanup removes it on completion.
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", spec(2));
    await waitFor(() => {
      const s = f.orch.getWorkflowState(id);
      return (
        !!s && s.workers.length === 2 && s.workers.every((w) => w.status === "running")
      );
    });
    // One binding per spawned worker, keyed by the worker session name.
    expect(f.bindings.size).toBe(2);
    for (const sessionName of f.startedSessions) {
      const b = f.bindings.get(sessionName);
      expect(b).toBeDefined();
      expect(b!.sessionName).toBe(sessionName);
      expect(b!.lastActivity).toBe(f.clock.now);
    }
    // cleanup — let the workers finish so the background job settles.
    for (const [, resolve] of f.dispatchResolvers) resolve("done");
    await f.orch.drainForTest();
  });

  it("uses spawner-shaped session names so the reaper manages workers", async () => {
    const f = makeFixture("p");
    f.orch.launchWorkflow("p", spec(1));
    await f.orch.drainForTest();
    const sessionName = f.startedSessions[0]!;
    // `${parent}-sub-${id}` so it is excluded from the top-level fleet listing.
    expect(sessionName).toMatch(/^p-sub-/);
    // LOAD-BEARING: the worker name MUST match isSubagentThreadName, or the idle
    // subagent reaper skips it (line 111 `if (!isSubagentThreadName) continue`)
    // — making the entire lastActivity survival machinery inert AND removing the
    // idle-reap backstop. `isSubagentThreadName` requires a TRAILING 6-char
    // nanoid suffix, so production must use nanoid(6) (and this fixture a 6-char
    // id). This assertion fails on a default 21-char nanoid.
    expect(isSubagentThreadName(sessionName)).toBe(true);
  });

  it("caps parallel-step fan-out (DoS guard) — over-cap spec is rejected fast", () => {
    const f = makeFixture("p");
    expect(() =>
      f.orch.launchWorkflow("p", spec(MAX_WORKFLOW_PARALLEL_STEPS + 1)),
    ).toThrow(/parallel/i);
    // No partial fan-out on rejection.
    expect(f.startedSessions.length).toBe(0);
  });

  it("rejects an unknown agent fast (no workers spawned)", () => {
    const f = makeFixture("p");
    expect(() => f.orch.launchWorkflow("nope", spec(2))).toThrow();
  });

  it("a worker-spawn rejection does not crash the fan-out (fire-and-forget safety)", async () => {
    const f = makeFixture("p", { failSessionsMatching: "p-sub-" });
    // Every worker spawn rejects; launchWorkflow must still return an id and the
    // un-awaited fan-out must swallow the rejection (no unhandled rejection).
    const id = f.orch.launchWorkflow("p", spec(2));
    expect(id).toMatch(/^wf_/);
    await expect(f.orch.drainForTest()).resolves.toBeUndefined();
    const state = f.orch.getWorkflowState(id);
    expect(state).toBeDefined();
    // A failed spawn is tracked as failed, not silently dropped.
    expect(state!.workers.every((w) => w.status === "failed")).toBe(true);
  });
});

describe("WorkflowOrchestrator.refreshWorkerActivity — reaper-survival contract", () => {
  it("bumps the worker binding lastActivity on a progress tick", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", spec(1));
    await waitFor(() => {
      const s = f.orch.getWorkflowState(id);
      return !!s && s.workers.length === 1 && s.workers[0].status === "running";
    });
    const sessionName = f.startedSessions[0]!;
    const t0 = f.bindings.get(sessionName)!.lastActivity;

    // Advance the injected clock, then refresh on progress.
    f.clock.now += 30 * 60_000; // 30 min later
    await f.orch.refreshWorkerActivity(id, sessionName);

    const t1 = f.bindings.get(sessionName)!.lastActivity;
    expect(t1).toBeGreaterThan(t0);
    expect(t1).toBe(f.clock.now);

    for (const [, resolve] of f.dispatchResolvers) resolve("done");
    await f.orch.drainForTest();
  });

  it("is a no-op (no throw) for an unknown workflow or worker", async () => {
    const f = makeFixture("p");
    await expect(
      f.orch.refreshWorkerActivity("wf_missing", "nobody-sub-x"),
    ).resolves.toBeUndefined();
  });
});

describe("WorkflowOrchestrator — workflow-state tracking (Plan 06 seam)", () => {
  it("tracks per-workflow state addressable by id (workers + status)", async () => {
    const f = makeFixture("p");
    const id = f.orch.launchWorkflow("p", spec(2));
    const state = f.orch.getWorkflowState(id);
    expect(state).toBeDefined();
    expect(state!.workflowId).toBe(id);
    expect(state!.parentAgentName).toBe("p");
    await f.orch.drainForTest();
    const after = f.orch.getWorkflowState(id)!;
    expect(after.workers.length).toBe(2);
    // Every worker maps a stepId to a session name (the barrier addresses these).
    for (const w of after.workers) {
      expect(typeof w.stepId).toBe("string");
      expect(w.sessionName).toMatch(/^p-sub-/);
    }
  });
});

describe("WorkflowOrchestrator — fan-in barrier + result collection (Plan 06)", () => {
  it("drives each worker via dispatchTurn with its step prompt and collects the result", async () => {
    const f = makeFixture("p");
    const id = f.orch.launchWorkflow("p", spec(3));
    await f.orch.drainForTest();

    // Each worker's turn is driven with its step prompt (the turn INPUT — the
    // backend-agnostic path; firstTurnInput is v3-only, the relay/completedAt
    // seam deadlocks a channel-less worker).
    expect(f.dispatchedTurns).toHaveLength(3);
    expect(f.dispatchedTurns.map((d) => d.message).sort()).toEqual([
      "do step 0",
      "do step 1",
      "do step 2",
    ]);
    const state = f.orch.getWorkflowState(id)!;
    expect(state.workers.every((w) => w.status === "done")).toBe(true);
    // Result collected DIRECTLY from dispatchTurn's return (not channel
    // scrape): each settled step's PERSISTED artifact carries the dispatch
    // return verbatim. (Post-finalize the in-heap `result` is released —
    // 999.106 QW-1 — so the disk artifact is the observable.)
    for (const w of state.workers) {
      const artifact = f.persistedArtifacts.find(
        (a) => a.relativePath !== "summary.json" && a.content.includes(`result:${w.sessionName}`),
      );
      expect(artifact).toBeDefined();
    }
  });

  it("releases the barrier when all workers complete (workflow → done)", async () => {
    const f = makeFixture("p");
    const id = f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    expect(f.orch.getWorkflowState(id)!.status).toBe("done");
  });

  it("a worker whose turn rejects is marked failed and the barrier STILL proceeds", async () => {
    const f = makeFixture("p", { dispatchFailMessage: "do step 1" });
    const id = f.orch.launchWorkflow("p", spec(3));
    await f.orch.drainForTest();

    const state = f.orch.getWorkflowState(id)!;
    const failed = state.workers.filter((w) => w.status === "failed");
    const done = state.workers.filter((w) => w.status === "done");
    expect(failed).toHaveLength(1);
    expect(failed[0].stepId).toBe("s1");
    expect(failed[0].error).toMatch(/synthetic dispatch failure/);
    expect(done).toHaveLength(2);
    // Barrier proceeded: the workflow finalized (NOT hung) — T-145-17.
    expect(state.status).toBe("done");
    const finalPost = f.posts.find((p) => p.text.includes("complete"))!;
    expect(finalPost.text).toContain("2/3");
    expect(finalPost.text).toContain("failed");
  });

  it("marks the workflow failed only when EVERY worker fails (still finalizes)", async () => {
    // All spawns fail → no running workers → barrier finalizes as failed.
    const f = makeFixture("p", { failSessionsMatching: "p-sub-" });
    const id = f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    const state = f.orch.getWorkflowState(id)!;
    expect(state.workers.every((w) => w.status === "failed")).toBe(true);
    expect(state.status).toBe("failed");
  });

  it("cleans up each worker binding on completion (own-cleanup → orphan-reaper teardown)", async () => {
    const f = makeFixture("p");
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    expect(f.addedBindings).toHaveLength(2); // created at spawn
    expect(f.removedBindings).toHaveLength(2); // removed on completion
    expect(f.bindings.size).toBe(0);
  });

  it("passes an AbortSignal wall-clock backstop to each dispatchTurn", async () => {
    const f = makeFixture("p");
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    expect(f.dispatchSignals).toHaveLength(2);
    for (const s of f.dispatchSignals) expect(s).toBeInstanceOf(AbortSignal);
  });

  it("posts a final aggregated result to the bound channel on completion", async () => {
    const f = makeFixture("p");
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    const finalPost = f.posts.find((p) => p.text.includes("complete"))!;
    expect(finalPost).toBeDefined();
    expect(finalPost.agent).toBe("p");
    expect(finalPost.text).toContain("s0");
    expect(finalPost.text).toContain("s1");
    expect(finalPost.text).toContain("result:");
  });
});

// INC-2026-08-10 — chunking is no longer the DEFAULT finalize path; it now
// only runs under the `inline` rollback mode, so these tests pass
// `outputMode: "inline"` explicitly. The machinery still has to work: `inline`
// is the operator's escape hatch if consolidation ever hides something they
// need, and it is the only path that can exceed one message.
describe("WorkflowOrchestrator — finalize chunking, inline mode (quick task 260714-mkq)", () => {
  // The Discord per-message ceiling is 2000; finalize splits at a ~1900 margin.
  const CHUNK_MARGIN = 1900;

  it("splits an oversized finalize into multiple Discord-safe chunks, posted in order", async () => {
    // One step whose result is far larger than the Discord ceiling.
    const bigResult = "LONGRESULT ".repeat(500); // ~5500 chars
    const f = makeFixture("p", { dispatchResultText: bigResult, outputMode: "inline" });
    f.orch.launchWorkflow("p", spec(1));
    await f.orch.drainForTest();

    // No progress pings during drain (sweepWorkflows not invoked) → every post
    // is a finalize chunk.
    expect(f.posts.length).toBeGreaterThan(1);
    for (const p of f.posts) {
      expect(p.agent).toBe("p");
      expect(p.text.length).toBeLessThanOrEqual(CHUNK_MARGIN);
    }
    // Header lands in the FIRST chunk; the result body is spread across chunks.
    expect(f.posts[0].text).toContain("complete");
    expect(f.posts.some((p) => p.text.includes("LONGRESULT"))).toBe(true);
  });

  it("posts a short finalize as exactly ONE message (no behavior change)", async () => {
    const f = makeFixture("p");
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0].text).toContain("complete");
    expect(f.posts[0].text.length).toBeLessThanOrEqual(CHUNK_MARGIN);
  });

  it("Finding 2 (260714-mkq): formats BEFORE splitting — no chunk can expand past 2000 under the daemon's per-chunk re-format", async () => {
    // Adversarial-review repro: a wide markdown table in a worker result. The
    // daemon's sendText applies formatOutboundText AFTER our split; on RAW
    // chunks the table re-render/em-dash replacement expanded 1900-char chunks
    // to 2100-3074 chars → Discord 50035 → chunk silently dropped. With
    // format-then-split, formatOutboundText is idempotent — re-applying it to
    // any posted chunk must not grow it past Discord's 2000 hard limit.
    const wideRow =
      "| alpha beta gamma delta epsilon zeta | eta theta iota kappa lambda mu | nu xi omicron pi rho sigma | tau upsilon phi chi psi omega | one two three four five — six |";
    const wideTable = [
      "| Column A heading | Column B heading | Column C heading | Column D heading | Column E heading |",
      "| --- | --- | --- | --- | --- |",
      ...Array.from({ length: 60 }, () => wideRow),
    ].join("\n");
    const f = makeFixture("p", { dispatchResultText: wideTable, outputMode: "inline" });
    f.orch.launchWorkflow("p", spec(1));
    await f.orch.drainForTest();

    expect(f.posts.length).toBeGreaterThan(1);
    for (const p of f.posts) {
      expect(formatOutboundText(p.text).length).toBeLessThanOrEqual(2000);
    }
  });

  it("logs (does not swallow) a per-chunk post failure and still attempts remaining chunks", async () => {
    const bigResult = "LONGRESULT ".repeat(500); // ~5500 chars → multiple chunks
    // Fail the FIRST finalize post (chunk index 0); remaining chunks must still post.
    const f = makeFixture("p", {
      dispatchResultText: bigResult,
      failPostCall: 1,
      outputMode: "inline",
    });
    f.orch.launchWorkflow("p", spec(1));
    await f.orch.drainForTest();

    // The failed chunk was logged, not silently swallowed.
    expect(f.loggedErrors.length).toBeGreaterThanOrEqual(1);
    const chunkErr = f.loggedErrors.find(
      (e) => (e as { chunkIndex?: number }).chunkIndex === 0,
    ) as
      | { chunkIndex?: number; workflowId?: string; agent?: string }
      | undefined;
    expect(chunkErr).toBeDefined();
    expect(chunkErr!.agent).toBe("p");
    expect(typeof chunkErr!.workflowId).toBe("string");
    // Remaining chunks STILL attempted (chunk 0 failed → not pushed; the rest
    // posted), proving the loop did not abort on the first failure.
    expect(f.posts.length).toBeGreaterThanOrEqual(1);
  });

});

describe("WorkflowOrchestrator — consolidated finalize (INC-2026-08-10)", () => {
  it("REGRESSION: an oversized finalize is ONE message by default, not ~51", async () => {
    // The incident input: 4 steps, each far past the Discord ceiling. Under
    // the old unconditional concatenate this produced 51 sequential posts.
    const bigResult = "LONGRESULT ".repeat(2000); // ~22k chars per step
    const f = makeFixture("p", { dispatchResultText: bigResult });
    f.orch.launchWorkflow("p", spec(4));
    await f.orch.drainForTest();

    expect(f.posts).toHaveLength(1);
    expect(f.posts[0].text.length).toBeLessThanOrEqual(1900);
    expect(f.posts[0].text).toContain("complete");
    // The claim is about VOLUME, not vocabulary: a one-line-per-step gist may
    // legitimately quote the start of a result. What must never happen again
    // is the whole payload reaching the channel.
    const rawTotal = bigResult.length * 4;
    expect(f.posts[0].text.length).toBeLessThan(rawTotal / 50);
  });

  it("still names every step, and points at the on-disk artifacts", async () => {
    // Consolidation must not become concealment: the operator has to be able
    // to find the full text, which is what the persisted dir is for.
    const f = makeFixture("p", {
      // Long enough to clear the INC-2026-08-14 meta-summary gate - the gist
      // assertion below needs the ORIGINAL result, not a corrective retry.
      dispatchResultText:
        "Finding: margins compressed 400bps. " +
        "Supporting detail with verified figures and sources. ".repeat(6),
    });
    f.orch.launchWorkflow("p", spec(3));
    await f.orch.drainForTest();

    expect(f.posts).toHaveLength(1);
    const text = f.posts[0].text;
    expect(text).toContain("3/3 step(s) succeeded");
    expect(text).toContain("margins compressed 400bps");
    expect(text).toMatch(/workflows\/wf_/);
  });

  it("delivers the summary AND both PDFs in ONE message", async () => {
    const f = makeFixture("p", { withReports: true, withFileSender: true });
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();

    expect(f.filePosts).toHaveLength(1);
    expect(f.posts).toHaveLength(0); // no separate text post
    expect(f.filePosts[0].names).toEqual(["wf_id0001-report.pdf"]);
    expect(f.filePosts[0].text).toContain("complete");
    // The attachment `content` path bypasses splitMessage entirely.
    expect(f.filePosts[0].text.length).toBeLessThanOrEqual(2000);
  });

  it("names the attachments it is actually shipping, and only those", async () => {
    const withFiles = makeFixture("p", { withReports: true, withFileSender: true });
    withFiles.orch.launchWorkflow("p", spec(2));
    await withFiles.orch.drainForTest();
    expect(withFiles.filePosts[0].text).toContain("Attached:");

    // Render failed -> the summary must not advertise files nobody received.
    const noFiles = makeFixture("p", {
      withReports: true,
      withFileSender: true,
      failRender: true,
    });
    noFiles.orch.launchWorkflow("p", spec(2));
    await noFiles.orch.drainForTest();
    expect(noFiles.posts).toHaveLength(1);
    expect(noFiles.posts[0].text).not.toContain("Attached:");
  });

  it("falls back to a text post when the file send is rejected", async () => {
    // A bot without ATTACH_FILES in the channel is a live failure mode on this
    // fleet; losing the summary to it would be strictly worse than no PDFs.
    const f = makeFixture("p", {
      withReports: true,
      withFileSender: true,
      failFilePost: true,
    });
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();

    expect(f.filePosts).toHaveLength(0);
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0].text).toContain("complete");
  });

  it("posts text-only when the render fails, and still completes the workflow", async () => {
    const f = makeFixture("p", {
      withReports: true,
      withFileSender: true,
      failRender: true,
    });
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();

    expect(f.filePosts).toHaveLength(0);
    expect(f.posts).toHaveLength(1);
    // INC-2026-08-14b — 3/3, not 2/2: the report-synthesis step runs through
    // the same machinery and counts as a step (honest accounting).
    expect(f.posts[0].text).toContain("3/3 step(s) succeeded");
  });

  it("does not render at all when reportDeps is absent", async () => {
    const f = makeFixture("p", { withFileSender: true });
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    expect(f.filePosts).toHaveLength(0);
    expect(f.posts).toHaveLength(1);
  });

  it("inline rollback mode skips the report render entirely", async () => {
    // `inline` is the escape hatch back to pre-incident behavior; pairing it
    // with a browser render would be the worst of both.
    const f = makeFixture("p", {
      outputMode: "inline",
      withReports: true,
      withFileSender: true,
    });
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    expect(f.filePosts).toHaveLength(0);
    expect(f.posts.length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces a failed step's reason in the consolidated post", async () => {
    // A failure must never be reduced to a count the operator has to go dig up.
    const f = makeFixture("p", {
      dispatchFailMessage: "do step 1",
      dispatchFailError: "upstream 502 from data vendor",
    });
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();

    const text = f.posts.map((x) => x.text).join("\n");
    expect(text).toContain("failed");
    expect(text).toContain("502");
  });
});

describe("WorkflowOrchestrator.sweepWorkflows — progress + reaper survival (Plan 06)", () => {
  it("refreshes every running worker's lastActivity on each tick (reaper survival)", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", spec(2));
    await waitFor(() => {
      const s = f.orch.getWorkflowState(id);
      return (
        !!s && s.workers.length === 2 && s.workers.every((w) => w.status === "running")
      );
    });

    f.clock.now += 60_000; // one 60s tick later
    await f.orch.sweepWorkflows(f.clock.now);

    for (const sessionName of f.startedSessions) {
      expect(f.bindings.get(sessionName)!.lastActivity).toBe(f.clock.now);
    }

    for (const [, resolve] of f.dispatchResolvers) resolve("done");
    await f.orch.drainForTest();
  });

  it("posts a progress ping only after the progress interval elapses", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", spec(2));
    await waitFor(() => {
      const s = f.orch.getWorkflowState(id);
      return (
        !!s && s.workers.length === 2 && s.workers.every((w) => w.status === "running")
      );
    });

    // Before the interval: a sweep refreshes but does NOT post a ping.
    f.clock.now += 60_000;
    await f.orch.sweepWorkflows(f.clock.now);
    // 999.165 — the ping is identified by its prefix (the header changed).
    expect(f.posts.filter((p) => p.text.startsWith("Workflow")).length).toBe(0);

    // After the interval: exactly one ping to the bound channel.
    f.clock.now += WORKFLOW_PROGRESS_INTERVAL_MS;
    await f.orch.sweepWorkflows(f.clock.now);
    const pings = f.posts.filter((p) => p.text.startsWith("Workflow"));
    expect(pings).toHaveLength(1);
    expect(pings[0].agent).toBe("p");

    for (const [, resolve] of f.dispatchResolvers) resolve("done");
    await f.orch.drainForTest();
  });

  it("is a no-op when there are no running workflows", async () => {
    const f = makeFixture("p");
    await expect(f.orch.sweepWorkflows(f.clock.now)).resolves.toBeUndefined();
    expect(f.posts).toHaveLength(0);
  });

  it("aborts wedged workers + posts a stall notice after WORKFLOW_STALL_MS of no progress", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", spec(2));
    await waitFor(() => {
      const s = f.orch.getWorkflowState(id);
      return (
        !!s &&
        s.workers.length === 2 &&
        s.workers.every((w) => w.status === "running")
      );
    });

    // Before the stall bound: a sweep refreshes/pings but does NOT abort.
    f.clock.now += WORKFLOW_PROGRESS_INTERVAL_MS;
    await f.orch.sweepWorkflows(f.clock.now);
    expect(f.posts.filter((p) => p.text.includes("stalled"))).toHaveLength(0);
    expect(f.dispatchSignals.every((sig) => sig && !sig.aborted)).toBe(true);

    // Past the stall bound with no worker having settled → abort the wedged
    // workers so the barrier can proceed with partial results.
    f.clock.now += WORKFLOW_STALL_MS;
    await f.orch.sweepWorkflows(f.clock.now);

    expect(f.dispatchSignals).toHaveLength(2);
    expect(f.dispatchSignals.every((sig) => sig?.aborted === true)).toBe(true);
    const stallPosts = f.posts.filter((p) => p.text.includes("stalled"));
    expect(stallPosts).toHaveLength(1);
    expect(stallPosts[0].agent).toBe("p");
    expect(stallPosts[0].text).toMatch(/aborting 2 stuck step/);

    // Idempotent — the stallAborted guard prevents a re-abort/re-post next tick.
    f.clock.now += WORKFLOW_STALL_MS;
    await f.orch.sweepWorkflows(f.clock.now);
    expect(f.posts.filter((p) => p.text.includes("stalled"))).toHaveLength(1);

    for (const [, resolve] of f.dispatchResolvers) resolve("done");
    await f.orch.drainForTest();
  });

  it("does NOT stall a workflow that keeps making progress (worker settles reset the clock)", async () => {
    const f = makeFixture("p");
    const id = f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest(); // workers complete promptly (no dispatchPending)
    const s = f.orch.getWorkflowState(id);
    expect(s?.workers.every((w) => w.status === "done")).toBe(true);

    // Even long after STALL_MS, a settled workflow is never stall-aborted.
    f.clock.now += WORKFLOW_STALL_MS * 3;
    await f.orch.sweepWorkflows(f.clock.now);
    expect(f.posts.filter((p) => p.text.includes("stalled"))).toHaveLength(0);
  });
});

describe("WorkflowOrchestrator.listWorkflows — pull-based status projection", () => {
  it("projects in-flight workflows with worker counts + filters by agent", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", spec(3));
    await waitFor(() => {
      const s = f.orch.getWorkflowState(id);
      return !!s && s.workers.length === 3;
    });

    const all = f.orch.listWorkflows();
    expect(all).toHaveLength(1);
    expect(all[0].workflowId).toBe(id);
    expect(all[0].parentAgentName).toBe("p");
    expect(all[0].workers.total).toBe(3);
    expect(all[0].workers.running).toBe(3);
    expect(all[0].ageMs).toBeGreaterThanOrEqual(0);

    // Filter by a different agent → empty.
    expect(f.orch.listWorkflows({ agent: "other" })).toHaveLength(0);
    expect(f.orch.listWorkflows({ agent: "p" })).toHaveLength(1);

    for (const [, resolve] of f.dispatchResolvers) resolve("done");
    await f.orch.drainForTest();
  });
});

describe("WorkflowOrchestrator — admission control (2026-06-27 OOM fix)", () => {
  it("stops each worker session on completion (synchronous teardown frees the heap)", async () => {
    const f = makeFixture("p");
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    // Every worker that ran a turn is explicitly stopped (not left for the
    // ~300s orphan reaper) — this is what makes the concurrency cap bound
    // RESIDENT sessions, not just active turns.
    expect(f.stoppedSessions.sort()).toEqual([...f.startedSessions].sort());
    expect(f.stoppedSessions).toHaveLength(2);
  });

  it("bounds concurrent worker turns to maxConcurrentWorkers across the workflow", async () => {
    // 6 steps, cap 2, turns held pending → only 2 can be in flight at once.
    const f = makeFixture("p", {
      maxConcurrentWorkers: 2,
      dispatchPending: true,
    });
    f.orch.launchWorkflow("p", spec(6));

    await waitFor(() => f.dispatchedTurns.length >= 2);
    await new Promise((r) => setTimeout(r, 25));
    // Capped: the other 4 steps are blocked in the admission gate.
    expect(f.dispatchedTurns.length).toBe(2);

    // Release waves; each freed slot admits exactly one more (never > cap).
    let guard = 0;
    while (f.dispatchedTurns.length < 6 && guard++ < 30) {
      const before = f.dispatchedTurns.length;
      for (const [, resolve] of [...f.dispatchResolvers]) // Long enough to clear the INC-2026-08-14 quality gate: this test counts
        // dispatches as a proxy for ADMITTED workers, and a corrective retry
        // would inflate the count without violating the real concurrency bound.
        resolve(`done - findings. ${"Detail. ".repeat(40)}`);
      await waitFor(
        () => f.dispatchedTurns.length > before || f.dispatchedTurns.length >= 6,
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(f.dispatchedTurns.length - before).toBeLessThanOrEqual(2);
    }
    expect(f.dispatchedTurns.length).toBe(6);

    for (const [, resolve] of [...f.dispatchResolvers]) resolve(`done - findings. ${"Detail. ".repeat(40)}`);
    await f.orch.drainForTest();
  });

  it("records a failed worker (never silently drops a step) when admission times out under memory pressure", async () => {
    // Memory above the 85% watermark + a short wall-clock timeout → every step
    // is refused admission before any session is spawned.
    const f = makeFixture("p", { memoryPercent: 95, admissionTimeoutMs: 20 });
    const id = f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();

    const state = f.orch.getWorkflowState(id)!;
    expect(state.workers).toHaveLength(2);
    expect(state.workers.every((w) => w.status === "failed")).toBe(true);
    expect(
      state.workers.every((w) => /admission failed/.test(w.error ?? "")),
    ).toBe(true);
    // Admission blocked BEFORE spawn — no worker session ever started.
    expect(f.startedSessions).toHaveLength(0);
    expect(state.status).toBe("failed");
  });

  it("admits freely when memory is below the watermark (fail-open path unaffected)", async () => {
    const f = makeFixture("p", { memoryPercent: 50 });
    const id = f.orch.launchWorkflow("p", spec(3));
    await f.orch.drainForTest();
    const state = f.orch.getWorkflowState(id)!;
    expect(state.workers.every((w) => w.status === "done")).toBe(true);
    expect(f.startedSessions).toHaveLength(3);
  });
});

describe("WorkflowOrchestrator — bounded step runners (INC-2026-07-26 starvation fix)", () => {
  it("steps beyond the cap do NOT time out at fan-out: admission wait starts at pickup, not launch", async () => {
    // The 2026-07-26 failure shape: N steps against a small cap with turns
    // longer than the admission timeout. Under the OLD fan-out-anchored
    // acquires, steps 5-6 here would blow the 50ms admission deadline while
    // the first waves ran (6 steps × 30ms / 2 slots = 90ms of queue).
    // Bounded runners acquire only when they PICK a step up, so no step ever
    // waits in the gate longer than a slot handoff.
    const f = makeFixture("p", {
      maxConcurrentWorkers: 2,
      admissionTimeoutMs: 50,
      dispatchDelayMs: 30,
    });
    const id = f.orch.launchWorkflow("p", spec(6));
    await f.orch.drainForTest();

    const state = f.orch.getWorkflowState(id)!;
    expect(state.workers).toHaveLength(6);
    expect(state.workers.every((w) => w.status === "done")).toBe(true);
    expect(
      state.workers.some((w) => /admission failed/.test(w.error ?? "")),
    ).toBe(false);
    expect(state.status).toBe("done");
  });

  it("two concurrent workflows share the pool and BOTH complete (no cross-workflow starvation)", async () => {
    // Strengthened pin (review): the admission timeout (100ms) is SHORTER
    // than the four steps' total serial time (4 × 40ms = 160ms). Under the
    // old fan-out-anchored acquires, the last-queued steps' deadlines —
    // anchored at launch — would expire before their turn came and fail.
    // With runner-anchored acquires no single wait approaches the timeout.
    const f = makeFixture("p", {
      maxConcurrentWorkers: 1,
      admissionTimeoutMs: 100,
      dispatchDelayMs: 40,
    });
    const idA = f.orch.launchWorkflow("p", spec(2));
    const idB = f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();

    for (const id of [idA, idB]) {
      const state = f.orch.getWorkflowState(id)!;
      expect(state.workers.every((w) => w.status === "done")).toBe(true);
      expect(state.status).toBe("done");
    }
  });
});

describe("WorkflowOrchestrator — stall recovery closes the spawn window (INC-2026-07-26 review)", () => {
  it("after stall recovery, unstarted queued steps are drained as skipped — no new workers spawn", async () => {
    // cap 1 → one runner; s0 wedges pending, s1/s2 still in the step queue.
    const f = makeFixture("p", {
      maxConcurrentWorkers: 1,
      dispatchPending: true,
      admissionTimeoutMs: 60_000,
    });
    const id = f.orch.launchWorkflow("p", spec(3));
    await waitFor(() => f.dispatchedTurns.length === 1);

    f.clock.now += WORKFLOW_STALL_MS + 1;
    await f.orch.sweepWorkflows(f.clock.now);
    await f.orch.drainForTest();

    const state = f.orch.getWorkflowState(id)!;
    // Only s0 ever spawned; s1/s2 were drained without spawning.
    expect(f.startedSessions).toHaveLength(1);
    expect(state.workers).toHaveLength(3);
    expect(
      state.workers.filter((w) =>
        /skipped: workflow stall recovery/.test(w.error ?? ""),
      ),
    ).toHaveLength(2);
    // The wedged s0 was aborted (not retried — abort is not a masquerade).
    expect(
      f.dispatchedTurns.filter((t) => t.message === "do step 0"),
    ).toHaveLength(1);
    expect(state.status).toBe("failed");
  });

  it("stall recovery aborts the workflow's QUEUED gate waiters — no post-recovery admission spawns", async () => {
    // cap 2: workflow A's wedged step holds slot 1; workflow B's runner 1
    // wedges in slot 2 while B's runner 2 waits IN THE GATE. When B stalls,
    // its gate waiter must be torn out of the FIFO — otherwise it would be
    // admitted into the freed slot and spawn a fresh worker into a workflow
    // that already reported partial results.
    const f = makeFixture("p", {
      maxConcurrentWorkers: 2,
      dispatchPending: true,
      admissionTimeoutMs: 60_000,
    });
    f.orch.launchWorkflow("p", spec(1)); // A — takes slot 1, wedges
    await waitFor(() => f.dispatchedTurns.length === 1);
    const idB = f.orch.launchWorkflow("p", spec(3)); // B — slot 2 + 1 gate waiter
    await waitFor(() => f.dispatchedTurns.length === 2);
    const spawnedBeforeRecovery = f.startedSessions.length;

    f.clock.now += WORKFLOW_STALL_MS + 1;
    await f.orch.sweepWorkflows(f.clock.now);
    await f.orch.drainForTest();

    // No session spawned after recovery fired.
    expect(f.startedSessions).toHaveLength(spawnedBeforeRecovery);
    const stateB = f.orch.getWorkflowState(idB)!;
    expect(stateB.workers).toHaveLength(3);
    // The gate waiter surfaced as an admission failure (aborted before
    // admission), the queued third step as a drained skip — all terminal.
    expect(
      stateB.workers.some((w) => /aborted before worker admission/.test(w.error ?? "")),
    ).toBe(true);
    expect(stateB.workers.every((w) => w.status !== "running")).toBe(true);
  });

  it("a max-turn-duration masquerade is terminal — never retried (budget exhaustion must not double)", async () => {
    const f = makeFixture("p", {
      dispatchFailMessage: "do step 0",
      dispatchFailError:
        "stream-stall abort masqueraded as a result message (reason=max-turn-duration)",
    });
    const id = f.orch.launchWorkflow("p", spec(1));
    await f.orch.drainForTest();

    const state = f.orch.getWorkflowState(id)!;
    expect(state.workers[0]?.status).toBe("failed");
    expect(
      f.dispatchedTurns.filter((t) => t.message === "do step 0"),
    ).toHaveLength(1);
  });
});

describe("WorkflowOrchestrator — disk persistence (2026-07-27: results previously vanished after the 10-min prune)", () => {
  it("writes each completed step's result at settle time + summary.json at finalize, and the post advertises the directory", async () => {
    const f = makeFixture("p");
    const id = f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();

    // Per-step artifacts carry the worker's full result.
    const stepWrites = f.persistedArtifacts.filter((a) =>
      a.relativePath.endsWith(".md"),
    );
    expect(stepWrites).toHaveLength(2);
    expect(stepWrites.map((a) => a.relativePath).sort()).toEqual([
      "00-s0.md",
      "01-s1.md",
    ]);
    expect(stepWrites.every((a) => a.workflowId === id)).toBe(true);
    expect(stepWrites.every((a) => a.content.startsWith("result:"))).toBe(true);

    // summary.json is machine-readable with per-step status + resultFile.
    const summary = f.persistedArtifacts.find(
      (a) => a.relativePath === "summary.json",
    );
    expect(summary).toBeDefined();
    const parsed = JSON.parse(summary!.content) as {
      status: string;
      steps: { stepId: string; status: string; resultFile?: string }[];
    };
    expect(parsed.status).toBe("done");
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps.every((s) => s.status === "done")).toBe(true);
    expect(parsed.steps[0]?.resultFile).toBe(`workflows/${id}/00-s0.md`);

    // The finalize post tells the agent where the files are.
    const finalPost = f.posts.find((p) => p.text.includes("complete"));
    expect(finalPost?.text).toContain(`workflows/${id}/`);

    // The tracked worker records carry the workspace-relative path.
    const state = f.orch.getWorkflowState(id)!;
    expect(state.workers.every((w) => w.resultFile?.startsWith("workflows/"))).toBe(
      true,
    );
  });

  it("sanitizes hostile model-supplied stepIds — no path traversal into the workspace", async () => {
    const f = makeFixture("p");
    f.orch.launchWorkflow("p", {
      steps: [{ stepId: "../../etc/passwd", prompt: "do evil step" }],
    });
    await f.orch.drainForTest();

    const stepWrite = f.persistedArtifacts.find((a) =>
      a.relativePath.endsWith(".md"),
    );
    expect(stepWrite).toBeDefined();
    expect(stepWrite!.relativePath).not.toContain("/");
    expect(stepWrite!.relativePath).not.toContain("..");
  });

  it("colliding stepIds get DISTINCT artifact files (index-namespaced) — no silent overwrite (review HIGH)", async () => {
    const f = makeFixture("p");
    const id = f.orch.launchWorkflow("p", {
      // Both sanitize to the same stem "fetch_" — pre-fix they mapped to ONE
      // file and the later settle silently clobbered the earlier result.
      steps: [
        { stepId: "fetch!", prompt: "do step A" },
        { stepId: "fetch?", prompt: "do step B" },
      ],
    });
    await f.orch.drainForTest();

    const stepWrites = f.persistedArtifacts.filter((a) =>
      a.relativePath.endsWith(".md"),
    );
    expect(stepWrites.map((a) => a.relativePath).sort()).toEqual([
      "00-fetch_.md",
      "01-fetch_.md",
    ]);
    // summary.json points each step at its OWN file.
    const summary = JSON.parse(
      f.persistedArtifacts.find((a) => a.relativePath === "summary.json")!
        .content,
    ) as { steps: { stepId: string; resultFile?: string }[] };
    expect(summary.steps[0]?.resultFile).toBe(`workflows/${id}/00-fetch_.md`);
    expect(summary.steps[1]?.resultFile).toBe(`workflows/${id}/01-fetch_.md`);
  });

  it("persist failures are best-effort: workflow completes, result still posts, no directory advertised, warn logged", async () => {
    const f = makeFixture("p", { failPersist: true });
    const id = f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();

    const state = f.orch.getWorkflowState(id)!;
    expect(state.status).toBe("done");
    expect(state.workers.every((w) => w.status === "done")).toBe(true);
    expect(state.workers.every((w) => w.resultFile === undefined)).toBe(true);
    const finalPost = f.posts.find((p) => p.text.includes("complete"));
    expect(finalPost).toBeDefined();
    expect(finalPost!.text).not.toContain("workflows/");
    expect(
      f.loggedWarns.some((w) =>
        String((w as { err?: string }).err ?? "").includes("synthetic persist"),
      ),
    ).toBe(true);
  });

  it("a failed step gets no result file; its error lands in summary.json", async () => {
    const f = makeFixture("p", { dispatchFailMessage: "do step 0" });
    const id = f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();

    const stepWrites = f.persistedArtifacts.filter((a) =>
      a.relativePath.endsWith(".md"),
    );
    expect(stepWrites.map((a) => a.relativePath)).toEqual(["01-s1.md"]);
    const summary = JSON.parse(
      f.persistedArtifacts.find((a) => a.relativePath === "summary.json")!
        .content,
    ) as { steps: { stepId: string; status: string; error?: string }[] };
    const failedStep = summary.steps.find((s) => s.stepId === "s0")!;
    expect(failedStep.status).toBe("failed");
    expect(failedStep.error).toContain("synthetic dispatch failure");
    expect(id).toBeTruthy();
  });
});

describe("sanitizeStepFileName", () => {
  it("collapses path metacharacters and truncates to 64 chars", () => {
    expect(sanitizeStepFileName("../../etc/passwd")).not.toContain("/");
    expect(sanitizeStepFileName("../../etc/passwd")).not.toContain(".");
    expect(sanitizeStepFileName("fetch-filings_2")).toBe("fetch-filings_2");
    expect(sanitizeStepFileName("a".repeat(100))).toHaveLength(64);
    expect(sanitizeStepFileName("!!!")).toBe("___");
    expect(sanitizeStepFileName("")).toBe("step");
  });
});

describe("WorkflowOrchestrator — bounded step retry (INC-2026-07-26)", () => {
  const MASQUERADE_MSG =
    "stream-stall abort masqueraded as a result message (reason=max-pause-exceeded, inFlightTools=WebFetch(893s))";

  it("retries a stall-aborted step ONCE and reports the step done on retry success", async () => {
    const f = makeFixture("p", {
      dispatchFailOnceMessage: "do step 1",
      dispatchFailOnceError: MASQUERADE_MSG,
    });
    const id = f.orch.launchWorkflow("p", spec(3));
    await f.orch.drainForTest();

    const state = f.orch.getWorkflowState(id)!;
    // The failed first attempt's record was dropped — final outcome only.
    expect(state.workers).toHaveLength(3);
    expect(state.workers.every((w) => w.status === "done")).toBe(true);
    expect(state.status).toBe("done");
    // The step was dispatched twice (attempt + retry) and the retry was
    // logged, never invisible.
    expect(
      f.dispatchedTurns.filter((t) => t.message === "do step 1"),
    ).toHaveLength(2);
    expect(
      f.loggedWarns.some(
        (w) =>
          (w as { stepId?: string; attempt?: number }).stepId === "s1" &&
          (w as { attempt?: number }).attempt === 2,
      ),
    ).toBe(true);
    // Both attempts' sessions were torn down (release-after-teardown holds
    // across retries).
    expect(f.stoppedSessions.sort()).toEqual([...f.startedSessions].sort());
  });

  it("a step that stall-aborts on BOTH attempts is terminal after exactly two tries", async () => {
    const f = makeFixture("p", {
      dispatchFailMessage: "do step 0", // fails EVERY time…
      dispatchFailError: MASQUERADE_MSG, // …with the RETRYABLE signature
    });
    const id = f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();

    const state = f.orch.getWorkflowState(id)!;
    expect(state.workers).toHaveLength(2);
    const failed = state.workers.find((w) => w.stepId === "s0")!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe(MASQUERADE_MSG);
    // Exactly two dispatch attempts for the failing step — no third.
    expect(
      f.dispatchedTurns.filter((t) => t.message === "do step 0"),
    ).toHaveLength(2);
    // The sibling step still succeeded.
    expect(state.workers.find((w) => w.stepId === "s1")?.status).toBe("done");
  });

  it("a generic turn failure is NOT retried (single attempt, terminal)", async () => {
    const f = makeFixture("p", { dispatchFailMessage: "do step 0" });
    const id = f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();

    const state = f.orch.getWorkflowState(id)!;
    expect(state.workers.find((w) => w.stepId === "s0")?.status).toBe("failed");
    expect(
      f.dispatchedTurns.filter((t) => t.message === "do step 0"),
    ).toHaveLength(1);
  });

  it("an admission timeout is retried once (memory-pressure timeout → two gate passes)", async () => {
    const f = makeFixture("p", { memoryPercent: 95, admissionTimeoutMs: 20 });
    const id = f.orch.launchWorkflow("p", spec(1));
    await f.orch.drainForTest();

    const state = f.orch.getWorkflowState(id)!;
    // Terminal after the bounded retry — exactly one final failed record.
    expect(state.workers).toHaveLength(1);
    expect(state.workers[0]?.status).toBe("failed");
    expect(/admission failed/.test(state.workers[0]?.error ?? "")).toBe(true);
    // The retry attempt was logged.
    expect(
      f.loggedWarns.some(
        (w) => (w as { attempt?: number }).attempt === 2,
      ),
    ).toBe(true);
    expect(f.startedSessions).toHaveLength(0);
  });
});

describe("WorkflowOrchestrator — terminal retention + heap release (999.106 QW-1)", () => {
  it("releases every worker's result + prompt at finalize (text path), keeping status + resultFile", async () => {
    const f = makeFixture("p");
    const id = f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();

    const state = f.orch.getWorkflowState(id)!;
    expect(state.status).toBe("done");
    for (const w of state.workers) {
      // The retained heap strings are gone…
      expect(w.result).toBeUndefined();
      expect(w.prompt).toBe("");
      // …but the metadata + disk pointer survive (the read-back route).
      expect(w.status).toBe("done");
      expect(w.resultFile).toMatch(new RegExp(`^workflows/${id}/`));
    }
    // The release happened AFTER composition: the posted summary still names
    // every step (composed from the results before they were dropped).
    expect(f.posts.length).toBeGreaterThan(0);
  });

  it("releases result + prompt on the attachment-post success path too (early return)", async () => {
    const f = makeFixture("p", { withReports: true, withFileSender: true });
    const id = f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();

    // The attachment leg posted (early-return path) — the release must have
    // run BEFORE that return, or this path would never free the heap.
    expect(f.filePosts).toHaveLength(1);
    const state = f.orch.getWorkflowState(id)!;
    for (const w of state.workers) {
      expect(w.result).toBeUndefined();
      expect(w.prompt).toBe("");
    }
  });

  it("sweep evicts a terminal workflow after WORKFLOW_TERMINAL_RETENTION_MS — after the 10-min view filter already hid it", async () => {
    const f = makeFixture("p");
    const id = f.orch.launchWorkflow("p", spec(1));
    await f.orch.drainForTest();
    expect(f.orch.getWorkflowState(id)!.status).toBe("done");

    // Inside the retention window: view filter hides it at >10 min, but the
    // state itself must survive (the /clawcode-workflows contract is purely
    // the view's; eviction is the sweep's).
    f.clock.now += 11 * 60_000;
    await f.orch.sweepWorkflows(f.clock.now);
    expect(f.orch.listWorkflows()).toHaveLength(0);
    expect(f.orch.getWorkflowState(id)).toBeDefined();

    // Past retention: the sweep deletes the map entry (pre-QW-1 NOTHING ever
    // deleted from the map — the 1.66 GB daemon-heap accumulation).
    f.clock.now += WORKFLOW_TERMINAL_RETENTION_MS;
    await f.orch.sweepWorkflows(f.clock.now);
    expect(f.orch.getWorkflowState(id)).toBeUndefined();
  });

  it("never evicts a RUNNING workflow, regardless of age", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", spec(1));
    await waitFor(() => {
      const s = f.orch.getWorkflowState(id);
      return !!s && s.workers.some((w) => w.status === "running");
    });

    f.clock.now += WORKFLOW_TERMINAL_RETENTION_MS * 4;
    await f.orch.sweepWorkflows(f.clock.now);
    expect(f.orch.getWorkflowState(id)).toBeDefined();

    for (const [, resolve] of f.dispatchResolvers) resolve("done");
    await f.orch.drainForTest();
  });

  it("a crashed run (launch-job catch) is stamped terminal and evicted like a finished one", async () => {
    // getParentConfig succeeds at launch; startAgent throws for every worker →
    // finalize marks the workflow failed. Either terminal route must stamp
    // finishedAt, or the entry leaks forever.
    const f = makeFixture("p", { failSessionsMatching: "-sub-" });
    const id = f.orch.launchWorkflow("p", spec(1));
    await f.orch.drainForTest();
    const state = f.orch.getWorkflowState(id)!;
    expect(state.status).toBe("failed");
    expect(state.finishedAt).toBeDefined();

    f.clock.now += WORKFLOW_TERMINAL_RETENTION_MS + 1;
    await f.orch.sweepWorkflows(f.clock.now);
    expect(f.orch.getWorkflowState(id)).toBeUndefined();
  });

  it("arms the reserved final-report step with REPORT_STEP_MAX_MS — not the 4h wall clock", async () => {
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((fn: Parameters<typeof setTimeout>[0], ms?: number) => {
        delays.push(ms ?? 0);
        return origSetTimeout(fn, ms);
      }) as typeof setTimeout);
    try {
      const f = makeFixture("p", { withReports: true });
      f.orch.launchWorkflow("p", spec(2));
      await f.orch.drainForTest();
    } finally {
      spy.mockRestore();
    }
    // Two research steps arm the full wall clock; the synthesis step arms the
    // tight report deadline (it runs after stall protection is spent).
    expect(delays.filter((d) => d === WORKFLOW_WALL_CLOCK_MS)).toHaveLength(2);
    expect(delays.filter((d) => d === REPORT_STEP_MAX_MS)).toHaveLength(1);
  });

  it("Phase 999.123 — runs the reserved verify-figures step BEFORE the editor and hands its ledger to the final-report prompt", async () => {
    const ledgerResult = [
      "Audit complete; the ledger follows.",
      "```ledger",
      "figures:",
      '  - value: "$1,200"',
      '    claim: "monthly cost"',
      "    step: step-0",
      "    status: unsourced",
      "```",
      "The cost figure has no source.",
      "Detail sentence with facts and figures. ".repeat(8),
    ].join("\n");
    const f = makeFixture("p", {
      withReports: true,
      verifyFigures: true,
      // Every worker returns this: research (carries a figure, so the audit
      // runs), the fact-checker (carries the ledger) and the editor.
      dispatchResultText: `Revenue was $1,200 in 2025. ${"Detail sentence with facts and figures. ".repeat(8)}\n${ledgerResult}`,
    });
    const id = f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    const messages = f.dispatchedTurns.map((t) => t.message);
    const verifyIdx = messages.findIndex((m) => m.includes("You are the FACT-CHECKER"));
    const editorIdx = messages.findIndex((m) => m.includes("You are the EDITOR"));
    expect(verifyIdx).toBeGreaterThanOrEqual(2); // after both research steps
    expect(editorIdx).toBeGreaterThan(verifyIdx);
    expect(messages[editorIdx]).toContain("VERIFICATION LEDGER");
    expect(messages[editorIdx]).toContain("$1,200 (monthly cost; step-0): UNVERIFIED");
    // The fact-checker is not a source for the editor.
    expect(messages[editorIdx]).not.toContain("### source: verify-figures");
    const stepIds = f.orch.getWorkflowState(id)!.workers.map((w) => w.stepId);
    expect(stepIds).toEqual(["s0", "s1", "verify-figures", "final-report"]);
  });

  it("Phase 999.129 — a template run reads the previous run, briefs the editor, posts the deltas and persists run.json", async () => {
    const previous = {
      workflowId: "wf_prev",
      template: "market-scan",
      params: { ticker: "NVDA" },
      finishedAt: Date.UTC(2026, 7, 29),
      status: "done",
      bluf: "Flat week.",
      keyFindings: ["Revenue $1.2M"],
      nextSteps: [],
      changes: [],
    };
    const findings = [
      "```findings",
      "summary: Revenue rose.",
      "findings:",
      "  - Revenue $1.5M.",
      "changes:",
      "  - Revenue up $0.3M since last run.",
      "```",
    ].join("\n");
    const f = makeFixture("p", {
      withReports: true,
      previousRun: previous,
      dispatchResultText: `Revenue was $1,500,000 in 2026. ${"Detail sentence with facts and figures. ".repeat(8)}\n${findings}`,
    });
    const id = f.orch.launchWorkflow("p", spec(2), { origin: { template: "market-scan", params: { ticker: "NVDA" } } });
    await f.orch.drainForTest();
    const editor = f.dispatchedTurns.map((t) => t.message).find((m) => m.includes("You are the EDITOR"))!;
    expect(editor).toContain('PREVIOUS RUN. This is a recurring workflow (template "market-scan", ticker=NVDA)');
    expect(editor).toContain("- Bottom line then: Flat week.");
    expect(editor).toContain("Since last run");
    const run = f.persistedArtifacts.find((a) => a.workflowId === id && a.relativePath === "run.json");
    expect(run).toBeDefined();
    const record = JSON.parse(run!.content);
    expect(record).toMatchObject({ workflowId: id, template: "market-scan", params: { ticker: "NVDA" }, status: "done" });
    expect(record.changes).toEqual(["Revenue up $0.3M since last run."]);
    const summary = JSON.parse(f.persistedArtifacts.find((a) => a.workflowId === id && a.relativePath === "summary.json")!.content);
    expect(summary.origin).toEqual({ template: "market-scan", params: { ticker: "NVDA" } });
    const post = f.posts.map((p) => p.text).join("\n");
    expect(post).toContain("**Since last run (since 2026-08-29)**");
    expect(post).toContain("• Revenue up $0.3M since last run.");
    expect(post.indexOf("Since last run")).toBeLessThan(post.indexOf("**Key findings**"));
  });

  it("Phase 999.129 — an ad-hoc run neither reads a previous run nor writes run.json", async () => {
    const f = makeFixture("p", { withReports: true, previousRun: null });
    const id = f.orch.launchWorkflow("p", spec(1));
    await f.orch.drainForTest();
    expect(f.persistedArtifacts.some((a) => a.workflowId === id && a.relativePath === "run.json")).toBe(false);
    expect(f.dispatchedTurns.some((t) => t.message.includes("PREVIOUS RUN"))).toBe(false);
  });

  it("Phase 999.123 — the verify-figures step is skipped when the agent is not opted in", async () => {
    const f = makeFixture("p", {
      withReports: true,
      dispatchResultText: `Revenue was $1,200 in 2025. ${"Detail sentence with facts and figures. ".repeat(8)}`,
    });
    const id = f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    expect(f.dispatchedTurns.some((t) => t.message.includes("You are the FACT-CHECKER"))).toBe(false);
    expect(f.orch.getWorkflowState(id)!.workers.map((w) => w.stepId)).toEqual(["s0", "s1", "final-report"]);
  });
});

describe("buildWorkflowWorkerConfig — worker diet mode (999.106 QW-2)", () => {
  const server = (name: string) => ({
    name,
    command: "cmd",
    args: [] as const,
    env: {} as const,
    optional: false,
  });
  const roster = [server("search"), server("browser"), server("gworkspace")];

  it("full inherit when no allowlist anywhere (the zero-change first-deploy default)", () => {
    const parent = makeParentConfig("p", { mcpServers: roster });
    const cfg = buildWorkflowWorkerConfig(parent, "p-sub-abc123");
    expect(cfg.mcpServers).toEqual(roster);
    const cfgWithOpts = buildWorkflowWorkerConfig(parent, "p-sub-abc123", {});
    expect(cfgWithOpts.mcpServers).toEqual(roster);
  });

  it("per-step [] yields a TOOL-FREE worker", () => {
    const parent = makeParentConfig("p", { mcpServers: roster });
    const cfg = buildWorkflowWorkerConfig(parent, "p-sub-abc123", {
      stepMcpServers: [],
    });
    expect(cfg.mcpServers).toEqual([]);
  });

  it("filters fail-closed BOTH ways: only listed ∩ parent survives (no self-granting)", () => {
    const parent = makeParentConfig("p", { mcpServers: roster });
    const cfg = buildWorkflowWorkerConfig(parent, "p-sub-abc123", {
      stepMcpServers: ["browser", "1password-NOT-ATTACHED"],
    });
    expect((cfg.mcpServers ?? []).map((s) => s.name)).toEqual(["browser"]);
  });

  it("fleet ceiling applies when the step is silent; the step narrows WITHIN it", () => {
    const parent = makeParentConfig("p", { mcpServers: roster });
    const ceilingOnly = buildWorkflowWorkerConfig(parent, "p-sub-abc123", {
      mcpAllowlist: ["search", "browser"],
    });
    expect((ceilingOnly.mcpServers ?? []).map((s) => s.name)).toEqual([
      "search",
      "browser",
    ]);
    // Step precedence: an explicit step list narrows WITHIN the ceiling (the
    // canary lever) — including narrowing all the way to [].
    const stepWins = buildWorkflowWorkerConfig(parent, "p-sub-abc123", {
      mcpAllowlist: ["search", "browser"],
      stepMcpServers: ["search"],
    });
    expect((stepWins.mcpServers ?? []).map((s) => s.name)).toEqual(["search"]);
  });

  it("REVIEW FIX: a step list can NEVER escape the fleet ceiling — steps are agent-authored input", () => {
    const parent = makeParentConfig("p", { mcpServers: roster });
    // Operator caps workers to tool-free after a memory incident; an agent
    // re-requests its full roster per-step. The ceiling must win — `step ??
    // ceiling` semantics would silently defeat the operator's cap.
    const emptyCeiling = buildWorkflowWorkerConfig(parent, "p-sub-abc123", {
      mcpAllowlist: [],
      stepMcpServers: ["search", "browser", "gworkspace"],
    });
    expect(emptyCeiling.mcpServers).toEqual([]);
    // Partial ceiling: the step's extra names are clipped to step ∩ ceiling.
    const clipped = buildWorkflowWorkerConfig(parent, "p-sub-abc123", {
      mcpAllowlist: ["search"],
      stepMcpServers: ["search", "browser"],
    });
    expect((clipped.mcpServers ?? []).map((s) => s.name)).toEqual(["search"]);
  });

  it("e2e: steps[].mcpServers reaches the spawned worker's config; a plain step inherits", async () => {
    const f = makeFixture("p", { parentMcpServers: roster });
    f.orch.launchWorkflow("p", {
      steps: [
        { stepId: "slim", prompt: "analyze text", mcpServers: [] },
        { stepId: "full", prompt: "research web" },
      ],
    });
    await f.orch.drainForTest();

    const configs = [...f.startedConfigs.values()];
    const slim = configs.find((c) => c.soul?.includes("WORKFLOW WORKER") && c.mcpServers.length === 0);
    const full = configs.find((c) => c.mcpServers.length === roster.length);
    expect(slim).toBeDefined();
    expect(full).toBeDefined();
  });

  it("e2e: the fleet ceiling from getWorkflowLimits scopes every worker", async () => {
    const f = makeFixture("p", {
      parentMcpServers: roster,
      workerMcpAllowlist: ["gworkspace"],
    });
    f.orch.launchWorkflow("p", { steps: [{ stepId: "a", prompt: "task a" }] });
    await f.orch.drainForTest();

    const configs = [...f.startedConfigs.values()];
    expect(configs.length).toBeGreaterThan(0);
    for (const c of configs) {
      expect(c.mcpServers.map((s) => s.name)).toEqual(["gworkspace"]);
    }
  });
});

// ---------------------------------------------------------------------------
// 999.106 W-2 — waved execution
// ---------------------------------------------------------------------------

const waveSpec = (...sizes: number[]): WorkflowSpec => ({
  waves: sizes.map((n, w) =>
    Array.from({ length: n }, (_, i) => ({
      stepId: `w${w}s${i}`,
      prompt: `do wave ${w} step ${i}`,
    })),
  ),
});

describe("normalizeWorkflowSpec — shape + caps (999.106 W-2)", () => {
  it("normalizes a legacy {steps} spec to one wave", () => {
    const waves = normalizeWorkflowSpec(spec(3));
    expect(waves.length).toBe(1);
    expect(waves[0]!.length).toBe(3);
  });

  it("rejects a spec with BOTH steps and waves", () => {
    expect(() =>
      normalizeWorkflowSpec({ ...spec(2), ...waveSpec(1) }),
    ).toThrow(/exactly one/i);
  });

  it("rejects a spec with NEITHER steps nor waves", () => {
    expect(() => normalizeWorkflowSpec({} as WorkflowSpec)).toThrow(
      /exactly one/i,
    );
  });

  it("rejects an empty wave", () => {
    expect(() => normalizeWorkflowSpec({ waves: [[]] })).toThrow(/no steps/i);
  });

  it("rejects a wave over the per-wave parallel cap", () => {
    expect(() =>
      normalizeWorkflowSpec(waveSpec(MAX_WORKFLOW_PARALLEL_STEPS + 1)),
    ).toThrow(/parallel/i);
  });

  it("rejects more waves than MAX_WORKFLOW_WAVES", () => {
    expect(() =>
      normalizeWorkflowSpec(
        waveSpec(...Array.from({ length: MAX_WORKFLOW_WAVES + 1 }, () => 1)),
      ),
    ).toThrow(/wave cap/i);
  });

  it("rejects a total over MAX_WORKFLOW_TOTAL_STEPS even when each wave is legal", () => {
    // 5 waves × 8 = 40 > 24, every wave within the per-wave cap.
    expect(() => normalizeWorkflowSpec(waveSpec(8, 8, 8, 8, 8))).toThrow(
      /total-step cap/i,
    );
  });

  it("accepts the documented maximum shape (waves of ≤8, ≤6 waves, ≤24 total)", () => {
    expect(() => normalizeWorkflowSpec(waveSpec(8, 8, 8))).not.toThrow();
    expect(() =>
      normalizeWorkflowSpec(waveSpec(4, 4, 4, 4, 4, 4)),
    ).not.toThrow();
  });
});

describe("WorkflowOrchestrator — waved execution (999.106 W-2)", () => {
  it("launchWorkflow rejects an over-cap waves spec fast (no workers spawned)", () => {
    const f = makeFixture("p");
    expect(() =>
      f.orch.launchWorkflow("p", waveSpec(8, 8, 8, 8, 8)),
    ).toThrow(/total-step cap/i);
    expect(f.startedSessions.length).toBe(0);
  });

  it("runs waves strictly in order: wave K+1's first spawn post-dates wave K's last teardown", async () => {
    const f = makeFixture("p");
    f.orch.launchWorkflow("p", waveSpec(2, 1));
    await f.orch.drainForTest();

    // 3 workers total; the wave-2 worker's start must come after BOTH wave-1
    // stops in the interleaving log.
    expect(f.startedSessions.length).toBe(3);
    const wave2Start = f.events.indexOf(`start:${f.startedSessions[2]!}`);
    const wave1Stops = f.stoppedSessions
      .slice(0, 2)
      .map((s) => f.events.indexOf(`stop:${s}`));
    expect(wave2Start).toBeGreaterThan(Math.max(...wave1Stops));
  });

  it("a legacy {steps} spec still runs as a single wave (byte-compatible)", async () => {
    const f = makeFixture("p");
    const id = f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    const state = f.orch.getWorkflowState(id)!;
    expect(state.status).toBe("done");
    expect(state.workers.filter((w) => w.status === "done").length).toBe(2);
  });

  it("resets the completion-based stall clock at each wave boundary", async () => {
    const f = makeFixture("p", { dispatchPending: true, holdTeardown: true });
    const t0 = f.clock.now;
    const id = f.orch.launchWorkflow("p", waveSpec(1, 1));

    // Wave 1's worker settles at t0…
    await waitFor(() => f.dispatchResolvers.size === 1);
    const wave1Session = f.startedSessions[0]!;
    f.dispatchResolvers.get(wave1Session)!(
      `result body with substance. ${"Detail sentence with facts. ".repeat(8)}`,
    );
    await waitFor(
      () => f.orch.getWorkflowState(id)!.workers[0]!.status === "done",
    );

    // …but its teardown (and so the wave boundary) happens 10 minutes later.
    f.clock.now = t0 + 10 * 60_000;
    f.releaseTeardown();
    await waitFor(() => f.startedSessions.length === 2);

    // The boundary reset the idle clock to the boundary time, NOT the settle.
    const state = f.orch.getWorkflowState(id)!;
    expect(state.lastWorkerProgressAt).toBe(t0 + 10 * 60_000);

    // 46 min past the SETTLE (t0) — the pre-reset clock would have stalled
    // here; the reset clock is only 36 min idle, so the lone wave-2 step
    // survives.
    f.clock.now = t0 + 46 * 60_000;
    await f.orch.sweepWorkflows(f.clock.now);
    expect(f.orch.getWorkflowState(id)!.stallAborted).not.toBe(true);
    expect(f.orch.getWorkflowState(id)!.workers[1]!.status).toBe("running");

    // 46 min past the BOUNDARY — now it is genuinely idle-stalled.
    f.clock.now = t0 + 56 * 60_000;
    await f.orch.sweepWorkflows(f.clock.now);
    expect(f.orch.getWorkflowState(id)!.stallAborted).toBe(true);
    await f.orch.drainForTest();
  });

  it("caps a settled wave's result/prompt strings in heap at the wave boundary", async () => {
    const longPrompt = `long prompt ${"p".repeat(20_000)}`;
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", {
      waves: [
        [{ stepId: "big", prompt: longPrompt }],
        [{ stepId: "later", prompt: "small follow-up" }],
      ],
    });

    await waitFor(() => f.dispatchResolvers.size === 1);
    const bigText = `finding. ${"Substantive detail sentence. ".repeat(700)}`;
    expect(bigText.length).toBeGreaterThan(RESULT_HEAP_CAP);
    f.dispatchResolvers.get(f.startedSessions[0]!)!(bigText);

    // Wave 2 running ⇒ wave 1's boundary release has fired.
    await waitFor(() => f.startedSessions.length === 2);
    const wave1Worker = f.orch.getWorkflowState(id)!.workers[0]!;
    expect(wave1Worker.result!.length).toBe(RESULT_HEAP_CAP);
    // Prompts have no disk copy — the cut is permanent, so it is MARKED.
    expect(wave1Worker.prompt.length).toBe(
      RESULT_HEAP_CAP + PROMPT_TRUNCATION_MARKER.length,
    );
    expect(wave1Worker.prompt.endsWith(PROMPT_TRUNCATION_MARKER)).toBe(true);
    // The FULL text reached disk before the cap.
    const persisted = f.persistedArtifacts.find((a) =>
      a.relativePath.includes("big"),
    )!;
    expect(persisted.content.length).toBe(bigText.length);

    f.dispatchResolvers.get(f.startedSessions[1]!)!(
      `wave-2 result. ${"More detail. ".repeat(20)}`,
    );
    await f.orch.drainForTest();
    expect(f.orch.getWorkflowState(id)!.status).toBe("done");
  });

  it("re-hydrates FULL results from disk for finalize delivery (inline mode)", async () => {
    const marker = "TAIL_MARKER_PAST_THE_HEAP_CAP";
    const bigText =
      `finding. ${"Substantive detail sentence. ".repeat(700)}${marker}`;
    const f = makeFixture("p", {
      outputMode: "inline",
      withArtifactReader: true,
      dispatchResultText: bigText,
    });
    f.orch.launchWorkflow("p", waveSpec(1, 1));
    await f.orch.drainForTest();

    const allPosts = f.posts.map((p) => p.text).join("");
    expect(allPosts).toContain(marker);
  });

  it("falls back to the capped in-heap result when no artifact reader is wired", async () => {
    const marker = "TAIL_MARKER_PAST_THE_HEAP_CAP";
    const bigText =
      `finding. ${"Substantive detail sentence. ".repeat(700)}${marker}`;
    const f = makeFixture("p", {
      outputMode: "inline",
      dispatchResultText: bigText,
    });
    f.orch.launchWorkflow("p", waveSpec(1, 1));
    await f.orch.drainForTest();

    const allPosts = f.posts.map((p) => p.text).join("");
    expect(allPosts).not.toContain(marker);
  });

  it("drains remaining waves as skip records when stall recovery fires in an earlier wave", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", waveSpec(1, 1));
    await waitFor(() => f.startedSessions.length === 1);

    // Wave 1 never settles; the sweep stall-aborts it.
    f.clock.now += WORKFLOW_STALL_MS;
    await f.orch.sweepWorkflows(f.clock.now);
    await f.orch.drainForTest();

    const state = f.orch.getWorkflowState(id)!;
    expect(state.stallAborted).toBe(true);
    // Wave 2 was never spawned…
    expect(f.startedSessions.length).toBe(1);
    // …but its step is surfaced as a terminal skip record, not dropped.
    const skipped = state.workers.find((w) => w.stepId === "w1s0")!;
    expect(skipped.status).toBe("failed");
    expect(skipped.error).toMatch(/stall recovery fired in an earlier wave/);
  });

  it("namespaces artifact filenames GLOBALLY across waves (no cross-wave collisions)", async () => {
    const f = makeFixture("p");
    f.orch.launchWorkflow("p", waveSpec(2, 1));
    await f.orch.drainForTest();

    const paths = f.persistedArtifacts.map((a) => a.relativePath).sort();
    expect(paths).toEqual([
      "00-w0s0.md",
      "01-w0s1.md",
      "02-w1s0.md",
      "summary.json",
    ]);
  });
});

describe("WorkflowOrchestrator — W-2 review fixes (999.106)", () => {
  /** Resolve every pending worker turn, wave after wave, until the workflow
   *  goes terminal (each wave registers NEW resolvers only after the prior
   *  wave's barrier — a fixed number of resolution passes cannot work). */
  async function resolveAllWaves(f: Fixture, id: string): Promise<void> {
    const resolved = new Set<string>();
    for (let round = 0; round < 12; round++) {
      await waitFor(
        () =>
          [...f.dispatchResolvers.keys()].some((k) => !resolved.has(k)) ||
          f.orch.getWorkflowState(id)?.status === "done",
      );
      for (const [session, resolve] of f.dispatchResolvers) {
        if (resolved.has(session)) continue;
        resolved.add(session);
        resolve(`done. ${"Detail sentence with facts. ".repeat(8)}`);
      }
      if (f.orch.getWorkflowState(id)?.status === "done") break;
    }
    await f.orch.drainForTest();
  }
  it("wave-2+ workers receive earlier steps' result-file paths as dispatch context", async () => {
    const f = makeFixture("p");
    const id = f.orch.launchWorkflow("p", waveSpec(1, 1));
    await f.orch.drainForTest();

    // Wave 1's turn input carries NO preamble; wave 2's carries the concrete
    // artifact path of wave 1's settled result.
    expect(f.dispatchedTurns[0]!.message).not.toContain("[workflow context]");
    const wave2Message = f.dispatchedTurns[1]!.message;
    expect(wave2Message).toContain("[workflow context]");
    expect(wave2Message).toContain(`workflows/${id}/00-w0s0.md`);
    // The stored instruction stays CLEAN (report provenance).
    const wave2Worker = f.orch.getWorkflowState(id)!.workers[1]!;
    expect(wave2Worker.prompt).not.toContain("[workflow context]");
  });

  it("skips queued steps of the CURRENT wave immediately once the wall clock elapses", async () => {
    const f = makeFixture("p", {
      dispatchPending: true,
      maxConcurrentWorkers: 1,
    });
    const id = f.orch.launchWorkflow("p", spec(2));
    await waitFor(() => f.startedSessions.length === 1);

    // The ceiling passes while step 1 is still running; step 2 is queued.
    f.clock.now += WORKFLOW_WALL_CLOCK_MS;
    f.dispatchResolvers.get(f.startedSessions[0]!)!(
      `late result. ${"Detail sentence with facts. ".repeat(8)}`,
    );
    await f.orch.drainForTest();

    // Step 2 was never spawned (no gate.acquire round-trip) and is surfaced
    // as a wall-clock skip record.
    expect(f.startedSessions.length).toBe(1);
    const skipped = f.orch
      .getWorkflowState(id)!
      .workers.find((w) => w.stepId === "s1")!;
    expect(skipped.status).toBe("failed");
    expect(skipped.error).toMatch(/wall clock elapsed before this step started/);
  });

  it("counts a successful spawn as forward progress (admission wait is not idle time)", async () => {
    const f = makeFixture("p", {
      dispatchPending: true,
      maxConcurrentWorkers: 1,
      admissionTimeoutMs: 3_600_000,
    });
    // Workflow A holds the single fleet slot…
    f.orch.launchWorkflow("p", spec(1));
    await waitFor(() => f.startedSessions.length === 1);
    // …while workflow B's only step waits in the admission FIFO.
    const idB = f.orch.launchWorkflow("p", spec(1));
    const bCreatedAt = f.clock.now;

    // 40 min of slot contention pass (under the 60-min admission timeout,
    // but only 5 min short of the 45-min stall bound).
    f.clock.now += 40 * 60_000;
    f.dispatchResolvers.get(f.startedSessions[0]!)!(
      `A result. ${"Detail sentence with facts. ".repeat(8)}`,
    );
    await waitFor(() => f.startedSessions.length === 2);

    // B's spawn reset its idle clock: the 40-min FIFO wait does not count.
    const stateB = f.orch.getWorkflowState(idB)!;
    expect(stateB.lastWorkerProgressAt).toBe(f.clock.now);

    // 6 more minutes (46 min past B's launch — past the stall bound measured
    // from launch, but only 6 min since its worker started): NOT stalled.
    f.clock.now += 6 * 60_000;
    await f.orch.sweepWorkflows(f.clock.now);
    expect(f.orch.getWorkflowState(idB)!.stallAborted).not.toBe(true);
    expect(f.clock.now - bCreatedAt).toBeGreaterThan(WORKFLOW_STALL_MS);

    f.dispatchResolvers.get(f.startedSessions[1]!)!(
      `B result. ${"Detail sentence with facts. ".repeat(8)}`,
    );
    await f.orch.drainForTest();
  });

  it("progress pings denominate against the PLANNED total with the wave position", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", waveSpec(2, 1, 1));
    await waitFor(() => f.startedSessions.length === 2);

    f.clock.now += WORKFLOW_PROGRESS_INTERVAL_MS;
    await f.orch.sweepWorkflows(f.clock.now);
    const ping = f.posts.find((p) => p.text.startsWith("Workflow"))!;
    expect(ping.text).toContain("0/4 step(s) done");
    // 999.165 — same facts, new ping layout (header · wave · ETA).
    expect(ping.text).toContain("· wave 1/3 ·");

    await resolveAllWaves(f, id);
  });

  it("listWorkflows reports plannedSteps + wave position for multi-wave runs", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", waveSpec(2, 1, 1));
    await waitFor(() => f.startedSessions.length === 2);

    const [summary] = f.orch.listWorkflows();
    expect(summary!.plannedSteps).toBe(4);
    expect(summary!.waves).toEqual({ current: 1, total: 3 });
    expect(summary!.workers.total).toBe(2);

    await resolveAllWaves(f, id);
  });
});

describe("WorkflowOrchestrator — stall sweep defers while admission is memory-blocked (999.106 G-2)", () => {
  it("does NOT stall-abort healthy running workers while a sibling's head is memory-blocked", async () => {
    const memoryPercentRef = { value: 40 as number | null };
    const f = makeFixture("p", {
      dispatchPending: true,
      maxConcurrentWorkers: 1,
      admissionTimeoutMs: 3_600_000,
      memoryPercentRef,
    });
    // Workflow A's worker holds the single slot and runs (pending turn)…
    const id = f.orch.launchWorkflow("p", spec(1));
    await waitFor(() => f.startedSessions.length === 1);

    // …then pressure arrives, and workflow B's step queues behind a
    // memory-blocked head that keeps stamping the gate's lastMemoryBlockAt.
    memoryPercentRef.value = 99;
    const idB = f.orch.launchWorkflow("p", spec(1));
    // Give B's head a few real poll cycles to observe the block.
    await new Promise((r) => setTimeout(r, 30));

    // 46 min with zero settles and one RUNNING worker — pre-fix this fired
    // stallAborted and killed the healthy worker.
    f.clock.now += WORKFLOW_STALL_MS + 60_000;
    await f.orch.sweepWorkflows(f.clock.now);
    const state = f.orch.getWorkflowState(id)!;
    expect(state.stallAborted).not.toBe(true);
    expect(state.workers[0]!.status).toBe("running");

    // Pressure clears → A settles, B admits and settles; both complete.
    memoryPercentRef.value = 40;
    f.dispatchResolvers.get(f.startedSessions[0]!)!(
      `A result. ${"Detail sentence with facts. ".repeat(8)}`,
    );
    await waitFor(() => f.startedSessions.length === 2);
    f.dispatchResolvers.get(f.startedSessions[1]!)!(
      `B result. ${"Detail sentence with facts. ".repeat(8)}`,
    );
    await f.orch.drainForTest();
    expect(f.orch.getWorkflowState(id)!.status).toBe("done");
    expect(f.orch.getWorkflowState(idB)!.status).toBe("done");
  });
});

describe("WorkflowOrchestrator.isLiveWorkerSession (999.109 sweep exemption)", () => {
  it("claims a worker while its step is running, releases it once settled", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", spec(1));
    await waitFor(() => f.startedSessions.length === 1);
    const session = f.startedSessions[0]!;

    // Mid-flight: the orchestrator owns this session → exempt from the sweep.
    expect(f.orch.isLiveWorkerSession(session)).toBe(true);
    // A session it never spawned is never claimed.
    expect(f.orch.isLiveWorkerSession("fin-client-sub-foreign")).toBe(
      false,
    );

    f.dispatchResolvers.get(session)!(
      `result. ${"Detail sentence with facts. ".repeat(8)}`,
    );
    await f.orch.drainForTest();

    // Settled + workflow terminal → jurisdiction returns to the sweep.
    expect(f.orch.getWorkflowState(id)!.status).toBe("done");
    expect(f.orch.isLiveWorkerSession(session)).toBe(false);
  });

  it("does not claim workers of a terminal workflow still held in the map", async () => {
    const f = makeFixture("p");
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    for (const s of f.startedSessions) {
      expect(f.orch.isLiveWorkerSession(s)).toBe(false);
    }
  });
});

describe("WorkflowOrchestrator — heartbeat gate registration (999.109 review)", () => {
  it("registers each worker's config so heartbeat.enabled:false is LOAD-BEARING", async () => {
    const registered: ResolvedAgentConfig[] = [];
    const f = makeFixture("p", { registerHeartbeatConfig: (c) => registered.push(c) });
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();

    // One registration per spawned worker (2 steps + the report step).
    expect(registered.length).toBeGreaterThanOrEqual(2);
    // Every registration carries the disabling flag the runner gate reads —
    // without the registration the runner's lookup is undefined, the `&&`
    // short-circuits, and the whole check loop (inbox force-release at the
    // SAME 5-min threshold + the parent-inbox drain) runs on the worker.
    for (const cfg of registered) {
      expect(cfg.heartbeat?.enabled).toBe(false);
      expect(f.startedSessions).toContain(cfg.name);
    }
  });

  it("registration happens for every worker that actually started", async () => {
    const registered: string[] = [];
    const f = makeFixture("p", {
      registerHeartbeatConfig: (c) => registered.push(c.name),
    });
    f.orch.launchWorkflow("p", spec(3));
    await f.orch.drainForTest();
    expect([...registered].sort()).toEqual([...f.startedSessions].sort());
  });
});

/**
 * 999.149 — the answer at the end.
 *
 * Fan-in posted a report ABOUT the workflow and the agent the operator was
 * actually talking to never spoke — and never learned the workflow had
 * finished at all. 2026-09-17, #acme-client-acquisition: Client A asked for a
 * financial plan, a workflow ran, a PDF landed that was not the plan, and no
 * agent said a word about it.
 */
describe("WorkflowOrchestrator — parent answer at fan-in (999.149)", () => {
  it("dispatches ONE answer turn into the parent's own session", async () => {
    const f = makeFixture("p", { withParentAnswer: true });
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    expect(f.parentAnswers).toHaveLength(1);
    expect(f.parentAnswers[0]!.agent).toBe("p");
    expect(f.parentAnswers[0]!.workflowId).toMatch(/^wf_/);
  });

  it("asks for the answer, not a restatement of the report", async () => {
    const f = makeFixture("p", { withParentAnswer: true });
    f.orch.launchWorkflow("p", spec(1));
    await f.orch.drainForTest();
    const prompt = f.parentAnswers[0]!.prompt;
    // 999.150 — nothing posts alongside the answer any more, and the prompt
    // has to say so or the agent writes as if the findings were already shown.
    expect(prompt).toMatch(/Nothing has been posted/i);
    expect(prompt).toMatch(/YOUR reply is what the person sees/i);
    // The half that matters for the fin-client case: say so when the output
    // is not what was asked for.
    expect(prompt).toMatch(/do NOT answer it/i);
    expect(prompt).toMatch(/say so plainly/i);
    expect(prompt).toMatch(/do NOT use a tool to post the text itself/i);
  });

  it("carries the report as context so the agent can judge it", async () => {
    const f = makeFixture("p", { withParentAnswer: true });
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    expect(f.parentAnswers[0]!.prompt).toContain("workflow findings");
    expect(f.parentAnswers[0]!.prompt).toContain("s0");
  });

  it("answers INSTEAD of posting the report — the summary is the floor now", async () => {
    const f = makeFixture("p", { withParentAnswer: true });
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    expect(f.parentAnswers).toHaveLength(1);
    // The status post the operator called noise does not land at all.
    expect(f.posts.some((p) => p.text.includes("complete"))).toBe(false);
  });

  it("posts the floor when the answer runs but never lands", async () => {
    const f = makeFixture("p", { parentAnswerNotDelivered: true });
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    expect(f.parentAnswers).toHaveLength(1);
    expect(f.posts.some((p) => p.text.includes("complete"))).toBe(true);
  });

  it("tells the agent to BUILD the deliverable when that is what was asked for", async () => {
    const f = makeFixture("p", { withParentAnswer: true });
    f.orch.launchWorkflow("p", spec(1));
    await f.orch.drainForTest();
    const prompt = f.parentAnswers[0]!.prompt;
    // Deliberately NOT pinned to "financial plan": that phrase came from one
    // incident, and naming it here would nudge side-project/shopping/state-contract
    // toward the wrong artifact on every completion.
    expect(prompt).toMatch(/DELIVERABLE/);
    expect(prompt).toMatch(/clawcode_share_file/);
    expect(prompt).toMatch(/not the deliverable/i);
  });

  it("an empty reply does NOT summon the status wall the agent just replaced", async () => {
    // The agent answered through a tool and returned no prose. Posting the
    // deterministic summary on top would stack noise on a real answer.
    const f = makeFixture("p", { withParentAnswer: true });
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    expect(f.posts.some((p) => p.text.includes("complete"))).toBe(false);
  });

  it("renders NO pdf by default — nobody wanted the research report", async () => {
    const f = makeFixture("p", { withParentAnswer: true, withFileSender: true });
    f.orch.launchWorkflow("p", spec(2));
    await f.orch.drainForTest();
    expect(f.filePosts).toEqual([]);
  });

  it("still posts the report when the answer turn throws", async () => {
    const f = makeFixture("p", { failParentAnswer: true });
    f.orch.launchWorkflow("p", spec(2));
    await expect(f.orch.drainForTest()).resolves.toBeUndefined();
    expect(f.posts.some((p) => p.text.includes("complete"))).toBe(true);
    // The logger fixture captures the payload, not the message string.
    expect(f.loggedWarns.some((w) => JSON.stringify(w).includes("QUEUE_FULL"))).toBe(true);
  });

  it("caps how much report the answer turn is shown", async () => {
    const big = "LONGRESULT ".repeat(2000); // ~22k chars
    const f = makeFixture("p", { withParentAnswer: true, dispatchResultText: big, outputMode: "inline" });
    f.orch.launchWorkflow("p", spec(1));
    await f.orch.drainForTest();
    expect(f.parentAnswers[0]!.prompt.length).toBeLessThan(8_000);
  });
});

// ---------------------------------------------------------------------------
// Phase 999.165 — cancel a whole workflow or one step. The outcome is decided
// by the flag set before the abort, never the abort's error text; a cancelled
// step is never retried; later waves are skipped with the cancel wording.
// ---------------------------------------------------------------------------
describe("999.165 — cancel", () => {
  const twoWaves = (): WorkflowSpec => ({
    waves: [
      [
        { stepId: "a0", prompt: "do step a0" },
        { stepId: "a1", prompt: "do step a1" },
      ],
      [{ stepId: "b0", prompt: "do step b0" }],
    ],
  });

  it("cancelWorkflow stops running steps, skips the later wave, never retries, and says who stopped it", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", twoWaves());
    await waitFor(() => f.dispatchedTurns.length === 2);

    const result = f.orch.cancelWorkflow(id, { by: "projects", reason: "wrong direction" });
    expect(result).toEqual({ status: "cancelled", done: 0, stopped: 2, skipped: 1 });
    await f.orch.drainForTest();

    const state = f.orch.getWorkflowState(id)!;
    // Both running turns were aborted exactly once — no retry dispatch.
    expect(f.dispatchedTurns.filter((t) => t.message === "do step a0")).toHaveLength(1);
    expect(f.dispatchedTurns.filter((t) => t.message === "do step a1")).toHaveLength(1);
    // The second wave never started.
    expect(f.dispatchedTurns.some((t) => t.message === "do step b0")).toBe(false);
    const byStep = new Map(state.workers.map((w) => [w.stepId, w]));
    expect(byStep.get("a0")?.error).toBe("cancelled by projects (wrong direction)");
    expect(byStep.get("b0")?.error).toBe("skipped: workflow cancelled by projects (wrong direction)");
    expect(state.cancelled?.by).toBe("projects");
    // Notice + final summary both name the canceller; no stall wording.
    expect(f.posts.some((p) => p.text.startsWith("🛑 Workflow") && p.text.includes("cancelled by projects"))).toBe(true);
    expect(f.posts.some((p) => p.text.includes("stalled"))).toBe(false);
    // No parent-answer turn for a cancelled workflow.
    expect(f.parentAnswers).toHaveLength(0);
    // The pull view marks it.
    expect(f.orch.listWorkflows()[0]?.cancelled).toEqual({ by: "projects", reason: "wrong direction" });
  });

  it("cancelWorkflow is idempotent and refuses finished or unknown workflows", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", spec(1));
    await waitFor(() => f.dispatchedTurns.length === 1);
    expect(f.orch.cancelWorkflow(id, { by: "a" }).status).toBe("cancelled");
    expect(f.orch.cancelWorkflow(id, { by: "b" })).toEqual({ status: "already-cancelled", by: "a" });
    await f.orch.drainForTest();
    expect(f.orch.cancelWorkflow(id, { by: "a" }).status).toBe("already-finished");
    expect(f.orch.cancelWorkflow("wf_nope", { by: "a" })).toEqual({ status: "not-found" });
  });

  it("cancelStep on a running step aborts only that step; the rest of the workflow finishes", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", spec(2));
    await waitFor(() => f.dispatchedTurns.length === 2);
    const s1Session = f.dispatchedTurns.find((t) => t.message === "do step 1")!.session;

    expect(f.orch.cancelStep(id, "s0", { by: "operator (owner_a)" })).toEqual({ status: "step-stopped", stepId: "s0" });
    f.dispatchResolvers.get(s1Session)!(`result - ${"Detail sentence with facts and figures. ".repeat(8)}`);
    await f.orch.drainForTest();

    const state = f.orch.getWorkflowState(id)!;
    const byStep = new Map(state.workers.map((w) => [w.stepId, w]));
    expect(byStep.get("s0")?.status).toBe("failed");
    expect(byStep.get("s0")?.error).toBe("cancelled by operator (owner_a)");
    expect(byStep.get("s1")?.status).toBe("done");
    expect(f.dispatchedTurns.filter((t) => t.message === "do step 0")).toHaveLength(1);
    expect(state.status).toBe("done");
    expect(state.cancelled).toBeUndefined();
  });

  it("cancelStep on a step that has not started skips it at admission", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", twoWaves());
    await waitFor(() => f.dispatchedTurns.length === 2);

    expect(f.orch.cancelStep(id, "b0", { by: "projects" })).toEqual({ status: "step-will-skip", stepId: "b0" });
    expect(f.orch.cancelStep(id, "zz", { by: "projects" })).toEqual({ status: "step-not-found", stepId: "zz" });
    for (const [, resolve] of f.dispatchResolvers) resolve(`result - ${"Detail sentence with facts and figures. ".repeat(8)}`);
    await f.orch.drainForTest();

    const state = f.orch.getWorkflowState(id)!;
    expect(f.dispatchedTurns.some((t) => t.message === "do step b0")).toBe(false);
    expect(state.workers.find((w) => w.stepId === "b0")?.error).toBe("skipped: step cancelled by projects");
    expect(f.orch.cancelStep(id, "a0", { by: "projects" }).status).toBe("already-finished");
  });

  it("a cancelled step is never retried even when its abort looks like the retryable stall signature", async () => {
    // The real handle's abort error is not a contract; the flag decides.
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", spec(1));
    await waitFor(() => f.dispatchedTurns.length === 1);
    f.orch.cancelStep(id, "s0", { by: "projects" });
    await f.orch.drainForTest();
    expect(f.dispatchedTurns).toHaveLength(1);
    expect(f.orch.getWorkflowState(id)!.workers[0]!.error).toBe("cancelled by projects");
  });
});

// ---------------------------------------------------------------------------
// Phase 999.165 slice 2 — live status: per-step view, activity, ETA, ping.
// ---------------------------------------------------------------------------
describe("999.165 — live status", () => {
  const RESULT = `result - ${"Detail sentence with facts and figures. ".repeat(8)}`;
  const twoWaves = (): WorkflowSpec => ({
    waves: [
      [
        { stepId: "a0", prompt: "do step a0" },
        { stepId: "a1", prompt: "do step a1" },
      ],
      [{ stepId: "b0", prompt: "do step b0" }],
    ],
  });

  it("describeWorkflow lists every planned step by wave, with queued steps that have no worker yet", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", twoWaves());
    await waitFor(() => f.dispatchedTurns.length === 2);
    const d = f.orch.describeWorkflow(id)!;
    expect(d.steps.map((st) => [st.stepId, st.wave, st.status])).toEqual([
      ["a0", 1, "running"],
      ["a1", 1, "running"],
      ["b0", 2, "queued"],
    ]);
    expect(d.currentWave).toBe(1);
    expect(d.totalWaves).toBe(2);
    // No step has finished yet → no guess.
    expect(d.eta).toEqual({ kind: "unknown", reason: "estimating once the first step finishes" });
    // Teardown: resolving wave 1 would start wave 2 behind a pending mock.
    f.orch.cancelWorkflow(id, { by: "test" });
    await f.orch.drainForTest();
  });

  it("records each worker's latest tool call as a secret-safe activity label", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", spec(1));
    await waitFor(() => f.dispatchedTurns.length === 1);
    const onToolUse = f.dispatchToolUses[0]!;
    expect(onToolUse).toBeTypeOf("function");
    onToolUse("WebSearch", { query: "discord components v2 container" });
    onToolUse("Bash", { command: "API_KEY=sk-live-123 curl -H 'Authorization: Bearer x' https://api.example.invalid/v1" });
    const step = f.orch.describeWorkflow(id)!.steps[0]!;
    expect(step.activity?.label).toBe("running curl");
    expect(step.toolCalls).toBe(2);
    expect(JSON.stringify(step)).not.toMatch(/sk-live|Bearer|example\.invalid/);
    for (const [, resolve] of f.dispatchResolvers) resolve(RESULT);
    await f.orch.drainForTest();
  });

  it("once a step finishes, the ETA is estimated from this workflow's own step durations", async () => {
    const f = makeFixture("p", { dispatchPending: true, maxConcurrentWorkers: 100 });
    const id = f.orch.launchWorkflow("p", twoWaves());
    await waitFor(() => f.dispatchedTurns.length === 2);
    const a0 = f.dispatchedTurns.find((t) => t.message === "do step a0")!.session;
    f.clock.now += 10 * 60_000;
    f.dispatchResolvers.get(a0)!(RESULT);
    await waitFor(() => f.orch.describeWorkflow(id)!.steps[0]!.status === "done");
    const d = f.orch.describeWorkflow(id)!;
    expect(d.eta.kind).toBe("estimate");
    if (d.eta.kind === "estimate") {
      expect(d.eta.medianStepMs).toBe(10 * 60_000);
      expect(d.eta.basisSteps).toBe(1);
      // a1 has run 10m of a 10m median → the overrun floor (1m), then wave 2 (10m).
      expect(d.eta.remainingMs).toBe(60_000 + 10 * 60_000);
    }
    f.orch.cancelWorkflow(id, { by: "test" });
    await f.orch.drainForTest();
  });

  it("the progress ping carries the ETA and what each running step is doing", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", spec(2));
    await waitFor(() => f.dispatchedTurns.length === 2);
    f.dispatchToolUses[0]!("Write", { file_path: "/home/clawcode/.clawcode/agents/projects/mockup-d1.html" });
    f.clock.now += WORKFLOW_PROGRESS_INTERVAL_MS;
    await f.orch.sweepWorkflows(f.clock.now);
    const ping = f.posts.find((p) => p.text.startsWith("Workflow"))!.text;
    expect(ping).toContain(`Workflow \`${id}\` — 0/2 step(s) done · ETA: estimating once the first step finishes`);
    expect(ping).toMatch(/• `s\d` — 6m · writing mockup-d1\.html \(6m ago\)/);
    expect(ping).not.toContain("/home/clawcode");
    for (const [, resolve] of f.dispatchResolvers) resolve(RESULT);
    await f.orch.drainForTest();
  });

  it("a step cancelled before it starts shows as cancelled, not queued", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", twoWaves());
    await waitFor(() => f.dispatchedTurns.length === 2);
    f.orch.cancelStep(id, "b0", { by: "projects" });
    const b0 = f.orch.describeWorkflow(id)!.steps.find((st) => st.stepId === "b0")!;
    expect(b0.status).toBe("cancelled");
    expect(b0.note).toBe("will be skipped — cancelled by projects");
    f.orch.cancelWorkflow(id, { by: "test" });
    await f.orch.drainForTest();
  });
});

// ---------------------------------------------------------------------------
// Phase 999.165 slice 3 — steer and edit a running workflow.
// ---------------------------------------------------------------------------
describe("999.165 — steer + edit", () => {
  const RESULT = `result - ${"Detail sentence with facts and figures. ".repeat(8)}`;
  const twoWaves = (): WorkflowSpec => ({
    waves: [
      [
        { stepId: "a0", prompt: "do step a0" },
        { stepId: "a1", prompt: "do step a1" },
      ],
      [{ stepId: "b0", prompt: "do step b0" }],
    ],
  });
  const resolveSession = async (f: ReturnType<typeof makeFixture>, match: (m: string) => boolean) => {
    // A restart goes back through admission — allow it a few more ticks.
    await waitFor(() => f.dispatchedTurns.some((t) => match(t.message) && f.dispatchResolvers.has(t.session)), 3000);
    const turn = [...f.dispatchedTurns].reverse().find((t) => match(t.message))!;
    f.dispatchResolvers.get(turn.session)!(RESULT);
    f.dispatchResolvers.delete(turn.session);
  };

  it("steers a running step INTO its turn when the session accepts injection — no restart", async () => {
    const injected: { session: string; text: string }[] = [];
    const f = makeFixture("p", {
      dispatchPending: true,
      injectMidTurn: (session, text) => {
        injected.push({ session, text });
        return { injected: true };
      },
    });
    const id = f.orch.launchWorkflow("p", spec(1));
    await waitFor(() => f.dispatchedTurns.length === 1);
    const result = f.orch.steerWorkflow(id, { guidance: "focus on the Tesla card only", by: "projects", stepId: "s0" });
    expect(result).toEqual({ status: "steered", injected: ["s0"], restarted: [], amended: [], limited: [] });
    expect(injected[0]!.text).toContain("[Workflow update from projects");
    expect(injected[0]!.text).toContain("focus on the Tesla card only");
    await resolveSession(f, (m) => m === "do step 0");
    await f.orch.drainForTest();
    expect(f.dispatchedTurns).toHaveLength(1);
    expect(f.orch.getWorkflowState(id)!.workers[0]!.status).toBe("done");
    expect(f.posts.some((p) => p.text.startsWith("Workflow") && p.text.includes("mid-step"))).toBe(true);
  });

  it("restarts the step with the guidance appended when injection is declined — and it is not a retry", async () => {
    const f = makeFixture("p", { dispatchPending: true, injectMidTurn: () => ({ injected: false, reason: "idle" }) });
    const id = f.orch.launchWorkflow("p", spec(1));
    await waitFor(() => f.dispatchedTurns.length === 1);
    expect(f.orch.steerWorkflow(id, { guidance: "use the dark theme", by: "projects" })).toEqual({
      status: "steered",
      injected: [],
      restarted: ["s0"],
      amended: [],
      limited: [],
    });
    await resolveSession(f, (m) => m.includes("use the dark theme"));
    await f.orch.drainForTest();
    const state = f.orch.getWorkflowState(id)!;
    expect(f.dispatchedTurns).toHaveLength(2);
    expect(f.dispatchedTurns[1]!.message).toContain("do step 0\n\n[Update from projects — follow this in addition to the instructions above]\nuse the dark theme");
    // One record for the step, and it succeeded.
    expect(state.workers.filter((w) => w.stepId === "s0").map((w) => w.status)).toEqual(["done"]);
  });

  it("caps restarts per step", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", spec(1));
    for (let i = 1; i <= 3; i += 1) {
      await waitFor(() => f.dispatchedTurns.length === i);
      expect(f.orch.steerWorkflow(id, { guidance: `change ${i}`, by: "p" }).status).toBe("steered");
    }
    await waitFor(() => f.dispatchedTurns.length === 4);
    const fourth = f.orch.steerWorkflow(id, { guidance: "change 4", by: "p" });
    expect(fourth).toEqual({ status: "steered", injected: [], restarted: [], amended: [], limited: ["s0"] });
    f.orch.cancelWorkflow(id, { by: "test" });
    await f.orch.drainForTest();
  });

  it("a step that has not started gets the guidance on its prompt when it starts", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", twoWaves());
    await waitFor(() => f.dispatchedTurns.length === 2);
    expect(f.orch.steerWorkflow(id, { guidance: "keep it under 300 words", by: "projects", stepId: "b0" })).toEqual({
      status: "steered",
      injected: [],
      restarted: [],
      amended: ["b0"],
      limited: [],
    });
    await resolveSession(f, (m) => m === "do step a0");
    await resolveSession(f, (m) => m === "do step a1");
    await resolveSession(f, (m) => m.includes("keep it under 300 words"));
    await f.orch.drainForTest();
    expect(f.dispatchedTurns.find((t) => t.message.includes("do step b0"))!.message).toContain("keep it under 300 words");
  });

  it("replace_step rewrites a pending step; a running one needs restart:true", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", twoWaves());
    await waitFor(() => f.dispatchedTurns.length === 2);
    expect(f.orch.editWorkflow(id, { kind: "replace_step", stepId: "b0", prompt: "brand new b0" }, { by: "p" })).toEqual({
      status: "replaced",
      stepId: "b0",
      restarted: false,
    });
    expect(f.orch.editWorkflow(id, { kind: "replace_step", stepId: "a0", prompt: "new a0" }, { by: "p" })).toEqual({
      status: "step-running",
      stepId: "a0",
    });
    expect(f.orch.editWorkflow(id, { kind: "replace_step", stepId: "a0", prompt: "new a0", restart: true }, { by: "p" })).toEqual({
      status: "replaced",
      stepId: "a0",
      restarted: true,
    });
    await resolveSession(f, (m) => m === "new a0");
    await resolveSession(f, (m) => m === "do step a1");
    // Wave 2 carries the wave-context preamble ahead of the step prompt.
    await resolveSession(f, (m) => m.endsWith("brand new b0"));
    await f.orch.drainForTest();
    const messages = f.dispatchedTurns.map((t) => t.message);
    expect(messages.slice(0, 3)).toEqual(["do step a0", "do step a1", "new a0"]);
    expect(messages[3]).toMatch(/\[workflow context\][^]*brand new b0$/);
    expect(messages.some((m) => m.includes("do step b0"))).toBe(false);
  });

  it("add_step joins the running wave while its runners are active, else the next or a new wave", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", twoWaves());
    await waitFor(() => f.dispatchedTurns.length === 2);
    expect(f.orch.editWorkflow(id, { kind: "add_step", stepId: "a2", prompt: "do step a2", wave: "current" }, { by: "p" })).toEqual({
      status: "added",
      stepId: "a2",
      wave: 1,
      live: true,
    });
    expect(f.orch.editWorkflow(id, { kind: "add_step", stepId: "b1", prompt: "do step b1", wave: "next" }, { by: "p" })).toEqual({
      status: "added",
      stepId: "b1",
      wave: 2,
      live: false,
    });
    expect(f.orch.editWorkflow(id, { kind: "add_step", stepId: "c0", prompt: "do step c0", wave: "new" }, { by: "p" })).toEqual({
      status: "added",
      stepId: "c0",
      wave: 3,
      live: false,
    });
    expect(f.orch.editWorkflow(id, { kind: "add_step", stepId: "a0", prompt: "dup", wave: "next" }, { by: "p" })).toEqual({
      status: "invalid",
      reason: "stepId a0 is already used in this workflow",
    });
    const d = f.orch.describeWorkflow(id)!;
    expect(d.steps.map((st) => [st.stepId, st.wave])).toEqual([
      ["a0", 1], ["a1", 1], ["a2", 1], ["b0", 2], ["b1", 2], ["c0", 3],
    ]);
    expect(d.plannedSteps).toBe(6);
    expect(d.totalWaves).toBe(3);
    for (const m of ["do step a0", "do step a1", "do step a2", "do step b0", "do step b1", "do step c0"]) {
      await resolveSession(f, (x) => x.includes(m));
    }
    await f.orch.drainForTest();
    const state = f.orch.getWorkflowState(id)!;
    expect(state.workers.filter((w) => w.status === "done").map((w) => w.stepId).sort()).toEqual(["a0", "a1", "a2", "b0", "b1", "c0"]);
    // Artifact indices stay unique across the added steps.
    const indices = state.workers.map((w) => w.artifactIndex);
    expect(new Set(indices).size).toBe(indices.length);
  });

  it("refuses to steer or edit a cancelled or unknown workflow", async () => {
    const f = makeFixture("p", { dispatchPending: true });
    const id = f.orch.launchWorkflow("p", spec(1));
    await waitFor(() => f.dispatchedTurns.length === 1);
    f.orch.cancelWorkflow(id, { by: "a" });
    expect(f.orch.steerWorkflow(id, { guidance: "x", by: "b" })).toEqual({ status: "already-cancelled", by: "a" });
    expect(f.orch.editWorkflow(id, { kind: "add_step", stepId: "z", prompt: "z", wave: "new" }, { by: "b" })).toEqual({
      status: "already-cancelled",
      by: "a",
    });
    expect(f.orch.steerWorkflow("wf_nope", { guidance: "x", by: "b" })).toEqual({ status: "not-found" });
    await f.orch.drainForTest();
  });
});
