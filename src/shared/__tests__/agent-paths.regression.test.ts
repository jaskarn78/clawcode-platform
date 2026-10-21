/**
 * Phase 99-A static-grep regression pin for the per-agent memories.db path.
 *
 * Background: prior to Phase 99-A the OpenClaw→ClawCode session translator
 * (`src/cli/commands/sync-translate-sessions.ts`) and the memory backfill CLI
 * (`src/cli/commands/memory-backfill.ts`) joined `"memories.db"` directly
 * onto `<memoryPath>` (no `memory/` subdir), while every running agent reads
 * the canonical `<memoryPath>/memory/memories.db` set by
 * `AgentMemoryManager.initMemory` (`src/manager/session-memory.ts`). The
 * mismatch silently routed translator output to an orphan DB file that no
 * agent ever opened — 308 historical sessions and zero turns visible to
 * dream-pass / restart-greeting / session-summarizer.
 *
 * The fix routes every reader/writer through the
 * `getAgentMemoryDbPath(memoryPath)` helper in `src/shared/agent-paths.ts`.
 * This pin walks `src/` (excluding `__tests__/` and the helper's own file)
 * and fails CI if any source file re-introduces a direct
 * `join(... , "memories.db")` or `resolve(... , "memories.db")` literal.
 *
 * Modeled on `src/discord/__tests__/slash-commands-register.test.ts:35-90`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

describe("Phase 99-A — getAgentMemoryDbPath static-grep regression pin", () => {
  /**
   * Catches BOTH `join(... , "memories.db")` and `resolve(... , "memories.db")`
   * forms. Permissive `.*?` between the open paren and the literal allows
   * one-or-more positional args (e.g. `join(a, b, "memories.db")`).
   */
  const FORBIDDEN_PATTERN = /(?:join|resolve)\s*\([^)]*?,\s*"memories\.db"/;

  const SRC_ROOT = resolve(__dirname, "..", "..");
  /** The helper itself contains the literal — exempt by absolute path. */
  const HELPER_FILE = resolve(__dirname, "..", "agent-paths.ts");

  function walk(dir: string, out: string[]): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "__tests__") continue;
        if (e.name === "node_modules") continue;
        walk(full, out);
      } else if (e.isFile() && e.name.endsWith(".ts")) {
        if (full === HELPER_FILE) continue;
        out.push(full);
      }
    }
  }

  it("no direct join/resolve onto 'memories.db' exists anywhere in src/ (use getAgentMemoryDbPath)", () => {
    try {
      statSync(SRC_ROOT);
    } catch {
      throw new Error(`src root missing: ${SRC_ROOT}`);
    }
    const files: string[] = [];
    walk(SRC_ROOT, files);

    const offenders: Array<{ file: string; match: string }> = [];
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      const match = content.match(FORBIDDEN_PATTERN);
      if (match) {
        offenders.push({ file, match: match[0] });
      }
    }

    expect(
      offenders,
      `Found direct path-join onto 'memories.db':\n${offenders
        .map((o) => `  ${o.file}: ${o.match}`)
        .join("\n")}\n\n` +
        "Phase 99-A forbids this — every per-agent DB path MUST funnel through " +
        "getAgentMemoryDbPath(memoryPath) from src/shared/agent-paths.ts so the " +
        "translator/backfill path-mismatch class of bug cannot reappear.",
    ).toEqual([]);
  });
});
