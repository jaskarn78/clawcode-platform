/**
 * FIND-123-A.next T-05 — Silent-path-bifurcation sentinel for the structural
 * spawn wrapper.
 *
 * **Anti-pattern context.** The Claude Agent SDK's default `spawn()` for
 * the `claude` CLI does NOT pass `detached: true`, so the child inherits
 * the daemon's process group. The Phase 110 / FIND-123-A regressions
 * (MCP grandchildren idling for ≥60s after shutdown until the reaper's
 * next sweep) trace to that single missing flag. T-01/T-02 introduce
 * `makeDetachedSpawn` and wire it through the SDK's
 * `spawnClaudeCodeProcess` hook (sdk.d.ts:1806) inside
 * `createPersistentSessionHandle`. If a future refactor silently
 * bifurcates the call path again — by invoking `sdk.query(...)` from
 * `persistent-session-handle.ts` without `spawnClaudeCodeProcess` in the
 * Options — shutdown reverts to leaking grandchildren and the daemon's
 * group-kill in T-03 becomes a no-op.
 *
 * **Scope (locked Option A — narrow, FIND-aligned).** Only the
 * MCP-bearing persistent session path needs the wrapper. Ephemeral query
 * call sites (advisor, haiku-direct, summarize, json-rpc-call, initial
 * drain, benchmarks) deliberately don't launch MCP servers, so this
 * sentinel is path-scoped to `persistent-session-handle.ts`. The
 * Option B (every `sdk.query(`) scope is deferred to a follow-up plan.
 *
 * **Pattern.** Mirrors `static-grep-iterateWithTracing.test.ts` and the
 * Phase 119 Plan 01 D-09 sentinel — Node-native fs read, no `glob`
 * dependency, fails CI loudly if the invariant drifts.
 *
 * @see ~/.claude/projects/-home-example-user--openclaw-workspace-coding/memory/feedback_silent_path_bifurcation.md
 * @see .planning/phases/_research/FIND-123-A-next-structural-spawn-wrapper.md
 * @see src/manager/detached-spawn.ts
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..", "..");

describe("silent-path-bifurcation sentinel: persistent handle uses spawnClaudeCodeProcess", () => {
  it("Test 1: every sdk.query(...) in persistent-session-handle.ts passes spawnClaudeCodeProcess", () => {
    // Strategy: locate each `sdk.query(` invocation in the file and
    // assert that the source range from the call site to its matching
    // closing paren (or, conservatively, a fixed window of the next
    // ~50 lines covering both the initial-build and the swap-build) MUST
    // contain `spawnClaudeCodeProcess`. The two production call sites
    // live in `buildEpoch` (initial + swap reuse the same builder), so
    // a single occurrence is enough — but we count call sites explicitly
    // to fail loudly if a future contributor adds a third bare sdk.query.
    const filePath = join(
      repoRoot,
      "src",
      "manager",
      "persistent-session-handle.ts",
    );
    const src = readFileSync(filePath, "utf8");
    const lines = src.split("\n");

    const callSiteIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Skip doc-comments + single-line comments to match invocations only.
      const trimmed = line.trimStart();
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
      // Match `sdk.query(` as an invocation — narrow regex.
      if (/\bsdk\.query\(/.test(line)) {
        callSiteIndices.push(i);
      }
    }
    expect(
      callSiteIndices.length,
      "positive control failed: persistent-session-handle.ts has zero sdk.query( invocations",
    ).toBeGreaterThan(0);

    for (const idx of callSiteIndices) {
      // Look ahead through the call's Options literal — bounded window
      // covers the largest current call (~25 lines including comments).
      const window = lines.slice(idx, Math.min(idx + 50, lines.length)).join("\n");
      expect(
        /\bspawnClaudeCodeProcess\b/.test(window),
        `sdk.query( at line ${idx + 1} of persistent-session-handle.ts does not pass spawnClaudeCodeProcess within the next 50 lines — structural shutdown fix regressed (FIND-123-A.next T-02).`,
      ).toBe(true);
    }
  });

  it("Test 2: makeDetachedSpawn is imported by persistent-session-handle.ts", () => {
    // Defense in depth — even if the call-site window contains the
    // identifier in a comment, the file must actually IMPORT the
    // wrapper. Without the import, the option name resolves to
    // `undefined` and the SDK falls back to non-detached default.
    const filePath = join(
      repoRoot,
      "src",
      "manager",
      "persistent-session-handle.ts",
    );
    const src = readFileSync(filePath, "utf8");
    expect(
      /from\s+["']\.\/detached-spawn(\.js)?["']/.test(src),
      "persistent-session-handle.ts must import from ./detached-spawn — structural spawn wrapper missing.",
    ).toBe(true);
    expect(
      /\bmakeDetachedSpawn\b/.test(src),
      "persistent-session-handle.ts must reference makeDetachedSpawn by name.",
    ).toBe(true);
  });

  it("Test 3: detached-spawn.ts wrapper actually sets detached:true", () => {
    // Pin the structural flag itself — the whole regression-prevention
    // exists because the SDK default is `detached:false`. If a future
    // contributor flips this to `detached:false` (or removes the
    // property entirely) for any reason, the negative-PID kill in T-03
    // becomes a no-op and grandchildren leak again.
    const filePath = join(repoRoot, "src", "manager", "detached-spawn.ts");
    const src = readFileSync(filePath, "utf8");
    expect(
      /detached:\s*true/.test(src),
      "detached-spawn.ts must spawn with `detached: true` — the entire point of the wrapper.",
    ).toBe(true);
  });
});
