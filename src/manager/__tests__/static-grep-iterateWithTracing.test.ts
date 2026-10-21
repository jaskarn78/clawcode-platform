/**
 * Phase 120 Plan 03 T-02 — Silent-path-bifurcation sentinel for the
 * split-latency producer (DASH-04, ROADMAP SC-4).
 *
 * **Anti-pattern context.** Phase 115-08 ported per-batch tool-execution
 * + roundtrip + parallel-batch-size telemetry into the canonical
 * producer at `src/manager/persistent-session-handle.ts:iterateUntilResult`
 * (around line 389). The legacy producer at
 * `src/manager/session-adapter.ts:iterateWithTracing` (line 1520) is
 * the test-fixture path, reachable ONLY via
 * `createTracedSessionHandle` (line 2288) → `wrapSdkQuery` (line 1410,
 * `@deprecated`) → `iterateWithTracing`. Production routes through
 * `createPersistentSessionHandle` (line 1114 / 1209 of
 * `session-adapter.ts`) → `iterateUntilResult`.
 *
 * If a future refactor silently bifurcates the call path again — by
 * invoking `iterateWithTracing(...)` from production code outside
 * `session-adapter.ts` — telemetry goes NULL fleet-wide. This sentinel
 * fails CI before that lands.
 *
 * **Pattern.** Mirrors the Phase 119 Plan 01 D-09 static-grep sentinel
 * and the `producer-call-sites-sentinel.test.ts` adjacent to this file
 * (which is the positive complement — asserts iterateUntilResult
 * CONTAINS the producer methods). Together they pin both halves of the
 * silent-path-bifurcation guard.
 *
 * **Scope.** Forbids INVOCATIONS (`iterateWithTracing(`) outside two
 * legitimate locations:
 *   - `src/manager/__tests__/` — test code may exercise the fixture
 *   - `src/manager/session-adapter.ts` — the fixture's own file
 *
 * Doc-comment references to the token (`// session-adapter.ts:iterateWithTracing`)
 * are NOT invocations and pose no bifurcation risk — they're left alone.
 *
 * @see ~/.claude/projects/-home-example-user--openclaw-workspace-coding/memory/feedback_silent_path_bifurcation.md
 * @see .planning/phases/120-dashboard-observability-cleanup/120-03-PLAN.md
 * @see src/manager/__tests__/producer-call-sites-sentinel.test.ts
 */

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..", "..");

describe("silent-path-bifurcation sentinel: iterateWithTracing is fixture-only", () => {
  it("Test 1: no production-path file invokes iterateWithTracing(", () => {
    // Strict pattern: identifier immediately followed by `(` — matches
    // function invocations only, not doc-comment references like
    // `(the test-only path)` where the `(` is incidental punctuation.
    let raw = "";
    try {
      raw = execSync(
        "grep -RIn --include='*.ts' --exclude-dir='__tests__' --exclude='session-adapter.ts' -F 'iterateWithTracing(' src/",
        { cwd: repoRoot, encoding: "utf8" },
      );
    } catch {
      // grep exits 1 on zero matches — that is the GREEN path
      raw = "";
    }
    const offenders = raw.split("\n").filter(Boolean);
    expect(
      offenders,
      `iterateWithTracing(...) invocation leaked to production path:\n${offenders.join("\n")}`,
    ).toHaveLength(0);
  });

  it("Test 2 (positive control): fixture-file contains the invocation pattern", () => {
    // Sanity: the grep machinery + repoRoot resolution actually works.
    // If session-adapter.ts ever stops invoking iterateWithTracing, this
    // sentinel can no longer claim "iterateWithTracing is the fixture
    // path" and the asymmetry must be re-examined.
    const raw = execSync(
      "grep -RIn --include='*.ts' -F 'iterateWithTracing(' src/manager/session-adapter.ts",
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(
      raw.trim().length,
      "positive control failed — grep machinery or fixture file missing",
    ).toBeGreaterThan(0);
  });
});
