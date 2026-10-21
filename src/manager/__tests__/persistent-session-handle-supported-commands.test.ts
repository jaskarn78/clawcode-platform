/**
 * Phase 87 Plan 01 Task 1 — SDK wire regression pin for getSupportedCommands.
 *
 * Mirrors the Phase 86 `persistent-session-handle-model.test.ts` blueprint:
 * assert the SDK spy was CALLED exactly once and that subsequent calls hit
 * the per-handle cache. If the wiring ever silently un-wires (same class of
 * bug Phase 73 introduced for setEffort), these tests fail loudly.
 *
 * Contract:
 *   - First call to handle.getSupportedCommands() invokes q.initializationResult
 *     exactly once
 *   - Second call returns the cached result (q.initializationResult NOT called
 *     a second time)
 *   - Returned shape is SlashCommand[] (name/description/argumentHint)
 *   - SDK rejection propagates as a thrown error and does NOT poison the
 *     cache — the next call retries
 */

import { describe, it, expect, vi } from "vitest";
import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import type { SdkModule, SdkQuery } from "../sdk-types.js";

type InitSpy = ReturnType<typeof vi.fn>;

function buildHandleWithInitSpy(
  initSpy: InitSpy,
): ReturnType<typeof createPersistentSessionHandle> {
  // Minimal async-iterator shim — never yields. Tests don't consume the
  // stream; they only call getSupportedCommands + inspect the spy.
  const next = (): Promise<IteratorResult<never>> =>
    new Promise(() => {
      /* never resolve */
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
    initializationResult: initSpy,
    supportedCommands: vi.fn(() => Promise.resolve([])),
  } as unknown as SdkQuery;

  const sdkMock: SdkModule = {
    query: vi.fn(() => query),
  } as unknown as SdkModule;

  return createPersistentSessionHandle(sdkMock, {}, "sess-cmds");
}

describe("persistent-session-handle getSupportedCommands — SDK wire + cache regression pin (Phase 87 CMD-01)", () => {
  it("P1: first call invokes q.initializationResult exactly once", async () => {
    const sampleCommands = [
      { name: "compact", description: "Compact context", argumentHint: "" },
      { name: "model", description: "Switch model", argumentHint: "<name>" },
    ];
    const spy = vi.fn().mockResolvedValue({
      commands: sampleCommands,
      agents: [],
      models: [],
    });
    const handle = buildHandleWithInitSpy(spy);
    const result = await handle.getSupportedCommands();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toEqual(sampleCommands);
    await handle.close();
  });

  it("P2: second call returns cached result (initializationResult NOT called again)", async () => {
    const spy = vi.fn().mockResolvedValue({
      commands: [{ name: "compact", description: "X", argumentHint: "" }],
      agents: [],
      models: [],
    });
    const handle = buildHandleWithInitSpy(spy);
    const first = await handle.getSupportedCommands();
    const second = await handle.getSupportedCommands();
    expect(spy).toHaveBeenCalledTimes(1);
    // Cached reference-equality not required — just shape equality.
    expect(second).toEqual(first);
    await handle.close();
  });

  it("P3: returned array shape is SlashCommand[] (name/description/argumentHint)", async () => {
    const spy = vi.fn().mockResolvedValue({
      commands: [
        { name: "compact", description: "Compact context", argumentHint: "" },
        { name: "cost", description: "Show cost", argumentHint: "" },
      ],
      agents: [],
      models: [],
    });
    const handle = buildHandleWithInitSpy(spy);
    const result = await handle.getSupportedCommands();
    expect(Array.isArray(result)).toBe(true);
    for (const cmd of result) {
      expect(typeof cmd.name).toBe("string");
      expect(typeof cmd.description).toBe("string");
      expect(typeof cmd.argumentHint).toBe("string");
    }
    await handle.close();
  });

  it("P4: SDK rejection throws; cache NOT populated; next call retries", async () => {
    const spy = vi
      .fn()
      .mockRejectedValueOnce(new Error("sdk not ready"))
      .mockResolvedValueOnce({
        commands: [{ name: "compact", description: "X", argumentHint: "" }],
        agents: [],
        models: [],
      });
    const handle = buildHandleWithInitSpy(spy);
    await expect(handle.getSupportedCommands()).rejects.toThrow(
      "sdk not ready",
    );
    // Second call must retry — cache should not have been populated on failure.
    const result = await handle.getSupportedCommands();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      { name: "compact", description: "X", argumentHint: "" },
    ]);
    await handle.close();
  });
});
