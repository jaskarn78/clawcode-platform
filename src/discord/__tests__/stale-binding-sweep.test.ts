/**
 * Phase 999.14 Plan 00 — MCP-09 RED tests for the stale-binding sweep.
 *
 * Wave 0 status: 12 tests RED on purpose. The module
 * `../stale-binding-sweep` is a thrower stub; Wave 1 Task 2 lands the
 * real implementation.
 *
 * Contract this file pins:
 *   - scanStaleBindings: pure filter + oldest-first sort.
 *   - parseIdleDuration: "24h"/"6h"/"30m"/"0" recognized, garbage throws.
 *   - sweepStaleBindings: invokes cleanupThreadWithClassifier per stale
 *     entry; emits summary warn log with alphabetically-sorted agents
 *     object; idleMs<=0 disables; individual failures continue the sweep.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  scanStaleBindings,
  parseIdleDuration,
  sweepStaleBindings,
} from "../stale-binding-sweep.js";
import type {
  ThreadBinding,
  ThreadBindingRegistry,
} from "../thread-types.js";

// Lock NOW — deterministic test math, never depend on Date.now().
const NOW = 1_730_000_000_000;
const ONE_HOUR = 3_600_000;
const TWENTY_FOUR_HOURS = 24 * ONE_HOUR;

function makeBinding(
  threadId: string,
  agentName: string,
  lastActivity: number,
): ThreadBinding {
  return {
    threadId,
    parentChannelId: "channel-1",
    agentName,
    sessionName: `${agentName}-sub-${threadId}`,
    createdAt: lastActivity,
    lastActivity,
  };
}

function makeRegistry(
  bindings: readonly ThreadBinding[],
): ThreadBindingRegistry {
  return { bindings, updatedAt: NOW };
}

// Mock the thread-cleanup helper so the sweep's per-entry cleanup is
// observable + controllable.
const { cleanupThreadWithClassifierMock } = vi.hoisted(() => ({
  cleanupThreadWithClassifierMock: vi.fn(),
}));

vi.mock("../thread-cleanup.js", async () => {
  const actual =
    await vi.importActual<typeof import("../thread-cleanup.js")>(
      "../thread-cleanup.js",
    );
  return {
    ...actual,
    cleanupThreadWithClassifier: cleanupThreadWithClassifierMock,
  };
});

// Mock the registry I/O so sweep doesn't touch disk.
const { readThreadRegistryMock, writeThreadRegistryMock } = vi.hoisted(() => ({
  readThreadRegistryMock: vi.fn(),
  writeThreadRegistryMock: vi.fn(),
}));

vi.mock("../thread-registry.js", async () => {
  const actual =
    await vi.importActual<typeof import("../thread-registry.js")>(
      "../thread-registry.js",
    );
  return {
    ...actual,
    readThreadRegistry: readThreadRegistryMock,
    writeThreadRegistry: writeThreadRegistryMock,
  };
});

function makeLog(): {
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
} {
  const log = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  log.child.mockReturnValue(log);
  return log;
}

describe("scanStaleBindings (MCP-09 pure filter)", () => {
  it("Test 1: returns entries older than idleMs, sorted oldest first", () => {
    const bindings = [
      makeBinding("t1", "fin-client", NOW - 1 * ONE_HOUR), // fresh
      makeBinding("t2", "fin-client", NOW - 23 * ONE_HOUR), // fresh
      makeBinding("t3", "fin-client", NOW - 25 * ONE_HOUR), // STALE
      makeBinding("t4", "fin-client", NOW - 30 * ONE_HOUR), // STALE
      makeBinding("t5", "fin-test", NOW - 2 * ONE_HOUR), // fresh
    ];

    const stale = scanStaleBindings({
      registry: makeRegistry(bindings),
      now: NOW,
      idleMs: TWENTY_FOUR_HOURS,
    });

    expect(stale.length).toBe(2);
    // Sorted oldest first — 30h before 25h.
    expect(stale[0]!.threadId).toBe("t4");
    expect(stale[1]!.threadId).toBe("t3");
  });

  it("Test 2: idleMs=0 disables sweep (returns [])", () => {
    const bindings = [
      makeBinding("t1", "fin-client", NOW - 100 * ONE_HOUR),
    ];

    const stale = scanStaleBindings({
      registry: makeRegistry(bindings),
      now: NOW,
      idleMs: 0,
    });

    expect(stale.length).toBe(0);
  });

  it("Test 3: negative idleMs returns []", () => {
    const bindings = [
      makeBinding("t1", "fin-client", NOW - 100 * ONE_HOUR),
    ];

    const stale = scanStaleBindings({
      registry: makeRegistry(bindings),
      now: NOW,
      idleMs: -1,
    });

    expect(stale.length).toBe(0);
  });
});

describe("parseIdleDuration (MCP-09)", () => {
  it("Test 4: '24h' === 86_400_000 ms", () => {
    expect(parseIdleDuration("24h")).toBe(86_400_000);
  });

  it("Test 5: '6h' === 21_600_000 ms", () => {
    expect(parseIdleDuration("6h")).toBe(21_600_000);
  });

  it("Test 6: '30m' === 1_800_000 ms", () => {
    expect(parseIdleDuration("30m")).toBe(1_800_000);
  });

  it("Test 7: '0' === 0", () => {
    expect(parseIdleDuration("0")).toBe(0);
  });

  it("Test 8: garbage input throws", () => {
    expect(() => parseIdleDuration("garbage")).toThrow();
  });
});

describe("sweepStaleBindings (MCP-09 orchestrator)", () => {
  beforeEach(() => {
    cleanupThreadWithClassifierMock.mockReset();
    readThreadRegistryMock.mockReset();
    writeThreadRegistryMock.mockReset();
    writeThreadRegistryMock.mockResolvedValue(undefined);
  });

  const REGISTRY_PATH = "/tmp/test-thread-bindings.json";

  it("Test 9: happy path — 3 stale entries pruned, summary warn log", async () => {
    const bindings = [
      // 3 stale (fin-client x2, fin-test x1)
      makeBinding("t1", "fin-client", NOW - 30 * ONE_HOUR),
      makeBinding("t2", "fin-client", NOW - 25 * ONE_HOUR),
      makeBinding("t3", "fin-test", NOW - 26 * ONE_HOUR),
      // 2 fresh
      makeBinding("t4", "fin-client", NOW - 1 * ONE_HOUR),
      makeBinding("t5", "fin-test", NOW - 2 * ONE_HOUR),
    ];
    readThreadRegistryMock.mockResolvedValue(makeRegistry(bindings));
    cleanupThreadWithClassifierMock.mockResolvedValue({
      archived: false,
      bindingPruned: true,
      classification: "prune",
    });

    const log = makeLog();
    const spawner = { archiveThread: vi.fn() };

    const result = await sweepStaleBindings({
      spawner,
      registryPath: REGISTRY_PATH,
      now: NOW,
      idleMs: TWENTY_FOUR_HOURS,
      log: log as unknown as import("pino").Logger,
    });

    expect(cleanupThreadWithClassifierMock).toHaveBeenCalledTimes(3);
    expect(result.staleCount).toBe(3);
    expect(result.prunedCount).toBe(3);
    // agents object keyed by agentName, alphabetical for deterministic
    // log readability.
    expect(result.agents).toEqual({
      "fin-client": 2,
      "fin-test": 1,
    });
    expect(Object.keys(result.agents)).toEqual([
      "fin-client",
      "fin-test",
    ]);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "thread-cleanup",
        action: "stale-sweep",
        staleCount: 3,
        prunedCount: 3,
        idleMs: TWENTY_FOUR_HOURS,
        agents: { "fin-client": 2, "fin-test": 1 },
      }),
      expect.any(String),
    );
  });

  it("Test 10: idleMs=0 → cleanup NOT called, no warn log (sweep disabled)", async () => {
    const bindings = [
      makeBinding("t1", "fin-client", NOW - 100 * ONE_HOUR),
    ];
    readThreadRegistryMock.mockResolvedValue(makeRegistry(bindings));

    const log = makeLog();
    const spawner = { archiveThread: vi.fn() };

    const result = await sweepStaleBindings({
      spawner,
      registryPath: REGISTRY_PATH,
      now: NOW,
      idleMs: 0,
      log: log as unknown as import("pino").Logger,
    });

    expect(cleanupThreadWithClassifierMock).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(result.staleCount).toBe(0);
    expect(result.prunedCount).toBe(0);
  });

  it("Test 11: staleCount=0 → cleanup NOT called, no warn log (debug only)", async () => {
    const bindings = [
      // All fresh
      makeBinding("t1", "fin-client", NOW - 1 * ONE_HOUR),
      makeBinding("t2", "fin-test", NOW - 2 * ONE_HOUR),
    ];
    readThreadRegistryMock.mockResolvedValue(makeRegistry(bindings));

    const log = makeLog();
    const spawner = { archiveThread: vi.fn() };

    const result = await sweepStaleBindings({
      spawner,
      registryPath: REGISTRY_PATH,
      now: NOW,
      idleMs: TWENTY_FOUR_HOURS,
      log: log as unknown as import("pino").Logger,
    });

    expect(cleanupThreadWithClassifierMock).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(result.staleCount).toBe(0);
    expect(result.prunedCount).toBe(0);
  });

  it("Phase 999.X: subagent-named binding triggers stopSubagentSession", async () => {
    // Binding whose sessionName matches isSubagentThreadName.
    const subBinding: ThreadBinding = {
      threadId: "thread-sub-1",
      parentChannelId: "ch-1",
      agentName: "fin-client-via-fin-research-57r__G",
      sessionName: "fin-client-via-fin-research-57r__G",
      createdAt: NOW - 30 * ONE_HOUR,
      lastActivity: NOW - 25 * ONE_HOUR,
    };
    readThreadRegistryMock.mockResolvedValue(makeRegistry([subBinding]));
    cleanupThreadWithClassifierMock.mockResolvedValue({
      archived: false,
      bindingPruned: true,
      classification: "prune",
    });

    const log = makeLog();
    const spawner = { archiveThread: vi.fn() };
    const stopSubagentSession = vi.fn().mockResolvedValue(undefined);

    const result = await sweepStaleBindings({
      spawner,
      registryPath: REGISTRY_PATH,
      now: NOW,
      idleMs: TWENTY_FOUR_HOURS,
      log: log as unknown as import("pino").Logger,
      stopSubagentSession,
    });

    expect(stopSubagentSession).toHaveBeenCalledTimes(1);
    expect(stopSubagentSession).toHaveBeenCalledWith(
      "fin-client-via-fin-research-57r__G",
    );
    expect(result.subagentSessionsStopped).toBe(1);
  });

  it("Phase 999.X: operator-defined binding does NOT trigger stopSubagentSession", async () => {
    // Plain agentName/sessionName; no nanoid6 suffix.
    const opBinding: ThreadBinding = {
      threadId: "thread-op-1",
      parentChannelId: "ch-1",
      agentName: "fin-client",
      sessionName: "fin-client",
      createdAt: NOW - 30 * ONE_HOUR,
      lastActivity: NOW - 25 * ONE_HOUR,
    };
    readThreadRegistryMock.mockResolvedValue(makeRegistry([opBinding]));
    cleanupThreadWithClassifierMock.mockResolvedValue({
      archived: false,
      bindingPruned: true,
      classification: "prune",
    });

    const log = makeLog();
    const spawner = { archiveThread: vi.fn() };
    const stopSubagentSession = vi.fn().mockResolvedValue(undefined);

    const result = await sweepStaleBindings({
      spawner,
      registryPath: REGISTRY_PATH,
      now: NOW,
      idleMs: TWENTY_FOUR_HOURS,
      log: log as unknown as import("pino").Logger,
      stopSubagentSession,
    });

    expect(stopSubagentSession).not.toHaveBeenCalled();
    expect(result.subagentSessionsStopped).toBe(0);
  });

  it("Phase 999.X: stopSubagentSession not provided → no stop attempt (back-compat)", async () => {
    const subBinding: ThreadBinding = {
      threadId: "thread-sub-1",
      parentChannelId: "ch-1",
      agentName: "fin-client-via-fin-research-57r__G",
      sessionName: "fin-client-via-fin-research-57r__G",
      createdAt: NOW - 30 * ONE_HOUR,
      lastActivity: NOW - 25 * ONE_HOUR,
    };
    readThreadRegistryMock.mockResolvedValue(makeRegistry([subBinding]));
    cleanupThreadWithClassifierMock.mockResolvedValue({
      archived: false,
      bindingPruned: true,
      classification: "prune",
    });

    const log = makeLog();
    const spawner = { archiveThread: vi.fn() };

    const result = await sweepStaleBindings({
      spawner,
      registryPath: REGISTRY_PATH,
      now: NOW,
      idleMs: TWENTY_FOUR_HOURS,
      log: log as unknown as import("pino").Logger,
      // stopSubagentSession intentionally omitted
    });

    // Sweep proceeded normally; subagentSessionsStopped is zero by default.
    expect(result.subagentSessionsStopped).toBe(0);
    expect(result.prunedCount).toBe(1);
  });

  it("Phase 999.X: stopSubagentSession failure does NOT abort sweep", async () => {
    const subBinding1: ThreadBinding = {
      threadId: "thread-sub-1",
      parentChannelId: "ch-1",
      agentName: "fin-client-via-fin-research-57r__G",
      sessionName: "fin-client-via-fin-research-57r__G",
      createdAt: NOW - 30 * ONE_HOUR,
      lastActivity: NOW - 25 * ONE_HOUR,
    };
    const subBinding2: ThreadBinding = {
      threadId: "thread-sub-2",
      parentChannelId: "ch-1",
      agentName: "fin-client-via-fin-research-4XZKL0",
      sessionName: "fin-client-via-fin-research-4XZKL0",
      createdAt: NOW - 26 * ONE_HOUR,
      lastActivity: NOW - 25 * ONE_HOUR,
    };
    readThreadRegistryMock.mockResolvedValue(
      makeRegistry([subBinding1, subBinding2]),
    );
    cleanupThreadWithClassifierMock.mockResolvedValue({
      archived: false,
      bindingPruned: true,
      classification: "prune",
    });

    const log = makeLog();
    const spawner = { archiveThread: vi.fn() };
    const stopSubagentSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);

    const result = await sweepStaleBindings({
      spawner,
      registryPath: REGISTRY_PATH,
      now: NOW,
      idleMs: TWENTY_FOUR_HOURS,
      log: log as unknown as import("pino").Logger,
      stopSubagentSession,
    });

    // First failed, second succeeded — second still got processed.
    expect(stopSubagentSession).toHaveBeenCalledTimes(2);
    expect(result.subagentSessionsStopped).toBe(1);
  });

  it("Phase 999.X: 'not running' race is tolerated silently", async () => {
    const subBinding: ThreadBinding = {
      threadId: "thread-sub-1",
      parentChannelId: "ch-1",
      agentName: "fin-client-via-fin-research-57r__G",
      sessionName: "fin-client-via-fin-research-57r__G",
      createdAt: NOW - 30 * ONE_HOUR,
      lastActivity: NOW - 25 * ONE_HOUR,
    };
    readThreadRegistryMock.mockResolvedValue(makeRegistry([subBinding]));
    cleanupThreadWithClassifierMock.mockResolvedValue({
      archived: false,
      bindingPruned: true,
      classification: "prune",
    });

    const log = makeLog();
    const spawner = { archiveThread: vi.fn() };
    const stopSubagentSession = vi.fn().mockRejectedValue(
      new Error(
        "Agent 'fin-client-via-fin-research-57r__G' is not running",
      ),
    );

    await sweepStaleBindings({
      spawner,
      registryPath: REGISTRY_PATH,
      now: NOW,
      idleMs: TWENTY_FOUR_HOURS,
      log: log as unknown as import("pino").Logger,
      stopSubagentSession,
    });

    // Race tolerated → info, not error.
    expect(log.error).not.toHaveBeenCalledWith(
      expect.objectContaining({
        action: "stop-subagent-session-failed",
      }),
      expect.any(String),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "stop-subagent-session",
      }),
      expect.stringContaining("already stopped"),
    );
  });

  it("Test 12: continues on individual failure — staleCount=3, prunedCount=2", async () => {
    const bindings = [
      makeBinding("t1", "fin-client", NOW - 30 * ONE_HOUR),
      makeBinding("t2", "fin-client", NOW - 28 * ONE_HOUR),
      makeBinding("t3", "fin-test", NOW - 26 * ONE_HOUR),
    ];
    readThreadRegistryMock.mockResolvedValue(makeRegistry(bindings));

    // First call throws — sweep must continue with remaining entries.
    cleanupThreadWithClassifierMock
      .mockRejectedValueOnce(new Error("unexpected sweep failure"))
      .mockResolvedValue({
        archived: false,
        bindingPruned: true,
        classification: "prune",
      });

    const log = makeLog();
    const spawner = { archiveThread: vi.fn() };

    const result = await sweepStaleBindings({
      spawner,
      registryPath: REGISTRY_PATH,
      now: NOW,
      idleMs: TWENTY_FOUR_HOURS,
      log: log as unknown as import("pino").Logger,
    });

    expect(cleanupThreadWithClassifierMock).toHaveBeenCalledTimes(3);
    expect(result.staleCount).toBe(3);
    expect(result.prunedCount).toBe(2);
  });
});
