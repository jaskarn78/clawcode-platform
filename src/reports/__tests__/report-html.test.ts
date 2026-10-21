import { describe, it, expect } from "vitest";
import {
  buildBriefHtml,
  buildFullReportHtml,
  condense,
  humanizeStepId,
  stripRedundantLeadHeading,
  footerTemplate,
} from "../report-html.js";
import type { ReportDoc } from "../types.js";

const baseDoc = (over: Partial<ReportDoc> = {}): ReportDoc => ({
  workflowId: "wf_HSegp2",
  agentName: "fin-client",
  generatedAt: Date.parse("2026-08-11T09:14:00-07:00"),
  elapsedMs: 862_000,
  steps: [
    { stepId: "revenue-quality", status: "done", durationMs: 402_000, result: "## Revenue quality\n\nMargins compressed 640bps." },
    { stepId: "synergy-model", status: "failed", error: "upstream 502 from data vendor" },
  ],
  ...over,
});

describe("report documents — self-containment", () => {
  it("references NO external URL (the renderer aborts every request)", () => {
    // A stylesheet link, a webfont URL or a remote image would render as a
    // silent fallback in production and nowhere else, so this is asserted
    // rather than trusted.
    for (const html of [buildBriefHtml(baseDoc()), buildFullReportHtml(baseDoc())]) {
      const external = html.match(/(?:src|href)\s*=\s*["']https?:/gi);
      expect(external).toBeNull();
      expect(html).not.toContain("url(http");
      expect(html).toContain("data:font/woff2;base64,");
    }
  });

  it("opts into background printing, which print media drops by default", () => {
    expect(buildBriefHtml(baseDoc())).toContain("print-color-adjust: exact");
  });
});

describe("report documents — degrade without synthesis", () => {
  it("publishes a brief with no synthesis at all", () => {
    const html = buildBriefHtml(baseDoc());
    expect(html).toContain("Revenue quality");
    expect(html).toContain("Margins compressed 640bps");
    // INC-2026-08-14 — the fallback title is now an honest generic (the old
    // joined-step-ids fallback typeset "Active fun / Screens food treats /
    // Water no lake" as a masthead on wf_X2SbTV).
    expect(html).toContain("Research report - 2 workstreams");
  });

  it("uses the synthesized title and bottom line when present", () => {
    const html = buildBriefHtml(
      baseDoc({
        synthesis: {
          title: "Meridian Systems",
          dek: "Four workstreams.",
          bluf: "Cheaper than it looks.",
          keyFindings: ["Margin down **640bps**."],
        },
      }),
    );
    expect(html).toContain("Meridian Systems");
    expect(html).toContain("Cheaper than it looks.");
    expect(html).toContain("<strong>640bps</strong>");
  });

  it("shows a failed step's reason in BOTH documents, never just a count", () => {
    for (const html of [buildBriefHtml(baseDoc()), buildFullReportHtml(baseDoc())]) {
      expect(html).toContain("upstream 502 from data vendor");
    }
  });

  it("escapes a hostile synthesized title", () => {
    const html = buildBriefHtml(
      baseDoc({ synthesis: { title: '<script>alert(1)</script>' } }),
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("full report — completeness", () => {
  it("carries the FULL result, not a condensed one", () => {
    const long = `## Revenue quality\n\n${"Detailed sentence. ".repeat(400)}`;
    const doc = baseDoc({ steps: [{ stepId: "revenue-quality", status: "done", result: long }] });
    const full = buildFullReportHtml(doc);
    expect(full).not.toContain("continues in the full report");
    expect(full.length).toBeGreaterThan(long.length);
  });

  it("condenses in the BRIEF and says so", () => {
    const long = `## Revenue quality\n\n${"Detailed sentence. ".repeat(400)}`;
    const doc = baseDoc({ steps: [{ stepId: "revenue-quality", status: "done", result: long }] });
    expect(buildBriefHtml(doc)).toContain("continues in the full report");
  });

  it("lists every step in the contents", () => {
    const full = buildFullReportHtml(baseDoc());
    expect(full).toContain('class="toc"');
    expect(full).toContain("Revenue quality");
    expect(full).toContain("Synergy model");
  });

  it("shows the instruction as provenance when one is recorded", () => {
    const doc = baseDoc({
      steps: [{ stepId: "s", status: "done", result: "x", prompt: "Analyse the revenue base." }],
    });
    expect(buildFullReportHtml(doc)).toContain("Analyse the revenue base.");
  });
});

describe("helpers", () => {
  it("strips a lead heading that only restates the step title", () => {
    expect(stripRedundantLeadHeading("## Revenue quality\n\nBody.", "Revenue quality")).toBe("Body.");
    // Different heading: kept, because it is real content.
    expect(stripRedundantLeadHeading("## Margins\n\nBody.", "Revenue quality")).toContain("## Margins");
  });

  it("humanizes kebab and snake step ids", () => {
    expect(humanizeStepId("revenue-quality")).toBe("Revenue quality");
    expect(humanizeStepId("retention_risk")).toBe("Retention risk");
  });

  it("condense cuts at a paragraph boundary and marks the cut", () => {
    const text = `${"a".repeat(300)}\n\n${"b".repeat(300)}\n\n${"c".repeat(300)}`;
    const out = condense(text, 400);
    expect(out).toContain("continues in the full report");
    expect(out).not.toContain("c".repeat(300));
  });

  it("condense is a no-op under the limit", () => {
    expect(condense("short", 100)).toBe("short");
  });

  it("footer template names only host-available fonts", () => {
    // Chromium renders header/footer in an isolated context with no access to
    // the page's @font-face rules, so a webfont name there resolves to nothing.
    const f = footerTemplate(baseDoc(), "Brief");
    expect(f).not.toContain("Newsreader");
    expect(f).not.toContain("IBM Plex");
    expect(f).toContain("pageNumber");
  });
});
