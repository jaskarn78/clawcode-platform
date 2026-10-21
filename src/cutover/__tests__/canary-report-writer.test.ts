/**
 * Phase 92 Plan 05 Task 1 (RED) — canary-report-writer tests.
 *
 * Pins the contract for `writeCanaryReport(deps)` defined in the plan's
 * <interfaces> block. RED gate: src/cutover/canary-report-writer.ts does
 * not yet exist so import-time failure triggers vitest red.
 *
 * Behavioral pins (D-08 / Plan 92-06 frontmatter consumer):
 *   P1 frontmatter: 40 results, 38 passed → canary_pass_rate: 95 +
 *                   total_invocations: 40 + passed: 38 + failed: 2 + generated_at present
 *   P2 table-shape: header row "| intent | prompt | discord-bot | api | discord-bot-ms | api-ms |"
 *   P3 atomic-write: after writeCanaryReport resolves, no .tmp leftovers and final file present
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";

import { writeCanaryReport } from "../canary-report-writer.js";
import type { CanaryInvocationResult } from "../types.js";

let outputDir: string;

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "cutover-canary-report-"));
});
afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

function makeResults(passCount: number, failCount: number): CanaryInvocationResult[] {
  // Each prompt contributes 2 results (discord-bot + api). Build half passed
  // discord-bot + half passed api up to passCount, then fill with failed.
  const total = passCount + failCount;
  const promptCount = Math.ceil(total / 2);
  const results: CanaryInvocationResult[] = [];
  let remainingPass = passCount;
  for (let i = 0; i < promptCount; i++) {
    const intent = `intent-${String(i).padStart(2, "0")}`;
    const prompt = `Please do task ${i}.`;
    const dStatus = remainingPass-- > 0 ? "passed" : "failed-error";
    const aStatus = remainingPass-- > 0 ? "passed" : "failed-error";
    results.push({
      intent,
      prompt,
      path: "discord-bot",
      status: dStatus as CanaryInvocationResult["status"],
      responseChars: dStatus === "passed" ? 50 : 0,
      durationMs: 1000 + i,
      error: dStatus === "passed" ? null : "synthetic failure",
    });
    results.push({
      intent,
      prompt,
      path: "api",
      status: aStatus as CanaryInvocationResult["status"],
      responseChars: aStatus === "passed" ? 60 : 0,
      durationMs: 800 + i,
      error: aStatus === "passed" ? null : "synthetic failure",
    });
  }
  return results.slice(0, total);
}

function extractFrontmatter(md: string): Record<string, unknown> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error("no frontmatter found in markdown");
  return parseYaml(m[1]!) as Record<string, unknown>;
}

describe("writeCanaryReport — P1 frontmatter shape", () => {
  it("38 of 40 passed → canary_pass_rate=95, total_invocations=40, passed=38, failed=2, generated_at present", async () => {
    const results = makeResults(38, 2);
    const outcome = await writeCanaryReport({
      agent: "fin-client",
      results,
      outputDir,
    });
    expect(outcome.kind).toBe("written");
    if (outcome.kind === "written") {
      const md = await readFile(outcome.reportPath, "utf8");
      const fm = extractFrontmatter(md);
      expect(fm.canary_pass_rate).toBe(95);
      expect(fm.total_invocations).toBe(40);
      expect(fm.passed).toBe(38);
      expect(fm.failed).toBe(2);
      expect(typeof fm.generated_at).toBe("string");
      expect((fm.generated_at as string).length).toBeGreaterThan(0);
    }
  });
});

describe("writeCanaryReport — P2 table column shape", () => {
  it("emitted markdown contains the canonical column header line", async () => {
    const results = makeResults(2, 0);
    const outcome = await writeCanaryReport({
      agent: "fin-client",
      results,
      outputDir,
    });
    expect(outcome.kind).toBe("written");
    if (outcome.kind === "written") {
      const md = await readFile(outcome.reportPath, "utf8");
      expect(md).toContain(
        "| intent | prompt | discord-bot | api | discord-bot-ms | api-ms |",
      );
    }
  });
});

describe("writeCanaryReport — P3 atomic write", () => {
  it("no .tmp leftovers in outputDir after writer resolves; final file present", async () => {
    const results = makeResults(4, 0);
    const outcome = await writeCanaryReport({
      agent: "fin-client",
      results,
      outputDir,
    });
    expect(outcome.kind).toBe("written");

    const dirEntries = await readdir(outputDir);
    // Exactly one entry — the CANARY-REPORT.md file. No .tmp leftovers.
    expect(dirEntries).toEqual(["CANARY-REPORT.md"]);
    expect(dirEntries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });
});
