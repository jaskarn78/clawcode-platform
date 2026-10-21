import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBaseline, writeBaseline, formatDiffTable } from "../baseline.js";
import { BenchmarkConfigError, type BenchReport, type Baseline } from "../types.js";

function makeReport(overrides: Partial<BenchReport> = {}): BenchReport {
  return {
    run_id: "test-run-001",
    started_at: "2026-04-13T21:00:00.000Z",
    git_sha: "abc1234567890",
    node_version: "v22.11.0",
    prompt_results: [],
    overall_percentiles: [
      { segment: "end_to_end", p50: 1000, p95: 2000, p99: 3000, count: 25 },
      { segment: "first_token", p50: 400, p95: 800, p99: 1200, count: 25 },
      { segment: "context_assemble", p50: 50, p95: 100, p99: 150, count: 25 },
      { segment: "tool_call", p50: 75, p95: 150, p99: 225, count: 40 },
    ],
    ...overrides,
  };
}

function makeBaseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    ...makeReport(),
    updated_at: "2026-04-10T10:00:00.000Z",
    updated_by: "clawdy",
    ...overrides,
  };
}

describe("readBaseline", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "baseline-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns a frozen Baseline for a well-formed JSON file", () => {
    const path = join(tmp, "baseline.json");
    const baseline = makeBaseline();
    writeFileSync(path, JSON.stringify(baseline, null, 2), "utf-8");
    const result = readBaseline(path);
    expect(result.updated_by).toBe("clawdy");
    expect(result.run_id).toBe("test-run-001");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("throws BenchmarkConfigError when the file is missing", () => {
    const missing = join(tmp, "missing.json");
    try {
      readBaseline(missing);
      expect.fail("expected readBaseline to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BenchmarkConfigError);
      expect((err as BenchmarkConfigError).path).toBe(missing);
      expect((err as BenchmarkConfigError).message).toContain("read failed");
    }
  });

  it("throws BenchmarkConfigError when the JSON fails schema validation", () => {
    const path = join(tmp, "bad.json");
    writeFileSync(
      path,
      JSON.stringify({ run_id: "x", bogus: true }, null, 2),
      "utf-8",
    );
    try {
      readBaseline(path);
      expect.fail("expected readBaseline to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BenchmarkConfigError);
      expect((err as BenchmarkConfigError).message).toContain("schema invalid");
    }
  });

  it("throws BenchmarkConfigError when the JSON is unparseable", () => {
    const path = join(tmp, "broken.json");
    writeFileSync(path, "{not-json", "utf-8");
    try {
      readBaseline(path);
      expect.fail("expected readBaseline to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BenchmarkConfigError);
      expect((err as BenchmarkConfigError).message).toContain(
        "json parse failed",
      );
    }
  });
});

describe("writeBaseline", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "baseline-write-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes baseline.json with stamped provenance that round-trips through readBaseline", () => {
    const path = join(tmp, "nested", "dir", "baseline.json");
    const written = writeBaseline(path, makeReport(), {
      username: "operator",
      gitSha: "deadbeef1234567",
    });
    expect(written.updated_by).toBe("operator");
    expect(written.git_sha).toBe("deadbeef1234567");
    expect(written.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const readBack = readBaseline(path);
    expect(readBack.updated_by).toBe("operator");
    expect(readBack.git_sha).toBe("deadbeef1234567");
    expect(readBack.run_id).toBe("test-run-001");
    expect(readFileSync(path, "utf-8").endsWith("\n")).toBe(true);
  });

  it("preserves report.git_sha when provenance.gitSha is absent", () => {
    const path = join(tmp, "baseline.json");
    const written = writeBaseline(path, makeReport(), { username: "operator" });
    expect(written.git_sha).toBe("abc1234567890");
  });
});

describe("formatDiffTable", () => {
  it("renders all 4 canonical segments with baseline + current p95 + delta columns", () => {
    const report = makeReport();
    const baseline = makeBaseline();
    const out = formatDiffTable(report, baseline);
    expect(out).toContain("end_to_end");
    expect(out).toContain("first_token");
    expect(out).toContain("context_assemble");
    expect(out).toContain("tool_call");
    expect(out).toMatch(/Baseline p95/);
    expect(out).toMatch(/Current p95/);
    expect(out).toMatch(/Delta/);
    // Same values on both sides → zero delta
    expect(out).toMatch(/\+0 ms/);
    expect(out).toMatch(/\+0\.0%/);
  });

  it("renders regressions with positive delta when current > baseline", () => {
    const report = makeReport({
      overall_percentiles: [
        { segment: "end_to_end", p50: 1000, p95: 2600, p99: 3000, count: 25 },
        { segment: "first_token", p50: 400, p95: 800, p99: 1200, count: 25 },
        { segment: "context_assemble", p50: 50, p95: 100, p99: 150, count: 25 },
        { segment: "tool_call", p50: 75, p95: 150, p99: 225, count: 40 },
      ],
    });
    const baseline = makeBaseline();
    const out = formatDiffTable(report, baseline);
    // end_to_end delta = 2600 - 2000 = +600 ms, +30.0%
    expect(out).toMatch(/\+600 ms/);
    expect(out).toMatch(/\+30\.0%/);
  });

  it('returns "(no baseline yet)" for all segments when baseline is null', () => {
    const report = makeReport();
    const out = formatDiffTable(report, null);
    // All 4 segments should emit the "(no baseline yet)" sentinel in the
    // Baseline p95 column.
    const occurrences = out.split("(no baseline yet)").length - 1;
    expect(occurrences).toBe(4);
  });
});
