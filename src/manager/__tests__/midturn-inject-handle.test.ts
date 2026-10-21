/**
 * Phase 999.100 — handle-level injectMidTurn contract.
 *
 * Pins the guard-and-push semantics on createPersistentSessionHandle:
 *   - inject during an in-flight turn → pushed into the SAME long-lived
 *     prompt iterable (observable order: original send, then injection),
 *     turn completes normally with its single result
 *   - inject while idle → {injected:false, reason:"idle"}, nothing pushed
 *   - per-turn cap (opts.maxPerTurn) → {injected:false, reason:"cap"}
 *   - cap counter resets when a NEW turn takes the in-flight slot
 *   - inject after close() → {injected:false, reason:"closed"}
 *
 * Harness is a slim clone of the persistent-session-handle.test.ts fake —
 * push-controlled SDK stream + prompt-iterable observation.
 */
import { describe, it, expect, vi } from "vitest";

import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import type { SdkModule, SdkQuery, SdkStreamMessage } from "../sdk-types.js";

type Ctrl = {
  query: SdkQuery;
  pushMessage: (msg: SdkStreamMessage) => void;
  receivedUserMessages: string[];
};

function createFakeQuery(promptIterable: AsyncIterable<unknown>): Ctrl {
  const pending: SdkStreamMessage[] = [];
  let waiter: ((r: IteratorResult<SdkStreamMessage>) => void) | null = null;
  const receivedUserMessages: string[] = [];

  void (async () => {
    try {
      for await (const m of promptIterable) {
        const msg = m as { message?: { content?: unknown } };
        const content = msg?.message?.content;
        receivedUserMessages.push(
          typeof content === "string" ? content : JSON.stringify(content),
        );
      }
    } catch {
      // prompt iterable closed abnormally — fine for these tests
    }
  })();

  const pushMessage = (msg: SdkStreamMessage): void => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ value: msg, done: false });
      return;
    }
    pending.push(msg);
  };

  const next = (): Promise<IteratorResult<SdkStreamMessage>> =>
    new Promise((resolve) => {
      const m = pending.shift();
      if (m !== undefined) {
        resolve({ value: m, done: false });
        return;
      }
      waiter = resolve;
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
    backgroundTasks: vi.fn(() => Promise.resolve(true)),
    stopTask: vi.fn(() => Promise.resolve()),
  } as unknown as SdkQuery;

  return { query, pushMessage, receivedUserMessages };
}

function buildHarness(): {
  sdkMock: { query: ReturnType<typeof vi.fn> };
  getCtrl: () => Ctrl;
} {
  let ctrl: Ctrl | null = null;
  const query = vi.fn((params: { prompt: unknown }) => {
    ctrl = createFakeQuery(params.prompt as AsyncIterable<unknown>);
    return ctrl.query;
  });
  return {
    sdkMock: { query },
    getCtrl: () => {
      if (!ctrl) throw new Error("FakeQuery not yet created");
      return ctrl;
    },
  };
}

function emitResult(ctrl: Ctrl, text: string, sessionId: string): void {
  ctrl.pushMessage({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text }] },
  } as unknown as SdkStreamMessage);
  ctrl.pushMessage({
    type: "result",
    subtype: "success",
    result: text,
    session_id: sessionId,
  } as unknown as SdkStreamMessage);
}

const tick = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("SessionHandle.injectMidTurn", () => {
  it("pushes into the running turn's input stream; turn completes with one result", async () => {
    const { sdkMock, getCtrl } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      { model: "sonnet" },
      "sess-inj",
    );

    const turn = handle.sendAndStream("original task", () => undefined);
    await tick();

    expect(handle.hasActiveTurn()).toBe(true);
    const res = handle.injectMidTurn!("<steer>make it blue</steer>");
    expect(res).toEqual({ injected: true });
    await tick();

    emitResult(getCtrl(), "done (blue)", "sess-inj");
    await expect(turn).resolves.toBe("done (blue)");

    // Prompt iterable observed BOTH messages, in order, within ONE turn.
    const received = getCtrl().receivedUserMessages;
    expect(received.length).toBe(2);
    expect(received[0]).toContain("original task");
    expect(received[1]).toContain("make it blue");

    await handle.close();
  });

  it("declines while idle (reason:idle) and pushes nothing", async () => {
    const { sdkMock, getCtrl } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      { model: "sonnet" },
      "sess-idle",
    );

    expect(handle.injectMidTurn!("nope")).toEqual({ injected: false, reason: "idle" });
    await tick();
    // The long-lived sdk.query exists from construction (one per epoch), but
    // the declined inject must not have pushed anything into its prompt.
    expect(getCtrl().receivedUserMessages).toEqual([]);

    await handle.close();
  });

  it("enforces the per-turn cap and resets it on the next turn", async () => {
    const { sdkMock, getCtrl } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      { model: "sonnet" },
      "sess-cap",
    );

    // Turn 1 — cap 2: two injections accepted, third declined.
    const t1 = handle.sendAndStream("task one", () => undefined);
    await tick();
    expect(handle.injectMidTurn!("s1", { maxPerTurn: 2 })).toEqual({ injected: true });
    expect(handle.injectMidTurn!("s2", { maxPerTurn: 2 })).toEqual({ injected: true });
    expect(handle.injectMidTurn!("s3", { maxPerTurn: 2 })).toEqual({
      injected: false,
      reason: "cap",
    });
    emitResult(getCtrl(), "r1", "sess-cap");
    await t1;

    // Turn 2 — fresh in-flight identity → counter reset.
    const t2 = handle.sendAndStream("task two", () => undefined);
    await tick();
    expect(handle.injectMidTurn!("s4", { maxPerTurn: 2 })).toEqual({ injected: true });
    emitResult(getCtrl(), "r2", "sess-cap");
    await t2;

    const received = getCtrl().receivedUserMessages;
    // task one, s1, s2, task two, s4 — the capped s3 never reached the SDK.
    expect(received.length).toBe(5);
    expect(received.some((m) => m.includes("s3"))).toBe(false);

    await handle.close();
  });

  it("declines after close (reason:closed)", async () => {
    const { sdkMock } = buildHarness();
    const handle = createPersistentSessionHandle(
      sdkMock as unknown as SdkModule,
      { model: "sonnet" },
      "sess-closed",
    );
    await handle.close();
    expect(handle.injectMidTurn!("x")).toEqual({ injected: false, reason: "closed" });
  });
});
