/**
 * 999.171 — handle-level routing of `system/thinking_tokens` to the
 * per-turn thinking sink.
 *
 * Proves at the createPersistentSessionHandle boundary (attributed stream on):
 *  - a daemon sendAndStream turn's thinking frames reach the sink registered
 *    under THAT send's turn id;
 *  - SC-4: a self-fired turn's frames reach no sink — neither after the daemon
 *    turn closed, nor while a daemon send is pending behind it;
 *  - the turn-id slot is cleared when the send ends, so a later send() /
 *    sendAndCollect() daemon turn (no status trail) never paints it;
 *  - no turn id, or the legacy stream (attributedStream off), emits nothing.
 *
 * FakeQuery harness: same shape as persistent-session-handle-attributed-stream
 * .test.ts (push-based generator + Query control methods).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Call-through spy on the emitter so "emits nothing" is asserted at the
// source, not only by the absence of sink deliveries.
vi.mock("../thinking-sink.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../thinking-sink.js")>();
  return { ...actual, emitThinkingTokens: vi.fn(actual.emitThinkingTokens) };
});

import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import {
  emitThinkingTokens,
  registerThinkingSink,
  resetThinkingSinksForTests,
  type ThinkingTokensEvent,
} from "../thinking-sink.js";
import type { SdkModule, SdkQuery, SdkStreamMessage } from "../sdk-types.js";
import type { Turn } from "../../performance/trace-collector.js";

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

/** Structural Turn: just the members iterateUntilResult touches on these paths. */
function fakeTurn(id: string): Turn {
  const span = { end: () => undefined, setMetadata: () => undefined };
  return {
    id,
    startSpan: () => span,
    recordToolCallName: () => undefined,
    recordCacheUsage: () => undefined,
  } as unknown as Turn;
}

// Frame factories mirroring the probe-verified layout.
const init = () => ({ type: "system", subtype: "init" }) as unknown as SdkStreamMessage;
const notification = () =>
  ({ type: "system", subtype: "task_notification", task_id: "t" }) as unknown as SdkStreamMessage;
const streamEvent = () =>
  ({ type: "stream_event", parent_tool_use_id: null, event: {} }) as unknown as SdkStreamMessage;
const thinking = (estimated: number) =>
  ({
    type: "system",
    subtype: "thinking_tokens",
    estimated_tokens: estimated,
    estimated_tokens_delta: 10,
  }) as unknown as SdkStreamMessage;
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

const emitSpy = vi.mocked(emitThinkingTokens);

function recordingSink() {
  const seen: number[] = [];
  const sink = (ev: ThinkingTokensEvent) => {
    seen.push(ev.estimatedTokens);
  };
  return { seen, sink };
}

function attributedHandle(sdkMock: SdkModule) {
  return createPersistentSessionHandle(
    sdkMock,
    { model: "sonnet", attributedStream: true, onOrphanTurnOutput: vi.fn() },
    "sess-1",
  );
}

/** One full daemon sendAndStream turn for `turnId` that thinks `tokens`. */
async function runStreamTurn(
  handle: ReturnType<typeof createPersistentSessionHandle>,
  push: (m: SdkStreamMessage) => void,
  turnId: string,
  tokens: number,
  text: string,
): Promise<string> {
  const reply = handle.sendAndStream("q", () => undefined, fakeTurn(turnId));
  await settle();
  push(streamEvent());
  push(thinking(tokens));
  push(assistant(text));
  push(result(text));
  return reply;
}

beforeEach(() => {
  resetThinkingSinksForTests();
  emitSpy.mockClear();
});

describe("persistent-session-handle — thinking routing (999.171)", () => {
  it("a daemon sendAndStream turn's thinking reaches the sink registered under its turn id", async () => {
    const { sdkMock, ctrl } = buildHarness();
    const handle = attributedHandle(sdkMock);
    await settle();
    const a = recordingSink();
    registerThinkingSink("turn-A", a.sink);

    const reply = await runStreamTurn(handle, ctrl().push, "turn-A", 1200, "answer");

    expect(reply).toBe("answer");
    expect(a.seen).toEqual([1200]);
    // The call-through spy really intercepts the handle's import, so the
    // "emits nothing" cases below are asserted at the source.
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy.mock.calls[0]?.[0]).toBe("turn-A");
    await handle.close();
  });

  it("SC-4: after the daemon turn closes, a self-fired turn's thinking reaches no sink", async () => {
    const { sdkMock, ctrl } = buildHarness();
    const handle = attributedHandle(sdkMock);
    await settle();
    const a = recordingSink();
    const b = recordingSink();
    registerThinkingSink("turn-A", a.sink);
    registerThinkingSink("turn-B", b.sink);

    await runStreamTurn(handle, ctrl().push, "turn-A", 1200, "answer");
    emitSpy.mockClear();

    // Self-fired turn (cron / poll / subagent relay) on the same agent.
    ctrl().push(notification());
    ctrl().push(streamEvent());
    ctrl().push(thinking(700));
    ctrl().push(result("bg", { origin: "task-notification" }));
    await settle();

    expect(a.seen).toEqual([1200]);
    expect(b.seen).toEqual([]);
    expect(emitSpy).not.toHaveBeenCalled();
    await handle.close();
  });

  it("SC-4: a self-fired turn streaming while a daemon send waits behind it never paints that send", async () => {
    const { sdkMock, ctrl } = buildHarness();
    const handle = attributedHandle(sdkMock);
    await settle();
    const b = recordingSink();
    registerThinkingSink("turn-B", b.sink);

    // The self-fired turn opens first...
    ctrl().push(notification());
    ctrl().push(init());
    await settle();
    // ...then the operator's message is sent; its turn id is live from here.
    const reply = handle.sendAndStream("q", () => undefined, fakeTurn("turn-B"));
    await settle();
    ctrl().push(thinking(700));
    ctrl().push(result("bg", { origin: "task-notification" }));
    // The daemon's own turn follows (its first frame decides the held merge).
    ctrl().push(init());
    ctrl().push(thinking(300));
    ctrl().push(assistant("mine"));
    ctrl().push(result("mine"));

    expect(await reply).toBe("mine");
    expect(b.seen).toEqual([300]);
    await handle.close();
  });

  it("the turn-id slot is cleared when the send ends: a later sendAndCollect turn never paints it", async () => {
    const { sdkMock, ctrl } = buildHarness();
    const handle = attributedHandle(sdkMock);
    await settle();
    const a = recordingSink();
    registerThinkingSink("turn-A", a.sink);

    await runStreamTurn(handle, ctrl().push, "turn-A", 1200, "answer");

    // A daemon turn with no status trail (heartbeat / scheduled prompt path).
    const collected = handle.sendAndCollect("hb", fakeTurn("turn-hb"));
    await settle();
    ctrl().push(streamEvent());
    ctrl().push(thinking(650));
    ctrl().push(assistant("hb ok"));
    ctrl().push(result("hb ok"));

    expect(await collected).toBe("hb ok");
    expect(a.seen).toEqual([1200]);
    await handle.close();
  });

  it("sendAndStream with no turn emits nothing and does not throw", async () => {
    const { sdkMock, ctrl } = buildHarness();
    const handle = attributedHandle(sdkMock);
    await settle();
    const a = recordingSink();
    registerThinkingSink("turn-A", a.sink);

    const reply = handle.sendAndStream("q", () => undefined);
    await settle();
    ctrl().push(streamEvent());
    ctrl().push(thinking(500));
    ctrl().push(assistant("fine"));
    ctrl().push(result("fine"));

    await expect(reply).resolves.toBe("fine");
    expect(emitSpy).not.toHaveBeenCalled();
    expect(a.seen).toEqual([]);
    await handle.close();
  });

  it("legacy stream (attributedStream off) emits nothing — capture is inert by design", async () => {
    const { sdkMock, ctrl } = buildHarness();
    const handle = createPersistentSessionHandle(sdkMock, { model: "sonnet" }, "sess-1");
    await settle();
    const a = recordingSink();
    registerThinkingSink("turn-A", a.sink);

    const reply = handle.sendAndStream("q", () => undefined, fakeTurn("turn-A"));
    await settle();
    ctrl().push(init());
    ctrl().push(thinking(900));
    ctrl().push(assistant("legacy"));
    ctrl().push(result("legacy"));

    expect(await reply).toBe("legacy");
    expect(emitSpy).not.toHaveBeenCalled();
    expect(a.seen).toEqual([]);
    await handle.close();
  });
});
