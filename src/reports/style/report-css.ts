/**
 * The report stylesheet: one committed aesthetic, printed.
 *
 * DIRECTION - "research desk". These documents are read the way a buy-side
 * research note is read: skimmed for the number, then re-read for the argument.
 * So the page is built as a printed note, not as a web page saved to PDF.
 * A left rail carries mono section labels and the content sits in an asymmetric
 * main column at a ~68-character measure; the masthead is a full-bleed ink band;
 * every figure is set in tabular mono so columns align without markup tricks.
 * Restraint is the point - the only ornament is a hairline and one oxblood rule.
 *
 * PRINT-SPECIFIC RULES THAT ARE NOT OPTIONAL:
 *  - `page.pdf()` renders the PRINT media type, which drops background fills
 *    unless `print-color-adjust: exact` is set. Without it the ink masthead and
 *    the callouts render as blank white boxes with white text in them.
 *  - Fonts come from `fontFaceCss()` as base64 `data:` URIs. The renderer aborts
 *    every network request, and clawdy has none of these faces installed, so a
 *    plain `font-family` reference would silently fall back to Liberation Serif.
 *  - The faces are STATIC instances, not a variable font: Chromium rasterises a
 *    variable face into Type 3 fonts when it prints, and synthesises the bold.
 */

import { fontFaceCss } from "./fonts.js";

/** Ink, paper and signal colors. One accent; two status colors; nothing else. */
export const PALETTE = {
  paper: "#F7F4EE",
  paperDeep: "#EFEAE0",
  ink: "#17181B",
  inkSoft: "#4A4A46",
  inkFaint: "#8A877E",
  rule: "#D6D0C4",
  accent: "#8C2B1F",
  ok: "#2F5D50",
  warn: "#9A6B12",
} as const;

export function reportCss(): string {
  return `
${fontFaceCss()}

:root {
  --paper: ${PALETTE.paper};
  --paper-deep: ${PALETTE.paperDeep};
  --ink: ${PALETTE.ink};
  --ink-soft: ${PALETTE.inkSoft};
  --ink-faint: ${PALETTE.inkFaint};
  --rule: ${PALETTE.rule};
  --accent: ${PALETTE.accent};
  --ok: ${PALETTE.ok};
  --warn: ${PALETTE.warn};
  --rail: 104px;
  --gutter: 26px;
}

* { box-sizing: border-box; }

/* Every painted surface opts in explicitly - print media drops fills by default. */
html, body, .masthead, .statband, .callout, thead th, .chip, .cover, .rail-mark,
.pill, .toc, code, pre, .stat, blockquote {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

@page {
  size: Letter;
  margin: 16mm 15mm 18mm 15mm;
}

html { font-size: 15px; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: "Newsreader", "Liberation Serif", Georgia, serif;
  font-weight: 400;
  line-height: 1.52;
  font-feature-settings: "kern" 1, "liga" 1, "onum" 1;
  text-rendering: optimizeLegibility;
}

/* ---------------------------------------------------------------- cover ---- */

.cover { break-after: page; }
/* INC-2026-08-14 - a cover with no synthesized content lets the first section
   flow onto page 1 instead of shipping a mostly-blank opener. */
.cover.cover-flow { break-after: auto; }

.masthead {
  background: var(--ink);
  color: var(--paper);
  padding: 30px 30px 26px;
  margin: -4px -6px 0;
  position: relative;
}
.masthead::after {
  content: "";
  position: absolute;
  left: 30px; right: 30px; bottom: 0;
  height: 3px;
  background: var(--accent);
}
.masthead .kicker {
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #C9C2B4;
  margin-bottom: 16px;
}
.masthead h1 {
  font-size: 40px;
  font-weight: 600;
  line-height: 1.08;
  letter-spacing: -0.014em;
  margin: 0 0 12px;
  max-width: 16ch;
}
.masthead .dek {
  font-size: 15px;
  line-height: 1.45;
  color: #D8D2C6;
  max-width: 52ch;
  margin: 0;
}

.statband {
  display: flex;
  border-bottom: 1px solid var(--rule);
  background: var(--paper-deep);
  margin: 0 -6px;
}
.stat {
  flex: 1;
  padding: 15px 18px 14px;
  border-right: 1px solid var(--rule);
}
.stat:last-child { border-right: 0; }
.stat .label {
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 8.5px;
  font-weight: 600;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--ink-faint);
  margin-bottom: 6px;
}
.stat .value {
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 21px;
  font-weight: 600;
  font-feature-settings: "tnum" 1, "lnum" 1;
  letter-spacing: -0.02em;
  line-height: 1;
}
.stat .value.accent { color: var(--accent); }
.stat .value.ok { color: var(--ok); }

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0 30px;
  padding: 14px 0 0;
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 9.5px;
  letter-spacing: 0.06em;
  color: var(--ink-faint);
}
.meta b { color: var(--ink-soft); font-weight: 600; }

/* --------------------------------------------------------------- layout ---- */

section.block {
  display: grid;
  grid-template-columns: var(--rail) 1fr;
  column-gap: var(--gutter);
  border-top: 1px solid var(--rule);
  padding-top: 16px;
  margin-top: 26px;
  break-inside: avoid-page;
}
section.block.loose { break-inside: auto; }

.rail {
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-faint);
  line-height: 1.6;
  padding-top: 3px;
}
.rail .idx {
  display: block;
  font-size: 17px;
  letter-spacing: -0.02em;
  color: var(--accent);
  font-feature-settings: "tnum" 1, "lnum" 1;
  margin-bottom: 5px;
}
.rail .label { display: block; }
.rail .rail-mark {
  display: inline-block;
  margin-top: 7px;
  padding: 2px 6px;
  font-size: 8px;
  letter-spacing: 0.08em;
  /* Durations are lowercase ("6m 42s"); uppercasing them reads as a shout. */
  text-transform: none;
  border: 1px solid var(--rule);
  color: var(--ink-soft);
  white-space: nowrap;
}
.rail .rail-mark.fail { color: var(--accent); border-color: var(--accent); }
.rail .rail-mark.ok { color: var(--ok); border-color: var(--ok); }

/* min() rather than a bare 68ch, which overflows the grid track at this rail
   width - the symptom is a table's right column clipped at the paper edge. */
.body { max-width: min(68ch, 100%); min-width: 0; }
.body > :first-child { margin-top: 0; }

h2 {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.012em;
  line-height: 1.18;
  margin: 0 0 10px;
}
/* INC-2026-08-14 - a step's own title vs headings from the WORKER's markdown
   (demoted h1 -> h2) rendered at the same 22px, flattening the hierarchy.
   The section keeps 22px via .step-title; content h2s drop to 17px with a
   hairline so a worker's internal structure reads as SUB-structure. */
.body h2 { font-size: 17px; margin: 18px 0 8px; padding-bottom: 4px;
  border-bottom: 1px solid var(--rule); }
.body h2.step-title { font-size: 22px; margin: 0 0 10px; padding-bottom: 0;
  border-bottom: none; }
h3 {
  font-size: 15.5px;
  font-weight: 600;
  letter-spacing: 0.002em;
  margin: 20px 0 7px;
}
h4, h5, h6 {
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-soft);
  margin: 18px 0 6px;
}

p { margin: 0 0 11px; }
p:last-child { margin-bottom: 0; }

.lede {
  font-size: 17px;
  line-height: 1.45;
  color: var(--ink-soft);
}

ul, ol { margin: 0 0 11px; padding-left: 19px; }
li { margin-bottom: 4px; }
li::marker { color: var(--accent); }
ol li::marker {
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 11px;
  font-feature-settings: "tnum" 1;
}
li .sub { color: var(--ink-soft); }

blockquote {
  margin: 14px 0;
  padding: 3px 0 3px 15px;
  border-left: 2px solid var(--accent);
  color: var(--ink-soft);
  font-size: 15.5px;
}

hr.rule {
  border: 0;
  border-top: 1px solid var(--rule);
  margin: 18px 0;
}

code {
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 0.84em;
  background: var(--paper-deep);
  border: 1px solid var(--rule);
  border-radius: 2px;
  padding: 0.5px 4px;
  word-break: break-word;
}
pre {
  background: var(--paper-deep);
  border: 1px solid var(--rule);
  border-left: 2px solid var(--ink-faint);
  padding: 11px 13px;
  margin: 13px 0;
  overflow-wrap: break-word;
  white-space: pre-wrap;
  break-inside: avoid-page;
}
pre code {
  background: none;
  border: 0;
  padding: 0;
  font-size: 10.5px;
  line-height: 1.5;
}
.url {
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 0.78em;
  color: var(--ink-faint);
  word-break: break-all;
}

/* --------------------------------------------------------------- tables ---- */

.table-wrap { margin: 14px 0; break-inside: avoid-page; }
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  line-height: 1.35;
}
thead th {
  background: var(--paper-deep);
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 8.5px;
  font-weight: 600;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: var(--ink-soft);
  text-align: left;
  padding: 7px 9px;
  border-bottom: 1.5px solid var(--ink);
}
td {
  padding: 6px 9px;
  border-bottom: 1px solid var(--rule);
  vertical-align: top;
}
tbody tr:last-child td { border-bottom: 1.5px solid var(--ink); }
td.num, th.a-right {
  text-align: right;
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 11px;
  font-feature-settings: "tnum" 1, "lnum" 1;
  white-space: nowrap;
}
th.a-center, td.a-center { text-align: center; }

/* -------------------------------------------------------------- accents ---- */

.callout {
  background: var(--paper-deep);
  border-left: 3px solid var(--accent);
  padding: 13px 16px;
  margin: 16px 0;
  break-inside: avoid-page;
}
.callout .callout-label {
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 8.5px;
  font-weight: 600;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 6px;
}
.callout p { font-size: 14px; }

.pill {
  display: inline-block;
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 8.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 2px 7px;
  border: 1px solid currentColor;
  color: var(--ok);
}
.pill.fail { color: var(--accent); }
.pill.warn { color: var(--warn); }

.toc { margin: 0; padding: 0; list-style: none; }
.toc li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--rule);
  font-size: 13.5px;
}
.toc .n {
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  font-feature-settings: "tnum" 1;
  min-width: 22px;
}
.toc .dots { flex: 1; border-bottom: 1px dotted var(--rule); }
.toc .st {
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 8.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-faint);
}

.colophon {
  margin-top: 30px;
  padding-top: 12px;
  border-top: 1px solid var(--rule);
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 8.5px;
  letter-spacing: 0.09em;
  color: var(--ink-faint);
  line-height: 1.7;
}
`;
}

/**
 * INC-2026-08-14b — the authored mobile brief. Dark by deliberate choice: the
 * operator's reference PDF (the agent-made "Kids' Weekend" guide) was dark,
 * phone-shaped and chunky, and reads far better in a dim room than paper-white.
 * Same faces (embedded, data:), same accent family shifted for a dark ground.
 */
export function mobileCss(): string {
  return `
${fontFaceCss()}
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html { font-size: 16px; }
body.mobile {
  margin: 0;
  background: #17181B;
  color: #E4E1D8;
  font-family: "IBM Plex Sans", "Liberation Sans", sans-serif;
  line-height: 1.5;
}
/* Interior spacing lives HERE, not in the PDF margin - the dark ground runs
   to the paper edge so no white frame appears around the page. */
.m-page { padding: 20px 18px 16px; min-height: 100%; background: #17181B; }
.m-kicker {
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 9.5px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase;
  color: #E8A33D; margin: 0 0 10px;
}
h2 { /* the authored title (content h1 demotes here) */
  font-family: "IBM Plex Sans Condensed", "IBM Plex Sans", sans-serif;
  font-size: 30px; font-weight: 700; line-height: 1.04; letter-spacing: -.012em;
  color: #FFFFFF; margin: 0 0 10px; text-wrap: balance;
}
h3 { /* content h2 - section heads */
  font-family: "IBM Plex Sans Condensed", "IBM Plex Sans", sans-serif;
  font-size: 19px; font-weight: 700; color: #FFFFFF;
  margin: 22px 0 8px;
}
h4, h5, h6 { /* content h3+ - the FRIDAY-style bars from the reference */
  font-family: "IBM Plex Mono", "Liberation Mono", monospace;
  font-size: 10px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase;
  color: #FFFFFF; background: #B3541E;
  padding: 5px 9px 4px; border-radius: 3px; margin: 18px 0 8px;
  break-after: avoid-page;
}
p { margin: 0 0 9px; font-size: 13.5px; color: #C9C5BB; }
p:first-of-type { color: #E4E1D8; } /* the standfirst reads a step brighter */
ul, ol { margin: 0 0 12px; padding-left: 24px; }
li { margin-bottom: 8px; font-size: 13.5px; color: #C9C5BB; }
li::marker { color: #E8A33D; font-weight: 700; }
ol li::marker {
  font-family: "IBM Plex Sans Condensed", sans-serif;
  font-size: 15px;
}
strong { color: #FFFFFF; font-weight: 600; }
blockquote { margin: 10px 0; padding: 2px 0 2px 11px; border-left: 3px solid #E8A33D; color: #B0ACA2; }
hr.rule { border: 0; border-top: 1px solid #2E3138; margin: 14px 0; }
code {
  font-family: "IBM Plex Mono", monospace; font-size: .85em;
  background: #23262C; border: 1px solid #2F333A; border-radius: 3px; padding: .5px 4px;
  color: #E4E1D8;
}
pre { background: #23262C; border: 1px solid #2F333A; padding: 9px 11px; margin: 10px 0;
  white-space: pre-wrap; overflow-wrap: break-word; break-inside: avoid-page; }
pre code { background: none; border: 0; padding: 0; font-size: 10.5px; }
.url { font-family: "IBM Plex Mono", monospace; font-size: .78em; color: #8B95A3; word-break: break-all; }
.table-wrap { margin: 10px 0; break-inside: avoid-page; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
thead th {
  font-family: "IBM Plex Mono", monospace; font-size: 8.5px; font-weight: 600;
  letter-spacing: .1em; text-transform: uppercase; color: #8B95A3; text-align: left;
  padding: 6px 8px; border-bottom: 1.5px solid #E4E1D8; background: #23262C;
}
td { padding: 6px 8px; border-bottom: 1px solid #2E3138; vertical-align: top; color: #C9C5BB; }
td.num, th.a-right { text-align: right; font-family: "IBM Plex Mono", monospace;
  font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.m-colophon {
  margin-top: 20px; padding-top: 8px; border-top: 1px solid #2E3138;
  font-family: "IBM Plex Mono", monospace; font-size: 8px; letter-spacing: .07em;
  color: #6E7681;
}
`;
}
