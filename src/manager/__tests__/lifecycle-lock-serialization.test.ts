/**
 * Regression: per-agent lifecycle serialization — the "db not open" restart race.
 *
 * Incident (2026-06-02, fleet-wide): a crashed/wedged agent could not be
 * recovered by the daemon auto-restart OR a manual /clawcode-restart — both
 * failed with "The database connection is not open", needing a full systemctl
 * restart. Root cause: start/stop/restart/performRestart for ONE agent were
 * unsynchronized async methods sharing the same memory-store maps + one
 * better-sqlite3 connection (closed by stopAgent->cleanupMemory). A reload/
 * manual restartAgent (its stopAgent closing the store) could run concurrently
 * with a crash-timer performRestart (its startAgent reading the store), so the
 * in-flight start resumed onto a CLOSED connection.
 *
 * Fix: withLifecycleLock serializes all four ops per agent. These tests prove:
 *   1. start + stop for the SAME agent never overlap (no read-after-close).
 *   2. WITHOUT the lock (cores invoked directly) they DO overlap + read after
 *      close — i.e. the test reproduces the logged failure and the lock fixes it.
 *   3. Different agents still run concurrently (independent locks).
 *   4. withLifecycleLock strictly serializes + propagates errors + a failed op
 *      does not wedge the chain.
 *   5. The reentrant compositor (restartAgent -> *Core) does not self-deadlock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createMockAdapter } from "../session-adapter.js";
import type { MockSessionAdapter } from "../session-adapter.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { BackoffConfig } from "../types.js";
import { SessionManager } from "../session-manager.js";
import { readRegistry, writeRegistry, createEntry } from "../registry.js";

const TEST_BACKOFF: BackoffConfig = {
  baseMs: 100,
  maxMs: 1000,
  maxRetries: 3,
  stableAfterMs: 500,
};

const tick = (ms = 5): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  };
}

/**
 * Stub the lifecycle cores with instrumented async bodies that model the exact
 * prod race: a `stop` CLOSES a shared store after an await; a `start` parks on
 * an await (like buildSessionConfig's RAG read) then READS the store. Tracks
 * peak concurrency and whether `start` ever resumed onto a closed store.
 */
function instrument(mgr: SessionManager): {
  storeOpen: boolean;
  inCore: number;
  maxConcurrent: number;
  readAfterClose: boolean;
} {
  const state = {
    storeOpen: true,
    inCore: 0,
    maxConcurrent: 0,
    readAfterClose: false,
  };
  // start parks LONGER than stop so that, when the two overlap (no lock), stop
  // closes the store DURING start's parked window — making the read-after-close
  // deterministic. Under the lock they never overlap, so the gap is irrelevant.
  const START_DELAY = 25;
  const STOP_DELAY = 5;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mgr as any).startAgentCore = vi.fn(async () => {
    state.inCore++;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.inCore);
    await tick(START_DELAY); // park, like an awaited DB/RAG read mid-startAgent
    if (!state.storeOpen) state.readAfterClose = true; // resumed onto a closed store
    state.inCore--;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mgr as any).stopAgentCore = vi.fn(async () => {
    state.inCore++;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.inCore);
    await tick(STOP_DELAY);
    state.storeOpen = false; // cleanupMemory closes the connection
    state.inCore--;
  });
  return state;
}

describe("SessionManager — per-agent lifecycle serialization (db-not-open restart race)", () => {
  let adapter: MockSessionAdapter;
  let registryPath: string;
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    adapter = createMockAdapter();
    tmpDir = await mkdtemp(join(tmpdir(), "sm-lifecycle-lock-"));
    registryPath = join(tmpDir, "registry.json");
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
    });
  });

  afterEach(async () => {
    try {
      await manager.stopAll();
    } catch {
      /* ignore */
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("Test 1 — concurrent start + stop for the SAME agent are serialized (no overlap, no read-after-close)", async () => {
    const cfg = makeConfig("clawdy", tmpDir);
    const s = instrument(manager);
    // startAgent acquires the lock first; stopAgent must queue behind it.
    await Promise.all([
      manager.startAgent("clawdy", cfg),
      manager.stopAgent("clawdy"),
    ]);
    expect(s.maxConcurrent).toBe(1); // never ran concurrently
    expect(s.readAfterClose).toBe(false); // start never resumed onto a closed store
  });

  it("Test 2 — WITHOUT the lock (cores invoked directly) the ops overlap and read after close (reproduces the bug)", async () => {
    const cfg = makeConfig("clawdy", tmpDir);
    const s = instrument(manager);
    // Bypass withLifecycleLock — invoke the cores directly, concurrently.
    await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).startAgentCore("clawdy", cfg),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).stopAgentCore("clawdy"),
    ]);
    expect(s.maxConcurrent).toBe(2); // overlapped
    expect(s.readAfterClose).toBe(true); // the exact "database connection is not open" condition
  });

  it("Test 3 — different agents run concurrently (independent per-agent locks)", async () => {
    const cfgA = makeConfig("alpha", tmpDir);
    const cfgB = makeConfig("beta", tmpDir);
    let inCore = 0;
    let maxConcurrent = 0;
    const core = async (): Promise<void> => {
      inCore++;
      maxConcurrent = Math.max(maxConcurrent, inCore);
      await tick();
      inCore--;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).startAgentCore = vi.fn(core);
    await Promise.all([
      manager.startAgent("alpha", cfgA),
      manager.startAgent("beta", cfgB),
    ]);
    expect(maxConcurrent).toBe(2); // distinct agents are not serialized against each other
  });

  it("Test 4 — withLifecycleLock strictly serializes; errors propagate but do not wedge the chain", async () => {
    const order: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lock = (name: string, fn: () => Promise<unknown>): Promise<unknown> =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).withLifecycleLock(name, fn);

    const p1 = lock("x", async () => {
      order.push("1-start");
      await tick();
      order.push("1-end");
      throw new Error("boom");
    });
    const p2 = lock("x", async () => {
      order.push("2-start");
      await tick();
      order.push("2-end");
    });

    await expect(p1).rejects.toThrow("boom"); // fn's rejection reaches the caller
    await p2; // a prior failure must not block the chain forever
    expect(order).toEqual(["1-start", "1-end", "2-start", "2-end"]); // op2 waited for op1 to settle
  });

  it("Test 5 — restart compositor calls the *Core methods (no self-deadlock) and completes", async () => {
    const cfg = makeConfig("clawdy", tmpDir);
    // Seed a registry entry so restartAgentCore's restartCount bump (updateEntry)
    // doesn't throw "not found" between the stop and start cores.
    const reg = await readRegistry(registryPath);
    await writeRegistry(registryPath, { ...reg, entries: [createEntry("clawdy")] });
    const calls: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).stopAgentCore = vi.fn(async () => {
      calls.push("stop");
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).startAgentCore = vi.fn(async () => {
      calls.push("start");
    });
    // If restartAgent invoked the LOCKED stopAgent/startAgent it would queue
    // behind its OWN lock and hang — the timeout would fire. Completing proves
    // the reentrant *Core wiring is correct.
    await expect(
      Promise.race([
        manager.restartAgent("clawdy", cfg).catch(() => undefined),
        tick(2000).then(() => {
          throw new Error("restartAgent deadlocked");
        }),
      ]),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["stop", "start"]);
  });

  it("Test 6 — a crash-path performRestart serialized behind a same-agent stop never overlaps", async () => {
    const cfg = makeConfig("clawdy", tmpDir);
    const s = instrument(manager);
    // performRestart is private (crash-timer entry). Fire it concurrently with a
    // manual stop — the lock must serialize them so the restart's startAgentCore
    // never reads a store the stop closed mid-flight.
    await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).performRestart("clawdy", cfg),
      manager.stopAgent("clawdy"),
    ]);
    expect(s.maxConcurrent).toBe(1);
    expect(s.readAfterClose).toBe(false);
  });
});
