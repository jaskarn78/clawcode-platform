/**
 * FIND-123-A.next T-09 — Static-grep sentinel pinning the deletion of
 * `discoverClaudeSubprocessPid` from production code.
 *
 * The function walked `/proc` from `daemonPid → claude` to recover the
 * SDK-managed claude CLI PID. Both former call sites (the session-manager
 * polled-registration loop and the reconciler's stale-claude rediscovery)
 * now read directly from the per-handle `ClaudePidSink` populated by the
 * structural spawn wrapper at `src/manager/detached-spawn.ts`. The walk
 * has known races (dying first-PID registered before the surviving
 * respawn settled, full-/proc scan cost at 14+ agents) and is no longer
 * the source of truth.
 *
 * If a future contributor reintroduces the function — or any equivalent
 * `ppid === daemonPid AND cmdline ~ /claude$/` walk under a new name —
 * the reconciler's sink-only contract breaks and the FIND-123-A.next
 * race window reopens.
 *
 * Strategy: regex-grep every `.ts` file under `src/` for a
 * `function discoverClaudeSubprocessPid` or `export.*discoverClaudeSubprocessPid`
 * DEFINITION (not a comment reference, not a name in a JSDoc breadcrumb).
 *
 * Pattern mirrors `static-grep-detached-spawn.test.ts` — Node-native
 * fs walk, no `glob` dependency, fails CI loudly on reintro.
 *
 * @see src/mcp/proc-scan.ts        — tombstone comment marks the removal
 * @see src/manager/detached-spawn.ts — sink source of truth
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..", "..");
const srcRoot = join(repoRoot, "src");

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      // Skip `node_modules` and any `dist` that may have leaked into src.
      if (entry === "node_modules" || entry === "dist") continue;
      walkTs(full, out);
    } else if (full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// Match a DEFINITION of the symbol, not a comment reference:
//   - `function discoverClaudeSubprocessPid(`
//   - `export ... discoverClaudeSubprocessPid` (function or const re-export)
const DEFINITION_PATTERN =
  /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+discoverClaudeSubprocessPid\s*\(/;
const EXPORT_DECLARATION_PATTERN =
  /^\s*export\s+\{[^}]*\bdiscoverClaudeSubprocessPid\b[^}]*\}/m;

describe("static-grep sentinel: discoverClaudeSubprocessPid is not defined in src/", () => {
  it("Test 1: no production file defines `function discoverClaudeSubprocessPid`", () => {
    const files = walkTs(srcRoot);
    const offenders: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trimStart();
        // Skip comments — comment references to the historical name are
        // permitted (tombstones, regex-alignment breadcrumbs).
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
        if (DEFINITION_PATTERN.test(line)) {
          offenders.push({ file, line: i + 1, text: line.trim() });
        }
      }
    }

    expect(
      offenders,
      `discoverClaudeSubprocessPid was reintroduced in:\n${offenders
        .map((o) => `  ${o.file}:${o.line} — ${o.text}`)
        .join("\n")}\n\nThe function was deleted in FIND-123-A.next T-09. Claude PIDs must come from the per-handle ClaudePidSink populated by makeDetachedSpawn — not a /proc walk. Read the sink via SessionHandle.getClaudePid?.() and route through the reconciler's deps.getClaudePid resolver.`,
    ).toEqual([]);
  });

  it("Test 2: no production file re-exports discoverClaudeSubprocessPid", () => {
    // Defense in depth — DEFINITION_PATTERN catches a fresh function
    // declaration, but a sneaky `export { discoverClaudeSubprocessPid }
    // from "..."` would slip past. Search for that shape separately.
    const files = walkTs(srcRoot);
    const offenders: Array<{ file: string }> = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (EXPORT_DECLARATION_PATTERN.test(src)) {
        offenders.push({ file });
      }
    }
    expect(
      offenders,
      `discoverClaudeSubprocessPid was reintroduced via re-export in:\n${offenders
        .map((o) => `  ${o.file}`)
        .join("\n")}\n\nSee Test 1's failure message for context.`,
    ).toEqual([]);
  });

  it("Test 3: src/mcp/proc-scan.ts no longer exports the function", () => {
    // Positive-control: the tombstone comment in proc-scan.ts should
    // describe the deletion, and the file must not contain the function
    // body anywhere. If this assertion fails, the deletion regressed.
    const procScanPath = join(srcRoot, "mcp", "proc-scan.ts");
    const src = readFileSync(procScanPath, "utf8");
    expect(
      DEFINITION_PATTERN.test(src),
      "src/mcp/proc-scan.ts must NOT define `function discoverClaudeSubprocessPid` — the function was removed in FIND-123-A.next T-09.",
    ).toBe(false);
    // Tombstone marker still present — protects readers who land here
    // via blame or grep on the historical name.
    expect(
      /T-09/.test(src) && /discoverClaudeSubprocessPid/.test(src),
      "src/mcp/proc-scan.ts must retain the T-09 tombstone comment referencing discoverClaudeSubprocessPid by name (breadcrumb for future archaeology).",
    ).toBe(true);
  });
});
