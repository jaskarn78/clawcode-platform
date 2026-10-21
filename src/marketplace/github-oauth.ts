/**
 * Phase 90 Plan 06 HUB-07 — GitHub OAuth device-code flow.
 *
 * Headless-friendly OAuth per D-02 (§Claude's Discretion): the ClawCode
 * daemon has no HTTPS callback surface, so web-redirect OAuth is not viable.
 * Device-code flow works in two steps:
 *
 *   1. POST https://github.com/login/device/code
 *        body: client_id=<CLAWHUB_GITHUB_CLIENT_ID>&scope=read:user
 *        → {device_code, user_code, verification_uri, expires_in, interval}
 *
 *   2. Display user_code + verification_uri in Discord embed. User visits
 *      the URL and enters the code.
 *
 *   3. Poll https://github.com/login/oauth/access_token every `interval`
 *      seconds:
 *        body: client_id=..., device_code=..., grant_type=urn:ietf:params:oauth:grant-type:device_code
 *        → 200 {access_token} on completion
 *        → 400 {error:"authorization_pending"} → keep polling
 *        → 400 {error:"slow_down"} → bump interval by +5s
 *        → 400 {error:"expired_token"} → abort (OAuthExpiredError)
 *        → 400 {error:"access_denied"} → abort (OAuthAccessDeniedError)
 *
 *   4. storeTokenTo1Password: shell out to `op item create --category=Credential
 *      --title="ClawHub Token" credential=<token>` so the token lives at
 *      op://example-vault-21/ClawHub Token/credential for downstream ClawHub calls.
 *
 * Pure-function DI (Phase 85 blueprint): all I/O injected via the `deps`
 * struct. Tests drop in fetch + sleep + execFile stubs without touching
 * vi.mock. Production calls use globalThis.fetch + setTimeout + execFile.
 *
 * Placeholder GitHub App client_id: until ClawCode registers a dedicated
 * GitHub OAuth App, the client_id is a placeholder. Callers can override
 * via CLAWHUB_GITHUB_CLIENT_ID env var. When the env var is absent the
 * device-code endpoint returns an error — the Discord UI surfaces this as
 * the "auth deferred" state per plan critical_constraints.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Endpoints + placeholder client id
// ---------------------------------------------------------------------------

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * GitHub App client_id for ClawHub. Read from env var with a placeholder
 * fallback. The placeholder will fail at the device-code endpoint — the UI
 * catches this and surfaces "OAuth not configured yet; ask operator to set
 * CLAWHUB_GITHUB_CLIENT_ID" per plan contract.
 */
function getClientId(): string {
  return (
    process.env.CLAWHUB_GITHUB_CLIENT_ID ??
    process.env.GITHUB_CLIENT_ID ??
    "Iv1.clawhub-public-placeholder"
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of initiateDeviceCodeFlow. Caller uses `user_code` + `verification_uri`
 * to render the Discord embed; `device_code` + `interval` + `expires_at` are
 * passed back to pollForAccessToken to complete the flow.
 */
export type DeviceCodeInit = Readonly<{
  user_code: string;
  verification_uri: string;
  device_code: string;
  interval: number; // seconds — starting poll cadence
  expires_at: number; // ms epoch — absolute deadline for poll
}>;

/**
 * DI struct: fetch + now + sleep + run. Tests override each piece; production
 * uses globalThis.fetch, Date.now, setTimeout, and child_process.execFile.
 */
export type GithubOauthDeps = Readonly<{
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  run?: (bin: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string } | unknown>;
}>;

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Device code expired before the user completed the flow (GitHub returns
 * error=expired_token, OR the local clock passed expires_at with no success).
 */
export class OAuthExpiredError extends Error {
  constructor() {
    super("github device-code expired before token received");
    this.name = "OAuthExpiredError";
  }
}

/**
 * User explicitly denied access on the GitHub consent page.
 */
export class OAuthAccessDeniedError extends Error {
  constructor() {
    super("user denied GitHub OAuth consent");
    this.name = "OAuthAccessDeniedError";
  }
}

// ---------------------------------------------------------------------------
// initiateDeviceCodeFlow
// ---------------------------------------------------------------------------

/**
 * Kick off the GitHub device-code flow. Returns the user_code to display +
 * the device_code to pass to pollForAccessToken.
 *
 * Throws on non-OK response (e.g. invalid client_id — caller surfaces this
 * as "auth deferred" state per plan contract).
 */
export async function initiateDeviceCodeFlow(
  deps?: GithubOauthDeps,
): Promise<DeviceCodeInit> {
  const fetchFn = deps?.fetch ?? globalThis.fetch;
  const nowFn = deps?.now ?? Date.now;
  const clientId = getClientId();
  const res = await fetchFn(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `client_id=${encodeURIComponent(clientId)}&scope=read%3Auser`,
  });
  if (!res.ok) {
    throw new Error(
      `github device-code init failed: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
    );
  }
  const body = (await res.json()) as {
    device_code?: unknown;
    user_code?: unknown;
    verification_uri?: unknown;
    expires_in?: unknown;
    interval?: unknown;
  };
  if (
    typeof body.device_code !== "string" ||
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string"
  ) {
    throw new Error("github device-code init: malformed response body");
  }
  const intervalSec = typeof body.interval === "number" ? body.interval : 5;
  const expiresInSec =
    typeof body.expires_in === "number" ? body.expires_in : 900;
  const now = nowFn();
  return Object.freeze({
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    device_code: body.device_code,
    interval: intervalSec,
    expires_at: now + expiresInSec * 1000,
  });
}

// ---------------------------------------------------------------------------
// pollForAccessToken
// ---------------------------------------------------------------------------

/**
 * Poll the GitHub token endpoint until we receive an access_token, a fatal
 * error response, or the clock passes `expires_at`.
 *
 * State machine per GitHub OAuth device-code spec:
 *   - access_token present          → return token
 *   - error="authorization_pending" → sleep(interval), retry
 *   - error="slow_down"             → interval += 5, sleep, retry
 *   - error="access_denied"         → throw OAuthAccessDeniedError
 *   - error="expired_token"         → throw OAuthExpiredError
 *   - any other error               → continue polling (likely transient)
 *   - clock > expires_at            → throw OAuthExpiredError
 */
export async function pollForAccessToken(
  init: DeviceCodeInit,
  deps?: GithubOauthDeps,
): Promise<string> {
  const fetchFn = deps?.fetch ?? globalThis.fetch;
  const nowFn = deps?.now ?? Date.now;
  const sleep =
    deps?.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clientId = getClientId();

  let interval = init.interval;
  while (nowFn() < init.expires_at) {
    await sleep(interval * 1000);
    const res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body:
        `client_id=${encodeURIComponent(clientId)}` +
        `&device_code=${encodeURIComponent(init.device_code)}` +
        `&grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:device_code")}`,
    });
    const body = (await res.json()) as {
      access_token?: unknown;
      error?: unknown;
    };
    if (typeof body.access_token === "string" && body.access_token.length > 0) {
      return body.access_token;
    }
    if (body.error === "authorization_pending") {
      continue;
    }
    if (body.error === "slow_down") {
      interval += 5;
      continue;
    }
    if (body.error === "access_denied") {
      throw new OAuthAccessDeniedError();
    }
    if (body.error === "expired_token") {
      throw new OAuthExpiredError();
    }
    // Unknown/transient error — keep polling until expiry.
  }
  throw new OAuthExpiredError();
}

// ---------------------------------------------------------------------------
// storeTokenTo1Password
// ---------------------------------------------------------------------------

/**
 * Persist the GitHub access token to 1Password as a Credential item.
 *
 * Produces the item at `op://example-vault-21/<label>/credential` — downstream
 * ClawHub calls consume this via `op read` resolution (same pattern as
 * Discord bot tokens per D-02).
 *
 * Invocation:
 *   op item create --category=Credential --title="<label>" --vault=clawdbot credential=<token>
 *
 * Note: `--vault=clawdbot` is the Phase 90 convention for machine secrets;
 * operators who use a different vault can override via the OP_VAULT env
 * var (standard 1Password CLI contract).
 */
export async function storeTokenTo1Password(
  token: string,
  label: string = "ClawHub Token",
  deps?: GithubOauthDeps,
): Promise<void> {
  const run =
    deps?.run ??
    (async (bin: string, args: readonly string[]) => {
      const res = await execFileP(bin, [...args]);
      return { stdout: res.stdout.toString(), stderr: res.stderr.toString() };
    });
  const args: string[] = [
    "item",
    "create",
    "--category=Credential",
    `--title=${label}`,
    `credential=${token}`,
  ];
  // Honor OP_VAULT if set (standard 1Password CLI contract); otherwise
  // target the clawdbot vault per Phase 90 convention.
  if (process.env.OP_VAULT) {
    args.splice(2, 0, `--vault=${process.env.OP_VAULT}`);
  } else {
    args.splice(2, 0, "--vault=clawdbot");
  }
  await run("op", args);
}
