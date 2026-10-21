/**
 * Phase 999.123 — the reserved `verify-figures` step.
 *
 * WHY. The report the editor writes is only as good as the figures the
 * workers collected, and the house standard for Client A's documents is that
 * every figure is sourced or marked `[unverified]`. Asking the editor to do
 * that while also writing the report is how unsourced figures slip through
 * (the retraction incidents of 2026-08). So the audit is its own worker:
 * it runs after the research barrier and BEFORE the final-report step,
 * over the same sources, and produces a ledger: figure, claim, source,
 * status. The ledger then:
 *   1. rides into the final-report prompt with hard rules (unsourced →
 *      `[unverified]`, conflicting → both values named, wrong → corrected),
 *   2. is typeset as a "Verification" appendix in the delivered PDF,
 *   3. is summarised in the completion post next to the key findings.
 *
 * Everything here is pure; the orchestrator owns spawning and timing.
 */

import { parse as yamlParse } from "yaml";
import type { AuthoredReportSource } from "./authored-report.js";

/** Reserved stepId for the fact-check step. Collision-guarded at append. */
export const VERIFY_STEP_ID = "verify-figures";
export const LEDGER_FENCE = "ledger";

export const LEDGER_STATUSES = ["verified", "consistent", "unsourced", "conflicting", "wrong"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export interface LedgerFigure {
  /** The figure as written in the research, e.g. "$11,700" or "7.2%". */
  readonly value: string;
  /** What the figure asserts, one clause. */
  readonly claim: string;
  readonly step?: string;
  readonly source?: string;
  readonly status: LedgerStatus;
  /** Conflict values, the correction, or "derived". */
  readonly note?: string;
}

export interface LedgerCounts {
  readonly total: number;
  readonly verified: number;
  readonly consistent: number;
  readonly unsourced: number;
  readonly conflicting: number;
  readonly wrong: number;
}

export interface FigureLedger {
  readonly figures: readonly LedgerFigure[];
  /** Recomputed from `figures`; the worker's own summary is not trusted. */
  readonly counts: LedgerCounts;
  /** The worker's reliability paragraph, when it wrote one. */
  readonly note?: string;
}

/** What the completion post carries. */
export interface VerificationSummary {
  readonly line: string;
  /** "<figure>: <why>" for every flagged figure, capped. */
  readonly flagged: readonly string[];
  readonly counts: LedgerCounts;
}

/** Per-sibling cap, same as the synthesis prompt. */
const MAX_SOURCE_CHARS = 14_000;
/** Ledger entries kept after parsing (the prompt asks for at most 60). */
export const MAX_LEDGER_FIGURES = 80;
const MAX_FIELD_CHARS = 240;
const MAX_FLAGGED_IN_POST = 4;

/** True when at least one completed source carries a digit; without one the audit has nothing to do. */
export function hasFigures(sources: readonly AuthoredReportSource[]): boolean {
  return sources.some((s) => s.status === "done" && /\d/.test(s.result ?? ""));
}

/** The fact-check worker's turn prompt. */
export function buildVerifyFiguresPrompt(sources: readonly AuthoredReportSource[]): string {
  const sections = sources.map((s) => {
    const body =
      s.status === "done"
        ? (s.result ?? "").slice(0, MAX_SOURCE_CHARS)
        : "(this step FAILED - nothing to audit; note the gap in your reliability paragraph)";
    return `### source: ${s.stepId}\nOriginal instruction: ${s.prompt.slice(0, 400)}\n\n${body}`;
  });

  return [
    "You are the FACT-CHECKER of a research desk. Parallel workers produced the",
    "research below; before an editor writes the report, you audit its figures.",
    "",
    "Build a ledger of every specific figure that carries a claim: dollar amounts,",
    "rates and percentages, limits and thresholds, counts, dates a conclusion",
    "depends on, regulatory or statutory numbers. For each figure decide:",
    "- verified: the research names a source for it AND, when it is a public",
    "  reference figure (a contribution limit, a tax bracket, a published rate or",
    "  price), it matches what you know or can confirm.",
    "- consistent: no source is named, but the same figure appears independently",
    "  in two or more steps.",
    "- unsourced: no source is named and it appears once.",
    "- conflicting: steps disagree on it. Put every value and its step in `note`.",
    "- wrong: a public reference figure you know or confirmed to be different. Put",
    "  the correct figure and its source in `note`.",
    "",
    "If you have web or search tools, use them ONLY to confirm public reference",
    "figures (at most 10 lookups); never to add research. A figure derived by",
    "arithmetic from other figures is verified when the arithmetic checks and the",
    "inputs are sourced; write \"derived\" in `note`.",
    "",
    "Prioritise the load-bearing figures (the ones a decision rests on); cap the",
    "ledger at 60 entries.",
    "",
    "OUTPUT: one fenced block, exactly:",
    "```ledger",
    "figures:",
    '  - value: "<the figure as written, e.g. $11,700 or 7.2%>"',
    '    claim: "<what it asserts, under 120 chars>"',
    '    step: "<source step id>"',
    '    source: "<the source the research names, or null>"',
    "    status: verified | consistent | unsourced | conflicting | wrong",
    '    note: "<optional: conflict values, the correction, or derived>"',
    "summary:",
    "  total: <n>",
    "  verified: <n>",
    "  consistent: <n>",
    "  unsourced: <n>",
    "  conflicting: <n>",
    "  wrong: <n>",
    "```",
    "Then ONE short paragraph on the overall reliability of the research: what a",
    "reader can trust and what they should not. No em dashes anywhere.",
    "",
    "The sources:",
    "",
    ...sections,
  ].join("\n");
}

const clean = (v: unknown, max = MAX_FIELD_CHARS): string | undefined => {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length === 0 || t === "null" ? undefined : t.slice(0, max);
};

function toFigure(raw: unknown): LedgerFigure | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const value = clean(r.value, 80);
  const status = clean(r.status, 20)?.toLowerCase();
  if (!value || !status || !(LEDGER_STATUSES as readonly string[]).includes(status)) return null;
  const claim = clean(r.claim) ?? "";
  const step = clean(r.step, 80);
  const source = clean(r.source);
  const note = clean(r.note);
  return Object.freeze({
    value,
    claim,
    ...(step ? { step } : {}),
    ...(source ? { source } : {}),
    status: status as LedgerStatus,
    ...(note ? { note } : {}),
  });
}

export function ledgerCounts(figures: readonly LedgerFigure[]): LedgerCounts {
  const n = (s: LedgerStatus) => figures.filter((f) => f.status === s).length;
  return Object.freeze({
    total: figures.length,
    verified: n("verified"),
    consistent: n("consistent"),
    unsourced: n("unsourced"),
    conflicting: n("conflicting"),
    wrong: n("wrong"),
  });
}

/** Pull the ```ledger block out of the fact-check worker's result. Null when absent or unusable. */
export function extractLedgerBlock(result: string): FigureLedger | null {
  const m = /```ledger\s*\n([^]*?)\n```/i.exec(result);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = yamlParse(m[1]!);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const figures = (Array.isArray(rec.figures) ? rec.figures : [])
    .map(toFigure)
    .filter((f): f is LedgerFigure => f !== null)
    .slice(0, MAX_LEDGER_FIGURES);
  if (figures.length === 0) return null;
  const after = result.slice(m.index + m[0].length).trim();
  const note = clean(after.split(/\n\s*\n/)[0], 600);
  return Object.freeze({
    figures: Object.freeze(figures),
    counts: ledgerCounts(figures),
    ...(note ? { note } : {}),
  });
}

/** Strip the ledger block (and anything after it) so it is never typeset as prose. */
export function stripLedgerBlock(result: string): string {
  return result.replace(/```ledger\s*\n[^]*?\n```[^]*$/i, "").trimEnd();
}

export function isFlagged(f: LedgerFigure): boolean {
  return f.status === "unsourced" || f.status === "conflicting" || f.status === "wrong";
}

function statusWord(f: LedgerFigure): string {
  switch (f.status) {
    case "verified":
      return f.note?.toLowerCase().startsWith("derived") ? "verified (derived)" : "verified";
    case "consistent":
      return "consistent across steps";
    case "unsourced":
      return "UNVERIFIED";
    case "conflicting":
      return f.note ? `CONFLICTING: ${f.note}` : "CONFLICTING";
    case "wrong":
      return f.note ? `CORRECTED: ${f.note}` : "CORRECTED";
  }
}

/** The instruction block appended to the final-report prompt when a ledger exists. */
export function ledgerInstructionForReport(ledger: FigureLedger): string {
  const rows = ledger.figures.map(
    (f) =>
      `- ${f.value} (${f.claim || "no claim recorded"}${f.step ? `; ${f.step}` : ""}): ${statusWord(f)}` +
      (f.source && f.status !== "conflicting" ? ` [source: ${f.source}]` : ""),
  );
  return [
    "VERIFICATION LEDGER (from the fact-check step). Hard rules for the report:",
    "- A figure marked UNVERIFIED is written as `<figure> [unverified]` wherever it appears.",
    "- A CONFLICTING figure is presented with every value and the conflict named inline;",
    "  never silently pick one.",
    "- A CORRECTED figure uses the corrected value and says the research had it wrong.",
    "- verified / consistent figures carry no marker; cite their source in Sources.",
    "- Do not introduce figures that are not in the research or the ledger.",
    "The ledger:",
    ...rows,
    ...(ledger.note ? ["", `Fact-checker's reliability note: ${ledger.note}`] : []),
  ].join("\n");
}

export function ledgerSummaryLine(ledger: FigureLedger): string {
  const c = ledger.counts;
  const parts = [
    `${c.verified} sourced`,
    ...(c.consistent > 0 ? [`${c.consistent} consistent across steps`] : []),
    ...(c.unsourced > 0 ? [`${c.unsourced} unverified`] : []),
    ...(c.conflicting > 0 ? [`${c.conflicting} conflicting`] : []),
    ...(c.wrong > 0 ? [`${c.wrong} corrected`] : []),
  ];
  return `${c.total} figure(s) checked: ${parts.join(", ")}`;
}

/** "<figure>: <why>" lines for the flagged figures, capped for the post. */
export function flaggedFigureLines(ledger: FigureLedger, max = MAX_FLAGGED_IN_POST): string[] {
  return ledger.figures
    .filter(isFlagged)
    .slice(0, max)
    .map((f) => {
      const what = f.claim ? `${f.value} (${f.claim})` : f.value;
      const why =
        f.status === "unsourced"
          ? "no source named"
          : f.status === "conflicting"
            ? `conflicting${f.note ? `: ${f.note}` : ""}`
            : `wrong${f.note ? `: ${f.note}` : ""}`;
      return `${what}: ${why}`;
    });
}

export function verificationSummary(ledger: FigureLedger): VerificationSummary {
  return Object.freeze({
    line: ledgerSummaryLine(ledger),
    flagged: Object.freeze(flaggedFigureLines(ledger)),
    counts: ledger.counts,
  });
}

const cell = (s: string | undefined): string => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The markdown appendix typeset into a markdown-bodied report (Acme, mobile fallback). */
export function ledgerMarkdownSection(ledger: FigureLedger): string {
  const rows = ledger.figures.map(
    (f) => `| ${cell(f.value)} | ${cell(f.claim)} | ${cell(f.source ?? (f.status === "consistent" ? "(consistent across steps)" : "none named"))} | ${cell(statusWord(f))} |`,
  );
  return [
    "## Verification",
    "",
    `${ledgerSummaryLine(ledger)}.${ledger.note ? ` ${ledger.note}` : ""}`,
    "",
    "| Figure | Claim | Source | Status |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n");
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The HTML appendix for an agent-designed document. Self-contained styling; inherits the page's fonts. */
export function ledgerHtmlSection(ledger: FigureLedger): string {
  const rows = ledger.figures
    .map(
      (f) =>
        `<tr><td>${esc(f.value)}</td><td>${esc(f.claim)}</td><td>${esc(f.source ?? (f.status === "consistent" ? "(consistent across steps)" : "none named"))}</td><td class="${isFlagged(f) ? "flag" : "ok"}">${esc(statusWord(f))}</td></tr>`,
    )
    .join("");
  return (
    `<section class="verification" style="break-before: page; padding: 1.25em; font-size: 0.8em; line-height: 1.35;">` +
    `<style>.verification table{width:100%;border-collapse:collapse;margin-top:.75em}.verification th,.verification td{text-align:left;vertical-align:top;padding:.3em .4em;border-bottom:1px solid rgba(128,128,128,.4)}.verification .flag{font-weight:600}</style>` +
    `<h2 style="margin:0 0 .4em 0;">Verification</h2>` +
    `<p>${esc(ledgerSummaryLine(ledger))}.${ledger.note ? ` ${esc(ledger.note)}` : ""}</p>` +
    `<table><thead><tr><th>Figure</th><th>Claim</th><th>Source</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` +
    `</section>`
  );
}

/** Append the HTML appendix before `</body>` (or at the end when there is none). */
export function appendLedgerToHtml(html: string, ledger: FigureLedger): string {
  const section = ledgerHtmlSection(ledger);
  const idx = html.toLowerCase().lastIndexOf("</body>");
  return idx === -1 ? html + section : html.slice(0, idx) + section + html.slice(idx);
}
