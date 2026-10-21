/**
 * Builds the two report documents as standalone HTML strings.
 *
 * Both are rendered from the same {@link ReportDoc}, and both are FULLY
 * self-contained: fonts are embedded base64, the stylesheet is inline, and no
 * element references an external URL. That is a hard requirement, not a
 * convenience - the renderer aborts every network request the page attempts.
 *
 * THE BRIEF is the thorough summary: masthead, at-a-glance figures, bottom
 * line, key findings, one condensed panel per step, risks and next steps.
 * A reader who only opens this one should not be missing a decision input.
 *
 * THE RECORD is the full report: the same masthead, a contents page, then every
 * step's complete output verbatim with its instruction shown as provenance.
 * Nothing is summarized here - this is the artifact the brief is accountable to.
 */

import { renderMarkdown, escapeHtml } from "./markdown.js";
import { reportCss, mobileCss } from "./style/report-css.js";
import { fontFaceCss as fontFaceCssForAgentDocs } from "./style/fonts.js";
import type { ReportDoc, ReportStep } from "./types.js";

/** ~1 page of prose. Beyond this a "step summary" is not a summary. */
const CONDENSED_CHARS = 2200;

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtTimestamp(epochMs: number): string {
  // Fixed locale + explicit zone so the same doc renders identically wherever
  // the daemon happens to be running.
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "America/Los_Angeles",
  }).format(new Date(epochMs));
}

const isDone = (s: ReportStep): boolean => s.status === "done";

/** Turns a `kebab-or_snake id` into a display title. */
export function humanizeStepId(stepId: string): string {
  const words = stepId.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (words === "") return stepId;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Cuts markdown at a paragraph boundary rather than mid-sentence, so a
 * condensed panel ends like prose instead of like a truncated buffer.
 */
export function condense(markdown: string, limit = CONDENSED_CHARS): string {
  if (markdown.length <= limit) return markdown;
  const head = markdown.slice(0, limit);
  const para = head.lastIndexOf("\n\n");
  const cut = para > limit * 0.45 ? head.slice(0, para) : head;
  return `${cut.trimEnd()}\n\n*[continues in the full report]*`;
}

/**
 * Drops a step's own opening heading when it just restates the step title.
 * Workers almost always start with `## <the thing I was asked about>`, which
 * next to the block's own h2 renders the same words twice in two sizes.
 */
export function stripRedundantLeadHeading(markdown: string, title: string): string {
  const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i += 1;
  const m = /^#{1,6}\s+(.*)$/.exec(lines[i]?.trim() ?? "");
  if (!m || norm(m[1]!) !== norm(title)) return markdown;
  return lines.slice(i + 1).join("\n").replace(/^\n+/, "");
}

function shell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>${reportCss()}</style>
</head><body>
${bodyHtml}
</body></html>`;
}

function masthead(doc: ReportDoc, kicker: string, title: string, dek: string): string {
  return `<header class="masthead">
  <div class="kicker">${escapeHtml(kicker)}</div>
  <h1>${escapeHtml(title)}</h1>
  <p class="dek">${escapeHtml(dek)}</p>
</header>`;
}

function statband(doc: ReportDoc): string {
  const done = doc.steps.filter(isDone).length;
  const failed = doc.steps.length - done;
  const words = doc.steps.reduce(
    (n, s) => n + (s.result ? s.result.trim().split(/\s+/).length : 0),
    0,
  );
  const cells: { label: string; value: string; cls?: string }[] = [
    { label: "Steps delivered", value: `${done}/${doc.steps.length}`, cls: failed === 0 ? "ok" : "" },
    { label: "Elapsed", value: fmtDuration(doc.elapsedMs) },
    { label: "Words analysed", value: words.toLocaleString("en-US") },
  ];
  if (failed > 0) cells.push({ label: "Failed", value: String(failed), cls: "accent" });
  return `<div class="statband">${cells
    .map(
      (c) =>
        `<div class="stat"><div class="label">${escapeHtml(c.label)}</div>` +
        `<div class="value ${c.cls ?? ""}">${escapeHtml(c.value)}</div></div>`,
    )
    .join("")}</div>`;
}

function metaLine(doc: ReportDoc): string {
  return `<div class="meta">
  <span><b>Workflow</b> ${escapeHtml(doc.workflowId)}</span>
  <span><b>Agent</b> ${escapeHtml(doc.agentName)}</span>
  <span><b>Generated</b> ${escapeHtml(fmtTimestamp(doc.generatedAt))}</span>
</div>`;
}

function block(rail: string, bodyHtml: string, opts: { idx?: string; mark?: string; markCls?: string; loose?: boolean } = {}): string {
  const idx = opts.idx ? `<span class="idx">${escapeHtml(opts.idx)}</span>` : "";
  const mark = opts.mark
    ? `<span class="rail-mark ${opts.markCls ?? ""}">${escapeHtml(opts.mark)}</span>`
    : "";
  return `<section class="block${opts.loose ? " loose" : ""}">
  <div class="rail">${idx}<span class="label">${escapeHtml(rail)}</span>${mark}</div>
  <div class="body">${bodyHtml}</div>
</section>`;
}

function bulletList(items: readonly string[]): string {
  return `<ul>${items.map((t) => `<li>${renderMarkdown(t).replace(/^<p>|<\/p>$/g, "")}</li>`).join("")}</ul>`;
}

function colophon(doc: ReportDoc, kind: string): string {
  return `<div class="colophon">
  ${escapeHtml(kind)} &middot; workflow ${escapeHtml(doc.workflowId)} &middot;
  generated by ClawCode for ${escapeHtml(doc.agentName)} &middot;
  full per-step output retained at workflows/${escapeHtml(doc.workflowId)}/ in the agent workspace
</div>`;
}

function resolvedTitle(doc: ReportDoc): string {
  const t = doc.synthesis?.title?.trim();
  if (t) return t;
  // INC-2026-08-14 — the old fallback joined step ids with " / ", which on a
  // 4-step run typeset "Active fun / Screens food treats / Water no lake" as
  // a masthead. One step keeps its name; multi-step runs get an honest
  // generic title instead of an id salad.
  if (doc.steps.length === 1) return humanizeStepId(doc.steps[0]!.stepId);
  return `Research report - ${doc.steps.length} workstreams`;
}

function resolvedDek(doc: ReportDoc): string {
  const d = doc.synthesis?.dek?.trim();
  if (d) return d;
  const done = doc.steps.filter(isDone).length;
  const failed = doc.steps.length - done;
  return (
    `${done} of ${doc.steps.length} parallel research steps completed in ` +
    `${fmtDuration(doc.elapsedMs)}${failed > 0 ? `, with ${failed} unable to finish` : ""}.`
  );
}

/** THE BRIEF - the thorough summary document. */
export function buildBriefHtml(doc: ReportDoc): string {
  const title = resolvedTitle(doc);
  const syn = doc.synthesis;
  const parts: string[] = [];

  // INC-2026-08-14 — the cover forces a page break ONLY when it carries real
  // content (bottom line / key findings). A synthesis-less brief used to ship
  // a masthead followed by 70% blank page; now the first section flows on.
  const coverHasContent = Boolean(syn?.bluf?.trim() || (syn?.keyFindings?.length ?? 0) > 0);
  parts.push(`<div class="${coverHasContent ? "cover" : "cover cover-flow"}">
${masthead(doc, "ClawCode workflow brief", title, resolvedDek(doc))}
${statband(doc)}
${metaLine(doc)}`);

  if (syn?.bluf?.trim()) {
    parts.push(
      block("Bottom line", `<div class="lede">${renderMarkdown(syn.bluf)}</div>`),
    );
  }
  if (syn?.keyFindings && syn.keyFindings.length > 0) {
    parts.push(block("Key findings", bulletList(syn.keyFindings)));
  }
  parts.push("</div>"); // end cover

  doc.steps.forEach((step, i) => {
    const idx = String(i + 1).padStart(2, "0");
    const condensed = syn?.perStep?.[step.stepId];
    let body: string;
    if (!isDone(step)) {
      body =
        `<h2 class="step-title">${escapeHtml(humanizeStepId(step.stepId))}</h2>` +
        `<div class="callout"><div class="callout-label">Step did not complete</div>` +
        `<p>${escapeHtml(step.error ?? "No error was reported.")}</p></div>`;
    } else if (condensed?.trim()) {
      body =
        `<h2 class="step-title">${escapeHtml(humanizeStepId(step.stepId))}</h2>` +
        renderMarkdown(stripRedundantLeadHeading(condensed, humanizeStepId(step.stepId)));
    } else {
      // No synthesis for this step: publish a condensed head of the raw result.
      // Truthful and useful, just not edited.
      body =
        `<h2 class="step-title">${escapeHtml(humanizeStepId(step.stepId))}</h2>` +
        renderMarkdown(
          condense(
            stripRedundantLeadHeading(
              step.result ?? "_No output was returned._",
              humanizeStepId(step.stepId),
            ),
          ),
        );
    }
    parts.push(
      // INC-2026-08-14 — `loose`: a half-page panel with break-inside:avoid
      // was pushed wholesale to the next page, leaving ~50% whitespace per
      // page. Brief panels flow like the full report's sections.
      block(isDone(step) ? "Finding" : "Incomplete", body, {
        idx,
        mark: isDone(step) ? fmtDuration(step.durationMs) : "failed",
        markCls: isDone(step) ? "ok" : "fail",
        loose: true,
      }),
    );
  });

  if (syn?.risks && syn.risks.length > 0) {
    parts.push(block("Risks", bulletList(syn.risks)));
  }
  if (syn?.nextSteps && syn.nextSteps.length > 0) {
    parts.push(block("Next", bulletList(syn.nextSteps)));
  }
  parts.push(colophon(doc, "Brief"));

  return shell(`${title} - Brief`, parts.join("\n"));
}

/** THE RECORD - the complete report, nothing condensed. */
export function buildFullReportHtml(doc: ReportDoc): string {
  const title = resolvedTitle(doc);
  const parts: string[] = [];

  parts.push(`<div class="${doc.steps.length > 3 ? "cover" : "cover cover-flow"}">
${masthead(doc, "ClawCode workflow report - complete record", title, resolvedDek(doc))}
${statband(doc)}
${metaLine(doc)}`);

  parts.push(
    block(
      "Contents",
      `<ol class="toc">${doc.steps
        .map(
          (s, i) =>
            `<li><span class="n">${String(i + 1).padStart(2, "0")}</span>` +
            `<span>${escapeHtml(humanizeStepId(s.stepId))}</span>` +
            `<span class="dots"></span>` +
            `<span class="st">${escapeHtml(isDone(s) ? fmtDuration(s.durationMs) : "failed")}</span></li>`,
        )
        .join("")}</ol>`,
    ),
  );
  parts.push("</div>"); // end cover

  doc.steps.forEach((step, i) => {
    const idx = String(i + 1).padStart(2, "0");
    const head =
      `<h2 class="step-title">${escapeHtml(humanizeStepId(step.stepId))} ` +
      `<span class="pill ${isDone(step) ? "" : "fail"}">${escapeHtml(step.status)}</span></h2>`;
    const provenance = step.prompt?.trim()
      ? `<div class="callout"><div class="callout-label">Instruction</div><p>${escapeHtml(
          step.prompt.trim(),
        )}</p></div>`
      : "";
    const body = isDone(step)
      ? renderMarkdown(
          stripRedundantLeadHeading(
            step.result ?? "_No output was returned._",
            humanizeStepId(step.stepId),
          ),
        )
      : `<div class="callout"><div class="callout-label">Error</div><p>${escapeHtml(
          step.error ?? "No error was reported.",
        )}</p></div>`;
    parts.push(
      // `loose` because a full step is routinely longer than a page; forbidding
      // a break inside would push it whole and leave half-empty pages.
      block("Step", `${head}${provenance}${body}`, {
        idx,
        mark: isDone(step) ? fmtDuration(step.durationMs) : "failed",
        markCls: isDone(step) ? "ok" : "fail",
        loose: true,
      }),
    );
  });

  parts.push(colophon(doc, "Complete record"));
  return shell(`${title} - Full report`, parts.join("\n"));
}

/**
 * INC-2026-08-14b — the AUTHORED brief, phone-shaped.
 *
 * `markdown` is the report the synthesis WORKER wrote (a full agent turn with
 * every sibling result in context) - this function only typesets it through
 * the same escape-first pipeline. Dark, single-column, large type: the
 * operator reads these from Discord on a phone, where a Letter page is
 * unreadable. Page geometry: 360x640pt via PdfJob.page (the caller pairs
 * this HTML with MOBILE_PAGE).
 */
// Playwright's page.pdf rejects `pt` units - inches only.
// 4.5in x 8in, 0.05in margins: the page IS the card. Interior spacing lives in
// the body padding (CSS), where the dark ground fills to the paper edge - a
// PDF margin on a dark page prints as a white frame, which was most of the
// "massive margins" complaint. Reads full-width on a phone and as a crisp
// centered column on desktop.
export const MOBILE_PAGE = {
  width: "4.5in",
  height: "8in",
  margin: { top: "0.05in", bottom: "0.05in", left: "0.05in", right: "0.05in" },
} as const;

/**
 * INC-2026-08-14c — AGENT-DESIGNED report. The synthesis worker authored a
 * complete HTML document (design chosen for the content); the daemon only
 * hardens and equips it:
 *  - strips <script> blocks (belt) - JS is ALSO disabled at render (braces),
 *    and every network request is aborted (the load-bearing guard);
 *  - injects the embedded @font-face pack so the families the prompt promised
 *    actually resolve (nothing else on clawdy has them);
 *  - pins the page geometry via @page so the agent's design fills the sheet.
 */
export function hardenAgentDesignedHtml(rawHtml: string): string {
  const noScripts = rawHtml
    .replace(/<script[\s>][^]*?<\/script\s*>/gi, "")
    .replace(/<script[^>]*\/>/gi, "");
  const inject =
    `<style>${fontFaceCssForAgentDocs()}` +
    `@page { size: ${MOBILE_PAGE.width} ${MOBILE_PAGE.height}; margin: 0; }` +
    `html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }` +
    `</style>`;
  // Inject before </head> when present, else right after <html ...>.
  if (/<\/head>/i.test(noScripts)) {
    return noScripts.replace(/<\/head>/i, `${inject}</head>`);
  }
  return noScripts.replace(/(<html[^>]*>)/i, `$1<head>${inject}</head>`);
}

export function buildAuthoredReportHtml(doc: ReportDoc, markdown: string): string {
  const kicker = `${doc.agentName} · ${fmtTimestamp(doc.generatedAt)}`;
  const body = renderMarkdown(markdown);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${escapeHtml(resolvedTitle(doc))}</title>
<style>${mobileCss()}</style>
</head><body class="mobile"><div class="m-page">
<p class="m-kicker">${escapeHtml(kicker)}</p>
${body}
<div class="m-colophon">workflow ${escapeHtml(doc.workflowId)} · per-step research: workflows/${escapeHtml(doc.workflowId)}/ in the workspace</div>
</div></body></html>`;
}

/**
 * The `footerTemplate` for `page.pdf`. Chromium renders header/footer templates
 * in an isolated context with NO access to the page's stylesheet or its
 * `@font-face` rules, so this carries its own inline styling and names only
 * fonts that exist on the host.
 */
export function footerTemplate(doc: ReportDoc, kind: string): string {
  const left = escapeHtml(`${kind} - ${doc.workflowId}`);
  return `<div style="width:100%;font-family:'Liberation Mono',monospace;font-size:7px;
letter-spacing:0.09em;color:#8A877E;padding:0 15mm;display:flex;justify-content:space-between;">
<span>${left}</span><span class="pageNumber"></span></div>`;
}
