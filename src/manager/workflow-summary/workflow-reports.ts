/**
 * Turns a finished workflow into its two delivered PDFs.
 *
 * WHERE THIS SITS. `finalizeWorkflow` always posts the deterministic summary
 * (`deterministic-summary.ts`) - that post is the floor and it cannot fail on
 * length. This module is the enrichment above it: build a `ReportDoc`, optionally
 * let a synthesis turn edit it, render two PDFs, hand them back as attachments
 * (plus the synthesis itself, so the channel post can carry the bottom line).
 *
 * EVERY STEP HERE IS BEST-EFFORT AND BOUNDED. A synthesis turn is an LLM call; a
 * render is a browser. Both are more fragile than the summary they decorate, and
 * by finalize time the orchestrator's stall recovery has already retired (it
 * watches WORKERS settling, and the barrier has passed) - so nothing else would
 * catch a wedge here. Failure yields no attachments and the caller posts text
 * alone.
 */

import type { Logger } from "pino";
import {
  buildFullReportHtml,
  buildAuthoredReportHtml,
  hardenAgentDesignedHtml,
  footerTemplate,
  MOBILE_PAGE,
} from "../../reports/report-html.js";
import {
  REPORT_STEP_ID,
  extractAuthoredHtml,
  extractFindingsBlock,
  stripFindingsBlock,
} from "./authored-report.js";
import { looksLikeMetaSummary } from "./result-quality.js";
import {
  VERIFY_STEP_ID,
  appendLedgerToHtml,
  extractLedgerBlock,
  ledgerMarkdownSection,
  verificationSummary,
  type VerificationSummary,
} from "./verify-figures.js";
import { firstMeaningfulLine } from "./deterministic-summary.js";
import { renderPdfs, fitsDiscordAttachment } from "../../reports/render-pdf.js";
import type { RenderDeps } from "../../reports/render-pdf.js";
import type {
  ReportDoc,
  ReportStep,
  ReportSynthesis,
} from "../../reports/types.js";

/** Ceiling on the synthesis turn. Past this the brief simply goes out unedited. */
export const SYNTHESIS_TIMEOUT_MS = 180_000;

export interface ReportAttachment {
  readonly name: string;
  readonly data: Buffer;
}

/** The subset of a workflow worker this module needs. */
export interface ReportWorker {
  readonly stepId: string;
  readonly status: string;
  readonly prompt?: string;
  readonly result?: string;
  readonly error?: string;
  readonly startedAt?: number;
  readonly settledAt?: number;
}

export interface BuildReportDocInput {
  readonly workflowId: string;
  readonly agentName: string;
  readonly workers: readonly ReportWorker[];
  readonly createdAt: number;
  readonly now: number;
  /** Phase 999.120 — how the authored report is typeset. Default agent-designed. */
}

/** Pure: workflow state -> document model. */
export function buildReportDoc(input: BuildReportDocInput): ReportDoc {
  const steps: ReportStep[] = input.workers.map((w) => ({
    stepId: w.stepId,
    status: w.status,
    ...(w.prompt !== undefined ? { prompt: w.prompt } : {}),
    ...(w.result !== undefined ? { result: w.result } : {}),
    ...(w.error !== undefined ? { error: w.error } : {}),
    ...(w.startedAt !== undefined && w.settledAt !== undefined
      ? { durationMs: Math.max(0, w.settledAt - w.startedAt) }
      : {}),
  }));
  return {
    workflowId: input.workflowId,
    agentName: input.agentName,
    generatedAt: input.now,
    elapsedMs: Math.max(0, input.now - input.createdAt),
    steps,
  };
}

/**
 * Attachment filenames. Prefixed with the workflow id so a channel holding
 * several days of runs never shows two files called `brief.pdf`.
 */
export function attachmentNames(workflowId: string): {
  readonly brief: string;
  readonly full: string;
  readonly report: string;
} {
  const safe = workflowId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "workflow";
  return {
    brief: `${safe}-brief.pdf`,
    full: `${safe}-full-report.pdf`,
    // INC-2026-08-14c — the single channel attachment.
    report: `${safe}-report.pdf`,
  };
}

export interface WorkflowReportDeps {
  readonly logger: Logger;
  /**
   * Optional editorial pass. Returns null (or throws, or times out) and the
   * documents fall back to their deterministic composition.
   */
  readonly synthesize?: (doc: ReportDoc) => Promise<ReportSynthesis | null>;
  readonly synthesisTimeoutMs?: number;
  /** Injected in tests; production uses the real browser driver. */
  readonly render?: RenderDeps;
  /**
   * 999.150 — render the report to PDF at all. DEFAULT FALSE.
   *
   * Operator, 2026-09-17: "Nobody ever wants to see the research workflow pdf."
   * Every workflow used to drop one in the channel unasked, and when the
   * request had actually been for a document (a financial plan) the generated
   * research PDF was mistaken for it. The SYNTHESIS is still computed — the
   * agent's answer and the run record both consume it — but nothing renders
   * and nothing attaches unless a caller explicitly asks.
   *
   * On-demand regeneration is unaffected: step artifacts and the run record
   * persist under `<workspace>/workflows/<wfId>/`, so "generate the full
   * report for wf_X" still works whenever someone actually wants one.
   */
  readonly renderPdf?: boolean;
}

async function runSynthesis(
  doc: ReportDoc,
  deps: WorkflowReportDeps,
): Promise<ReportSynthesis | undefined> {
  if (!deps.synthesize) return undefined;
  const limit = deps.synthesisTimeoutMs ?? SYNTHESIS_TIMEOUT_MS;
  try {
    const result = await Promise.race([
      deps.synthesize(doc),
      new Promise<null>((_r, reject) =>
        setTimeout(() => reject(new Error(`synthesis timed out after ${limit}ms`)), limit).unref?.(),
      ),
    ]);
    return result ?? undefined;
  } catch (err: unknown) {
    deps.logger.warn(
      {
        component: "workflow-reports",
        workflowId: doc.workflowId,
        err: err instanceof Error ? err.message : String(err),
      },
      "workflow report synthesis failed - publishing unedited documents",
    );
    return undefined;
  }
}

export interface WorkflowReportResult {
  readonly attachments: readonly ReportAttachment[];
  /**
   * The editorial pass's output, when it produced one. Returned so the channel
   * post can carry the bottom line too - an answer that lives only inside a PDF
   * is an answer the operator has to open a file to read.
   */
  readonly synthesis?: ReportSynthesis;
  /**
   * Phase 999.123 — the fact-check step's summary (one line + the flagged
   * figures), when a `verify-figures` worker produced a ledger.
   */
  readonly verification?: VerificationSummary;
}

/**
 * Builds and renders both PDFs. Attachments come back empty on ANY failure -
 * the caller's summary post is the contract, attachments are the bonus. The
 * synthesis is returned independently, so a successful edit still reaches the
 * channel even when the RENDER is what failed.
 */
export async function buildWorkflowReports(
  input: BuildReportDocInput,
  deps: WorkflowReportDeps,
): Promise<WorkflowReportResult> {
  if (input.workers.length === 0) return { attachments: [] };

  // INC-2026-08-14b/c — ONE pdf lands in the channel (operator decision: no
  // separate brief + record). Preference order:
  //   1. the synthesis worker's AGENT-DESIGNED HTML document,
  //   2. its markdown through the fixed mobile template,
  //   3. (no synthesis at all) the verbatim research record, Letter.
  const synthWorker = input.workers.find(
    (w) => w.stepId.startsWith(REPORT_STEP_ID) && w.status === "done",
  );
  const authoredRaw =
    synthWorker?.result && !looksLikeMetaSummary(synthWorker.result)
      ? synthWorker.result
      : null;
  // Phase 999.123 — the fact-check worker is not research: its ledger becomes
  // the Verification appendix and the post's summary line, and it never
  // appears in the research record (a failed one still shows in the summary).
  const verifyWorker = input.workers.find(
    (w) => w.stepId.startsWith(VERIFY_STEP_ID) && w.status === "done",
  );
  const ledger = verifyWorker?.result ? extractLedgerBlock(verifyWorker.result) : null;
  const verification = ledger ? { verification: verificationSummary(ledger) } : {};
  const researchWorkers = input.workers.filter(
    (w) => w !== synthWorker && !w.stepId.startsWith(VERIFY_STEP_ID),
  );
  const base = buildReportDoc({ ...input, workers: researchWorkers });

  // The findings the worker appended. They ride the channel post next to the PDF.
  const findingsBlock = authoredRaw ? extractFindingsBlock(authoredRaw) : null;
  const authoredBody = authoredRaw ? stripFindingsBlock(authoredRaw) : null;

  // The channel post's bottom line: from the authored doc when there is one,
  // else the JSON-edit fallback synthesizes it.
  const jsonSynthesis = authoredRaw ? undefined : await runSynthesis(base, deps);
  const effectiveSynthesis: ReportSynthesis | undefined = authoredBody
    ? {
        bluf:
          findingsBlock?.summary ??
          firstMeaningfulLine(stripHtmlForBluf(authoredBody), 320),
        keyFindings: findingsBlock?.findings ?? [],
        nextSteps: findingsBlock?.nextSteps ?? [],
        // Phase 999.129 — deltas ride to the post next to the findings.
        ...(findingsBlock?.changes.length ? { changes: findingsBlock.changes } : {}),
      }
    : jsonSynthesis;
  const doc: ReportDoc = jsonSynthesis ? { ...base, synthesis: jsonSynthesis } : base;
  const names = attachmentNames(doc.workflowId);

  const agentHtml = authoredBody ? extractAuthoredHtml(authoredBody) : null;
  const job = agentHtml
    ? // Agent-designed: hardened (scripts stripped, fonts injected, page
      // pinned), no footer chrome, phone geometry.
      {
        html: hardenAgentDesignedHtml(ledger ? appendLedgerToHtml(agentHtml, ledger) : agentHtml),
        page: MOBILE_PAGE,
      }
    : authoredBody
      ? // Markdown fallback through the fixed dark template.
        {
          html: buildAuthoredReportHtml(
            doc,
            ledger ? `${authoredBody}\n\n${ledgerMarkdownSection(ledger)}` : authoredBody,
          ),
          page: MOBILE_PAGE,
        }
      : // No synthesis at all: the verbatim record is better than nothing.
        { html: buildFullReportHtml(doc), footerHtml: footerTemplate(doc, "Report") };
  const attachmentName = names.report;

  // 999.150 — default OFF. Returning here skips the browser entirely, so the
  // cost of a report nobody wanted is not paid either.
  if (deps.renderPdf !== true) {
    return { attachments: [], ...(effectiveSynthesis ? { synthesis: effectiveSynthesis } : {}), ...verification };
  }

  try {
    const [pdf] = await renderPdfs([job], { ...deps.render, logger: deps.logger });
    const out = [{ name: attachmentName, data: pdf! }];
    if (!fitsDiscordAttachment(out.map((a) => a.data))) {
      deps.logger.warn(
        {
          component: "workflow-reports",
          workflowId: doc.workflowId,
          sizes: out.map((a) => a.data.byteLength),
        },
        "workflow report exceeds the Discord attachment ceiling - posting summary only",
      );
      return { attachments: [], ...(effectiveSynthesis ? { synthesis: effectiveSynthesis } : {}), ...verification };
    }
    return { attachments: out, ...(effectiveSynthesis ? { synthesis: effectiveSynthesis } : {}), ...verification };
  } catch (err: unknown) {
    deps.logger.warn(
      {
        component: "workflow-reports",
        workflowId: doc.workflowId,
        err: err instanceof Error ? err.message : String(err),
      },
      "workflow report render failed - posting summary only",
    );
    return { attachments: [], ...(effectiveSynthesis ? { synthesis: effectiveSynthesis } : {}), ...verification };
  }
}

/** Crude tag strip so the channel bluf never quotes markup. */
function stripHtmlForBluf(text: string): string {
  return text
    .replace(/<style[\s>][^]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
