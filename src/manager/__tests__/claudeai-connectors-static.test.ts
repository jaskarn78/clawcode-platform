/**
 * Static-grep sentinel: every production path that spawns a Claude Code
 * session builds its env through a helper that disables claude.ai account
 * connectors (ENABLE_CLAUDEAI_MCP_SERVERS=false).
 *
 * Rule: a production file that calls `.query({ … prompt … })` (an SDK session)
 * or resolves the Claude binary (`resolveClaudeBinaryOverride()` /
 * `CLAWCODE_CLAUDE_BIN`) must use `buildAnthropicSafeEnv` / `buildCleanEnv` /
 * `buildSpawnEnv`, or spread `CLAUDEAI_CONNECTORS_DISABLED_ENV` itself — or be
 * listed in EXEMPT with the reason it never starts a session with its own env.
 * The comment stripper is not string-aware; it can only blank code, so a
 * mis-strip flags a file (fails closed), never passes one.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const EXEMPT: Readonly<Record<string, string>> = {
  "src/manager/persistent-session-handle.ts":
    "spreads the caller's pre-built sdkOptions (env from buildCleanEnv / buildAnthropicSafeEnv)",
  "src/cli/commands/check-cli-version.ts": "runs `claude --version` only — no session",
  "src/dashboard/plugin-cli.ts": "runs `claude plugin …` management commands only — no session",
  "src/bridge/anthropic-interceptor.ts": "mentions the pin in version constants; spawns nothing",
  "src/bridge/event-logging-distributions.ts": "mentions the pin in comments/data; spawns nothing",
  "src/manager/sdk-types.ts": "type declarations only",
  "src/manager/spawn-env.ts": "defines the env builder itself",
  "src/manager/daemon.ts":
    "resolves the binary only to hand it to AccountService, whose oauth-cli " +
    "buildIsolatedEnv carries the disable (pinned by the unit test)",
  "src/shared/claude-binary.ts":
    "999.169 binary resolver: names the override var and runs `claude --version` only — no session",
  "src/manager/cli-version-guard.ts": "compares probed versions; names the override var in messages only",
  "src/manager/version-watch.ts": "reports versions; names the override var in messages only",
};

/** Sites this scan must keep finding — proves the patterns have not rotted. */
const KNOWN_SESSION_SITES = [
  "src/manager/session-adapter.ts",
  "src/openai/driver.ts",
  "src/openai/template-driver.ts",
  "src/llm-runtime/backends/claude-code-interactive.ts",
  // 999.169 — the SDK query chokepoint; forces the disable when env lacks the key.
  "src/llm-runtime/backends/anthropic-agent-sdk.ts",
] as const;

const SDK_QUERY_CALL = /\.query\(\s*\{[\s\S]{0,600}?\bprompt\s*:/;
const BINARY_RESOLUTION = /resolveClaudeBinaryOverride\s*\(|CLAWCODE_CLAUDE_BIN/;
// The 999.169 chokepoint (withPinnedClaudeBinary) sets the key to "false" when a
// caller's env lacks it; that literal assignment counts as a safe env too.
const SAFE_ENV =
  /buildAnthropicSafeEnv\s*\(|buildCleanEnv\s*\(|buildSpawnEnv\s*\(|CLAUDEAI_CONNECTORS_DISABLED_ENV|\[CLAUDEAI_CONNECTORS_ENV\]\s*:\s*"false"/;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

function productionSources(): readonly string[] {
  return execSync(
    `git ls-files 'src/**/*.ts' | grep -v '__tests__/' | grep -v '\\.test\\.ts$'`,
    { encoding: "utf-8", cwd: process.cwd() },
  )
    .trim()
    .split("\n")
    .filter((p) => p.length > 0);
}

function scan(): { sessionSites: string[]; unsafe: string[] } {
  const sessionSites: string[] = [];
  const unsafe: string[] = [];
  for (const file of productionSources()) {
    const raw = readFileSync(file, "utf-8");
    const code = stripComments(raw);
    if (!SDK_QUERY_CALL.test(code) && !BINARY_RESOLUTION.test(raw)) continue;
    sessionSites.push(file);
    if (!(file in EXEMPT) && !SAFE_ENV.test(code)) unsafe.push(file);
  }
  return { sessionSites, unsafe };
}

describe("every Claude session spawn disables claude.ai connectors", () => {
  const { sessionSites, unsafe } = scan();

  it("no session spawn path builds its env without the connector disable", () => {
    if (unsafe.length > 0) {
      throw new Error(
        `Claude session spawn paths whose env skips the connector disable:\n` +
          unsafe.map((f) => `  - ${f}`).join("\n") +
          `\n\nBuild the env with buildAnthropicSafeEnv()/buildCleanEnv(), spread ` +
          `CLAUDEAI_CONNECTORS_DISABLED_ENV, or add the file to EXEMPT with a reason.`,
      );
    }
  });

  it("the scan still finds every known session spawn site", () => {
    for (const site of KNOWN_SESSION_SITES) expect(sessionSites).toContain(site);
  });

  it("only the agent-session env path can ENABLE connectors (entitlement is not a general knob)", () => {
    // The enable constant is used only by the env builder; only buildCleanEnv
    // (entitled agent SDK sessions) passes `claudeAiConnectors` into it.
    const enableUsers: string[] = [];
    const entitlementPassers: string[] = [];
    for (const file of productionSources()) {
      const code = stripComments(readFileSync(file, "utf-8"));
      if (file !== "src/shared/claudeai-connectors.ts" && /CLAUDEAI_CONNECTORS_ENABLED_ENV/.test(code)) {
        enableUsers.push(file);
      }
      if (/buildAnthropicSafeEnv\s*\([\s\S]{0,800}?claudeAiConnectors/.test(code) && file !== "src/manager/spawn-env.ts") {
        entitlementPassers.push(file);
      }
    }
    expect(enableUsers).toEqual(["src/manager/spawn-env.ts"]);
    expect(entitlementPassers).toEqual(["src/manager/session-adapter.ts"]);
  });

  it("every EXEMPT entry still exists (no stale exemptions)", () => {
    const all = new Set(productionSources());
    for (const f of Object.keys(EXEMPT)) expect(all.has(f)).toBe(true);
  });
});
