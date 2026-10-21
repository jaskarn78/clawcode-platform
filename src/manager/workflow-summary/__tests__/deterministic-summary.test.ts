import { describe, it, expect } from "vitest";
import {
  buildDeterministicSummary,
  truncateToLimit,
  firstMeaningfulLine,
  MAX_SUMMARY_LENGTH,
  type SummaryWorker,
} from "../deterministic-summary.js";
import { formatOutboundText } from "../../../discord/markdown-table-wrap.js";
import { FINALIZE_CHUNK_MAX_LENGTH } from "../../workflow-orchestrator.js";

/**
 * INC-2026-08-10 — a 4-step fin-client workflow finalized into 90,103
 * chars, which splitMessage cut into ~51 Discord messages. These pin that the
 * replacement post is ONE message, survives the outbound transform unchanged,
 * and can never exceed the cap that would fail the whole delivery.
 */

/** Reconstructed from the incident: 4 workers, ~18-27k chars each. */
function incidentWorkers(): SummaryWorker[] {
  const bulk = (n: number, head: string) =>
    `## ${head}\n\n${"Detailed analysis paragraph. ".repeat(n)}`;
  return [
    { stepId: "revenue-quality", status: "done", result: bulk(600, "Revenue quality") },
    { stepId: "retention-risk", status: "done", result: bulk(650, "Retention risk") },
    { stepId: "compliance-review", status: "done", result: bulk(900, "Compliance review") },
    { stepId: "synergy-model", status: "done", result: bulk(620, "Synergy model") },
  ];
}

describe("buildDeterministicSummary — the incident", () => {
  it("REGRESSION: collapses ~90k chars of worker output into ONE message", () => {
    const workers = incidentWorkers();
    const rawTotal = workers.reduce((n, w) => n + (w.result?.length ?? 0), 0);
    expect(rawTotal).toBeGreaterThan(60_000); // the old body scale

    const summary = buildDeterministicSummary({
      workflowId: "wf_HSegp2",
      workers,
      artifactDir: "workflows/wf_HSegp2/",
      elapsedMs: 14 * 60_000,
    });

    expect(summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    // The old path produced ~51 messages at 1900 chars/chunk. This is one.
    expect(Math.ceil(summary.length / 1900)).toBe(1);
  });

  it("is a formatOutboundText FIXED POINT (renders byte-identically outbound)", () => {
    // The daemon re-applies this transform on the way out, and the attachment
    // `content` path bypasses splitMessage entirely — so any expansion here
    // could push a near-limit post over Discord's 2000 and fail the delivery.
    const summary = buildDeterministicSummary({
      workflowId: "wf_HSegp2",
      workers: incidentWorkers(),
      artifactDir: "workflows/wf_HSegp2/",
      attachments: ["wf_HSegp2-summary.pdf", "wf_HSegp2-report.pdf"],
    });
    expect(formatOutboundText(summary)).toBe(summary);
    expect(formatOutboundText(formatOutboundText(summary))).toBe(summary);
  });

  it("contains no em dash (stripEmDashes would rewrite it and break the fixed point)", () => {
    const summary = buildDeterministicSummary({
      workflowId: "wf_x",
      workers: incidentWorkers(),
    });
    expect(summary).not.toContain("—");
  });

  it("names every step and its gist", () => {
    const summary = buildDeterministicSummary({
      workflowId: "wf_x",
      workers: incidentWorkers(),
    });
    for (const id of ["revenue-quality", "retention-risk", "compliance-review", "synergy-model"]) {
      expect(summary).toContain(id);
    }
  });

  it("surfaces failures with their reason, not just a count", () => {
    const summary = buildDeterministicSummary({
      workflowId: "wf_x",
      workers: [
        { stepId: "ok-step", status: "done", result: "All good." },
        { stepId: "bad-step", status: "failed", error: "upstream 502 from data vendor\nstack..." },
      ],
    });
    expect(summary).toContain("1/2 step(s) succeeded, 1 failed");
    expect(summary).toContain("upstream 502 from data vendor");
    expect(summary).not.toContain("stack..."); // first line only
  });

  it("ALWAYS names the workspace path, even when attachments exist", () => {
    // The message must stand alone: never "see attached" with no fallback,
    // because attachments can fail to render or fail to send.
    const summary = buildDeterministicSummary({
      workflowId: "wf_x",
      workers: incidentWorkers(),
      artifactDir: "workflows/wf_x/",
      attachments: ["a.pdf"],
    });
    expect(summary).toContain("workflows/wf_x/");
    expect(summary).toContain("a.pdf");
  });

  it("omits the attachment line entirely when nothing rendered", () => {
    const summary = buildDeterministicSummary({
      workflowId: "wf_x",
      workers: incidentWorkers(),
      artifactDir: "workflows/wf_x/",
    });
    expect(summary).not.toContain("Attached:");
    expect(summary).toContain("workflows/wf_x/");
  });

  it("stays under the cap even with many steps and long ids", () => {
    const many: SummaryWorker[] = Array.from({ length: 40 }, (_, i) => ({
      stepId: `an-unusually-long-descriptive-step-identifier-${i}`,
      status: "done",
      result: `Finding ${i}: ${"x".repeat(400)}`,
    }));
    const summary = buildDeterministicSummary({ workflowId: "wf_big", workers: many });
    expect(summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    expect(summary).toContain("truncated");
  });
});

describe("firstMeaningfulLine", () => {
  it("prefers prose over a heading, and never returns fenced code", () => {
    expect(firstMeaningfulLine("## Heading\n\n- \n```\ncode\n```\nActual finding here.")).toBe(
      "Actual finding here.",
    );
  });

  it("falls back to the heading when there is no prose", () => {
    // A section title is a usable gist; returning nothing would be worse.
    expect(firstMeaningfulLine("## Revenue quality\n\n```\ntable\n```")).toBe("Revenue quality");
  });
  it("strips leading markers and bold from the chosen line", () => {
    expect(firstMeaningfulLine("1. **Revenue** is thin")).toBe("Revenue is thin");
  });
  it("returns empty string rather than throwing on empty input", () => {
    expect(firstMeaningfulLine("")).toBe("");
  });
});

describe("the bottom line reaches the channel, not only the PDF", () => {
  it("carries a synthesized bluf as a quoted line", () => {
    const summary = buildDeterministicSummary({
      workflowId: "wf_x",
      workers: incidentWorkers(),
      bluf: "The asset is **cheaper than it looks and riskier than it prices**.",
    });
    expect(summary).toContain("> The asset is cheaper than it looks");
    // Emphasis is stripped: it competes with the bold step labels below.
    expect(summary).not.toContain("**cheaper");
    expect(formatOutboundText(summary)).toBe(summary);
  });

  it("omits the line entirely when there is no synthesis", () => {
    const summary = buildDeterministicSummary({ workflowId: "wf_x", workers: incidentWorkers() });
    expect(summary).not.toContain("\n> ");
  });

  it("stays under the cap with a long bluf AND many steps", () => {
    const summary = buildDeterministicSummary({
      workflowId: "wf_x",
      workers: Array.from({ length: 30 }, (_, i) => ({
        stepId: `step-${i}`,
        status: "done",
        result: `Finding ${i}. ${"x".repeat(300)}`,
      })),
      bluf: "y".repeat(2_000),
    });
    expect(summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
  });
});

describe("gist clipping", () => {
  it("stops at a sentence boundary rather than mid-clause", () => {
    const line = firstMeaningfulLine(
      "Revenue quality is intact in aggregate. But the mix has drifted materially over six quarters and the trend continues.",
    );
    expect(line).toBe("Revenue quality is intact in aggregate.");
    expect(line).not.toContain("…");
  });

  it("falls back to an ellipsis when there is no sentence break near the limit", () => {
    expect(firstMeaningfulLine("z".repeat(400))).toMatch(/…$/);
  });
});

describe("the one-message invariant", () => {
  it("MAX_SUMMARY_LENGTH stays strictly under the finalize chunk size", () => {
    // These two constants live in different modules and are currently equal,
    // which puts the summary exactly ON the one-chunk boundary. If either
    // moves the wrong way the finalize silently becomes two messages again -
    // the precise thing this work exists to prevent.
    expect(MAX_SUMMARY_LENGTH).toBeLessThan(FINALIZE_CHUNK_MAX_LENGTH);
  });
});

describe("truncateToLimit", () => {
  it("is a no-op under the limit", () => {
    expect(truncateToLimit("short", 100)).toBe("short");
  });
  it("marks a cut rather than truncating silently", () => {
    expect(truncateToLimit("x".repeat(500), 100)).toContain("truncated");
    expect(truncateToLimit("x".repeat(500), 100).length).toBeLessThanOrEqual(100);
  });
  it("prefers a line boundary when one is close to the budget", () => {
    const text = `${"a".repeat(80)}\n${"b".repeat(80)}`;
    expect(truncateToLimit(text, 100)).not.toContain("b");
  });
});

describe("Phase 999.120 — the findings land next to the PDF", () => {
  const base = {
    workflowId: "wf_x",
    workers: [
      { stepId: "planner", status: "done", result: "Planner gist here." },
      { stepId: "dashboard", status: "done", result: "Dashboard gist here." },
    ],
    attachments: ["2026-09-05-training-system-build-report.pdf"],
    bluf: "Everything is built; one token refresh is open.",
    keyFindings: [
      "The planner writes a 7-day block every Sunday — verified in the cron log.",
      "**The dashboard** reads the health DB directly.",
      "",
    ],
    nextSteps: ["Refresh the Garmin token before Sept 12."],
  };

  it("posts numbered findings and next steps, and collapses the step gists to one line", () => {
    const s = buildDeterministicSummary(base);
    expect(s).toContain("**Key findings**");
    expect(s).toContain("1. The planner writes a 7-day block every Sunday - verified in the cron log.");
    expect(s).toContain("2. The dashboard reads the health DB directly.");
    expect(s).not.toContain("3.");
    expect(s).toContain("**Next**");
    expect(s).toContain("• Refresh the Garmin token before Sept 12.");
    expect(s).toContain("**Steps** `planner` · `dashboard`");
    expect(s).not.toContain("Planner gist here");
    expect(s).toContain("2026-09-05-training-system-build-report.pdf");
  });

  it("keeps the fixed point and the cap with findings present", () => {
    const s = buildDeterministicSummary({
      ...base,
      keyFindings: Array.from({ length: 6 }, (_, i) => `Finding ${i} — ${"x".repeat(400)}`),
      nextSteps: Array.from({ length: 4 }, (_, i) => `Step ${i} – ${"y".repeat(300)}`),
    });
    expect(s.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
    expect(s).not.toContain("—");
    expect(formatOutboundText(s)).toBe(s);
  });

  it("is unchanged when no findings are supplied (per-step gists stay)", () => {
    const s = buildDeterministicSummary({ ...base, keyFindings: undefined, nextSteps: undefined });
    expect(s).not.toContain("Key findings");
    expect(s).toContain("• **planner** - Planner gist here.");
  });
});

describe("verification lines (Phase 999.123)", () => {
  it("posts the count line and the flagged figures under the findings, with no em dash", () => {
    const text = buildDeterministicSummary({
      workflowId: "wf_v",
      workers: [{ stepId: "a", status: "done", result: "Revenue was $1,200." }],
      keyFindings: ["Revenue was $1,200."],
      verification: {
        line: "3 figure(s) checked: 2 sourced, 1 unverified",
        flagged: ["$1,200 (revenue): no source named — really"],
      },
    });
    expect(text).toContain("**Verification** 3 figure(s) checked: 2 sourced, 1 unverified");
    expect(text).toContain("• ⚠️ $1,200 (revenue): no source named - really");
    expect(text).not.toContain("—");
    expect(text.indexOf("**Key findings**")).toBeLessThan(text.indexOf("**Verification**"));
  });

  it("omits the block when there is no verification", () => {
    const text = buildDeterministicSummary({ workflowId: "wf_v", workers: [{ stepId: "a", status: "done", result: "x" }] });
    expect(text).not.toContain("Verification");
  });
});

describe("since-last-run block (Phase 999.129)", () => {
  it("posts the deltas above the key findings with the previous run date", () => {
    const text = buildDeterministicSummary({
      workflowId: "wf_r",
      workers: [{ stepId: "a", status: "done", result: "x" }],
      keyFindings: ["Revenue $1.5M."],
      changes: ["Revenue up $0.3M — nice.", ""],
      previousRunAt: Date.UTC(2026, 7, 29),
    });
    expect(text).toContain("**Since last run (since 2026-08-29)**\n• Revenue up $0.3M - nice.");
    expect(text.indexOf("Since last run")).toBeLessThan(text.indexOf("**Key findings**"));
    expect(text).not.toContain("—");
    const noDate = buildDeterministicSummary({ workflowId: "wf_r", workers: [], changes: ["No material change"] });
    expect(noDate).toContain("**Since last run**\n• No material change");
  });
});
