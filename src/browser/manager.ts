import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import { BrowserError } from "./errors.js";
import { loadState, saveState, makeDebouncedSaver } from "./storage-state.js";
import type { BrowserContext, BrowserLogger } from "./types.js";

/**
 * Phase 70 — BrowserManager singleton.
 *
 * Owns the shared Chromium process (one per daemon) and a per-agent
 * BrowserContext cache. Architecture is locked to Option 2 from
 * 70-RESEARCH.md:
 *
 *   chromium.launch()                         # shared Browser, warmed at boot
 *     └── browser.newContext({ storageState }) # per agent, lazy-first-call
 *
 * NOT a persistent-profile launch — that call cannot share a Browser
 * across multiple userDataDirs (70-RESEARCH.md Pitfall 1). Every
 * persistent context IS a separate browser process. Trying it means 14
 * Chromium processes, ~5GB RSS floor. Storage-state + shared Browser
 * keeps us in the ~50-150MB-per-agent band.
 *
 * Pitfall 2 guard: we do NOT disable the Chromium sandbox via launch
 * flags. The daemon runs as `clawcode` (non-root), so the Chromium
 * user-namespace sandbox works. Disabling it unnecessarily is a
 * security regression. The Playwright install-deps path handles
 * system libs.
 *
 * Pitfall 10 guard: close() performs strict ordering:
 *   1. For each agent: flush debounced saver → perform immediate save.
 *   2. For each agent: close BrowserContext.
 *   3. Close Browser.
 * This prevents storageState writes from racing with ctx.close and
 * corrupting state.json.
 */

/* ------------------------------------------------------------------ */
/*  Minimal types — keeps the module decoupled from playwright-core    */
/*  at compile time (and lets tests inject a mock driver).             */
/* ------------------------------------------------------------------ */

/** Options passed to `browser.newContext()`. Mirrors playwright-core. */
export interface NewContextOptions {
  storageState?: string | undefined;
  viewport?: { width: number; height: number };
  userAgent?: string;
}

/** Minimal Browser surface the manager relies on. */
export interface BrowserLike {
  newContext(options: NewContextOptions): Promise<BrowserContext>;
  close(): Promise<void>;
}

/** Minimal driver surface — mirrors `chromium.launch` contract. */
export interface BrowserDriver {
  launch(options: { headless: boolean; args: string[] }): Promise<BrowserLike>;
}

/** Options for BrowserManager construction. */
export interface BrowserManagerOpts {
  headless?: boolean;
  viewport?: { width: number; height: number };
  userAgent?: string | null;
  log?: BrowserLogger;
  /** DI seam — tests inject a mock driver so manager tests run without real Chromium. */
  driver?: BrowserDriver;
  /** Debounce window for `saveAgentState`. Defaults to 5000ms per 70-RESEARCH Q4. */
  debounceMs?: number;
}

/* ------------------------------------------------------------------ */
/*  Per-agent cache entry                                              */
/* ------------------------------------------------------------------ */

interface AgentEntry {
  ctx: BrowserContext;
  workspace: string;
  statePath: string;
}

/* ------------------------------------------------------------------ */
/*  BrowserManager                                                     */
/* ------------------------------------------------------------------ */

export class BrowserManager {
  private browser: BrowserLike | null = null;
  private warmPromise: Promise<void> | null = null;
  private readonly contexts = new Map<string, AgentEntry>();
  private readonly savers = new Map<
    string,
    { trigger(): void; flush(): Promise<void> }
  >();
  private readonly headless: boolean;
  private readonly viewport: { width: number; height: number };
  private readonly userAgent?: string;
  private readonly debounceMs: number;
  private readonly log?: BrowserLogger;
  private readonly driverOverride?: BrowserDriver;
  private closed = false;

  constructor(opts: BrowserManagerOpts = {}) {
    this.headless = opts.headless ?? true;
    this.viewport = opts.viewport ?? { width: 1280, height: 720 };
    // null userAgent → leave undefined so Playwright picks the default.
    if (opts.userAgent !== null && opts.userAgent !== undefined) {
      this.userAgent = opts.userAgent;
    }
    this.debounceMs = opts.debounceMs ?? 5000;
    this.log = opts.log;
    this.driverOverride = opts.driver;
  }

  isReady(): boolean {
    return this.browser !== null;
  }

  /**
   * Idempotent warm — parallel callers await the same promise. On failure
   * the warmPromise is reset so the next call can retry; on success the
   * Browser handle stays cached and subsequent calls short-circuit.
   */
  async warm(): Promise<void> {
    if (this.closed) {
      throw new BrowserError("launch_failed", "BrowserManager is closed");
    }
    if (this.browser) return;
    if (this.warmPromise) return this.warmPromise;
    this.warmPromise = this.doWarm();
    try {
      await this.warmPromise;
    } catch (err) {
      // Reset so callers can retry after a transient failure.
      this.warmPromise = null;
      throw err;
    }
  }

  private async doWarm(): Promise<void> {
    const started = Date.now();
    const driver = this.driverOverride ?? (await this.resolveDefaultDriver());

    let browser: BrowserLike;
    try {
      // Empty args — Pitfall 2 guard keeps the Chromium sandbox enabled.
      browser = await driver.launch({ headless: this.headless, args: [] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BrowserError(
        "launch_failed",
        `Chromium launch failed: ${msg}. Hint: one-time setup — run "npx playwright install chromium --only-shell" and (on a fresh Linux box) "sudo npx playwright install-deps chromium".`,
        { cause: err },
      );
    }

    // Health probe — exercise the full Playwright→CDP→Chromium→renderer
    // path without network. Hard-fails on missing system libs (libnss3,
    // libgbm), sandbox failures, or renderer crashes.
    try {
      const probeCtx = await browser.newContext({});
      const probePage = await probeCtx.newPage();
      await probePage.goto("about:blank", { timeout: 5000 });
      await probeCtx.close();
    } catch (err) {
      // Clean up the browser we just launched so a retry can start fresh.
      await browser.close().catch(() => {
        /* ignore */
      });
      const msg = err instanceof Error ? err.message : String(err);
      throw new BrowserError(
        "launch_failed",
        `Chromium health probe failed: ${msg}`,
        { cause: err },
      );
    }

    this.browser = browser;
    this.log?.info(
      { durationMs: Date.now() - started },
      "browser warm+probe ok",
    );
  }

  private async resolveDefaultDriver(): Promise<BrowserDriver> {
    try {
      // Dynamic import mirrors src/memory/embedder.ts:68 — module load
      // stays cheap so tests can inject a DI driver without touching
      // Playwright's install path.
      const mod = await import("playwright-core");
      return {
        launch: (opts) => mod.chromium.launch(opts) as Promise<BrowserLike>,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BrowserError(
        "launch_failed",
        `playwright-core import failed: ${msg}`,
        { cause: err },
      );
    }
  }

  /**
   * Get-or-create a BrowserContext for the given agent. Hydrates from
   * `<workspace>/browser/state.json` when that file exists and is
   * non-zero (first-run or partial-write guard via loadState).
   *
   * Cached context is reused on subsequent calls for the same agent.
   * `ctx.on("close")` is wired to purge the cache so an externally-
   * closed context (e.g. Playwright renderer crash) is replaced
   * on next call rather than returning a dead handle.
   */
  async getContext(agent: string, workspace: string): Promise<BrowserContext> {
    if (!this.browser) {
      throw new BrowserError(
        "launch_failed",
        "browser not warmed — call warm() first",
      );
    }
    const cached = this.contexts.get(agent);
    if (cached) return cached.ctx;

    const statePath = join(workspace, "browser", "state.json");
    await mkdir(dirname(statePath), { recursive: true });
    const storageState = await loadState(statePath);

    const newContextOpts: NewContextOptions = {
      storageState,
      viewport: this.viewport,
      ...(this.userAgent !== undefined ? { userAgent: this.userAgent } : {}),
    };
    const ctx = await this.browser.newContext(newContextOpts);

    this.contexts.set(agent, { ctx, workspace, statePath });
    this.savers.set(
      agent,
      makeDebouncedSaver(
        () => saveState(ctx, statePath),
        this.debounceMs,
        this.log,
      ),
    );
    // Cache hygiene — drop the entry if the context is externally closed.
    ctx.on("close", () => {
      this.contexts.delete(agent);
      this.savers.delete(agent);
    });
    return ctx;
  }

  /**
   * Trigger a debounced save of this agent's storageState. No-op if
   * the agent has no cached context. Multiple rapid calls collapse
   * into a single disk write after `debounceMs` of quiet — prevents
   * write amplification on burst navigation / form-fill sequences.
   */
  saveAgentState(agent: string): void {
    this.savers.get(agent)?.trigger();
  }

  /**
   * Shutdown-path save: flush the debounced saver and then perform
   * an immediate atomic save. Called by close() for each cached agent.
   * Throws `BrowserError("internal")` if saveState fails — callers
   * MUST catch and swallow per-agent failures so one bad agent does
   * not block the rest of shutdown.
   */
  async saveAgentStateNow(agent: string): Promise<void> {
    const entry = this.contexts.get(agent);
    if (!entry) return;
    const saver = this.savers.get(agent);
    if (saver) await saver.flush();
    await saveState(entry.ctx, entry.statePath);
  }

  /**
   * Graceful shutdown — Pitfall 10 ordering:
   *   (1) Save every agent's storageState to disk.
   *   (2) Close every BrowserContext.
   *   (3) Close the Browser.
   *
   * Per-agent failures in step (1) or (2) are logged at `warn` level
   * but swallowed so shutdown always reaches step (3). Second close
   * is a no-op — safe to call from a SIGTERM handler that may fire
   * twice due to systemd timing.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Step 1: save every agent's state BEFORE closing contexts (Pitfall 10).
    for (const agent of this.contexts.keys()) {
      try {
        await this.saveAgentStateNow(agent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log?.warn(
          { agent, err: msg },
          "per-agent storageState save failed on shutdown",
        );
      }
    }

    // Step 2: close every cached context.
    for (const [agent, entry] of this.contexts) {
      try {
        await entry.ctx.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log?.warn(
          { agent, err: msg },
          "per-agent context close failed on shutdown",
        );
      }
    }
    this.contexts.clear();
    this.savers.clear();

    // Step 3: close the shared Browser.
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log?.warn({ err: msg }, "browser close failed");
      }
      this.browser = null;
    }
    this.warmPromise = null;
    this.log?.info("browser manager closed");
  }
}
