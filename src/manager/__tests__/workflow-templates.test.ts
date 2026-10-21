/**
 * Phase 999.128 — named workflow templates: validation, merge, resolution.
 */

import { describe, it, expect } from "vitest";
import {
  describeTemplates,
  mergeTemplates,
  resolveWorkflowTemplate,
  templatePlaceholders,
  validateWorkflowTemplate,
  type WorkflowTemplate,
} from "../workflow-templates.js";

const scan: WorkflowTemplate = {
  name: "market-scan",
  description: "Weekly scan of one ticker",
  params: [
    { name: "ticker", description: "Symbol to scan" },
    { name: "horizon", default: "1 week" },
  ],
  waves: [
    [
      { stepId: "news-{{ticker}}", prompt: "Collect news on {{ticker}} over the last {{horizon}}.", mcpServers: ["search"] },
      { stepId: "filings", prompt: "Pull the latest filings for {{ ticker }}." },
    ],
    [{ stepId: "synthesis", prompt: "Combine the earlier results for {{ticker}}." }],
  ],
};

describe("workflow templates", () => {
  it("finds placeholders and validates declarations, shapes and names", () => {
    expect(templatePlaceholders(scan)).toEqual(["horizon", "ticker"]);
    expect(validateWorkflowTemplate(scan)).toEqual([]);
    expect(validateWorkflowTemplate({ name: "bad name!", steps: [{ stepId: "a", prompt: "Do {{x}}" }] })).toEqual([
      'template name "bad name!" must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/',
      'template "bad name!": prompt uses {{x}} but params does not declare it',
    ]);
    expect(validateWorkflowTemplate({ name: "both", steps: [], waves: [] })).toContain(
      'template "both" must declare exactly one of steps or waves',
    );
    expect(validateWorkflowTemplate({ name: "empty", steps: [{ stepId: "", prompt: " " }] })).toEqual([
      'template "empty": a step has an empty stepId',
      'template "empty": step "" has an empty prompt',
    ]);
  });

  it("per-agent templates override fleet templates by name", () => {
    const merged = mergeTemplates(
      [scan, { name: "audit", steps: [{ stepId: "a", prompt: "fleet audit" }] }],
      [{ name: "audit", steps: [{ stepId: "a", prompt: "agent audit" }] }],
    );
    expect(merged.map((t) => t.name)).toEqual(["audit", "market-scan"]);
    expect(merged[0]!.steps?.[0]!.prompt).toBe("agent audit");
  });

  it("resolves a template into a spec with substituted prompts and step ids, defaults applied", () => {
    const r = resolveWorkflowTemplate([scan], "market-scan", { ticker: "NVDA" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params).toEqual({ ticker: "NVDA", horizon: "1 week" });
    expect(r.spec.waves?.[0]?.[0]).toEqual({
      stepId: "news-NVDA",
      prompt: "Collect news on NVDA over the last 1 week.",
      mcpServers: ["search"],
    });
    expect(r.spec.waves?.[0]?.[1]?.prompt).toBe("Pull the latest filings for NVDA.");
    expect(r.spec.waves?.[1]?.[0]?.prompt).toBe("Combine the earlier results for NVDA.");
    expect(r.spec.steps).toBeUndefined();
  });

  it("reports unknown template, missing and unknown params, and a broken template", () => {
    const unknown = resolveWorkflowTemplate([scan], "nope");
    expect(unknown).toMatchObject({ ok: false, reason: "unknown-template" });
    expect(!unknown.ok && unknown.message).toContain("available: market-scan");
    const missing = resolveWorkflowTemplate([scan], "market-scan", {});
    expect(missing).toMatchObject({ ok: false, reason: "missing-params", message: 'template "market-scan" needs: ticker' });
    const extra = resolveWorkflowTemplate([scan], "market-scan", { ticker: "NVDA", foo: "bar" });
    expect(extra).toMatchObject({ ok: false, reason: "unknown-params" });
    expect(!extra.ok && extra.message).toContain("does not take: foo");
    const broken = resolveWorkflowTemplate([{ name: "b", steps: [{ stepId: "s", prompt: "{{x}}" }] }], "b");
    expect(broken).toMatchObject({ ok: false, reason: "invalid-template" });
    expect(resolveWorkflowTemplate([], "x")).toMatchObject({ ok: false, message: 'no workflow template named "x"; none are configured for this agent' });
  });

  it("describes templates for the listing tool", () => {
    expect(describeTemplates([scan])).toEqual([
      {
        name: "market-scan",
        description: "Weekly scan of one ticker",
        params: [
          { name: "ticker", description: "Symbol to scan", required: true, default: null },
          { name: "horizon", description: null, required: false, default: "1 week" },
        ],
        steps: 3,
        waves: 2,
      },
    ]);
  });
});
