/**
 * INC-2026-08-08 — admin-alert delivery target resolution + delivery cascade.
 *
 * Extracted from the daemon's `postToAdminClawdy` closure because that closure
 * is the SINGLE delivery leg for every daemon alert surface (document-ingest
 * fail-modes, MemoryGuard breaches, model-monitor new-tier proposals, and the
 * 1P ratelimit monitor) — and it was silently dead on production.
 *
 * Two independent bugs, one symptom:
 *   1. Both the webhook check and the resolved-config lookup keyed the literal
 *      string "admin-clawdy". The live agent is named "Admin Clawdy" (space,
 *      title case), so BOTH missed and every alert fell through to a pino line
 *      nobody reads.
 *   2. Even with the config found, the bot-direct branch never called
 *      `sendText` — it logged "missing channel id" and returned. The channel
 *      id was available all along via the routing table.
 *
 * Pure + DI-only so the cascade is unit-testable without a Discord client —
 * same shape as `secrets-ipc-handler.ts` / `orphan-delivery-callback.ts`.
 *
 * SEC note: alert text is operator-facing telemetry (counters, agent names,
 * cgroup numbers). No secret value is ever routed through here; callers keep
 * that invariant, exactly as before the extraction.
 */

import type { Logger } from "pino";

/** Canonical, NORMALIZED name of the fleet's admin/monitoring agent. */
export const ADMIN_AGENT_CANONICAL_NAME = "admin-clawdy";

/**
 * Bot-direct truncation ceiling. Discord's hard cap is 2000;
 * `WebhookManager.send` splits internally but `BotDirectSender.sendText` does
 * NOT — and the daemon's sendText impl runs `formatOutboundText()` AFTER we
 * hand it the string, which can ADD characters (it fences markdown tables).
 * 1900 leaves headroom so a table-carrying alert (model-monitor diffs,
 * document-ingest) can't be pushed back over the cap into a 400.
 */
export const DISCORD_MESSAGE_MAX = 1900;

/**
 * Fold an operator-authored agent name to a comparison key: lower-case, every
 * run of non-alphanumerics collapsed to a single "-", edges trimmed. "Admin
 * Clawdy", "admin-clawdy" and "Admin_Clawdy" all fold to "admin-clawdy".
 */
export function normalizeAgentName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Where the resolved channel id came from — surfaced in the boot sentinel. */
export type AdminChannelSource =
  | "routing-table"
  | "agent-config"
  | "env-override"
  | "deployment-constant";

export interface AdminAlertTarget {
  /** The agent's REAL configured name ("Admin Clawdy"), or undefined. */
  readonly agentName: string | undefined;
  readonly channelId: string;
  readonly channelSource: AdminChannelSource;
}

export interface AdminAlertTargetSources {
  readonly agents: readonly {
    readonly name: string;
    readonly channels: readonly string[];
  }[];
  readonly agentToChannels: ReadonlyMap<string, readonly string[]>;
  /** CLAWCODE_ADMIN_ALERT_CHANNEL_ID — operator escape hatch, no config edit. */
  readonly envChannelId?: string | undefined;
  /** Terminal fallback (the long-standing ADMIN_CLAWDY_CHANNEL_ID constant). */
  readonly fallbackChannelId: string;
}

/**
 * Resolve which agent identity + channel an admin alert targets. The cascade
 * is routing table → agent config → env override → deployment constant; the
 * winning source is returned so the boot sentinel can report it.
 */
export function resolveAdminAlertTarget(
  sources: AdminAlertTargetSources,
): AdminAlertTarget {
  const cfg = sources.agents.find(
    (a) => normalizeAgentName(a.name) === ADMIN_AGENT_CANONICAL_NAME,
  );
  const agentName = cfg?.name;
  // The env override is checked FIRST, deliberately. Behind the routing table
  // it would be unreachable on any fleet that actually has the admin agent
  // configured (prod resolves a channel every boot), which defeats its only
  // purpose: letting an operator re-point alerts mid-incident with a systemd
  // env edit + restart, without a config deploy.
  const fromEnv = sources.envChannelId;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { agentName, channelId: fromEnv, channelSource: "env-override" };
  }
  const fromRouting = agentName
    ? sources.agentToChannels.get(agentName)?.[0]
    : undefined;
  if (fromRouting !== undefined && fromRouting.length > 0) {
    return {
      agentName,
      channelId: fromRouting,
      channelSource: "routing-table",
    };
  }
  const fromConfig = cfg?.channels[0];
  if (fromConfig !== undefined && fromConfig.length > 0) {
    return { agentName, channelId: fromConfig, channelSource: "agent-config" };
  }
  return {
    agentName,
    channelId: sources.fallbackChannelId,
    channelSource: "deployment-constant",
  };
}

export type AdminAlertLeg = "webhook" | "bot-direct" | "pino-only";

/**
 * 999.147 — optional extras for one alert. Purely additive: `deliverAdminAlert`
 * is the single delivery leg for document-ingest, the model monitor, the 1P
 * ratelimit monitor and MemoryGuard, so its signature must stay
 * backward-compatible for callers that pass nothing.
 *
 * Only the WEBHOOK leg can carry components. On bot-direct or pino the button
 * is simply absent — which is why every page that offers one also names its
 * CLI equivalent in the message text.
 */
export interface AdminAlertOptions {
  readonly components?: readonly unknown[];
}

export interface AdminAlertDeliveryDeps {
  /** WebhookManager (structural) — null before Discord wiring converges. */
  readonly webhook: {
    hasWebhook(agentName: string): boolean;
    send(agentName: string, content: string): Promise<unknown>;
    /**
     * 999.147 — optional so every existing caller and test double still
     * satisfies this type. Only the relief button needs it; an alert with no
     * components never touches it.
     */
    editMessageComponents?(
      agentName: string,
      messageId: string,
      components: readonly unknown[],
    ): Promise<void>;
  } | null;
  /** BotDirectSender (structural) — null when Discord is disabled. */
  readonly botDirect: {
    sendText(channelId: string, content: string): Promise<string>;
  } | null;
  readonly target: AdminAlertTarget;
  readonly log: Logger;
}

/**
 * Which leg WOULD deliver, without delivering. The boot sentinel calls this so
 * what it reports and what `deliverAdminAlert` actually does can never drift.
 */
export function selectAdminAlertLeg(
  deps: Pick<AdminAlertDeliveryDeps, "webhook" | "botDirect" | "target">,
): AdminAlertLeg {
  const { webhook, botDirect, target } = deps;
  if (webhook && target.agentName && webhook.hasWebhook(target.agentName)) {
    return "webhook";
  }
  if (botDirect && target.channelId.length > 0) return "bot-direct";
  return "pino-only";
}

/**
 * Deliver one alert: webhook (agent identity) → bot-direct (bot identity) →
 * pino. NEVER throws — an alert failing must not take down its caller (a
 * MemoryGuard tick, a cron onTick). Returns the leg that actually delivered.
 */
export async function deliverAdminAlert(
  message: string,
  deps: AdminAlertDeliveryDeps,
  opts?: AdminAlertOptions,
): Promise<AdminAlertLeg> {
  const { webhook, botDirect, target, log } = deps;

  if (webhook && target.agentName && webhook.hasWebhook(target.agentName)) {
    try {
      const sent = await webhook.send(target.agentName, message);
      // 999.147 — components ride as a FOLLOW-UP EDIT, because
      // WebhookManager.send is text-only. Same two-step the 🧾 Sources button
      // uses. Best-effort by construction: the alert text has already landed,
      // so a failed edit costs the button, never the warning.
      if (opts?.components && opts.components.length > 0) {
        // A long alert is chunked into several messages; the button belongs
        // on the LAST one, which is where the reader ends up.
        const ids =
          (sent as { messageIds?: readonly string[] } | undefined)
            ?.messageIds ?? [];
        const lastId = ids[ids.length - 1];
        if (lastId && webhook.editMessageComponents) {
          try {
            await webhook.editMessageComponents(
              target.agentName,
              lastId,
              opts.components,
            );
          } catch (err) {
            log.warn(
              {
                tag: "admin-alert",
                agent: target.agentName,
                messageId: lastId,
                error: err instanceof Error ? err.message : String(err),
              },
              "admin alert: component attach failed (text delivered, button absent)",
            );
          }
        } else {
          log.warn(
            {
              tag: "admin-alert",
              agent: target.agentName,
              hasEditor: Boolean(webhook.editMessageComponents),
              messageIds: ids.length,
            },
            "admin alert: could not attach components (text delivered, button absent)",
          );
        }
      }
      return "webhook";
    } catch (err) {
      log.warn(
        {
          tag: "admin-alert",
          agent: target.agentName,
          error: err instanceof Error ? err.message : String(err),
        },
        "admin alert: webhook send failed (trying bot-direct)",
      );
    }
  }

  if (botDirect && target.channelId.length > 0) {
    const truncated =
      message.length > DISCORD_MESSAGE_MAX
        ? `${message.slice(0, DISCORD_MESSAGE_MAX - 3)}...`
        : message;
    try {
      await botDirect.sendText(target.channelId, truncated);
      return "bot-direct";
    } catch (err) {
      log.warn(
        {
          tag: "admin-alert",
          channelId: target.channelId,
          channelSource: target.channelSource,
          error: err instanceof Error ? err.message : String(err),
        },
        "admin alert: bot-direct send failed (falling back to pino)",
      );
    }
  }

  log.warn(
    {
      tag: "admin-alert",
      message,
      agent: target.agentName ?? null,
      channelId: target.channelId,
      channelSource: target.channelSource,
      hasWebhook: Boolean(webhook),
      hasBotDirect: Boolean(botDirect),
    },
    "admin alert: NOT delivered to Discord — pino only",
  );
  return "pino-only";
}
