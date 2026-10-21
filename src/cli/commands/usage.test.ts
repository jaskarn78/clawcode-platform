import { describe, it, expect } from "vitest";
import { formatUsageTable } from "./usage.js";
import type { UsageResponse } from "./usage.js";

describe("formatUsageTable", () => {
  it("formats sample usage data with all fields", () => {
    const data: UsageResponse = {
      agent: "coder",
      period: "session",
      tokens_in: 15000,
      tokens_out: 8500,
      cost_usd: 0.1234,
      turns: 12,
      duration_ms: 125000,
      event_count: 5,
    };

    const result = formatUsageTable(data);
    expect(result).toContain("Usage for coder (session)");
    expect(result).toContain("Tokens In:    15000");
    expect(result).toContain("Tokens Out:   8500");
    expect(result).toContain("Total Cost:   $0.1234");
    expect(result).toContain("Turns:        12");
    expect(result).toContain("Duration:     2m 5s");
    expect(result).toContain("Events:       5");
  });

  it("formats zero-value aggregate correctly", () => {
    const data: UsageResponse = {
      agent: "idle-agent",
      period: "weekly",
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      turns: 0,
      duration_ms: 0,
      event_count: 0,
    };

    const result = formatUsageTable(data);
    expect(result).toContain("Usage for idle-agent (weekly)");
    expect(result).toContain("Tokens In:    0");
    expect(result).toContain("Tokens Out:   0");
    expect(result).toContain("Total Cost:   $0.0000");
    expect(result).toContain("Turns:        0");
    expect(result).toContain("Duration:     0s");
    expect(result).toContain("Events:       0");
  });

  it("formats duration under 1 minute as seconds only", () => {
    const data: UsageResponse = {
      agent: "test",
      period: "daily",
      tokens_in: 100,
      tokens_out: 200,
      cost_usd: 0.01,
      turns: 1,
      duration_ms: 45000,
      event_count: 1,
    };

    const result = formatUsageTable(data);
    expect(result).toContain("Duration:     45s");
  });
});
