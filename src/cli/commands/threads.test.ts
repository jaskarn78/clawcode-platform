import { describe, it, expect } from "vitest";
import { formatThreadsTable, formatTimeAgo } from "./threads.js";

describe("formatTimeAgo", () => {
  const now = 1_700_000_000_000;

  it("returns 'just now' for timestamps less than a minute ago", () => {
    expect(formatTimeAgo(now - 30_000, now)).toBe("just now");
  });

  it("formats minutes ago", () => {
    expect(formatTimeAgo(now - 5 * 60_000, now)).toBe("5m ago");
  });

  it("formats hours and minutes ago", () => {
    expect(formatTimeAgo(now - (2 * 3_600_000 + 15 * 60_000), now)).toBe("2h 15m ago");
  });

  it("formats exact hours ago without minutes", () => {
    expect(formatTimeAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
  });

  it("formats days ago", () => {
    expect(formatTimeAgo(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("returns 'just now' for future timestamps", () => {
    expect(formatTimeAgo(now + 5_000, now)).toBe("just now");
  });
});

describe("formatThreadsTable", () => {
  const now = 1_700_000_000_000;

  it("returns empty message for no bindings", () => {
    const result = formatThreadsTable({ bindings: [] }, now);
    expect(result).toBe("No active thread bindings");
  });

  it("shows title and column headers", () => {
    const result = formatThreadsTable(
      {
        bindings: [
          {
            threadId: "000000000000000103",
            parentChannelId: "000000000000000124",
            agentName: "claw",
            sessionName: "claw-thread-000000000000000103",
            createdAt: now - 2 * 3_600_000,
            lastActivity: now - 5 * 60_000,
          },
        ],
      },
      now,
    );
    expect(result).toContain("Active Thread Bindings");
    expect(result).toContain("AGENT");
    expect(result).toContain("THREAD ID");
    expect(result).toContain("SESSION NAME");
    expect(result).toContain("PARENT CHANNEL");
    expect(result).toContain("AGE");
    expect(result).toContain("LAST ACTIVE");
  });

  it("formats binding data correctly", () => {
    const result = formatThreadsTable(
      {
        bindings: [
          {
            threadId: "000000000000000103",
            parentChannelId: "000000000000000124",
            agentName: "claw",
            sessionName: "claw-thread-123",
            createdAt: now - 2 * 3_600_000,
            lastActivity: now - 5 * 60_000,
          },
        ],
      },
      now,
    );
    expect(result).toContain("claw");
    expect(result).toContain("000000000000000103");
    expect(result).toContain("claw-thread-123");
    expect(result).toContain("000000000000000124");
    expect(result).toContain("2h ago");
    expect(result).toContain("5m ago");
  });

  it("handles multiple bindings", () => {
    const result = formatThreadsTable(
      {
        bindings: [
          {
            threadId: "111",
            parentChannelId: "aaa",
            agentName: "agent1",
            sessionName: "agent1-thread-111",
            createdAt: now - 3_600_000,
            lastActivity: now - 60_000,
          },
          {
            threadId: "222",
            parentChannelId: "bbb",
            agentName: "agent2",
            sessionName: "agent2-thread-222",
            createdAt: now - 7_200_000,
            lastActivity: now - 300_000,
          },
        ],
      },
      now,
    );
    expect(result).toContain("agent1");
    expect(result).toContain("agent2");
    expect(result).toContain("111");
    expect(result).toContain("222");
  });
});
