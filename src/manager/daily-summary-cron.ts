/**
 * Phase 52 Plan 03 (CACHE-03): daemon-side daily-summary cron factory.
 *
 * Wires `croner` into the daemon bootstrap so every running agent gets a
 * Discord embed at 09:00 UTC carrying the previous 24h cost + cache hit
 * rate. The cron callback iterates `manager.getRunningAgents()` and calls
 * `emitDailySummary` per agent.
 *
 * Factored out of `src/manager/daemon.ts` so:
 *   - unit tests can inject a stub `cronFactory` without spinning up
 *     croner's real timer
 *   - daemon.ts stays lean and focused on IPC routing + session bootstrap
 *   - the shutdown path (daemon.ts `shutdown()`) has a clean `.stop()` handle
 *
 * CONTEXT D-03 locked decision: extend the daily Discord cost summary embed
 * with `💾 Cache: {hitRate}% over {turns} turns` — the formatter lives in
 * `src/usage/daily-summary.ts`; this file is only the cron wiring.
 */

import { Cron } from "croner";
import type { Logger } from "pino";
import type { SessionManager } from "./session-manager.js";
import type { WebhookManager } from "../discord/webhook-manager.js";
import { emitDailySummary } from "../usage/daily-summary.js";

/**
 * Minimal Cron-like handle — trims croner's surface to just the two methods
 * the daemon + tests touch. Test stubs expose `trigger()` too so tests can
 * fire the callback synchronously.
 */
export type DailySummaryCronHandle = {
  readonly stop: () => void;
};

/**
 * Factory for the underlying scheduler. Production passes a wrapper over
 * croner's `new Cron(...)`; tests pass a stub that captures the callback.
 */
export type CronFactory = (
  pattern: string,
  opts: { readonly name: string },
  callback: () => unknown | Promise<unknown>,
) => DailySummaryCronHandle;

/** Default production cron factory — thin wrapper over `new Cron(...)`. */
const DEFAULT_CRON_FACTORY: CronFactory = (pattern, opts, callback) => {
  // croner's CronCallback is `(self, context) => void | Promise<void>`; our
  // CronFactory contract uses a simpler `() => unknown | Promise<unknown>`
  // so tests can pass zero-arg callbacks. Adapt the shape here, at the
  // single production boundary.
  const cron = new Cron(pattern, { name: opts.name }, async () => {
    await callback();
  });
  return {
    stop: () => cron.stop(),
  };
};

export type ScheduleDailySummaryCronArgs = {
  readonly manager: Pick<
    SessionManager,
    "getRunningAgents" | "getTraceStore" | "getUsageTracker"
  >;
  readonly webhookManager: WebhookManager;
  readonly log: Logger;
  /** Override for tests — defaults to real croner. */
  readonly cronFactory?: CronFactory;
  /** Override for tests — defaults to "0 9 * * *" (09:00 UTC daily). */
  readonly pattern?: string;
};

/**
 * Schedule the daily-summary cron.
 *
 * Returns a `DailySummaryCronHandle` with `.stop()` for shutdown. The cron
 * callback is async — any thrown error is caught per-agent so a single
 * misconfigured webhook cannot prevent the next agent from being summarized.
 */
export function scheduleDailySummaryCron(
  args: ScheduleDailySummaryCronArgs,
): DailySummaryCronHandle {
  const factory = args.cronFactory ?? DEFAULT_CRON_FACTORY;
  const pattern = args.pattern ?? "0 9 * * *";

  const callback = async (): Promise<void> => {
    const agents = args.manager.getRunningAgents();
    args.log.info(
      { agents: agents.length },
      "daily-summary cron tick — emitting per-agent summaries",
    );
    for (const agent of agents) {
      const traceStore = args.manager.getTraceStore(agent);
      const usageTracker = args.manager.getUsageTracker(agent);
      // Skip mid-startup agents — tick keeps firing for healthy peers.
      if (!traceStore || !usageTracker) {
        args.log.debug(
          {
            agent,
            hasTraceStore: Boolean(traceStore),
            hasUsageTracker: Boolean(usageTracker),
          },
          "daily-summary: skipping agent (store not ready)",
        );
        continue;
      }
      await emitDailySummary({
        agent,
        traceStore,
        usageTracker,
        webhookManager: args.webhookManager,
        log: args.log,
        now: new Date(),
      });
    }
  };

  return factory(pattern, { name: "daily-cache-summary" }, callback);
}
