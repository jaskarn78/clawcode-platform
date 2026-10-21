import { describe, it, expect, vi } from "vitest";

/**
 * Phase 124 Plan 05 — unit tests for SessionHandle.swap().
 *
 * Pins the new "ONE sdk.query per EPOCH" invariant:
 *   - swap() closes the current SDK Query and reopens against new session id.
 *   - Handle identity is preserved across the swap.
 *   - sessionId getter returns the new id post-swap.
 *   - epoch counter increments once per successful swap.
 *   - Within a single epoch, N sends still produce exactly ONE sdk.query
 *     for that epoch (the pre-existing invariant, scoped per epoch).
 *   - Cross-epoch send count: 2 epochs * N sends each => exactly 2 sdk.query
 *     invocations total.
 *   - Swap to the same session id is a no-op (no new sdk.query, epoch
 *     unchanged).
 *   - Swap on a closed handle rejects.
 *   - Setter state (effort/model/permissionMode) is re-applied to the new q.
 *   - Build-new-before-close-old: when sdk.query throws on the rebuild path,
 *     the old epoch is intact and the caller sees the rejection.
 */

import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import type { SdkModule, SdkQuery, SdkStreamMessage } from "../sdk-types.js";

type FakeQueryController = {
  readonly query: SdkQuery;
  pushMessage: (msg: SdkStreamMessage) => void;
  endStream: () => void;
  receivedUserMessages: string[];
  interrupt: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setMaxThinkingTokens: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
};

function createFakeQuery(
  promptIterable: AsyncIterable<unknown>,
): FakeQueryController {
  const pending: SdkStreamMessage[] = [];
  let msgWaiter: ((r: IteratorResult<SdkStreamMessage>) => void) | null = null;
  let streamEnded = false;
  const receivedUserMessages: string[] = [];

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
      // ignore — prompt closed
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
    new Promise<IteratorResult<SdkStreamMessage>>((resolve) => {
      if (pending.length > 0) {
        const m = pending.shift()!;
        resolve({ value: m, done: false });
        return;
      }
      if (streamEnded) {
        resolve({ value: undefined as unknown as SdkStreamMessage, done: true });
        return;
      }
      msgWaiter = resolve;
    });

  const interrupt = vi.fn(() => Promise.resolve());
  const close = vi.fn(() => undefined);
  const setMaxThinkingTokens = vi.fn(() => Promise.resolve(undefined));
  const setModel = vi.fn(() => Promise.resolve(undefined));
  const setPermissionMode = vi.fn(() => Promise.resolve(undefined));

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
    setMaxThinkingTokens,
    setModel,
    setPermissionMode,
  } as unknown as SdkQuery;

  return {
    query,
    pushMessage,
    endStream,
    receivedUserMessages,
    interrupt,
    close,
    setMaxThinkingTokens,
    setModel,
    setPermissionMode,
  };
}

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

/** Build a harness that returns the most recently-created controller. */
function buildHarness(): {
  sdkMock: { query: ReturnType<typeof vi.fn> };
  getController: () => FakeQueryController;
  controllers: FakeQueryController[];
} {
  const controllers: FakeQueryController[] = [];
  const query = vi.fn((params: { prompt: unknown; options?: unknown }) => {
    const iterable = params.prompt as AsyncIterable<unknown>;
    const c = createFakeQuery(iterable);
    controllers.push(c);
    return c.query;
  });
  return {
    sdkMock: { query },
    getController: () => {
      if (controllers.length === 0) throw new Error("no FakeQuery created");
      return controllers[controllers.length - 1];
    },
    controllers,
  };
}

describe("createPersistentSessionHandle — swap() epoch boundary", () => {
  it("swap reopens the SDK query and updates sessionId + epoch", async () => {
    const { sdkMock, getController } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      { model: "sonnet" },
      "epoch-0-sid",
    );

    expect(handle.sessionId).toBe("epoch-0-sid");
    expect(handle.getEpoch?.()).toBe(0);
    expect(sdkMock.query).toHaveBeenCalledTimes(1);

    // First send drives epoch 0.
    const p0 = handle.sendAndCollect("hi");
    await Promise.resolve();
    await Promise.resolve();
    emitStockTurn(getController(), {
      text: "reply-0",
      sessionId: "epoch-0-sid",
    });
    await p0;

    const oldClose = getController().close;

    // Swap.
    await handle.swap?.("epoch-1-fork-sid");

    expect(handle.sessionId).toBe("epoch-1-fork-sid");
    expect(handle.getEpoch?.()).toBe(1);
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    // Old SDK query closed exactly once.
    expect(oldClose).toHaveBeenCalledTimes(1);

    // The most recent sdk.query call carries the fork session id.
    const lastArgs = sdkMock.query.mock.calls.at(-1)![0] as {
      options: { resume: string };
    };
    expect(lastArgs.options.resume).toBe("epoch-1-fork-sid");

    // Second send drives epoch 1.
    const p1 = handle.sendAndCollect("post-swap");
    await Promise.resolve();
    await Promise.resolve();
    emitStockTurn(getController(), {
      text: "reply-1",
      sessionId: "epoch-1-fork-sid",
    });
    const r1 = await p1;
    expect(r1).toBe("reply-1");

    // The post-swap message was received by the NEW controller, not the old.
    expect(getController().receivedUserMessages).toEqual(["post-swap"]);

    await handle.close();
  });

  it("N sends per epoch -> 1 sdk.query per epoch; 2 epochs -> 2 total", async () => {
    const { sdkMock, controllers } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      {},
      "e0",
    );

    // 3 sends in epoch 0.
    for (let i = 0; i < 3; i++) {
      const p = handle.sendAndCollect(`e0-msg-${i}`);
      await Promise.resolve();
      await Promise.resolve();
      emitStockTurn(controllers[0], {
        text: `e0-reply-${i}`,
        sessionId: "e0",
      });
      await p;
    }

    expect(sdkMock.query).toHaveBeenCalledTimes(1);

    await handle.swap?.("e1");
    expect(sdkMock.query).toHaveBeenCalledTimes(2);

    // 3 sends in epoch 1.
    for (let i = 0; i < 3; i++) {
      const p = handle.sendAndCollect(`e1-msg-${i}`);
      await Promise.resolve();
      await Promise.resolve();
      emitStockTurn(controllers[1], {
        text: `e1-reply-${i}`,
        sessionId: "e1",
      });
      await p;
    }

    // Two epochs -> exactly two sdk.query calls. The Phase 73 invariant
    // ("one sdk.query per handle") generalizes to "one per epoch."
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    expect(controllers[0].receivedUserMessages).toEqual([
      "e0-msg-0",
      "e0-msg-1",
      "e0-msg-2",
    ]);
    expect(controllers[1].receivedUserMessages).toEqual([
      "e1-msg-0",
      "e1-msg-1",
      "e1-msg-2",
    ]);

    await handle.close();
  });

  // Phase 124 follow-up — swap() routes through turnQueue.run but it is NOT
  // a user turn, so getTurnStartedAt() must remain null. Instrumenting swap
  // would skew the ERR_TURN_TOO_LONG safety budget and cause a no-op
  // compaction swap to register as an active turn.
  it("swap does NOT set turnStartedAt (it is not a user turn)", async () => {
    const { sdkMock } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      {},
      "no-ts-on-swap",
    );

    expect(handle.getTurnStartedAt?.()).toBeNull();
    await handle.swap?.("no-ts-on-swap-fork");
    expect(handle.getTurnStartedAt?.()).toBeNull();

    await handle.close();
  });

  it("swap to same sessionId is a no-op", async () => {
    const { sdkMock } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      {},
      "noop-sid",
    );

    expect(sdkMock.query).toHaveBeenCalledTimes(1);
    await handle.swap?.("noop-sid");
    expect(sdkMock.query).toHaveBeenCalledTimes(1);
    expect(handle.getEpoch?.()).toBe(0);
    expect(handle.sessionId).toBe("noop-sid");

    await handle.close();
  });

  it("swap rejects after close", async () => {
    const { sdkMock } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      {},
      "closed-sid",
    );
    await handle.close();
    await expect(handle.swap?.("post-close")).rejects.toThrow(/closed/i);
  });

  it("re-applies model + effort + permission on the new SDK query", async () => {
    const { sdkMock, controllers } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      { model: "claude-sonnet-4-5" },
      "reapply-sid",
    );

    // Mutate per-handle state before swap.
    handle.setEffort("high");
    handle.setModel("claude-opus-4-8");
    handle.setPermissionMode("acceptEdits");
    // Let the epoch-0 fire-and-forget setters resolve.
    await Promise.resolve();

    await handle.swap?.("reapply-sid-fork");
    // Let the swap's reapply fire-and-forget setters resolve.
    await Promise.resolve();
    await Promise.resolve();

    const newCtrl = controllers[1];
    // Each was called at least once on the NEW q during reapply. The epoch-0
    // controller's setters were called from the pre-swap mutations; the
    // epoch-1 controller's setters are the reapply path.
    expect(newCtrl.setModel).toHaveBeenCalledWith("claude-opus-4-8");
    expect(newCtrl.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    expect(newCtrl.setMaxThinkingTokens).toHaveBeenCalled();

    // Getters still report the latest values.
    expect(handle.getModel()).toBe("claude-opus-4-8");
    expect(handle.getEffort()).toBe("high");
    expect(handle.getPermissionMode()).toBe("acceptEdits");

    await handle.close();
  });

  it("build-new-before-close-old: sdk.query rebuild rejection leaves old epoch intact", async () => {
    const controllers: FakeQueryController[] = [];
    let callCount = 0;
    const query = vi.fn((params: { prompt: unknown; options?: unknown }) => {
      callCount += 1;
      if (callCount === 2) {
        // Reject the rebuild path.
        throw new Error("sdk-rebuild-failed");
      }
      const iterable = params.prompt as AsyncIterable<unknown>;
      const c = createFakeQuery(iterable);
      controllers.push(c);
      return c.query;
    });
    const sdkMock = { query };

    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      {},
      "intact-sid",
    );
    const epoch0Close = controllers[0].close;

    await expect(handle.swap?.("intact-sid-fork")).rejects.toThrow(
      /sdk-rebuild-failed/,
    );

    // The old epoch survived — sessionId unchanged, epoch counter unchanged.
    expect(handle.sessionId).toBe("intact-sid");
    expect(handle.getEpoch?.()).toBe(0);
    // The old q.close was NOT called (rebuild rejected before commit).
    expect(epoch0Close).toHaveBeenCalledTimes(0);

    // Subsequent sends still work on the original epoch.
    const p = handle.sendAndCollect("still-alive");
    await Promise.resolve();
    await Promise.resolve();
    emitStockTurn(controllers[0], {
      text: "ok",
      sessionId: "intact-sid",
    });
    const r = await p;
    expect(r).toBe("ok");

    await handle.close();
  });

  it("mid-turn swap queues behind the in-flight turn (tool-chain-intact invariant)", async () => {
    // Fires a long-running turn through epoch 0, then invokes swap WHILE
    // the turn is still iterating. The SerialTurnQueue is depth-1; the
    // swap call enqueues and resolves only after the turn completes.
    // Pins: the result of the in-flight turn returns from epoch 0's
    // controller (not the post-swap one), and the swap's epoch increment
    // happens AFTER the turn's result, never interleaved.
    const { sdkMock, controllers } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      {},
      "mid-turn-sid",
    );

    // Start the turn but do NOT emit a result yet — the turn iterates
    // pending on driverIter.next() until we push it below.
    const turnPromise = handle.sendAndCollect("long-running");
    await Promise.resolve();
    await Promise.resolve();

    // While the turn is in-flight, invoke swap. It must enqueue (depth-1)
    // and NOT resolve until the turn resolves.
    expect(handle.hasActiveTurn()).toBe(true);
    let swapResolved = false;
    const swapPromise = handle.swap?.("mid-turn-fork-sid").then(() => {
      swapResolved = true;
    });

    // Yield a few microtasks; the swap MUST still be pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(swapResolved).toBe(false);
    expect(handle.sessionId).toBe("mid-turn-sid"); // not yet swapped
    expect(handle.getEpoch?.()).toBe(0);

    // Now emit the assistant + result for the in-flight turn through the
    // epoch-0 controller. The turn resolves with the epoch-0 text.
    emitStockTurn(controllers[0], {
      text: "in-flight-reply",
      sessionId: "mid-turn-sid",
    });
    const result = await turnPromise;
    expect(result).toBe("in-flight-reply");

    // The swap now runs and completes.
    await swapPromise;
    expect(swapResolved).toBe(true);
    expect(handle.sessionId).toBe("mid-turn-fork-sid");
    expect(handle.getEpoch?.()).toBe(1);
    // The in-flight turn's user message was received by the epoch-0
    // controller, not the post-swap one.
    expect(controllers[0].receivedUserMessages).toEqual(["long-running"]);
    expect(controllers[1].receivedUserMessages).toEqual([]);

    await handle.close();
  });
});

// Context-bloat fix #3c — first-turn-only continuity suffix + swap re-arm.
describe("createPersistentSessionHandle — continuity suffix (context-bloat #3c)", () => {
  const SUFFIX = "## Session Continuity\n\nresume + recent sessions";

  it("prepends the continuity suffix on turn 1 only; turns 2..N are unchanged", async () => {
    const { sdkMock, getController } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      { mutableSuffix: SUFFIX },
      "sid-0",
    );

    // Three sends in the same epoch.
    for (let i = 0; i < 3; i++) {
      const p = handle.sendAndCollect(`msg-${i}`);
      await Promise.resolve();
      await Promise.resolve();
      emitStockTurn(getController(), { text: `reply-${i}`, sessionId: "sid-0" });
      await p;
    }

    const received = getController().receivedUserMessages;
    // Turn 1 carries the suffix; turns 2 + 3 are sent unchanged.
    expect(received[0]).toBe(`${SUFFIX}\n\nmsg-0`);
    expect(received[1]).toBe("msg-1");
    expect(received[2]).toBe("msg-2");

    await handle.close();
  });

  it("re-sends the continuity suffix once after a swap (treats swap as a fresh first turn)", async () => {
    const { sdkMock, getController, controllers } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      { mutableSuffix: SUFFIX },
      "sid-0",
    );

    // Epoch 0: two sends — first carries the suffix, second does not.
    for (let i = 0; i < 2; i++) {
      const p = handle.sendAndCollect(`e0-${i}`);
      await Promise.resolve();
      await Promise.resolve();
      emitStockTurn(getController(), { text: `e0-r-${i}`, sessionId: "sid-0" });
      await p;
    }

    // Compaction swap — the forked session does NOT carry the continuity
    // block, so the flag must re-arm.
    await handle.swap?.("sid-1");

    // Epoch 1: two more sends — first AFTER the swap re-sends the suffix.
    for (let i = 0; i < 2; i++) {
      const p = handle.sendAndCollect(`e1-${i}`);
      await Promise.resolve();
      await Promise.resolve();
      emitStockTurn(getController(), { text: `e1-r-${i}`, sessionId: "sid-1" });
      await p;
    }

    // Epoch 0 controller: suffix on turn 1 only.
    expect(controllers[0].receivedUserMessages).toEqual([
      `${SUFFIX}\n\ne0-0`,
      "e0-1",
    ]);
    // Epoch 1 controller: swap re-armed the flag → suffix re-sent once.
    expect(controllers[1].receivedUserMessages).toEqual([
      `${SUFFIX}\n\ne1-0`,
      "e1-1",
    ]);

    await handle.close();
  });
});
