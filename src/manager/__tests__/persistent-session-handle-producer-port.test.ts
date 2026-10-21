/**
 * Phase 115 Plan 08 T01 — production-path producer-call integration test.
 *
 * Closes the loop on the silent-path-bifurcation regression (DEFERRED.md):
 * Phase 115-08 wired producers into `session-adapter.ts:iterateWithTracing`
 * (test-only path) but NOT into `persistent-session-handle.ts:iterateUntilResult`
 * (production path), so the `tool_execution_ms`, `tool_roundtrip_ms`, and
 * `parallel_tool_call_count` columns in traces.db stayed NULL fleet-wide.
 *
 * Quick task 260512 ported the producer call sites into the production path.
 * This test exercises the real `iterateUntilResult` via `createPersistentSessionHandle`
 * with a synthetic SDK iterator that emits a tool_use → tool_result → result
 * sequence, and asserts the TurnRecord persisted by TraceStore.writeTurn
 * carries non-zero values on all three split-latency fields.
 *
 * Anti-pattern guard (paired with producer-call-sites-sentinel.test.ts):
 *   - Static-grep sentinel pins the call-site presence in source.
 *   - This integration test pins the BEHAVIOR end-to-end.
 *
 * Pair-with reference:
 *   src/performance/__tests__/trace-collector-split-latency.test.ts
 *   src/manager/__tests__/persistent-session-handle.test.ts
 */

import { describe, it, expect, vi } from "vitest";
import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import type { SdkModule, SdkQuery, SdkStreamMessage } from "../sdk-types.js";
import { TraceCollector, type Turn } from "../../performance/trace-collector.js";
import type { TraceStore } from "../../performance/trace-store.js";
import type { TurnRecord } from "../../performance/types.js";

// ---------------------------------------------------------------------------
// Mirror the harness shape from persistent-session-handle.test.ts (minimal).
// ---------------------------------------------------------------------------

interface FakeQueryController {
  query: SdkQuery;
  pushMessage: (msg: SdkStreamMessage) => void;
  endStream: () => void;
}

function createFakeQuery(promptIterable: AsyncIterable<unknown>): FakeQueryController {
  const pending: SdkStreamMessage[] = [];
  let msgWaiter: ((r: IteratorResult<SdkStreamMessage>) => void) | null = null;
  let streamEnded = false;

  // Drain the prompt iterable in the background — same as the production
  // SDK does — so the handle's inputQueue.push doesn't deadlock.
  (async () => {
    try {
      for await (const _ of promptIterable) {
        // discard; we only need to keep the iterable alive.
      }
    } catch {
      // ignore
    }
  })();

  const pushMessage = (msg: SdkStreamMessage): void => {
    if (msgWaiter) {
      const w = msgWaiter;
      msgWaiter = null;
      w({ value: msg, done: false });
      return;
    }
    pending.push(msg);
  };

  const endStream = (): void => {
    streamEnded = true;
    if (msgWaiter) {
      const w = msgWaiter;
      msgWaiter = null;
      w({ value: undefined as unknown as SdkStreamMessage, done: true });
    }
  };

  const next = (): Promise<IteratorResult<SdkStreamMessage>> =>
    new Promise((resolve) => {
      if (pending.length > 0) {
        resolve({ value: pending.shift()!, done: false });
        return;
      }
      if (streamEnded) {
        resolve({ value: undefined as unknown as SdkStreamMessage, done: true });
        return;
      }
      msgWaiter = resolve;
    });

  const query = {
    [Symbol.asyncIterator]() {
      return { next };
    },
    next,
    return: async () => ({ value: undefined, done: true as const }),
    throw: async (err: unknown) => {
      throw err;
    },
    interrupt: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => undefined),
    streamInput: vi.fn(() => Promise.resolve()),
    mcpServerStatus: vi.fn(() => Promise.resolve([])),
    setMcpServers: vi.fn(() => Promise.resolve(undefined)),
    setMaxThinkingTokens: vi.fn(() => Promise.resolve(undefined)),
    setModel: vi.fn(() => Promise.resolve(undefined)),
    setPermissionMode: vi.fn(() => Promise.resolve(undefined)),
  } as unknown as SdkQuery;

  return { query, pushMessage, endStream };
}

function buildHarness(): {
  sdkMock: { query: ReturnType<typeof vi.fn> };
  getController: () => FakeQueryController;
} {
  let controller: FakeQueryController | null = null;
  const query = vi.fn((params: { prompt: unknown }) => {
    const iterable = params.prompt as AsyncIterable<unknown>;
    controller = createFakeQuery(iterable);
    return controller.query;
  });
  return {
    sdkMock: { query },
    getController: () => {
      if (!controller) throw new Error("FakeQuery not yet created");
      return controller;
    },
  };
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 115-08 producer port — production iterateUntilResult populates traces.db split-latency columns", () => {
  it("single tool_use → tool_result → result populates toolExecutionMs, toolRoundtripMs, parallelToolCallCount", async () => {
    const { sdkMock, getController } = buildHarness();
    const { store, writeTurn } = createMockStore();
    const collector = new TraceCollector(store, createMockLogger());
    const turn: Turn = collector.startTurn("msg-port-1", "alpha", null);

    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      {},
      "sess-port-1",
    );

    const p = handle.sendAndCollect("trigger tool", turn);

    // Let the handle push the user message + start awaiting messages.
    await Promise.resolve();
    await Promise.resolve();

    const ctrl = getController();
    const TOOL_USE_ID = "toolu_test_01";

    // (1) Parent assistant message carrying ONE tool_use block. This opens
    //     the batch-roundtrip timer AND fires recordParallelToolCallCount(1).
    ctrl.pushMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "tool_use", id: TOOL_USE_ID, name: "test_tool", input: {} },
        ],
      },
    } as unknown as SdkStreamMessage);

    // Allow the assistant branch to drain.
    await new Promise((r) => setTimeout(r, 10));

    // (2) User message carrying the tool_result — closes the tool_call span
    //     and fires addToolExecutionMs.
    ctrl.pushMessage({
      type: "user",
      parent_tool_use_id: TOOL_USE_ID,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: TOOL_USE_ID,
            content: "ok",
          },
        ],
      },
    } as unknown as SdkStreamMessage);

    // Brief delay so addToolExecutionMs records a non-zero interval.
    await new Promise((r) => setTimeout(r, 10));

    // (3) Result message terminates the turn. closeAllSpans fires the
    //     final-batch fallback for addToolRoundtripMs (since no "next
    //     parent assistant" arrived to close the batch organically).
    ctrl.pushMessage({
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "sess-port-1",
    } as unknown as SdkStreamMessage);

    const text = await p;
    expect(text).toBe("done");

    // Commit the Turn — writeTurn fires synchronously with the final record.
    turn.end("success");

    expect(writeTurn).toHaveBeenCalledTimes(1);
    const written = writeTurn.mock.calls[0]![0] as TurnRecord;

    // Sub-scope 17(b): MAX parallel batch size observed = 1 (single tool_use).
    expect(written.parallelToolCallCount).toBe(1);
    // Sub-scope 17(a) execution-side: addToolExecutionMs fired on tool_result.
    expect(typeof written.toolExecutionMs).toBe("number");
    expect(written.toolExecutionMs!).toBeGreaterThan(0);
    // Sub-scope 17(a) roundtrip: addToolRoundtripMs fired via final-batch
    // fallback inside closeAllSpans (no second parent-assistant arrived).
    expect(typeof written.toolRoundtripMs).toBe("number");
    expect(written.toolRoundtripMs!).toBeGreaterThan(0);

    await handle.close();
  });

  it("parallel batch of 3 tool_use blocks records parallelToolCallCount = 3", async () => {
    const { sdkMock, getController } = buildHarness();
    const { store, writeTurn } = createMockStore();
    const collector = new TraceCollector(store, createMockLogger());
    const turn: Turn = collector.startTurn("msg-port-2", "alpha", null);

    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      {},
      "sess-port-2",
    );

    const p = handle.sendAndCollect("trigger parallel", turn);
    await Promise.resolve();
    await Promise.resolve();

    const ctrl = getController();
    const IDS = ["toolu_p_1", "toolu_p_2", "toolu_p_3"];

    // Parent assistant with 3 tool_use blocks dispatched in parallel.
    ctrl.pushMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: IDS.map((id) => ({
          type: "tool_use",
          id,
          name: "test_tool",
          input: {},
        })),
      },
    } as unknown as SdkStreamMessage);

    await new Promise((r) => setTimeout(r, 5));

    // Three tool_results land in any order.
    for (const id of IDS) {
      ctrl.pushMessage({
        type: "user",
        parent_tool_use_id: id,
        message: {
          content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
        },
      } as unknown as SdkStreamMessage);
    }

    await new Promise((r) => setTimeout(r, 5));

    ctrl.pushMessage({
      type: "result",
      subtype: "success",
      result: "done",
      session_id: "sess-port-2",
    } as unknown as SdkStreamMessage);

    await p;
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    expect(written.parallelToolCallCount).toBe(3);
    // Three execution intervals summed.
    expect(written.toolExecutionMs!).toBeGreaterThan(0);

    await handle.close();
  });

  it("text-only turn (no tool_use) leaves split-latency fields NULL", async () => {
    const { sdkMock, getController } = buildHarness();
    const { store, writeTurn } = createMockStore();
    const collector = new TraceCollector(store, createMockLogger());
    const turn: Turn = collector.startTurn("msg-port-3", "alpha", null);

    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      {},
      "sess-port-3",
    );

    const p = handle.sendAndCollect("simple question", turn);
    await Promise.resolve();
    await Promise.resolve();

    const ctrl = getController();
    ctrl.pushMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "hello" }] },
    } as unknown as SdkStreamMessage);
    ctrl.pushMessage({
      type: "result",
      subtype: "success",
      result: "hello",
      session_id: "sess-port-3",
    } as unknown as SdkStreamMessage);

    await p;
    turn.end("success");

    const written = writeTurn.mock.calls[0]![0] as TurnRecord;
    // Conditional spread in Turn.end() omits the fields when
    // parallelToolCallCount === 0 — TurnRecord lands them as undefined,
    // SQL column persists NULL.
    expect(written.toolExecutionMs).toBeUndefined();
    expect(written.toolRoundtripMs).toBeUndefined();
    expect(written.parallelToolCallCount).toBeUndefined();

    await handle.close();
  });
});
