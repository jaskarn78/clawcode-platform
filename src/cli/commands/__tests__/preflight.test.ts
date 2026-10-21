import { describe, expect, it } from "vitest";
import { evaluatePreflight, formatPreflight } from "../preflight.js";

describe("evaluatePreflight", () => {
  it("OK when memory below threshold and no inflight", () => {
    const r = evaluatePreflight({
      cgroup: { memoryPercent: 45 },
      broker: { inflightCount: 0 },
      memoryAbortPercent: 80,
    });
    expect(r.ok).toBe(true);
    expect(r.aborts).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.memoryPercent).toBe(45);
    expect(r.inflightCount).toBe(0);
  });

  it("ABORT when memoryPercent exceeds threshold", () => {
    const r = evaluatePreflight({
      cgroup: { memoryPercent: 97.8 },
      broker: { inflightCount: 0 },
      memoryAbortPercent: 80,
    });
    expect(r.ok).toBe(false);
    expect(r.aborts.some((a) => a.includes("97.8"))).toBe(true);
  });

  it("ABORT when broker inflight > 0", () => {
    const r = evaluatePreflight({
      cgroup: { memoryPercent: 30 },
      broker: { inflightCount: 3 },
      memoryAbortPercent: 80,
    });
    expect(r.ok).toBe(false);
    expect(r.aborts.some((a) => /in-flight/.test(a))).toBe(true);
  });

  it("warns (not aborts) when cgroup memory is unavailable", () => {
    const r = evaluatePreflight({
      cgroup: null,
      broker: { inflightCount: 0 },
      memoryAbortPercent: 80,
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => /cgroup memory unavailable/.test(w))).toBe(true);
  });

  it("aggregates multiple aborts when both conditions trip", () => {
    const r = evaluatePreflight({
      cgroup: { memoryPercent: 95 },
      broker: { inflightCount: 1 },
      memoryAbortPercent: 80,
    });
    expect(r.ok).toBe(false);
    expect(r.aborts.length).toBe(2);
  });
});

describe("formatPreflight", () => {
  it("renders OK header for ok results", () => {
    const r = evaluatePreflight({
      cgroup: { memoryPercent: 30 },
      broker: { inflightCount: 0 },
      memoryAbortPercent: 80,
    });
    expect(formatPreflight(r)).toMatch(/^OK/);
  });
  it("renders ABORT header and bullet list when not ok", () => {
    const r = evaluatePreflight({
      cgroup: { memoryPercent: 95 },
      broker: { inflightCount: 0 },
      memoryAbortPercent: 80,
    });
    const out = formatPreflight(r);
    expect(out).toMatch(/^ABORT/);
    expect(out).toContain("✗");
  });
});
