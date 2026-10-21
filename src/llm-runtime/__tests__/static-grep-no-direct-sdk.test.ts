/**
 * Phase 136 T-06 — static-grep CI sentinel.
 *
 * Asserts that NO production file under `src/` outside
 * `src/llm-runtime/backends/anthropic-agent-sdk.ts` imports
 * `@anthropic-ai/claude-agent-sdk` at runtime. Type-only imports
 * (`import type { SDKRateLimitInfo } from ...`) are allowed: they
 * compile to nothing and are not a seam bypass.
 *
 * If this test fails, someone added an `await import(...)` or a
 * `import {X} from "@anthropic-ai/claude-agent-sdk"` outside the
 * permitted backend file. The fix is to route through
 * `src/llm-runtime/` instead.
 *
 * See:
 *   - `.planning/phases/136-llm-runtime-multi-backend/136-CONTEXT.md`
 *     §`<decisions>` D-05a — static-grep CI test
 *   - `src/manager/resolve-output-dir.ts:6` — Phase 96 precedent
 *     for in-test static-grep regression (same shape).
 */

import { execSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const ALLOWED_FILE = "src/llm-runtime/backends/anthropic-agent-sdk.ts";
const SEAM_DIR_PREFIX = "src/llm-runtime/";

/**
 * Multi-line-aware static-grep.
 *
 * Plain-text grep misses two real cases:
 *   1. Multi-line `import type { ... } from "@anthropic-ai/..."`
 *      where the package name appears on a different line from
 *      `import type` (e.g., `src/manager/detached-spawn.ts:42-45`).
 *      We don't want to flag those — they're type-only.
 *   2. String literals containing `@anthropic-ai/claude-agent-sdk`
 *      in error messages, JSDoc, or comments. Those are not seam
 *      bypass.
 *
 * Strategy: for every `.ts` file under `src/` (excluding
 * `__tests__`), parse the file content and look for a RUNTIME
 * `import` or `await import(...)` statement that mentions the
 * package. Multi-line imports are handled by joining all `import`
 * lines into one logical statement per import.
 */
function findOffenders(): readonly string[] {
  // List every TypeScript file under src/ excluding test files.
  // Use git ls-files to avoid scanning untracked junk.
  const listing = execSync(
    `git ls-files 'src/**/*.ts' | grep -v '__tests__/' | grep -v '\\.test\\.ts$'`,
    { encoding: "utf-8", cwd: process.cwd() },
  )
    .trim()
    .split("\n")
    .filter((p) => p.length > 0);

  const offenders: string[] = [];
  for (const file of listing) {
    // Files inside the seam package are allowed — they ARE the
    // chokepoint. The package-level allowance covers
    // llm-runtime-service.ts (re-imports backend class), types.ts
    // (re-exports SDK types), index.ts (barrel), and the backend
    // file itself.
    if (file.startsWith(SEAM_DIR_PREFIX)) continue;
    const rawContent = readFileSyncCached(file);
    // Fast path: no mention of the package anywhere → skip.
    if (!rawContent.includes("@anthropic-ai/claude-agent-sdk")) continue;

    // Strip JS/TS comments before scanning. We don't try to be
    // string-aware (string literals containing comment-like
    // sequences are vanishingly rare in this codebase, and a string
    // literal containing `@anthropic-ai/claude-agent-sdk` AND
    // `import ...` syntax is essentially impossible). Stripping
    // comments eliminates ~all false positives:
    //   - block comments `/** ... @anthropic-ai/... */` (JSDoc)
    //   - line comments `// @anthropic-ai/...`
    const content = stripComments(rawContent);
    if (!content.includes("@anthropic-ai/claude-agent-sdk")) continue;

    // 1. Match `await import("@anthropic-ai/claude-agent-sdk")` —
    //    runtime dynamic import. ALWAYS an offender.
    if (
      /await\s+import\s*\(\s*['"]@anthropic-ai\/claude-agent-sdk['"]/.test(
        content,
      )
    ) {
      offenders.push(file);
      continue;
    }
    // 2. Multi-line `import` statements. The regex `^import [\s\S]+?
    //    from "@anthropic-ai/..."` is GREEDY-ENOUGH to gobble an
    //    earlier `import` line on a different statement (e.g.,
    //    `import { spawn } from "node:child_process"` followed by
    //    `import type { ... } from "@anthropic-ai/..."`). Non-greedy
    //    matching across newlines isn't enough — we need to find the
    //    nearest preceding `import` keyword for each `from "..."`
    //    site.
    //
    //    Strategy: locate every `from "@anthropic-ai/..."` and walk
    //    BACKWARDS line-by-line to find the line that begins with
    //    `import` (type-only or value). Inspect that opening line to
    //    classify.
    const lines = content.split("\n");
    const fromRe = /from\s*['"]@anthropic-ai\/claude-agent-sdk['"]/;
    let isValueImport = false;
    for (let i = 0; i < lines.length; i++) {
      if (!fromRe.test(lines[i] ?? "")) continue;
      // Walk back to find the `import` keyword that owns this `from`.
      let j = i;
      while (j >= 0) {
        const line = lines[j] ?? "";
        if (/^\s*import\b/.test(line)) {
          // Found the owning `import` line. Classify.
          if (/^\s*import\s+type\b/.test(line)) {
            // type-only — allowed.
          } else {
            isValueImport = true;
          }
          break;
        }
        j--;
      }
      if (isValueImport) break;
    }
    if (isValueImport) {
      offenders.push(file);
    }
  }
  return offenders;
}

/**
 * Strip JS/TS line and block comments. Naive (not string-aware)
 * but adequate for this test's purpose. Preserves line structure
 * (block comments become whitespace) so line-anchored regex still
 * works on the stripped content.
 */
function stripComments(src: string): string {
  // Block comments: replace with equivalent newlines so line numbers
  // and line anchors stay aligned.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.split("").map((c) => (c === "\n" ? "\n" : " ")).join(""),
  );
  // Line comments: trim from `//` to end-of-line.
  out = out.replace(/\/\/[^\n]*/g, "");
  return out;
}

const fileCache = new Map<string, string>();
function readFileSyncCached(path: string): string {
  const hit = fileCache.get(path);
  if (hit !== undefined) return hit;
  // Inline fs import — we read tiny files (max ~2500 LOC) and the
  // test is once-per-run, so the sync read is fine.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const content = (require("node:fs") as typeof import("node:fs"))
    .readFileSync(path, "utf-8");
  fileCache.set(path, content);
  return content;
}

describe("Phase 136 — no direct @anthropic-ai/claude-agent-sdk imports outside the backend", () => {
  it("guards against seam bypass — every production file routes through src/llm-runtime/", () => {
    const offenders = findOffenders();
    if (offenders.length > 0) {
      const formatted = offenders.map((p) => `  - ${p}`).join("\n");
      throw new Error(
        `Phase 136 seam bypass detected — the following files import\n` +
          `\`@anthropic-ai/claude-agent-sdk\` directly at runtime instead of\n` +
          `routing through \`src/llm-runtime/\`:\n${formatted}\n\n` +
          `Fix: replace \`await import("@anthropic-ai/claude-agent-sdk")\`\n` +
          `with \`await import("../llm-runtime/index.js").then(m => m.loadAnthropicAgentSdkModule())\`\n` +
          `or accept an \`LlmRuntimeService\` via DI and call \`service.loadSdkModule()\`.\n` +
          `See \`src/llm-runtime/backends/anthropic-agent-sdk.ts\` for the\n` +
          `single permitted import site.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it("the allowed file actually imports the SDK", () => {
    // Sanity check — the static-grep test would falsely pass if
    // someone removed the SDK import entirely from the backend file
    // (e.g., during a refactor). Pin the contract.
    const content = readFileSyncCached(ALLOWED_FILE);
    expect(content).toMatch(/await\s+import\s*\(\s*['"]@anthropic-ai\/claude-agent-sdk['"]/);
  });
});
