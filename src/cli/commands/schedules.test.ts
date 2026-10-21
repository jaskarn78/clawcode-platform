import { describe, it, expect } from "vitest";
import { formatSchedulesTable, formatNextRun } from "./schedules.js";

describe("formatNextRun", () => {
  const now = 1_700_000_000_000; // fixed reference point

  it("returns '-' for null timestamp", () => {
    expect(formatNextRun(null, now)).toBe("-");
  });

  it("formats seconds in the future", () => {
    const future = now + 30_000; // 30s from now
    expect(formatNextRun(future, now)).toBe("in 30s");
  });

  it("formats minutes in the future", () => {
    const future = now + 5 * 60_000; // 5m from now
    expect(formatNextRun(future, now)).toBe("in 5m");
  });

  it("formats hours in the future", () => {
    const future = now + 3 * 3_600_000; // 3h from now
    expect(formatNextRun(future, now)).toBe("in 3h");
  });

  it("formats days in the future", () => {
    const future = now + 2 * 86_400_000; // 2d from now
    expect(formatNextRun(future, now)).toBe("in 2d");
  });

  it("returns 'now' for timestamps in the past", () => {
    const past = now - 5_000;
    expect(formatNextRun(past, now)).toBe("now");
  });
});

describe("formatSchedulesTable", () => {
  const now = 1_700_000_000_000;

  it("returns 'No scheduled tasks' for empty schedules", () => {
    const result = formatSchedulesTable({ schedules: [] }, now);
    expect(result).toBe("No scheduled tasks");
  });

  it("shows columns AGENT, TASK, CRON, NEXT RUN, LAST STATUS", () => {
    const result = formatSchedulesTable(
      {
        schedules: [
          {
            name: "daily-summary",
            agentName: "atlas",
            cron: "0 9 * * *",
            enabled: true,
            lastRun: now - 60_000,
            lastStatus: "success",
            lastError: null,
            nextRun: now + 3_600_000,
          },
        ],
      },
      now,
    );
    expect(result).toContain("AGENT");
    expect(result).toContain("TASK");
    expect(result).toContain("CRON");
    expect(result).toContain("NEXT RUN");
    expect(result).toContain("LAST STATUS");
  });

  it("colorizes 'success' green", () => {
    const result = formatSchedulesTable(
      {
        schedules: [
          {
            name: "task1",
            agentName: "bot1",
            cron: "* * * * *",
            enabled: true,
            lastRun: now - 1000,
            lastStatus: "success",
            lastError: null,
            nextRun: now + 60_000,
          },
        ],
      },
      now,
    );
    // GREEN = \x1b[32m, RESET = \x1b[0m
    expect(result).toContain("\x1b[32msuccess\x1b[0m");
  });

  it("colorizes 'error' red and shows lastError", () => {
    const result = formatSchedulesTable(
      {
        schedules: [
          {
            name: "task2",
            agentName: "bot2",
            cron: "0 * * * *",
            enabled: true,
            lastRun: now - 1000,
            lastStatus: "error",
            lastError: "Connection timeout",
            nextRun: now + 60_000,
          },
        ],
      },
      now,
    );
    expect(result).toContain("\x1b[31merror\x1b[0m");
    expect(result).toContain("(Connection timeout)");
  });

  it("colorizes 'pending' dim", () => {
    const result = formatSchedulesTable(
      {
        schedules: [
          {
            name: "task3",
            agentName: "bot3",
            cron: "0 0 * * *",
            enabled: true,
            lastRun: null,
            lastStatus: "pending",
            lastError: null,
            nextRun: now + 60_000,
          },
        ],
      },
      now,
    );
    expect(result).toContain("\x1b[2mpending\x1b[0m");
  });

  it("shows '(disabled)' in dim for disabled schedules", () => {
    const result = formatSchedulesTable(
      {
        schedules: [
          {
            name: "task4",
            agentName: "bot4",
            cron: "0 0 * * *",
            enabled: false,
            lastRun: null,
            lastStatus: "pending",
            lastError: null,
            nextRun: null,
          },
        ],
      },
      now,
    );
    expect(result).toContain("\x1b[2m(disabled)\x1b[0m");
  });

  it("truncates long lastError to 40 chars", () => {
    const longError = "A".repeat(60);
    const result = formatSchedulesTable(
      {
        schedules: [
          {
            name: "task5",
            agentName: "bot5",
            cron: "0 * * * *",
            enabled: true,
            lastRun: now - 1000,
            lastStatus: "error",
            lastError: longError,
            nextRun: now + 60_000,
          },
        ],
      },
      now,
    );
    // Should contain truncated error (40 chars + "...")
    expect(result).toContain("(" + "A".repeat(40) + "...)");
  });

  it("formats nextRun as relative time", () => {
    const result = formatSchedulesTable(
      {
        schedules: [
          {
            name: "task6",
            agentName: "bot6",
            cron: "*/5 * * * *",
            enabled: true,
            lastRun: now - 60_000,
            lastStatus: "success",
            lastError: null,
            nextRun: now + 300_000, // 5 minutes
          },
        ],
      },
      now,
    );
    expect(result).toContain("in 5m");
  });

  it("handles mixed statuses in same table", () => {
    const result = formatSchedulesTable(
      {
        schedules: [
          {
            name: "task-a",
            agentName: "agent1",
            cron: "0 9 * * *",
            enabled: true,
            lastRun: now - 1000,
            lastStatus: "success",
            lastError: null,
            nextRun: now + 3_600_000,
          },
          {
            name: "task-b",
            agentName: "agent2",
            cron: "0 12 * * *",
            enabled: true,
            lastRun: now - 1000,
            lastStatus: "error",
            lastError: "Failed",
            nextRun: now + 7_200_000,
          },
          {
            name: "task-c",
            agentName: "agent3",
            cron: "0 0 * * *",
            enabled: false,
            lastRun: null,
            lastStatus: "pending",
            lastError: null,
            nextRun: null,
          },
        ],
      },
      now,
    );
    // All agents present
    expect(result).toContain("agent1");
    expect(result).toContain("agent2");
    expect(result).toContain("agent3");
    // Status colors
    expect(result).toContain("\x1b[32msuccess\x1b[0m");
    expect(result).toContain("\x1b[31merror\x1b[0m");
    expect(result).toContain("\x1b[2m(disabled)\x1b[0m");
  });
});
