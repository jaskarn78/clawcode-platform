import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserManager } from "../manager.js";
import { BrowserError } from "../errors.js";
import type { BrowserDriver, BrowserLike, NewContextOptions } from "../manager.js";
import type { BrowserContext, BrowserLogger } from "../types.js";

/* ------------------------------------------------------------------ */
/*  Mock driver / browser / context / page builders                    */
/* ------------------------------------------------------------------ */

interface PageCall {
  goto: Array<{ url: string; timeout?: number }>;
  closed: number;
}

interface ContextCall {
  opts: NewContextOptions;
  storageStateCalls: Array<{ path?: string; indexedDB?: boolean }>;
  closed: number;
  closeHandlers: Array<() => void>;
  page: PageCall;
}

interface BrowserCall {
  launched: number;
  closed: number;
  contexts: ContextCall[];
}

interface MockSetup {
  driver: BrowserDriver;
  calls: BrowserCall;
  order: string[]; // records ordered events across context.storageState vs ctx.close
}

function createMockDriver(opts: {
  failLaunch?: Error;
  failProbeGoto?: Error;
  failStorageStateFor?: Set<string>; // ctx IDs to fail
  failCloseFor?: Set<string>;
} = {}): MockSetup {
  const calls: BrowserCall = { launched: 0, closed: 0, contexts: [] };
  const order: string[] = [];

  const makePage = (): { page: unknown; record: PageCall } => {
    const record: PageCall = { goto: [], closed: 0 };
    const page = {
      goto: vi.fn(async (url: string, gotoOpts?: { timeout?: number }) => {
        record.goto.push({ url, timeout: gotoOpts?.timeout });
        if (opts.failProbeGoto && url === "about:blank") {
          throw opts.failProbeGoto;
        }
        return null;
      }),
      close: vi.fn(async () => {
        record.closed++;
      }),
    };
    return { page, record };
  };

  const makeContext = (
    ctxOpts: NewContextOptions,
    ctxId: string,
  ): { ctx: BrowserContext; record: ContextCall } => {
    const { page, record: pageRecord } = makePage();
    const record: ContextCall = {
      opts: ctxOpts,
      storageStateCalls: [],
      closed: 0,
      closeHandlers: [],
      page: pageRecord,
    };
    const ctx = {
      newPage: vi.fn(async () => page),
      storageState: vi.fn(async (args: { path?: string; indexedDB?: boolean }) => {
        record.storageStateCalls.push({
          path: args?.path,
          indexedDB: args?.indexedDB,
        });
        order.push(`storageState:${ctxId}`);
        if (opts.failStorageStateFor?.has(ctxId)) {
          throw new Error(`forced storageState failure for ${ctxId}`);
        }
        if (args?.path) {
          await writeFile(args.path, `{"id":"${ctxId}"}`);
        }
        return {} as Record<string, unknown>;
      }),
      close: vi.fn(async () => {
        record.closed++;
        order.push(`close:${ctxId}`);
        if (opts.failCloseFor?.has(ctxId)) {
          throw new Error(`forced close failure for ${ctxId}`);
        }
        // Fire close handlers for cache hygiene assertions.
        for (const h of record.closeHandlers) h();
      }),
      on: vi.fn((event: string, cb: () => void) => {
        if (event === "close") record.closeHandlers.push(cb);
        return ctx;
      }),
    } as unknown as BrowserContext;
    return { ctx, record };
  };

  let nextCtxId = 0;
  const browser: BrowserLike = {
    newContext: vi.fn(async (ctxOpts: NewContextOptions) => {
      const id = `ctx${++nextCtxId}`;
      const { ctx, record } = makeContext(ctxOpts, id);
      calls.contexts.push(record);
      return ctx;
    }),
    close: vi.fn(async () => {
      calls.closed++;
      order.push("browser:close");
    }),
  };

  const driver: BrowserDriver = {
    launch: vi.fn(async () => {
      calls.launched++;
      if (opts.failLaunch) throw opts.failLaunch;
      return browser;
    }),
  };

  return { driver, calls, order };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("BrowserManager.warm", () => {
  it("launches browser once and resolves", async () => {
    const { driver, calls } = createMockDriver();
    const mgr = new BrowserManager({ driver });
    await mgr.warm();
    expect(calls.launched).toBe(1);
    expect(mgr.isReady()).toBe(true);
    await mgr.close();
  });

  it("is idempotent on parallel calls", async () => {
    const { driver, calls } = createMockDriver();
    const mgr = new BrowserManager({ driver });
    await Promise.all([mgr.warm(), mgr.warm(), mgr.warm()]);
    expect(calls.launched).toBe(1);
    await mgr.close();
  });

  it("health probe navigates to about:blank", async () => {
    const { driver, calls } = createMockDriver();
    const mgr = new BrowserManager({ driver });
    await mgr.warm();
    // The probe context is the first one — its page gets goto(about:blank).
    expect(calls.contexts).toHaveLength(1);
    expect(calls.contexts[0].page.goto).toEqual([
      { url: "about:blank", timeout: 5000 },
    ]);
    // Probe context should be closed after probe.
    expect(calls.contexts[0].closed).toBe(1);
    await mgr.close();
  });

  it("surfaces probe failure as BrowserError('launch_failed') and resets warmPromise", async () => {
    const { driver } = createMockDriver({ failProbeGoto: new Error("renderer crash") });
    const mgr = new BrowserManager({ driver });
    await expect(mgr.warm()).rejects.toBeInstanceOf(BrowserError);
    try {
      await mgr.warm();
    } catch (err) {
      expect(err).toBeInstanceOf(BrowserError);
      expect((err as BrowserError).type).toBe("launch_failed");
    }
    // After reset, a fresh warm (with successful driver) would re-launch.
    expect(mgr.isReady()).toBe(false);
  });

  it("surfaces launch failure with playwright-install hint", async () => {
    const { driver } = createMockDriver({
      failLaunch: new Error(`Executable doesn't exist at /foo/chromium`),
    });
    const mgr = new BrowserManager({ driver });
    await expect(mgr.warm()).rejects.toBeInstanceOf(BrowserError);
    try {
      await mgr.warm();
    } catch (err) {
      const be = err as BrowserError;
      expect(be.type).toBe("launch_failed");
      expect(be.message).toContain("playwright install chromium");
    }
  });

  it("supports re-warm after close", async () => {
    const { driver, calls } = createMockDriver();
    const mgr = new BrowserManager({ driver });
    await mgr.warm();
    await mgr.close();

    const mgr2 = new BrowserManager({ driver });
    await mgr2.warm();
    expect(calls.launched).toBe(2);
    await mgr2.close();
  });
});

describe("BrowserManager.getContext", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mgr-ctx-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("throws BrowserError('launch_failed') before warm", async () => {
    const { driver } = createMockDriver();
    const mgr = new BrowserManager({ driver });
    await expect(mgr.getContext("clawdy", dir)).rejects.toBeInstanceOf(BrowserError);
    try {
      await mgr.getContext("clawdy", dir);
    } catch (err) {
      expect((err as BrowserError).type).toBe("launch_failed");
    }
  });

  it("caches per-agent contexts — same agent reuses, different agents create new", async () => {
    const { driver, calls } = createMockDriver();
    const mgr = new BrowserManager({ driver });
    await mgr.warm();
    // Probe created ctx1; getContext creates fresh agent contexts.
    const c1a = await mgr.getContext("clawdy", dir);
    const c1b = await mgr.getContext("clawdy", dir);
    expect(c1a).toBe(c1b);

    const c2 = await mgr.getContext("rex", dir);
    expect(c2).not.toBe(c1a);

    // Probe + clawdy + rex = 3 newContext calls.
    expect(calls.contexts).toHaveLength(3);
    await mgr.close();
  });

  it("passes storageState when state.json exists and is non-zero", async () => {
    const statePath = join(dir, "browser", "state.json");
    // Pre-seed state.json so loadState returns the path.
    await writeFile(join(dir, "browser.placeholder"), "x").catch(() => {});
    const { driver, calls } = createMockDriver();
    const mgr = new BrowserManager({ driver });
    await mgr.warm();
    // Seed the state file AFTER warm (before first getContext call).
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "browser"), { recursive: true });
    await writeFile(statePath, '{"cookies":[],"origins":[]}');

    await mgr.getContext("clawdy", dir);
    // The agent context (index 1 — index 0 is probe) received storageState.
    expect(calls.contexts[1].opts.storageState).toBe(statePath);
    await mgr.close();
  });

  it("passes storageState=undefined on first run (no state.json)", async () => {
    const { driver, calls } = createMockDriver();
    const mgr = new BrowserManager({ driver });
    await mgr.warm();
    await mgr.getContext("clawdy", dir);
    expect(calls.contexts[1].opts.storageState).toBeUndefined();
    await mgr.close();
  });

  it("wires ctx.on('close') to purge cache — next getContext returns fresh ctx", async () => {
    const { driver, calls } = createMockDriver();
    const mgr = new BrowserManager({ driver });
    await mgr.warm();

    const c1 = await mgr.getContext("clawdy", dir);
    // Manually fire the close handler to simulate external close.
    const ctxRecord = calls.contexts[1];
    for (const h of ctxRecord.closeHandlers) h();

    const c2 = await mgr.getContext("clawdy", dir);
    // A new context was created (cache purged).
    expect(c2).not.toBe(c1);
    expect(calls.contexts).toHaveLength(3); // probe + clawdy1 + clawdy2
    await mgr.close();
  });
});

describe("BrowserManager.saveAgentState", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mgr-save-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("debounces — 3 rapid triggers collapse to one saveState call", async () => {
    const { driver, calls } = createMockDriver();
    // Short debounce so the test completes quickly on real timers.
    const mgr = new BrowserManager({ driver, debounceMs: 50 });
    await mgr.warm();
    await mgr.getContext("clawdy", dir);
    const agentCtx = calls.contexts[1];
    const countBefore = agentCtx.storageStateCalls.length;

    mgr.saveAgentState("clawdy");
    mgr.saveAgentState("clawdy");
    mgr.saveAgentState("clawdy");
    // Before the debounce window elapses, no save has fired.
    expect(agentCtx.storageStateCalls.length).toBe(countBefore);

    // Wait slightly longer than the debounce window + microtask settle.
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(agentCtx.storageStateCalls.length).toBe(countBefore + 1);

    await mgr.close();
  });

  it("is a no-op on an unknown agent", async () => {
    const { driver } = createMockDriver();
    const mgr = new BrowserManager({ driver, debounceMs: 50 });
    await mgr.warm();
    // No warning, no throw — just silently does nothing.
    expect(() => mgr.saveAgentState("never-seen")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await mgr.close();
  });
});

describe("BrowserManager.close", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mgr-close-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("saves state BEFORE closing contexts (Pitfall 10 ordering)", async () => {
    const { driver, calls, order } = createMockDriver();
    const mgr = new BrowserManager({ driver, debounceMs: 5000 });
    await mgr.warm();
    await mgr.getContext("clawdy", dir);
    await mgr.getContext("rex", dir);

    await mgr.close();

    // Expected order: save clawdy → save rex → close clawdy → close rex → browser:close
    // Filter to the events we care about (skip the probe's storageState/close).
    const filtered = order.filter((e) =>
      e.includes("ctx2") || e.includes("ctx3") || e === "browser:close",
    );
    // Every storageState for an agent ctx must come BEFORE that ctx's close.
    for (const ctxId of ["ctx2", "ctx3"]) {
      const saveIdx = filtered.indexOf(`storageState:${ctxId}`);
      const closeIdx = filtered.indexOf(`close:${ctxId}`);
      expect(saveIdx).toBeGreaterThanOrEqual(0);
      expect(closeIdx).toBeGreaterThan(saveIdx);
    }
    expect(filtered[filtered.length - 1]).toBe("browser:close");
    expect(calls.closed).toBe(1);
  });

  it("closes every cached context and the browser", async () => {
    const { driver, calls } = createMockDriver();
    const mgr = new BrowserManager({ driver });
    await mgr.warm();
    await mgr.getContext("clawdy", dir);
    await mgr.getContext("rex", dir);

    await mgr.close();

    // Two agent contexts closed (+ probe already closed during warm).
    expect(calls.contexts[1].closed).toBe(1);
    expect(calls.contexts[2].closed).toBe(1);
    expect(calls.closed).toBe(1);
  });

  it("per-agent save failure does not block shutdown", async () => {
    const { driver, calls } = createMockDriver({
      failStorageStateFor: new Set(["ctx2"]),
    });
    const log: BrowserLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const mgr = new BrowserManager({ driver, log });
    await mgr.warm();
    await mgr.getContext("clawdy", dir);
    await mgr.getContext("rex", dir);

    await expect(mgr.close()).resolves.toBeUndefined();
    // rex's save happened; clawdy's failed but was logged.
    const rexCtx = calls.contexts[2];
    expect(rexCtx.storageStateCalls.length).toBeGreaterThan(0);
    expect(log.warn).toHaveBeenCalled();
    expect(calls.closed).toBe(1);
  });

  it("is idempotent — second close is a no-op", async () => {
    const { driver, calls } = createMockDriver();
    const mgr = new BrowserManager({ driver });
    await mgr.warm();
    await mgr.close();
    await expect(mgr.close()).resolves.toBeUndefined();
    // browser.close was only called once.
    expect(calls.closed).toBe(1);
  });
});
