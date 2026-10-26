import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  truncateSummary,
  saveSummary,
  loadLatestSummary,
  parseGeneratedTimestamp,
  isPlaceholderSummary,
  DEFAULT_RESUME_SUMMARY_MAX_AGE_MS,
} from "./context-summary.js";

describe("truncateSummary", () => {
  it("returns short text unchanged", () => {
    const text = "This is a short summary.";
    expect(truncateSummary(text)).toBe(text);
  });

  it("truncates text exceeding max words", () => {
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    const result = truncateSummary(text, 500);
    const resultWords = result.replace("...", "").trim().split(/\s+/);
    expect(resultWords.length).toBe(500);
    expect(result.endsWith("...")).toBe(true);
  });

  it("handles empty string", () => {
    expect(truncateSummary("")).toBe("");
  });

  it("respects custom max words", () => {
    const text = "one two three four five";
    const result = truncateSummary(text, 3);
    expect(result).toBe("one two three...");
  });

  it("returns text exactly at max words without truncation marker", () => {
    const text = "one two three";
    expect(truncateSummary(text, 3)).toBe("one two three");
  });
});

describe("saveSummary / loadLatestSummary", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ctx-summary-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves and loads a summary", async () => {
    await saveSummary(tmpDir, "test-agent", "Key facts from session.");
    const loaded = await loadLatestSummary(tmpDir);
    expect(loaded).toBe("Key facts from session.");
  });

  it("creates the file with markdown header", async () => {
    await saveSummary(tmpDir, "researcher", "Some summary text.");
    const content = readFileSync(
      join(tmpDir, "context-summary.md"),
      "utf-8",
    );
    expect(content).toContain("# Context Summary");
    expect(content).toContain("**Agent:** researcher");
    expect(content).toContain("Some summary text.");
  });

  it("overwrites previous summary", async () => {
    await saveSummary(tmpDir, "agent", "First summary.");
    await saveSummary(tmpDir, "agent", "Second summary.");
    const loaded = await loadLatestSummary(tmpDir);
    expect(loaded).toBe("Second summary.");
  });

  it("returns undefined when no summary exists", async () => {
    const result = await loadLatestSummary(tmpDir);
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty summary body", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(tmpDir, "context-summary.md"),
      "# Context Summary\n\n**Agent:** test\n**Generated:** 2026-04-09T00:00:00.000Z\n\n",
      "utf-8",
    );
    const result = await loadLatestSummary(tmpDir);
    expect(result).toBeUndefined();
  });

  it("creates directory if it does not exist", async () => {
    const nestedDir = join(tmpDir, "nested", "memory");
    await saveSummary(nestedDir, "agent", "Summary.");
    expect(existsSync(join(nestedDir, "context-summary.md"))).toBe(true);
  });
});

// Memory overhaul WP6 (2026-10-25): the resume summary read at boot skips the
// heartbeat placeholder and anything older than 7 days.
describe("loadLatestSummary staleness guards (WP6)", () => {
  let tmpDir: string;
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Fixed clock: 2026-10-25T12:00:00Z.
  const NOW = Date.parse("2026-10-25T12:00:00.000Z");

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ctx-summary-wp6-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function writeSummaryFile(generated: string | null, body: string): Promise<void> {
    const { writeFile } = await import("node:fs/promises");
    const header = ["# Context Summary", "", "**Agent:** test"];
    if (generated !== null) header.push(`**Generated:** ${generated}`);
    await writeFile(
      join(tmpDir, "context-summary.md"),
      [...header, "", body, ""].join("\n"),
      "utf-8",
    );
  }

  it("the default age ceiling is 7 days", () => {
    expect(DEFAULT_RESUME_SUMMARY_MAX_AGE_MS).toBe(7 * DAY_MS);
  });

  it("skips a file whose body is only the heartbeat zone-snapshot placeholder", async () => {
    await writeSummaryFile("2026-10-25 04:00:00 PDT", "Auto-snapshot at 85% context fill [red zone]");
    expect(await loadLatestSummary(tmpDir, { now: NOW })).toBeUndefined();
    // Same result without a clock override (the placeholder check is not age based).
    expect(await loadLatestSummary(tmpDir)).toBeUndefined();
  });

  it("skips the placeholder written through saveSummary (production writer shape)", async () => {
    await saveSummary(tmpDir, "agent", "Auto-snapshot at 72% context fill [yellow zone]");
    expect(await loadLatestSummary(tmpDir)).toBeUndefined();
  });

  it("keeps a multi-line summary that merely starts with the placeholder words", async () => {
    const body = "Auto-snapshot at 85% context fill [red zone]\nKey context: user is migrating the billing job.";
    await writeSummaryFile("2026-10-25 04:00:00 PDT", body);
    expect(await loadLatestSummary(tmpDir, { now: NOW })).toBe(body);
  });

  it("returns a real summary written within the last 7 days", async () => {
    await writeSummaryFile("2026-10-19T12:00:00.000Z", "Key context from previous session: deploy is blocked on DNS.");
    expect(await loadLatestSummary(tmpDir, { now: NOW })).toBe(
      "Key context from previous session: deploy is blocked on DNS.",
    );
  });

  it("ignores a summary whose Generated timestamp is older than 7 days", async () => {
    await writeSummaryFile("2026-10-18T11:59:59.000Z", "Old facts that are no longer current.");
    expect(await loadLatestSummary(tmpDir, { now: NOW })).toBeUndefined();
  });

  it("parses the agent-visible header format (zone abbreviation) for the age check", async () => {
    // 2026-10-17 09:00 PDT is 8 days before NOW.
    await writeSummaryFile("2026-10-17 09:00:00 PDT", "Stale.");
    expect(await loadLatestSummary(tmpDir, { now: NOW })).toBeUndefined();
    // 2026-10-24 09:00 PDT is about 1 day before NOW.
    await writeSummaryFile("2026-10-24 09:00:00 PDT", "Fresh.");
    expect(await loadLatestSummary(tmpDir, { now: NOW })).toBe("Fresh.");
  });

  it("honours a custom maxAgeMs", async () => {
    await writeSummaryFile("2026-10-24T12:00:00.000Z", "One day old.");
    expect(await loadLatestSummary(tmpDir, { now: NOW, maxAgeMs: 12 * 60 * 60 * 1000 })).toBeUndefined();
    expect(await loadLatestSummary(tmpDir, { now: NOW, maxAgeMs: 2 * DAY_MS })).toBe("One day old.");
  });

  it("keeps the summary when the Generated header is missing or unparseable (no evidence it is stale)", async () => {
    await writeSummaryFile("invalid date", "Header could not be rendered.");
    expect(await loadLatestSummary(tmpDir, { now: NOW })).toBe("Header could not be rendered.");
  });

  it("a summary saved now is still returned; the same file read 8 days later is not", async () => {
    await saveSummary(tmpDir, "agent", "Fresh summary.", "UTC");
    expect(await loadLatestSummary(tmpDir)).toBe("Fresh summary.");
    expect(await loadLatestSummary(tmpDir, { now: Date.now() + 8 * DAY_MS })).toBeUndefined();
  });
});

describe("parseGeneratedTimestamp (WP6)", () => {
  it("parses ISO timestamps", () => {
    expect(parseGeneratedTimestamp(" 2026-10-25T14:00:00.000Z")).toBe(Date.parse("2026-10-25T14:00:00.000Z"));
  });

  it("parses the renderAgentVisibleTimestamp shape with US and GMT offset zones", () => {
    expect(parseGeneratedTimestamp("2026-10-25 14:00:00 PDT")).toBe(Date.parse("2026-10-25T21:00:00.000Z"));
    expect(parseGeneratedTimestamp("2026-10-25 14:00:00 UTC")).toBe(Date.parse("2026-10-25T14:00:00.000Z"));
    expect(parseGeneratedTimestamp("2026-10-25 14:00:00 GMT+2")).toBe(Date.parse("2026-10-25T12:00:00.000Z"));
  });

  it("falls back to reading the wall clock as UTC for an unknown zone abbreviation", () => {
    expect(parseGeneratedTimestamp("2026-10-25 14:00:00 CEST")).toBe(Date.parse("2026-10-25T14:00:00.000Z"));
  });

  it("returns undefined for empty or non-date text", () => {
    expect(parseGeneratedTimestamp("")).toBeUndefined();
    expect(parseGeneratedTimestamp("invalid date")).toBeUndefined();
  });
});

describe("isPlaceholderSummary (WP6)", () => {
  it("matches only a single-line heartbeat placeholder", () => {
    expect(isPlaceholderSummary("Auto-snapshot at 85% context fill [red zone]")).toBe(true);
    expect(isPlaceholderSummary("  Auto-snapshot at 60% context fill [yellow zone]\n")).toBe(true);
    expect(isPlaceholderSummary("Auto-snapshot at 85%\nplus real content")).toBe(false);
    expect(isPlaceholderSummary("Key context from previous session")).toBe(false);
  });
});
