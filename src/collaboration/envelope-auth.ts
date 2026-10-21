/**
 * Phase 999.144 — cryptographic A2A envelope authentication.
 *
 * WHY (INCIDENT-webhook-spam-2026-09-16): a leaked legacy webhook URL let an
 * outside actor post arbitrary content into a bound channel. The fleet was not
 * prompt-injected ONLY because the spam lacked our A2A footer — i.e. the sole
 * gate between "rendered in a channel" and "dispatched as an agent turn" was a
 * string FORMAT that is plainly readable in this repository. Authentication by
 * obscurity.
 *
 * THE RULE: rendering may be spoofable — Discord allows anyone with a webhook
 * URL to render anything — but DISPATCH requires proof. An A2A embed now
 * carries an HMAC minted by the daemon; the relay verifies it before a turn is
 * dispatched. The key is the existing process identity secret (the same trust
 * root as `_callerAgent` tokens): held in daemon memory, never persisted,
 * rotated on restart. Sign and verify happen in the same process seconds
 * apart, so rotation is a non-issue; anything unverifiable after a restart
 * still reaches the agent through the inbox path, which has its own identity
 * story.
 *
 * Replay is NOT this module's job: the cross-path DeliveryDedupe already
 * collapses any repeated deliveryId to a single turn (999.117 WS-2). The
 * signature binds WHO said WHAT to WHOM; the dedupe bounds HOW MANY TIMES.
 *
 * Pure functions, node:crypto only — no Discord, no daemon imports.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Fields bound by the signature. */
export interface A2aEnvelopeFields {
  /** Cross-path idempotency key (999.117). Absent id signs as empty. */
  readonly deliveryId: string;
  /** Machine name of the sending agent (footer sender, not display name). */
  readonly sender: string;
  /** Machine name of the agent the embed is addressed to (bound channel). */
  readonly recipient: string;
  /**
   * The EXACT embed description string as posted (i.e. AFTER truncation).
   * Hash-bound so a valid footer cannot be re-attached to new content.
   */
  readonly content: string;
}

/**
 * Canonical byte string under the MAC. Versioned first token so a future
 * field change cannot collide with v1 signatures. Every variable-length
 * field is LENGTH-PREFIXED (netstring style, `<byteLength>:<value>`) so
 * field boundaries are structural — a separator character occurring INSIDE
 * a field can never shift content between positions (`a\nb`+`c` must not
 * canonicalize like `a`+`b\nc`; the unit test pins this). Free-text content
 * additionally rides as its hash.
 */
export function canonicalEnvelopeString(fields: A2aEnvelopeFields): string {
  const ns = (v: string) => `${Buffer.byteLength(v, "utf8")}:${v}`;
  const contentHash = createHash("sha256").update(fields.content, "utf8").digest("hex");
  return [
    "a2a-v1",
    ns(fields.deliveryId),
    ns(fields.sender),
    ns(fields.recipient),
    contentHash,
  ].join("\n");
}

/** Sign the envelope. Returns lowercase hex HMAC-SHA256 (64 chars). */
export function signA2aEnvelope(secret: string, fields: A2aEnvelopeFields): string {
  return createHmac("sha256", secret)
    .update(canonicalEnvelopeString(fields), "utf8")
    .digest("hex");
}

/** Constant-time signature check. Malformed/odd-length sig → false, never throws. */
export function verifyA2aEnvelope(
  secret: string,
  fields: A2aEnvelopeFields,
  sig: string,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = Buffer.from(signA2aEnvelope(secret, fields), "hex");
  const actual = Buffer.from(sig, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
