/**
 * dashboard-rework P4 — minimal admin auth gate.
 *
 * The dashboard historically had ZERO auth and binds to loopback/Tailscale.
 * Adding write surfaces (config edits, key management, agent control, optimizer
 * runs, agent creation) raises the exposure, so mutating requests + the OpenAI
 * key surface are gated behind a single shared admin token.
 *
 * Token source: env `CLAWCODE_DASHBOARD_TOKEN`. Presented by the client as
 * `Authorization: Bearer <token>` (or `X-Clawcode-Token`).
 *
 * FAIL-OPEN by design: when the env var is unset, auth is DISABLED and every
 * request is allowed — preserving the existing single-host loopback behavior
 * and guaranteeing operators can never lock themselves out by deploying this
 * code without first setting a token. Set the token to turn the gate on.
 */
import type { IncomingMessage } from "node:http";

const TOKEN_ENV = "CLAWCODE_DASHBOARD_TOKEN";

/** The configured admin token, or null when auth is disabled. */
export function adminToken(): string | null {
  const t = process.env[TOKEN_ENV]?.trim();
  return t && t.length > 0 ? t : null;
}

export function isAuthEnabled(): boolean {
  return adminToken() !== null;
}

function presentedToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const t = auth.slice("Bearer ".length).trim();
    return t.length > 0 ? t : null;
  }
  const hdr = req.headers["x-clawcode-token"];
  if (typeof hdr === "string" && hdr.trim().length > 0) return hdr.trim();
  return null;
}

/** Length-independent constant-time-ish compare (avoids early-exit timing leak). */
export function tokensMatch(presented: string, expected: string): boolean {
  // Compare against a fixed-length transform so length itself doesn't leak via
  // timing; an unequal length still returns false.
  let diff = presented.length === expected.length ? 0 : 1;
  const n = Math.max(presented.length, expected.length);
  for (let i = 0; i < n; i++) {
    diff |= (presented.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * True when the request may perform an admin action. Fail-open when no token is
 * configured. Pure enough to unit-test: pass a `{headers}`-shaped object.
 */
export function isAdminAuthorized(req: Pick<IncomingMessage, "headers">): boolean {
  const token = adminToken();
  if (token === null) return true; // auth disabled
  const presented = presentedToken(req as IncomingMessage);
  return presented !== null && tokensMatch(presented, token);
}

/**
 * Should this request be gated? Mutations (POST/PUT/DELETE/PATCH) and the
 * OpenAI key surface (list/create/revoke) are sensitive. The SPA telemetry sink
 * and the HMAC-verified webhook endpoint are exempt (non-sensitive / separately
 * authenticated).
 */
export function isGatedRequest(method: string, pathname: string): boolean {
  if (pathname.startsWith("/api/openai/keys")) return true;
  const isMutation =
    method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH";
  if (!isMutation) return false;
  if (pathname === "/api/dashboard-telemetry") return false;
  if (pathname.startsWith("/webhook")) return false;
  return true;
}
