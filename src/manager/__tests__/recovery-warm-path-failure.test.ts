/**
 * Quick task 260521-5gh Gap 1 + Gap 3 — warm-path-failure recovery routing.
 *
 * Pins the fix for the 2026-05-20 fin-client incident: a warm-path
 * check failure used to mark the agent terminally `failed` on the FIRST
 * failure, bypassing SessionRecoveryManager entirely. After this fix a
 * warm-path failure routes through `recovery.handleCrash()` so it gets the
 * same exponential-backoff + N-retry envelope as a session crash.
 *
 * Gap 1 behaviors:
 *   - first warm-path failure → registry `status: "crashed"` + restart scheduled.
 *   - envelope exhaustion (failures >= maxRetries) → registry `status: "failed"`.
 *   - `warm_path_ready: false` + `warm_path_readiness_ms` survive the
 *     handleCrash registry merge.
 *
 * Gap 3 behavior:
 *   - the crash log line carries `stack`, a numeric `uptimeMs`, and
 *     `cause: "warm-path-check"`.
 *
 * Harness mirrors warm-path-mcp-gate.test.ts: real SessionManager + mock
 * adapter, with `runWarmPathCheck` mocked so we control the pass/fail verdict
 * directly without touching real sqlite / embedder / MCP I/O. Real timers
 * throughout — first-crash tests call `_clearAllRecoveryTimers()` right after
 * draining the crash promise so the scheduled restart never re-enters
 * startAgent; the envelope test lets the auto-restart chain run to terminal
 * `failed`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import pino from "pino";
import type { Logger } from "pino";
import { createMockAdapter } from "../session-adapter.js";
import type { MockSessionAdapter } from "../session-adapter.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { BackoffConfig } from "../types.js";
import { readRegistry } from "../registry.js";
import { SessionManager } from "../session-manager.js";

// Control the warm-path verdict directly. Always fails in this suite.
vi.mock("../warm-path-check.js", async () => {
  const actual = await vi.importActual<typeof import("../warm-path-check.js")>(
    "../warm-path-check.js",
  );
  return {
    ...actual,
    runWarmPathCheck: vi.fn(async () =>
      Object.freeze({
        ready: false,
        durations_ms: Object.freeze({
          sqlite: 1,
          embedder: 1,
          session: 1,
          browser: 0,
          mcp: 0,
        }),
        total_ms: 42,
        errors: Object.freeze([
          "sqlite: warm failed",
        ]) as readonly string[],
      }),
    ),
  };
});

// Envelope test — tiny backoff so the auto-restart chain runs to exhaustion
// fast. maxRetries:3 — the first failure writes `crashed` + schedules a
// restart; the envelope is exhausted after 3 consecutive failures.
const FAST_BACKOFF: BackoffConfig = {
  baseMs: 10,
  maxMs: 50,
  maxRetries: 3,
  stableAfterMs: 500,
};

// First-crash tests — large baseMs so the scheduled restart timer is far in
// the future (it never fires within the test window). The first crash still
// writes `crashed` (backoff returns ~60s, not -1, since failures < maxRetries)
// and the test clears the pending restart timer before it can fire.
const SLOW_BACKOFF: BackoffConfig = {
  baseMs: 60_000,
  maxMs: 120_000,
  maxRetries: 3,
  stableAfterMs: 500,
};

function makeConfig(name: string, workspace: string): ResolvedAgentConfig {
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
    sandbox: { enabled: false, allowRuntimeOp: false },
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
    reactions: false,
    mcpServers: [],
    slashCommands: [],
  } as ResolvedAgentConfig;
}

/**
 * Logger whose `error` method we can spy on (Gap 3 assertions). Mirrors the
 * makeSpyLogger helper in session-manager-warmup-timeout.test.ts.
 */
function makeSpyLogger(): {
  log: Logger;
  errorSpy: ReturnType<typeof vi.fn>;
} {
  const base = pino({ level: "silent" });
  const errorSpy = vi.fn();
  const log = {
    warn: vi.fn(),
    info: vi.fn(),
    error: errorSpy,
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
  return { log, errorSpy };
}

// ---------------------------------------------------------------------------
// First-crash assertions — clear the recovery timers immediately after the
// crash promise resolves so the scheduled restart never re-enters startAgent.
// ---------------------------------------------------------------------------
describe("Quick 260521-5gh — warm-path failure routes through recovery (first crash)", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;
  let spyLog: ReturnType<typeof makeSpyLogger>;

  beforeEach(async () => {
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "wp-recovery-test-"));
    registryPath = join(tmpDir, "registry.json");
    spyLog = makeSpyLogger();
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: SLOW_BACKOFF,
      log: spyLog.log,
    });
  });

  afterEach(async () => {
    manager._clearAllRecoveryTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("Gap 1 — first warm-path failure → registry 'crashed' (NOT 'failed'), restart scheduled", async () => {
    await manager.startAgent("agent-a", makeConfig("agent-a", tmpDir));
    // Drain the handleCrash registry write, then immediately halt the
    // scheduled restart so the chain does not churn.
    await manager._lastCrashPromise;
    manager._clearAllRecoveryTimers();

    const registry = await readRegistry(registryPath);
    const entry = registry.entries.find((e) => e.name === "agent-a");
    expect(entry).toBeDefined();
    // The bug: this used to be "failed" on the first failure. The fix routes
    // through handleCrash, which writes "crashed" and schedules a restart.
    expect(entry!.status).toBe("crashed");
    expect(entry!.consecutiveFailures).toBe(1);
    expect(manager.isRunning("agent-a")).toBe(false);
  }, 30_000);

  it("Gap 1 — registry keeps warm_path_ready=false + warm_path_readiness_ms after the recovery write", async () => {
    await manager.startAgent("agent-b", makeConfig("agent-b", tmpDir));
    await manager._lastCrashPromise;
    manager._clearAllRecoveryTimers();

    const registry = await readRegistry(registryPath);
    const entry = registry.entries.find((e) => e.name === "agent-b");
    expect(entry).toBeDefined();
    // updateEntry is a partial merge — the pre-written observability fields
    // survive the later handleCrash registry write.
    expect(entry!.warm_path_ready).toBe(false);
    expect(entry!.warm_path_readiness_ms).toBe(42);
  }, 30_000);

  it("Gap 3 — the crash log line carries stack + numeric uptimeMs + cause='warm-path-check'", async () => {
    await manager.startAgent("agent-d", makeConfig("agent-d", tmpDir));
    await manager._lastCrashPromise;
    manager._clearAllRecoveryTimers();

    const crashCall = spyLog.errorSpy.mock.calls.find(
      ([, msg]) => msg === "agent crashed",
    );
    expect(crashCall).toBeDefined();
    expect(crashCall![0]).toEqual(
      expect.objectContaining({
        agent: "agent-d",
        uptimeMs: expect.any(Number),
        stack: expect.any(String),
        cause: "warm-path-check",
      }),
    );
    // uptime must be a sane non-negative number.
    expect(
      (crashCall![0] as { uptimeMs: number }).uptimeMs,
    ).toBeGreaterThanOrEqual(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Envelope exhaustion — let the auto-restart chain run until the N-retry
// envelope is exhausted → terminal `failed`.
// ---------------------------------------------------------------------------
describe("Quick 260521-5gh — warm-path failure envelope exhaustion", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "wp-recovery-env-"));
    registryPath = join(tmpDir, "registry.json");
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: FAST_BACKOFF,
    });
  });

  afterEach(async () => {
    manager._clearAllRecoveryTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("Gap 1 — after maxRetries consecutive warm-path failures the registry transitions to terminal 'failed'", async () => {
    await manager.startAgent("agent-c", makeConfig("agent-c", tmpDir));

    // Poll the registry until the agent reaches the terminal `failed` status.
    // Each restart re-enters startAgent, fails warm-path again, increments
    // consecutiveFailures; once it hits maxRetries the backoff returns -1 and
    // markFailed writes terminal `failed`. Terminal stays terminal. The first
    // startAgent + each restart re-enter does real memory/embedder warmup
    // (~6s each on a cold worker), so the poll window is generous.
    const deadline = Date.now() + 50_000;
    let entry: { status: string } | undefined;
    while (Date.now() < deadline) {
      const registry = await readRegistry(registryPath);
      entry = registry.entries.find((e) => e.name === "agent-c");
      if (entry?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("failed");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Gap 2 — the onCrashAlert DI hook fires on every crash (terminal:false) and
// on the terminal `failed` transition (terminal:true). A throwing hook must
// never destabilize recovery.
// ---------------------------------------------------------------------------
describe("Quick 260521-5gh — onCrashAlert DI hook (Gap 2)", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager | undefined;

  beforeEach(async () => {
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "wp-recovery-hook-"));
    registryPath = join(tmpDir, "registry.json");
    manager = undefined;
  });

  afterEach(async () => {
    manager?._clearAllRecoveryTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("fires the hook with terminal:false + the right attempt on a warm-path crash", async () => {
    const hookCalls: Array<{
      agent: string;
      errorSummary: string;
      attempt: number;
      terminal: boolean;
    }> = [];
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: SLOW_BACKOFF,
      onCrashAlert: (p) => hookCalls.push({ ...p }),
    });

    await manager.startAgent("agent-h", makeConfig("agent-h", tmpDir));
    await manager._lastCrashPromise;
    manager._clearAllRecoveryTimers();

    const nonTerminal = hookCalls.filter((c) => !c.terminal);
    expect(nonTerminal).toHaveLength(1);
    expect(nonTerminal[0]).toEqual(
      expect.objectContaining({
        agent: "agent-h",
        attempt: 1,
        terminal: false,
      }),
    );
    // errorSummary carries the warm-path error.message.
    expect(nonTerminal[0].errorSummary).toContain("warm-path");
  }, 30_000);

  it("fires the hook with terminal:true on the terminal 'failed' transition", async () => {
    const hookCalls: Array<{ terminal: boolean; agent: string }> = [];
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: FAST_BACKOFF,
      onCrashAlert: (p) => hookCalls.push({ terminal: p.terminal, agent: p.agent }),
    });

    await manager.startAgent("agent-i", makeConfig("agent-i", tmpDir));

    // Wait for the envelope to exhaust → markFailed → terminal hook.
    const deadline = Date.now() + 50_000;
    while (Date.now() < deadline) {
      if (hookCalls.some((c) => c.terminal)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(hookCalls.some((c) => c.terminal && c.agent === "agent-i")).toBe(
      true,
    );
  }, 60_000);

  it("a throwing onCrashAlert hook does NOT prevent the crash from being recorded", async () => {
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: SLOW_BACKOFF,
      onCrashAlert: () => {
        throw new Error("hook boom");
      },
    });

    // The throwing hook must be swallowed — startAgent still completes and
    // the crash still routes through recovery (registry written `crashed`).
    await manager.startAgent("agent-j", makeConfig("agent-j", tmpDir));
    await manager._lastCrashPromise;
    manager._clearAllRecoveryTimers();

    const registry = await readRegistry(registryPath);
    const entry = registry.entries.find((e) => e.name === "agent-j");
    expect(entry).toBeDefined();
    // Recovery completed normally despite the throwing hook.
    expect(entry!.status).toBe("crashed");
    expect(entry!.consecutiveFailures).toBe(1);
  }, 30_000);
});
