/**
 * Sentinel test against silent path bifurcation in the dream-pass
 * AUTO-trigger cron.
 *
 * THE BUG CLASS:
 *   `registerDreamCron` (src/manager/dream-cron.ts) — the 30-min-idle
 *   AUTO trigger that decides when to fire a dream pass — was fully
 *   implemented and unit-tested but had ZERO production callers.
 *   daemon.ts never registered it (a comment near the `get-dream-queue`
 *   IPC handler explicitly admitted "the actual cron scheduler isn't
 *   directly registered in daemon.ts today ... wired via test paths").
 *   Consequence: dream passes only ever fired via the manual
 *   `clawcode dream` IPC call. The 30-min-idle auto-trigger never ran —
 *   fin-client's auto-dream went 5+ days dark.
 *
 *   This is the silent-path-bifurcation anti-pattern (memory note
 *   `feedback_silent_path_bifurcation.md`) — code shipped that looks
 *   reachable but production never actually invokes it. This is
 *   instance #5 of the same class.
 *
 *   Historical instances:
 *     1. Phase 115-08 producer regression (lookup result never paged
 *        back to the requester)
 *     2. Phase 116-postdeploy IPC allowlist drift x3 (caught by
 *        `src/ipc/__tests__/protocol-daemon-parity.test.ts`)
 *     3. Phase 115 embedding-v2 migration runner never scheduled
 *        (caught by
 *        `src/memory/migrations/__tests__/migration-cron-wiring.test.ts`)
 *     4. (the migration-runner sentinel — same file as #3)
 *     5. (this file — `registerDreamCron` never wired)
 *
 * THE INVARIANT THIS PINS:
 *   `registerDreamCron` MUST have at least one production caller — a
 *   non-test source file under `src/` that calls it. Today that caller
 *   is `src/manager/daemon.ts`, which registers one dream cron per agent
 *   at boot and stores each `DreamCronRegistration` so the SIGTERM
 *   shutdown sequence can `.unregister()` it. If a future refactor
 *   removes the daemon-side wiring, this test fails at PR time instead
 *   of going silently dark in production.
 *
 *   Static grep — no daemon construction, no real timer, no real DB.
 *   Mirrors `src/memory/migrations/__tests__/migration-cron-wiring.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname = src/manager/__tests__
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const DREAM_CRON_PATH = path.join(SRC_ROOT, "manager", "dream-cron.ts");
const DAEMON_PATH = path.join(SRC_ROOT, "manager", "daemon.ts");

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

describe("dream-pass auto-trigger cron wiring", () => {
  it("registerDreamCron exists at the expected path (extractor sanity)", () => {
    const src = readFileSync(DREAM_CRON_PATH, "utf-8");
    expect(src).toMatch(
      /export\s+function\s+registerDreamCron\s*\(/,
    );
  });

  it("has at least one production caller outside of its definition site", () => {
    const callers: string[] = [];
    for (const file of walkProductionSources(SRC_ROOT)) {
      if (file === DREAM_CRON_PATH) continue; // skip definition site
      const src = readFileSync(file, "utf-8");
      // Match `registerDreamCron(` (callsite) — not just any mention of
      // the identifier (which could be a comment or a type-only import).
      if (/\bregisterDreamCron\s*\(/.test(src)) {
        callers.push(path.relative(REPO_ROOT, file));
      }
    }

    if (callers.length === 0) {
      throw new Error(
        [
          "",
          "SILENT PATH BIFURCATION: `registerDreamCron` (the dream-pass",
          "30-min-idle AUTO trigger) has NO production callers. Dream",
          "passes will ONLY ever fire via the manual `clawcode dream`",
          "IPC call — the auto-trigger silently never runs.",
          "",
          "Today this is wired in `src/manager/daemon.ts`, which",
          "registers one dream cron per agent at boot and stores each",
          "registration so SIGTERM shutdown can `.unregister()` it. If",
          "you removed that wiring, re-establish a production caller",
          "before merging.",
          "",
          "See `feedback_silent_path_bifurcation.md` for the anti-pattern",
          "history. This is instance #5 of the same class.",
          "",
        ].join("\n"),
      );
    }

    expect(callers.length).toBeGreaterThan(0);
  });

  it("daemon.ts is one of the production callers", () => {
    // Lock the specific wiring site so a refactor that drops the
    // daemon-side registration (without replacing it) fails loud.
    const src = readFileSync(DAEMON_PATH, "utf-8");
    expect(src).toMatch(/\bregisterDreamCron\s*\(/);
  });

  it("daemon.ts unregisters dream crons in the shutdown path", () => {
    // The daemon must own the registration handles so the SIGTERM
    // shutdown sequence cleanly stops every per-agent dream cron — same
    // contract migrationCron.stop() / dailySummaryCron.stop() satisfy.
    const src = readFileSync(DAEMON_PATH, "utf-8");
    // Storage array for the registrations.
    expect(src).toMatch(/dreamCronRegistrations/);
    // Shutdown-side teardown — `.unregister?.()` on each registration.
    expect(src).toMatch(/\.unregister\?\.\(\)/);
  });
});
