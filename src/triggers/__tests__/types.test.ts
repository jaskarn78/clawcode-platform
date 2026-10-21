/**
 * Phase 60 Plan 01 — TriggerEvent schema + types tests.
 *
 * TDD RED: These tests exercise the Zod schema, type exports, and
 * default constants from src/triggers/types.ts.
 */

import { describe, it, expect } from "vitest";

import {
  TriggerEventSchema,
  type TriggerEvent,
  type TriggerSource,
  type TriggerEngineOptions,
  DEFAULT_DEDUP_LRU_SIZE,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_REPLAY_MAX_AGE_MS,
} from "../types.js";

describe("TriggerEventSchema", () => {
  const validEvent = {
    sourceId: "sched-daily",
    idempotencyKey: "tick-1713300000",
    targetAgent: "research",
    payload: { prompt: "daily scan" },
    timestamp: 1713300000,
  };

  it("parses a valid event", () => {
    const result = TriggerEventSchema.parse(validEvent);
    expect(result.sourceId).toBe("sched-daily");
    expect(result.idempotencyKey).toBe("tick-1713300000");
    expect(result.targetAgent).toBe("research");
    expect(result.payload).toEqual({ prompt: "daily scan" });
    expect(result.timestamp).toBe(1713300000);
  });

  it("accepts null payload", () => {
    const result = TriggerEventSchema.parse({ ...validEvent, payload: null });
    expect(result.payload).toBeNull();
  });

  it("accepts undefined payload (z.unknown passes)", () => {
    const { payload: _, ...rest } = validEvent;
    // z.unknown() accepts missing fields (they become undefined)
    const result = TriggerEventSchema.parse(rest);
    expect(result.payload).toBeUndefined();
  });

  it("accepts string payload", () => {
    const result = TriggerEventSchema.parse({ ...validEvent, payload: "raw text" });
    expect(result.payload).toBe("raw text");
  });

  it("rejects empty sourceId", () => {
    expect(() =>
      TriggerEventSchema.parse({ ...validEvent, sourceId: "" }),
    ).toThrow();
  });

  it("rejects empty idempotencyKey", () => {
    expect(() =>
      TriggerEventSchema.parse({ ...validEvent, idempotencyKey: "" }),
    ).toThrow();
  });

  it("rejects empty targetAgent", () => {
    expect(() =>
      TriggerEventSchema.parse({ ...validEvent, targetAgent: "" }),
    ).toThrow();
  });

  it("rejects negative timestamp", () => {
    expect(() =>
      TriggerEventSchema.parse({ ...validEvent, timestamp: -1 }),
    ).toThrow();
  });

  it("rejects non-integer timestamp", () => {
    expect(() =>
      TriggerEventSchema.parse({ ...validEvent, timestamp: 1.5 }),
    ).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() => TriggerEventSchema.parse({})).toThrow();
    expect(() => TriggerEventSchema.parse({ sourceId: "x" })).toThrow();
  });

  it("accepts timestamp of 0", () => {
    const result = TriggerEventSchema.parse({ ...validEvent, timestamp: 0 });
    expect(result.timestamp).toBe(0);
  });
});

describe("Default constants", () => {
  it("DEFAULT_DEDUP_LRU_SIZE is 10_000", () => {
    expect(DEFAULT_DEDUP_LRU_SIZE).toBe(10_000);
  });

  it("DEFAULT_DEBOUNCE_MS is 5_000", () => {
    expect(DEFAULT_DEBOUNCE_MS).toBe(5_000);
  });

  it("DEFAULT_REPLAY_MAX_AGE_MS is 86_400_000 (24h)", () => {
    expect(DEFAULT_REPLAY_MAX_AGE_MS).toBe(86_400_000);
  });
});

describe("TriggerSource type shape", () => {
  it("satisfies the interface with poll", () => {
    const source: TriggerSource = {
      sourceId: "test-source",
      start() {},
      stop() {},
      async poll(_since: string | null) {
        return [];
      },
    };
    expect(source.sourceId).toBe("test-source");
    expect(typeof source.start).toBe("function");
    expect(typeof source.stop).toBe("function");
    expect(typeof source.poll).toBe("function");
  });

  it("satisfies the interface without poll (optional)", () => {
    const source: TriggerSource = {
      sourceId: "no-poll",
      start() {},
      stop() {},
    };
    expect(source.poll).toBeUndefined();
  });
});

describe("TriggerEngineOptions type shape", () => {
  it("is constructible with required fields", () => {
    // Type-level test: ensure the shape compiles
    const opts: TriggerEngineOptions = {
      turnDispatcher: {} as any,
      taskStore: {} as any,
      log: {} as any,
      config: {
        replayMaxAgeMs: 86_400_000,
        dedupLruSize: 10_000,
        defaultDebounceMs: 5_000,
      },
    };
    expect(opts.config.replayMaxAgeMs).toBe(86_400_000);
    expect(opts.config.dedupLruSize).toBe(10_000);
    expect(opts.config.defaultDebounceMs).toBe(5_000);
  });
});
