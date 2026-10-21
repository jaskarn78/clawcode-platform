import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatStatusTable, formatUptime } from "../commands/status.js";
import type { RegistryEntry } from "../../manager/types.js";

// Strip ANSI escape codes for assertion clarity
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("formatUptime", () => {
  it("formats seconds when under 60s", () => {
    expect(formatUptime(5_000)).toBe("5s");
    expect(formatUptime(59_000)).toBe("59s");
  });

  it("formats minutes and seconds when under 60m", () => {
    expect(formatUptime(60_000)).toBe("1m 0s");
    expect(formatUptime(90_000)).toBe("1m 30s");
    expect(formatUptime(3_540_000)).toBe("59m 0s");
  });

  it("formats hours and minutes when under 24h", () => {
    expect(formatUptime(3_600_000)).toBe("1h 0m");
    expect(formatUptime(7_260_000)).toBe("2h 1m");
    expect(formatUptime(82_800_000)).toBe("23h 0m");
  });

  it("formats days and hours for 24h+", () => {
    expect(formatUptime(86_400_000)).toBe("1d 0h");
    expect(formatUptime(90_000_000)).toBe("1d 1h");
    expect(formatUptime(259_200_000)).toBe("3d 0h");
  });

  it("handles zero", () => {
    expect(formatUptime(0)).toBe("0s");
  });
});

describe("formatStatusTable", () => {
  const now = 1_700_000_000_000;

  const sampleEntries: readonly RegistryEntry[] = [
    {
      name: "coder",
      status: "running",
      sessionId: "sess-1",
      startedAt: now - 3_600_000, // 1 hour ago
      restartCount: 0,
      consecutiveFailures: 0,
      lastError: null,
      lastStableAt: now - 300_000,
    },
    {
      name: "researcher",
      status: "stopped",
      sessionId: null,
      startedAt: null,
      restartCount: 2,
      consecutiveFailures: 0,
      lastError: null,
      lastStableAt: null,
    },
    {
      name: "reviewer",
      status: "crashed",
      sessionId: null,
      startedAt: null,
      restartCount: 5,
      consecutiveFailures: 3,
      lastError: "Connection timeout",
      lastStableAt: null,
    },
  ] as const;

  it("formats a table with agent entries", () => {
    const result = formatStatusTable(sampleEntries, now);
    const plain = stripAnsi(result);

    // Header row
    expect(plain).toContain("NAME");
    expect(plain).toContain("STATUS");
    expect(plain).toContain("UPTIME");
    expect(plain).toContain("RESTARTS");

    // Agent rows
    expect(plain).toContain("coder");
    expect(plain).toContain("running");
    expect(plain).toContain("1h 0m");
    expect(plain).toContain("researcher");
    expect(plain).toContain("stopped");
    expect(plain).toContain("reviewer");
    expect(plain).toContain("crashed");
  });

  it("shows dash for uptime when not running", () => {
    const result = formatStatusTable(sampleEntries, now);
    const lines = stripAnsi(result).split("\n");

    // researcher (stopped) should show "-" for uptime
    const researcherLine = lines.find((l) => l.includes("researcher"));
    expect(researcherLine).toContain("-");
  });

  it("shows restart count", () => {
    const result = formatStatusTable(sampleEntries, now);
    const plain = stripAnsi(result);
    const lines = plain.split("\n");

    const reviewerLine = lines.find((l) => l.includes("reviewer"));
    expect(reviewerLine).toContain("5");
  });

  it("returns 'No agents configured' for empty array", () => {
    const result = formatStatusTable([]);
    expect(result).toBe("No agents configured");
  });

  it("applies ANSI colors to status values", () => {
    const result = formatStatusTable(sampleEntries, now);

    // Running should have green
    expect(result).toContain("\x1b[32m");
    // Crashed should have red
    expect(result).toContain("\x1b[31m");
    // Stopped should have dim
    expect(result).toContain("\x1b[2m");
  });
});

describe("CLI command modules", () => {
  it("start command exports registerStartCommand", async () => {
    const mod = await import("../commands/start.js");
    expect(typeof mod.registerStartCommand).toBe("function");
  });

  it("stop command exports registerStopCommand", async () => {
    const mod = await import("../commands/stop.js");
    expect(typeof mod.registerStopCommand).toBe("function");
  });

  it("restart command exports registerRestartCommand", async () => {
    const mod = await import("../commands/restart.js");
    expect(typeof mod.registerRestartCommand).toBe("function");
  });

  it("status command exports registerStatusCommand", async () => {
    const mod = await import("../commands/status.js");
    expect(typeof mod.registerStatusCommand).toBe("function");
  });
});
