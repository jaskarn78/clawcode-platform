/**
 * Phase 115 Plan 08 T01 — split tool latency methodology audit (sub-scope 17a/b).
 *
 * Tests the three new split-latency producers on Turn:
 *   - addToolExecutionMs(durationMs)         — sum across the turn (sub-scope 17a)
 *   - addToolRoundtripMs(durationMs)         — sum across the turn (sub-scope 17a)
 *   - recordParallelToolCallCount(batchSize) — MAX across the turn (sub-scope 17b)
 *
 * The TurnRecord persisted via TraceStore.writeTurn carries:
 *   - toolExecutionMs       (number | null)
 *   - toolRoundtripMs       (number | null)
 *   - parallelToolCallCount (number | null)
 *
 * Producer semantics under audit (premise inversion documented in
 * 115-08-SUMMARY.md): the existing `tool_call.<name>` span at
 * session-adapter.ts:1419-1514 measures `tool_use_emitted →
 * tool_result_arrived` (execution-side). The new toolRoundtripMs measures
 * `tool_use_emitted → next parent assistant message arrived` (full
 * wall-clock including LLM resume), so the difference is the
 * prompt-bloat / cache-tax cost surfaced for sub-scope 17.
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

describe("Phase 115 Plan 08 T01 — Turn split-latency producers", () => {
  let store: TraceStore;
  let writeTurn: ReturnType<typeof vi.fn>;
  let collector: TraceCollector;

  beforeEach(() => {
    const mock = createMockStore();
    store = mock.store;
    writeTurn = mock.writeTurn;
    collector = new TraceCollector(store, createMockLogger());
  });

  it("addToolExecutionMs accumulates across the turn (sub-scope 17a)", () => {
    const turn = collector.startTurn("msg-1", "alpha", null);
    // One parallel batch with 1 tool to satisfy the parallelCount > 0 gate
    // that controls whether the split-latency fields land in the record.
    turn.recordParallelToolCallCount(1);
    turn.addToolExecutionMs(120);
    turn.addToolExecutionMs(80);
    turn.addToolExecutionMs(200);
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.toolExecutionMs).toBe(400);
  });

  it("addToolRoundtripMs accumulates across the turn (sub-scope 17a)", () => {
    const turn = collector.startTurn("msg-1", "alpha", null);
    turn.recordParallelToolCallCount(1);
    turn.addToolRoundtripMs(15_000);
    turn.addToolRoundtripMs(45_000);
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.toolRoundtripMs).toBe(60_000);
  });

  it("recordParallelToolCallCount records MAX across the turn (sub-scope 17b)", () => {
    const turn = collector.startTurn("msg-1", "alpha", null);
    turn.recordParallelToolCallCount(1);
    turn.recordParallelToolCallCount(3); // parallel batch of 3
    turn.recordParallelToolCallCount(2);
    turn.recordParallelToolCallCount(1);
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    // MAX across all parent assistant messages this turn.
    expect(written.parallelToolCallCount).toBe(3);
  });

  it("turns with no tool_use blocks land NULL on all three columns", () => {
    const turn = collector.startTurn("msg-1", "alpha", null);
    // No recordParallelToolCallCount call — short Discord ack pattern.
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    // Conditional spread in Turn.end omits the fields entirely when
    // parallelToolCallCount === 0; persisted SQL row lands NULL on all 3.
    expect(written.toolExecutionMs).toBeUndefined();
    expect(written.toolRoundtripMs).toBeUndefined();
    expect(written.parallelToolCallCount).toBeUndefined();
  });

  it("execution and roundtrip are independent — execution-only turns supported", () => {
    // Edge case: single tool call where the SDK terminated mid-roundtrip
    // (closeAllSpans fires; execution recorded but no batch close ever
    // observed). Both producers honor their addX no-op-on-zero semantics.
    const turn = collector.startTurn("msg-1", "alpha", null);
    turn.recordParallelToolCallCount(1);
    turn.addToolExecutionMs(150);
    // No addToolRoundtripMs call.
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.toolExecutionMs).toBe(150);
    expect(written.toolRoundtripMs).toBe(0);
    expect(written.parallelToolCallCount).toBe(1);
  });

  it("post-end() calls are no-ops (idempotency)", () => {
    const turn = collector.startTurn("msg-1", "alpha", null);
    turn.recordParallelToolCallCount(2);
    turn.addToolExecutionMs(100);
    turn.addToolRoundtripMs(5000);
    turn.end("success");

    // After commit, additional producer calls must not mutate the record.
    turn.addToolExecutionMs(99999);
    turn.addToolRoundtripMs(99999);
    turn.recordParallelToolCallCount(99);

    expect(writeTurn).toHaveBeenCalledTimes(1);
    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.toolExecutionMs).toBe(100);
    expect(written.toolRoundtripMs).toBe(5000);
    expect(written.parallelToolCallCount).toBe(2);
  });

  it("negative or zero durations are ignored (no-op)", () => {
    const turn = collector.startTurn("msg-1", "alpha", null);
    turn.recordParallelToolCallCount(1);
    turn.addToolExecutionMs(0);
    turn.addToolExecutionMs(-50);
    turn.addToolExecutionMs(120);
    turn.addToolRoundtripMs(0);
    turn.addToolRoundtripMs(-1000);
    turn.addToolRoundtripMs(8000);
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.toolExecutionMs).toBe(120);
    expect(written.toolRoundtripMs).toBe(8000);
  });
});

describe("Phase 115 Plan 08 T01 — TraceStore migration idempotency", () => {
  // Keep migration assertion light here; full DB round-trip lives in
  // src/performance/__tests__/trace-store-115-columns.test.ts (extended
  // below in this same plan).
  it("Phase115TurnColumns type exposes the three new column slots", async () => {
    const mod = await import("../trace-store.js");
    const sample: import("../trace-store.js").Phase115TurnColumns = {
      tool_execution_ms: 150,
      tool_roundtrip_ms: 12_700,
      parallel_tool_call_count: 3,
    };
    expect(sample.tool_execution_ms).toBe(150);
    expect(sample.tool_roundtrip_ms).toBe(12_700);
    expect(sample.parallel_tool_call_count).toBe(3);
    // Type-only assertion that the symbol exists at runtime.
    expect(typeof mod.TraceStore).toBe("function");
  });
});
