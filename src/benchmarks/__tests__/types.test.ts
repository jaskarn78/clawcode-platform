import { describe, it, expect } from "vitest";

import {
  BenchmarkConfigError,
  baselineSchema,
  benchReportSchema,
  promptResultSchema,
} from "../types.js";

const validReport = {
  run_id: "bench-2026-04-13-abc123",
  started_at: "2026-04-13T20:00:00Z",
  git_sha: "f48895d",
  node_version: "v22.22.0",
  prompt_results: [
    {
      id: "no-tool-short-reply",
      turnIds: ["msg-001", "msg-002"],
      percentiles: [
        { segment: "end_to_end", p50: 1200, p95: 4500, p99: 5200, count: 5 },
      ],
    },
  ],
  overall_percentiles: [
    { segment: "end_to_end", p50: 1200, p95: 4500, p99: 5200, count: 25 },
    { segment: "first_token", p50: 800, p95: 1900, p99: 2100, count: 25 },
    {
      segment: "context_assemble",
      p50: 80,
      p95: 250,
      p99: 290,
      count: 25,
    },
    { segment: "tool_call", p50: 350, p95: 1200, p99: 1450, count: 18 },
  ],
} as const;

describe("benchReportSchema", () => {
  it("parses a valid report into a typed BenchReport with frozen-shape contents", () => {
    const result = benchReportSchema.safeParse(validReport);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.run_id).toBe("bench-2026-04-13-abc123");
      expect(result.data.started_at).toBe("2026-04-13T20:00:00Z");
      expect(result.data.git_sha).toBe("f48895d");
      expect(result.data.node_version).toBe("v22.22.0");
      expect(result.data.prompt_results).toHaveLength(1);
      expect(result.data.overall_percentiles).toHaveLength(4);
    }
  });

  it("rejects a report with missing run_id", () => {
    const { run_id: _omit, ...partial } = validReport;
    const result = benchReportSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it("rejects a report whose overall_percentiles contains a non-canonical segment name", () => {
    const bad = {
      ...validReport,
      overall_percentiles: [
        { segment: "garbage", p50: 1, p95: 2, p99: 3, count: 5 },
      ],
    };
    const result = benchReportSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  // Phase 54 Plan 03 — rate_limit_errors counter
  it("Test 1 (Phase 54): parses a report with rate_limit_errors: 0 successfully", () => {
    const report = { ...validReport, rate_limit_errors: 0 };
    const result = benchReportSchema.safeParse(report);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rate_limit_errors).toBe(0);
    }
  });

  it("Test 2 (Phase 54): parses a report WITHOUT rate_limit_errors (field is optional — backward compat)", () => {
    const result = benchReportSchema.safeParse(validReport);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rate_limit_errors).toBeUndefined();
    }
  });

  it("Test 3 (Phase 54): rejects rate_limit_errors: -1 (nonnegative integer required)", () => {
    const report = { ...validReport, rate_limit_errors: -1 };
    const result = benchReportSchema.safeParse(report);
    expect(result.success).toBe(false);
  });
});

describe("baselineSchema", () => {
  it("requires updated_at + updated_by on top of the BenchReport shape", () => {
    const baseline = {
      ...validReport,
      updated_at: "2026-04-13T21:00:00Z",
      updated_by: "clawdy",
    };
    const result = baselineSchema.safeParse(baseline);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.updated_by).toBe("clawdy");
      expect(result.data.git_sha).toBe("f48895d");
    }
  });

  it("rejects a baseline missing updated_at or updated_by", () => {
    const noUpdatedAt = { ...validReport, updated_by: "x" };
    expect(baselineSchema.safeParse(noUpdatedAt).success).toBe(false);

    const noUpdatedBy = { ...validReport, updated_at: "2026-04-13T21:00:00Z" };
    expect(baselineSchema.safeParse(noUpdatedBy).success).toBe(false);
  });
});

describe("promptResultSchema", () => {
  it("accepts the minimal empty-prompt-result shape", () => {
    const result = promptResultSchema.safeParse({
      id: "x",
      turnIds: [],
      percentiles: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an entry with empty id string", () => {
    const result = promptResultSchema.safeParse({
      id: "",
      turnIds: [],
      percentiles: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("BenchmarkConfigError", () => {
  it("formats the path into the message and exposes a readonly path field", () => {
    const err = new BenchmarkConfigError("yaml broken", "/etc/thresholds.yaml");
    expect(err.name).toBe("BenchmarkConfigError");
    expect(err.path).toBe("/etc/thresholds.yaml");
    expect(err.message).toContain("/etc/thresholds.yaml");
    expect(err.message).toContain("yaml broken");
  });
});
