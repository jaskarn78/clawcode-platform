/**
 * Phase 94 Plan 03 — D-05 pattern 1: Playwright Chromium-missing recovery.
 *
 * Trigger: error matches `/Executable doesn't exist at .*ms-playwright/`.
 * Action: run `npx playwright install chromium --with-deps` via deps.execFile
 * with a 120s timeout. On exitCode=0 → "recovered" (heartbeat re-probes
 * lift status to ready). On non-zero exit → "give-up" with verbatim stderr.
 * On thrown rejection → "retry-later" with a 5min cool-down.
 *
 * DI-pure: no node:child_process imports here. Production wires execFile
 * at the daemon edge (mirrors Phase 91 sync-runner pattern).
 */

import type { RecoveryHandler, RecoveryOutcome } from "./types.js";

const PLAYWRIGHT_RE = /Executable doesn't exist at.*ms-playwright/i;

/**
 * Plan 94-03 invariant — pinned by static-grep:
 *   `npx playwright install chromium --with-deps` typically completes in
 *   30-90s depending on network + disk; 120s is the conservative cap. Above
 *   this and we surface a `retry-later` so the heartbeat doesn't block.
 */
const PLAYWRIGHT_TIMEOUT_MS = 120_000;

/** 5min cool-down on transient (thrown) failures. */
const PLAYWRIGHT_RETRY_AFTER_MS = 5 * 60_000;

export const playwrightChromiumHandler: RecoveryHandler = {
  name: "playwright-chromium",
  priority: 10,
  matches(error: string): boolean {
    return PLAYWRIGHT_RE.test(error);
  },
  async recover(serverName, deps): Promise<RecoveryOutcome> {
    const startNow = (deps.now ?? (() => new Date()))();
    const startMs = startNow.getTime();
    try {
      const result = await deps.execFile(
        "npx",
        ["playwright", "install", "chromium", "--with-deps"],
        { timeoutMs: PLAYWRIGHT_TIMEOUT_MS },
      );
      const endMs = (deps.now ?? (() => new Date()))().getTime();
      const durationMs = Math.max(0, endMs - startMs);
      if (result.exitCode === 0) {
        return {
          kind: "recovered",
          serverName,
          handlerName: "playwright-chromium",
          durationMs,
          note: "chromium installed via npx playwright install",
        };
      }
      return {
        kind: "give-up",
        serverName,
        handlerName: "playwright-chromium",
        reason: `npx playwright install exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
      };
    } catch (err) {
      // execFile threw (e.g., spawn ENOENT, timeout) — transient, retry later.
      const reason = err instanceof Error ? err.message : String(err);
      return {
        kind: "retry-later",
        serverName,
        handlerName: "playwright-chromium",
        retryAfterMs: PLAYWRIGHT_RETRY_AFTER_MS,
        reason,
      };
    }
  },
};

export { PLAYWRIGHT_TIMEOUT_MS };
