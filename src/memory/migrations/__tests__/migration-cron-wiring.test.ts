/**
 * Phase 115-postdeploy 2026-05-12 — sentinel test against silent path
 * bifurcation in the embedding-v2 migration runner.
 *
 * THE BUG CLASS:
 *   Phase 115 Plan 06 shipped three pieces of the migration:
 *     (a) state machine `EmbeddingV2Migrator`
 *     (b) batch runner `runReEmbedBatch`
 *     (c) IPC handlers (transition / status / pause / resume)
 *   It NEVER shipped a scheduler that called the runner. The operator
 *   clicked "Start re-embedding" — phase flipped to `re-embedding` —
 *   `progressProcessed` sat at 0% forever because no production caller
 *   ever invoked `runReEmbedBatch`. See `feedback_silent_path_bifurcation.md`
 *   for the anti-pattern history; this is instance #4 of the same class.
 *
 *   Historical instances:
 *     1. Phase 115-08 producer regression (lookup result never paged
 *        back to the requester)
 *     2. Phase 116-postdeploy IPC allowlist drift x3 (caught by
 *        `src/ipc/__tests__/protocol-daemon-parity.test.ts`)
 *     3. (this file is instance #4)
 *
 * THE INVARIANT THIS PINS:
 *   `runReEmbedBatch` (the embedding-v2 migration batch runner) MUST
 *   have at least one production caller — i.e. a non-test source file
 *   under `src/` that imports it. Today the production caller is
 *   `src/manager/migration-cron.ts`. If a future refactor renames /
 *   moves the cron without re-establishing the caller chain, this test
 *   fails and the silent-path-bifurcation surfaces at PR time instead
 *   of post-deploy when an operator clicks the button.
 *
 *   Static grep — no daemon construction, no real timer, no real DB.
 *   Mirrors the style of
 *   `src/ipc/__tests__/protocol-daemon-parity.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname = src/memory/migrations/__tests__
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const RUNNER_PATH = path.join(
  REPO_ROOT,
  "src",
  "memory",
  "migrations",
  "embedding-v2-runner.ts",
);

/** Recursively yield every .ts file under `dir` that is NOT a test file. */
function* walkProductionSources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip any __tests__ directory — we only count PRODUCTION callers.
      if (entry === "__tests__" || entry === "node_modules") continue;
      yield* walkProductionSources(full);
    } else if (
      st.isFile() &&
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".spec.ts")
    ) {
      yield full;
    }
  }
}

describe("embedding-v2 migration runner wiring", () => {
  it("runReEmbedBatch exists at the expected path (extractor sanity)", () => {
    const src = readFileSync(RUNNER_PATH, "utf-8");
    expect(src).toMatch(/export\s+async\s+function\s+runReEmbedBatch\s*\(/);
  });

  it("has at least one production caller outside of its definition site", () => {
    const callers: string[] = [];
    for (const file of walkProductionSources(SRC_ROOT)) {
      if (file === RUNNER_PATH) continue; // skip definition site
      const src = readFileSync(file, "utf-8");
      // Match `runReEmbedBatch(` (callsite) — not just any mention of the
      // identifier (which could be a comment or type import).
      if (/\brunReEmbedBatch\s*\(/.test(src)) {
        callers.push(path.relative(REPO_ROOT, file));
      }
    }

    if (callers.length === 0) {
      throw new Error(
        [
          "",
          "SILENT PATH BIFURCATION: `runReEmbedBatch` (the embedding-v2",
          "migration batch runner) has NO production callers. Operators",
          "who flip the migration phase to `re-embedding` will see",
          "`progressProcessed` stick at 0 forever because no scheduler",
          "ever invokes the runner.",
          "",
          "Today this is wired through `src/manager/migration-cron.ts`",
          "(both the cron tick and the one-shot kick from the IPC",
          "transition handler call `runReEmbedBatch`). If you renamed or",
          "removed that file, re-establish a production caller before",
          "merging.",
          "",
          "See `feedback_silent_path_bifurcation.md` for the anti-pattern",
          "history. This is instance #4 of the same class.",
          "",
        ].join("\n"),
      );
    }

    expect(callers.length).toBeGreaterThan(0);
  });

  it("migration-cron.ts is one of the production callers", () => {
    // Lock the specific wiring site so a refactor that drops the cron
    // (without replacing it) fails loud.
    const cronPath = path.join(SRC_ROOT, "manager", "migration-cron.ts");
    const src = readFileSync(cronPath, "utf-8");
    expect(src).toMatch(/\brunReEmbedBatch\s*\(/);
  });

  it("daemon.ts wires the cron via scheduleMigrationCron", () => {
    // Pins the daemon-side scheduling site. The daemon may delegate the
    // actual `runReEmbedBatch(` call to migration-cron.ts (it does), but
    // daemon.ts itself must construct + own the cron handle so SIGTERM
    // shutdown can call `.stop()` on it.
    const daemonPath = path.join(SRC_ROOT, "manager", "daemon.ts");
    const src = readFileSync(daemonPath, "utf-8");
    expect(src).toMatch(/\bscheduleMigrationCron\s*\(/);
    expect(src).toMatch(/migrationCron\.stop\s*\(/);
  });
});
