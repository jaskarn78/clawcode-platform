/**
 * A webhook identity for an agent — allows agents to post
 * to Discord with their own display name and avatar.
 */
export type WebhookIdentity = {
  readonly displayName: string;
  readonly avatarUrl: string | undefined;
  readonly webhookUrl: string;
  /**
   * 2026-09-03 — this identity may be used ONLY for agent-to-agent embeds,
   * never for the agent's normal replies to a person.
   *
   * Set on identities the daemon auto-provisions for agents that never asked
   * for one. Those exist purely so an A2A message can wear the SENDING
   * agent's face in the recipient's channel. Normal replies must keep coming
   * from the bot (ClawdyV2): `hasWebhook` gates ordinary delivery in four
   * places in bridge.ts, so an unqualified identity silently re-routes every
   * conversational reply through a webhook named after the agent, with a
   * default Discord avatar. An operator explicitly configuring `webhook:` in
   * YAML is opting into the agent-identity look and does NOT get this flag.
   */
  readonly a2aOnly?: boolean;
};

/**
 * Webhook configuration from clawcode.yaml.
 * webhookUrl is optional — if omitted, the agent uses the bot identity.
 */
export type WebhookConfig = {
  readonly displayName: string;
  readonly avatarUrl: string | undefined;
  readonly webhookUrl: string | undefined;
};
