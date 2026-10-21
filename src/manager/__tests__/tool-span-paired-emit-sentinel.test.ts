/**
 * Phase 120 Plan 05 (DEFERRED-120-A close-out) — paired-emit invariant sentinel.
 *
 * Background: DEFERRED-120-A captured an apparent producer-gating regression
 * — 136 production traces with `tool_call.*` spans but NULL `tool_execution_ms`.
 * Fleet-wide daily-breakdown analysis (120-05-SUMMARY.md) proved this was
 * non-reproducible: the producer port commit `a0f30a6` (deployed mid-day
 * 2026-05-11) already populates 100% of post-deploy traces. The 136 NULL
 * traces are legacy pre-deploy data.
 *
 * The bug was logically impossible in the as-written code because span
 * creation and recordParallelToolCallCount live inside the SAME
 * `if (parentToolUseId === null)` block in both producer files. This
 * sentinel pins that coupling so a future refactor cannot silently split
 * them — extracting span creation to a helper while leaving the counter
 * call behind (or vice versa) would silently NULL the column for every
 * tool-firing turn again.
 *
 * Pairs with `producer-call-sites-sentinel.test.ts` (commit `a0f30a6`) —
 * the original sentinel pins call-site presence per producer; this
 * sentinel pins the invariant that span-emit and counter-emit are
 * structurally co-located in the same control-flow block.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", "..", "..");

const PRODUCER_FILES = [
  "src/manager/persistent-session-handle.ts",
  "src/manager/session-adapter.ts",
] as const;

const SPAN_EMIT_PATTERN = /startSpan\(\s*`tool_call\.\$\{[^}]+\}`/;
const COUNTER_EMIT_PATTERN = /\.recordParallelToolCallCount\?\.\(/;
const SUBAGENT_GATE_PATTERN = /if\s*\(\s*parentToolUseId\s*===\s*null\s*\)/;

describe("tool_call span / recordParallelToolCallCount paired-emit invariant", () => {
  for (const relPath of PRODUCER_FILES) {
    describe(relPath, () => {
      const src = readFileSync(join(repoRoot, relPath), "utf8");

      it("opens at least one tool_call.* span", () => {
        expect(src).toMatch(SPAN_EMIT_PATTERN);
      });

      it("calls recordParallelToolCallCount at least once", () => {
        expect(src).toMatch(COUNTER_EMIT_PATTERN);
      });

      it("gates both emits behind a single parentToolUseId === null block", () => {
        const counterIdx = src.search(COUNTER_EMIT_PATTERN);
        const spanIdx = src.search(SPAN_EMIT_PATTERN);
        expect(counterIdx).toBeGreaterThan(-1);
        expect(spanIdx).toBeGreaterThan(-1);

        const gateIdx = src.search(SUBAGENT_GATE_PATTERN);
        expect(gateIdx).toBeGreaterThan(-1);
        expect(counterIdx).toBeGreaterThan(gateIdx);
        expect(spanIdx).toBeGreaterThan(gateIdx);
      });

      it("orders counter-emit before span-emit so the counter records a tool-bearing message even on early-throw of span creation", () => {
        const counterIdx = src.search(COUNTER_EMIT_PATTERN);
        const spanIdx = src.search(SPAN_EMIT_PATTERN);
        expect(counterIdx).toBeLessThan(spanIdx);
      });
    });
  }

  it("the conditional-spread gate on Turn.end() persists the trio only when parallelToolCallCount > 0", () => {
    const collectorSrc = readFileSync(
      join(repoRoot, "src/performance/trace-collector.ts"),
      "utf8",
    );
    expect(collectorSrc).toMatch(
      /this\.parallelToolCallCount\s*>\s*0/,
    );
    const gateIdx = collectorSrc.search(/this\.parallelToolCallCount\s*>\s*0/);
    const sliceAfterGate = collectorSrc.slice(gateIdx, gateIdx + 400);
    expect(sliceAfterGate).toContain("toolExecutionMs");
    expect(sliceAfterGate).toContain("toolRoundtripMs");
    expect(sliceAfterGate).toContain("parallelToolCallCount");
  });
});

describe("Turn.recordParallelToolCallCount no-op semantics (zero/negative batch sizes never poison the gate)", () => {
  it("recordParallelToolCallCount(0) leaves parallelToolCallCount at 0", async () => {
    const { TraceCollector } = await import("../../performance/trace-collector.js");
    const writeTurn = (): void => undefined;
    const store = {
      writeTurn,
      pruneOlderThan: () => 0,
      close: () => undefined,
      getPercentiles: () => [],
    } as never;
    const logger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      child: function (this: unknown) {
        return this;
      },
    } as never;
    const collector = new TraceCollector(store, logger);
    const turn = collector.startTurn("paired-emit-zero", "alpha", null);

    turn.recordParallelToolCallCount(0);
    turn.recordParallelToolCallCount(-1);

    let captured: { parallelToolCallCount?: number } | null = null;
    (store as { writeTurn: (r: unknown) => void }).writeTurn = (r) => {
      captured = r as { parallelToolCallCount?: number };
    };
    turn.end("success");

    expect(captured).not.toBeNull();
    expect(captured!.parallelToolCallCount).toBeUndefined();
  });

  it("recordParallelToolCallCount(N>0) followed by recordParallelToolCallCount(M<N) keeps the MAX", async () => {
    const { TraceCollector } = await import("../../performance/trace-collector.js");
    let captured: { parallelToolCallCount?: number } | null = null;
    const store = {
      writeTurn: (r: unknown) => {
        captured = r as { parallelToolCallCount?: number };
      },
      pruneOlderThan: () => 0,
      close: () => undefined,
      getPercentiles: () => [],
    } as never;
    const logger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      child: function (this: unknown) {
        return this;
      },
    } as never;
    const collector = new TraceCollector(store, logger);
    const turn = collector.startTurn("paired-emit-max", "alpha", null);

    turn.recordParallelToolCallCount(3);
    turn.recordParallelToolCallCount(1);
    turn.recordParallelToolCallCount(2);
    turn.end("success");

    expect(captured).not.toBeNull();
    expect(captured!.parallelToolCallCount).toBe(3);
  });
});
