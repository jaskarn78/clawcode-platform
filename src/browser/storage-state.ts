import { access, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { BrowserError } from "./errors.js";
import type { BrowserContext, BrowserLogger } from "./types.js";

/**
 * Phase 70 — per-agent storageState persistence helpers.
 *
 * Architecture: Option 2 from 70-RESEARCH.md — shared `chromium.launch()`
 * browser + per-agent `newContext({ storageState })`. This module owns
 * the disk read/write of `<workspace>/browser/state.json`, including:
 *   - First-run guard (Pitfall 10): zero-byte state files from an
 *     ungraceful shutdown return `undefined` so Playwright never tries
 *     to parse them and crash the newContext call.
 *   - Atomic write: write to `.tmp`, rename — rename is atomic on the
 *     same filesystem, so a crash mid-save cannot corrupt the final file.
 *   - Debounced save: multiple rapid writes collapse to a single disk
 *     write after a quiet window (default 5s in manager.ts).
 */

/**
 * Return the given path if a non-zero-byte state.json exists, else undefined.
 *
 * Zero-byte files are treated as first-run (Pitfall 10 from 70-RESEARCH.md:
 * partial write during ungraceful shutdown — don't hand them to Playwright
 * or it crashes the newContext call).
 */
export async function loadState(statePath: string): Promise<string | undefined> {
  try {
    await access(statePath);
    const s = await stat(statePath);
    if (s.size === 0) return undefined;
    return statePath;
  } catch {
    return undefined;
  }
}

/**
 * Save context storageState atomically: write to `<statePath>.tmp`, then
 * rename. Rename is atomic on the same filesystem.
 *
 * `indexedDB: true` is required so OAuth and IndexedDB-backed auth state
 * survives restart — without it, Option 2 loses the auth-token case
 * that a dedicated persistent-profile approach would have captured.
 *
 * Stale `.tmp` from a prior crash is best-effort unlinked on entry.
 *
 * On ANY failure from `ctx.storageState` the error is wrapped in a
 * `BrowserError("internal", ...)` with the original error threaded
 * through `cause` so stack traces survive.
 */
export async function saveState(
  ctx: BrowserContext,
  statePath: string,
): Promise<void> {
  const tmp = `${statePath}.tmp`;
  try {
    await mkdir(dirname(statePath), { recursive: true });
    await unlink(tmp).catch(() => { /* stale .tmp — ignore */ });
    await ctx.storageState({ path: tmp, indexedDB: true });
    await rename(tmp, statePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BrowserError("internal", `storageState save failed: ${msg}`, {
      cause: err,
    });
  }
}

/**
 * Best-effort debounced saver.
 *
 * Multiple rapid `trigger()` calls collapse to a single `saveFn()`
 * execution after `waitMs` of quiet. `flush()` awaits any pending or
 * in-flight save — used on shutdown to guarantee the last pending
 * save lands before `close()`.
 *
 * Errors from `saveFn` are logged via the optional `BrowserLogger`
 * (`warn` level) but NOT thrown. Rationale: storageState loss is not
 * fatal (agent recovers next warm), so surfacing this to tool callers
 * would be noisier than useful. Plan 03's shutdown path calls
 * `saveAgentStateNow` which DOES throw — the debounced path
 * deliberately does not.
 */
export function makeDebouncedSaver(
  saveFn: () => Promise<void>,
  waitMs: number,
  log?: BrowserLogger,
): { trigger: () => void; flush: () => Promise<void> } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    timer = null;
    try {
      const p = saveFn();
      inflight = p;
      await p;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn({ err: msg }, "debounced storageState save failed");
    } finally {
      inflight = null;
    }
  };

  return {
    trigger(): void {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void run();
      }, waitMs);
    },
    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        await run();
        return;
      }
      if (inflight) await inflight;
    },
  };
}
