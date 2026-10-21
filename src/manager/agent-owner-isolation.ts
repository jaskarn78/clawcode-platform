/**
 * Cross-agent owner/tenant isolation (2026-06-27).
 *
 * One daemon runs many agents as one OS uid over one Unix socket. Agents are
 * tagged with an `owner` (e.g. "owner_a" / "client_a"). This module is the single
 * authority that decides whether a CALLER agent may perform a cross-agent
 * action against a TARGET agent — used at the daemon's IPC dispatch chokepoint
 * so a new cross-agent handler cannot silently bypass it.
 *
 * Rules, in order:
 *   1. The caller identity used for the check is the TOKEN-VERIFIED caller
 *      (`_callerAgent` proven by `_agentToken` = HMAC(secret, name)), NEVER a
 *      self-reported `from`/`agent`/`parentAgent` param — otherwise a Client A agent
 *      sets `from:"personal"` and the owner comparison reads owner_a→owner_a and allows
 *      it. Tokenless calls (CLI/dashboard/pre-boot) fail OPEN (trusted local),
 *      consistent with `enforceAgentIdentity`.
 *   2. Owner boundary: admin callers are exempt; otherwise if the TARGET has an
 *      owner and it differs from the caller's owner, DENY (fail-closed toward
 *      owned targets — an unowned caller cannot reach an owned target).
 *   3. Admin-TARGET request exemption: a SEND/request method
 *      ({@link REQUEST_METHODS_TO_ADMIN}) directed at an `admin` agent is allowed
 *      from any owner, so a tenant agent can ask the fleet coordinator (Admin
 *      Clawdy) to make a change or escalate. Read/history/scheduling methods and
 *      the read vectors below keep rule 2, so admin's cross-tenant context stays
 *      private. This exemption lives in `enforceCrossAgentIsolation` (which knows
 *      the method), NOT in `assertCrossAgentAllowed`.
 *
 * Pure + dependency-injected (secret + configs passed in) so it unit-tests with
 * no daemon. The Discord-channel/thread read vectors (read-thread,
 * fetch-discord-messages) resolve their target agent OUTSIDE this module (the
 * daemon maps threadId/channelId → owning agent) and then call
 * {@link assertCrossAgentAllowed} directly.
 */

import { timingSafeEqual } from "node:crypto";
import { ManagerError } from "../shared/errors.js";
import {
  AGENT_TOKEN_PARAM,
  CALLER_AGENT_PARAM,
  computeAgentToken,
} from "./agent-identity-token.js";

/** Minimal config projection this module needs. */
export interface OwnerConfigView {
  readonly name: string;
  readonly owner?: string;
  readonly admin?: boolean;
}

/**
 * Map of IPC method → extractor returning the TARGET agent name from params
 * (or undefined when there is no cross-agent target, e.g. a non-delegate
 * subagent spawn). Param keys are the verified handler param names. The two
 * Discord-read vectors are NOT here — their target is resolved from a
 * threadId/channelId by the daemon and checked via assertCrossAgentAllowed.
 */
export const CROSS_AGENT_TARGET_EXTRACTORS: Readonly<
  Record<string, (params: Record<string, unknown>) => string | undefined>
> = {
  "ask-agent": (p) => asName(p.to),
  "send-message": (p) => asName(p.to),
  "post-to-agent": (p) => asName(p.to),
  // The PARENT (`parentAgent`) is the caller; the cross-agent target is the
  // delegate it spawns AS. A non-delegate spawn inherits the caller's own
  // config → no cross-agent target.
  "spawn-subagent-thread": (p) => asName(p.delegateTo),
  "start-workflow": (p) => asName(p.agent),
  "delegate-task": (p) => asName(p.target),
  "message-history": (p) => asName(p.agent),
  "schedule-recurring": (p) => asName(p.agent),
  "training-connect-link": (p) => asName(p.agent),
  "schedule-reminder": (p) => asName(p.agent),
};

function asName(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Resolve the token-verified caller. Returns the caller name when the token
 * proves it; `null` when no token is present (trusted local path — fail open);
 * THROWS on a present-but-invalid token (forged identity).
 */
export function resolveVerifiedCaller(
  params: Record<string, unknown>,
  secret: string | null,
): string | null {
  const token = params[AGENT_TOKEN_PARAM];
  const caller = params[CALLER_AGENT_PARAM];
  if (
    secret === null ||
    typeof token !== "string" ||
    token.length === 0 ||
    typeof caller !== "string" ||
    caller.length === 0
  ) {
    return null; // tokenless → trusted CLI/dashboard/pre-boot (fail open)
  }
  const expected = computeAgentToken(secret, caller);
  const expectedBuf = Buffer.from(expected, "hex");
  const tokenBuf = Buffer.from(token, "hex");
  if (
    expectedBuf.length !== tokenBuf.length ||
    !timingSafeEqual(expectedBuf, tokenBuf)
  ) {
    throw new ManagerError(
      `agent-identity token mismatch for caller '${caller}' — cross-agent action refused`,
    );
  }
  return caller;
}

/**
 * Throw {@link ManagerError} if `callerName` may not act on `targetName`.
 * Same-name (self) and admin callers are always allowed; an unowned target
 * asserts no boundary; otherwise owners must match.
 */
export function assertCrossAgentAllowed(
  callerName: string,
  targetName: string,
  configs: readonly OwnerConfigView[],
): void {
  if (callerName === targetName) return;
  const caller = configs.find((c) => c.name === callerName);
  if (caller?.admin) return; // admin agents are cross-owner exempt
  const target = configs.find((c) => c.name === targetName);
  const targetOwner = target?.owner;
  if (targetOwner === undefined) return; // untenanted target → no boundary
  if (caller?.owner !== targetOwner) {
    throw new ManagerError(
      `cross-owner action denied: '${callerName}' (owner=${
        caller?.owner ?? "none"
      }) may not act on '${targetName}' (owner=${targetOwner})`,
    );
  }
}

/**
 * The SEND/request methods any agent may direct at an `admin` (coordinator)
 * agent regardless of owner — so a tenant agent can ask Admin Clawdy to make a
 * change (e.g. register a cron) or escalate. This is a TARGET-admin exemption
 * for the request direction ONLY: read/history/scheduling methods and the
 * direct read-thread / fetch-discord vectors stay strictly owner-scoped (via
 * `assertCrossAgentAllowed`), so an admin agent's cross-tenant context is never
 * exposed to a caller from another owner.
 */
const REQUEST_METHODS_TO_ADMIN: ReadonlySet<string> = new Set([
  "ask-agent",
  "send-message",
  "post-to-agent",
  "delegate-task",
]);

/**
 * Central enforcement for param-addressable cross-agent IPC methods. Called at
 * the daemon's IPC dispatch chokepoint. No-op for non-cross-agent methods,
 * tokenless callers, and calls with no cross-agent target. Throws on a denied
 * cross-owner action or a forged token.
 *
 * Admin-target request exemption: a {@link REQUEST_METHODS_TO_ADMIN} call whose
 * target is an admin agent is allowed from any owner (see the set's doc). Every
 * other method still goes through the strict same-owner `assertCrossAgentAllowed`
 * — including the read/scheduling methods and the direct read-vector callers, so
 * only the coordinator's inbound request channel opens, not its context.
 */
export function enforceCrossAgentIsolation(
  method: string,
  params: Record<string, unknown>,
  configs: readonly OwnerConfigView[],
  secret: string | null,
): void {
  const extractor = CROSS_AGENT_TARGET_EXTRACTORS[method];
  if (!extractor) return;
  const target = extractor(params);
  if (target === undefined) return;
  const caller = resolveVerifiedCaller(params, secret);
  if (caller === null) return; // trusted local path
  // Any agent may SEND a request to a coordinator (admin) agent. Gated on the
  // method here (not inside assertCrossAgentAllowed) so the direct read-vector
  // callers keep the strict rule — admin history/threads stay owner-scoped.
  if (
    REQUEST_METHODS_TO_ADMIN.has(method) &&
    configs.find((c) => c.name === target)?.admin
  ) {
    return;
  }
  assertCrossAgentAllowed(caller, target, configs);
}
