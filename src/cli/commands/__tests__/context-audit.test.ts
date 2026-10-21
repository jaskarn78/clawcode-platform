/**
 * Phase 53 Plan 01 — `clawcode context-audit` CLI formatter + registration tests.
 *
 * Pure-function formatters (no IPC, no daemon, no SQLite — those aggregator
 * behaviors are tested in src/performance/__tests__/context-audit.test.ts).
 * These tests cover the CLI-layer contract:
 *   - formatAuditTable: all 7 sections rendered, header present, empty fallback
 *   - registerContextAuditCommand: options wired (--since, --turns, etc.)
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";

import {
  formatAuditTable,
  registerContextAuditCommand,
} from "../context-audit.js";
import type { ContextAuditReport } from "../../../performance/context-audit.js";

function makeReport(
  overrides: Partial<ContextAuditReport> = {},
): ContextAuditReport {
  return Object.freeze({
    agent: "clawdy",
    since: "24h",
    sinceIso: "2026-04-13T00:00:00.000Z",
    sampledTurns: 25,
    sections: Object.freeze([
      Object.freeze({ sectionName: "identity" as const, p50: 100, p95: 100, count: 25 }),
      Object.freeze({ sectionName: "soul" as const, p50: 200, p95: 200, count: 25 }),
      Object.freeze({ sectionName: "skills_header" as const, p50: 300, p95: 300, count: 25 }),
      Object.freeze({ sectionName: "hot_tier" as const, p50: 400, p95: 400, count: 25 }),
      Object.freeze({ sectionName: "recent_history" as const, p50: 500, p95: 500, count: 25 }),
      Object.freeze({ sectionName: "per_turn_summary" as const, p50: 50, p95: 50, count: 25 }),
      Object.freeze({ sectionName: "resume_summary" as const, p50: 1000, p95: 1000, count: 25 }),
    ]),
    recommendations: Object.freeze({
      new_defaults: Object.freeze({
        identity: 120,
        soul: 240,
        skills_header: 360,
        hot_tier: 480,
        recent_history: 600,
        per_turn_summary: 60,
        resume_summary: 1200,
      }),
    }),
    resume_summary_over_budget_count: 0,
    git_sha: "abc1234",
    generated_at: "2026-04-14T00:00:00.000Z",
    warnings: Object.freeze([]),
    ...overrides,
  });
}

describe("formatAuditTable (Phase 53)", () => {
  it("renders each of the 7 canonical section names, p50/p95/count columns, and header", () => {
    const out = formatAuditTable(makeReport());
    expect(out).toContain("Context audit for clawdy (since 24h):");
    expect(out).toContain("Section");
    expect(out).toContain("p50 tok");
    expect(out).toContain("p95 tok");
    expect(out).toContain("Count");
    expect(out).toContain("identity");
    expect(out).toContain("soul");
    expect(out).toContain("skills_header");
    expect(out).toContain("hot_tier");
    expect(out).toContain("recent_history");
    expect(out).toContain("per_turn_summary");
    expect(out).toContain("resume_summary");
  });

  it("prints 'No context-assemble data for {agent}' when sampledTurns === 0", () => {
    const out = formatAuditTable(
      makeReport({
        sampledTurns: 0,
        sections: Object.freeze(
          [
            "identity",
            "soul",
            "skills_header",
            "hot_tier",
            "recent_history",
            "per_turn_summary",
            "resume_summary",
          ].map((n) =>
            Object.freeze({ sectionName: n as never, p50: null, p95: null, count: 0 }),
          ),
        ),
      }),
    );
    expect(out).toContain("No context-assemble data for clawdy");
    expect(out).not.toContain("p50 tok");
  });

  it("surfaces warnings and recommendations blocks when present", () => {
    const out = formatAuditTable(
      makeReport({
        warnings: Object.freeze(["minimum sampled turns not met (sampled=10, required>=20)"]),
      }),
    );
    expect(out).toContain("WARN:");
    expect(out).toContain("Recommended new_defaults");
    expect(out).toContain("identity: 120");
  });
});

describe("registerContextAuditCommand (Phase 53)", () => {
  it("registers a `context-audit` command with all expected options", () => {
    const program = new Command();
    registerContextAuditCommand(program);
    const cmd = program.commands.find((c) => c.name() === "context-audit");
    expect(cmd).toBeDefined();
    const optionFlags = (cmd?.options ?? []).map((o) => o.long);
    expect(optionFlags).toContain("--since");
    expect(optionFlags).toContain("--turns");
    expect(optionFlags).toContain("--min-turns");
    expect(optionFlags).toContain("--trace-store");
    expect(optionFlags).toContain("--json");
    expect(optionFlags).toContain("--out");
  });
});
