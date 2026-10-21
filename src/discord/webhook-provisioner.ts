import type { Client } from "discord.js";
import type { WebhookIdentity } from "./webhook-types.js";
import type { Logger } from "pino";

/**
 * Three-state identity status returned by verifyAgentWebhookIdentity.
 *
 * - "verified"    — a webhook already existed on the channel (bot-owned
 *                   reuse path); no new webhook was created
 * - "provisioned" — no bot-owned webhook existed; one was auto-created
 * - "missing"     — agent has no channel binding OR provisioning failed
 *                   (fetch/create threw); provisionWebhooks logs details
 */
export type AgentWebhookIdentityStatus =
  | {
      readonly status: "verified";
      readonly webhookUrl: string;
      readonly displayName: string;
    }
  | {
      readonly status: "provisioned";
      readonly webhookUrl: string;
      readonly displayName: string;
    }
  | { readonly status: "missing"; readonly reason: string };

export type VerifyAgentWebhookIdentityArgs = Readonly<{
  client: Client;
  agentName: string;
  /** First bound channel ID for the agent (undefined when no binding). */
  channelId: string | undefined;
  displayName: string;
  avatarUrl?: string;
  log: Logger;
}>;

/**
 * Configuration for auto-provisioning webhooks.
 */
export type ProvisionConfig = {
  readonly client: Client;
  readonly agents: readonly {
    readonly name: string;
    readonly channels: readonly string[];
    readonly webhook?: {
      readonly displayName: string;
      readonly avatarUrl?: string;
      readonly webhookUrl?: string;
    };
  }[];
  readonly manualIdentities: ReadonlyMap<string, WebhookIdentity>;
  readonly log: Logger;
};

/**
 * Auto-provision Discord webhooks for agents that have a displayName
 * but no manual webhookUrl. Reuses existing bot-owned webhooks when
 * found on the channel to avoid duplication.
 *
 * Returns a merged map of all webhook identities (manual + auto-provisioned).
 * Per-agent errors are caught and logged, never thrown.
 */
export async function provisionWebhooks(
  config: ProvisionConfig,
): Promise<Map<string, WebhookIdentity>> {
  const { client, agents, manualIdentities, log } = config;
  const result = new Map<string, WebhookIdentity>(manualIdentities);

  for (const agent of agents) {
    // Skip agents that already have a manual webhook URL
    if (result.has(agent.name)) {
      continue;
    }

    // Phase 999.117 WS-7 — an absent `webhook:` block no longer disables
    // per-agent webhooks.
    //
    // This early-continue is why the webhook rung was 100% dead in
    // production: NONE of the nine live agents declared a `webhook:` block,
    // so provisioning skipped every one and the WebhookManager booted with
    // zero identities on every restart (`total:0, manual:0, autoProvisioned:0`
    // in the boot log). Every A2A message therefore fell through to
    // bot-direct — which the recipient's own bridge drops — leaving the inbox
    // watcher as the only real delivery.
    //
    // The only thing provisioning actually needed was a display name, and the
    // agent's own name is a perfectly good one. Defaulting it lights up the
    // rung for the whole fleet with no config change.
    //
    // SAFE ONLY BECAUSE WS-2 LANDED FIRST. Before cross-path dedupe, enabling
    // this doubled every hop: the inbox watcher delivered the message and the
    // webhook relay delivered it again, differently formatted. Do not reorder
    // this ahead of the dedupe work.
    const displayName = agent.webhook?.displayName ?? agent.name;

    // Skip agents with no bound channels
    if (agent.channels.length === 0) {
      continue;
    }

    try {
      const channelId = agent.channels[0];
      const channel = await client.channels.fetch(channelId);

      // Verify channel supports webhooks (text-based guild channel)
      if (!channel || !("fetchWebhooks" in channel) || typeof (channel as unknown as Record<string, unknown>).fetchWebhooks !== "function") {
        log.warn(
          { agent: agent.name, channelId },
          "channel does not support webhooks, skipping auto-provision",
        );
        continue;
      }

      const textChannel = channel as {
        fetchWebhooks: () => Promise<Map<string, { owner?: { id: string }; url: string }>>;
        createWebhook: (opts: { name: string; avatar: string | null }) => Promise<{ url: string }>;
      };

      const existingWebhooks = await textChannel.fetchWebhooks();
      const botId = client.user?.id;

      // Look for an existing webhook owned by this bot
      let webhookUrl: string | undefined;
      for (const [, webhook] of existingWebhooks) {
        if (webhook.owner?.id === botId) {
          webhookUrl = webhook.url;
          break;
        }
      }

      // Create a new webhook if none found
      if (!webhookUrl) {
        const created = await textChannel.createWebhook({
          name: displayName,
          avatar: agent.webhook?.avatarUrl ?? null,
        });
        webhookUrl = created.url;
        log.info(
          { agent: agent.name, channelId },
          "auto-provisioned new webhook",
        );
      } else {
        log.info(
          { agent: agent.name, channelId },
          "reusing existing bot-owned webhook",
        );
      }

      // An agent that declared no `webhook:` block gets an A2A-ONLY identity:
      // it exists so a cross-agent message can wear the sender's face, and
      // must not take over the agent's ordinary replies (which belong to the
      // bot). An explicit YAML block is an opt-in to the full identity.
      const a2aOnly = agent.webhook?.displayName === undefined;
      result.set(agent.name, {
        displayName,
        avatarUrl: agent.webhook?.avatarUrl,
        webhookUrl,
        ...(a2aOnly ? { a2aOnly: true } : {}),
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(
        { agent: agent.name, error: errorMsg },
        "failed to auto-provision webhook, skipping agent",
      );
    }
  }

  return result;
}

/**
 * Phase 90 Plan 07 WIRE-05 — per-agent webhook identity probe.
 *
 * Thin wrapper over provisionWebhooks that:
 *   - returns `missing` when no channel is bound (no Discord API call fires)
 *   - probes the channel directly to distinguish `verified` vs `provisioned`
 *   - delegates actual create/reuse to provisionWebhooks (single source of
 *     truth for the auto-provision contract)
 *
 * Called at daemon boot for agents with a webhook config block so operators
 * can see per-agent identity status in the log without manually poking
 * Discord.
 */
export async function verifyAgentWebhookIdentity(
  args: VerifyAgentWebhookIdentityArgs,
): Promise<AgentWebhookIdentityStatus> {
  if (!args.channelId) {
    return { status: "missing", reason: "no channel bound" };
  }

  // Pre-check: does a bot-owned webhook already exist on the channel?
  // provisionWebhooks contains the reuse-vs-create branching but doesn't
  // surface WHICH path it took. We peek at fetchWebhooks first so the
  // return shape can distinguish "verified" (already present) from
  // "provisioned" (freshly created).
  let existedBefore = false;
  try {
    const channel = await args.client.channels.fetch(args.channelId);
    if (
      channel &&
      "fetchWebhooks" in channel &&
      typeof (channel as unknown as Record<string, unknown>).fetchWebhooks ===
        "function"
    ) {
      const textChannel = channel as {
        fetchWebhooks: () => Promise<
          Map<string, { owner?: { id: string }; url: string }>
        >;
      };
      const existingWebhooks = await textChannel.fetchWebhooks();
      const botId = args.client.user?.id;
      for (const [, webhook] of existingWebhooks) {
        if (webhook.owner?.id === botId) {
          existedBefore = true;
          break;
        }
      }
    }
  } catch (err) {
    args.log.warn(
      { agent: args.agentName, error: (err as Error).message },
      "verifyAgentWebhookIdentity: channel pre-check failed",
    );
    return { status: "missing", reason: (err as Error).message };
  }

  // Delegate actual create/reuse to provisionWebhooks. It either reuses
  // the bot-owned webhook we detected above or creates a new one.
  const merged = await provisionWebhooks({
    client: args.client,
    agents: [
      {
        name: args.agentName,
        channels: [args.channelId],
        webhook: {
          displayName: args.displayName,
          avatarUrl: args.avatarUrl,
        },
      },
    ],
    manualIdentities: new Map(),
    log: args.log,
  });

  const ident = merged.get(args.agentName);
  if (!ident?.webhookUrl) {
    return {
      status: "missing",
      reason: "provisionWebhooks returned no webhookUrl",
    };
  }

  return existedBefore
    ? {
        status: "verified",
        webhookUrl: ident.webhookUrl,
        displayName: args.displayName,
      }
    : {
        status: "provisioned",
        webhookUrl: ident.webhookUrl,
        displayName: args.displayName,
      };
}
