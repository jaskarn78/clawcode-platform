/**
 * 999.99 review CRITICAL — force-release ghost window at the handle
 * boundary.
 *
 * Pre-fix: forceReleaseTurn freed the SerialTurnQueue slot while the ghost
 * iterateUntilResult lived (≤2s abort deadline). A successor dispatch B
 * entering that window could receive the released turn's stale result, get
 * generator-dead'd by the ghost's late abandon (bricking the handle), or
 * have its live turn converted to orphan-mode.
 *
 * Post-fix pins:
 *   - forceReleaseTurn abandons the demux turn BEFORE clearing the slot
 *     (token-gated, so the ghost's own catch-side abandon later no-ops);
 *   - the ghost exits promptly as an AbortError (void-resolved waiter +
 *     interruptCalled → abort classification, NEVER generator-dead);
 *   - dispatch B — started immediately after the release — receives ITS
 *     OWN result while A's late output delivers via the orphan sink;
 *   - the handle stays healthy (no notifyError/generatorDead poisoning).
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

describe("999.99 review — forceReleaseTurn ghost window (attributed)", () => {
  it("release → immediate dispatch B: ghost exits as AbortError, B gets ITS OWN result, A's late output hits the sink", { timeout: 15_000 }, async () => {
    let controller: ReturnType<typeof createFakeQuery> | null = null;
    const query = vi.fn(() => {
      controller = createFakeQuery();
      return controller.query;
    });
    const orphanSink = vi.fn();
    const onError = vi.fn();

    const handle = createPersistentSessionHandle(
      { query } as unknown as SdkModule,
      { model: "sonnet", attributedStream: true, onOrphanTurnOutput: orphanSink },
      "sess-1",
    );
    handle.onError(onError);
    const ctrl = (): ReturnType<typeof createFakeQuery> => {
      if (!controller) throw new Error("query not invoked");
      return controller;
    };

    // Dispatch A — turn opens and streams.
    const a = handle.sendAndCollect("question A");
    await settle();
    ctrl().push(init());
    ctrl().push(assistant("working on A..."));
    await settle();

    // 999.64 sweep: force-release the "wedged" turn. Slot frees NOW.
    expect(handle.forceReleaseTurn?.()).toBe(true);

    // Ghost A exits promptly as an ABORT (void-resolved waiter +
    // interruptCalled) — never generator-dead, never a 2s hang.
    await expect(a).rejects.toThrow(/Aborted/i);

    // Dispatch B enters the (former) ghost window immediately.
    const b = handle.sendAndCollect("question B");
    await settle();

    // A's late frames + result arrive — they belong to the CONVERTED
    // abandoned turn, not to B.
    ctrl().push(assistant("late A text"));
    ctrl().push(result("STALE ANSWER A"));
    await settle();

    expect(orphanSink).toHaveBeenCalledTimes(1);
    expect(orphanSink.mock.calls[0]?.[0]).toMatchObject({
      text: "STALE ANSWER A",
      classification: "abandoned-daemon",
    });

    // B's own turn runs and B resolves with B's OWN result.
    ctrl().push(init());
    ctrl().push(assistant("working on B"));
    ctrl().push(result("FRESH ANSWER B"));
    await expect(b).resolves.toBe("FRESH ANSWER B");

    // Handle stayed healthy: the ghost never fired generator-dead.
    expect(onError).not.toHaveBeenCalled();

    await handle.close();
  });
});
