/**
 * Phase 60 Plan 02 — TriggerEngine + TriggerSourceRegistry tests.
 *
 * TDD RED phase: these tests define the expected behavior of the
 * TriggerEngine ingest pipeline (3-layer dedup -> policy -> causation_id
 * dispatch) and TriggerSourceRegistry (register/get/all/size).
 *
 * Uses:
 *   - real better-sqlite3 :memory: DB for DedupLayer + TaskStore trigger_state
 *   - mock TurnDispatcher (vi.fn() for dispatch)
 *   - FakeTriggerSource implementing TriggerSource interface
 *   - pino silent logger
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import pino from "pino";

import { TriggerSourceRegistry } from "../source-registry.js";
import { TriggerEngine } from "../engine.js";
import { SCHEDULED_SILENCE_CONTRACT } from "../silence-sentinel.js";
import { PolicyEvaluator } from "../policy-evaluator.js";
import type { CompiledRule } from "../policy-loader.js";
import type { TriggerEvent, TriggerSource } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLog = pino({ level: "silent" });

/** Minimal mock TurnDispatcher — only dispatch() is used by TriggerEngine. */
function makeMockDispatcher() {
  return {
    dispatch: vi.fn().mockResolvedValue("ok"),
    dispatchStream: vi.fn(),
  };
}

/**
 * Minimal mock TaskStore that uses a real :memory: SQLite for rawDb (needed
 * by DedupLayer), plus in-memory Maps for trigger state methods.
 */
function makeMockTaskStore(db: DatabaseType) {
  const stateMap = new Map<string, { last_watermark: string | null; cursor_blob: string | null; updated_at: number }>();
  return {
    rawDb: db,
    upsertTriggerState: vi.fn((sourceId: string, lastWatermark: string | null, cursorBlob: string | null) => {
      stateMap.set(sourceId, { last_watermark: lastWatermark, cursor_blob: cursorBlob, updated_at: Date.now() });
    }),
    getTriggerState: vi.fn((sourceId: string) => {
      const s = stateMap.get(sourceId);
      if (!s) return null;
      return { source_id: sourceId, ...s };
    }),
    purgeCompleted: vi.fn(() => 0),
    purgeTriggerEvents: vi.fn(() => 0),
  };
}

/** FakeTriggerSource implementing TriggerSource. */
function makeFakeSource(
  sourceId: string,
  opts: { poll?: boolean } = {},
): TriggerSource & {
  start: ReturnType<typeof vi.fn<() => void>>;
  stop: ReturnType<typeof vi.fn<() => void>>;
  pollFn?: ReturnType<typeof vi.fn<(since: string | null) => Promise<readonly never[]>>>;
} {
  const source: TriggerSource & {
    start: ReturnType<typeof vi.fn<() => void>>;
    stop: ReturnType<typeof vi.fn<() => void>>;
    pollFn?: ReturnType<typeof vi.fn<(since: string | null) => Promise<readonly never[]>>>;
  } = {
    sourceId,
    start: vi.fn<() => void>(),
    stop: vi.fn<() => void>(),
  };
  if (opts.poll) {
    const pollFn = vi.fn().mockResolvedValue([]);
    source.poll = pollFn;
    source.pollFn = pollFn;
  }
  return source;
}

function makeEvent(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    sourceId: "test-source",
    idempotencyKey: `key-${Date.now()}-${Math.random()}`,
    targetAgent: "agent-one",
    payload: { msg: "hello" },
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TriggerSourceRegistry
// ---------------------------------------------------------------------------

describe("TriggerSourceRegistry", () => {
  it("registers and retrieves a source by sourceId", () => {
    const registry = new TriggerSourceRegistry();
    const source = makeFakeSource("src-1");
    registry.register(source);
    expect(registry.get("src-1")).toBe(source);
  });

  it("returns undefined for unknown sourceId", () => {
    const registry = new TriggerSourceRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("all() returns all registered sources as array", () => {
    const registry = new TriggerSourceRegistry();
    const s1 = makeFakeSource("s1");
    const s2 = makeFakeSource("s2");
    registry.register(s1);
    registry.register(s2);
    const all = registry.all();
    expect(all).toHaveLength(2);
    expect(all).toContain(s1);
    expect(all).toContain(s2);
  });

  it("size returns the count of registered sources", () => {
    const registry = new TriggerSourceRegistry();
    expect(registry.size).toBe(0);
    registry.register(makeFakeSource("a"));
    expect(registry.size).toBe(1);
    registry.register(makeFakeSource("b"));
    expect(registry.size).toBe(2);
  });

  it("registerSource rejects duplicate sourceId", () => {
    const registry = new TriggerSourceRegistry();
    registry.register(makeFakeSource("dup"));
    expect(() => registry.register(makeFakeSource("dup"))).toThrow(
      /already registered/,
    );
  });
});

// ---------------------------------------------------------------------------
// TriggerEngine
// ---------------------------------------------------------------------------

describe("TriggerEngine", () => {
  let db: DatabaseType;
  let dispatcher: ReturnType<typeof makeMockDispatcher>;
  let taskStore: ReturnType<typeof makeMockTaskStore>;
  let engine: TriggerEngine;
  const configuredAgents = new Set(["agent-one", "agent-two"]);

  beforeEach(() => {
    db = new Database(":memory:");
    dispatcher = makeMockDispatcher();
    taskStore = makeMockTaskStore(db);
    engine = new TriggerEngine(
      {
        turnDispatcher: dispatcher as any,
        taskStore: taskStore as any,
        log: silentLog,
        config: {
          replayMaxAgeMs: 86_400_000,
          dedupLruSize: 100,
          defaultDebounceMs: 0, // zero debounce for test speed
        },
      },
      configuredAgents,
    );
  });

  afterEach(() => {
    engine.stopAll();
    db.close();
  });

  // -------------------------------------------------------------------------
  // ingest
  // -------------------------------------------------------------------------

  it("ingest dispatches event with causationId on origin", async () => {
    const event = makeEvent();
    await engine.ingest(event);

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const [origin, agentName, payload] = dispatcher.dispatch.mock.calls[0]!;
    expect(agentName).toBe("agent-one");
    expect(origin.causationId).toBeTypeOf("string");
    expect(origin.causationId!.length).toBeGreaterThan(0);
    expect(origin.source.kind).toBe("trigger");
    expect(origin.source.id).toBe("test-source");
  });

  it("ingest rejects LRU duplicate — dispatch called once", async () => {
    const event = makeEvent({ idempotencyKey: "same-key" });
    await engine.ingest(event);
    await engine.ingest(event);

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it("ingest rejects unknown targetAgent — policy blocks", async () => {
    const event = makeEvent({ targetAgent: "nonexistent-agent" });
    await engine.ingest(event);

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("ingest updates watermark after successful dispatch", async () => {
    const event = makeEvent({ timestamp: 1234567890 });
    await engine.ingest(event);

    expect(taskStore.upsertTriggerState).toHaveBeenCalledWith(
      event.sourceId,
      "1234567890",
      null,
    );
  });

  it("replayMissed survives a throwing ingest (agent not running) — never crashes boot", async () => {
    // Regression: replayMissed runs BEFORE agent startAll, so a missed trigger
    // for a not-yet-started agent throws `Agent '<name>' is not running`. That
    // must NOT propagate out of replayMissed (it would crash the daemon at boot).
    dispatcher.dispatch.mockRejectedValueOnce(
      new Error("Agent 'agent-one' is not running"),
    );
    const failing = makeFakeSource("replay-fail", { poll: true });
    // pollFn is typed as Promise<readonly never[]> in the test helper; real
    // events need a cast to satisfy tsc (vitest transpiles fine either way).
    failing.pollFn!.mockResolvedValueOnce([
      makeEvent({ sourceId: "replay-fail" }),
    ] as unknown as never[]);
    // A second source whose event dispatches fine — proves replay CONTINUES past
    // the failure (per-source isolation, not just per-event swallow).
    const ok = makeFakeSource("replay-ok", { poll: true });
    ok.pollFn!.mockResolvedValueOnce([
      makeEvent({ sourceId: "replay-ok" }),
    ] as unknown as never[]);
    engine.registerSource(failing);
    engine.registerSource(ok);

    await expect(engine.replayMissed()).resolves.toBeUndefined();
    // The healthy source's event still dispatched (replay didn't abort).
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it("SQLite UNIQUE rejects duplicate after LRU eviction", async () => {
    // Create engine with LRU size of 2
    const smallEngine = new TriggerEngine(
      {
        turnDispatcher: dispatcher as any,
        taskStore: taskStore as any,
        log: silentLog,
        config: {
          replayMaxAgeMs: 86_400_000,
          dedupLruSize: 2,
          defaultDebounceMs: 0,
        },
      },
      configuredAgents,
    );

    // Insert event A — fills LRU slot 1
    const eventA = makeEvent({ idempotencyKey: "key-a" });
    await smallEngine.ingest(eventA);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);

    // Insert events B and C — evicts A from LRU
    await smallEngine.ingest(makeEvent({ idempotencyKey: "key-b" }));
    await smallEngine.ingest(makeEvent({ idempotencyKey: "key-c" }));
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3);

    // Re-insert A — LRU won't catch it, but SQLite UNIQUE should
    await smallEngine.ingest(makeEvent({ idempotencyKey: "key-a" }));
    // Still 3 dispatches — SQLite blocked the fourth
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3);

    smallEngine.stopAll();
  });

  // -------------------------------------------------------------------------
  // replayMissed
  // -------------------------------------------------------------------------

  it("replayMissed calls poll on sources with watermark", async () => {
    const source = makeFakeSource("poll-src", { poll: true });
    engine.registerSource(source);

    // Seed a watermark — must be recent enough to pass maxAge check
    const recentWatermark = String(Date.now() - 1000); // 1 second ago
    taskStore.upsertTriggerState("poll-src", recentWatermark, null);

    await engine.replayMissed();

    expect(source.pollFn).toHaveBeenCalledWith(recentWatermark);
  });

  it("replayMissed skips sources without poll method", async () => {
    const source = makeFakeSource("no-poll-src"); // no poll
    engine.registerSource(source);

    // Should not throw
    await engine.replayMissed();
  });

  it("replayMissed skips watermarks older than maxAge", async () => {
    const source = makeFakeSource("old-src", { poll: true });
    engine.registerSource(source);

    // Set watermark to a very old timestamp
    const veryOld = Date.now() - 200_000_000; // well beyond 86400000 maxAge
    taskStore.getTriggerState.mockReturnValueOnce({
      source_id: "old-src",
      last_watermark: String(veryOld),
      cursor_blob: null,
      updated_at: Date.now(),
    });

    await engine.replayMissed();

    // poll should NOT be called because watermark is too old
    expect(source.pollFn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // startAll / stopAll
  // -------------------------------------------------------------------------

  it("startAll and stopAll call source lifecycle methods", () => {
    const s1 = makeFakeSource("s1");
    const s2 = makeFakeSource("s2");
    engine.registerSource(s1);
    engine.registerSource(s2);

    engine.startAll();
    expect(s1.start).toHaveBeenCalledTimes(1);
    expect(s2.start).toHaveBeenCalledTimes(1);

    engine.stopAll();
    expect(s1.stop).toHaveBeenCalledTimes(1);
    expect(s2.stop).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // registerSource
  // -------------------------------------------------------------------------

  it("registerSource rejects duplicate sourceId via registry", () => {
    engine.registerSource(makeFakeSource("dup-src"));
    expect(() => engine.registerSource(makeFakeSource("dup-src"))).toThrow(
      /already registered/,
    );
  });

  // -------------------------------------------------------------------------
  // updateConfiguredAgents
  // -------------------------------------------------------------------------

  it("updateConfiguredAgents changes policy evaluation", async () => {
    const event = makeEvent({ targetAgent: "new-agent" });

    // Should be rejected — new-agent not in initial set
    await engine.ingest(event);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();

    // Update agents to include new-agent (need different key to avoid dedup)
    engine.updateConfiguredAgents(new Set(["new-agent"]));
    const event2 = makeEvent({ targetAgent: "new-agent", idempotencyKey: "new-key" });
    await engine.ingest(event2);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 999.11 Plan 00 — POLICY default-allow regression locks.
//
// These two tests are REGRESSION LOCKS, not driver-RED. POLICY-01 and
// POLICY-02's actual RED moment is at the daemon boot site (daemon.ts ~2034,
// which today constructs `new PolicyEvaluator([], configuredAgentNames)` —
// fail-closed on missing policies.yaml). The engine ternary at engine.ts:130
// already does the right thing when `evaluator` is undefined: it routes
// through `evaluatePolicy()` (default-allow for any configured target).
//
// These tests pin the engine-side contract so a future refactor cannot
// silently break the swap mechanism Plan 01 relies on.
//
// Failure mode if the engine ternary regresses:
//   POLICY-01 — would fail with "policy rejected event" / dispatcher not called.
//   POLICY-02 — would fail because reloadEvaluator(real) wouldn't override the
//   default-allow path.
// ---------------------------------------------------------------------------

describe("default-allow when evaluator undefined (POLICY-01)", () => {
  let db: DatabaseType;
  let dispatcher: ReturnType<typeof makeMockDispatcher>;
  let taskStore: ReturnType<typeof makeMockTaskStore>;
  const configuredAgents = new Set(["fin-client", "acme-content-creator"]);

  beforeEach(() => {
    db = new Database(":memory:");
    dispatcher = makeMockDispatcher();
    taskStore = makeMockTaskStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("dispatches scheduler event when targetAgent is in configuredAgents", async () => {
    // Reproduces today's clawdy journal: 09:00 fin-client standup
    // MUST dispatch via the default-allow function-form when evaluator undefined.
    const engine = new TriggerEngine(
      {
        turnDispatcher: dispatcher as any,
        taskStore: taskStore as any,
        log: silentLog,
        config: {
          replayMaxAgeMs: 86_400_000,
          dedupLruSize: 100,
          defaultDebounceMs: 0,
        },
      },
      configuredAgents,
      undefined, // ← path B: undefined evaluator → engine.ts:130 selects evaluatePolicy()
    );

    const event: TriggerEvent = {
      sourceId: "scheduler",
      sourceKind: "scheduler",
      idempotencyKey: "sched-0900-fin-client-standup",
      targetAgent: "fin-client",
      payload: "0900 standup",
      timestamp: Date.now(),
    };

    await engine.ingest(event);

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const [, agentName, payload] = dispatcher.dispatch.mock.calls[0]!;
    expect(agentName).toBe("fin-client");
    // Payload preserved through default-allow path (string passthrough) —
    // plus the scheduler-family silence contract appended at dispatch
    // (INC-2026-08-14c, silence-sentinel.ts).
    expect(payload).toBe("0900 standup" + SCHEDULED_SILENCE_CONTRACT);
    engine.stopAll();
  });

  it("rejects with 'target agent X not configured' (NOT 'no matching rule')", async () => {
    // Pin the rejection reason from CONTEXT.md <specifics>: when targetAgent
    // is NOT configured, the failure mode must be the function-form's
    // "target agent 'X' not configured", NEVER the class-form's
    // "no matching rule" (which is what fail-closed empty-rules emits today
    // at the daemon boot site).
    const engine = new TriggerEngine(
      {
        turnDispatcher: dispatcher as any,
        taskStore: taskStore as any,
        log: silentLog,
        config: {
          replayMaxAgeMs: 86_400_000,
          dedupLruSize: 100,
          defaultDebounceMs: 0,
        },
      },
      configuredAgents,
      undefined,
    );

    const logSpy = vi.spyOn((engine as any).log, "info");

    const event: TriggerEvent = {
      sourceId: "scheduler",
      sourceKind: "scheduler",
      idempotencyKey: "ghost-evt-1",
      targetAgent: "ghost-agent",
      payload: "should not dispatch",
      timestamp: Date.now(),
    };

    await engine.ingest(event);

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    // Look through the info log calls for the specific rejection reason —
    // must contain "not configured" (function-form), NOT "no matching rule".
    const rejectCall = logSpy.mock.calls.find((c) => {
      const ctx = c[0] as { reason?: string } | undefined;
      return ctx && typeof ctx.reason === "string" && ctx.reason.includes("not configured");
    });
    expect(rejectCall).toBeDefined();
    // And explicitly NOT the empty-rules failure mode.
    const emptyRulesCall = logSpy.mock.calls.find((c) => {
      const ctx = c[0] as { reason?: string } | undefined;
      return ctx && ctx.reason === "no matching rule";
    });
    expect(emptyRulesCall).toBeUndefined();
    engine.stopAll();
  });
});

describe("reloadEvaluator swap (POLICY-02)", () => {
  let db: DatabaseType;
  let dispatcher: ReturnType<typeof makeMockDispatcher>;
  let taskStore: ReturnType<typeof makeMockTaskStore>;
  const configuredAgents = new Set(["fin-client"]);

  beforeEach(() => {
    db = new Database(":memory:");
    dispatcher = makeMockDispatcher();
    taskStore = makeMockTaskStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("swaps from undefined default-allow to a real evaluator that rejects", async () => {
    // Phase 999.11 Plan 01 must preserve the back-compat with PolicyWatcher.onReload:
    // boot with undefined evaluator (default-allow), then reloadEvaluator(real)
    // must take effect on the very next ingest.
    const engine = new TriggerEngine(
      {
        turnDispatcher: dispatcher as any,
        taskStore: taskStore as any,
        log: silentLog,
        config: {
          replayMaxAgeMs: 86_400_000,
          dedupLruSize: 100,
          defaultDebounceMs: 0,
        },
      },
      configuredAgents,
      undefined,
    );

    // Step 1: default-allow path dispatches a configured-target event.
    const evt1: TriggerEvent = {
      sourceId: "scheduler",
      sourceKind: "scheduler",
      idempotencyKey: "swap-evt-1",
      targetAgent: "fin-client",
      payload: "before reload",
      timestamp: Date.now(),
    };
    await engine.ingest(evt1);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);

    // Step 2: build a real PolicyEvaluator with ZERO rules (so .evaluate()
    // returns "no matching rule" — the fail-closed semantic). After
    // reloadEvaluator(real), the ternary at engine.ts:130 must select the
    // class form and reject the next event.
    const realEvaluator = new PolicyEvaluator([] as readonly CompiledRule[], configuredAgents);
    engine.reloadEvaluator(realEvaluator);

    const evt2: TriggerEvent = {
      sourceId: "scheduler",
      sourceKind: "scheduler",
      idempotencyKey: "swap-evt-2",
      targetAgent: "fin-client",
      payload: "after reload",
      timestamp: Date.now() + 1,
    };
    await engine.ingest(evt2);

    // Dispatcher count unchanged — the real evaluator rejected evt2.
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    engine.stopAll();
  });
});
