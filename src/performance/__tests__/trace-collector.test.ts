import { describe, it, expect, beforeEach, vi } from "vitest";
import { TraceCollector } from "../trace-collector.js";
import type { TraceStore } from "../trace-store.js";
import type { TurnRecord } from "../types.js";

/**
 * Minimal mock TraceStore for Wave 0 scaffolding.
 *
 * Captures every `writeTurn` invocation so we can inspect the
 * committed TurnRecord shape, metadata passthrough, and freeze semantics.
 */
function createMockStore(): {
  store: TraceStore;
  writeTurn: ReturnType<typeof vi.fn>;
} {
  const writeTurn = vi.fn();
  const store = {
    writeTurn,
    pruneOlderThan: vi.fn().mockReturnValue(0),
    close: vi.fn(),
    getPercentiles: vi.fn().mockReturnValue([]),
  } as unknown as TraceStore;
  return { store, writeTurn };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

describe("TraceCollector", () => {
  let store: TraceStore;
  let writeTurn: ReturnType<typeof vi.fn>;
  let collector: TraceCollector;

  beforeEach(() => {
    const mock = createMockStore();
    store = mock.store;
    writeTurn = mock.writeTurn;
    collector = new TraceCollector(store, createMockLogger());
  });

  it("startTurn returns a Turn with the given id and agent", () => {
    const turn = collector.startTurn("msg-123", "alpha", "channel-1");
    expect(turn).toBeDefined();
    // Turn should expose readable identity — either via public fields or accessor
    const turnAny = turn as unknown as { id?: string; agent?: string; channelId?: string | null };
    expect(turnAny.id ?? (turn as any).turnId).toBe("msg-123");
    expect(turnAny.agent).toBe("alpha");
    expect(turnAny.channelId).toBe("channel-1");
  });

  it("Turn.startSpan returns a Span object", () => {
    const turn = collector.startTurn("msg-1", "alpha", null);
    const span = turn.startSpan("receive");
    expect(span).toBeDefined();
    expect(typeof (span as unknown as { end: () => void }).end).toBe("function");
  });

  it("span.end() records a duration_ms > 0", async () => {
    const turn = collector.startTurn("msg-1", "alpha", null);
    const span = turn.startSpan("receive");
    await new Promise((r) => setTimeout(r, 2));
    span.end();
    turn.end("success");

    expect(writeTurn).toHaveBeenCalledTimes(1);
    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    const receiveSpan = written.spans.find((s) => s.name === "receive");
    expect(receiveSpan).toBeDefined();
    expect(receiveSpan!.durationMs).toBeGreaterThan(0);
  });

  it("turn.end() commits all spans in a single writeTurn call", () => {
    const turn = collector.startTurn("msg-1", "alpha", null);
    const s1 = turn.startSpan("receive");
    s1.end();
    const s2 = turn.startSpan("context_assemble");
    s2.end();
    const s3 = turn.startSpan("first_token");
    s3.end();
    turn.end("success");

    expect(writeTurn).toHaveBeenCalledTimes(1);
    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.spans.length).toBe(3);
    const names = written.spans.map((s) => s.name).sort();
    expect(names).toEqual(["context_assemble", "first_token", "receive"]);
  });

  it("turn.end() freezes the committed TurnRecord", () => {
    const turn = collector.startTurn("msg-1", "alpha", null);
    const s1 = turn.startSpan("receive");
    s1.end();
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(Object.isFrozen(written)).toBe(true);
    expect(Object.isFrozen(written.spans)).toBe(true);
  });

  it("turn.end('error') records status='error'", () => {
    const turn = collector.startTurn("msg-1", "alpha", null);
    const s1 = turn.startSpan("receive");
    s1.end();
    turn.end("error");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.status).toBe("error");
  });

  it("metadata JSON is passed through per span", () => {
    const turn = collector.startTurn("msg-1", "alpha", null);
    const span = turn.startSpan("tool_call.memory_lookup", { tool: "memory_lookup", len: 42 });
    span.end();
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    const toolSpan = written.spans.find((s) => s.name === "tool_call.memory_lookup");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.metadata).toMatchObject({ tool: "memory_lookup", len: 42 });
  });
});

describe("Turn.recordCacheUsage (Phase 52)", () => {
  let store: TraceStore;
  let writeTurn: ReturnType<typeof vi.fn>;
  let collector: TraceCollector;

  beforeEach(() => {
    const mock = createMockStore();
    store = mock.store;
    writeTurn = mock.writeTurn;
    collector = new TraceCollector(store, createMockLogger());
  });

  it("Turn.recordCacheUsage stores snapshot and includes it in the written TurnRecord", () => {
    const turn = collector.startTurn("msg-cache-1", "alpha", null);
    turn.recordCacheUsage({
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 100,
      inputTokens: 50,
    });
    turn.end("success");

    expect(writeTurn).toHaveBeenCalledTimes(1);
    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.cacheReadInputTokens).toBe(500);
    expect(written.cacheCreationInputTokens).toBe(100);
    expect(written.inputTokens).toBe(50);
  });

  it("Turn.recordCacheUsage is idempotent — second call overwrites first", () => {
    const turn = collector.startTurn("msg-cache-2", "alpha", null);
    turn.recordCacheUsage({
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 50,
      inputTokens: 25,
    });
    // Second call overwrites.
    turn.recordCacheUsage({
      cacheReadInputTokens: 999,
      cacheCreationInputTokens: 1,
      inputTokens: 1,
    });
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.cacheReadInputTokens).toBe(999);
    expect(written.cacheCreationInputTokens).toBe(1);
    expect(written.inputTokens).toBe(1);
  });

  it("Turn without recordCacheUsage produces a TurnRecord with undefined cache fields", () => {
    const turn = collector.startTurn("msg-no-cache", "alpha", null);
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.cacheReadInputTokens).toBeUndefined();
    expect(written.cacheCreationInputTokens).toBeUndefined();
    expect(written.inputTokens).toBeUndefined();
    expect(written.prefixHash).toBeUndefined();
    expect(written.cacheEvictionExpected).toBeUndefined();
  });
});

describe("Turn.toolCache (Phase 55)", () => {
  let store: TraceStore;
  let collector: TraceCollector;

  beforeEach(() => {
    const mock = createMockStore();
    store = mock.store;
    collector = new TraceCollector(store, createMockLogger());
  });

  it("Test 13: toolCache getter returns the same instance across calls (lazy singleton per Turn)", () => {
    const turn = collector.startTurn("msg-tc-1", "alpha", null);
    const c1 = turn.toolCache;
    const c2 = turn.toolCache;
    expect(c1).toBe(c2);
  });

  it("Test 14: two different Turns have independent toolCache instances (no cross-turn state)", () => {
    const turnA = collector.startTurn("msg-tc-a", "alpha", null);
    const turnB = collector.startTurn("msg-tc-b", "alpha", null);
    const cA = turnA.toolCache;
    const cB = turnB.toolCache;
    expect(cA).not.toBe(cB);

    // Writes on one turn do not appear on the other.
    cA.set("memory_lookup", { q: "foo" }, { hit: "A" });
    expect(cB.get("memory_lookup", { q: "foo" })).toBeUndefined();
  });

  it("Test 15: after turn.end(), a NEW turn has a fresh empty toolCache — zero cross-turn leak", () => {
    const turnA = collector.startTurn("msg-leak-a", "alpha", null);
    turnA.toolCache.set("memory_lookup", { q: "foo" }, { hit: "value-A" });
    expect(turnA.toolCache.get("memory_lookup", { q: "foo" })).toEqual({ hit: "value-A" });
    turnA.end("success");

    // Brand-new turn from the same collector — must have an empty cache.
    const turnB = collector.startTurn("msg-leak-b", "alpha", null);
    expect(turnB.toolCache.get("memory_lookup", { q: "foo" })).toBeUndefined();
    expect(turnB.toolCache.hitCount()).toBe(0);
  });

  it("toolCache is lazy — constructing a Turn does not allocate a cache up front", () => {
    const turn = collector.startTurn("msg-lazy", "alpha", null);
    // We cannot directly introspect the private field without touching internals,
    // but we can at least verify that calling the getter works even after end().
    // (More importantly: `_toolCache` remains undefined until first read.)
    const privateField = (turn as unknown as { _toolCache?: unknown })._toolCache;
    expect(privateField).toBeUndefined();
    // Now force construction
    turn.toolCache.set("memory_lookup", { q: "x" }, 1);
    const afterAccess = (turn as unknown as { _toolCache?: unknown })._toolCache;
    expect(afterAccess).toBeDefined();
  });
});
