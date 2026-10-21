import { WebhookClient, type EmbedBuilder, type WebhookMessageEditOptions } from "discord.js";
import type { WebhookIdentity } from "./webhook-types.js";
import { logger } from "../shared/logger.js";
import { formatOutboundText } from "./markdown-table-wrap.js";
import { splitKeepingAnnotations } from "./markdown-table-wrap.js";
import { chunkIndexForFile, type OutboundFile } from "./table-delivery.js";
import { deliveryFlags } from "./delivery-flags.js";
import type { Logger } from "pino";

/** Maximum Discord message length. */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * Reprovisioner closure shape. Called when a webhook send fails with a
 * Discord 401 (revoked) or 404 (deleted) so the manager can request a fresh
 * webhook URL for the agent. Returns the new identity or `undefined` if
 * reprovisioning is not possible (no channel, Discord-side error). Phase 119
 * A2A-02 — kept as a DI seam so the manager stays decoupled from the Discord
 * Client and the provisioning helper lives in webhook-provisioner.ts.
 */
export type WebhookReprovisioner = (
  agentName: string,
) => Promise<WebhookIdentity | undefined>;

/**
 * Configuration for creating a WebhookManager.
 */
export type WebhookManagerConfig = {
  readonly identities: ReadonlyMap<string, WebhookIdentity>;
  readonly log?: Logger;
  /**
   * Phase 119 A2A-02 — optional reprovisioner. When set, sendAsAgent
   * recovers from Discord 401/404 by calling this to obtain a fresh
   * webhook URL, then retrying the send ONCE with the new identity.
   * Bounded retry — second failure surfaces normally.
   */
  readonly reprovisionWebhook?: WebhookReprovisioner;
};

/**
 * Manages webhook-based message delivery for agents.
 * Each agent with a configured webhook URL sends messages
 * with its own display name and avatar instead of using the bot identity.
 */
export class WebhookManager {
  private readonly identities: Map<string, WebhookIdentity>;
  private readonly clients: Map<string, WebhookClient> = new Map();
  private readonly log: Logger;
  private readonly reprovisionWebhook?: WebhookReprovisioner;

  constructor(config: WebhookManagerConfig) {
    this.identities = new Map(config.identities);
    this.log = config.log ?? logger;
    this.reprovisionWebhook = config.reprovisionWebhook;
  }

  /**
   * Check whether an agent has a webhook identity configured.
   */
  hasWebhook(agentName: string): boolean {
    // Gates ORDINARY delivery (bridge.ts x4). An A2A-only identity is
    // deliberately invisible here so the agent's replies to a person keep
    // coming from the bot rather than from a webhook named after the agent.
    const identity = this.identities.get(agentName);
    return identity !== undefined && identity.a2aOnly !== true;
  }

  /**
   * Whether an agent has ANY webhook identity, including A2A-only ones.
   * Use this for agent-to-agent embeds; use `hasWebhook` for normal replies.
   */
  hasA2aWebhook(agentName: string): boolean {
    return this.identities.has(agentName);
  }

  /**
   * Every identity the manager actually holds, including A2A-only ones.
   *
   * The `webhooks` IPC used to enumerate raw CONFIG instead, so it reported
   * zero for the whole fleet — no agent declares `webhook:` in YAML, and
   * auto-provisioned identities were invisible to it. Agents asking
   * `list_webhooks` were told "no webhook exists to use" while nine did.
   */
  listIdentities(): readonly {
    agent: string;
    displayName: string;
    avatarUrl: string | undefined;
    a2aOnly: boolean;
  }[] {
    return [...this.identities.entries()].map(([agent, id]) => ({
      agent,
      displayName: id.displayName,
      avatarUrl: id.avatarUrl,
      a2aOnly: id.a2aOnly === true,
    }));
  }

  /**
   * Get the webhook identity for an agent, or undefined if not configured.
   */
  getIdentity(agentName: string): WebhookIdentity | undefined {
    return this.identities.get(agentName);
  }

  /**
   * Send a message via the agent's webhook.
   * Handles message splitting for content over 2000 characters.
   *
   * @throws Error if the agent has no webhook configured
   */
  /**
   * 999.63d/4 — RETURNS the per-chunk message ids + the exact wire text
   * sent (post-format, post-split), so the delivery layer can retain
   * chunk refs for in-place corrections. ADDITIVE: every existing caller
   * awaits this in void position and is unaffected.
   */
  // eslint-disable-next-line prettier/prettier -- single-line signature pinned by UWC-2 (122-universal-wrap-coverage)
  async send(agentName: string, content: string): Promise<{ messageIds: readonly string[]; chunks: readonly string[] }> {
    // Wrap raw markdown tables for Discord (adaptive list / grid / cards).
    // wrapMarkdownTablesInCodeFence is pure + idempotent (already-rendered
    // content passes through unchanged), so callers that pre-wrap or send
    // pure prose are unaffected. Closes the regression gap left by Phase
    // 100-fu where bridge.ts sendDirect fallback, daemon.ts, and
    // usage/daily-summary.ts reached webhook delivery without the wrap.
    const wrapped = formatOutboundText(content);
    return this.sendChunks(agentName, splitKeepingAnnotations(wrapped, MAX_MESSAGE_LENGTH, splitMessage), []);
  }

  /**
   * 2026-08-27 — final-delivery variant: `content` is the planner's text
   * (already formatted, table placeholders in place) and `files` are the
   * rendered table images. Each file rides the chunk that carries its
   * placeholder line (else the last chunk). Idempotent re-format.
   */
  async sendWithFiles(
    agentName: string,
    content: string,
    files: readonly OutboundFile[],
  ): Promise<{ messageIds: readonly string[]; chunks: readonly string[] }> {
    const wrapped = formatOutboundText(content);
    return this.sendChunks(agentName, splitKeepingAnnotations(wrapped, MAX_MESSAGE_LENGTH, splitMessage), files);
  }

  private async sendChunks(
    agentName: string,
    chunks: readonly string[],
    files: readonly OutboundFile[],
  ): Promise<{ messageIds: readonly string[]; chunks: readonly string[] }> {
    const identity = this.identities.get(agentName);
    if (!identity) {
      throw new Error(`No webhook identity configured for agent '${agentName}'`);
    }
    const client = this.getOrCreateClient(agentName, identity.webhookUrl);
    const messageIds: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const attach = files
        .filter((f) => chunkIndexForFile(chunks, f) === i)
        .map((f) => ({ attachment: f.attachment, name: f.name, ...(f.description ? { description: f.description } : {}) }));
      const result = await client.send({
        content: chunks[i],
        username: identity.displayName,
        avatarURL: identity.avatarUrl ?? undefined,
        ...(attach.length > 0 ? { files: attach } : {}),
        ...(deliveryFlags() as { flags?: never }),
      });
      const id =
        typeof result === "string"
          ? result
          : (result as { id?: unknown })?.id;
      if (typeof id === "string") messageIds.push(id);
    }

    this.log.info(
      { agent: agentName, chunks: chunks.length, files: files.length },
      "webhook message sent",
    );
    return { messageIds, chunks };
  }

  /**
   * Phase 140 streaming — post a SINGLE message via the agent's webhook and
   * return its id, so a later {@link editMessage} can progressively update it
   * (block-level "typing" on the v3 channel path). Unlike {@link send} this
   * does NOT chunk — progressive content is editor-managed (≤2000, truncated by
   * the editor). Returns the posted message id for the edit handle.
   *
   * @throws Error if the agent has no webhook configured
   */
  async sendReturningId(agentName: string, content: string): Promise<string> {
    const identity = this.identities.get(agentName);
    if (!identity) {
      throw new Error(`No webhook identity configured for agent '${agentName}'`);
    }
    const client = this.getOrCreateClient(agentName, identity.webhookUrl);
    const result = await client.send({
      content: formatOutboundText(content).slice(0, MAX_MESSAGE_LENGTH),
      username: identity.displayName,
      avatarURL: identity.avatarUrl ?? undefined,
    });
    return typeof result === "string" ? result : result.id;
  }

  /**
   * Phase 140 streaming — edit a previously-sent webhook message in place
   * (progressive block updates). BEST-EFFORT: a failed edit is non-fatal — a
   * dropped progress frame just isn't reflected; the final delivery corrects
   * it. Truncates to the Discord max (the editor sends the tail separately).
   *
   * @throws Error only if the agent has no webhook configured (a Discord-side
   *   edit failure is swallowed by the caller's progressive editor).
   */
  async editMessage(
    agentName: string,
    messageId: string,
    content: string,
  ): Promise<void> {
    const identity = this.identities.get(agentName);
    if (!identity) {
      throw new Error(`No webhook identity configured for agent '${agentName}'`);
    }
    const client = this.getOrCreateClient(agentName, identity.webhookUrl);
    await client.editMessage(messageId, {
      content: formatOutboundText(content).slice(0, MAX_MESSAGE_LENGTH),
    });
  }

  /**
   * 999.63d/4 — RAW edit: no re-format, no truncation. Used by the
   * chunk-edit correction path, whose planner already produced exact
   * post-format wire text and whose footer's `—` must survive (the
   * formatter strips em-dashes from prose). Length is the PLANNER's
   * contract (≤ Discord max, all-or-nothing); a violation surfaces as a
   * Discord 400 the caller treats as fallback.
   *
   * @throws Error if the agent has no webhook configured
   */
  async editMessageRaw(
    agentName: string,
    messageId: string,
    content: string,
  ): Promise<void> {
    const identity = this.identities.get(agentName);
    if (!identity) {
      throw new Error(`No webhook identity configured for agent '${agentName}'`);
    }
    const client = this.getOrCreateClient(agentName, identity.webhookUrl);
    await client.editMessage(messageId, { content });
  }

  /**
   * WS-4 — replace ONLY the component rows (e.g. the 🧾 Sources button) on a
   * previously-sent webhook message. The payload is `{ components }` and
   * nothing else — no content, no flags — so Discord keeps the text and the
   * SUPPRESS_EMBEDS bit exactly as delivered. An empty array clears the rows.
   * `components` is the raw Discord/discord.js row shape the caller already
   * built; this method is deliberately untyped at the boundary so CV2 and v1
   * rows both pass without a rebuild.
   *
   * @throws Error if the agent has no webhook configured (a Discord-side
   *   failure propagates — the caller decides whether a stale button is
   *   acceptable).
   */
  async editMessageComponents(
    agentName: string,
    messageId: string,
    components: readonly unknown[],
  ): Promise<void> {
    const identity = this.identities.get(agentName);
    if (!identity) {
      throw new Error(`No webhook identity configured for agent '${agentName}'`);
    }
    const client = this.getOrCreateClient(agentName, identity.webhookUrl);
    await client.editMessage(messageId, {
      components: components as WebhookMessageEditOptions["components"],
    });
  }

  /**
   * Send an embed to a target agent's channel using the sender's identity.
   * Used for agent-to-agent messages where the embed appears in the target's channel
   * but shows the sender's display name and avatar.
   *
   * @param targetAgent - Name of the target agent whose channel receives the embed
   * @param senderDisplayName - Display name shown as the webhook username
   * @param senderAvatarUrl - Avatar URL for the webhook message (optional)
   * @param embed - The EmbedBuilder to send
   * @returns The Discord message ID
   * @throws Error if target agent has no webhook configured
   */
  async sendAsAgent(
    targetAgent: string,
    senderDisplayName: string,
    senderAvatarUrl: string | undefined,
    embed: EmbedBuilder,
  ): Promise<string> {
    const identity = this.identities.get(targetAgent);
    if (!identity) {
      throw new Error(
        `No webhook identity configured for target agent '${targetAgent}'`,
      );
    }
    try {
      return await this.attemptSendAsAgent(
        targetAgent,
        identity.webhookUrl,
        senderDisplayName,
        senderAvatarUrl,
        embed,
      );
    } catch (err) {
      const code = extractDiscordStatusCode(err);
      if (
        (code === 401 || code === 404) &&
        this.reprovisionWebhook
      ) {
        this.log.warn(
          { channel: targetAgent, code, action: "invalidate-and-reprovision" },
          "webhook 401/404 — invalidating cache and reprovisioning once",
        );
        this.invalidate(targetAgent);
        const fresh = await this.reprovisionWebhook(targetAgent);
        if (!fresh) {
          throw err;
        }
        this.identities.set(targetAgent, fresh);
        return await this.attemptSendAsAgent(
          targetAgent,
          fresh.webhookUrl,
          senderDisplayName,
          senderAvatarUrl,
          embed,
        );
      }
      throw err;
    }
  }

  /**
   * Phase 119 A2A-02 — drop the cached identity + WebhookClient for an agent.
   * Used by the 401/404 reprovision-once retry path. Idempotent.
   */
  invalidate(agentName: string): void {
    this.identities.delete(agentName);
    const client = this.clients.get(agentName);
    if (client) {
      client.destroy();
      this.clients.delete(agentName);
    }
  }

  private async attemptSendAsAgent(
    targetAgent: string,
    webhookUrl: string,
    senderDisplayName: string,
    senderAvatarUrl: string | undefined,
    embed: EmbedBuilder,
  ): Promise<string> {
    const client = this.getOrCreateClient(targetAgent, webhookUrl);
    // Phase 122 single-chokepoint wrap for embed bodies. Mutates the embed
    // in place via setDescription so the wrap rides on the same EmbedBuilder
    // the caller (or reprovision retry) hands us. Idempotent because
    // wrapMarkdownTablesInCodeFence is pure + idempotent. embed.data is
    // optional-chained because test doubles can hand us a minimal toJSON
    // shape; real EmbedBuilder always has .data.
    const description = embed.data?.description;
    if (typeof description === "string" && description.length > 0) {
      embed.setDescription(formatOutboundText(description));
    }
    const result = await client.send({
      embeds: [embed],
      username: senderDisplayName,
      avatarURL: senderAvatarUrl ?? undefined,
    });
    this.log.info(
      { target: targetAgent, sender: senderDisplayName },
      "agent-to-agent embed sent",
    );
    return typeof result === "string" ? result : result.id;
  }

  /**
   * Destroy all cached webhook clients. Call on shutdown.
   */
  destroy(): void {
    for (const client of this.clients.values()) {
      client.destroy();
    }
    this.clients.clear();
  }

  /**
   * Get or create a cached WebhookClient for an agent.
   */
  private getOrCreateClient(agentName: string, url: string): WebhookClient {
    let client = this.clients.get(agentName);
    if (!client) {
      client = new WebhookClient({ url });
      this.clients.set(agentName, client);
    }
    return client;
  }
}

/**
 * Phase 999.82 Plan 02 — narrow surface the streaming editFn needs from the
 * WebhookManager. Structurally satisfied by {@link WebhookManager} (both
 * methods already shipped in Phase 140). Kept narrow so the factory is unit-
 * testable with a tiny stub.
 */
export type WebhookEditTarget = {
  sendReturningId(agentName: string, content: string): Promise<string>;
  editMessage(agentName: string, messageId: string, content: string): Promise<void>;
};

/**
 * Phase 999.82 Plan 02 — a post-then-edit `editFn` factory for the masking
 * webhook, mirroring the v2 editor's `channel.send` / `message.edit` pattern
 * but over the agent's masking webhook.
 *
 * Returns a FRESH closure per call (no shared module state — immutable style).
 * The closure owns a mutable `messageId`:
 *   - first invocation → {@link WebhookManager.sendReturningId} (posts ONCE,
 *     stores the id)
 *   - subsequent invocations → {@link WebhookManager.editMessage} (edits the
 *     SAME message in place)
 *
 * The returned function carries two introspection helpers the v3 bridge branch
 * uses for the final-vs-progress DEDUP decision:
 *   - `posted()` — did the editor ever post a message this turn? (drives
 *     flush-editor vs send-only)
 *   - `messageId()` — the posted id (or null) — diagnostic.
 */
export type WebhookEditFn = ((content: string) => Promise<void>) & {
  posted(): boolean;
  messageId(): string | null;
};

export function makeWebhookEditFn(
  webhook: WebhookEditTarget,
  agentName: string,
): WebhookEditFn {
  let messageId: string | null = null;
  const editFn = async (content: string): Promise<void> => {
    if (messageId === null) {
      messageId = await webhook.sendReturningId(agentName, content);
      return;
    }
    await webhook.editMessage(agentName, messageId, content);
  };
  const fn = editFn as WebhookEditFn;
  fn.posted = () => messageId !== null;
  fn.messageId = () => messageId;
  return fn;
}

/**
 * Split a long message into chunks respecting the max length.
 * Tries to split on newlines, falls back to space, then hard split.
 *
 * Exported for testing.
 */
export function splitMessage(
  text: string,
  maxLength: number,
): readonly string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex <= 0 || splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex <= 0 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Phase 119 A2A-02 — pull the HTTP status code off a discord.js
 * DiscordAPIError. discord.js v14 exposes both `status` (HTTP code) and
 * `code` (Discord error code). Either may match 401/404 depending on the
 * error path; we check both and return whichever is the HTTP-status-shape.
 */
function extractDiscordStatusCode(err: unknown): number | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const candidate = err as { status?: unknown; code?: unknown };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.code === "number") return candidate.code;
  return undefined;
}

/**
 * Build the identities map from resolved agent configs.
 * Only includes agents that have a webhook config with a webhookUrl.
 */
export function buildWebhookIdentities(
  agents: readonly { readonly name: string; readonly webhook?: { readonly displayName: string; readonly avatarUrl?: string; readonly webhookUrl?: string } }[],
): Map<string, WebhookIdentity> {
  const identities = new Map<string, WebhookIdentity>();

  for (const agent of agents) {
    if (agent.webhook?.webhookUrl) {
      identities.set(agent.name, {
        displayName: agent.webhook.displayName,
        avatarUrl: agent.webhook.avatarUrl,
        webhookUrl: agent.webhook.webhookUrl,
      });
    }
  }

  return identities;
}
