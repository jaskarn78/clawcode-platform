import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LoginSession,
  buildIsolatedEnv,
  extractAuthorizeUrl,
  normalizeAuthCode,
  preflightSlot,
  type OAuthCliDeps,
} from "../oauth-cli.js";
import { slotPath } from "../credential-slots.js";

const STATE = "stateABC123xyz";
const AUTH_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code" +
  `&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=cc&state=${STATE}&login_hint=admin%40example.com`;

/**
 * Fake `claude` binary. Behaviour is steered by `<bin dir>/mode.json`
 * because the real spawn passes an isolated env (no custom vars survive).
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const mode = JSON.parse(fs.readFileSync(path.join(__dirname, "mode.json"), "utf-8"));
const cfg = process.env.CLAUDE_CONFIG_DIR;
const args = process.argv.slice(2);
const writeCreds = (rt) => fs.writeFileSync(path.join(cfg, ".credentials.json"), JSON.stringify({
  claudeAiOauth: { accessToken: "at", refreshToken: rt, expiresAt: Date.now() + 8 * 3600e3,
    subscriptionType: "max", rateLimitTier: "default_claude_max_5x" } }));
const writeEmail = (email) => fs.writeFileSync(path.join(cfg, ".claude.json"),
  JSON.stringify({ oauthAccount: { emailAddress: email } }));
if (args[0] === "-p") {
  if (process.env.ANTHROPIC_API_KEY) { console.error("leaked api key"); process.exit(9); }
  if (mode.preflight === "ok") { writeCreds("rotated-rt"); writeEmail(mode.email); process.stdout.write("PONG"); process.exit(0); }
  if (mode.preflight === "rotate-then-fail") { writeCreds("rotated-rt"); process.exit(1); }
  process.exit(1);
}
if (args[0] === "auth" && args[1] === "login") {
  const url = ${JSON.stringify(AUTH_URL)};
  process.stdout.write("Opening browser to sign in…\\nIf the browser didn't open, visit: \\u001b]8;;" + url + "\\u0007" + url + "\\u001b]8;;\\u0007\\nPaste code here if prompted > ");
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    if (!buf.includes("\\n")) return;
    const code = buf.trim();
    if (code !== "goodcode123#${STATE}") { console.error("bad code"); process.exit(1); }
    writeCreds("fresh-login-rt"); writeEmail(mode.email);
    process.stdout.write("Login successful.\\n");
    process.exit(0);
  });
  return;
}
process.exit(2);
`;

let root: string;
let deps: OAuthCliDeps;

async function setMode(mode: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, "bin", "mode.json"), JSON.stringify(mode));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "oauth-cli-"));
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "config"));
  const bin = join(root, "bin", "claude.cjs");
  await writeFile(bin, FAKE_CLAUDE);
  await chmod(bin, 0o755);
  deps = { claudeBin: bin, configDir: join(root, "config"), workRoot: join(root, "work") };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const slotCred = (rt: string): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: rt, expiresAt: Date.now() - 1000 } });

describe("extractAuthorizeUrl", () => {
  it("pulls the URL out of an OSC-8 hyperlink and validates the host", () => {
    const out = `visit: \u001b]8;;${AUTH_URL}\u0007${AUTH_URL}\u001b]8;;\u0007\nPaste code >`;
    const url = extractAuthorizeUrl(out);
    expect(url?.searchParams.get("state")).toBe(STATE);
  });

  it("ignores lookalike hosts and non-authorize links", () => {
    expect(extractAuthorizeUrl("https://claude.com.evil.io/oauth/authorize?state=x")).toBeNull();
    expect(extractAuthorizeUrl("https://claude.com/docs?state=x")).toBeNull();
  });
});

describe("normalizeAuthCode", () => {
  it("accepts code#state for this session", () => {
    expect(normalizeAuthCode(` goodcode123#${STATE}\n`, STATE)).toEqual({ ok: true, value: `goodcode123#${STATE}` });
  });
  it("appends the session state to a bare code", () => {
    expect(normalizeAuthCode("goodcode123", STATE)).toEqual({ ok: true, value: `goodcode123#${STATE}` });
  });
  it("rejects a code from another login attempt", () => {
    expect(normalizeAuthCode("goodcode123#otherstate", STATE).ok).toBe(false);
  });
  it("rejects shell-ish garbage", () => {
    expect(normalizeAuthCode("abc; rm -rf /", STATE).ok).toBe(false);
    expect(normalizeAuthCode("a#b#c", STATE).ok).toBe(false);
  });
});

describe("buildIsolatedEnv", () => {
  it("never carries API keys or the daemon's CLAUDE_* env", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test.invalid";
    try {
      const env = buildIsolatedEnv("/h", "/h/cfg");
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBe("/h/cfg");
      expect(env.HOME).toBe("/h");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe("preflightSlot", () => {
  it("passes a live slot and persists the rotated credential back to the slot", async () => {
    await setMode({ preflight: "ok", email: "admin@example.com" });
    await writeFile(slotPath(deps.configDir, "admin"), slotCred("old-rt"));
    const r = await preflightSlot(deps, "admin", "admin@example.com");
    expect(r.ok).toBe(true);
    const saved = JSON.parse(await readFile(slotPath(deps.configDir, "admin"), "utf-8"));
    expect(saved.claudeAiOauth.refreshToken).toBe("rotated-rt");
    expect(await readdir(deps.workRoot)).toEqual([]);
  });

  it("persists a rotation even when the call itself fails", async () => {
    await setMode({ preflight: "rotate-then-fail" });
    await writeFile(slotPath(deps.configDir, "admin"), slotCred("old-rt"));
    const r = await preflightSlot(deps, "admin", "admin@example.com");
    expect(r).toMatchObject({ ok: false, reason: "refresh-failed" });
    const saved = JSON.parse(await readFile(slotPath(deps.configDir, "admin"), "utf-8"));
    expect(saved.claudeAiOauth.refreshToken).toBe("rotated-rt");
  });

  it("fails a dead slot without touching it", async () => {
    await setMode({ preflight: "fail" });
    const dead = slotCred("dead-rt");
    await writeFile(slotPath(deps.configDir, "admin"), dead);
    expect(await preflightSlot(deps, "admin", "admin@example.com")).toMatchObject({ ok: false, reason: "refresh-failed" });
    expect(await readFile(slotPath(deps.configDir, "admin"), "utf-8")).toBe(dead);
  });

  it("flags a slot that holds a different account", async () => {
    await setMode({ preflight: "ok", email: "someone-else@example.com" });
    await writeFile(slotPath(deps.configDir, "admin"), slotCred("rt"));
    expect(await preflightSlot(deps, "admin", "admin@example.com")).toMatchObject({ ok: false, reason: "wrong-account" });
  });

  it("reports a missing slot", async () => {
    expect(await preflightSlot(deps, "admin", "a@example.com")).toMatchObject({ ok: false, reason: "slot-missing" });
  });
});

describe("LoginSession", () => {
  it("surfaces the URL, accepts the code, verifies the email, and seeds the slot", async () => {
    await setMode({ email: "Admin@Example.com" });
    const s = await LoginSession.start(deps, "admin", "admin@example.com");
    expect(s.authorizeUrl).toBe(AUTH_URL);
    const r = await s.submitCode(`goodcode123#${STATE}`);
    expect(r).toMatchObject({ accepted: true, outcome: { status: "succeeded", email: "Admin@Example.com" } });
    const saved = JSON.parse(await readFile(slotPath(deps.configDir, "admin"), "utf-8"));
    expect(saved.claudeAiOauth.refreshToken).toBe("fresh-login-rt");
    expect(await readdir(deps.workRoot)).toEqual([]);
  });

  it("refuses to save when the browser signed in as the wrong account", async () => {
    await setMode({ email: "main@example.com" });
    const s = await LoginSession.start(deps, "admin", "admin@example.com");
    const r = await s.submitCode("goodcode123");
    expect(r).toMatchObject({ accepted: true, outcome: { status: "failed" } });
    await expect(readFile(slotPath(deps.configDir, "admin"), "utf-8")).rejects.toThrow();
  });

  it("rejects a mismatched state without consuming the session, then first valid code wins", async () => {
    await setMode({ email: "admin@example.com" });
    const s = await LoginSession.start(deps, "admin", "admin@example.com");
    expect(await s.submitCode("goodcode123#wrongstate")).toMatchObject({ accepted: false });
    expect(s.isOpen).toBe(true);
    await s.submitCode("goodcode123");
    expect(await s.submitCode("goodcode123")).toMatchObject({ accepted: false });
  });

  it("a rejected code fails the session cleanly", async () => {
    await setMode({ email: "admin@example.com" });
    const s = await LoginSession.start(deps, "admin", "admin@example.com");
    const r = await s.submitCode("badcode12345");
    expect(r).toMatchObject({ accepted: true, outcome: { status: "failed" } });
  });

  it("cancel settles done and removes the isolated dir", async () => {
    await setMode({ email: "admin@example.com" });
    const s = await LoginSession.start(deps, "admin", "admin@example.com");
    s.cancel();
    expect(await s.done).toMatchObject({ status: "cancelled" });
    expect(await readdir(deps.workRoot)).toEqual([]);
  });
});
