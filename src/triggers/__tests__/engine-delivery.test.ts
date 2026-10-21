/**
 * Phase 100 follow-up — TriggerEngine delivery callback tests.
 *
 * Bug context (2026-04-27, SUBAGENT-DELIVERY-ANALYSIS.md):
 *   `TriggerEngine.ingest()` calls `await turnDispatcher.dispatch(...)` and
 *   discards the returned response string. Scheduled cron output is generated
 *   by the agent but never reaches Discord — it stays in the agent's
 *   conversation history and gets dragged into the next user-msg-driven
 *   reply, producing the wrong-slot attribution symptom the operator sees.
 *
 * Fix: a `deliveryFn` option on TriggerEngineOptions. When provided,
 * the engine invokes it after every successful dispatch with the response
 * text so the daemon can route it to the agent's bound Discord surface
 * (webhook for identity, bot-direct fallback). Failures are swallowed
 * with a warn log so a delivery hiccup does not block subsequent triggers
 * or leave the watermark un-advanced.
 *
 * Coverage:
 *   TD1 — back-compat: no deliveryFn -> dispatch happens, no delivery
 *   TD2 — deliveryFn invoked with (targetAgent, response) on non-empty reply
 *   TD3 — deliveryFn skipped when dispatch returns empty / whitespace
 *   TD4 — deliveryFn throw is caught + watermark still advances
 *   TD5 — TriggerEngineOptions stays back-compat (no deliveryFn = optional)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import pino from "pino";

import { TriggerEngine } from "../engine.js";
import type { TriggerEvent, TriggerEngineOptions } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers (mirror engine.test.ts shape so engine internals stay shared)
// ---------------------------------------------------------------------------

const silentLog = pino({ level: "silent" });

function makeMockDispatcher(responseText: string = "agent reply") {
  return {
    dispatch: vi.fn().mockResolvedValue(responseText),
    dispatchStream: vi.fn(),
  };
}

function makeMockTaskStore(db: DatabaseType) {
  const stateMap = new Map<
    string,
    { last_watermark: string | null; cursor_blob: string | null; updated_at: number }
  >();
  return {
    rawDb: db,
    upsertTriggerState: vi.fn(
      (sourceId: string, lastWatermark: string | null, cursorBlob: string | null) => {
        stateMap.set(sourceId, {
          last_watermark: lastWatermark,
          cursor_blob: cursorBlob,
          updated_at: Date.now(),
        });
      },
    ),
    getTriggerState: vi.fn((sourceId: string) => {
      const s = stateMap.get(sourceId);
      if (!s) return null;
      return { source_id: sourceId, ...s };
    }),
    purgeCompleted: vi.fn(() => 0),
    purgeTriggerEvents: vi.fn(() => 0),
  };
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

const configuredAgents = new Set(["agent-one", "agent-two"]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TriggerEngine delivery callback (Phase 100 follow-up)", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  // ---- TD1 ----------------------------------------------------------------

  it("TD1 — without deliveryFn, dispatch happens but no delivery is attempted (back-compat)", async () => {
    const dispatcher = makeMockDispatcher("scheduled output");
    const taskStore = makeMockTaskStore(db);
    const engine = new TriggerEngine(
      {
        turnDispatcher: dispatcher as never,
        taskStore: taskStore as never,
        log: silentLog,
        config: {
          replayMaxAgeMs: 86_400_000,
          dedupLruSize: 100,
          defaultDebounceMs: 0,
        },
      },
      configuredAgents,
    );

    await engine.ingest(makeEvent());

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(taskStore.upsertTriggerState).toHaveBeenCalledTimes(1);
    // Nothing else to assert — the absence of a deliveryFn means no extra
    // call surface exists. This locks in the pre-fix behavior remains valid
    // when the option is omitted (e.g. existing tests, embedded daemons).

    engine.stopAll();
  });

  // ---- TD2 ----------------------------------------------------------------

  it("TD2 — with deliveryFn + non-empty response, deliveryFn is called with (targetAgent, response)", async () => {
    const dispatcher = makeMockDispatcher("All 3 plans written and ready for review");
    const taskStore = makeMockTaskStore(db);
    const deliveryFn = vi.fn().mockResolvedValue(undefined);
    const engine = new TriggerEngine(
      {
        turnDispatcher: dispatcher as never,
        taskStore: taskStore as never,
        log: silentLog,
        config: {
          replayMaxAgeMs: 86_400_000,
          dedupLruSize: 100,
          defaultDebounceMs: 0,
        },
        deliveryFn,
      },
      configuredAgents,
    );

    await engine.ingest(makeEvent({ targetAgent: "agent-two" }));

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(deliveryFn).toHaveBeenCalledTimes(1);
    expect(deliveryFn).toHaveBeenCalledWith(
      "agent-two",
      "All 3 plans written and ready for review",
      // 999.178 R1 — the engine now passes a delivery context carrying the
      // trigger sourceId as the dead-letter label.
      expect.objectContaining({ label: expect.any(String) }),
    );
    expect(taskStore.upsertTriggerState).toHaveBeenCalledTimes(1);

    engine.stopAll();
  });

  // ---- TD3 ----------------------------------------------------------------

  it("TD3 — empty / whitespace dispatch response: deliveryFn NOT called", async () => {
    const taskStore = makeMockTaskStore(db);
    const deliveryFn = vi.fn().mockResolvedValue(undefined);

    // Empty string
    {
      const dispatcher = makeMockDispatcher("");
      const engine = new TriggerEngine(
        {
          turnDispatcher: dispatcher as never,
          taskStore: taskStore as never,
          log: silentLog,
          config: {
            replayMaxAgeMs: 86_400_000,
            dedupLruSize: 100,
            defaultDebounceMs: 0,
          },
          deliveryFn,
        },
        configuredAgents,
      );
      await engine.ingest(makeEvent({ idempotencyKey: "empty-key" }));
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(deliveryFn).not.toHaveBeenCalled();
      engine.stopAll();
    }

    // Whitespace only
    {
      const dispatcher = makeMockDispatcher("   \n\t  ");
      const engine = new TriggerEngine(
        {
          turnDispatcher: dispatcher as never,
          taskStore: taskStore as never,
          log: silentLog,
          config: {
            replayMaxAgeMs: 86_400_000,
            dedupLruSize: 100,
            defaultDebounceMs: 0,
          },
          deliveryFn,
        },
        configuredAgents,
      );
      await engine.ingest(makeEvent({ idempotencyKey: "ws-key" }));
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(deliveryFn).not.toHaveBeenCalled();
      engine.stopAll();
    }

    // Watermark still advanced for both ingests (the dispatch itself succeeded).
    expect(taskStore.upsertTriggerState).toHaveBeenCalledTimes(2);
  });

  // ---- TD4 ----------------------------------------------------------------

  it("TD4 — deliveryFn throw is swallowed: ingest does not propagate, watermark still advances", async () => {
    const dispatcher = makeMockDispatcher("important scheduled note");
    const taskStore = makeMockTaskStore(db);
    const deliveryError = new Error("discord 503 — channel unavailable");
    const deliveryFn = vi.fn().mockRejectedValue(deliveryError);
    const engine = new TriggerEngine(
      {
        turnDispatcher: dispatcher as never,
        taskStore: taskStore as never,
        log: silentLog,
        config: {
          replayMaxAgeMs: 86_400_000,
          dedupLruSize: 100,
          defaultDebounceMs: 0,
        },
        deliveryFn,
      },
      configuredAgents,
    );

    // Must not throw — engine logs warn + swallows so the next trigger fires.
    await expect(engine.ingest(makeEvent())).resolves.toBeUndefined();

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(deliveryFn).toHaveBeenCalledTimes(1);
    // Watermark advance must happen even on delivery failure — otherwise
    // we'd reprocess this scheduled tick on the next replay and double-dispatch.
    expect(taskStore.upsertTriggerState).toHaveBeenCalledTimes(1);

    engine.stopAll();
  });

  // ---- TD5 ----------------------------------------------------------------

  it("TD5 — TriggerEngineOptions back-compat: deliveryFn is optional in the type", () => {
    // Pure compile-time assertion: this object literal MUST satisfy
    // TriggerEngineOptions without a deliveryFn key. If a future refactor
    // makes deliveryFn required, this test file fails to type-check.
    const optsWithoutDelivery: TriggerEngineOptions = {
      turnDispatcher: makeMockDispatcher() as never,
      taskStore: makeMockTaskStore(db) as never,
      log: silentLog,
      config: {
        replayMaxAgeMs: 86_400_000,
        dedupLruSize: 100,
        defaultDebounceMs: 0,
      },
    };
    expect(optsWithoutDelivery.config.dedupLruSize).toBe(100);

    // And WITH deliveryFn must also satisfy the type.
    const optsWithDelivery: TriggerEngineOptions = {
      turnDispatcher: makeMockDispatcher() as never,
      taskStore: makeMockTaskStore(db) as never,
      log: silentLog,
      config: {
        replayMaxAgeMs: 86_400_000,
        dedupLruSize: 100,
        defaultDebounceMs: 0,
      },
      deliveryFn: async (_agent: string, _response: string) => {
        /* no-op */
      },
    };
    expect(typeof optsWithDelivery.deliveryFn).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// INC-2026-08-14c — silence contract + suppression (silence-sentinel.ts)
// ---------------------------------------------------------------------------

import {
  SCHEDULED_SILENCE_CONTRACT,
  SILENCE_SENTINEL,
} from "../silence-sentinel.js";

describe("TriggerEngine silence sentinel (INC-2026-08-14c)", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function makeEngine(
    dispatcher: ReturnType<typeof makeMockDispatcher>,
    taskStore: ReturnType<typeof makeMockTaskStore>,
    deliveryFn: ReturnType<typeof vi.fn>,
  ) {
    // Same as-never coercion the surrounding tests use for the mock seams.
    return new TriggerEngine(
      {
        turnDispatcher: dispatcher as never,
        taskStore: taskStore as never,
        log: silentLog,
        config: {
          replayMaxAgeMs: 86_400_000,
          dedupLruSize: 100,
          defaultDebounceMs: 0,
        },
        deliveryFn: deliveryFn as never,
      },
      configuredAgents,
    );
  }

  it("TD6 — NO_REPORT reply is suppressed (deliveryFn NOT called), watermark still advances", async () => {
    const dispatcher = makeMockDispatcher(SILENCE_SENTINEL);
    const taskStore = makeMockTaskStore(db);
    const deliveryFn = vi.fn().mockResolvedValue(undefined);
    const engine = makeEngine(dispatcher, taskStore, deliveryFn);

    await engine.ingest(makeEvent({ sourceId: "scheduler" }));

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(deliveryFn).not.toHaveBeenCalled();
    expect(taskStore.upsertTriggerState).toHaveBeenCalledTimes(1);

    engine.stopAll();
  });

  it("TD7 — the verbatim prod narration is suppressed by the backstop", async () => {
    const dispatcher = makeMockDispatcher(
      "Watchlist is empty - nothing to check. Ending silently per instructions.",
    );
    const taskStore = makeMockTaskStore(db);
    const deliveryFn = vi.fn().mockResolvedValue(undefined);
    const engine = makeEngine(dispatcher, taskStore, deliveryFn);

    await engine.ingest(makeEvent({ sourceId: "scheduler" }));

    expect(deliveryFn).not.toHaveBeenCalled();

    engine.stopAll();
  });

  it("TD8 — scheduler-family payloads get the silence contract appended; event sources do not", async () => {
    const dispatcher = makeMockDispatcher("a real report worth posting");
    const taskStore = makeMockTaskStore(db);
    const deliveryFn = vi.fn().mockResolvedValue(undefined);
    const engine = makeEngine(dispatcher, taskStore, deliveryFn);

    await engine.ingest(makeEvent({ sourceId: "scheduler" }));
    await engine.ingest(makeEvent({ sourceId: "recurring:abc123" }));
    await engine.ingest(makeEvent({ sourceId: "test-source" }));

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3);
    const payloads = dispatcher.dispatch.mock.calls.map((c) => c[2] as string);
    expect(payloads[0]!.endsWith(SCHEDULED_SILENCE_CONTRACT)).toBe(true);
    expect(payloads[1]!.endsWith(SCHEDULED_SILENCE_CONTRACT)).toBe(true);
    expect(payloads[2]!.includes(SCHEDULED_SILENCE_CONTRACT)).toBe(false);
    // A real report still delivers on every source.
    expect(deliveryFn).toHaveBeenCalledTimes(3);

    engine.stopAll();
  });
});
