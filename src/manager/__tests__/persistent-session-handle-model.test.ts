/**
 * Phase 86 Plan 01 Task 2 — SDK canary regression pin for setModel wiring.
 *
 * Mirrors the Phase 83 `persistent-session-handle-effort.test.ts` blueprint
 * exactly: assert the SDK spy was CALLED with the exact model id. If the
 * wiring ever silently un-wires (same class of bug Phase 73 introduced for
 * setEffort), these tests fail loudly.
 *
 * Contract:
 *   - handle.setModel(modelId) → q.setModel(modelId) exactly once
 *   - setModel is synchronous (slash-command / IPC path cannot wait)
 *   - SDK rejection is swallowed + logged (fire-and-forget + .catch)
 *   - getModel() returns the most-recently-set id (state parity)
 *   - No coalescing: two sequential setModel calls produce two SDK calls
 *   - setModel does not throw when called before any turn has run
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import type { SdkModule, SdkQuery } from "../sdk-types.js";

// ---------------------------------------------------------------------------
// Harness — build an SdkModule whose Query exposes a spy'd setModel.
// No stream messages are consumed; these tests only exercise the mutation
// path (identical pattern to persistent-session-handle-effort.test.ts).
// ---------------------------------------------------------------------------

function buildHandleWithSpy(
  setModelSpy: ReturnType<typeof vi.fn>,
): ReturnType<typeof createPersistentSessionHandle> {
  // Minimal async-iterator shim — never yields. Tests don't consume the
  // stream; they only call setModel + inspect the spy.
  const next = (): Promise<IteratorResult<never>> =>
    new Promise(() => {
      // Never resolve — handle can't consume anything because these tests
      // never call send(). That's fine; setModel is synchronous-dispatch
      // and doesn't depend on the stream.
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
    setModel: setModelSpy,
  } as unknown as SdkQuery;

  const sdkMock: SdkModule = {
    query: vi.fn(() => query),
  } as unknown as SdkModule;

  return createPersistentSessionHandle(sdkMock, {}, "sess-model");
}

describe("persistent-session-handle setModel — SDK wire regression pin (Phase 86 MODEL-03)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("P1: setModel('claude-sonnet-4-5') invokes q.setModel exactly once with that id", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    const handle = buildHandleWithSpy(spy);
    handle.setModel("claude-sonnet-4-5");
    // Fire-and-forget — give the microtask queue a tick to resolve the promise.
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("claude-sonnet-4-5");
    await handle.close();
  });

  it("P2: two sequential setModel calls produce two SDK calls in order (no coalescing)", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    const handle = buildHandleWithSpy(spy);
    handle.setModel("claude-haiku-4-5");
    handle.setModel("claude-opus-4-8");
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls).toEqual([["claude-haiku-4-5"], ["claude-opus-4-8"]]);
    await handle.close();
  });

  it("P3: getModel() returns the most recently set id (state parity)", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    const handle = buildHandleWithSpy(spy);
    handle.setModel("claude-sonnet-4-5");
    expect(handle.getModel()).toBe("claude-sonnet-4-5");
    handle.setModel("claude-opus-4-8");
    expect(handle.getModel()).toBe("claude-opus-4-8");
    await handle.close();
  });

  it("P4: SDK rejection does not throw synchronously; warning logged via console.warn", async () => {
    const spy = vi.fn().mockRejectedValue(new Error("sdk blew up"));
    const handle = buildHandleWithSpy(spy);
    // Must not throw synchronously — slash-command / IPC path relies on this.
    expect(() => handle.setModel("claude-sonnet-4-5")).not.toThrow();
    // Give the rejection a chance to propagate through the .catch handler.
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith("claude-sonnet-4-5");
    // Warning logged, not thrown.
    expect(warnSpy).toHaveBeenCalled();
    await handle.close();
  });

  it("P5: setModel does not throw when called immediately after handle creation", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    const handle = buildHandleWithSpy(spy);
    // No turn has run yet — driverIter is captured but no messages pushed.
    // Invocation must be a clean no-throw.
    expect(() => handle.setModel("claude-haiku-4-5")).not.toThrow();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith("claude-haiku-4-5");
    await handle.close();
  });
});
