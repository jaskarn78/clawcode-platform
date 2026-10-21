/**
 * Phase 52 Plan 03 (CACHE-03): daily cost + cache summary emitter.
 *
 * Fires on a daemon-side daily cron (09:00 UTC by default — wired in
 * `src/manager/daemon.ts`). Emits a single Discord embed per running agent
 * containing:
 *   - 📊 agent header with the YYYY-MM-DD day key
 *   - 💵 Cost line with tokens in/out + cost_usd + turns
 *   - 💾 Cache: {hitRate}% over {turns} turns    ← appended ONLY when
 *     `cache.totalTurns > 0`. Idle-day summaries omit the cache line to
 *     avoid noise (per CONTEXT D-03 + BLOCKER-1 checker guidance).
 *
 * INVESTIGATION 2026-04-13: No pre-existing Phase 40 cost-summary emitter
 * was found in the repo at the time of authoring this plan. Grep for
 * patterns "daily.*summary", "💰", "emitDaily", "postDaily", "dailyCost",
 * "costSummary" returned only test fixtures + unrelated slash-command
 * templates. This file creates a minimal emitter scaffold; the locked
 * CONTEXT D-03 cache-line requirement ships HERE as its first home.
 *
 * SECURITY: the embed description contains cost numbers + cache percentages
 * — both are already surfaced via CLI / dashboard. No new secret surface.
 * Webhook-based send reuses existing Phase 40 / 48 rate-limiting + auth.
 */

import type { Logger } from "pino";
import type { TraceStore } from "../performance/trace-store.js";
import type { UsageTracker } from "./tracker.js";
import type { WebhookManager } from "../discord/webhook-manager.js";

/** Arguments for `buildDailySummaryEmbed` (pure function, no side effects). */
export type BuildDailySummaryArgs = {
  readonly agent: string;
  readonly traceStore: TraceStore;
  readonly usageTracker: UsageTracker;
  /** Injectable for deterministic tests — production passes `new Date()`. */
  readonly now: Date;
};

/**
 * The daily-summary Discord embed shape. A plain object (not `EmbedBuilder`)
 * so tests can assert on the literal strings; callers can wrap this in a
 * richer embed type if needed.
 */
export type DailySummaryEmbed = {
  readonly title: string;
  readonly description: string;
};

/**
 * Build a frozen daily-summary embed for `agent` over the 24h window ending
 * at `now`. Reads cost from the UsageTracker's daily aggregate for today's
 * date and cache stats from TraceStore.getCacheTelemetry for the last 24h.
 *
 * The cache line (`💾 Cache: XX.X% over N turns`) is appended ONLY when
 * `cache.totalTurns > 0`. This is the BLOCKER-1 resolution per checker
 * guidance: idle-day summaries stay clean and operators aren't paged by
 * phantom "0% hit rate over 0 turns" noise.
 */
export function buildDailySummaryEmbed(
  args: BuildDailySummaryArgs,
): DailySummaryEmbed {
  const { agent, traceStore, usageTracker, now } = args;

  const dayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const usage = usageTracker.getDailyUsage(dayStr);

  const iso24hAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const cache = traceStore.getCacheTelemetry(agent, iso24hAgo);

  const lines: string[] = [];
  lines.push(`📊 Daily summary for ${agent}`);
  lines.push(
    `💵 Cost: $${usage.cost_usd.toFixed(2)} · ${usage.tokens_in} in / ${usage.tokens_out} out · ${usage.turns} turns`,
  );

  // CONTEXT D-03 verbatim format, suppress-when-zero per BLOCKER-1 guidance.
  if (cache.totalTurns > 0) {
    const hitPct = (cache.avgHitRate * 100).toFixed(1);
    lines.push(`💾 Cache: ${hitPct}% over ${cache.totalTurns} turns`);
  }

  return Object.freeze({
    title: `Daily summary — ${dayStr}`,
    description: lines.join("\n"),
  });
}

/** Arguments for `emitDailySummary` (has side effects: webhook send + log). */
export type EmitDailySummaryArgs = BuildDailySummaryArgs & {
  readonly webhookManager: WebhookManager;
  readonly log: Logger;
};

/**
 * Emit the daily summary to the agent's Discord webhook.
 *
 * When the agent has no webhook configured, the summary is logged at
 * `info` level (graceful drop — no throw). All errors from the send path
 * are caught and logged at `warn` level so a single misconfigured webhook
 * never crashes the daemon-side cron tick.
 *
 * The cron caller (in `src/manager/daemon.ts`) is responsible for calling
 * this once per running agent on its 09:00 UTC schedule.
 */
export async function emitDailySummary(
  args: EmitDailySummaryArgs,
): Promise<void> {
  try {
    const embed = buildDailySummaryEmbed(args);
    if (args.webhookManager.hasWebhook(args.agent)) {
      await args.webhookManager.send(
        args.agent,
        `**${embed.title}**\n${embed.description}`,
      );
    } else {
      args.log.info(
        { agent: args.agent, embed },
        "daily summary emitted (no webhook configured — dropped gracefully)",
      );
    }
  } catch (err) {
    args.log.warn(
      { err, agent: args.agent },
      "daily summary emit failed",
    );
  }
}
