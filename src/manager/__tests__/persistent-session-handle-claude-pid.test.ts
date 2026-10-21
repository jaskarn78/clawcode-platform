/**
 * FIND-123-A.next T-06 — lifecycle test for handle.getClaudePid().
 *
 * Verifies the per-handle pidSink contract:
 *
 *   1. Before any spawn — handle.getClaudePid() returns null.
 *   2. After SDK invokes spawnClaudeCodeProcess — sink mutates; getClaudePid()
 *      returns the live PID synchronously.
 *   3. On handle.close() — sink clears to null. Terminal-shutdown safety
 *      pin: the daemon's group-kill loop in T-03 must NEVER target a PID
 *      the kernel has since recycled (locked sink semantics).
 *
 * The SDK invokes `spawnClaudeCodeProcess` synchronously inside its own
 * `ProcessTransport.initialize()`; this test simulates that by inspecting
 * the option the handle passes to `sdk.query()` and calling the captured
 * spawn closure directly with realistic SpawnOptions.
 */

import { describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import type { SdkModule, SdkQuery } from "../sdk-types.js";

type SpawnHookArg = {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
};

type SpawnedShape = {
  pid: number;
  on(e: "exit", l: () => void): void;
};

function buildHandleHarness(): {
  handle: ReturnType<typeof createPersistentSessionHandle>;
  capturedSpawnHook: () => ((opts: SpawnHookArg) => SpawnedShape) | undefined;
  closeMock: ReturnType<typeof vi.fn>;
} {
  let spawnHook: ((opts: SpawnHookArg) => SpawnedShape) | undefined;

  const closeMock = vi.fn(() => undefined);
  const query = vi.fn((params: { prompt: unknown; options?: unknown }) => {
    const opts = params.options as
      | { spawnClaudeCodeProcess?: (o: SpawnHookArg) => SpawnedShape }
      | undefined;
    if (opts?.spawnClaudeCodeProcess) {
      spawnHook = opts.spawnClaudeCodeProcess;
    }
    // Minimal Query shape — never iterated by this test.
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise(() => {
              /* never resolves */
            }),
        };
      },
      close: closeMock,
      interrupt: vi.fn(() => Promise.resolve()),
      setMaxThinkingTokens: vi.fn(() => Promise.resolve(undefined)),
      setModel: vi.fn(() => Promise.resolve(undefined)),
      setPermissionMode: vi.fn(() => Promise.resolve(undefined)),
    } as unknown as SdkQuery;
  });

  const handle = createPersistentSessionHandle(
    { query } as unknown as SdkModule,
    { model: "sonnet" },
    "sess-pid-test",
  );

  return {
    handle,
    capturedSpawnHook: () => spawnHook,
    closeMock,
  };
}

describe("createPersistentSessionHandle — getClaudePid lifecycle (T-06)", () => {
  it("returns null before any SDK spawn callback fires", () => {
    const { handle } = buildHandleHarness();
    expect(handle.getClaudePid?.()).toBeNull();
  });

  it("returns the live PID after spawnClaudeCodeProcess populates the sink", async () => {
    const { handle, capturedSpawnHook } = buildHandleHarness();
    expect(handle.getClaudePid?.()).toBeNull();

    const hook = capturedSpawnHook();
    expect(hook).toBeDefined();

    const ac = new AbortController();
    const child = hook!({
      command: "sleep",
      args: ["5"],
      env: { ...process.env } as Record<string, string | undefined>,
      signal: ac.signal,
    });

    expect(child.pid).toBeGreaterThan(1);
    expect(handle.getClaudePid?.()).toBe(child.pid);

    // Cleanup spawned child.
    if (process.platform === "linux") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* best-effort */
      }
    }
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    void ac;
  });

  it("close() clears the sink so a post-close getClaudePid returns null", async () => {
    const { handle, capturedSpawnHook } = buildHandleHarness();
    const hook = capturedSpawnHook();
    expect(hook).toBeDefined();

    const ac = new AbortController();
    const child = hook!({
      command: "sleep",
      args: ["5"],
      env: { ...process.env } as Record<string, string | undefined>,
      signal: ac.signal,
    });
    expect(handle.getClaudePid?.()).toBe(child.pid);

    // Terminal shutdown: handle.close() must clear the sink BEFORE the
    // daemon's group-kill loop could read it (defense against killing a
    // recycled PID — locked sink semantics).
    await handle.close();
    expect(handle.getClaudePid?.()).toBeNull();

    if (process.platform === "linux") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* best-effort */
      }
    }
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    void ac;
  });
});

// Quiet lint — spawn is used transitively via makeDetachedSpawn at runtime.
void spawn;
