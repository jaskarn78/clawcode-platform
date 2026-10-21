/**
 * Phase 999.117 WS-4 — where an A2A message was rendered.
 *
 * WHY THIS EXISTS
 *
 * An acknowledgment is a receipt, not a conversation. Today it is delivered
 * as a whole Discord message posted into the sender's channel:
 *
 *     ✅ projects processed your message
 *     sent 14:32 · processed 14:34
 *
 * 51 of those in one week on production — roughly as many receipts as real
 * messages. Each one is a separate post the operator has to read past, and
 * it says nothing the original message could not say by wearing a checkmark.
 *
 * A reaction on the ORIGINAL message is strictly better: it appears exactly
 * where the operator is already looking, it carries the state without adding
 * a line, and several states can stack on one message (📨 sent → 👀 seen →
 * ✅ processed) instead of accumulating three posts.
 *
 * To react, something has to remember which Discord message rendered which
 * A2A delivery. Nothing did — the delivery cascade posted and forgot. This
 * registry is that memory: delivery id → {channel, message}. Bounded and
 * in-memory, because a receipt is only interesting while the exchange is
 * live; losing the mapping on restart costs a reaction, not a message.
 */

/** Where a delivery was rendered in Discord. */
export type PresentationRef = Readonly<{
  channelId: string;
  messageId: string;
}>;

/** Bound on tracked presentations. FIFO-evicted. */
const DEFAULT_CAP = 2048;

export class PresentationRegistry {
  private readonly cap: number;
  private readonly refs = new Map<string, PresentationRef>();

  constructor(cap: number = DEFAULT_CAP) {
    this.cap = cap;
  }

  /**
   * Record where a delivery was rendered.
   *
   * No-ops on a missing id or message id rather than throwing: this is
   * best-effort decoration, and a failure to remember where something was
   * rendered must never be able to fail the delivery itself.
   */
  record(deliveryId: string | undefined, ref: PresentationRef | undefined): void {
    if (!deliveryId || !ref?.messageId || !ref.channelId) return;
    this.refs.set(deliveryId, ref);
    if (this.refs.size > this.cap) {
      const oldest = this.refs.keys().next().value;
      if (oldest !== undefined) this.refs.delete(oldest);
    }
  }

  /** Look up where a delivery was rendered, if it still is remembered. */
  get(deliveryId: string | undefined): PresentationRef | undefined {
    if (!deliveryId) return undefined;
    return this.refs.get(deliveryId);
  }

  /** Test/diagnostic: number of tracked presentations. */
  size(): number {
    return this.refs.size;
  }
}

/**
 * Receipt states, in the order they occur. Rendered as reactions on the
 * original message rather than as separate posts.
 */
export const RECEIPT_EMOJI = {
  /** Delivered to the recipient's inbox / channel. */
  sent: "📨",
  /** The recipient consumed it and it became a turn. */
  processed: "✅",
  /** Could not be delivered — the operator needs to know. */
  undeliverable: "⚠️",
} as const;

export type ReceiptState = keyof typeof RECEIPT_EMOJI;
