/**
 * Phase 92 Plan 06 Task 1 (RED) — report-writer tests.
 *
 * Pins the contract for `writeCutoverReport(deps)` and `readCutoverReport(path)`
 * defined in the plan's <interfaces> block. RED gate: src/cutover/report-writer.ts
 * does not yet exist — import-time failure triggers vitest red.
 *
 * Behavioral pins (D-09):
 *   WR1 happy-ready          : zero gaps + 40/40 canary passed → cutover_ready: true
 *                              + final line literally "Cutover ready: true"
 *   WR2 not-ready-destructive: 1 destructive gap → cutover_ready: false; markdown
 *                              body explains via /clawcode-cutover-verify
 *   WR3 not-ready-canary-fail: 39/40 canary passed → cutover_ready: false,
 *                              canary_pass_rate: 97.5
 *   WR4 round-trip           : write → readCutoverReport → frontmatter equals what
 *                              was written
 *   WR5 atomic-write         : write resolves cleanly; no .tmp lingers in outputDir
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as yamlParse } from "yaml";

import {
  writeCutoverReport,
  readCutoverReport,
} from "../report-writer.js";
import type {
  CanaryInvocationResult,
  CutoverGap,
  AdditiveApplyOutcome,
} from "../types.js";

let outputDir: string;

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "cutover-report-writer-"));
});
afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

function makeCanaryResults(passed: number, total: number): CanaryInvocationResult[] {
  const out: CanaryInvocationResult[] = [];
  for (let i = 0; i < total; i++) {
    out.push({
      intent: `intent-${i}`,
      prompt: `prompt ${i}`,
      path: i % 2 === 0 ? "discord-bot" : "api",
      status: i < passed ? "passed" : "failed-empty",
      responseChars: i < passed ? 100 : 0,
      durationMs: 50,
      error: null,
    });
  }
  return out;
}

const dryRunOutcome: AdditiveApplyOutcome = {
  kind: "dry-run",
  agent: "fin-client",
  plannedAdditive: 0,
  destructiveDeferred: 0,
};

describe("writeCutoverReport — WR1 happy-path-ready", () => {
  it("zero gaps + 40/40 canary passed → cutover_ready: true; final line is `Cutover ready: true`", async () => {
    const fixedNow = new Date("2026-04-25T12:00:00.000Z");
    const res = await writeCutoverReport({
      agent: "fin-client",
      gaps: [],
      canaryResults: makeCanaryResults(40, 40),
      additiveOutcome: dryRunOutcome,
      outputDir,
      now: () => fixedNow,
    });
    expect(res.kind).toBe("written");
    if (res.kind !== "written") return;
    expect(res.cutoverReady).toBe(true);

    const content = await readFile(res.reportPath, "utf8");
    const fmMatch = content.match(/^---\n([\s\S]+?)\n---\n/);
    expect(fmMatch).not.toBeNull();
    const fm = yamlParse(fmMatch![1]) as Record<string, unknown>;
    expect(fm.cutover_ready).toBe(true);
    expect(fm.gap_count).toBe(0);
    expect(fm.canary_pass_rate).toBe(100);
    expect(fm.canary_total_invocations).toBe(40);
    expect(fm.report_generated_at).toBe(fixedNow.toISOString());
    expect(fm.agent).toBe("fin-client");

    // E-LITERAL: final non-blank line must be exactly `Cutover ready: true`
    const lines = content.split("\n");
    let lastNonBlank = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i];
      if (s !== undefined && s.trim().length > 0) {
        lastNonBlank = s;
        break;
      }
    }
    expect(lastNonBlank).toBe("Cutover ready: true");
  });
});

describe("writeCutoverReport — WR2 not-ready-with-destructive-gap", () => {
  it("1 destructive gap → cutover_ready: false; mentions admin-clawdy/cutover-verify", async () => {
    const gaps: CutoverGap[] = [
      {
        kind: "outdated-memory-file",
        identifier: "memory/x.md",
        severity: "destructive",
        sourceRef: { path: "memory/x.md", sourceHash: "a".repeat(64) },
        targetRef: { path: "memory/x.md", targetHash: "b".repeat(64) },
      },
    ];
    const res = await writeCutoverReport({
      agent: "fin-client",
      gaps,
      canaryResults: makeCanaryResults(40, 40),
      additiveOutcome: dryRunOutcome,
      outputDir,
    });
    expect(res.kind).toBe("written");
    if (res.kind !== "written") return;
    expect(res.cutoverReady).toBe(false);

    const content = await readFile(res.reportPath, "utf8");
    const fmMatch = content.match(/^---\n([\s\S]+?)\n---\n/);
    const fm = yamlParse(fmMatch![1]) as Record<string, unknown>;
    expect(fm.cutover_ready).toBe(false);
    expect(fm.destructive_gap_count).toBe(1);
    expect(fm.gap_count).toBe(1);

    // markdown body must mention the operator action surface
    expect(content.toLowerCase()).toMatch(/clawcode-cutover-verify|admin-clawdy/);

    // final non-blank line literally `Cutover ready: false`
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines[lines.length - 1]).toBe("Cutover ready: false");
  });
});

describe("writeCutoverReport — WR3 not-ready-canary-fail", () => {
  it("39/40 canary passed → cutover_ready: false; canary_pass_rate: 97.5", async () => {
    const res = await writeCutoverReport({
      agent: "fin-client",
      gaps: [],
      canaryResults: makeCanaryResults(39, 40),
      additiveOutcome: dryRunOutcome,
      outputDir,
    });
    expect(res.kind).toBe("written");
    if (res.kind !== "written") return;
    expect(res.cutoverReady).toBe(false);

    const content = await readFile(res.reportPath, "utf8");
    const fm = yamlParse(content.match(/^---\n([\s\S]+?)\n---\n/)![1]) as Record<
      string,
      unknown
    >;
    expect(fm.cutover_ready).toBe(false);
    expect(fm.canary_pass_rate).toBe(97.5);
    expect(fm.gap_count).toBe(0);
  });
});

describe("writeCutoverReport — WR4 round-trip", () => {
  it("write → readCutoverReport → frontmatter parses back via schema", async () => {
    const fixedNow = new Date("2026-04-25T12:34:56.000Z");
    const wr = await writeCutoverReport({
      agent: "fin-client",
      gaps: [],
      canaryResults: makeCanaryResults(40, 40),
      additiveOutcome: dryRunOutcome,
      outputDir,
      now: () => fixedNow,
    });
    expect(wr.kind).toBe("written");
    if (wr.kind !== "written") return;

    const rr = await readCutoverReport(wr.reportPath);
    expect(rr.kind).toBe("read");
    if (rr.kind !== "read") return;
    expect(rr.frontmatter.agent).toBe("fin-client");
    expect(rr.frontmatter.cutover_ready).toBe(true);
    expect(rr.frontmatter.gap_count).toBe(0);
    expect(rr.frontmatter.canary_pass_rate).toBe(100);
    expect(rr.frontmatter.canary_total_invocations).toBe(40);
    expect(rr.frontmatter.report_generated_at).toBe(fixedNow.toISOString());
  });

  it("readCutoverReport on missing path → kind: missing", async () => {
    const rr = await readCutoverReport(join(outputDir, "does-not-exist.md"));
    expect(rr.kind).toBe("missing");
  });
});

describe("writeCutoverReport — WR5 atomic-write", () => {
  it("after write, no .tmp file lingers in outputDir; file exists at canonical path", async () => {
    const wr = await writeCutoverReport({
      agent: "fin-client",
      gaps: [],
      canaryResults: makeCanaryResults(40, 40),
      additiveOutcome: dryRunOutcome,
      outputDir,
    });
    expect(wr.kind).toBe("written");

    const entries = await readdir(outputDir);
    const tmpFiles = entries.filter((e) => e.includes(".tmp"));
    expect(tmpFiles.length).toBe(0);
    expect(entries).toContain("CUTOVER-REPORT.md");
  });
});
