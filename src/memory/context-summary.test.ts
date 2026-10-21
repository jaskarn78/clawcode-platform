import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  truncateSummary,
  saveSummary,
  loadLatestSummary,
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
