/**
 * 999.99 review finding #1 — session-adapter create/resume symmetry pin.
 *
 * The attributed-stream pair (`attributedStream` + `onOrphanTurnOutput`) is
 * a handle-only baseOptions field: consumed by createPersistentSessionHandle's
 * epoch builder, stripped by stripHandleOnlyFields before sdk.query. Both
 * `createSession` AND `resumeSession` must spread it, or a daemon restart
 * (which resumes every session) silently reverts a canary agent to the
 * buffering LEGACY loop — re-seeding the exact off-by-one incident this fix
 * closes — with ZERO failing unit tests (the review's flagged blind spot).
 *
 * A behavioral pin would need a full LlmRuntime + SDK-module harness; the
 * failure mode is a *refactor dropping one of two identical spread blocks*,
 * so a source-structural pin (same family as MISSED_UPLOAD_PATTERN /
 * static-grep regressions elsewhere in this tree) is the right-grained,
 * low-brittleness guard: it fails the instant the two paths diverge.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "session-adapter.ts",
);

// The file has a MockSessionAdapter (createMockAdapter) whose method
// signatures collide with the real impl; anchor on the LAST occurrence so
// we always slice the production AnthropicSessionAdapter methods.
function bodyOf(source: string, methodSig: string, nextSig: string): string {
  const start = source.lastIndexOf(methodSig);
  expect(start, `method not found: ${methodSig}`).toBeGreaterThan(-1);
  const end = source.indexOf(nextSig, start + methodSig.length);
  expect(end, `boundary not found after ${methodSig}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("999.99 review #1 — attributed-stream create/resume symmetry", () => {
  const source = readFileSync(SRC, "utf-8");

  const ATTR_SPREAD = "config.attributedStream === true";
  const SINK_SPREAD = "typeof config.onOrphanTurnOutput === \"function\"";

  it("createSession spreads BOTH attributedStream and onOrphanTurnOutput into baseOptions", () => {
    const create = bodyOf(source, "async createSession(", "async resumeSession(");
    expect(create).toContain(ATTR_SPREAD);
    expect(create).toContain(SINK_SPREAD);
  });

  it("resumeSession spreads BOTH — the restart-revert guard", () => {
    // resumeSession runs to the module-level stripHandleOnlyFields helper.
    const resume = bodyOf(
      source,
      "async resumeSession(",
      "function stripHandleOnlyFields(",
    );
    expect(resume).toContain(ATTR_SPREAD);
    expect(resume).toContain(SINK_SPREAD);
  });

  it("stripHandleOnlyFields removes BOTH before the bag reaches sdk.query", () => {
    const strip = bodyOf(
      source,
      "function stripHandleOnlyFields(",
      "return rest;",
    );
    expect(strip).toContain("attributedStream: _attributedStream");
    expect(strip).toContain("onOrphanTurnOutput: _onOrphanTurnOutput");
  });

  it("the two spread blocks are byte-identical (Rule 3 divergence guard)", () => {
    // Extract each path's attributed-stream spread block and compare —
    // catches a subtle asymmetric edit (e.g. one path gains a condition).
    const grab = (region: string): string => {
      const i = region.indexOf(ATTR_SPREAD);
      const j = region.indexOf(SINK_SPREAD, i);
      const k = region.indexOf("}", region.indexOf(":", j)); // end of sink spread
      return region.slice(i, k).replace(/\s+/g, " ").trim();
    };
    const create = grab(
      bodyOf(source, "async createSession(", "async resumeSession("),
    );
    const resume = grab(
      bodyOf(source, "async resumeSession(", "function stripHandleOnlyFields("),
    );
    expect(resume).toBe(create);
  });
});
