/**
 * INC-2026-08-14b — the report is AUTHORED BY AN AGENT, not assembled.
 *
 * The operator compared the daemon-assembled per-step brief against a report
 * the parent agent wrote itself and the verdict was unambiguous: the authored
 * one ("The Kids' Weekend, Actually Fun Edition" - ranked picks, a day-by-day
 * plan built around constraints only the agent knew) was better in a way no
 * deterministic assembler can reach. Synthesis needs the CONTEXT, so it runs
 * as a workflow step.
 *
 * The synthesizer is a RESERVED STEP appended after the parallel barrier and
 * driven through the exact same machinery as every other step — admission
 * gate, spawn, delivery contract, meta-summary quality gate, disk persistence,
 * teardown. Its result is the report markdown; the mobile brief PDF renders
 * it through the existing escape-first pipeline (the worker authors CONTENT,
 * never HTML).
 */

import { parse as yamlParse } from "yaml";
import { ledgerInstructionForReport, type FigureLedger } from "./verify-figures.js";
import { previousRunPromptSection, type PreviousRun } from "./previous-run.js";

/** Phase 999.123 — options shared by both prompt builders. */
export interface ReportPromptOptions {
  /** The fact-check step's ledger; when present its rules are appended to the prompt. */
  readonly ledger?: FigureLedger;
  /** Phase 999.129 — the previous run of the same template; the report leads with the deltas. */
  readonly previous?: PreviousRun;
}

/** Reserved stepId for the synthesis step. Collision-guarded at append. */
export const REPORT_STEP_ID = "final-report";

export interface AuthoredReportSource {
  readonly stepId: string;
  readonly prompt: string;
  readonly result?: string;
  readonly status: string;
}

/** Per-sibling cap — synthesis reads everything, but bounded. */
const MAX_SOURCE_CHARS = 14_000;

/**
 * The synthesis step's turn prompt. The sibling results ride INSIDE the
 * prompt (the worker is a fresh session with no other context), along with
 * each step's original instruction so the constraints that shaped the
 * research shape the report too.
 */
export function buildAuthoredReportPrompt(
  sources: readonly AuthoredReportSource[],
  opts?: ReportPromptOptions,
): string {
  const sections = sources.map((s) => {
    const body =
      s.status === "done"
        ? (s.result ?? "").slice(0, MAX_SOURCE_CHARS)
        : `(this step FAILED - fold its absence into the report as a known gap)`;
    return `### source: ${s.stepId}\nOriginal instruction: ${s.prompt.slice(0, 400)}\n\n${body}`;
  });

  return [
    "You are the EDITOR and the DESIGNER. The research below was produced by",
    "parallel workers; author the single document the reader actually wants -",
    "not a summary of the workers' outputs, THE report, with a design chosen",
    "for this specific content.",
    "",
    "OUTPUT FORMAT - one complete self-contained HTML document:",
    "- Start with <!doctype html>; include <html>, <head> with a <style> block,",
    "  and <body>. Everything inline - no external stylesheets, scripts,",
    "  images, or fonts (the renderer BLOCKS all network requests).",
    "- No <script> tags; JavaScript is disabled at render. Design with CSS only.",
    "- The page is 4.5in x 8in (phone-shaped, also crisp on desktop), zero PDF",
    "  margin - your body/padding IS the frame. Long content flows across",
    "  pages; use break-inside: avoid on cards you don't want split.",
    "- These font families are provided by the renderer and are the ONLY",
    "  custom faces available: 'IBM Plex Sans' (400/600), 'IBM Plex Sans",
    "  Condensed' (700), 'IBM Plex Mono' (400/600), 'Newsreader' (400/600).",
    "- Dark or light ground is YOUR call - pick what serves the content;",
    "  ensure print-color-adjust: exact so fills survive PDF rendering.",
    "",
    "DESIGN the document for its content: a trip guide wants a ranked list and",
    "a day plan; a financial review wants tables and callouts; an incident",
    "report wants a timeline. Choose structure, hierarchy, and accents that",
    "fit - do not produce a generic template.",
    "",
    "CONTENT RULES:",
    "- MERGE and RESTRUCTURE across sources - the reader must never see the",
    "  seams between workers.",
    "- Honor constraints visible in the original instructions (dates, ages,",
    "  budgets, exclusions) - structure the report AROUND them.",
    "- Keep every load-bearing fact: names, addresses, prices, hours, phone",
    "  numbers, caveats, verification status. Cut only redundancy.",
    "- If sources conflict, say so inline rather than silently picking one.",
    "- Target the equivalent of 800-2000 words.",
    "",
    "If for any reason you cannot produce HTML, plain markdown is an accepted",
    "fallback (it renders through a fixed template).",
    "",
    // Phase 999.120 — the findings land in the channel next to the PDF.
    FINDINGS_BLOCK_INSTRUCTION,
    "",
    // Phase 999.123 — the fact-check ledger's rules, when the step ran.
    ...(opts?.ledger ? [ledgerInstructionForReport(opts.ledger), ""] : []),
    // Phase 999.129 — the previous run, when this is a recurring template run.
    ...(opts?.previous ? [previousRunPromptSection(opts.previous), ""] : []),
    "The sources:",
    "",
    ...sections,
  ].join("\n");
}

/**
 * Extract a complete HTML document from a worker result, tolerating a
 * ```html fence and surrounding prose. Null when the result is not HTML
 * (markdown fallback path). The extraction is structural only - sanitizing
 * happens in the renderer wrapper (script strip + JS disabled + network
 * abort).
 */
export function extractAuthoredHtml(result: string): string | null {
  const fenced = /```html\s*([^]*?)```/i.exec(result);
  const candidate = fenced ? fenced[1]! : result;
  const start = candidate.search(/<!doctype html|<html[\s>]/i);
  if (start === -1) return null;
  const endIdx = candidate.toLowerCase().lastIndexOf("</html>");
  if (endIdx === -1) return null;
  const html = candidate.slice(start, endIdx + "</html>".length).trim();
  // A real document, not a stray tag in prose.
  return html.length > 500 && /<body[\s>]/i.test(html) ? html : null;
}

// ── Phase 999.120 — Acme house-style prompt + the findings block ────

/**
 * The fenced block every final-report worker appends after its document.
 * Parsed by `extractFindingsBlock`; posted to Discord alongside the PDF so
 * the operator gets the findings in the channel, not only inside a file.
 */
export const FINDINGS_FENCE = "findings";

export interface ReportFindings {
  readonly summary?: string;
  readonly findings: readonly string[];
  readonly nextSteps: readonly string[];
  /** Phase 999.129 — what changed since the previous run (recurring workflows). */
  readonly changes: readonly string[];
}

/** The instruction appended to BOTH prompt variants. */
export const FINDINGS_BLOCK_INSTRUCTION = [
  "AFTER the document, append ONE fenced block, exactly:",
  "```findings",
  "summary: <the bottom line in 2-4 sentences>",
  "findings:",
  "  - <one-sentence finding with its figure>",
  "  - <3 to 6 items>",
  "next_steps:",
  "  - <0 to 4 concrete, time-bound asks>",
  "```",
  "It is posted to the channel next to the PDF, so it must stand on its own.",
  "No em dashes anywhere in it.",
].join("\n");

const asList = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => (typeof x === "string" ? x.trim() : typeof x === "number" ? String(x) : ""))
        .filter((x) => x.length > 0)
        .slice(0, max)
    : [];

/**
 * Pull the ```findings block out of a worker result. Null when absent or
 * unparseable - the caller falls back to the first meaningful line.
 */
export function extractFindingsBlock(result: string): ReportFindings | null {
  const m = /```findings\s*\n([^]*?)\n```/i.exec(result);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = yamlParse(m[1]!);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const summary = typeof rec.summary === "string" && rec.summary.trim() ? rec.summary.trim() : undefined;
  const findings = asList(rec.findings ?? rec.key_findings, 6);
  const nextSteps = asList(rec.next_steps ?? rec.nextSteps, 4);
  const changes = asList(rec.changes ?? rec.since_last_run, 5);
  if (!summary && findings.length === 0) return null;
  return Object.freeze({
    summary,
    findings: Object.freeze(findings),
    nextSteps: Object.freeze(nextSteps),
    changes: Object.freeze(changes),
  });
}

/**
 * Strip the findings block (and any trailing prose after it) from a result
 * so it never ends up typeset inside the document body.
 */
export function stripFindingsBlock(result: string): string {
  return result.replace(/```findings\s*\n[^]*?\n```\s*/gi, "").trimEnd();
}
