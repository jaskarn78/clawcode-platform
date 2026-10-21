/**
 * Quick 260520-r70 — shared agent-to-agent inbox ack-emitter.
 *
 * Closes the cross-agent message acknowledgment loop. When a target agent
 * CONSUMES a genuine cross-agent inbox message, this emitter writes an ack
 * back into the SENDER's inbox (kind "ack") AND posts it to the sender's
 * Discord channel — reusing the EXISTING post-to-agent delivery cascade
 * (webhook → bot-direct → inbox-only). No 4th delivery path.
 *
 * Design invariants (all proven by inbox-ack.test.ts):
 *
 *  1. LOOP PREVENTION — consuming a message whose `kind` resolves to "ack"
 *     is a no-op. The emitter never acks an ack. Without this the sender
 *     would ack the ack, the target would ack THAT, ad infinitum.
 *
 *  2. CROSS-AGENT GATING — only messages whose `from` is a known fleet
 *     agent are acked. System / trigger / attachment-ingest messages
 *     (Phase 999.43) have a `from` that is not a fleet agent → no-op.
 *
 *  3. SINGLE HOOK — this factory produces ONE emitter closure that BOTH
 *     inbox consumers (InboxSource watcher + heartbeat reconciler) call.
 *     No module-level flag, no bifurcated emit path.
 *
 *  4. FIRE-AND-FORGET — the emitter NEVER rejects. A delivery failure is
 *     caught, warn-logged, and swallowed. Ack emission must never block,
 *     delay, or fail the target agent's turn or the markProcessed move.
 */

import type { InboxMessage } from "./types.js";
import { resolveKind } from "./inbox.js";

/** Minimal pino-like logger surface — mirrors PostToAgentLogger. */
export type InboxAckLogger = Readonly<{
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}>;

/**
 * Delivery closure — production wraps `handlePostToAgentIpc` with
 * `kind: "ack"` so the ack rides the existing cross-agent cascade.
 */
export type InboxAckDeliver = (req: {
  from: string;
  to: string;
  message: string;
  kind: "ack";
  /**
   * Phase 999.117 WS-4 — the id of the message being acknowledged. The
   * delivery path looks this up in the presentation registry to find the
   * Discord message that rendered it, and reacts there instead of posting a
   * separate receipt. Without it the ack has no way to say WHICH message it
   * is acknowledging, and falls back to a text notification.
   */
  causationId: string;
}) => Promise<{ ok: boolean; delivered: boolean }>;

/** Injected dependencies for the ack-emitter. Fully DI — no fs, no Discord. */
export type InboxAckDeps = Readonly<{
  /**
   * The set of known fleet agent names. Used by the cross-agent gate:
   * a consumed message whose `from` is NOT in this set is not acked
   * (system / trigger / attachment-ingest messages).
   */
  fleetAgentNames: ReadonlySet<string>;
  /** Injectable clock — production uses `() => Date.now()`. */
  now: () => number;
  /** The delivery closure — production wraps `handlePostToAgentIpc`. */
  deliverAck: InboxAckDeliver;
  /** Pino-like logger for the fire-and-forget failure path. */
  log: InboxAckLogger;
}>;

/**
 * The shared emitter closure both inbox consumers invoke.
 *
 * @param consumed - The inbox message that was just consumed.
 *   `consumed.from` becomes the ack's `to` (the original sender).
 * @param consumerAgent - The agent that just consumed `consumed`.
 *   Becomes the ack's `from`.
 * @returns A promise that ALWAYS resolves (never rejects).
 */
export type InboxAckEmitter = (
  consumed: InboxMessage,
  consumerAgent: string,
) => Promise<void>;

/**
 * Zero-pad a millisecond timestamp to a local-time `HH:MM` string.
 */
function formatHhMm(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Build the locked ack content shape:
 *   ✅ <consumerAgent> processed your message
 *   sent <hh:mm> · processed <hh:mm>
 */
function buildAckContent(
  consumerAgent: string,
  sentTs: number,
  processedTs: number,
): string {
  const line1 = `✅ ${consumerAgent} processed your message`;
  const line2 = `sent ${formatHhMm(sentTs)} · processed ${formatHhMm(processedTs)}`;
  return `${line1}\n${line2}`;
}

/**
 * Create the shared inbox ack-emitter. Call ONCE at daemon boot; pass the
 * SAME returned closure to both inbox consumers (InboxSource + heartbeat
 * reconciler) so the ack fires from a single hook point.
 */
export function createInboxAckEmitter(deps: InboxAckDeps): InboxAckEmitter {
  return async (consumed: InboxMessage, consumerAgent: string): Promise<void> => {
    // (a) LOOP PREVENTION — never ack an ack.
    if (resolveKind(consumed) === "ack") {
      return;
    }

    // (b) CROSS-AGENT GATING — only ack genuine fleet-agent senders.
    if (!deps.fleetAgentNames.has(consumed.from)) {
      return;
    }

    // (c)-(e) Build + deliver the ack. The ENTIRE delivery is wrapped in
    // try/catch — fire-and-forget: this function MUST NEVER reject.
    try {
      const ackContent = buildAckContent(
        consumerAgent,
        consumed.timestamp,
        deps.now(),
      );
      await deps.deliverAck({
        from: consumerAgent,
        to: consumed.from,
        message: ackContent,
        kind: "ack",
        // The consumed message's own id — what the presentation registry is
        // keyed on, so the ack can land as a reaction on it.
        causationId: consumed.deliveryId ?? consumed.id,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        {
          consumerAgent,
          originalSender: consumed.from,
          messageId: consumed.id,
          error,
        },
        "inbox-ack: emit failed (non-fatal)",
      );
    }
  };
}
