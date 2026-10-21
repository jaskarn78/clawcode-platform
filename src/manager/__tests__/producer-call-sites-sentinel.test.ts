/**
 * Phase 115 Plan 08 T01 — producer call-site sentinel (silent-path-bifurcation guard).
 *
 * Background: Phase 115-08 added the trio of producer methods
 *   - Turn.addToolExecutionMs
 *   - Turn.addToolRoundtripMs
 *   - Turn.recordParallelToolCallCount
 * to populate traces.db columns `tool_execution_ms`, `tool_roundtrip_ms`,
 * and `parallel_tool_call_count`. The producers were wired into
 * `session-adapter.ts:iterateWithTracing` — but that function is the
 * test-only path (invoked via `wrapSdkQuery` / `createTracedSessionHandle`).
 *
 * Production runs `persistent-session-handle.ts:iterateUntilResult`
 * (daemon.ts → SdkSessionAdapter → template-driver.ts →
 * createPersistentSessionHandle). The 115-08 wiring missed it, so the
 * three columns were silently NULL fleet-wide.
 *
 * Quick task 260512 (this file) ported the producer call sites into
 * `iterateUntilResult`. These sentinels pin BOTH files so a future
 * refactor cannot silently re-bifurcate the path.
 *
 * Anti-pattern reference:
 *   ~/.claude/projects/-home-example-user--openclaw-workspace-coding/memory/feedback_silent_path_bifurcation.md
 *   .planning/quick/260511-pw2-investigate-post-to-agent-silent-drops-b/260511-pw2-PLAN.md
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..", "..");

const PRODUCERS = [
  "addToolExecutionMs",
  "addToolRoundtripMs",
  "recordParallelToolCallCount",
  // 2026-08-27 PR-0 — figures-class provenance producer (its first cut sat
  // in the dead wrapSdkQuery; this pins it to the production handle).
  "recordToolResultText",
  // 2026-08-27 PR-1 — evidence ledger producer (both seams)
  "recordEvidence",
] as const;

describe("Phase 115-08 producer call-site sentinels", () => {
  describe("production path: persistent-session-handle.ts:iterateUntilResult", () => {
    const src = readFileSync(
      join(repoRoot, "src/manager/persistent-session-handle.ts"),
      "utf8",
    );

    for (const producer of PRODUCERS) {
      it(`contains a call site for Turn.${producer}`, () => {
        // The optional-chain cast pattern from the port:
        //   (turn as { producer?: (...) => void }).producer?.(value)
        // The regex tolerates whitespace + wrapping but anchors on the
        // method name being invoked with `?.(`.
        const pattern = new RegExp(`\\.${producer}\\?\\.\\(`);
        expect(src).toMatch(pattern);
      });
    }

    it("the call sites live inside iterateUntilResult (not a different function)", () => {
      // Locate the iterateUntilResult function body. The function starts
      // with `async function iterateUntilResult(` and the next `async
      // function` declaration (or EOF) marks the end. The producer calls
      // MUST live inside this slice.
      const startIdx = src.indexOf("async function iterateUntilResult(");
      expect(startIdx).toBeGreaterThan(-1);
      // Find the next top-level async function or end of file (rough but
      // sufficient — iterateUntilResult is contained within
      // createPersistentSessionHandle so we look for the closing of the
      // function which is preceded by `}` at column 2).
      const slice = src.slice(startIdx);

      for (const producer of PRODUCERS) {
        const pattern = new RegExp(`\\.${producer}\\?\\.\\(`);
        expect(slice).toMatch(pattern);
      }
    });

    it("declares batchOpenedAtMs (per-batch roundtrip timer state)", () => {
      expect(src).toContain("batchOpenedAtMs");
    });
  });

  describe("test path: session-adapter.ts:iterateWithTracing (kept for tests)", () => {
    const src = readFileSync(
      join(repoRoot, "src/manager/session-adapter.ts"),
      "utf8",
    );

    for (const producer of PRODUCERS) {
      it(`still contains a call site for Turn.${producer} (do NOT remove)`, () => {
        const pattern = new RegExp(`\\.${producer}\\?\\.\\(`);
        expect(src).toMatch(pattern);
      });
    }
  });
});
