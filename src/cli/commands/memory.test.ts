import { describe, it, expect } from "vitest";
import { formatSearchResults, formatMemoryList } from "./memory.js";

describe("formatSearchResults", () => {
  it("returns no results message for empty results", () => {
    const result = formatSearchResults({ results: [] });
    expect(result).toBe("No results found");
  });

  it("formats results with rank, score, and content", () => {
    const result = formatSearchResults({
      results: [
        {
          id: "abc123",
          content: "The user prefers TypeScript",
          source: "conversation",
          importance: 0.8,
          accessCount: 5,
          tier: "warm",
          createdAt: "2026-04-09T10:00:00Z",
          score: 0.923,
          distance: 0.15,
        },
        {
          id: "def456",
          content: "Project uses vitest for testing",
          source: "observation",
          importance: 0.6,
          accessCount: 2,
          tier: "hot",
          createdAt: "2026-04-08T14:00:00Z",
          score: 0.812,
          distance: 0.25,
        },
      ],
    });

    expect(result).toContain("Memory Search Results");
    expect(result).toContain("SCORE");
    expect(result).toContain("CONTENT");
    expect(result).toContain("0.923");
    expect(result).toContain("TypeScript");
    expect(result).toContain("0.812");
    expect(result).toContain("vitest");
  });

  it("truncates long content", () => {
    const longContent = "a".repeat(100);
    const result = formatSearchResults({
      results: [
        {
          id: "x",
          content: longContent,
          source: "test",
          importance: 0.5,
          accessCount: 0,
          tier: "warm",
          createdAt: "2026-04-09T00:00:00Z",
          score: 0.5,
          distance: 0.5,
        },
      ],
    });

    expect(result).toContain("...");
    // Content should be truncated to 60 chars + "..."
    expect(result).not.toContain(longContent);
  });
});

describe("formatMemoryList", () => {
  it("returns no memories message for empty list", () => {
    const result = formatMemoryList({ entries: [] });
    expect(result).toBe("No memories found");
  });

  it("formats entries with id, content, tier, and accesses", () => {
    const result = formatMemoryList({
      entries: [
        {
          id: "abc123defghijk",
          content: "User is building a multi-agent system",
          source: "conversation",
          importance: 0.7,
          accessCount: 3,
          tier: "warm",
          createdAt: "2026-04-09T10:00:00Z",
          accessedAt: "2026-04-09T12:00:00Z",
        },
      ],
    });

    expect(result).toContain("Agent Memories");
    expect(result).toContain("abc123de"); // truncated ID
    expect(result).toContain("multi-agent");
    expect(result).toContain("warm");
    expect(result).toContain("3");
    expect(result).toContain("2026-04-09");
  });
});
