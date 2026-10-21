import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  buildWorkflowReports,
  buildReportDoc,
  attachmentNames,
} from "../workflow-reports.js";
import type { PdfDriver } from "../../../reports/render-pdf.js";

const log = pino({ level: "silent" });

/** A driver that returns a PDF of a chosen size, or fails. */
function driverOf(opts: { bytes?: number; fail?: boolean } = {}): PdfDriver {
  return {
    async launch() {
      return {
        async newPage() {
          return {
            async route() {},
            async setContent() {},
            async pdf() {
              if (opts.fail) throw new Error("render boom");
              return Buffer.alloc(opts.bytes ?? 1024, 0x41);
            },
          };
        },
        async close() {},
      };
    },
  };
}

const input = {
  workflowId: "wf_HSegp2",
  agentName: "fin-client",
  createdAt: 1_000,
  now: 901_000,
  workers: [
    {
      stepId: "revenue-quality",
      status: "done",
      result: "Margins fell 640bps.",
      prompt: "Analyse revenue.",
      startedAt: 2_000,
      settledAt: 404_000,
    },
    { stepId: "synergy-model", status: "failed", error: "upstream 502" },
  ],
};

describe("buildReportDoc", () => {
  it("derives per-step and workflow durations", () => {
    const doc = buildReportDoc(input);
    expect(doc.elapsedMs).toBe(900_000);
    expect(doc.steps[0]!.durationMs).toBe(402_000);
    // No timing recorded for a step that never got a turn - absent, not zero.
    expect(doc.steps[1]!.durationMs).toBeUndefined();
  });

  it("carries the error through for a failed step", () => {
    expect(buildReportDoc(input).steps[1]!.error).toBe("upstream 502");
  });
});

describe("attachmentNames", () => {
  it("prefixes with the workflow id so runs never collide in a channel", () => {
    expect(attachmentNames("wf_HSegp2")).toEqual({
      brief: "wf_HSegp2-brief.pdf",
      full: "wf_HSegp2-full-report.pdf",
      report: "wf_HSegp2-report.pdf",
    });
  });
  it("strips path characters out of an id it did not generate", () => {
    const n = attachmentNames("../../etc/passwd");
    expect(n.brief).not.toContain("/");
    expect(n.brief).not.toContain("..");
  });
});

describe("buildWorkflowReports — attachments are an enrichment, never the delivery", () => {
  it("returns ONE pdf on the happy path (operator decision: single attachment)", async () => {
    const out = await buildWorkflowReports(input, {
      logger: log,
      renderPdf: true,
      render: { driver: driverOf() },
    });
    expect(out.attachments.map((a) => a.name)).toEqual(["wf_HSegp2-report.pdf"]);
  });

  it("returns [] when the render fails", async () => {
    const out = await buildWorkflowReports(input, {
      logger: log,
      renderPdf: true,
      render: { driver: driverOf({ fail: true }) },
    });
    expect(out.attachments).toEqual([]);
  });

  it("returns [] rather than an oversized attachment", async () => {
    // Discord rejects the WHOLE message when one file is over the ceiling,
    // which would take the summary down with the PDFs.
    const out = await buildWorkflowReports(input, {
      logger: log,
      renderPdf: true,
      render: { driver: driverOf({ bytes: 11 * 1024 * 1024 }) },
    });
    expect(out.attachments).toEqual([]);
  });

  it("returns [] for a workflow with no steps", async () => {
    const spy = vi.fn();
    const out = await buildWorkflowReports(
      { ...input, workers: [] },
      { logger: log, renderPdf: true, render: { driver: { launch: spy as never } } },
    );
    expect(out.attachments).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("buildWorkflowReports — synthesis is optional and bounded", () => {
  it("renders without a synthesize hook at all", async () => {
    const out = await buildWorkflowReports(input, {
      logger: log,
      renderPdf: true,
      render: { driver: driverOf() },
    });
    expect(out.attachments).toHaveLength(1);
  });

  it("still renders when synthesis throws", async () => {
    const out = await buildWorkflowReports(input, {
      logger: log,
      renderPdf: true,
      render: { driver: driverOf() },
      synthesize: async () => {
        throw new Error("model unavailable");
      },
    });
    expect(out.attachments).toHaveLength(1);
  });

  it("still renders when synthesis times out", async () => {
    // By finalize time the orchestrator's stall recovery has already retired,
    // so an unbounded hang here would hang the workflow's last act.
    const out = await buildWorkflowReports(input, {
      logger: log,
      renderPdf: true,
      render: { driver: driverOf() },
      synthesisTimeoutMs: 20,
      synthesize: () => new Promise(() => {}),
    });
    expect(out.attachments).toHaveLength(1);
  });

  it("returns the synthesis even when the RENDER failed, so the post keeps it", async () => {
    // The bottom line is the most valuable output of the whole pipeline; losing
    // it because a browser died would be the wrong coupling.
    const out = await buildWorkflowReports(input, {
      logger: log,
      renderPdf: true,
      render: { driver: driverOf({ fail: true }) },
      synthesize: async () => ({ bluf: "Cheaper than it looks." }),
    });
    expect(out.attachments).toEqual([]);
    expect(out.synthesis?.bluf).toBe("Cheaper than it looks.");
  });

  it("passes the built doc to the synthesizer", async () => {
    const seen = vi.fn(async (_doc: import("../../../reports/types.js").ReportDoc) => null);
    await buildWorkflowReports(input, {
      logger: log,
      renderPdf: true,
      render: { driver: driverOf() },
      synthesize: seen,
    });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]?.[0]).toMatchObject({ workflowId: "wf_HSegp2" });
  });
});

// ── Phase 999.120 — findings next to the PDF ─────────────────────────────

/** A driver that records the HTML + page geometry it was asked to render. */
function capturingDriver(): PdfDriver & { jobs: Array<{ html: string; pdfOptions: Record<string, unknown> }> } {
  const jobs: Array<{ html: string; pdfOptions: Record<string, unknown> }> = [];
  return {
    jobs,
    async launch() {
      return {
        async newPage() {
          let html = "";
          return {
            async route() {},
            async setContent(h: string) {
              html = h;
            },
            async pdf(options: Record<string, unknown>) {
              jobs.push({ html, pdfOptions: options });
              return Buffer.alloc(2048, 0x41);
            },
          };
        },
        async close() {},
      };
    },
  };
}

const MARKDOWN_RESULT = `---
title: System build report
facts:
  - label: Sessions / week
    value: "5"
summary: Everything is built; one token refresh is open.
findings:
  - The planner writes a 7-day block every Sunday.
  - The dashboard reads the health DB directly.
next_steps:
  - Refresh the API token before Sept 12.
---
## 1 · What was built

Three pieces.
`;

const reportInput = {
  workflowId: "wf_eaAU-i",
  agentName: "client-a",
  createdAt: Date.UTC(2026, 8, 5, 18, 0),
  now: Date.UTC(2026, 8, 5, 18, 10),
  workers: [
    { stepId: "weekly-planner", status: "done", result: "Built.", prompt: "Build it.", startedAt: 1, settledAt: 2 },
    { stepId: "final-report", status: "done", result: MARKDOWN_RESULT, prompt: "(synth)" },
  ],
};

describe("buildWorkflowReports — agent-designed style and findings block (Phase 999.120)", () => {
  it("the phone document ships the phone document, and its findings block reaches the post", async () => {
    const driver = capturingDriver();
    const html = `<!doctype html><html><head><style>body{}</style></head><body>${"<p>doc</p>".repeat(80)}</body></html>`;
    const result = `${html}\n\n\`\`\`findings\nsummary: Bottom line here.\nfindings:\n  - One.\n  - Two.\n\`\`\`\n`;
    const r = await buildWorkflowReports(
      {
        ...reportInput,
        workers: [
          reportInput.workers[0]!,
          { stepId: "final-report", status: "done", result, prompt: "(synth)" },
        ],
      },
      { logger: log, renderPdf: true, render: { driver } },
    );
    expect(r.attachments.map((a) => a.name)).toEqual(["wf_eaAU-i-report.pdf"]);
    expect(driver.jobs[0]!.pdfOptions.width).toBe("4.5in");
    expect(driver.jobs[0]!.html).not.toContain("```findings");
    expect(r.synthesis?.bluf).toBe("Bottom line here.");
    expect(r.synthesis?.keyFindings).toEqual(["One.", "Two."]);
  });
});

// ── Phase 999.123 — verify-figures appendix ──────────────────────────────

const LEDGER_RESULT = `Audited.

\`\`\`ledger
figures:
  - value: "7 days"
    claim: "planner block length"
    step: weekly-planner
    source: "planner spec"
    status: verified
  - value: "$49"
    claim: "API fee"
    step: weekly-planner
    status: unsourced
\`\`\`

One fee is unsourced.`;

describe("buildWorkflowReports — verify-figures ledger (Phase 999.123)", () => {
  const withVerify = {
    ...reportInput,
    workers: [
      reportInput.workers[0]!,
      { stepId: "verify-figures", status: "done", result: LEDGER_RESULT, prompt: "(verify)" },
      reportInput.workers[1]!,
    ],
  };

  it("typesets a Verification appendix into the markdown body and returns the summary for the post", async () => {
    const driver = capturingDriver();
    const r = await buildWorkflowReports(withVerify, { logger: log, renderPdf: true, render: { driver } });
    const html = driver.jobs[0]!.html;
    expect(html).toContain("Verification");
    expect(html).toContain("UNVERIFIED");
    expect(html).toContain("$49");
    // The fact-checker is not part of the research record.
    expect(html).not.toContain("(verify)");
    expect(r.verification?.line).toBe("2 figure(s) checked: 1 sourced, 1 unverified");
    expect(r.verification?.flagged).toEqual(["$49 (API fee): no source named"]);
    expect(r.verification?.counts.unsourced).toBe(1);
  });

  it("appends the appendix to an agent-designed document too", async () => {
    const driver = capturingDriver();
    const html = `<!doctype html><html><head><style>body{}</style></head><body>${"<p>doc</p>".repeat(80)}</body></html>`;
    const r = await buildWorkflowReports(
      {
        ...withVerify,
        workers: [
          withVerify.workers[0]!,
          withVerify.workers[1]!,
          { stepId: "final-report", status: "done", result: html, prompt: "(synth)" },
        ],
      },
      { logger: log, renderPdf: true, render: { driver } },
    );
    expect(driver.jobs[0]!.html).toContain('class="verification"');
    expect(r.verification?.counts.total).toBe(2);
  });

  it("omits verification entirely when no ledger worker ran", async () => {
    const r = await buildWorkflowReports(reportInput, { logger: log, renderPdf: true, render: { driver: driverOf() } });
    expect("verification" in r).toBe(false);
  });
});

describe("findings block changes (Phase 999.129)", () => {
  it("carries the changes list back for the post", async () => {
    const result = `${MARKDOWN_RESULT}\n\n\`\`\`findings\nsummary: Bottom.\nfindings:\n  - One.\nchanges:\n  - Token refreshed since last run.\n\`\`\`\n`;
    const r = await buildWorkflowReports(
      { ...reportInput, workers: [reportInput.workers[0]!, { stepId: "final-report", status: "done", result, prompt: "(synth)" }] },
      { logger: log, renderPdf: true, render: { driver: driverOf() } },
    );
    expect(r.synthesis?.changes).toEqual(["Token refreshed since last run."]);
    const plain = await buildWorkflowReports(reportInput, { logger: log, renderPdf: true, render: { driver: driverOf() } });
    expect(plain.synthesis?.changes).toBeUndefined();
  });
});
