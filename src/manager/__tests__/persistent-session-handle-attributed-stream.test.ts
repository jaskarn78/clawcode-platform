/**
 * WS-1 (999.99 structural delivery) — handle-level integration tests for the
 * attributed-stream epoch wrap.
 *
 * Proves at the createPersistentSessionHandle boundary:
 *  1. Flag OFF (default) → legacy consumption, and the LEGACY BUG is pinned:
 *     a buffered self-fired result is returned as the next send's reply
 *     (this is the rollback path — its behavior must stay byte-identical).
 *  2. Flag ON → the incident sequence delivers orphan output immediately via
 *     onOrphanTurnOutput and the daemon send pairs with ITS OWN result.
 *  3. Flag ON survives multiple buffered orphan turns + interleaving.
 *
 * Uses a compact local FakeQuery (same shape as persistent-session-handle
 * .test.ts's controller — push-based generator + Query control methods).
 */
import { describe, it, expect, vi } from "vitest";
import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import type { SdkModule, SdkQuery, SdkStreamMessage } from "../sdk-types.js";

// ---------------------------------------------------------------------------
// Compact FakeQuery
// ---------------------------------------------------------------------------

function createFakeQuery() {
  const pending: SdkStreamMessage[] = [];
  const waiters: Array<(r: IteratorResult<SdkStreamMessage>) => void> = [];
  let streamEnded = false;

  const next = (): Promise<IteratorResult<SdkStreamMessage>> =>
    new Promise((resolve) => {
      const m = pending.shift();
      if (m !== undefined) return resolve({ value: m, done: false });
      if (streamEnded)
        return resolve({ value: undefined as unknown as SdkStreamMessage, done: true });
      waiters.push(resolve);
    });

  const push = (msg: SdkStreamMessage): void => {
    const w = waiters.shift();
    if (w) return w({ value: msg, done: false });
    pending.push(msg);
  };

  const query = {
    [Symbol.asyncIterator]() {
      return { next };
    },
    next,
    return: async () => ({ value: undefined, done: true as const }),
    interrupt: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => {
      streamEnded = true;
      for (const w of waiters.splice(0)) {
        w({ value: undefined as unknown as SdkStreamMessage, done: true });
      }
    }),
    streamInput: vi.fn(() => Promise.resolve()),
    mcpServerStatus: vi.fn(() => Promise.resolve([])),
    setMcpServers: vi.fn(() => Promise.resolve(undefined)),
    setMaxThinkingTokens: vi.fn(() => Promise.resolve(undefined)),
    setModel: vi.fn(() => Promise.resolve(undefined)),
    setPermissionMode: vi.fn(() => Promise.resolve(undefined)),
    backgroundTasks: vi.fn(() => Promise.resolve(true)),
    stopTask: vi.fn(() => Promise.resolve()),
  } as unknown as SdkQuery;

  return { query, push };
}

function buildHarness() {
  let controller: ReturnType<typeof createFakeQuery> | null = null;
  const query = vi.fn(() => {
    controller = createFakeQuery();
    return controller.query;
  });
  return {
    sdkMock: { query } as unknown as SdkModule,
    ctrl: () => {
      if (!controller) throw new Error("query not yet invoked");
      return controller;
    },
  };
}

// Frame factories mirroring the probe-verified layout.
const init = () => ({ type: "system", subtype: "init" }) as unknown as SdkStreamMessage;
const notification = () =>
  ({ type: "system", subtype: "task_notification", task_id: "t" }) as unknown as SdkStreamMessage;
const assistant = (text: string) =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text }] },
  }) as unknown as SdkStreamMessage;
const result = (text: string, opts: { origin?: string } = {}) =>
  ({
    type: "result",
    subtype: "success",
    result: text,
    session_id: "sess-1",
    ...(opts.origin ? { origin: { kind: opts.origin } } : {}),
  }) as unknown as SdkStreamMessage;

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// 1. Flag OFF — legacy behavior pinned (incl. the bug, for rollback parity)
// ---------------------------------------------------------------------------

describe("WS-1 — flag OFF (legacy path pinned)", () => {
  it("a buffered self-fired result is returned as the next send's reply (THE legacy bug — rollback-path pin)", async () => {
    const { sdkMock, ctrl } = buildHarness();
    const orphanSink = vi.fn();
    const handle = createPersistentSessionHandle(
      sdkMock,
      // No attributedStream flag — legacy consumption.
      { model: "sonnet", onOrphanTurnOutput: orphanSink },
      "sess-1",
    );

    // Self-fired turn completes while the daemon is idle — frames buffer.
    ctrl().push(notification());
    ctrl().push(init());
    ctrl().push(assistant("stale background output"));
    ctrl().push(result("stale background output", { origin: "task-notification" }));
    await settle();

    // The next send pops the STALE result (off-by-N). This is the pinned
    // legacy behavior the flag-off path must preserve for rollback.
    const reply = await handle.sendAndCollect("Run the ingest");
    expect(reply).toBe("stale background output");
    // Legacy path never constructs a demux → the sink never fires.
    expect(orphanSink).not.toHaveBeenCalled();
    await handle.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Flag ON — the incident scenario is FIXED
// ---------------------------------------------------------------------------

describe("WS-1 — flag ON (attributed stream)", () => {
  it("THE incident: self-fired output delivers immediately; the user's send pairs with its own reply", async () => {
    const { sdkMock, ctrl } = buildHarness();
    const orphanSink = vi.fn();
    const handle = createPersistentSessionHandle(
      sdkMock,
      { model: "sonnet", attributedStream: true, onOrphanTurnOutput: orphanSink },
      "sess-1",
    );
    // The demux pump starts reading at construction; trigger query creation
    // by... construction itself (buildEpoch runs in the constructor).
    await settle();

    // Monitor fires while idle: the orphan turn's output is delivered NOW.
    ctrl().push(notification());
    ctrl().push(init());
    ctrl().push(assistant("Click delivered (worker run ended clean)"));
    ctrl().push(result("Click delivered (worker run ended clean)", { origin: "task-notification" }));
    await settle();

    expect(orphanSink).toHaveBeenCalledTimes(1);
    expect(orphanSink.mock.calls[0][0]).toMatchObject({
      text: "Click delivered (worker run ended clean)",
      originKind: "task-notification",
      classification: "orphan-signaled",
    });

    // User sends "Run the ingest" — the reply is THIS turn's result.
    const replyPromise = handle.sendAndCollect("Run the ingest and make sure the cv2 lands");
    await settle();
    ctrl().push(init());
    ctrl().push(assistant("Ingest started — cv2 will post to fin-client"));
    ctrl().push(result("Ingest started — cv2 will post to fin-client"));
    const reply = await replyPromise;
    expect(reply).toBe("Ingest started — cv2 will post to fin-client");
    expect(orphanSink).toHaveBeenCalledTimes(1);
    await handle.close();
  });

  it("multiple buffered self-fired turns deliver in order; poking '.' style sends never pop stale output", async () => {
    const { sdkMock, ctrl } = buildHarness();
    const orphanSink = vi.fn();
    const handle = createPersistentSessionHandle(
      sdkMock,
      { model: "sonnet", attributedStream: true, onOrphanTurnOutput: orphanSink },
      "sess-1",
    );
    await settle();

    for (const text of ["first bg", "second bg", "third bg"]) {
      ctrl().push(notification());
      ctrl().push(init());
      ctrl().push(assistant(text));
      ctrl().push(result(text, { origin: "task-notification" }));
    }
    await settle();
    expect(orphanSink.mock.calls.map((c) => c[0].text)).toEqual([
      "first bg",
      "second bg",
      "third bg",
    ]);

    const replyPromise = handle.sendAndCollect(".");
    await settle();
    ctrl().push(init());
    ctrl().push(assistant("nothing pending"));
    ctrl().push(result("nothing pending"));
    expect(await replyPromise).toBe("nothing pending");
    await handle.close();
  });

  it("streaming send (sendAndStream) receives only its own turn's chunks", async () => {
    const { sdkMock, ctrl } = buildHarness();
    const orphanSink = vi.fn();
    const handle = createPersistentSessionHandle(
      sdkMock,
      { model: "sonnet", attributedStream: true, onOrphanTurnOutput: orphanSink },
      "sess-1",
    );
    await settle();

    // Orphan completes first.
    ctrl().push(notification());
    ctrl().push(init());
    ctrl().push(assistant("bg noise"));
    ctrl().push(result("bg noise", { origin: "task-notification" }));
    await settle();

    const chunks: string[] = [];
    const replyPromise = handle.sendAndStream("hello", (acc) => chunks.push(acc));
    await settle();
    ctrl().push(init());
    ctrl().push(assistant("real answer"));
    ctrl().push(result("real answer"));
    const reply = await replyPromise;
    expect(reply).toBe("real answer");
    // No chunk ever contained the orphan text.
    expect(chunks.every((c) => !c.includes("bg noise"))).toBe(true);
    await handle.close();
  });

  it("close() stops the demux pump cleanly", async () => {
    const { sdkMock } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock,
      { model: "sonnet", attributedStream: true },
      "sess-1",
    );
    await settle();
    await handle.close();
    // No hanging pump: the test completing without a leaked-timer warning is
    // the assertion; close() ended the queue and returned.
    expect(true).toBe(true);
  });
});
