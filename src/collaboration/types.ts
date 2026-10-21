/**
 * Priority levels for inbox messages.
 * - normal: standard messages, processed in order
 * - high: elevated priority, processed before normal
 * - urgent: immediate attention required
 */
export type MessagePriority = "normal" | "high" | "urgent";

/**
 * Discriminator for the role of an inbox message.
 * - message: a genuine cross-agent / trigger message (the default)
 * - ack: an acknowledgment emitted when a target agent CONSUMES a
 *   genuine cross-agent message. Acks are NEVER acked back — the
 *   ack-emitter no-ops on kind "ack" (loop prevention).
 *
 * Quick 260520-r70 — additive-optional on InboxMessage. An ABSENT kind
 * (legacy on-disk inbox JSON written before this field existed) resolves
 * as "message" via `resolveKind` in inbox.ts. Never make this required:
 * old files have no `kind` and must stay valid.
 */
export type InboxMessageKind = "message" | "ack";

/**
 * A message in an agent's inbox.
 * All fields are readonly to enforce immutability.
 */
export type InboxMessage = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly content: string;
  readonly timestamp: number;
  readonly priority: MessagePriority;
  /**
   * Quick 260520-r70 — additive-OPTIONAL message-role discriminator.
   * Absent kind resolves as "message" (see `resolveKind` in inbox.ts).
   * Back-compat: existing on-disk inbox JSON files have no `kind`.
   */
  readonly kind?: InboxMessageKind;

  // -------------------------------------------------------------------------
  // Phase 999.117 WS-1 — the A2A envelope.
  //
  // Every field is additive-OPTIONAL for the same reason `kind` is: there is
  // live on-disk inbox JSON written before these existed, and it must stay
  // valid. `resolveEnvelope` in inbox.ts is the single place that supplies
  // defaults — never read these raw.
  //
  // These exist because ClawCode had NO conversation state at all. There was
  // no hop count, no TTL, no conversation id, no per-pair budget; the only
  // loop guard in the system was "never ack an ack", which does nothing for a
  // genuine A→B→A→B exchange. Two agents doing their jobs correctly had
  // nothing that could ever make them stop. Bounding that needs identity
  // (which exchange is this?) and depth (how far has it gone?) to travel WITH
  // the message — the same reason IP carries a TTL and mail carries Received
  // headers.
  // -------------------------------------------------------------------------

  /**
   * Stable id for the whole exchange, propagated hop to hop (A2A calls this
   * `contextId`). The first message of an exchange mints one; every reply
   * carries it forward. This is what the loop governor counts against.
   */
  readonly conversationId?: string;

  /** Id of the message this one is a reply to. Builds the causal chain. */
  readonly causationId?: string;

  /**
   * Idempotency key for delivery de-duplication. ClawCode can deliver the
   * same logical message through more than one path (inbox watcher, webhook
   * relay, v3 channel push); a stable key lets the consumer collapse those
   * to one turn — the at-least-once + idempotent-consumer pattern, since
   * exactly-once delivery is not achievable.
   */
  readonly deliveryId?: string;

  /**
   * Hop count, incremented on each relay. The hard TTL: past the configured
   * ceiling the exchange is terminated regardless of what either agent
   * "wants" to do next.
   */
  readonly hops?: number;

  /**
   * RFC 3834 `Auto-Submitted` analog. True for anything machine-generated —
   * acks, receipts, digests, trigger fan-out. Nothing auto-responds to a
   * message carrying this, which is the rule that stops responder ping-pong
   * in email and stops it here.
   */
  readonly autoSubmitted?: boolean;
};

/**
 * Phase 999.117 WS-1 — the envelope with every default resolved.
 *
 * Read this, never the raw optional fields. A legacy on-disk message with no
 * envelope resolves to a fresh single-hop conversation, which is exactly how
 * it should be treated.
 */
export type ResolvedEnvelope = Readonly<{
  conversationId: string;
  causationId: string | undefined;
  deliveryId: string;
  hops: number;
  autoSubmitted: boolean;
  kind: InboxMessageKind;
}>;
