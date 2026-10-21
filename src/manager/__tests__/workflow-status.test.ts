/**
 * Phase 999.165 slice 2 — activity labels are allowlisted per tool (they land
 * in Discord channels), and the ETA never guesses before a step has finished.
 */
import { describe, expect, it } from "vitest";
import { estimateWorkflowEta, median, summarizeToolUse, type EtaStep } from "../workflow-status.js";
import {
  renderEditResultText,
  renderEta,
  renderProgressPing,
  renderSteerResultText,
  renderWorkflowDetailText,
} from "../workflow-status-render.js";
import type { WorkflowDetail } from "../workflow-orchestrator.js";
import { IconRegistry } from "../../discord/icons.js";

describe("summarizeToolUse — allowlisted, secret-safe labels", () => {
  it("search shows the query, clipped", () => {
    expect(summarizeToolUse("WebSearch", { query: "discord components v2" })).toBe('searching "discord components v2"');
    expect(summarizeToolUse("WebSearch", { query: "x".repeat(200) }).length).toBeLessThanOrEqual(62);
  });
  it("web fetch shows the host only — never the path or query string", () => {
    const label = summarizeToolUse("WebFetch", { url: "https://api.example.invalid/v1/items?token=abc123" });
    expect(label).toBe("reading api.example.invalid");
    expect(summarizeToolUse("WebFetch", { url: "not a url" })).toBe("reading a web page");
  });
  it("file tools show the base name only", () => {
    expect(summarizeToolUse("Read", { file_path: "/home/clawcode/.clawcode/agents/x/secrets/notes.md" })).toBe("reading notes.md");
    expect(summarizeToolUse("Write", { file_path: "C:\\\\work\\\\mockup.html" })).toBe("writing mockup.html");
    expect(summarizeToolUse("Edit", {})).toBe("editing a file");
  });
  it("shell shows the program only — no env assignments, no arguments", () => {
    expect(summarizeToolUse("Bash", { command: "OP_TOKEN=ops_abc sudo /usr/bin/psql -h db -U admin -W hunter2" })).toBe("running psql");
    expect(summarizeToolUse("Bash", { command: "git push origin main" })).toBe("running git");
    expect(summarizeToolUse("Bash", {})).toBe("running a command");
  });
  it("MCP tools show server and tool; everything else only its name", () => {
    expect(summarizeToolUse("mcp__finnhub__quote", { symbol: "AAPL", apiKey: "k" })).toBe("finnhub: quote");
    expect(summarizeToolUse("Grep", { pattern: "password=.*" })).toBe("searching files");
    expect(summarizeToolUse("SomeNewTool", { secret: "s" })).toBe("SomeNewTool");
  });
});

describe("estimateWorkflowEta", () => {
  const MIN = 60_000;
  const base = { now: 100 * MIN, poolSize: 3, currentWave: 1, totalWaves: 2, reportStepPending: false };
  it("no finished step → no estimate", () => {
    const steps: EtaStep[] = [{ wave: 1, status: "running", startedAt: 90 * MIN }];
    expect(estimateWorkflowEta({ ...base, steps })).toEqual({ kind: "unknown", reason: "estimating once the first step finishes" });
  });
  it("running remainder + queued work over the pool + later waves + report", () => {
    const steps: EtaStep[] = [
      { wave: 1, status: "done", startedAt: 80 * MIN, settledAt: 90 * MIN }, // 10m
      { wave: 1, status: "done", startedAt: 86 * MIN, settledAt: 100 * MIN }, // 14m → median 12m
      { wave: 1, status: "running", startedAt: 96 * MIN }, // 4m in → 8m left
      { wave: 1, status: "queued" },
      { wave: 2, status: "queued" },
      { wave: 2, status: "queued" },
      { wave: 2, status: "queued" },
      { wave: 2, status: "queued" },
    ];
    const eta = estimateWorkflowEta({ ...base, steps, reportStepPending: true });
    // Wave 1: max(8m, (8m + 12m)/3) = 8m. Wave 2: ceil(4/3)=2 batches × 12m = 24m. Report: 12m.
    expect(eta).toEqual({ kind: "estimate", remainingMs: 44 * MIN, medianStepMs: 12 * MIN, basisSteps: 2 });
  });
  it("skipped and cancelled steps add nothing", () => {
    const steps: EtaStep[] = [
      { wave: 1, status: "done", startedAt: 0, settledAt: 10 * MIN },
      { wave: 2, status: "cancelled" },
      { wave: 2, status: "skipped" },
    ];
    const eta = estimateWorkflowEta({ ...base, steps });
    expect(eta.kind === "estimate" && eta.remainingMs).toBe(0);
  });
  it("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("renderers", () => {
  const detail: WorkflowDetail = {
    workflowId: "wf_abc123",
    parentAgentName: "projects",
    status: "running",
    ageMs: 14 * 60_000,
    workers: { total: 3, running: 1, done: 1, failed: 1 },
    lastProgressAt: 0,
    plannedSteps: 4,
    waves: { current: 1, total: 2 },
    currentWave: 1,
    totalWaves: 2,
    eta: { kind: "estimate", remainingMs: 22 * 60_000, medianStepMs: 7 * 60_000, basisSteps: 1 },
    steps: [
      { stepId: "research", wave: 1, status: "done", elapsedMs: 7 * 60_000 },
      { stepId: "cv2", wave: 1, status: "running", elapsedMs: 6 * 60_000, activity: { label: 'searching "cv2"', agoMs: 20_000 }, toolCalls: 14 },
      { stepId: "d1", wave: 1, status: "failed", elapsedMs: 3 * 60_000, note: "turn failed: model overloaded" },
      { stepId: "synth", wave: 2, status: "queued" },
    ],
  };
  it("progress ping: header with ETA, a line per running step, then counts (no registry → no glyph)", () => {
    expect(renderProgressPing(detail)).toBe(
      "Workflow `wf_abc123` — 1/4 step(s) done · wave 1/2 · ETA ~22m (median step 7m over 1 finished)\n" +
        '• `cv2` — 6m · searching "cv2"\n' +
        "1 queued · 1 failed",
    );
  });
  it("detail view: every step by wave with status, activity and failure note (no registry → words only)", () => {
    const text = renderWorkflowDetailText(detail);
    expect(text).toContain("wf_abc123 · projects — running · 1/4 step(s) done · wave 1/2 · 14m old");
    expect(text).toContain("Wave 1\n  research — done in 7m");
    expect(text).toContain('  cv2 — running 6m · searching "cv2" · 14 tool call(s)');
    expect(text).toContain("  d1 — failed after 3m: turn failed: model overloaded");
    expect(text).toContain("Wave 2\n  · synth — queued");
  });
  it("999.178 R1 — with a loaded registry the glyphs render as cc_* custom emoji, never Unicode", () => {
    const reg = new IconRegistry();
    reg.setAll([
      { id: "1", name: "cc_hourglass" },
      { id: "2", name: "cc_circle_check" },
      { id: "3", name: "cc_circle_x" },
    ]);
    const ping = renderProgressPing(detail, reg);
    expect(ping.startsWith("<:cc_hourglass:1> Workflow")).toBe(true);
    const text = renderWorkflowDetailText(detail, reg);
    expect(text).toContain("  <:cc_circle_check:2> research — done in 7m");
    expect(text).toContain("  <:cc_hourglass:1> cv2 — running 6m");
    expect(text).toContain("  <:cc_circle_x:3> d1 — failed after 3m");
    // No Unicode status glyph survives once the set is loaded.
    for (const glyph of ["⏳", "✅", "❌", "🛑", "⏭️"]) {
      expect(ping).not.toContain(glyph);
      expect(text).not.toContain(glyph);
    }
  });
  it("ETA wording", () => {
    expect(renderEta({ kind: "unknown", reason: "estimating once the first step finishes" })).toBe(
      "ETA: estimating once the first step finishes",
    );
  });
});

describe("steer / edit wording", () => {
  it("says exactly what happened to each step", () => {
    expect(
      renderSteerResultText("wf_x", { status: "steered", injected: ["a"], restarted: ["b"], amended: ["c"], limited: ["d"] }),
    ).toBe(
      "Steered wf_x: delivered into the running turn of a; restarting b with it (that attempt's progress so far is discarded); " +
        "added to c, which start later; d already restarted 3 times — not changed.",
    );
    expect(renderSteerResultText("wf_x", { status: "nothing-to-steer" })).toMatch(/no running or pending steps/);
    expect(renderSteerResultText("wf_x", { status: "already-cancelled", by: "a" })).toBe("wf_x was already cancelled by a.");
  });
  it("edit outcomes", () => {
    expect(renderEditResultText("wf_x", { status: "added", stepId: "s9", wave: 2, live: false })).toBe("Added s9 to wave 2 of wf_x.");
    expect(renderEditResultText("wf_x", { status: "added", stepId: "s9", wave: 1, live: true })).toMatch(/starts as soon as a worker slot frees/);
    expect(renderEditResultText("wf_x", { status: "step-running", stepId: "s1" })).toMatch(/restart: true.*steer_workflow/);
    expect(renderEditResultText("wf_x", { status: "invalid", reason: "stepId s1 is already used in this workflow" })).toBe(
      "Could not edit wf_x: stepId s1 is already used in this workflow.",
    );
    expect(renderEditResultText("wf_x", { status: "step-will-skip", stepId: "s2" })).toMatch(/will be skipped/);
  });
});
