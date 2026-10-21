/**
 * Phase 87 Plan 02 Task 1 — SDK canary regression pin for setPermissionMode wiring.
 *
 * Third application of the Phase 83/86 blueprint (setMaxThinkingTokens,
 * setModel, setPermissionMode). Mirrors `persistent-session-handle-model.test.ts`
 * byte for byte: assert the SDK spy was CALLED with the exact mode string.
 * If the wire ever silently un-wires, these tests fail loudly.
 *
 * Contract:
 *   - handle.setPermissionMode(mode) → q.setPermissionMode(mode) exactly once
 *   - setPermissionMode is synchronous (slash-command / IPC path cannot wait)
 *   - SDK rejection is swallowed + logged (fire-and-forget + .catch)
 *   - getPermissionMode() returns the most-recently-set mode (state parity)
 *   - No coalescing: two sequential setPermissionMode calls produce two SDK calls
 *   - setPermissionMode does not throw when called before any turn has run
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import type { SdkModule, SdkQuery } from "../sdk-types.js";

// ---------------------------------------------------------------------------
// Harness — build an SdkModule whose Query exposes a spy'd setPermissionMode.
// No stream messages are consumed; these tests only exercise the mutation
// path (identical pattern to persistent-session-handle-model.test.ts).
// ---------------------------------------------------------------------------

function buildHandleWithSpy(
  setPermissionModeSpy: ReturnType<typeof vi.fn>,
): ReturnType<typeof createPersistentSessionHandle> {
  // Minimal async-iterator shim — never yields. Tests don't consume the
  // stream; they only call setPermissionMode + inspect the spy.
  const next = (): Promise<IteratorResult<never>> =>
    new Promise(() => {
      // Never resolve — handle can't consume anything because these tests
      // never call send(). That's fine; setPermissionMode is synchronous
      // dispatch and doesn't depend on the stream.
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
    setPermissionMode: setPermissionModeSpy,
  } as unknown as SdkQuery;

  const sdkMock: SdkModule = {
    query: vi.fn(() => query),
  } as unknown as SdkModule;

  return createPersistentSessionHandle(sdkMock, {}, "sess-permission");
}

describe("persistent-session-handle setPermissionMode — SDK wire regression pin (Phase 87 CMD-02)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("P1: setPermissionMode('bypassPermissions') invokes q.setPermissionMode exactly once with that mode", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    const handle = buildHandleWithSpy(spy);
    handle.setPermissionMode("bypassPermissions");
    // Fire-and-forget — give the microtask queue a tick to resolve the promise.
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("bypassPermissions");
    await handle.close();
  });

  it("P2: two sequential setPermissionMode calls produce two SDK calls in order (no coalescing)", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    const handle = buildHandleWithSpy(spy);
    handle.setPermissionMode("plan");
    handle.setPermissionMode("acceptEdits");
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls).toEqual([["plan"], ["acceptEdits"]]);
    await handle.close();
  });

  it("P3: getPermissionMode() returns the most recently set mode (state parity)", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    const handle = buildHandleWithSpy(spy);
    handle.setPermissionMode("bypassPermissions");
    expect(handle.getPermissionMode()).toBe("bypassPermissions");
    handle.setPermissionMode("acceptEdits");
    expect(handle.getPermissionMode()).toBe("acceptEdits");
    await handle.close();
  });

  it("P4: SDK rejection does not throw synchronously; warning logged via console.warn", async () => {
    const spy = vi.fn().mockRejectedValue(new Error("sdk blew up"));
    const handle = buildHandleWithSpy(spy);
    // Must not throw synchronously — slash-command / IPC path relies on this.
    expect(() => handle.setPermissionMode("bypassPermissions")).not.toThrow();
    // Give the rejection a chance to propagate through the .catch handler.
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith("bypassPermissions");
    // Warning logged, not thrown.
    expect(warnSpy).toHaveBeenCalled();
    // Verify the warning message prefix matches the wire spec.
    const warnCalls = warnSpy.mock.calls
      .map((c: readonly unknown[]) => (typeof c[0] === "string" ? c[0] : ""))
      .join("\n");
    expect(warnCalls).toMatch(/\[permission\] setPermissionMode/);
    await handle.close();
  });

  it("P5: setPermissionMode does not throw when called immediately after handle creation", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    const handle = buildHandleWithSpy(spy);
    // No turn has run yet — driverIter is captured but no messages pushed.
    // Invocation must be a clean no-throw.
    expect(() => handle.setPermissionMode("plan")).not.toThrow();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith("plan");
    await handle.close();
  });
});
