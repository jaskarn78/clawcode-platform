/**
 * Phase 115 Plan 08 T03 — parallel-tool-call counter (sub-scope 17b).
 *
 * Validates the per-turn `parallel_tool_call_count` semantics: MAX
 * across all parent assistant messages in the turn. Sequential-only
 * turns land 1; turns with at least one N-block parallel batch land N.
 *
 * Producer wiring lives in `src/manager/session-adapter.ts`
 * `iterateWithTracing` (line ~1393-1402, ~1419-1438): the per-message
 * `toolUseCount` scan calls `Turn.recordParallelToolCallCount` for any
 * parent assistant message that emits ≥1 tool_use block. T01's tests
 * cover the Turn-side accumulator; this test pins the sub-scope 17b
 * behavioral semantics (0 / 1 / 3 / sequential-of-1) at the producer
 * boundary.
 *
 * The wiring sentinel asserts `recordParallelToolCallCount` exists
 * on Turn (a static-grep-ish check that the producer hook is callable
 * by session-adapter.ts).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TraceCollector } from "../trace-collector.js";
import type { TraceStore } from "../trace-store.js";
import type { TurnRecord } from "../types.js";

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

describe("Phase 115 Plan 08 T03 — parallel-tool-call counter (sub-scope 17b)", () => {
  let store: TraceStore;
  let writeTurn: ReturnType<typeof vi.fn>;
  let collector: TraceCollector;

  beforeEach(() => {
    const mock = createMockStore();
    store = mock.store;
    writeTurn = mock.writeTurn;
    collector = new TraceCollector(store, createMockLogger());
  });

  it("0 tool_use blocks → no count recorded → NULL on the column", () => {
    const turn = collector.startTurn("msg-no-tools", "alpha", null);
    // Producer (session-adapter) only calls recordParallelToolCallCount
    // when toolUseCount > 0. Simulate by simply not calling it.
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.parallelToolCallCount).toBeUndefined();
  });

  it("1 tool_use block → count = 1 (sequential single-call)", () => {
    const turn = collector.startTurn("msg-one-tool", "alpha", null);
    // Producer scans contentBlocks, finds 1 tool_use, records 1.
    turn.recordParallelToolCallCount(1);
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.parallelToolCallCount).toBe(1);
  });

  it("3 tool_use blocks in same assistant message → count = 3 (parallel batch)", () => {
    const turn = collector.startTurn("msg-parallel-batch", "alpha", null);
    // Producer scans one message, finds 3 tool_use blocks → records 3.
    turn.recordParallelToolCallCount(3);
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.parallelToolCallCount).toBe(3);
  });

  it("sequential turns each with 1 tool → MAX stays 1 (not aggregated)", () => {
    // Multi-batch turn with ALL batches being single-tool-sequential.
    // Wave-clock semantic: the column is MAX, not SUM, so 4 sequential
    // batches of 1 still land 1.
    const turn = collector.startTurn("msg-sequential", "alpha", null);
    turn.recordParallelToolCallCount(1);
    turn.recordParallelToolCallCount(1);
    turn.recordParallelToolCallCount(1);
    turn.recordParallelToolCallCount(1);
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.parallelToolCallCount).toBe(1);
  });

  it("mixed batches → MAX is the largest single batch (not the SUM)", () => {
    // Turn with 3 batches: [1, 5, 2]. MAX = 5; sub-scope 17b's signal
    // is "did the agent ever issue a parallel batch this turn", not
    // "how many tool calls total" — those are the lazy_recall_call_count
    // and tool_execution_ms columns respectively.
    const turn = collector.startTurn("msg-mixed", "alpha", null);
    turn.recordParallelToolCallCount(1);
    turn.recordParallelToolCallCount(5); // big parallel batch
    turn.recordParallelToolCallCount(2);
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.parallelToolCallCount).toBe(5);
  });

  it("post-end() recordParallelToolCallCount is a no-op", () => {
    const turn = collector.startTurn("msg-after-end", "alpha", null);
    turn.recordParallelToolCallCount(2);
    turn.end("success");

    // Late call must NOT mutate the persisted record.
    turn.recordParallelToolCallCount(99);

    expect(writeTurn).toHaveBeenCalledTimes(1);
    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.parallelToolCallCount).toBe(2);
  });

  it("recording 0 batchSize is a no-op (does not flip turn into has-tools state)", () => {
    // Defensive: producer should never call with 0, but if it did, the
    // accumulator should not promote the turn from "no-tools" to "had-tools".
    const turn = collector.startTurn("msg-zero", "alpha", null);
    turn.recordParallelToolCallCount(0);
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    // parallelToolCallCount remains 0 → the conditional spread in
    // Turn.end() omits all three split-latency fields → undefined.
    expect(written.parallelToolCallCount).toBeUndefined();
    expect(written.toolExecutionMs).toBeUndefined();
    expect(written.toolRoundtripMs).toBeUndefined();
  });

  it("producer hook exists on Turn — wiring sentinel for session-adapter.ts:1402", () => {
    // Static-grep-equivalent runtime check: the producer method that
    // session-adapter.ts iterateWithTracing calls MUST exist on Turn.
    // If this fails, the wiring at session-adapter.ts:1402 silently
    // becomes a no-op via the optional-chaining cast.
    const turn = collector.startTurn("msg-1", "alpha", null);
    expect(typeof (turn as any).recordParallelToolCallCount).toBe("function");
    // And the two companion methods (T01 sub-scope 17a producers).
    expect(typeof (turn as any).addToolExecutionMs).toBe("function");
    expect(typeof (turn as any).addToolRoundtripMs).toBe("function");
  });
});
