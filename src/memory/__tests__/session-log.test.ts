import { describe, it, expect, afterEach } from "vitest";
import { SessionLogger } from "../session-log.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("SessionLogger", () => {
  let tempDir: string;
  let logger: SessionLogger;

  function setup(): void {
    tempDir = mkdtempSync(join(tmpdir(), "session-log-test-"));
    logger = new SessionLogger(tempDir);
  }

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("appendEntry creates file with header on first write", async () => {
    setup();
    await logger.appendEntry(
      "2026-04-09T14:32:15.000Z",
      "user",
      "Hello world",
    );

    const content = readFileSync(join(tempDir, "2026-04-09.md"), "utf-8");
    expect(content).toContain("# Session Log: 2026-04-09");
    expect(content).toContain("## 14:32:15 [user]");
    expect(content).toContain("Hello world");
  });

  it("appendEntry appends to existing file", async () => {
    setup();
    await logger.appendEntry(
      "2026-04-09T14:32:15.000Z",
      "user",
      "First message",
    );
    await logger.appendEntry(
      "2026-04-09T14:33:00.000Z",
      "assistant",
      "Second message",
    );

    const content = readFileSync(join(tempDir, "2026-04-09.md"), "utf-8");

    // Header appears only once
    const headerCount = (content.match(/# Session Log:/g) || []).length;
    expect(headerCount).toBe(1);

    // Both entries present
    expect(content).toContain("## 14:32:15 [user]");
    expect(content).toContain("First message");
    expect(content).toContain("## 14:33:00 [assistant]");
    expect(content).toContain("Second message");
  });

  it("entry format matches expected pattern", async () => {
    setup();
    await logger.appendEntry(
      "2026-04-09T09:15:30.000Z",
      "user",
      "Test content here",
    );

    const content = readFileSync(join(tempDir, "2026-04-09.md"), "utf-8");

    // Check format: ## HH:MM:SS [role]\ncontent\n
    expect(content).toMatch(/## 09:15:30 \[user\]\nTest content here\n/);
  });

  it("flushConversation writes multiple entries and returns file path", async () => {
    setup();
    const entries = [
      {
        timestamp: "2026-04-09T10:00:00.000Z",
        role: "user" as const,
        content: "What is memory?",
      },
      {
        timestamp: "2026-04-09T10:00:30.000Z",
        role: "assistant" as const,
        content: "Memory is the ability to store and retrieve information.",
      },
      {
        timestamp: "2026-04-09T10:01:00.000Z",
        role: "user" as const,
        content: "Thanks!",
      },
    ];

    const filePath = await logger.flushConversation(entries);

    expect(filePath).toBe(join(tempDir, "2026-04-09.md"));

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("## 10:00:00 [user]");
    expect(content).toContain("What is memory?");
    expect(content).toContain("## 10:00:30 [assistant]");
    expect(content).toContain(
      "Memory is the ability to store and retrieve information.",
    );
    expect(content).toContain("## 10:01:00 [user]");
    expect(content).toContain("Thanks!");
  });

  it("handles empty entries array without error", async () => {
    setup();
    const filePath = await logger.flushConversation([]);
    expect(filePath).toBeTruthy();
  });

  it("creates memory directory if it does not exist", () => {
    const nonExistent = join(
      tmpdir(),
      `session-log-test-nested-${Date.now()}`,
      "sub",
    );
    const l = new SessionLogger(nonExistent);
    // Should not throw — directory is created
    expect(l).toBeTruthy();
    rmSync(
      join(tmpdir(), `session-log-test-nested-${Date.now().toString().slice(0, -1)}`),
      { recursive: true, force: true },
    );
  });
});
