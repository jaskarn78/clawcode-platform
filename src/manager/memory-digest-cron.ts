/**
 * Phase 999.127 — weekly memory-digest cron.
 *
 * Mirrors `daily-summary-cron.ts`: croner is wrapped behind a factory so
 * tests fire the callback directly. One cron for the fleet; per agent it
 * selects the week's memories, posts the digest to the agent's bound
 * channel through the bot-direct sender, and seeds the number reactions
 * (best-effort) so the owner only has to tap one.
 */

import { Cron } from "croner";
import type { Logger } from "pino";
import type { MemoryStore } from "../memory/store.js";
import type { BotDirectSender } from "./restart-greeting.js";
import { spawnKindOf } from "./subagent-name.js";
import {
  CONFIRM_EMOJI,
  DIGEST_WINDOW_MS,
  NUMBER_EMOJI,
  renderDigest,
  selectDigestMemories,
} from "./memory-digest.js";

export const DEFAULT_DIGEST_CRON = "0 9 * * 1"; // Mondays 09:00
export const DEFAULT_DIGEST_TIMEZONE = "America/Los_Angeles";

export type MemoryDigestCronHandle = { readonly stop: () => void };

export type DigestCronFactory = (
  pattern: string,
  opts: { readonly name: string; readonly timezone?: string },
  callback: () => unknown | Promise<unknown>,
) => MemoryDigestCronHandle;

const DEFAULT_FACTORY: DigestCronFactory = (pattern, opts, callback) => {
  const cron = new Cron(
    pattern,
    { name: opts.name, ...(opts.timezone ? { timezone: opts.timezone } : {}) },
    async () => {
      await callback();
    },
  );
  return { stop: () => cron.stop() };
};

/** Something that can add a reaction to a posted message (the A2A receipt sender). */
export type DigestReactor = {
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
};

export type ScheduleMemoryDigestCronArgs = {
  readonly manager: {
    getRunningAgents(): readonly string[];
    getMemoryStore(agent: string): MemoryStore | undefined;
    getAgentConfig(agent: string): { memoryDigest?: { enabled?: boolean } } | undefined;
  };
  /** The agent's bound channel, or undefined when it has none. */
  readonly channelFor: (agent: string) => string | undefined;
  readonly sender: () => Pick<BotDirectSender, "sendText"> | undefined;
  readonly reactor?: () => DigestReactor | undefined;
  readonly log: Logger;
  readonly cronFactory?: DigestCronFactory;
  readonly pattern?: string;
  readonly timezone?: string;
  readonly maxItems?: number;
  readonly now?: () => number;
};

export type DigestRunOutcome = {
  readonly agent: string;
  readonly status: "posted" | "empty" | "skipped" | "failed";
  readonly items?: number;
  readonly reason?: string;
};

/** One tick over every running agent. Exported so tests and an operator command can run it directly. */
export async function runMemoryDigestTick(
  args: ScheduleMemoryDigestCronArgs,
): Promise<readonly DigestRunOutcome[]> {
  const now = args.now?.() ?? Date.now();
  const window = {
    since: new Date(now - DIGEST_WINDOW_MS).toISOString(),
    until: new Date(now).toISOString(),
  };
  const outcomes: DigestRunOutcome[] = [];
  for (const agent of args.manager.getRunningAgents()) {
    // Derived sessions share the parent's store; the parent posts.
    if (spawnKindOf(agent) !== "agent") continue;
    if (args.manager.getAgentConfig(agent)?.memoryDigest?.enabled === false) {
      outcomes.push({ agent, status: "skipped", reason: "disabled" });
      continue;
    }
    const store = args.manager.getMemoryStore(agent);
    const channelId = args.channelFor(agent);
    const sender = args.sender();
    if (!store || !channelId || !sender) {
      outcomes.push({
        agent,
        status: "skipped",
        reason: !store ? "no memory store" : !channelId ? "no bound channel" : "no sender",
      });
      continue;
    }
    try {
      const items = selectDigestMemories(store, {
        ...window,
        ...(args.maxItems !== undefined ? { maxItems: args.maxItems } : {}),
      });
      const text = renderDigest(items, window);
      if (text.length === 0) {
        outcomes.push({ agent, status: "empty", items: 0 });
        continue;
      }
      const messageId = await sender.sendText(channelId, text);
      // Seed the reactions so the owner taps rather than searches the picker.
      const reactor = args.reactor?.();
      if (reactor) {
        for (const emoji of [...NUMBER_EMOJI.slice(0, items.length), CONFIRM_EMOJI]) {
          try {
            await reactor.react(channelId, messageId, emoji);
          } catch (err) {
            args.log.debug(
              { agent, emoji, error: err instanceof Error ? err.message : String(err) },
              "memory digest: seeding a reaction failed (non-fatal)",
            );
            break;
          }
        }
      }
      args.log.info({ agent, items: items.length, messageId }, "memory digest posted");
      outcomes.push({ agent, status: "posted", items: items.length });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      args.log.warn({ agent, error: reason }, "memory digest failed for agent");
      outcomes.push({ agent, status: "failed", reason });
    }
  }
  return outcomes;
}

export function scheduleMemoryDigestCron(args: ScheduleMemoryDigestCronArgs): MemoryDigestCronHandle {
  const factory = args.cronFactory ?? DEFAULT_FACTORY;
  const pattern = args.pattern ?? DEFAULT_DIGEST_CRON;
  const timezone = args.timezone ?? DEFAULT_DIGEST_TIMEZONE;
  return factory(pattern, { name: "memory-digest", timezone }, async () => {
    args.log.info({ pattern, timezone }, "memory-digest cron tick");
    await runMemoryDigestTick(args);
  });
}
