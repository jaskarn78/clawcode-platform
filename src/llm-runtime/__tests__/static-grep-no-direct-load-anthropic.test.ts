/**
 * Phase 138 Plan 04 T-04 — static-grep CI sentinel.
 *
 * Asserts that `loadAnthropicAgentSdkModule` — the free-function
 * chokepoint that loads the Anthropic Agent SDK — has ZERO callers in
 * production code (`src/**\/*.ts`, excluding `__tests__/`) outside the
 * `src/llm-runtime/` seam package.
 *
 * **The bug class this guards.** Before Plan 138-04, the per-turn
 * dispatch path bypassed the `LlmRuntimeService` factory entirely:
 * `session-adapter.ts`'s `loadSdk()` and the two `daemon.ts`
 * compaction-fork sites + `endpoint-bootstrap.ts` all called the free
 * `loadAnthropicAgentSdkModule()` directly. The daemon even did
 * `void llmRuntimeRegistry;` — explicitly discarding the per-agent
 * registry. Result: Phase 137's `codex-cli` backend was unreachable
 * in production and 138-05's failover override would land on a
 * dispatch path nothing consumed. Plan 138-04 migrated every caller
 * to resolve through the per-agent `LlmRuntimeService`; this sentinel
 * fails at PR time if a direct-call bypass is re-introduced — exactly
 * the `feedback_silent_path_bifurcation` instance class.
 *
 * The free function STAYS exported from `src/llm-runtime/index.ts` —
 * it is the default-resolver backing INSIDE the seam
 * (`src/llm-runtime/default-resolver.ts`). Only callers OUTSIDE
 * `src/llm-runtime/` are offenders.
 *
 * Mirrors the proven Phase 136 sentinel
 * (`static-grep-no-direct-sdk.test.ts`) — same comment-stripping,
 * same `git ls-files` walk — and the dream-cron-wiring sentinel
 * (`src/manager/__tests__/dream-cron-wiring.test.ts`).
 *
 * See:
 *   - `.planning/phases/138-.../138-04-PLAN.md` T-04 / T-08
 *   - `src/llm-runtime/__tests__/static-grep-no-direct-sdk.test.ts`
 *     — the Phase 136 model (the @anthropic-ai/... import variant)
 */

import { execSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const IDENTIFIER = "loadAnthropicAgentSdkModule";
const SEAM_DIR_PREFIX = "src/llm-runtime/";
const SDK_BACKEND_FILE = "src/llm-runtime/backends/anthropic-agent-sdk.ts";

/**
 * Strip JS/TS line and block comments. Block comments become
 * line-count-preserving whitespace so JSDoc mentions of the
 * identifier (e.g. the explanatory comments at `daemon.ts` /
 * `index.ts`) are NOT counted as offenders.
 */
function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m
      .split("")
      .map((c) => (c === "\n" ? "\n" : " "))
      .join(""),
  );
  out = out.replace(/\/\/[^\n]*/g, "");
  return out;
}

const fileCache = new Map<string, string>();
function readFileSyncCached(path: string): string {
  const hit = fileCache.get(path);
  if (hit !== undefined) return hit;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const content = (require("node:fs") as typeof import("node:fs")).readFileSync(
    path,
    "utf-8",
  );
  fileCache.set(path, content);
  return content;
}

/**
 * Every production file outside `src/llm-runtime/` whose
 * comment-stripped content references `loadAnthropicAgentSdkModule`
 * (import binding OR call) is an offender.
 */
function findOffenders(): readonly string[] {
  const listing = execSync(
    `git ls-files 'src/**/*.ts' | grep -v '__tests__/' | grep -v '\\.test\\.ts$'`,
    { encoding: "utf-8", cwd: process.cwd() },
  )
    .trim()
    .split("\n")
    .filter((p) => p.length > 0);

  const offenders: string[] = [];
  for (const file of listing) {
    // Files inside the seam package own this identifier — the
    // definition, the barrel re-export, and the default-resolver
    // backing all live here.
    if (file.startsWith(SEAM_DIR_PREFIX)) continue;
    const raw = readFileSyncCached(file);
    // Fast path: no mention anywhere → skip.
    if (!raw.includes(IDENTIFIER)) continue;
    // JSDoc / line-comment mentions are allowed — strip before scan.
    const content = stripComments(raw);
    if (content.includes(IDENTIFIER)) {
      offenders.push(file);
    }
  }
  return offenders;
}

describe("Phase 138-04 — no direct loadAnthropicAgentSdkModule callers outside the seam", () => {
  it("guards against per-turn-dispatch bypass — every caller routes through LlmRuntimeService", () => {
    const offenders = findOffenders();
    if (offenders.length > 0) {
      const formatted = offenders.map((p) => `  - ${p}`).join("\n");
      throw new Error(
        `Phase 138-04 seam bypass detected — the following production\n` +
          `files reference \`loadAnthropicAgentSdkModule\` directly instead\n` +
          `of resolving through the per-agent \`LlmRuntimeService\`:\n` +
          `${formatted}\n\n` +
          `Fix: accept a per-agent resolver via DI and call\n` +
          `\`getLlmRuntime(agentName).loadSdkModule()\`, or — for a\n` +
          `non-per-agent path — call \`createLlmRuntimeService(config,\n` +
          `deps).loadSdkModule()\`. The free function must stay INSIDE\n` +
          `\`src/llm-runtime/\` (it backs the seam-side default resolver).\n` +
          `Bypassing the factory makes the codex-cli backend + 138-05\n` +
          `failover unreachable — the bug Plan 138-04 fixed.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it("the seam backend still defines loadAnthropicAgentSdkModule", () => {
    // Sanity check — the sentinel above would falsely pass if someone
    // deleted the free function entirely during a refactor. Pin that
    // the seam still owns the definition.
    const content = readFileSyncCached(SDK_BACKEND_FILE);
    expect(content).toMatch(
      /export async function loadAnthropicAgentSdkModule/,
    );
  });
});
