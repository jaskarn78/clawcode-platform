/**
 * Phase 999.98 Plan 01 Task 3 — Fable effort-`off`→null guard regression pin.
 *
 * Asserts the EXACT value production hands the SDK at the setEffort wire site:
 *   - fable executor + `off`  → q.setMaxThinkingTokens(null)   [the guard fires]
 *   - opus  executor + `off`  → q.setMaxThinkingTokens(0)      [unchanged]
 *   - fable executor + `low`  → q.setMaxThinkingTokens(1024)   [guard only on 0]
 *
 * `currentModel` is seeded from `baseOptions.model` (the resolved SDK id) at
 * handle construction, so passing `model: "claude-fable-5"` reproduces the boot
 * state of a `model: fable` agent BEFORE any setModel call — which is exactly
 * when the guard must fire. A test that asserted against the alias or a stub
 * would pass while production silently no-ops; these assert the production rep.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import type { SdkModule, SdkQuery } from "../sdk-types.js";
import type { AdapterBaseOptions } from "../session-adapter.js";

function buildHandleWithSpy(
  setMaxThinkingTokensSpy: ReturnType<typeof vi.fn>,
  baseOptions: AdapterBaseOptions,
): ReturnType<typeof createPersistentSessionHandle> {
  // Minimal async-iterator shim — never yields. Tests only exercise the
  // synchronous setEffort mutation path; they never send().
  const next = (): Promise<IteratorResult<never>> =>
    new Promise(() => {
      // Never resolves — fine, setEffort does not depend on the stream.
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
    setMaxThinkingTokens: setMaxThinkingTokensSpy,
  } as unknown as SdkQuery;

  const sdkMock: SdkModule = {
    query: vi.fn(() => query),
  } as unknown as SdkModule;

  return createPersistentSessionHandle(sdkMock, baseOptions, "sess-effort-fable");
}

describe("persistent-session-handle setEffort — Fable off→null guard (Phase 999.98 D4)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("fable + setEffort('off') → q.setMaxThinkingTokens(null) (NOT 0) — the guard fires", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    const handle = buildHandleWithSpy(spy, { model: "claude-fable-5" });
    handle.setEffort("off");
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(null);
    await handle.close();
  });

  it("opus + setEffort('off') → q.setMaxThinkingTokens(0) — guard does NOT fire for non-fable", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    const handle = buildHandleWithSpy(spy, { model: "claude-opus-4-8" });
    handle.setEffort("off");
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(0);
    await handle.close();
  });

  it("fable + setEffort('low') → q.setMaxThinkingTokens(1024) — guard only fires on a 0 budget", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    const handle = buildHandleWithSpy(spy, { model: "claude-fable-5" });
    handle.setEffort("low");
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(1024);
    await handle.close();
  });

  it("fable + setEffort('auto') → q.setMaxThinkingTokens(null) — auto already maps to null (guard inert)", async () => {
    const spy = vi.fn().mockResolvedValue(undefined);
    const handle = buildHandleWithSpy(spy, { model: "claude-fable-5" });
    handle.setEffort("auto");
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(null);
    await handle.close();
  });
});
