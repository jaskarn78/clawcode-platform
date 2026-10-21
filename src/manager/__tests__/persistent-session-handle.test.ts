import { describe, it, expect, vi } from "vitest";

/**
 * Phase 73 Plan 01 Task 2 — RED tests for createPersistentSessionHandle.
 *
 * Verifies the persistent-per-agent SDK session contract:
 *   - ONE sdk.query({ prompt: asyncIterable }) call per handle lifetime
 *   - Depth-1 serial turn queue; 3rd concurrent send rejects QUEUE_FULL
 *   - Message ordering preserved across rapid sendAndStream calls
 *   - SessionHandle surface byte-identical to the v2.0 contract
 *   - Abort mid-turn races interrupt() + 2s deadline
 *   - Generator throw fires onError; in-flight sendAndStream rejects
 */

import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import type { SdkModule, SdkQuery, SdkStreamMessage } from "../sdk-types.js";
// Finding 1 (260714-mkq review) — the raced-result regression asserts the
// classifier decision END-TO-END (mutating in-flight tool → "notify").
import {
  decideWedgeRecovery,
  type WedgeInfo,
} from "../tool-mutation-classifier.js";

// ---------------------------------------------------------------------------
// FakeQuery helper — hand-rolled AsyncGenerator with push-based control.
// ---------------------------------------------------------------------------

type FakeQueryController = {
  readonly query: SdkQuery;
  /** Push one SDK message into the stream the handle consumes. */
  pushMessage: (msg: SdkStreamMessage) => void;
  /** Resolve the generator (no more messages). */
  endStream: () => void;
  /** Throw an error from the generator — simulates subprocess death. */
  throwFromGenerator: (err: Error) => void;
  /** Observe user messages that the SDK "received" (pushed into prompt iterable). */
  receivedUserMessages: string[];
  /** Spies on the Query control methods. */
  interrupt: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  /** Work-stream (C), FORK 8 — backgroundTasks / stopTask spies. */
  backgroundTasks: ReturnType<typeof vi.fn>;
  stopTask: ReturnType<typeof vi.fn>;
};

function createFakeQuery(
  promptIterable: AsyncIterable<unknown>,
): FakeQueryController {
  // Message queue the generator yields from.
  const pending: SdkStreamMessage[] = [];
  let msgWaiter: ((r: IteratorResult<SdkStreamMessage>) => void) | null = null;
  let msgError: ((err: Error) => void) | null = null;
  let streamEnded = false;
  const receivedUserMessages: string[] = [];

  // Drain the prompt iterable into receivedUserMessages so tests can observe
  // what the SDK "saw" (i.e., what the handle pushed via AsyncPushQueue).
  void (async () => {
    try {
      for await (const m of promptIterable) {
        const msg = m as { message?: { content?: unknown } };
        const content = msg?.message?.content;
        if (typeof content === "string") {
          receivedUserMessages.push(content);
        } else {
          receivedUserMessages.push(JSON.stringify(content));
        }
      }
    } catch {
      // ignore — prompt iterable closed abnormally
    }
  })();

  const pushMessage = (msg: SdkStreamMessage): void => {
    if (msgWaiter) {
      const w = msgWaiter;
      msgWaiter = null;
      msgError = null;
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
      msgError = null;
      w({ value: undefined as unknown as SdkStreamMessage, done: true });
    }
  };

  const throwFromGenerator = (err: Error): void => {
    if (msgError) {
      const reject = msgError;
      msgWaiter = null;
      msgError = null;
      reject(err);
      return;
    }
    // If no pending next(), schedule the throw for the next .next() call.
    streamEnded = true;
    pending.push({ __throw: err } as unknown as SdkStreamMessage);
  };

  const next = (): Promise<IteratorResult<SdkStreamMessage>> =>
    new Promise<IteratorResult<SdkStreamMessage>>((resolve, reject) => {
      if (pending.length > 0) {
        const m = pending.shift()!;
        if ((m as unknown as { __throw?: Error }).__throw) {
          reject((m as unknown as { __throw: Error }).__throw);
          return;
        }
        resolve({ value: m, done: false });
        return;
      }
      if (streamEnded) {
        resolve({ value: undefined as unknown as SdkStreamMessage, done: true });
        return;
      }
      msgWaiter = resolve;
      msgError = reject;
    });

  const interrupt = vi.fn(() => Promise.resolve());
  const close = vi.fn(() => undefined);
  // Work-stream (C), FORK 8 — `backgroundTasks` spy. Default behaviour:
  // resolves `true` (a detach succeeded). Tests override via
  // `.mockResolvedValueOnce(false)` / `.mockRejectedValueOnce(...)` to
  // drive the force-release fallback branches.
  const backgroundTasks = vi.fn(() => Promise.resolve(true));
  const stopTask = vi.fn(() => Promise.resolve());

  // Build a minimal object that satisfies the Query shape used by the handle.
  const query = {
    [Symbol.asyncIterator]() {
      return { next };
    },
    next,
    return: async () => ({ value: undefined, done: true as const }),
    throw: async (err: unknown) => {
      throw err;
    },
    interrupt,
    close,
    streamInput: vi.fn(() => Promise.resolve()),
    mcpServerStatus: vi.fn(() => Promise.resolve([])),
    setMcpServers: vi.fn(() => Promise.resolve(undefined)),
    // Phase 83 EFFORT-01 — setEffort() invokes this on the Query handle.
    setMaxThinkingTokens: vi.fn(() => Promise.resolve(undefined)),
    // Phase 86 MODEL-03 — setModel() invokes this on the Query handle.
    // Mirrors the Phase 83 Rule-3 fix-ahead pattern so existing "surface
    // byte-identical" tests don't crash the first time a downstream test
    // exercises the setModel wire.
    setModel: vi.fn(() => Promise.resolve(undefined)),
    // Phase 87 CMD-02 — setPermissionMode() invokes this on the Query handle.
    // Extends the Phase 83/86 Rule-3 fix-ahead pattern so the surface-check
    // test doesn't crash downstream callers that exercise the new wire.
    setPermissionMode: vi.fn(() => Promise.resolve(undefined)),
    // Work-stream (C), FORK 8 — `tryBackgroundOrRelease()` invokes these.
    backgroundTasks,
    stopTask,
  } as unknown as SdkQuery;

  return {
    query,
    pushMessage,
    endStream,
    throwFromGenerator,
    receivedUserMessages,
    interrupt,
    close,
    backgroundTasks,
    stopTask,
  };
}

/** Emit a stock { assistant → result } sequence for a given turn. */
function emitStockTurn(
  ctrl: FakeQueryController,
  opts: { readonly text: string; readonly sessionId: string },
): void {
  ctrl.pushMessage({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text: opts.text }] },
  } as unknown as SdkStreamMessage);
  ctrl.pushMessage({
    type: "result",
    subtype: "success",
    result: opts.text,
    session_id: opts.sessionId,
  } as unknown as SdkStreamMessage);
}

// ---------------------------------------------------------------------------
// Shared harness: build an SdkModule whose query() returns our FakeQuery.
// Expose the controller + the mock function so tests can assert behavior.
// ---------------------------------------------------------------------------

function buildHarness(): {
  sdkMock: { query: ReturnType<typeof vi.fn> };
  getController: () => FakeQueryController;
} {
  let controller: FakeQueryController | null = null;
  const query = vi.fn((params: { prompt: unknown; options?: unknown }) => {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPersistentSessionHandle", () => {
  it("N sendAndStream calls → exactly one sdk.query invocation", async () => {
    const { sdkMock, getController } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      { model: "sonnet" },
      "sess-1",
    );

    // Drive 5 turns sequentially; the controller replies to each.
    for (let i = 0; i < 5; i++) {
      const p = handle.sendAndStream(
        `msg-${i}`,
        () => undefined,
      );
      // Give the handle a microtask to push the user message + start awaiting.
      await Promise.resolve();
      await Promise.resolve();
      emitStockTurn(getController(), { text: `reply-${i}`, sessionId: "sess-1" });
      const result = await p;
      expect(result).toBe(`reply-${i}`);
    }

    expect(sdkMock.query).toHaveBeenCalledTimes(1);
    expect(getController().receivedUserMessages.length).toBe(5);

    await handle.close();
  });

  it("sendAndStream with images → SDK user message carries text + image content blocks (CAM-01/02)", async () => {
    const { sdkMock, getController } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      { model: "sonnet" },
      "sess-img",
    );

    const p = handle.sendAndStream("describe this", () => undefined, undefined, {
      images: [{ mediaType: "image/png", data: "QUJD" }],
    });
    await Promise.resolve();
    await Promise.resolve();
    emitStockTurn(getController(), { text: "a cat", sessionId: "sess-img" });
    await p;

    const received = getController().receivedUserMessages;
    expect(received).toHaveLength(1);
    const content = JSON.parse(received[0]) as Array<Record<string, unknown>>;
    expect(content).toEqual([
      { type: "text", text: "describe this" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "QUJD" },
      },
    ]);

    await handle.close();
  });

  it("sendAndStream with NO images → SDK user message stays a plain string (no regression)", async () => {
    const { sdkMock, getController } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      { model: "sonnet" },
      "sess-str",
    );

    const p = handle.sendAndStream("plain text", () => undefined);
    await Promise.resolve();
    await Promise.resolve();
    emitStockTurn(getController(), { text: "ok", sessionId: "sess-str" });
    await p;

    // The harness captures string content verbatim (not JSON-stringified).
    expect(getController().receivedUserMessages).toEqual(["plain text"]);

    await handle.close();
  });

  it("SessionHandle surface is byte-identical to the v2.0 contract (+ quick-task 260419-nic extensions)", async () => {
    const { sdkMock } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      {},
      "sess-surface",
    );
    expect(handle.sessionId).toBe("sess-surface");
    expect(typeof handle.send).toBe("function");
    expect(typeof handle.sendAndCollect).toBe("function");
    expect(typeof handle.sendAndStream).toBe("function");
    expect(typeof handle.close).toBe("function");
    expect(typeof handle.onError).toBe("function");
    expect(typeof handle.onEnd).toBe("function");
    expect(typeof handle.setEffort).toBe("function");
    expect(typeof handle.getEffort).toBe("function");
    // Phase 86 MODEL-03 — mid-session model mutation primitives.
    expect(typeof handle.setModel).toBe("function");
    expect(typeof handle.getModel).toBe("function");
    // Phase 87 CMD-02 — mid-session permission-mode mutation primitives.
    expect(typeof handle.setPermissionMode).toBe("function");
    expect(typeof handle.getPermissionMode).toBe("function");
    // quick-task 260419-nic — mid-turn interrupt primitives.
    expect(typeof handle.interrupt).toBe("function");
    expect(typeof handle.hasActiveTurn).toBe("function");
    // setEffort / getEffort round-trip
    handle.setEffort("high");
    expect(handle.getEffort()).toBe("high");
    await handle.close();
  });

  it("message ordering preserved under rapid sendAndStream calls", async () => {
    const { sdkMock, getController } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      {},
      "sess-order",
    );

    // Fire 3 turns back-to-back without awaiting. Each turn queues up.
    const p1 = handle.sendAndStream("msg-A", () => undefined);
    const p2 = handle.sendAndStream("msg-B", () => undefined);
    // 3rd concurrent call exceeds depth-1 → QUEUE_FULL
    const p3 = handle.sendAndStream("msg-C", () => undefined);

    await expect(p3).rejects.toThrow("QUEUE_FULL");

    // Let p1's push happen.
    await Promise.resolve();
    await Promise.resolve();
    emitStockTurn(getController(), { text: "reply-A", sessionId: "sess-order" });
    await expect(p1).resolves.toBe("reply-A");

    // Now p2 should push and run.
    await Promise.resolve();
    await Promise.resolve();
    emitStockTurn(getController(), { text: "reply-B", sessionId: "sess-order" });
    await expect(p2).resolves.toBe("reply-B");

    // Observed user-message order on the SDK side matches call order.
    expect(getController().receivedUserMessages).toEqual(["msg-A", "msg-B"]);

    await handle.close();
  });

  it("QUEUE_FULL propagates from SerialTurnQueue when 3 concurrent sends arrive", async () => {
    const { sdkMock, getController } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      {},
      "sess-full",
    );

    const p1 = handle.sendAndStream("1", () => undefined);
    const p2 = handle.sendAndStream("2", () => undefined);
    const p3 = handle.sendAndStream("3", () => undefined);

    await expect(p3).rejects.toThrow("QUEUE_FULL");

    // Drain p1 + p2 so the test can exit cleanly.
    await Promise.resolve();
    await Promise.resolve();
    emitStockTurn(getController(), { text: "r1", sessionId: "sess-full" });
    await p1;
    await Promise.resolve();
    await Promise.resolve();
    emitStockTurn(getController(), { text: "r2", sessionId: "sess-full" });
    await p2;

    await handle.close();
  });

  it("abort-during-turn calls interrupt() and rejects within the 2s deadline", async () => {
    const { sdkMock, getController } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      {},
      "sess-abort",
    );

    const controller = new AbortController();
    const p = handle.sendAndStream(
      "slow-msg",
      () => undefined,
      undefined,
      { signal: controller.signal },
    );

    // Let the handle push the user message and start awaiting the stream.
    await Promise.resolve();
    await Promise.resolve();

    // Abort BEFORE any message arrives. The handle should race interrupt()
    // and a 2s deadline; since the stream never produces a result, the
    // deadline path fires and throws an AbortError.
    const t0 = Date.now();
    controller.abort();

    // Expect the send to reject in under 2100ms.
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2500);

    expect(getController().interrupt).toHaveBeenCalledTimes(1);
    await handle.close();
  });

  it("generator throw → onError fires and in-flight sendAndStream rejects", async () => {
    const { sdkMock, getController } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      {},
      "sess-crash",
    );

    const errorHandler = vi.fn();
    handle.onError(errorHandler);

    const p = handle.sendAndStream("will-crash", () => undefined);
    await Promise.resolve();
    await Promise.resolve();

    // Simulate generator death.
    const crashErr = new Error("generator-dead");
    getController().throwFromGenerator(crashErr);

    await expect(p).rejects.toThrow(/generator-dead|crash/i);
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it("sdk.query options include resume + includePartialMessages", async () => {
    const { sdkMock } = buildHarness();
    createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      { model: "sonnet" },
      "sess-opts",
    );
    const args = sdkMock.query.mock.calls[0]![0];
    expect(args.options.resume).toBe("sess-opts");
    expect(args.options.includePartialMessages).toBe(true);
    expect(args.options.model).toBe("sonnet");
    // prompt is an AsyncIterable (not a string) — streaming input mode.
    expect(typeof args.prompt[Symbol.asyncIterator]).toBe("function");
  });

  it("close() ends the input iterable and is idempotent", async () => {
    const { sdkMock, getController } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      {},
      "sess-close",
    );
    await handle.close();
    await handle.close(); // idempotent
    expect(getController().close).toHaveBeenCalled();
    // Sends on a closed handle must throw.
    await expect(
      handle.sendAndStream("after-close", () => undefined),
    ).rejects.toThrow(/closed/i);
  });

  // ---------------------------------------------------------------------------
  // Quick task 260419-nic — public interrupt() + hasActiveTurn() primitives.
  // ---------------------------------------------------------------------------

  describe("interrupt() + hasActiveTurn() primitives", () => {
    it("A: handle exposes interrupt() and hasActiveTurn() on public surface", () => {
      const { sdkMock } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-surface-abc",
      );
      expect(typeof handle.interrupt).toBe("function");
      expect(typeof handle.hasActiveTurn).toBe("function");
    });

    it("B: hasActiveTurn() returns false on a fresh handle (no send yet)", () => {
      const { sdkMock } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-fresh",
      );
      expect(handle.hasActiveTurn()).toBe(false);
    });

    it("C: hasActiveTurn() returns true while sendAndStream awaits SDK, false after resolution", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-active",
      );

      const p = handle.sendAndStream("msg-C", () => undefined);
      // Two microticks for: (1) turnQueue.run slot install, (2) inputQueue.push +
      // iterateUntilResult entry awaiting driverIter.next().
      await Promise.resolve();
      await Promise.resolve();
      expect(handle.hasActiveTurn()).toBe(true);

      emitStockTurn(getController(), { text: "r-C", sessionId: "sess-active" });
      await p;
      expect(handle.hasActiveTurn()).toBe(false);

      await handle.close();
    });

    it("D: interrupt() with active turn fires q.interrupt() once; in-flight sendAndStream rejects with AbortError within 2500ms", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-interrupt-active",
      );

      const p = handle.sendAndStream("slow-msg", () => undefined);
      await Promise.resolve();
      await Promise.resolve();

      const t0 = Date.now();
      handle.interrupt();

      await expect(p).rejects.toMatchObject({ name: "AbortError" });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(2500);

      expect(getController().interrupt).toHaveBeenCalledTimes(1);
      await handle.close();
    });

    it("E: interrupt() with no active turn is a no-op (does not call q.interrupt())", () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-interrupt-idle",
      );
      // No send() issued → no active turn.
      expect(handle.hasActiveTurn()).toBe(false);
      // Must not throw, must not call q.interrupt().
      expect(() => handle.interrupt()).not.toThrow();
      // Controller exists because sdk.query is called inside the handle
      // factory (drives the long-lived generator).
      expect(getController().interrupt).not.toHaveBeenCalled();
    });

    it("F: interrupt() is idempotent — two calls during the same turn fire q.interrupt() only once", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-interrupt-idempotent",
      );

      const p = handle.sendAndStream("slow-msg", () => undefined);
      await Promise.resolve();
      await Promise.resolve();

      handle.interrupt();
      handle.interrupt();
      handle.interrupt();

      await expect(p).rejects.toMatchObject({ name: "AbortError" });
      expect(getController().interrupt).toHaveBeenCalledTimes(1);

      await handle.close();
    });

    it("G: close() makes subsequent interrupt() a hard no-op", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-interrupt-after-close",
      );
      await handle.close();
      const countBefore = getController().interrupt.mock.calls.length;
      expect(() => handle.interrupt()).not.toThrow();
      expect(handle.hasActiveTurn()).toBe(false);
      expect(getController().interrupt.mock.calls.length).toBe(countBefore);
    });
  });

  // Phase 124 follow-up — getTurnStartedAt() primitive for the
  // ERR_TURN_TOO_LONG safety budget in handleCompactSession.
  describe("getTurnStartedAt() primitive", () => {
    it("returns null on a fresh handle (no send yet)", () => {
      const { sdkMock } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-ts-fresh",
      );
      expect(handle.getTurnStartedAt).toBeDefined();
      expect(handle.getTurnStartedAt!()).toBeNull();
    });

    it("returns a ms-epoch number mid-turn, then null after the turn resolves", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-ts-resolve",
      );

      const t0 = Date.now();
      const p = handle.sendAndStream("hello", () => undefined);
      // Two microticks: (1) turnQueue.run slot install, (2) inner callback
      // runs and sets turnStartedAt before awaiting iterateUntilResult.
      await Promise.resolve();
      await Promise.resolve();

      const mid = handle.getTurnStartedAt!();
      expect(mid).not.toBeNull();
      expect(typeof mid).toBe("number");
      // Sanity: within a 5s window of the start (CI clock skew tolerance).
      expect(mid!).toBeGreaterThanOrEqual(t0);
      expect(mid! - t0).toBeLessThan(5000);

      emitStockTurn(getController(), {
        text: "r-ts",
        sessionId: "sess-ts-resolve",
      });
      await p;

      expect(handle.getTurnStartedAt!()).toBeNull();
      await handle.close();
    });

    it("clears to null after a turn rejects (AbortError path)", async () => {
      const { sdkMock } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-ts-reject",
      );

      const p = handle.sendAndStream("slow", () => undefined);
      await Promise.resolve();
      await Promise.resolve();
      expect(handle.getTurnStartedAt!()).not.toBeNull();

      handle.interrupt();
      await expect(p).rejects.toMatchObject({ name: "AbortError" });

      expect(handle.getTurnStartedAt!()).toBeNull();
      await handle.close();
    });

    it("returns null after close()", async () => {
      const { sdkMock } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-ts-closed",
      );
      await handle.close();
      expect(handle.getTurnStartedAt!()).toBeNull();
    });
  });

  // Debug session `in-tool-wedge-recovery` work-stream (B) — the handle
  // attaches a `WedgeInfo` to the thrown AbortError so the Discord recovery
  // layer can decide auto-rerun vs notify. Covers the two abort routes:
  // `forceReleaseTurn()` (the 999.64 heartbeat sweep) and `interrupt()`.
  describe("wedgeInfo surfacing on abort (work-stream B)", () => {
    /** Push a top-level assistant message carrying a single tool_use block. */
    function pushToolUse(
      ctrl: FakeQueryController,
      toolUseId: string,
      toolName: string,
    ): void {
      ctrl.pushMessage({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "tool_use", id: toolUseId, name: toolName }],
        },
      } as unknown as SdkStreamMessage);
    }

    it("forceReleaseTurn() while a tool is in flight → AbortError.wedgeInfo names the tool, reason sweep-force-release", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-wedge-tool",
      );

      const p = handle.sendAndStream("research please", () => undefined);
      await Promise.resolve();
      await Promise.resolve();

      // A top-level tool_use block opens — the tool is now "in flight".
      pushToolUse(getController(), "tu-1", "Read");
      // Let the handle consume the tool_use message.
      await Promise.resolve();
      await Promise.resolve();

      // The 999.64 heartbeat sweep reaches a wedged turn via forceReleaseTurn.
      const released = handle.forceReleaseTurn!();
      expect(released).toBe(true);

      const err = await p.catch((e: unknown) => e);
      expect((err as Error).name).toBe("AbortError");
      const wedgeInfo = (err as { wedgeInfo?: unknown }).wedgeInfo as {
        reason: string;
        inFlightToolNames: string[];
      };
      expect(wedgeInfo).toBeDefined();
      expect(wedgeInfo.reason).toBe("sweep-force-release");
      expect(wedgeInfo.inFlightToolNames).toEqual(["Read"]);

      await handle.close();
    });

    it("interrupt() with no tool in flight → wedgeInfo has an empty inFlightToolNames (pure-text hang)", async () => {
      const { sdkMock } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-wedge-text",
      );

      const p = handle.sendAndStream("write a long reply", () => undefined);
      await Promise.resolve();
      await Promise.resolve();

      // No tool_use block was emitted — pure-text hang. Abort via interrupt.
      handle.interrupt();

      const err = await p.catch((e: unknown) => e);
      expect((err as Error).name).toBe("AbortError");
      const wedgeInfo = (err as { wedgeInfo?: unknown }).wedgeInfo as {
        reason: string;
        inFlightToolNames: string[];
      };
      expect(wedgeInfo).toBeDefined();
      // No tool in flight — auto-retry-safe.
      expect(wedgeInfo.inFlightToolNames).toEqual([]);

      await handle.close();
    });

    it("forceReleaseTurn() captures a parallel tool batch — every in-flight tool name", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-wedge-batch",
      );

      const p = handle.sendAndStream("do many things", () => undefined);
      await Promise.resolve();
      await Promise.resolve();

      // A parallel batch — one assistant message with two tool_use blocks.
      getController().pushMessage({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "tool_use", id: "tu-a", name: "Read" },
            { type: "tool_use", id: "tu-b", name: "Bash" },
          ],
        },
      } as unknown as SdkStreamMessage);
      await Promise.resolve();
      await Promise.resolve();

      handle.forceReleaseTurn!();

      const err = await p.catch((e: unknown) => e);
      const wedgeInfo = (err as { wedgeInfo?: unknown }).wedgeInfo as {
        inFlightToolNames: string[];
      };
      expect(wedgeInfo.inFlightToolNames.sort()).toEqual(["Bash", "Read"]);

      await handle.close();
    });

    it("Finding 1 (260714-mkq): a raced result after a stall trip keeps the MUTATING in-flight tool visible → decideWedgeRecovery 'notify'", async () => {
      // Adversarial-review repro: a MUTATING tool (Bash) is in flight when the
      // stall tracker trips (max-pause ceiling). The SDK then emits a graceful
      // `result` INSIDE the 2s interrupt window (raced-result path), so the
      // success branch runs closeAllSpans() — draining pausedToolUseIds —
      // BEFORE the Part B no-masquerade guard throws. Without the trip-time
      // snapshot (lastStallInFlightToolNames), the catch read the drained live
      // map, produced inFlightToolNames: [], and decideWedgeRecovery silently
      // AUTO-RERAN the mutating request. This pins: the tool stays visible and
      // the classification is "notify".
      vi.useFakeTimers();
      try {
        const { sdkMock, getController } = buildHarness();
        const handle = createPersistentSessionHandle(
          sdkMock as unknown as SdkModule,
          // Short threshold keeps the tracker's tick interval small; the trip
          // itself comes from the DEFAULT 15-min max-pause ceiling (Bash is a
          // slow tool, so the pause suppresses the no-useful-tokens trip).
          { streamStallTimeoutMs: 1_000 },
          "sess-wedge-raced-result",
        );

        const p = handle.sendAndStream("mutate something", () => undefined);
        await vi.advanceTimersByTimeAsync(0);

        // Mutating tool_use opens — tracker pauses (slow ceiling, 15 min).
        pushToolUse(getController(), "tu-mut", "Bash");
        await vi.advanceTimersByTimeAsync(0);

        // Advance past the max-pause ceiling → tracker trips
        // (reason "max-pause-exceeded"), onStall snapshots ["Bash"] and fires
        // the interrupt (2s deadline armed but NOT advanced past).
        await vi.advanceTimersByTimeAsync(15 * 60_000 + 500);

        // RACED RESULT — a graceful `result` lands inside the interrupt
        // window. The success branch drains pausedToolUseIds via
        // closeAllSpans(), then the Part B guard throws AbortError.
        getController().pushMessage({
          type: "result",
          subtype: "success",
          result: "phantom clean completion",
          session_id: "sess-wedge-raced-result",
        } as unknown as SdkStreamMessage);

        const err = await p.catch((e: unknown) => e);
        expect((err as Error).name).toBe("AbortError");
        const wedgeInfo = (err as { wedgeInfo?: unknown }).wedgeInfo as WedgeInfo;
        expect(wedgeInfo).toBeDefined();
        expect(wedgeInfo.reason).toBe("max-pause-exceeded");
        // The trip-time snapshot — NOT the drained live map.
        expect([...wedgeInfo.inFlightToolNames]).toEqual(["Bash"]);
        // Load-bearing classification: a mutating wedge must NOT auto-rerun.
        expect(decideWedgeRecovery(wedgeInfo)).toBe("notify");

        vi.useRealTimers();
        await handle.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a clean turn (no abort) leaves no wedgeInfo and does not leak it into the next turn", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-wedge-clean",
      );

      // Turn 1 — wedge it with a tool in flight via forceReleaseTurn.
      const p1 = handle.sendAndStream("turn 1", () => undefined);
      await Promise.resolve();
      await Promise.resolve();
      pushToolUse(getController(), "tu-x", "Bash");
      await Promise.resolve();
      await Promise.resolve();
      handle.forceReleaseTurn!();
      await p1.catch(() => undefined);

      // Turn 2 — a clean turn. Its result must not carry a stale wedgeInfo,
      // and the turn must succeed normally (no leaked sweep snapshot).
      const p2 = handle.sendAndStream("turn 2", () => undefined);
      await Promise.resolve();
      await Promise.resolve();
      emitStockTurn(getController(), {
        text: "clean-result",
        sessionId: "sess-wedge-clean",
      });
      const result = await p2;
      expect(result).toBe("clean-result");

      await handle.close();
    });
  });

  // Debug session `in-tool-wedge-recovery` work-stream (C), FORK 8 —
  // `tryBackgroundOrRelease()`: cleanly DETACH a wedged Bash/Task tool via
  // `q.backgroundTasks` (the turn resumes — no abort) vs fall back to the
  // blunt `forceReleaseTurn` for an MCP-tool wedge / mixed batch / nothing
  // detached. The load-bearing assertion is the no-double-recovery
  // invariant: a detach must NOT abort the turn (no AbortError, no
  // wedgeInfo) so work-stream B's smart recovery does not also fire.
  describe("tryBackgroundOrRelease() — clean detach vs force-release (work-stream C)", () => {
    function pushToolUseC(
      ctrl: FakeQueryController,
      toolUseId: string,
      toolName: string,
    ): void {
      ctrl.pushMessage({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "tool_use", id: toolUseId, name: toolName }],
        },
      } as unknown as SdkStreamMessage);
    }

    it("DETACH path — a wedged Bash tool is backgrounded; the turn RESUMES (no AbortError, no wedgeInfo)", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-c-detach",
      );

      const p = handle.sendAndStream("run a long bash job", () => undefined);
      await Promise.resolve();
      await Promise.resolve();

      // A Bash tool is in flight — the turn is now wedged inside it.
      pushToolUseC(getController(), "tu-bash", "Bash");
      await Promise.resolve();
      await Promise.resolve();

      // The 999.64 sweep attempts the clean detach.
      const outcome = await handle.tryBackgroundOrRelease!();
      expect(outcome).toBe("detached");
      // backgroundTasks was called with the in-flight tool's id.
      expect(getController().backgroundTasks).toHaveBeenCalledWith("tu-bash");
      // NO-DOUBLE-RECOVERY INVARIANT — the detach must NOT abort the turn:
      // q.interrupt() was never called.
      expect(getController().interrupt).not.toHaveBeenCalled();
      // 999.173 — the best-effort stopTask cleanup targets the TASK id, never
      // the tool_use id (that call was a silent no-op). The task id is not
      // known yet, so the stop is deferred until task_started names it.
      expect(getController().stopTask).not.toHaveBeenCalled();
      getController().pushMessage({
        type: "system",
        subtype: "task_started",
        task_id: "b-task-1",
        tool_use_id: "tu-bash",
        description: "long bash job",
      } as unknown as SdkStreamMessage);
      await Promise.resolve();
      await Promise.resolve();
      expect(getController().stopTask).toHaveBeenCalledWith("b-task-1");
      expect(getController().stopTask).not.toHaveBeenCalledWith("tu-bash");

      // The turn is still live. The SDK delivers the tool_result + a final
      // result → the turn RESOLVES (no AbortError, no wedgeInfo).
      getController().pushMessage({
        type: "user",
        parent_tool_use_id: "tu-bash",
        message: { content: "backgrounded" },
      } as unknown as SdkStreamMessage);
      emitStockTurn(getController(), {
        text: "resumed-result",
        sessionId: "sess-c-detach",
      });
      const result = await p;
      expect(result).toBe("resumed-result");

      await handle.close();
    });

    it("FALLBACK — an MCP tool wedge is NOT detachable → force-release (turn aborts, wedgeInfo attached for B)", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-c-mcp",
      );

      const p = handle.sendAndStream("call an mcp tool", () => undefined);
      await Promise.resolve();
      await Promise.resolve();

      // An MCP tool is in flight — backgroundTasks does not target MCP.
      pushToolUseC(getController(), "tu-mcp", "mcp__clawcode__memory_lookup");
      await Promise.resolve();
      await Promise.resolve();

      const outcome = await handle.tryBackgroundOrRelease!();
      expect(outcome).toBe("released");
      // backgroundTasks must NOT have been called for a non-detachable tool.
      expect(getController().backgroundTasks).not.toHaveBeenCalled();
      // The force-release path aborts the turn → q.interrupt() fired.
      expect(getController().interrupt).toHaveBeenCalledTimes(1);

      // The turn rejects with an AbortError that carries wedgeInfo — so
      // work-stream B's smart recovery fires on the released path.
      const err = await p.catch((e: unknown) => e);
      expect((err as Error).name).toBe("AbortError");
      expect((err as { wedgeInfo?: unknown }).wedgeInfo).toBeDefined();

      await handle.close();
    });

    it("FALLBACK — backgroundTasks returns false (task already settled) → force-release", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-c-false",
      );

      const p = handle.sendAndStream("bash that already settled", () => undefined);
      await Promise.resolve();
      await Promise.resolve();
      pushToolUseC(getController(), "tu-stale", "Bash");
      await Promise.resolve();
      await Promise.resolve();

      // backgroundTasks reports `false` — nothing matched (already settled
      // / wrong id). Per the SDK contract this is "nothing to do", and the
      // turn is still wedged → fall back to force-release.
      getController().backgroundTasks.mockResolvedValueOnce(false);

      const outcome = await handle.tryBackgroundOrRelease!();
      expect(outcome).toBe("released");
      expect(getController().backgroundTasks).toHaveBeenCalledWith("tu-stale");
      // Force-release fallback fired.
      expect(getController().interrupt).toHaveBeenCalledTimes(1);

      const err = await p.catch((e: unknown) => e);
      expect((err as Error).name).toBe("AbortError");

      await handle.close();
    });

    it("FALLBACK — backgroundTasks throws → force-release (a sick SDK never leaves a wedge un-recovered)", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-c-throw",
      );

      const p = handle.sendAndStream("bash on a sick sdk", () => undefined);
      await Promise.resolve();
      await Promise.resolve();
      pushToolUseC(getController(), "tu-throw", "Bash");
      await Promise.resolve();
      await Promise.resolve();

      getController().backgroundTasks.mockRejectedValueOnce(
        new Error("SDK control channel error"),
      );

      const outcome = await handle.tryBackgroundOrRelease!();
      expect(outcome).toBe("released");
      expect(getController().interrupt).toHaveBeenCalledTimes(1);

      await p.catch(() => undefined);
      await handle.close();
    });

    it("FALLBACK — a MIXED batch (Bash + MCP) is NEVER half-detached → force-release", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-c-mixed",
      );

      const p = handle.sendAndStream("parallel bash + mcp", () => undefined);
      await Promise.resolve();
      await Promise.resolve();

      // A parallel batch — one Bash (detachable) + one MCP (not). A mixed
      // batch must NOT be half-detached: the whole batch falls back.
      getController().pushMessage({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "tool_use", id: "tu-b", name: "Bash" },
            { type: "tool_use", id: "tu-m", name: "mcp__clawcode__post_to_agent" },
          ],
        },
      } as unknown as SdkStreamMessage);
      await Promise.resolve();
      await Promise.resolve();

      const outcome = await handle.tryBackgroundOrRelease!();
      expect(outcome).toBe("released");
      // NOT half-detached — backgroundTasks must not have been called.
      expect(getController().backgroundTasks).not.toHaveBeenCalled();
      expect(getController().interrupt).toHaveBeenCalledTimes(1);

      await p.catch(() => undefined);
      await handle.close();
    });

    it("a pure-text hang (no tool in flight) is NOT detachable → force-release", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-c-text",
      );

      const p = handle.sendAndStream("write a long reply", () => undefined);
      await Promise.resolve();
      await Promise.resolve();

      // No tool_use emitted — pure-text hang. There is no foreground task
      // to background → force-release.
      const outcome = await handle.tryBackgroundOrRelease!();
      expect(outcome).toBe("released");
      expect(getController().backgroundTasks).not.toHaveBeenCalled();
      expect(getController().interrupt).toHaveBeenCalledTimes(1);

      await p.catch(() => undefined);
      await handle.close();
    });

    it("no turn in flight → 'no-turn' (idempotent no-op)", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-c-idle",
      );
      const outcome = await handle.tryBackgroundOrRelease!();
      expect(outcome).toBe("no-turn");
      expect(getController().backgroundTasks).not.toHaveBeenCalled();
      expect(getController().interrupt).not.toHaveBeenCalled();
      await handle.close();
    });
  });

  // error_during_execution soft-recovery
  //
  // Covers the change at persistent-session-handle.ts: when the SDK result
  // message lands with subtype = "error_during_execution" AND we already
  // captured streamed text or block text from the turn, return the partial
  // text plus a short notice footer instead of throwing. Anthropic returns
  // this subtype on transient long-output mid-stream failures (~30/5d, no
  // recent regression — both pre-deploy and post-deploy daemons hit it).
  describe("error_during_execution recovery", () => {
    it("returns partial text + notice when block text was captured before the error", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-edx-block",
      );
      const p = handle.sendAndStream("write a long reply", () => undefined);
      await Promise.resolve();
      await Promise.resolve();
      // Assistant emitted a partial text block before the error landed.
      getController().pushMessage({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "text", text: "partial reply before cut-off" }],
        },
      } as unknown as SdkStreamMessage);
      getController().pushMessage({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: null,
        session_id: "sess-edx-block",
        num_turns: 1,
        duration_ms: 1234,
      } as unknown as SdkStreamMessage);
      const result = await p;
      expect(result).toContain("partial reply before cut-off");
      expect(result).toContain("Generation was cut short by Anthropic");
      await handle.close();
    });

    it("still throws when error_during_execution lands with NO captured text", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-edx-empty",
      );
      const p = handle.sendAndStream("write something", () => undefined);
      await Promise.resolve();
      await Promise.resolve();
      // No assistant text — straight to error.
      getController().pushMessage({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: null,
        session_id: "sess-edx-empty",
        num_turns: 1,
        duration_ms: 1234,
      } as unknown as SdkStreamMessage);
      await expect(p).rejects.toThrow("Agent error: error_during_execution");
      await handle.close();
    });

    it("still throws on other error subtypes even with captured text (error_max_turns, budget, retries)", async () => {
      const { sdkMock, getController } = buildHarness();
      const handle = createPersistentSessionHandle(
        sdkMock as unknown as SdkModule,
        {},
        "sess-edx-other-subtype",
      );
      const p = handle.sendAndStream("write a reply", () => undefined);
      await Promise.resolve();
      await Promise.resolve();
      getController().pushMessage({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "text", text: "captured pre-cap text" }],
        },
      } as unknown as SdkStreamMessage);
      getController().pushMessage({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        result: null,
        session_id: "sess-edx-other-subtype",
        num_turns: 1,
        duration_ms: 1234,
      } as unknown as SdkStreamMessage);
      await expect(p).rejects.toThrow("Agent error: error_max_turns");
      await handle.close();
    });
  });
});

describe("stopTask(taskId) — 999.173 per-task stop", () => {
  it("forwards the task id to q.stopTask and resolves true", async () => {
    const { sdkMock, getController } = buildHarness();
    const handle = createPersistentSessionHandle(sdkMock as unknown as SdkModule, {}, "sess-stop");
    expect(await handle.stopTask!("a-123")).toBe(true);
    expect(getController().stopTask).toHaveBeenCalledWith("a-123");
    await handle.close();
  });

  it("resolves false after close, for an empty id, or when the SDK rejects", async () => {
    const { sdkMock, getController } = buildHarness();
    const handle = createPersistentSessionHandle(sdkMock as unknown as SdkModule, {}, "sess-stop-2");
    expect(await handle.stopTask!("")).toBe(false);
    getController().stopTask.mockImplementationOnce(() => Promise.reject(new Error("unknown task")));
    expect(await handle.stopTask!("a-1")).toBe(false);
    await handle.close();
    expect(await handle.stopTask!("a-2")).toBe(false);
  });
});
