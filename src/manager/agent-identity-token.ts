import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Per-agent capability token for IPC identity gating (C3 — unauthenticated
 * cross-agent memory R/W).
 *
 * THREAT: the daemon exposes ~18 memory/document/conversation IPC handlers on
 * ONE shared Unix socket; each resolves the target store from a caller-supplied
 * `agent` param with no identity check. Any agent's MCP shim could pass another
 * agent's name and read/write its memory (Reg S-P).
 *
 * MECHANISM: at spawn the daemon injects, into the agent's clawcode MCP server
 * env, a token = HMAC-SHA256(daemonSecret, agentName). The shim sends it
 * (`_agentToken` + `_callerAgent`) on every gated IPC call. The daemon
 * recomputes the HMAC from its in-memory secret and the CLAIMED caller, and
 * requires the requested `agent` to equal that verified caller. Verification is
 * stateless — no token table is persisted.
 *
 * HONEST SCOPE (this is tool-path hardening, NOT a full Reg S-P closure):
 *   - Closes the sanctioned-tool impersonation vector: a prompt-injected agent
 *     told to `memory_save({agent:"other"})` through its shim is forced to its
 *     own identity / rejected.
 *   - Does NOT close: (a) a tokenless raw-socket call — fail-open treats it as a
 *     trusted admin/CLI/dashboard path (required so v2 agents, tokenless until
 *     restart, and admin tooling are not locked out); (b) a same-uid agent
 *     reading another agent's `memory.db` off disk directly. Both require an OS
 *     boundary (per-agent uid / bwrap) — see RUNBOOK.
 */

/** Env var the shim reads to obtain its spawn-injected token. */
export const AGENT_TOKEN_ENV = "CLAWCODE_AGENT_TOKEN";
/** Env var carrying the agent's authoritative name (already set on v3 spawn). */
export const AGENT_NAME_ENV = "CLAWCODE_AGENT";
/** Params keys the shim adds to every gated IPC request. */
export const AGENT_TOKEN_PARAM = "_agentToken";
export const CALLER_AGENT_PARAM = "_callerAgent";

/**
 * Generate a fresh random daemon secret (256-bit hex). Held in daemon memory
 * for the process lifetime; never persisted. A daemon restart rotates it, and
 * because tokens are injected at spawn and agents are (re)started by the same
 * daemon, the injected tokens always match the live secret.
 */
export function generateDaemonIdentitySecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Process-singleton holder for the daemon identity secret. Lives here (not in
 * daemon.ts) so BOTH the daemon (mint + verify) and the v3
 * claude-code-interactive backend (mint at spawn) can read it without a
 * circular import (daemon ⇄ backend). Set once at boot via
 * `initProcessIdentitySecret`; read via `getProcessIdentitySecret`.
 */
let processIdentitySecret: string | null = null;

/**
 * Initialise the process identity secret. Pinnable via
 * `CLAWCODE_IDENTITY_SECRET` (used by the dispatch-path gate test); otherwise
 * random-per-boot. Idempotent-safe to call again (re-pins).
 */
export function initProcessIdentitySecret(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const pinned = env.CLAWCODE_IDENTITY_SECRET?.trim();
  processIdentitySecret =
    pinned && pinned.length > 0 ? pinned : generateDaemonIdentitySecret();
  return processIdentitySecret;
}

/** Read the process identity secret (null before boot init). */
export function getProcessIdentitySecret(): string | null {
  return processIdentitySecret;
}

/**
 * Mint a per-agent token if the process secret is initialised, else null.
 * Convenience for spawn paths: `null` means "no token injected" (fail-open).
 */
export function mintAgentTokenIfAvailable(agentName: string): string | null {
  if (processIdentitySecret === null) return null;
  return computeAgentToken(processIdentitySecret, agentName);
}

/** Compute the per-agent token = HMAC-SHA256(secret, agentName), hex. */
export function computeAgentToken(secret: string, agentName: string): string {
  return createHmac("sha256", secret).update(agentName).digest("hex");
}

/** Constant-time comparison of two hex token strings of equal byte length. */
function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type IdentityDecision =
  | { readonly ok: true; readonly mode: "untokenized" | "verified" }
  | { readonly ok: false; readonly reason: string };

/**
 * Decide whether a gated IPC request may act on `requestedAgent`.
 *
 * FAIL-OPEN by design (see scope note above):
 *   - No token present → `untokenized` admin/CLI/dashboard path → allowed.
 *   - Token present + valid HMAC for the claimed caller + caller === requested
 *     agent → `verified` → allowed.
 *   - Token present but invalid HMAC, or caller ≠ requested agent → REJECTED.
 *
 * Pure: the daemon passes its in-memory secret + the request params.
 */
export function decideAgentIdentity(args: {
  readonly secret: string;
  readonly requestedAgent: string;
  readonly token: unknown;
  readonly callerAgent: unknown;
}): IdentityDecision {
  const { secret, requestedAgent, token, callerAgent } = args;

  // No token → untokenized trusted path. Fail-open.
  if (token === undefined || token === null || token === "") {
    return { ok: true, mode: "untokenized" };
  }

  if (typeof token !== "string") {
    return { ok: false, reason: "agent token must be a string" };
  }
  if (typeof callerAgent !== "string" || callerAgent.length === 0) {
    return {
      ok: false,
      reason: "agent token present without a valid caller identity",
    };
  }

  const expected = computeAgentToken(secret, callerAgent);
  if (!tokensEqual(token, expected)) {
    return { ok: false, reason: "invalid agent identity token" };
  }

  // Token proves the caller's identity. The requested target must match it —
  // this is the cross-agent impersonation gate.
  if (requestedAgent !== callerAgent) {
    return {
      ok: false,
      reason: `agent '${callerAgent}' may not access agent '${requestedAgent}' memory (cross-agent access denied)`,
    };
  }

  return { ok: true, mode: "verified" };
}
