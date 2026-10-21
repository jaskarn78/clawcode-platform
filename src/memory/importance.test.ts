import { describe, it, expect } from "vitest";
import { calculateImportance } from "./importance.js";

describe("calculateImportance", () => {
  it("returns low score for empty string (recency boost only)", () => {
    const score = calculateImportance("");
    expect(score).toBeCloseTo(0.2, 1);
  });

  it("returns low score for short text (< 0.3)", () => {
    const score = calculateImportance("short");
    expect(score).toBeLessThan(0.3);
  });

  it("returns high score for long text with code and proper nouns (> 0.6)", () => {
    const content = `
      This is a detailed memory about the ClawCode system written by Example User.
      It contains important architectural decisions about the Agent Manager.

      \`\`\`typescript
      export class AgentManager {
        private readonly agents: Map<string, Agent> = new Map();
        start(name: string): void { /* ... */ }
      }
      \`\`\`

      The system processes 1500 requests per hour with 14 agents running.
      Node.js version 22 is required for better-sqlite3 compatibility.
      The Discord integration uses channel 987654321.
    `;
    const score = calculateImportance(content);
    expect(score).toBeGreaterThan(0.6);
  });

  it("always returns value between 0.0 and 1.0", () => {
    const testCases = [
      "",
      "x",
      "a".repeat(10000),
      "```code```".repeat(50),
      "The Quick Brown Fox Jumped Over 123 456 789",
    ];

    for (const content of testCases) {
      const score = calculateImportance(content);
      expect(score).toBeGreaterThanOrEqual(0.0);
      expect(score).toBeLessThanOrEqual(1.0);
    }
  });

  it("gives higher score to content with code blocks", () => {
    const withCode = "Some text\n```js\nconsole.log('hi');\n```\nMore text";
    const withoutCode = "Some text\nMore text without code blocks at all";
    expect(calculateImportance(withCode)).toBeGreaterThan(calculateImportance(withoutCode));
  });

  it("gives higher score to content with numbers", () => {
    const withNumbers = "The system uses port 8080 and handles 500 requests with 14 workers";
    const withoutNumbers = "The system uses a port and handles requests with workers";
    expect(calculateImportance(withNumbers)).toBeGreaterThan(calculateImportance(withoutNumbers));
  });
});
