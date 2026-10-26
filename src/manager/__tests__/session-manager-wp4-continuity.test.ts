/**
 * Memory overhaul 2026-10-25 (WP4): SessionManager wiring for capture and
 * continuity.
 *
 *   - reconcileRegistry's resume path starts the MEM-04 disk flush timer, as
 *     startAgentCore does.
 *   - armMemoryScanner: start and resume re-arm the scanner (runs the
 *     deferred backfill), and a scanner that stopAgent dropped is recreated
 *     through the daemon's factory on the next start.
 *   - stopAgent copies the final session summary into context-summary.md
 *     with a Generated: <ISO> line.
 *
 * The embedder is stubbed (no MiniLM load) and the warm-path probe is mocked
 * ready, so this suite does not need the model warmup the main
 * session-manager suite does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createMockAdapter } from "../session-adapter.js";
import type { MockSessionAdapter } from "../session-adapter.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { BackoffConfig, Registry } from "../types.js";
import { writeRegistry } from "../registry.js";
import { SessionManager } from "../session-manager.js";
import { EmbeddingService } from "../../memory/embedder.js";
import { loadLatestSummary } from "../../memory/context-summary.js";

vi.mock("../warm-path-check.js", async () => {
  const actual = await vi.importActual<typeof import("../warm-path-check.js")>(
    "../warm-path-check.js",
  );
  return {
    ...actual,
    runWarmPathCheck: vi.fn(async () =>
      Object.freeze({
        ready: true,
        durations_ms: Object.freeze({ sqlite: 1, embedder: 1, session: 1, browser: 0 }),
        total_ms: 3,
        errors: Object.freeze([]),
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

function makeConfig(name: string, dir: string): ResolvedAgentConfig {
  return {
    name,
    workspace: dir,
    memoryPath: dir,
    channels: ["#general"],
    model: "sonnet",
    effort: "low",
    allowedModels: ["haiku", "sonnet", "opus"],
    greetOnRestart: false,
    greetCoolDownMs: 300_000,
    autoCompactAt: 0.7,
    memoryAutoLoad: true,
    memoryRetrievalTopK: 5,
    memoryScannerEnabled: true,
    memoryFlushIntervalMs: 60 * 60 * 1000, // never fires during a test
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
      consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" },
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
  } as unknown as ResolvedAgentConfig;
}

type ScannerStub = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  backfill: ReturnType<typeof vi.fn>;
};

function makeScannerStub(): ScannerStub {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    backfill: vi.fn(async () => ({ indexed: 0, chunks: 0, skipped: 0 })),
  };
}

function runningRegistry(name: string): Registry {
  return {
    entries: [
      {
        name,
        status: "running",
        sessionId: `prior-session-${name}`,
        startedAt: Date.now() - 60_000,
        restartCount: 0,
        consecutiveFailures: 0,
        lastError: null,
        lastStableAt: null,
      },
    ],
    updatedAt: Date.now(),
  } as Registry;
}

const flushTimers = (m: SessionManager): ReadonlyMap<string, unknown> =>
  (m as unknown as { _memoryFileFlushTimers: ReadonlyMap<string, unknown> })
    ._memoryFileFlushTimers;

describe("SessionManager WP4 continuity wiring", () => {
  let adapter: MockSessionAdapter;
  let tmpDir: string;
  let registryPath: string;
  let manager: SessionManager;
  let summarizeFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useRealTimers();
    vi.spyOn(EmbeddingService.prototype, "embed").mockResolvedValue(
      new Float32Array(384).fill(0.1),
    );
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "sm-wp4-"));
    registryPath = join(tmpDir, "registry.json");
    summarizeFn = vi.fn(async () =>
      "## User Preferences\n(none)\n\n## Decisions\n- WP4-FINAL-SUMMARY staging shares the prod db\n\n## Open Threads\n(none)\n\n## Commitments\n(none)\n",
    );
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
      summarizeFn: summarizeFn as never,
    });
  });

  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {
      /* cleanup */
    }
    vi.restoreAllMocks();
    await new Promise((r) => setTimeout(r, 50));
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reconcileRegistry resume path starts the memory-file flush timer", async () => {
    const config = makeConfig("resume-flush", tmpDir);
    await writeRegistry(registryPath, runningRegistry("resume-flush"));

    await manager.reconcileRegistry([config]);

    expect(manager.getRunningAgents()).toContain("resume-flush");
    expect(flushTimers(manager).has("resume-flush")).toBe(true);
    // And the stop path's final flush now has a timer to drain.
    await manager.stopAgent("resume-flush");
    expect(flushTimers(manager).has("resume-flush")).toBe(false);
  }, 30_000);

  it("reconcileRegistry resume path re-arms the boot scanner (deferred backfill)", async () => {
    const config = makeConfig("resume-scan", tmpDir);
    await writeRegistry(registryPath, runningRegistry("resume-scan"));
    const stub = makeScannerStub();
    manager.setMemoryScanner("resume-scan", stub as never);

    await manager.reconcileRegistry([config]);

    expect(stub.start).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("startAgent re-arms an existing scanner once the store exists", async () => {
    const config = makeConfig("start-scan", tmpDir);
    const stub = makeScannerStub();
    manager.setMemoryScanner("start-scan", stub as never);

    await manager.startAgent("start-scan", config);

    expect(stub.start).toHaveBeenCalledTimes(1);
    expect(manager.getMemoryStore("start-scan")).toBeDefined();
  }, 30_000);

  it("a scanner dropped by stopAgent is recreated through the factory on restart", async () => {
    const config = makeConfig("restart-scan", tmpDir);
    const bootStub = makeScannerStub();
    const recreated = makeScannerStub();
    const factory = vi.fn((name: string) => (name === "restart-scan" ? (recreated as never) : null));
    manager.setMemoryScanner("restart-scan", bootStub as never);
    manager.setMemoryScannerFactory(factory);

    await manager.startAgent("restart-scan", config);
    expect(factory).not.toHaveBeenCalled(); // boot scanner still present

    await manager.restartAgent("restart-scan", config);

    expect(bootStub.stop).toHaveBeenCalled();
    expect(factory).toHaveBeenCalledWith("restart-scan");
    expect(manager._memoryScanners.get("restart-scan")).toBe(recreated);
    expect(recreated.start).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("a factory that returns null leaves the agent without a scanner", async () => {
    const config = makeConfig("no-scan", tmpDir);
    const factory = vi.fn(() => null);
    manager.setMemoryScannerFactory(factory);

    await manager.startAgent("no-scan", config);

    expect(factory).toHaveBeenCalledWith("no-scan");
    expect(manager._memoryScanners.has("no-scan")).toBe(false);
  }, 30_000);

  it("stopAgent writes the final session summary to context-summary.md with a Generated line", async () => {
    const config = makeConfig("stop-ctx", tmpDir);
    await manager.startAgent("stop-ctx", config);
    const convStore = manager.getConversationStore("stop-ctx")!;
    const convSessionId = manager.getActiveConversationSessionId("stop-ctx")!;
    for (let i = 0; i < 4; i++) {
      convStore.recordTurn({
        sessionId: convSessionId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i} about the staging database`,
      });
    }

    const before = Date.now();
    await manager.stopAgent("stop-ctx");

    expect(summarizeFn).toHaveBeenCalled();
    const body = await loadLatestSummary(join(tmpDir, "memory"));
    expect(body).toBeDefined();
    const firstLine = body!.split("\n")[0]!;
    expect(firstLine).toMatch(/^Generated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(firstLine.slice("Generated: ".length))).toBeGreaterThanOrEqual(
      before - 1_000,
    );
    expect(body).toContain("WP4-FINAL-SUMMARY");
  }, 30_000);

  it("stopAgent with no conversation leaves no context summary behind", async () => {
    const config = makeConfig("stop-empty", tmpDir);
    await manager.startAgent("stop-empty", config);
    await manager.stopAgent("stop-empty");
    expect(await loadLatestSummary(join(tmpDir, "memory"))).toBeUndefined();
  }, 30_000);
});
