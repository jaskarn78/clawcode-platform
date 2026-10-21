/**
 * Phase 999.130 — report card rubric + rendering.
 */

import { describe, it, expect } from "vitest";
import { gradeAgent, renderAgentLine, renderReportCard, type AgentWeekMetrics } from "../report-card.js";

const base: AgentWeekMetrics = {
  agent: "fin-client",
  turns: 140,
  turnsPrev: 120,
  costUsd: 12.4,
  costUsdPrev: 13.6,
  firstTokenP50Ms: 18_000,
  firstTokenP95Ms: 61_000,
  cacheHitRate: 0.72,
  memoriesNew: 37,
  memoriesNewPrev: 30,
  memoryProblems: [],
  incidentsWarning: 1,
  incidentsCritical: 0,
  openChecks: [],
  unverifiedFigures: 0,
  workflowsRun: 3,
  workflowsFailed: 0,
};

describe("gradeAgent", () => {
  it("is green when nothing trips the rubric", () => {
    expect(gradeAgent(base)).toEqual({ agent: "fin-client", grade: "green", reasons: [] });
  });

  it("yellow reasons: open checks, warning spam, slow p50, poor cache, memory problems, growth, unverified, partial workflow failures", () => {
    const g = gradeAgent({
      ...base,
      openChecks: ["memory-census"],
      incidentsWarning: 5,
      firstTokenP50Ms: 50_000,
      cacheHitRate: 0.2,
      memoryProblems: ["118 legacy cold archive file(s) on disk"],
      memoriesNew: 200,
      memoriesNewPrev: 30,
      unverifiedFigures: 2,
      workflowsFailed: 1,
    });
    expect(g.grade).toBe("yellow");
    expect(g.reasons).toEqual([
      "open: memory-census",
      "5 warning transitions",
      "first token p50 50s",
      "cache hit 20%",
      "memory: 118 legacy cold archive file(s) on disk",
      "memory growth 200 vs 30 last week",
      "2 unverified figure(s) in reports",
      "1/3 workflows failed",
    ]);
  });

  it("red beats yellow: critical incidents, p95 over 3 min, every workflow failed", () => {
    expect(gradeAgent({ ...base, incidentsCritical: 2 }).reasons[0]).toBe("2 critical incident(s)");
    expect(gradeAgent({ ...base, firstTokenP95Ms: 200_000 })).toMatchObject({ grade: "red", reasons: ["first token p95 200s"] });
    expect(gradeAgent({ ...base, workflowsRun: 2, workflowsFailed: 2 })).toMatchObject({ grade: "red", reasons: ["every workflow failed (2)"] });
  });

  it("does not judge cache on a quiet week or latency without data", () => {
    expect(gradeAgent({ ...base, turns: 5, cacheHitRate: 0.1 }).grade).toBe("green");
    expect(gradeAgent({ ...base, firstTokenP50Ms: null, firstTokenP95Ms: null }).grade).toBe("green");
  });
});

describe("rendering", () => {
  it("renders two lines per agent with deltas and the why line", () => {
    const g = gradeAgent({ ...base, incidentsWarning: 5 });
    const text = renderAgentLine({ ...base, incidentsWarning: 5 }, g);
    expect(text.split("\n")[0]).toBe("🟡 **fin-client** · 140 turns (▲17%) · $12.40 (▼9%) · first token p50 18s · cache 72%");
    expect(text.split("\n")[1]).toBe("-# memory +37 (▲23%) · incidents 5 warn / 0 crit · workflows 3/3 ok · unverified figures 0");
    expect(text.split("\n")[2]).toBe("-# why: 5 warning transitions");
  });

  it("orders the fleet card red, yellow, green and totals the header", () => {
    const card = renderReportCard({
      since: "2026-08-29T00:00:00.000Z",
      until: "2026-09-05T00:00:00.000Z",
      agents: [
        { metrics: base, grade: gradeAgent(base) },
        { metrics: { ...base, agent: "projects", turns: 20, incidentsCritical: 1 }, grade: gradeAgent({ ...base, agent: "projects", turns: 20, incidentsCritical: 1 }) },
        { metrics: { ...base, agent: "shopping", turns: 9, openChecks: ["inbox"] }, grade: gradeAgent({ ...base, agent: "shopping", turns: 9, openChecks: ["inbox"] }) },
      ],
    });
    const lines = card.split("\n");
    expect(lines[0]).toBe("📋 **Agent report card**");
    expect(lines[1]).toBe("-# 2026-08-29 to 2026-09-05 · 3 agents · 169 turns · $37.20 · 🟢 1 🟡 1 🔴 1");
    expect(card.indexOf("🔴 **projects**")).toBeLessThan(card.indexOf("🟡 **shopping**"));
    expect(card.indexOf("🟡 **shopping**")).toBeLessThan(card.indexOf("🟢 **fin-client**"));
    expect(renderReportCard({ since: "a", until: "b", agents: [] })).toBe("");
  });
});
