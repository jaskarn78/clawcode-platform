/**
 * dashboard-rework — shell-out to the `claude plugin` CLI for the marketplace
 * install / add surfaces. Uses node's execFile with ARRAY args (no shell), plus
 * strict input validation as defense-in-depth, so an untrusted ref/source can
 * never be interpolated into a command line. Binary is the fleet binary
 * (src/shared/claude-binary.ts), falling back to `claude` on PATH. All actions are
 * admin-token-gated at the route layer.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claudeBinaryPath } from "../shared/claude-binary.js";

const pExecFile = promisify(execFile);

// `<plugin>@<marketplace>` — both segments lowercase-ish slug charset.
const REF_RE = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+$/;
// marketplace name (for remove) — single slug.
const MKT_NAME_RE = /^[a-zA-Z0-9._-]+$/;
// marketplace source — "owner/repo" GitHub shorthand OR an https git URL.
const SOURCE_REPO_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const SOURCE_URL_RE = /^https:\/\/[a-zA-Z0-9._~:/?#@!$&'()*+,;=%-]+$/;

export function isValidPluginRef(ref: string): boolean {
  return REF_RE.test(ref);
}
export function isValidMarketplaceName(name: string): boolean {
  return MKT_NAME_RE.test(name);
}
export function isValidMarketplaceSource(src: string): boolean {
  return SOURCE_REPO_RE.test(src) || SOURCE_URL_RE.test(src);
}

/** The fleet binary (999.169 resolver); `claude` on PATH only if it cannot resolve. */
function claudeBin(): string {
  try {
    return claudeBinaryPath();
  } catch {
    return "claude";
  }
}

export type PluginCliResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

async function run(args: readonly string[], timeoutMs = 120_000): Promise<PluginCliResult> {
  try {
    const { stdout, stderr } = await pExecFile(claudeBin(), [...args], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env },
    });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: string };
    return {
      ok: false,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        (typeof e.stderr === "string" && e.stderr) || e.message || "plugin command failed",
    };
  }
}

export function installPlugin(ref: string): Promise<PluginCliResult> {
  if (!isValidPluginRef(ref)) {
    return Promise.resolve({ ok: false, stdout: "", stderr: `invalid plugin ref: ${ref}` });
  }
  return run(["plugin", "install", ref, "--scope", "user"]);
}
export function uninstallPlugin(ref: string): Promise<PluginCliResult> {
  if (!isValidPluginRef(ref)) {
    return Promise.resolve({ ok: false, stdout: "", stderr: `invalid plugin ref: ${ref}` });
  }
  return run(["plugin", "uninstall", ref]);
}
export function addMarketplace(source: string): Promise<PluginCliResult> {
  if (!isValidMarketplaceSource(source)) {
    return Promise.resolve({ ok: false, stdout: "", stderr: `invalid marketplace source: ${source}` });
  }
  return run(["plugin", "marketplace", "add", source, "--scope", "user"]);
}
export function removeMarketplace(name: string): Promise<PluginCliResult> {
  if (!isValidMarketplaceName(name)) {
    return Promise.resolve({ ok: false, stdout: "", stderr: `invalid marketplace name: ${name}` });
  }
  return run(["plugin", "marketplace", "remove", name]);
}
