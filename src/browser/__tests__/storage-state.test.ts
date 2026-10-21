import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadState, saveState, makeDebouncedSaver } from "../storage-state.js";
import { BrowserError } from "../errors.js";
import type { BrowserContext, BrowserLogger } from "../types.js";

/**
 * Fake BrowserContext that records storageState() calls and can simulate
 * Playwright's disk-write behavior (or a failure).
 */
function createMockContext(opts: {
  writeJson?: string;
  throwError?: Error;
} = {}): { ctx: BrowserContext; calls: Array<{ path: string; indexedDB?: boolean }> } {
  const calls: Array<{ path: string; indexedDB?: boolean }> = [];
  const ctx = {
    storageState: vi.fn(async (args: { path?: string; indexedDB?: boolean }) => {
      if (args.path) {
        calls.push({ path: args.path, indexedDB: args.indexedDB });
        if (opts.throwError) throw opts.throwError;
        await writeFile(args.path, opts.writeJson ?? '{"cookies":[],"origins":[]}');
      }
      return {} as Record<string, unknown>;
    }),
  } as unknown as BrowserContext;
  return { ctx, calls };
}

describe("loadState", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "loadState-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined when the file does not exist", async () => {
    const result = await loadState(join(dir, "state.json"));
    expect(result).toBeUndefined();
  });

  it("returns the path when file exists with content", async () => {
    const p = join(dir, "state.json");
    await writeFile(p, '{"ok":1}');
    const result = await loadState(p);
    expect(result).toBe(p);
  });

  it("returns undefined on zero-byte file (Pitfall 10 guard)", async () => {
    const p = join(dir, "state.json");
    await writeFile(p, "");
    const result = await loadState(p);
    expect(result).toBeUndefined();
  });
});

describe("saveState", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "saveState-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates parent directory if missing", async () => {
    const nested = join(dir, "nested", "deep", "state.json");
    const { ctx, calls } = createMockContext();
    await saveState(ctx, nested);
    // Parent created, file renamed from .tmp, content persisted.
    const s = await stat(nested);
    expect(s.size).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(`${nested}.tmp`);
    expect(calls[0].indexedDB).toBe(true);
  });

  it("atomically renames the .tmp file to the final path", async () => {
    const p = join(dir, "state.json");
    const { ctx } = createMockContext({ writeJson: '{"final":true}' });
    await saveState(ctx, p);
    const content = await readFile(p, "utf-8");
    expect(content).toBe('{"final":true}');
    // .tmp should NOT exist post-rename
    await expect(stat(`${p}.tmp`)).rejects.toThrow();
  });

  it("wraps underlying storageState failures in BrowserError(internal)", async () => {
    const p = join(dir, "state.json");
    const { ctx } = createMockContext({ throwError: new Error("disk full") });
    await expect(saveState(ctx, p)).rejects.toBeInstanceOf(BrowserError);
    try {
      await saveState(ctx, p);
    } catch (err) {
      expect(err).toBeInstanceOf(BrowserError);
      const bErr = err as BrowserError;
      expect(bErr.type).toBe("internal");
      expect(bErr.message).toContain("disk full");
    }
  });
});

describe("makeDebouncedSaver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses 3 rapid triggers into 1 saveFn call", async () => {
    const saveFn = vi.fn(async () => {});
    const saver = makeDebouncedSaver(saveFn, 5000);

    saver.trigger();
    saver.trigger();
    saver.trigger();
    expect(saveFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it("a trigger after idle produces a fresh call", async () => {
    const saveFn = vi.fn(async () => {});
    const saver = makeDebouncedSaver(saveFn, 1000);

    saver.trigger();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveFn).toHaveBeenCalledTimes(1);

    saver.trigger();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveFn).toHaveBeenCalledTimes(2);
  });

  it("flush() immediately runs any pending save", async () => {
    const saveFn = vi.fn(async () => {});
    const saver = makeDebouncedSaver(saveFn, 5000);

    saver.trigger();
    expect(saveFn).not.toHaveBeenCalled();
    await saver.flush();
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it("flush() with nothing pending resolves immediately", async () => {
    const saveFn = vi.fn(async () => {});
    const saver = makeDebouncedSaver(saveFn, 5000);
    await saver.flush();
    expect(saveFn).not.toHaveBeenCalled();
  });

  it("swallows errors in saveFn and logs via BrowserLogger.warn", async () => {
    const saveFn = vi.fn(async () => { throw new Error("boom"); });
    const log: BrowserLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const saver = makeDebouncedSaver(saveFn, 1000, log);

    saver.trigger();
    await vi.advanceTimersByTimeAsync(1000);
    // Allow the promise chain to settle.
    await vi.runAllTimersAsync();

    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it("flush() awaits an in-flight save even if timer already fired", async () => {
    const resolvers: Array<() => void> = [];
    const saveFn = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolvers.push(res);
        }),
    );
    const saver = makeDebouncedSaver(saveFn, 500);

    saver.trigger();
    // Fire the timer — save starts but has not resolved yet.
    await vi.advanceTimersByTimeAsync(500);
    expect(saveFn).toHaveBeenCalledTimes(1);

    // flush() should await the in-flight promise.
    const flushP = saver.flush();
    // Allow tick so flush sees the inflight.
    await Promise.resolve();
    for (const resolve of resolvers) resolve();
    await flushP;
  });
});
