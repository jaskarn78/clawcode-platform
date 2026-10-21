/**
 * Phase 999.10 — SEC-01 callsites assertion. Greps src/ for stray
 * `op read` execSync/spawn calls outside the three allowed homes:
 *   - src/config/loader.ts (defaultOpRefResolver — kept as back-compat;
 *     production daemon path now routes through SecretsResolver, but the
 *     sync export remains for tests + migration tooling)
 *   - src/manager/op-env-resolver.ts (defaultOpReadShellOut — the canonical
 *     `child_process.spawn("op", ["read", ...])` shell-out, injected into
 *     SecretsResolver as opRead)
 *   - src/manager/secrets-resolver.ts (the singleton — currently no
 *     direct shell-out; allow-listed in case a future refactor inlines one)
 *
 * Wave 2 plan 02 turns this green by rewriting the prior daemon.ts:3522
 * inline `execSync('op read ...')` block to route through
 * `await secretsResolver.resolve(raw)`. Any future drift that re-introduces
 * a stray shell-out fails this test loudly.
 *
 * Walker uses node:fs/promises.readdir recursive instead of `glob` to keep
 * the test dependency-free (CLAUDE.md rule: no new heavyweight deps for
 * what fs primitives can express).
 */

import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_FILES = new Set([
  "src/config/loader.ts",
  "src/manager/op-env-resolver.ts",
  "src/manager/secrets-resolver.ts",
]);

/**
 * Forbidden patterns — any direct shell-out to the 1Password CLI's `read`
 * subcommand. Catches both execSync and spawn variants in single + double +
 * backtick quotes, with optional whitespace.
 */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /execSync\(\s*`op\s+read/,
  /execSync\(\s*"op\s+read/,
  /execSync\(\s*'op\s+read/,
  /spawn\(\s*"op"\s*,\s*\[\s*"read"/,
  /spawn\(\s*'op'\s*,\s*\[\s*'read'/,
];

/** Repo root resolved relative to this test file (src/manager/__tests__). */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

async function walkSrcTs(dir: string, out: string[] = []): Promise<string[]> {
  const ents = await readdir(dir, { withFileTypes: true });
  for (const ent of ents) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // Skip test directories + node_modules (latter not present under src/
      // but defense-in-depth in case someone adds one).
      if (ent.name === "__tests__" || ent.name === "node_modules") continue;
      await walkSrcTs(full, out);
    } else if (ent.isFile() && full.endsWith(".ts") && !full.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("SEC-01 callsites — no stray op-read shell-outs", () => {
  it("CALL-01: only allowed files contain `op read` shell-out", async () => {
    const srcDir = path.join(REPO_ROOT, "src");
    const files = await walkSrcTs(srcDir);

    const violations: { file: string; line: number; text: string }[] = [];
    for (const fullPath of files) {
      const relPath = path.relative(REPO_ROOT, fullPath).replaceAll("\\", "/");
      if (ALLOWED_FILES.has(relPath)) continue;
      const text = await readFile(fullPath, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const re of FORBIDDEN_PATTERNS) {
          if (re.test(lines[i]!)) {
            violations.push({ file: relPath, line: i + 1, text: lines[i]!.trim() });
          }
        }
      }
    }

    expect(
      violations,
      `Stray op-read shell-out found:\n${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });
});
