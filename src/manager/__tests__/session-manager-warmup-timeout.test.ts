import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import pino from "pino";
import type { Logger } from "pino";
import { createMockAdapter } from "../session-adapter.js";
import type { MockSessionAdapter } from "../session-adapter.js";
import { SessionManager } from "../session-manager.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { BackoffConfig } from "../types.js";

/**
 * Phase 106 STALL-02 — RED tests for warmup-timeout sentinel.
 *
 * Bug surfaced 2026-04-30 22:09 PT (post-999.12 deploy): research and
 * fin-research agents stalled silently AFTER memory-scanner-watching but
 * BEFORE warm-path. No "warm-path ready" log, no error, no crash report.
 * The most likely culprit per Phase 106 RESEARCH.md is `adapter.createSession`
 * blocking indefinitely on Claude Agent SDK MCP cold-start (one of the 5-9
 * configured MCP servers — playwright/browserless/fal-ai — hung during
 * JSON-RPC `initialize` handshake).
 *
 * The `WARM_PATH_TIMEOUT_MS` budget only covers the warm-path probe itself
 * (line 895 in session-manager.ts). The window between memory-scanner
 * (line ~508 via daemon wiring) and runWarmPathCheck (line 895) — which
 * includes `buildSessionConfig` (725), `adapter.createSession` (754), and
 * polled MCP-discovery (780) — has NO outer timeout.
 *
 * Fix lands in Wave 1: a single `setTimeout` armed at the top of
 * `startAgent`, cleared on either reaching warm-path-ready or any fail
 * path. On fire (60s elapsed without clear), emit a structured pino-warn
 * log at level 50 with `agent`, `elapsedMs`, `lastStep`,
 * `mcpServersConfigured/Loaded/Pending`, message
 * "agent warmup-timeout — boot stalled, no warm-path-ready".
 *
 * These RED tests pin:
 *   - STALL-02 (Test 1): warn fires at 60s when adapter.createSession hangs
 *   - STALL-02 (Test 2): warn does NOT fire when warm-path completes <60s
 *   - STALL-02 (Test 3): lastStep === "adapter-create-session" when
 *     adapter.createSession is the hang site
 */

const TEST_BACKOFF: BackoffConfig = {
  baseMs: 100,
  maxMs: 1000,
  maxRetries: 3,
  stableAfterMs: 500,
};

const WARMUP_TIMEOUT_MSG =
  "agent warmup-timeout — boot stalled, no warm-path-ready";

function makeConfig(
  name: string,
  workspace: string,
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    name,
    workspace,
    memoryPath: workspace,
    channels: ["#general"],
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
    autoStart: true,
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
      contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
    },
    skillsPath: "/tmp/skills",
    admin: false,
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
    reactions: false,
    mcpServers: [
      { name: "brave-search", command: "true", args: [] },
      { name: "playwright", command: "true", args: [] },
    ],
    slashCommands: [],
    ...overrides,
  } as ResolvedAgentConfig;
}

/**
 * Build a logger whose `warn` method we can spy on. Pino loggers have
 * non-enumerable methods bound to internal state, so we wrap a base logger
 * and proxy through with a vi.fn() for `warn`. `info` / `error` / `debug`
 * are no-ops to keep test output clean.
 */
function makeSpyLogger(): {
  log: Logger;
  warnSpy: ReturnType<typeof vi.fn>;
} {
  const base = pino({ level: "silent" });
  const warnSpy = vi.fn();
  // Construct a logger-shaped object that satisfies the Logger interface.
  // SessionManager calls .warn(fields, msg), .info(fields, msg), .error,
  // .debug, .child. We provide all of them.
  const log = {
    warn: warnSpy,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: "silent",
    child: () => log,
    bindings: () => ({}),
    flush: () => {},
    isLevelEnabled: () => false,
    levelVal: 0,
    levels: base.levels,
  } as unknown as Logger;
  return { log, warnSpy };
}

describe("Phase 106 STALL-02 — startAgent warmup-timeout sentinel", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;
  let spyLog: ReturnType<typeof makeSpyLogger>;

  beforeEach(async () => {
    vi.useFakeTimers();
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "stall02-test-"));
    registryPath = join(tmpDir, "registry.json");
    spyLog = makeSpyLogger();
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
      log: spyLog.log,
    });
  });

  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {
      /* cleanup */
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    // Quick task 260521-xas — the happy-path STALL-02 test drives a full
    // agent startup whose async file writes (registry.json, memory db)
    // into `tmpDir` can still be settling when we tear down — `stopAll`
    // is fire-and-forget for some of that I/O under fake timers. A plain
    // `rm` then races the trailing write: it reads the dir empty, a file
    // lands, and `rmdir` fails with ENOTEMPTY. Retry the recursive
    // removal a few times so a late write is swept on the next pass.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "ENOTEMPTY" && code !== "EBUSY") throw err;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  });

  it("STALL-02: warmup-timeout fires at 60s when adapter.createSession never resolves", async () => {
    // Override createSession to return a never-resolving promise — simulates
    // SDK MCP cold-start hang (the 22:09 incident's most likely root cause).
    adapter.createSession = () => new Promise(() => {
      /* never resolves */
    });

    const config = makeConfig("research", tmpDir);
    // Don't await — startAgent will suspend forever at adapter.createSession.
    const startPromise = manager.startAgent("research", config);

    // Drain microtasks so init/registry/build-session-config steps run
    // through to the adapter.createSession await point.
    await vi.advanceTimersByTimeAsync(0);

    // Advance past the 60s sentinel threshold.
    await vi.advanceTimersByTimeAsync(60_001);

    // RED today: no sentinel exists → warn was NEVER called with the
    // warmup-timeout message. GREEN after Wave 1: warn fires once with the
    // structured payload below.
    expect(spyLog.warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "research",
        elapsedMs: 60_000,
        lastStep: expect.any(String),
        mcpServersConfigured: expect.arrayContaining([
          "brave-search",
          "playwright",
        ]),
      }),
      WARMUP_TIMEOUT_MSG,
    );

    // Prevent unhandled-rejection noise from the still-pending startAgent.
    void startPromise.catch(() => {});
  });

  it("STALL-02: sentinel cleared on warm-path-ready (no warmup-timeout warn fires after 60s if startup completed)", async () => {
    // Default mock adapter resolves createSession immediately. The agent
    // should reach warm-path-ready well before 60s. Drive the full startup.
    const config = makeConfig("happy-agent", tmpDir, {
      // Empty mcpServers → warm-path skips the readiness probe entirely.
      mcpServers: [],
    });

    await vi.runAllTimersAsync(); // settle any nested timers
    await manager.startAgent("happy-agent", config);

    // Advance well past 60s — the sentinel must have been cleared on the
    // warm-path-ready path. NO warmup-timeout warn should be observed.
    await vi.advanceTimersByTimeAsync(60_001);

    // Filter warn calls for the warmup-timeout message specifically (other
    // non-fatal warns are allowed during a happy-path startup).
    const warmupWarns = spyLog.warnSpy.mock.calls.filter(
      ([, msg]) => msg === WARMUP_TIMEOUT_MSG,
    );
    expect(warmupWarns).toHaveLength(0);
    // Quick task 260521-xas — the happy-path startup drives the full
    // memory/embedder warmup; under suite-wide load the real async
    // settling can brush the 5000ms vitest default. Generous per-test
    // timeout so a slow worker does not flake this assertion.
  }, 30_000);

  it("STALL-02: lastStep reports `adapter-create-session` when the hang is at adapter.createSession", async () => {
    // Same setup as Test 1 — hang at adapter.createSession — but assert the
    // lastStep marker pinpoints which subsystem hung. Operators grep
    // `journalctl ... | grep warmup-timeout | jq .lastStep` to identify the
    // culprit subsystem within seconds.
    adapter.createSession = () => new Promise(() => {
      /* never resolves */
    });

    const config = makeConfig("research", tmpDir);
    const startPromise = manager.startAgent("research", config);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_001);

    expect(spyLog.warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        lastStep: "adapter-create-session",
      }),
      WARMUP_TIMEOUT_MSG,
    );

    void startPromise.catch(() => {});
  });
});
