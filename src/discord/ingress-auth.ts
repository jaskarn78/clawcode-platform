/**
 * Phase 999.144 — inbound-channel authentication decisions (pure).
 *
 * Two gates, one module, because they answer the same question from opposite
 * directions: "may this Discord message become agent input?"
 *
 *   1. A2A envelope auth — webhook embeds claiming to be agent-to-agent
 *      traffic must carry a valid HMAC (see collaboration/envelope-auth.ts).
 *      The INCIDENT-webhook-spam-2026-09-16 lesson: the footer FORMAT was the
 *      only gate, and the format is public in this repo.
 *   2. Human allowlist — a human author must be on the operator-configured
 *      Discord user-id allowlist (unset = feature off, preserving existing
 *      behavior; the schema forbids an empty list so "configured but empty"
 *      — which would brick every channel — is unrepresentable).
 *
 * Pure functions so the policy is unit-testable without a Discord client;
 * the bridge holds only thin glue.
 */

import {
  verifyA2aEnvelope,
  type A2aEnvelopeFields,
} from "../collaboration/envelope-auth.js";

/** Rollout dial — mirrors governor.mode / shimRuntime / advisor.backend. */
export type EnvelopeAuthMode = "off" | "shadow" | "enforce";

export type EnvelopeVerdict =
  | "pass"            // valid signature
  | "unsigned"        // A2A-shaped footer, no sig segment (legacy build, mirror, or forgery)
  | "bad-signature"   // sig present but wrong — tampered or forged
  | "no-secret"       // daemon has no identity secret (pre-boot) — cannot judge
  | "skipped";        // mode off — not evaluated

export interface EnvelopeAuthDecision {
  readonly verdict: EnvelopeVerdict;
  /** May the relay dispatch this embed as an agent turn? */
  readonly dispatch: boolean;
}

/**
 * Decide whether an A2A-shaped webhook embed may dispatch.
 *
 *   off     → dispatch, no evaluation (pre-999.144 behavior).
 *   shadow  → ALWAYS dispatch; verdict is for logs. The retune-vs-real-load
 *             mode: watch for unexpected `unsigned`/`bad-signature` before
 *             flipping to enforce.
 *   enforce → dispatch ONLY on a valid signature. `unsigned` is a refusal by
 *             design — that is precisely the forged-footer hole, and it is
 *             also what retires the ask-agent mirror double-run (mirrors are
 *             deliberately unsigned display-only embeds).
 *
 * `no-secret` dispatches even under enforce: it means THIS process cannot
 * judge (identity secret not initialised — a boot-window state, the same
 * fail-open the `_callerAgent` verifier uses), not that the message is bad.
 */
export function evaluateEnvelopeAuth(
  mode: EnvelopeAuthMode,
  secret: string | null,
  fields: A2aEnvelopeFields,
  sig: string | undefined,
): EnvelopeAuthDecision {
  if (mode === "off") return { verdict: "skipped", dispatch: true };
  if (secret === null) return { verdict: "no-secret", dispatch: true };
  if (sig === undefined || sig === "") {
    return { verdict: "unsigned", dispatch: mode !== "enforce" };
  }
  if (verifyA2aEnvelope(secret, fields, sig)) {
    return { verdict: "pass", dispatch: true };
  }
  return { verdict: "bad-signature", dispatch: mode !== "enforce" };
}

/**
 * Human-author gate. `undefined` allowlist = feature not configured → allow
 * (existing behavior, no surprise lockout on upgrade). A configured list is
 * exact-match on the Discord snowflake id. The schema enforces min(1), so an
 * empty array never reaches here from config; if one does (programmer
 * error), it denies — fail closed, the pending-prompt-registry precedent.
 */
export function isHumanAuthorAllowed(
  allowedUserIds: readonly string[] | undefined,
  authorId: string,
): boolean {
  if (allowedUserIds === undefined) return true;
  return allowedUserIds.includes(authorId);
}
