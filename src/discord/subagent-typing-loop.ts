import type { Logger } from "pino";

/**
 * Phase 999.36 sub-bug A (D-04, D-05) — typing-indicator emit loop for
 * subagent thread dispatch. Mirrors bridge.ts:357-377 (fireTypingIndicator)
 * + bridge.ts:606-611 (8-second re-typing heartbeat) reference patterns.
 *
 * Cadence: 8s. Discord typing extends ~10s per call; 2s margin keeps the
 * indicator solid under clock drift (D-05).
 *
 * Failure mode: observational. sendTyping rejections (archived threads,
 * rate limits, missing permissions) are caught + log.debug'd, never thrown.
 * Surfaces without sendTyping (test mocks) produce a no-op handle.
 *
 * Caller MUST call `returnedHandle.stop()` in a finally block — leaving the
 * setInterval running on a dead thread leaks a timer for the daemon's life.
 */

/** D-05 cadence regression pin. Exported for tests. */
export const TYPING_REFRESH_MS = 8000;

export type TypingLoopHandle = {
  readonly stop: () => void;
};

type ThreadLikeWithTyping = {
  sendTyping?: () => Promise<unknown>;
};

export function startTypingLoop(
  thread: ThreadLikeWithTyping,
  log: Logger,
): TypingLoopHandle {
  const canType =
    "sendTyping" in thread && typeof thread.sendTyping === "function";

  const fire = (): void => {
    if (!canType) return;
    try {
      const promise = thread.sendTyping?.();
      if (promise && typeof (promise as Promise<unknown>).catch === "function") {
        void (promise as Promise<unknown>).catch((err: unknown) => {
          log.debug(
            { error: (err as Error).message ?? String(err) },
            "subagent typing indicator sendTyping failed — observational, non-fatal",
          );
        });
      }
    } catch (err) {
      log.debug(
        { error: (err as Error).message ?? String(err) },
        "subagent typing indicator setup failed — observational, non-fatal",
      );
    }
  };

  // Eager fire at t=0 mirrors bridge.ts:362 fireTypingIndicator pattern.
  fire();

  // Re-fire every 8s. Caller's finally invokes stop() to clear.
  const handle = setInterval(fire, TYPING_REFRESH_MS);

  return {
    stop: (): void => {
      clearInterval(handle);
    },
  };
}
