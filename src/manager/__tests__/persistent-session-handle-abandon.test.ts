/**
 * 999.99-F2 — handle-boundary incident regression (2026-07-23 fin-client).
 *
 * Real abort-deadline choreography through createPersistentSessionHandle:
 * dispatch A → interrupt → 2s INTERRUPT_DEADLINE_MS expires → A rejects
 * "Aborted: interrupt deadline exceeded" → the CLI later emits A's frames +
 * result anyway.
 *
 *  - attributed mode: the send's catch fires demux.abandonDaemonTurn — A's
 *    late output delivers via onOrphanTurnOutput ("abandoned-daemon") and
 *    dispatch B receives ITS OWN result. (THE fix.)
 *  - legacy mode: B receives A's STALE result — the exact off-by-one from
 *    the incident, pinned deliberately for rollback parity.
 *
 * These tests wait out the real 2s deadline (no fake timers — the deadline
 * race is armed inside iterateUntilResult and racing it with fake timers
 * would skip the production code path). ~2.2s each.
 */
import { describe, it, expect, vi } from "vitest";

import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import type { SdkModule, SdkQuery, SdkStreamMessage } from "../sdk-types.js";

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
    // interrupt resolves but the fake stream keeps flowing — models the
    // incident where the interrupt did NOT stop the in-flight turn.
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

const init = () => ({ type: "system", subtype: "init" }) as unknown as SdkStreamMessage;
const assistant = (text: string) =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text }] },
  }) as unknown as SdkStreamMessage;
const result = (text: string) =>
  ({
    type: "result",
    subtype: "success",
    result: text,
    session_id: "sess-1",
  }) as unknown as SdkStreamMessage;

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("999.99-F2 — abort-deadline abandonment at the handle boundary", () => {
  it(
    "attributed: abandoned turn delivers late via the sink; the next dispatch gets ITS OWN result",
    { timeout: 15_000 },
    async () => {
      const { sdkMock, ctrl } = buildHarness();
      const orphanSink = vi.fn();
      const handle = createPersistentSessionHandle(
        sdkMock,
        { model: "sonnet", attributedStream: true, onOrphanTurnOutput: orphanSink },
        "sess-1",
      );

      // Dispatch A — turn opens, loop consumes a couple of frames.
      const a = handle.sendAndCollect("question A");
      await settle();
      ctrl().push(init());
      ctrl().push(assistant("working on A..."));
      await settle();

      // Interrupt A; the fake CLI ignores it → the 2s deadline expires.
      handle.interrupt();
      await expect(a).rejects.toThrow(/interrupt deadline exceeded/i);

      // A's late output arrives anyway (the incident shape).
      ctrl().push(assistant("late A text"));
      ctrl().push(result("STALE ANSWER A"));
      await settle();

      expect(orphanSink).toHaveBeenCalledTimes(1);
      expect(orphanSink.mock.calls[0]?.[0]).toMatchObject({
        text: "STALE ANSWER A",
        classification: "abandoned-daemon",
      });

      // Dispatch B answers with ITS OWN result.
      const b = handle.sendAndCollect("question B");
      await settle();
      ctrl().push(init());
      ctrl().push(assistant("working on B"));
      ctrl().push(result("FRESH ANSWER B"));
      await expect(b).resolves.toBe("FRESH ANSWER B");

      await handle.close();
    },
  );

  it(
    "legacy (flag off): the next dispatch pops the STALE result — incident pinned for rollback parity",
    { timeout: 15_000 },
    async () => {
      const { sdkMock, ctrl } = buildHarness();
      const orphanSink = vi.fn();
      const handle = createPersistentSessionHandle(
        sdkMock,
        { model: "sonnet", onOrphanTurnOutput: orphanSink },
        "sess-1",
      );

      const a = handle.sendAndCollect("question A");
      await settle();
      ctrl().push(init());
      ctrl().push(assistant("working on A..."));
      await settle();

      handle.interrupt();
      await expect(a).rejects.toThrow(/interrupt deadline exceeded/i);

      // Late frames: the dangling raced next() void-consumes ONE frame;
      // the result queues unread.
      ctrl().push(assistant("late A text"));
      ctrl().push(result("STALE ANSWER A"));
      await settle();

      // Dispatch B pops A's stale result — the off-by-one conveyor.
      const b = handle.sendAndCollect("question B");
      await settle();
      const bResolved = await b;
      expect(bResolved).toBe("STALE ANSWER A");
      expect(orphanSink).not.toHaveBeenCalled();

      await handle.close();
    },
  );
});
