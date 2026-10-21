/**
 * Phase 55 Plan 03 — daemon `tools` IPC handler unit tests.
 *
 * Exercises the pure `augmentToolsWithSlo` helper exported from daemon.ts.
 * The helper is the only daemon-internal logic worth isolating here —
 * the full handler (--all branch / missing-store error / --since parsing)
 * is covered end-to-end via the REST endpoint tests in
 * src/dashboard/__tests__/server.test.ts and the integration path through
 * sendIpcRequest.
 *
 * Design mirror: src/manager/__tests__/daemon-latency-slo.test.ts
 * (`augmentWithSloStatus` tested the same way — helper in isolation, not
 * the full routeMethod switch).
 */

import { describe, it, expect } from "vitest";

import { augmentToolsWithSlo } from "../daemon.js";
import type { ToolPercentileRow } from "../../performance/types.js";

/**
 * Build a frozen ToolPercentileRow for tests. `p99` defaults to the p95 value
 * so tests that only care about p95 don't repeat the number.
 */
function toolRow(
  tool_name: string,
  p95: number | null,
  count: number,
  p50: number | null = p95,
): ToolPercentileRow {
  return Object.freeze({
    tool_name,
    p50,
    p95,
    p99: p95,
    count,
  });
}

describe("augmentToolsWithSlo (Phase 55)", () => {
  it("applies global tool_call SLO (1500ms p95) when no per-tool override", () => {
    const rows = [toolRow("memory_lookup", 200, 10, 100)];
    const augmented = augmentToolsWithSlo(rows, undefined);
    expect(augmented).toHaveLength(1);
    expect(augmented[0]!.slo_threshold_ms).toBe(1500);
    expect(augmented[0]!.slo_metric).toBe("p95");
    expect(augmented[0]!.slo_status).toBe("healthy");
    // Row shape passthrough — tool_name, count, p50/p95/p99 preserved.
    expect(augmented[0]!.tool_name).toBe("memory_lookup");
    expect(augmented[0]!.count).toBe(10);
    expect(augmented[0]!.p50).toBe(100);
    expect(augmented[0]!.p95).toBe(200);
  });

  it("per-tool override wins over global tool_call SLO (memory_lookup 100ms → breach at p95=200)", () => {
    // Without override: memory_lookup p95=200 would be healthy (under 1500).
    // With override threshold 100ms: p95=200 becomes a breach.
    const rows = [toolRow("memory_lookup", 200, 10, 100)];
    const augmented = augmentToolsWithSlo(rows, {
      slos: { memory_lookup: { thresholdMs: 100 } },
    });
    expect(augmented[0]!.slo_threshold_ms).toBe(100);
    expect(augmented[0]!.slo_metric).toBe("p95"); // default when omitted
    expect(augmented[0]!.slo_status).toBe("breach");
  });

  it("per-tool override respects explicit metric field (p50 instead of default p95)", () => {
    const rows = [toolRow("memory_lookup", 5000, 10, 1500)];
    const augmented = augmentToolsWithSlo(rows, {
      slos: { memory_lookup: { thresholdMs: 1000, metric: "p50" } },
    });
    expect(augmented[0]!.slo_metric).toBe("p50");
    expect(augmented[0]!.slo_threshold_ms).toBe(1000);
    // p50=1500 > threshold=1000 → breach.
    expect(augmented[0]!.slo_status).toBe("breach");
  });

  it("unknown tool falls back to global tool_call SLO (1500ms p95)", () => {
    const rows = [toolRow("random_new_tool", 400, 5, 200)];
    const augmented = augmentToolsWithSlo(rows, undefined);
    expect(augmented[0]!.slo_threshold_ms).toBe(1500);
    expect(augmented[0]!.slo_metric).toBe("p95");
    expect(augmented[0]!.slo_status).toBe("healthy");
  });

  it("count=0 / null p95 → slo_status='no_data' (threshold + metric still emitted)", () => {
    const rows = [toolRow("memory_lookup", null, 0, null)];
    const augmented = augmentToolsWithSlo(rows, undefined);
    expect(augmented[0]!.slo_status).toBe("no_data");
    expect(augmented[0]!.slo_threshold_ms).toBe(1500);
    expect(augmented[0]!.slo_metric).toBe("p95");
  });

  it("preserves input order (SQL layer already sorts by p95 DESC)", () => {
    // getToolPercentiles returns rows already sorted slowest-first. The
    // helper must not resort them — consumers trust the SQL ordering.
    const rows = [
      toolRow("search_documents", 800, 5, 400),
      toolRow("memory_lookup", 200, 10, 100),
      toolRow("weather_lookup", 50, 2, 25),
    ];
    const augmented = augmentToolsWithSlo(rows, undefined);
    expect(augmented[0]!.tool_name).toBe("search_documents");
    expect(augmented[1]!.tool_name).toBe("memory_lookup");
    expect(augmented[2]!.tool_name).toBe("weather_lookup");
  });

  it("returns a frozen array of frozen rows (immutability invariant)", () => {
    const rows = [toolRow("memory_lookup", 200, 10, 100)];
    const augmented = augmentToolsWithSlo(rows, undefined);
    expect(Object.isFrozen(augmented)).toBe(true);
    expect(Object.isFrozen(augmented[0])).toBe(true);
  });

  it("empty input → empty output (no throw, frozen empty array)", () => {
    const augmented = augmentToolsWithSlo([], undefined);
    expect(augmented).toEqual([]);
    expect(Object.isFrozen(augmented)).toBe(true);
  });

  it("per-tool override does not leak to sibling rows (memory_lookup overridden, search_documents still default)", () => {
    const rows = [
      toolRow("search_documents", 1600, 10, 800),
      toolRow("memory_lookup", 200, 10, 100),
    ];
    const augmented = augmentToolsWithSlo(rows, {
      slos: { memory_lookup: { thresholdMs: 100 } },
    });
    // search_documents still evaluated against global 1500 (p95=1600 > 1500 → breach).
    expect(augmented[0]!.tool_name).toBe("search_documents");
    expect(augmented[0]!.slo_threshold_ms).toBe(1500);
    expect(augmented[0]!.slo_status).toBe("breach");
    // memory_lookup override applied (p95=200 > 100 → breach).
    expect(augmented[1]!.tool_name).toBe("memory_lookup");
    expect(augmented[1]!.slo_threshold_ms).toBe(100);
    expect(augmented[1]!.slo_status).toBe("breach");
  });
});
