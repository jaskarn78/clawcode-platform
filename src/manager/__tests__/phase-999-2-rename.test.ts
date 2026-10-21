/**
 * Phase 999.2 Plan 01 — static-grep regression tests pinning the
 * SessionManager rename to dispatchTurn (D-RNI-01).
 *
 * Pattern: src/ipc/__tests__/protocol.test.ts literal-array pin tests.
 *
 * These tests are the GREEN gate for Plan 01:
 *   - No production .ts file may contain the deprecated method name.
 *   - No test .ts file may contain it (catches stale mocks per
 *     RESEARCH.md Pitfall 1 — false-positive mocks if test files keep the
 *     old method name on a mocked SessionManager).
 *   - All 4 production call-site files must contain the new name `dispatchTurn`.
 *   - SessionManager declares `async dispatchTurn`.
 *
 * NOTE: The deprecated method name is constructed dynamically below so this
 * test file does NOT itself contain the literal substring (it would otherwise
 * self-trigger the "no test file contains ..." assertion).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Construct the deprecated method name without including the literal
// substring anywhere in this file's source text.
const DEPRECATED_NAME = ["send", "To", "Agent"].join("");

/**
 * Recursively walk `dir` and yield paths to .ts files. Avoids dragging in
 * a `glob` dep just for this static-grep test (Node 22's `fs.globSync` is
 * available, but a plain readdir walk is portable across the team's
 * matrix and matches the precedent set by other static-pin tests).
 */
function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      // Skip node_modules + dist if they ever sneak under src/ (shouldn't,
      // but cheap insurance).
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...walkTsFiles(full));
    } else if (s.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const ALL_TS = walkTsFiles("src");
const TEST_FILES = ALL_TS.filter(
  (f) => f.endsWith(".test.ts") || f.includes("__tests__"),
);
const PROD_FILES = ALL_TS.filter(
  (f) => !f.endsWith(".test.ts") && !f.includes("__tests__"),
);

describe(`Phase 999.2 Plan 01 — ${DEPRECATED_NAME} rename complete`, () => {
  it(`no production file contains the deprecated method name`, () => {
    const offenders: string[] = [];
    for (const f of PROD_FILES) {
      const text = readFileSync(f, "utf8");
      if (text.includes(DEPRECATED_NAME)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it(`no test file contains the deprecated method name (mocks use the new name)`, () => {
    const offenders: string[] = [];
    for (const f of TEST_FILES) {
      const text = readFileSync(f, "utf8");
      if (text.includes(DEPRECATED_NAME)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("dispatchTurn appears at all required production call-site files", () => {
    const required = [
      "src/manager/turn-dispatcher.ts",
      "src/manager/daemon.ts",
      "src/manager/escalation.ts",
      "src/heartbeat/checks/inbox.ts",
    ];
    for (const f of required) {
      const text = readFileSync(f, "utf8");
      expect(text, `expected ${f} to contain dispatchTurn`).toMatch(
        /\bdispatchTurn\b/,
      );
    }
  });

  it("SessionManager declares async dispatchTurn", () => {
    const text = readFileSync("src/manager/session-manager.ts", "utf8");
    expect(text).toMatch(/\basync dispatchTurn\b/);
  });
});
