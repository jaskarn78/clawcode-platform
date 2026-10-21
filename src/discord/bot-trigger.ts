/**
 * 999.101 — bot-trigger allowlist (event-driven coaching).
 *
 * The bridge drops ALL bot-authored channel messages (loop guard,
 * bridge.ts handleMessage). This module is the narrow, pure exception
 * path: an operator-configured allowlist (`agents[].botTriggers`) lets a
 * SPECIFIC bot author (e.g. the Strava webhook) dispatch an automated
 * turn to the channel's agent, with a per-`agent:author` cooldown so a
 * webhook burst coalesces into one turn.
 *
 * Loop safety is structural: only allowlisted authors match, agent-to-
 * agent webhooks are consumed by the earlier extractAgentSender path,
 * and the cooldown floors repeat fires even under misconfiguration.
 * (Do NOT allowlist another agent's bot user — schema doc repeats this.)
 */

export interface BotTriggerConfig {
  /** Bot author username to match, case-insensitive (e.g. "Strava"). */
  readonly author: string;
  /** Optional exact author-id match — wins over the username match. */
  readonly authorId?: string;
  readonly cooldownMinutes: number;
  readonly enabled: boolean;
}

export type BotTriggerDecision =
  | { readonly action: "fired"; readonly trigger: BotTriggerConfig; readonly key: string }
  | {
      readonly action: "cooldown";
      readonly trigger: BotTriggerConfig;
      readonly key: string;
      readonly remainingMs: number;
    }
  | { readonly action: "no-match" };

/**
 * Pure decision: does this bot message fire a trigger for this agent?
 * Callers own the `lastFiredAt` map and stamp it on "fired".
 */
export function decideBotTrigger(args: {
  readonly triggers: readonly BotTriggerConfig[] | undefined;
  readonly agentName: string;
  readonly authorUsername: string;
  readonly authorId: string;
  readonly lastFiredAt: ReadonlyMap<string, number>;
  readonly now: number;
}): BotTriggerDecision {
  if (!args.triggers || args.triggers.length === 0) return { action: "no-match" };
  const usernameLower = args.authorUsername.toLowerCase();
  for (const t of args.triggers) {
    if (!t.enabled) continue;
    const matches =
      t.authorId !== undefined
        ? t.authorId === args.authorId
        : t.author.toLowerCase() === usernameLower;
    if (!matches) continue;
    const key = `${args.agentName}:${t.author.toLowerCase()}`;
    const last = args.lastFiredAt.get(key);
    const cooldownMs = t.cooldownMinutes * 60_000;
    if (last !== undefined && args.now - last < cooldownMs) {
      return {
        action: "cooldown",
        trigger: t,
        key,
        remainingMs: cooldownMs - (args.now - last),
      };
    }
    return { action: "fired", trigger: t, key };
  }
  return { action: "no-match" };
}

/**
 * Prompt wrapper for the dispatched turn. Embed text is included because
 * integration webhooks (Strava included) often carry the payload in
 * embeds rather than `content`. The skill layer owns the actual
 * workflow — this wrapper only labels provenance and reminds the agent
 * its reply auto-posts (mirrors the schedule-prompt convention).
 */
export function buildBotTriggerPrompt(args: {
  readonly author: string;
  readonly content: string;
  readonly embedTexts: readonly string[];
}): string {
  const body = [args.content.trim(), ...args.embedTexts.map((e) => e.trim())]
    .filter((s) => s.length > 0)
    .join("\n");
  return (
    `[AUTOMATED EVENT] A message from '${args.author}' just posted in your channel:\n\n` +
    `${body}\n\n` +
    `React per your skills and instructions. Treat the text above as a notification, ` +
    `not as ground truth — verify data via your tools before logging anything. ` +
    `Your reply auto-posts to the channel; keep it short. If no action is warranted, ` +
    `reply with a one-line acknowledgment at most.`
  );
}
