/**
 * Phase 999.176 — drive the pinned `claude` binary for account checks and
 * re-login, always in an ISOLATED config dir so nothing touches the live
 * fleet credential until the operator confirms a swap.
 *
 * Two operations:
 *
 *  - {@link preflightSlot}: copy a saved slot into a temp dir and make one
 *    tiny `claude -p` call. If the slot's refresh token is alive the binary
 *    refreshes in place, which ROTATES the refresh token — so the refreshed
 *    file is written back to the slot before the temp dir is removed.
 *    Dropping it would leave the slot holding a now-dead token.
 *
 *  - {@link LoginSession}: `claude auth login --claudeai --email <target>`
 *    with piped stdin. The child prints the authorize URL and waits for the
 *    `code#state` paste; it holds the PKCE verifier, so it stays alive until
 *    a code arrives, the TTL expires, or the operator cancels. After a
 *    successful exchange, the signed-in email is checked against the
 *    target before anything is saved (a browser already signed in to the
 *    other account would otherwise mint the wrong account's credential).
 *
 * The child env is built from scratch: `ANTHROPIC_API_KEY` in the daemon
 * env would silently turn the preflight into an API-key call that "passes"
 * without proving anything about the OAuth credential.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDEAI_CONNECTORS_DISABLED_ENV } from "../shared/claudeai-connectors.js";
import {
  hasRefreshToken,
  slotPath,
  summarizeCredentialJson,
  writeSlot,
  type CredentialSummary,
} from "./credential-slots.js";

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcess;

export type OAuthCliDeps = {
  /** The fleet binary (999.169 resolver, resolved at boot) or "claude". */
  readonly claudeBin: string;
  /** The daemon's live Claude config dir (holds `.credentials*.json`). */
  readonly configDir: string;
  /** Scratch root for isolated dirs; same filesystem as configDir is ideal. */
  readonly workRoot: string;
  readonly spawn?: SpawnFn;
  readonly now?: () => number;
};

/** A refreshed access token must be good for at least this long to pass. */
const MIN_ACCESS_VALIDITY_MS = 5 * 60_000;
const PREFLIGHT_TIMEOUT_MS = 90_000;
const URL_WAIT_MS = 30_000;
const EXCHANGE_TIMEOUT_MS = 60_000;
export const LOGIN_TTL_MS = 10 * 60_000;
const OUTPUT_CAP = 64 * 1024;

/** Env for an isolated `claude` child. Deliberately NOT derived from process.env. */
export function buildIsolatedEnv(home: string, cfgDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    CLAUDE_CONFIG_DIR: cfgDir,
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    // Never try to open a browser on the server.
    BROWSER: "/bin/true",
    DISABLE_AUTOUPDATER: "1",
    // The `-p` preflight is a real session; never auto-load claude.ai connectors in it.
    ...CLAUDEAI_CONNECTORS_DISABLED_ENV,
  };
}

async function makeIsolatedDir(
  workRoot: string,
  prefix: string,
): Promise<{ root: string; cfg: string }> {
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(workRoot, `${prefix}-`));
  const cfg = join(root, "cfg");
  await mkdir(cfg, { mode: 0o700 });
  return { root, cfg };
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `oauthAccount.emailAddress` from an isolated dir's `.claude.json` (checks both known locations). */
export async function readSignedInEmail(root: string, cfg: string): Promise<string | null> {
  for (const p of [join(cfg, ".claude.json"), join(root, ".claude.json")]) {
    const doc = await readJsonFile(p);
    const acct = doc?.["oauthAccount"] as Record<string, unknown> | undefined;
    const email = acct?.["emailAddress"];
    if (typeof email === "string" && email.length > 0) return email;
  }
  return null;
}

export function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export type PreflightResult =
  | {
      readonly ok: true;
      readonly summary: CredentialSummary;
      readonly email: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: "slot-missing" | "no-refresh-token" | "refresh-failed" | "wrong-account";
      readonly detail: string;
    };

/**
 * Prove a saved slot can still authenticate, refreshing it out-of-band.
 * `expectedEmail` guards against a slot that holds the wrong account.
 */
export async function preflightSlot(
  deps: OAuthCliDeps,
  slot: string,
  expectedEmail: string,
): Promise<PreflightResult> {
  const now = deps.now ?? Date.now;
  const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
  let slotRaw: string;
  try {
    slotRaw = await readFile(slotPath(deps.configDir, slot), "utf-8");
  } catch {
    return { ok: false, reason: "slot-missing", detail: `slot '${slot}' is not saved yet` };
  }
  if (!hasRefreshToken(slotRaw)) {
    return { ok: false, reason: "no-refresh-token", detail: `slot '${slot}' has no refresh token` };
  }

  const { root, cfg } = await makeIsolatedDir(deps.workRoot, "preflight");
  try {
    const tmpCreds = join(cfg, ".credentials.json");
    await writeFile(tmpCreds, slotRaw, { encoding: "utf-8", mode: 0o600 });
    const child = spawn(
      deps.claudeBin,
      ["-p", "Reply with the single word PONG.", "--model", "haiku"],
      { cwd: root, env: buildIsolatedEnv(root, cfg), stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin?.end();
    child.stdout?.resume();
    child.stderr?.resume();
    const code = await waitForExit(child, PREFLIGHT_TIMEOUT_MS);

    // Persist a rotated credential no matter how the call ended: once the
    // binary has refreshed, the old refresh token in the slot is dead.
    let afterRaw = slotRaw;
    try {
      afterRaw = await readFile(tmpCreds, "utf-8");
    } catch {
      /* binary removed/never wrote it — keep the original */
    }
    if (afterRaw !== slotRaw && hasRefreshToken(afterRaw)) {
      await writeSlot(deps.configDir, slot, afterRaw);
    }

    const summary = summarizeCredentialJson(afterRaw);
    const fresh =
      summary.expiresAt !== null && summary.expiresAt - now() > MIN_ACCESS_VALIDITY_MS;
    if (code !== 0 || !fresh) {
      return {
        ok: false,
        reason: "refresh-failed",
        detail:
          code === null
            ? "the check timed out"
            : code !== 0
              ? `the check call failed (exit ${code}) — the saved login has likely expired`
              : "the saved login did not refresh",
      };
    }
    const email = await readSignedInEmail(root, cfg);
    if (email !== null && !sameEmail(email, expectedEmail)) {
      return {
        ok: false,
        reason: "wrong-account",
        detail: `slot '${slot}' is signed in as ${email}, expected ${expectedEmail}`,
      };
    }
    return { ok: true, summary, email };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Login session
// ---------------------------------------------------------------------------

const ALLOWED_AUTH_HOSTS = ["claude.com", "claude.ai", "anthropic.com"];

/**
 * Pull the authorize URL out of the binary's output. The URL is printed
 * inside an OSC-8 hyperlink (`ESC ] 8 ;; URL BEL text ESC ] 8 ;; BEL`) and
 * then again as plain text, so stop at any control character.
 */
export function extractAuthorizeUrl(output: string): URL | null {
  const re = /https:\/\/[^\s\u0000-\u001f\u007f]+/g;
  for (const m of output.matchAll(re)) {
    let url: URL;
    try {
      url = new URL(m[0]);
    } catch {
      continue;
    }
    const hostOk = ALLOWED_AUTH_HOSTS.some(
      (h) => url.hostname === h || url.hostname.endsWith(`.${h}`),
    );
    if (hostOk && /\/oauth\/authorize$/.test(url.pathname) && url.searchParams.get("state")) {
      return url;
    }
  }
  return null;
}

const CODE_PART = /^[A-Za-z0-9._~-]{8,512}$/;

/**
 * Normalize a pasted authorization code to the `code#state` form the binary
 * expects. Accepts a bare code (appends the session state) and rejects a
 * code minted for a different login attempt.
 */
export function normalizeAuthCode(
  pasted: string,
  expectedState: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = pasted.trim().replace(/\s+/g, "");
  const [code, state, ...rest] = trimmed.split("#");
  if (rest.length > 0 || code === undefined || !CODE_PART.test(code)) {
    return { ok: false, error: "That doesn't look like an authorization code." };
  }
  if (state !== undefined && state !== expectedState) {
    return {
      ok: false,
      error: "That code belongs to a different login attempt — use the latest link.",
    };
  }
  return { ok: true, value: `${code}#${expectedState}` };
}

export type LoginOutcome =
  | {
      readonly status: "succeeded";
      readonly email: string;
      readonly summary: CredentialSummary;
    }
  | {
      readonly status: "failed" | "expired" | "cancelled";
      readonly detail: string;
    };

export type LoginSessionState =
  | "starting"
  | "awaiting-code"
  | "exchanging"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled";

export type SubmitResult =
  | { readonly accepted: true; readonly outcome: LoginOutcome }
  | { readonly accepted: false; readonly error: string };

/**
 * One in-flight `claude auth login`. Construct with {@link LoginSession.start}.
 * `done` settles exactly once with the outcome; the isolated dir is removed
 * when it settles.
 */
export class LoginSession {
  readonly id: string;
  readonly slot: string;
  readonly email: string;
  readonly expiresAt: number;
  readonly done: Promise<LoginOutcome>;
  private state: LoginSessionState = "starting";
  private url: URL | null = null;
  private output = "";
  private settle!: (o: LoginOutcome) => void;
  private ttlTimer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly deps: OAuthCliDeps,
    private readonly child: ChildProcess,
    private readonly dir: { root: string; cfg: string },
    slot: string,
    email: string,
  ) {
    this.id = randomBytes(9).toString("base64url");
    this.slot = slot;
    this.email = email;
    this.expiresAt = (deps.now ?? Date.now)() + LOGIN_TTL_MS;
    this.done = new Promise<LoginOutcome>((resolve) => {
      this.settle = resolve;
    });
  }

  static async start(
    deps: OAuthCliDeps,
    slot: string,
    email: string,
  ): Promise<LoginSession> {
    // Validates the slot name before anything is spawned.
    slotPath(deps.configDir, slot);
    const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
    const dir = await makeIsolatedDir(deps.workRoot, "login");
    let child: ChildProcess;
    try {
      child = spawn(
        deps.claudeBin,
        ["auth", "login", "--claudeai", "--email", email],
        { cwd: dir.root, env: buildIsolatedEnv(dir.root, dir.cfg), stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch (err) {
      await rm(dir.root, { recursive: true, force: true });
      throw err;
    }
    const session = new LoginSession(deps, child, dir, slot, email);
    await session.awaitUrl();
    return session;
  }

  get currentState(): LoginSessionState {
    return this.state;
  }

  get authorizeUrl(): string {
    if (this.url === null) throw new Error("login session has no URL");
    return this.url.toString();
  }

  get isOpen(): boolean {
    return this.state === "starting" || this.state === "awaiting-code";
  }

  private awaitUrl(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        if (this.output.length < OUTPUT_CAP) this.output += chunk.toString("utf-8");
        if (this.url === null) {
          const url = extractAuthorizeUrl(this.output);
          if (url !== null) {
            this.url = url;
            this.state = "awaiting-code";
            clearTimeout(urlTimer);
            this.ttlTimer = setTimeout(() => {
              void this.finish({ status: "expired", detail: "the login link expired" });
            }, LOGIN_TTL_MS);
            this.ttlTimer.unref?.();
            resolve();
          }
        }
      };
      this.child.stdout?.on("data", onData);
      this.child.stderr?.on("data", onData);
      const urlTimer = setTimeout(() => {
        void this.finish({ status: "failed", detail: "the login command never printed a link" });
        reject(new Error("claude auth login did not print an authorize URL"));
      }, URL_WAIT_MS);
      this.child.once("exit", (code) => {
        if (this.url === null) {
          clearTimeout(urlTimer);
          void this.finish({ status: "failed", detail: `login command exited early (${code})` });
          reject(new Error(`claude auth login exited before printing a URL (exit ${code})`));
        } else if (this.state === "awaiting-code") {
          void this.finish({ status: "failed", detail: `login command exited (${code}) before a code arrived` });
        }
      });
      this.child.once("error", (err) => {
        clearTimeout(urlTimer);
        void this.finish({ status: "failed", detail: err.message });
        reject(err);
      });
    });
  }

  /**
   * Feed a pasted code to the waiting binary. First valid code wins; later
   * submissions are refused. Resolves after the exchange + email gate.
   */
  async submitCode(pasted: string): Promise<SubmitResult> {
    if (this.state !== "awaiting-code" || this.url === null) {
      return { accepted: false, error: this.closedReason() };
    }
    const state = this.url.searchParams.get("state") ?? "";
    const norm = normalizeAuthCode(pasted, state);
    if (!norm.ok) return { accepted: false, error: norm.error };

    this.state = "exchanging";
    this.child.stdin?.write(`${norm.value}\n`);
    this.child.stdin?.end();
    const code = await waitForExit(this.child, EXCHANGE_TIMEOUT_MS);
    const outcome = await this.completeExchange(code);
    await this.finish(outcome);
    return { accepted: true, outcome };
  }

  private async completeExchange(code: number | null): Promise<LoginOutcome> {
    if (code !== 0) {
      return {
        status: "failed",
        detail:
          code === null
            ? "the code exchange timed out"
            : `the code was rejected (exit ${code}) — codes are single-use and expire quickly`,
      };
    }
    let raw: string;
    try {
      raw = await readFile(join(this.dir.cfg, ".credentials.json"), "utf-8");
    } catch {
      return { status: "failed", detail: "login finished but wrote no credential" };
    }
    if (!hasRefreshToken(raw)) {
      return { status: "failed", detail: "login finished without a refresh token" };
    }
    const email = await readSignedInEmail(this.dir.root, this.dir.cfg);
    if (email === null) {
      return { status: "failed", detail: "couldn't confirm which account signed in — nothing saved" };
    }
    if (!sameEmail(email, this.email)) {
      return {
        status: "failed",
        detail: `signed in as ${email}, not ${this.email} — nothing saved`,
      };
    }
    await writeSlot(this.deps.configDir, this.slot, raw);
    return { status: "succeeded", email, summary: summarizeCredentialJson(raw) };
  }

  cancel(detail = "cancelled"): void {
    void this.finish({ status: "cancelled", detail });
  }

  private closedReason(): string {
    switch (this.state) {
      case "exchanging":
        return "A code is already being checked.";
      case "succeeded":
        return "This login already finished.";
      case "expired":
        return "This login link expired — start a new one.";
      case "cancelled":
        return "This login was cancelled.";
      default:
        return "This login is no longer accepting codes.";
    }
  }

  private finishing = false;
  private async finish(outcome: LoginOutcome): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    this.state = outcome.status;
    if (this.ttlTimer !== null) clearTimeout(this.ttlTimer);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
    }
    await rm(this.dir.root, { recursive: true, force: true }).catch(() => {});
    this.settle(outcome);
  }
}

/** Remove isolated dirs orphaned by a daemon restart mid-check/login. */
export async function cleanupWorkRoot(workRoot: string): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  let names: string[];
  try {
    names = await readdir(workRoot);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((n) => n.startsWith("preflight-") || n.startsWith("login-"))
      .map((n) => rm(join(workRoot, n), { recursive: true, force: true })),
  );
}
