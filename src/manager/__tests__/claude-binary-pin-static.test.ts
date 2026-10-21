/**
 * Static-grep sentinel: the fleet Claude Code binary is decided in ONE place and
 * applied in ONE place (Phase 999.169 — pinned by construction).
 *
 * History: an `sdk.query` whose options omitted `pathToClaudeCodeExecutable`
 * silently spawned a different binary. Agent sessions lost the pin in the
 * 2026-06-01 union merge; the OpenAI endpoint never had it and returned 500 on
 * every completion until 2026-09-23. Both times a per-call-site spread was
 * forgotten. Those spreads are gone: `loadAnthropicAgentSdkModule()` wraps
 * `query` (`withPinnedClaudeBinary`) so every spawn is pinned whether or not the
 * caller remembers, and `src/shared/claude-binary.ts` is the only resolver.
 *
 * Rules enforced here:
 *   1. Only the chokepoint sets `pathToClaudeCodeExecutable` — a hand-rolled pin
 *      elsewhere would bypass the resolver (and its lockstep guarantee).
 *   2. Only the leaf resolver reads `CLAWCODE_CLAUDE_BIN`.
 *   3. The chokepoint really does wrap the SDK it imports.
 *   4. The scan still sees the known spawn sites (it has not gone blind).
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CHOKEPOINT = "src/llm-runtime/backends/anthropic-agent-sdk.ts";
const RESOLVER = "src/shared/claude-binary.ts";

const KNOWN_SPAWN_SITES = [
  "src/manager/session-adapter.ts",
  "src/manager/persistent-session-handle.ts",
  "src/openai/driver.ts",
  "src/openai/template-driver.ts",
] as const;

const SDK_QUERY_CALL = /\.query\(\s*\{[\s\S]{0,600}?\bprompt\s*:/;
// `key: value` OR object shorthand (`{ …, pathToClaudeCodeExecutable }`) — shorthand must not evade the sentinel.
const PIN_OPTION_KEY = /\bpathToClaudeCodeExecutable\s*[:,}]/;
const OVERRIDE_ENV_READ = /process\.env\.CLAWCODE_CLAUDE_BIN|process\.env\[\s*["']CLAWCODE_CLAUDE_BIN["']\s*\]/;

/** Strip comments (not string-aware) so a comment mention never counts. */
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

const code = new Map(productionSources().map((f) => [f, stripComments(readFileSync(f, "utf-8"))] as const));

describe("the fleet Claude binary is pinned by construction", () => {
  it("only the SDK chokepoint sets pathToClaudeCodeExecutable", () => {
    const offenders = [...code].filter(([f, c]) => f !== CHOKEPOINT && PIN_OPTION_KEY.test(c)).map(([f]) => f);
    if (offenders.length > 0) {
      throw new Error(
        `Hand-rolled Claude binary pins (bypass the 999.169 resolver):\n` +
          offenders.map((f) => `  - ${f}`).join("\n") +
          `\n\nDelete them: every query through loadAnthropicAgentSdkModule() is ` +
          `already pinned by withPinnedClaudeBinary.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it("only the leaf resolver reads CLAWCODE_CLAUDE_BIN", () => {
    const offenders = [...code].filter(([f, c]) => f !== RESOLVER && OVERRIDE_ENV_READ.test(c)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it("the chokepoint wraps the SDK module it imports", () => {
    const c = code.get(CHOKEPOINT) ?? "";
    expect(c).toMatch(/withPinnedClaudeBinary\(\s*sdk\s+as\s+unknown\s+as\s+LlmRuntimeSdkModule\s*\)/);
    expect(c).toMatch(PIN_OPTION_KEY);
  });

  it("still finds every known spawn site (the scan has not gone blind)", () => {
    const sites = [...code].filter(([, c]) => SDK_QUERY_CALL.test(c)).map(([f]) => f);
    for (const site of KNOWN_SPAWN_SITES) expect(sites).toContain(site);
  });
});
