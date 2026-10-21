/**
 * Table image — render a markdown table as a dark "card" PNG for Discord.
 *
 * ## Why an image
 *
 * Discord never renders markdown tables, and the same bytes serve desktop
 * and phone. Text fallbacks (`markdown-table-wrap.ts`) cover 2-column
 * tables (list) and narrow grids (monospace fence), but a genuinely wide
 * numeric grid — scenario years × balances, bracket charts, option
 * comparisons — has no readable text form on a phone: a fenced grid scrolls
 * sideways, cards explode into 60 lines. A rendered image keeps the grid
 * intact on desktop and is pinch-zoomable on mobile, with the alt text
 * (attachment `description`) carrying the data for screen readers.
 *
 * ## Design
 *
 *   - Dark card matching Discord's dark theme (`#2b2d31` surface, `#dbdee1`
 *     text, `#949ba4` muted), rounded corners, header band, zebra rows,
 *     accent bar. Light-theme viewers see a dark card — the same convention
 *     every code block already follows.
 *   - JetBrains Mono (embedded — the host has no fonts we can rely on).
 *     Strictly monospaced, so layout is exact arithmetic: width = chars ×
 *     0.6 em. Digits align by construction.
 *   - Numeric columns right-aligned (detected per column, or from the
 *     separator row's `---:` marker), the first column left-aligned.
 *   - Cells word-wrap to a per-column cap; rows grow. Total width is
 *     clamped to [minWidth, maxWidth] by tightening the widest column.
 *   - Emoji / glyphs outside the embedded subset are mapped to text
 *     equivalents (✅→✓, ❌→✗ …) or dropped — never rendered as tofu.
 *
 * Pure: builds SVG + alt text. Rasterisation lives in `render-png.ts`.
 */

export type ImageAlign = "left" | "right" | "center";

export interface TableImageInput {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** Per-column alignment from the separator row (`:---:`); may be shorter than nCols. */
  readonly aligns?: readonly ImageAlign[];
  readonly title?: string;
}

export interface TableImageStyle {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly padX: number;
  readonly padY: number;
  readonly outer: number;
  readonly titleSize: number;
  readonly maxFirstColChars: number;
  readonly maxColChars: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly accent: string;
}

export const TABLE_IMAGE_STYLE: TableImageStyle = Object.freeze({
  fontSize: 22,
  lineHeight: 30,
  padX: 18,
  padY: 9,
  outer: 26,
  titleSize: 27,
  // Generous caps: a column only wraps when the whole card would exceed
  // maxWidth (columns are then tightened widest-first).
  maxFirstColChars: 40,
  maxColChars: 32,
  minWidth: 420,
  // Discord shows an inline preview at ≈550 px on desktop (≈380 on a phone);
  // 1100 logical px at 22 px type keeps ≥ 11 px on desktop after downscale.
  maxWidth: 1100,
  accent: "#5865f2",
});

/** JetBrains Mono metrics (see fonts.generated.ts). */
const ADVANCE_EM = 0.6;
const ASCENT_EM = 1.02;
const DESCENT_EM = 0.3;
const FONT_FAMILY = "JetBrains Mono";

const COLORS = Object.freeze({
  card: "#2b2d31",
  headerBand: "#232428",
  zebra: "#2e3035",
  border: "#3f4147",
  text: "#dbdee1",
  header: "#f2f3f5",
  muted: "#949ba4",
});

export const TABLE_IMAGE_MAX_ROWS = 60;
export const ALT_TEXT_MAX = 1000;

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/** Glyphs outside (or missing from) the embedded subset → text equivalents. */
const GLYPH_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/[✅☑✔✓]️?/gu, "✓"],
  [/[❌✘❎✖]️?/gu, "✗"],
  [/⚠️?/gu, "⚠"],
  [/\u{1F195}/gu, "NEW"],
  [/[⭐★☆]️?/gu, "*"],
  [/\u{1F4C8}/gu, "↑"],
  [/\u{1F4C9}/gu, "↓"],
  [/\u{1F53A}️?/gu, "▲"],
  [/\u{1F53B}️?/gu, "▼"],
  [/➡️?/gu, "→"],
  [/⬅️?/gu, "←"],
  [/⬆️?/gu, "↑"],
  [/⬇️?/gu, "↓"],
  [/☐/gu, "[ ]"],
  [/₹/gu, "Rs"],
  [/[█░▒▓]/gu, "#"],
];

// Everything the subset does NOT cover (see fonts.generated.ts ranges).
const UNSUPPORTED_RE =
  /[^\u0020-\u007E\u00A0-\u017F\u2000-\u206F\u20A0-\u20CF\u2100-\u214F\u2190-\u21FF\u2200-\u22FF\u2500-\u257F\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF\u2B00-\u2BFF]/gu;

/** Strip inline markdown and map glyphs so a cell renders as plain text. */
export function normalizeCellText(raw: string): string {
  let s = raw.replace(/\\\|/g, "|");
  s = s.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1"); // [text](url) → text
  s = s.replace(/(\*\*|__|~~|`)/g, "");
  s = s.replace(/(?<!\w)\*(?!\s)([^*]+?)\*(?!\w)/g, "$1"); // *em* → em
  for (const [re, rep] of GLYPH_MAP) s = s.replace(re, rep);
  s = s.replace(/[\u200B-\u200D\uFE0F]/gu, "");
  s = s.replace(UNSUPPORTED_RE, "");
  return s.replace(/\s+/g, " ").trim();
}

const NUMERIC_RE = /^[(\s]*[-−+]?\s?[$€£¥]?\s?\d[\d,.\s]*%?\s?(?:[kKmMbBxX]|bps|pts|yrs?|mo)?[)\s]*$|^[-−–]$|^n\/a$|^—$/i;

export function looksNumeric(cell: string): boolean {
  const s = cell.trim();
  if (!s) return false;
  return NUMERIC_RE.test(s);
}

/** Greedy word wrap to `width` chars; over-long tokens are hard-split. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(4, width);
  const out: string[] = [];
  let line = "";
  for (const tok of text.split(" ")) {
    if (!tok) continue;
    const parts: string[] = [];
    for (let i = 0; i < tok.length; i += w) parts.push(tok.slice(i, i + w));
    for (const part of parts) {
      if (!line) line = part;
      else if (line.length + 1 + part.length <= w) line += ` ${part}`;
      else {
        out.push(line);
        line = part;
      }
    }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface TableImageLayout {
  readonly width: number;
  readonly height: number;
  readonly svg: string;
  readonly alt: string;
  readonly nCols: number;
  readonly nRows: number;
}

interface ColumnPlan {
  chars: number;
  align: ImageAlign;
}

function columnAlign(index: number, cells: readonly string[], declared: ImageAlign | undefined): ImageAlign {
  if (declared === "right" || declared === "center") return declared;
  if (index === 0) return "left";
  const filled = cells.filter((c) => c.length > 0);
  if (filled.length === 0) return "left";
  const numeric = filled.filter(looksNumeric).length;
  return numeric / filled.length >= 0.7 ? "right" : "left";
}

/**
 * Build the SVG for a table. Never throws on odd input (ragged rows are
 * normalised, empty tables render a one-row card).
 */
export function buildTableSvg(input: TableImageInput, style: TableImageStyle = TABLE_IMAGE_STYLE): TableImageLayout {
  const header = input.header.map(normalizeCellText);
  const rawRows = input.rows.slice(0, TABLE_IMAGE_MAX_ROWS).map((r) => r.map(normalizeCellText));
  const nCols = Math.max(header.length, ...rawRows.map((r) => r.length), 1);
  const H = Array.from({ length: nCols }, (_, i) => header[i] ?? "");
  const rows = rawRows.map((r) => Array.from({ length: nCols }, (_, i) => r[i] ?? ""));
  const title = input.title ? normalizeCellText(input.title) : "";

  const charW = style.fontSize * ADVANCE_EM;
  const cols: ColumnPlan[] = Array.from({ length: nCols }, (_, i) => {
    const cells = rows.map((r) => r[i]);
    const natural = Math.max(H[i].length, ...cells.map((c) => c.length), 3);
    const cap = i === 0 ? style.maxFirstColChars : style.maxColChars;
    return { chars: Math.min(natural, cap), align: columnAlign(i, cells, input.aligns?.[i]) };
  });

  const widthFor = (): number =>
    cols.reduce((a, c) => a + c.chars * charW + 2 * style.padX, 0) + 2 * style.outer;
  // Tighten until the card fits the max width: always the column with the
  // most slack above its floor, where the floor is the longest single word in
  // the column (header included) — so words are never split and headers stay
  // whole; a multi-word header may wrap to two lines instead.
  const longestWord = (t: string): number => Math.max(0, ...t.split(" ").map((w) => w.length));
  const floors = cols.map((_, i) =>
    Math.max(6, longestWord(H[i]), ...rows.map((r) => longestWord(r[i]))),
  );
  let guard = 0;
  while (widthFor() > style.maxWidth && guard++ < 400) {
    let best = -1;
    let slack = 0;
    for (let i = 0; i < cols.length; i++) {
      const sl = cols[i].chars - floors[i];
      if (sl > slack) {
        slack = sl;
        best = i;
      }
    }
    if (best < 0) break;
    cols[best].chars -= Math.min(slack, 2);
  }
  const tableWidth = Math.max(widthFor(), style.minWidth);
  // Distribute slack from minWidth into the first column so text stays left-packed.
  const slack = tableWidth - widthFor();
  const colPx = cols.map((c, i) => c.chars * charW + 2 * style.padX + (i === 0 ? slack : 0));

  // Wrap every cell.
  const headerLines = H.map((h, i) => wrapText(h, cols[i].chars));
  const bodyLines = rows.map((r) => r.map((c, i) => wrapText(c, cols[i].chars)));
  const rowHeight = (lines: string[][]): number =>
    Math.max(1, ...lines.map((l) => l.length)) * style.lineHeight + 2 * style.padY;

  const titleBlock = title ? style.titleSize + 18 : 0;
  const headerH = rowHeight(headerLines);
  const bodyHs = bodyLines.map(rowHeight);
  const height = style.outer + titleBlock + headerH + bodyHs.reduce((a, b) => a + b, 0) + style.outer;
  const width = Math.round(tableWidth);

  // Baseline inside a line box: centre the (ascent+descent) box, then add ascent.
  const glyphBox = (ASCENT_EM + DESCENT_EM) * style.fontSize;
  const baseline = (style.lineHeight - glyphBox) / 2 + ASCENT_EM * style.fontSize;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.round(height)}" viewBox="0 0 ${width} ${Math.round(height)}">`,
  );
  parts.push(`<defs><clipPath id="card"><rect x="0" y="0" width="${width}" height="${Math.round(height)}" rx="16"/></clipPath></defs>`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${Math.round(height)}" rx="16" fill="${COLORS.card}"/>`);
  parts.push(`<g clip-path="url(#card)">`);

  let y = style.outer;
  if (title) {
    const tChars = Math.floor((width - 2 * style.outer) / (style.titleSize * ADVANCE_EM));
    const t = wrapText(title, tChars)[0] ?? title;
    const tBase = y + ASCENT_EM * style.titleSize * 0.92;
    parts.push(
      `<text x="${style.outer}" y="${tBase.toFixed(1)}" font-family="${FONT_FAMILY}" font-size="${style.titleSize}" font-weight="700" fill="${COLORS.header}">${escapeXml(t)}</text>`,
    );
    y += titleBlock;
  }

  const cellText = (
    lines: string[],
    colIndex: number,
    top: number,
    x0: number,
    opts: { bold: boolean; color: string },
  ): void => {
    const c = cols[colIndex];
    const w = colPx[colIndex];
    for (let li = 0; li < lines.length; li++) {
      const ly = top + style.padY + li * style.lineHeight + baseline;
      let x = x0 + style.padX;
      let anchor = "start";
      if (c.align === "right") {
        x = x0 + w - style.padX;
        anchor = "end";
      } else if (c.align === "center") {
        x = x0 + w / 2;
        anchor = "middle";
      }
      parts.push(
        `<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" font-family="${FONT_FAMILY}" font-size="${style.fontSize}"${opts.bold ? ' font-weight="700"' : ""} fill="${opts.color}" text-anchor="${anchor}">${escapeXml(lines[li])}</text>`,
      );
    }
  };

  // Header band.
  parts.push(`<rect x="0" y="${y}" width="${width}" height="${headerH}" fill="${COLORS.headerBand}"/>`);
  let x = style.outer;
  for (let i = 0; i < nCols; i++) {
    cellText(headerLines[i], i, y, x, { bold: true, color: COLORS.header });
    x += colPx[i];
  }
  y += headerH;
  parts.push(`<rect x="0" y="${y - 1}" width="${width}" height="2" fill="${COLORS.border}"/>`);

  // Body rows.
  for (let ri = 0; ri < rows.length; ri++) {
    const h = bodyHs[ri];
    if (ri % 2 === 1) parts.push(`<rect x="0" y="${y}" width="${width}" height="${h}" fill="${COLORS.zebra}"/>`);
    x = style.outer;
    for (let i = 0; i < nCols; i++) {
      cellText(bodyLines[ri][i], i, y, x, { bold: i === 0, color: i === 0 ? COLORS.header : COLORS.text });
      x += colPx[i];
    }
    y += h;
  }
  if (rows.length === 0) {
    parts.push(
      `<text x="${style.outer + style.padX}" y="${(y + style.padY + baseline).toFixed(1)}" font-family="${FONT_FAMILY}" font-size="${style.fontSize}" fill="${COLORS.muted}">(no rows)</text>`,
    );
  }
  parts.push(`<rect x="0" y="0" width="6" height="${Math.round(height)}" fill="${style.accent}"/>`);
  parts.push(`</g></svg>`);

  return {
    width,
    height: Math.round(height),
    svg: parts.join("\n"),
    alt: buildAltText(title, H, rows),
    nCols,
    nRows: rows.length,
  };
}

/** Screen-reader / fallback text for the attachment description (≤ 1000 chars). */
export function buildAltText(title: string, header: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `Table${title ? ` — ${title}` : ""}. Columns: ${header.filter(Boolean).join(", ")}.`;
  const lines: string[] = [head];
  let total = head.length;
  for (const r of rows) {
    const line = ` ${r[0] || "Row"}: ${r.slice(1).map((c, i) => `${header[i + 1] ? `${header[i + 1]} ` : ""}${c || "-"}`).join("; ")}.`;
    if (total + line.length > ALT_TEXT_MAX - 12) {
      lines.push(" (truncated)");
      break;
    }
    lines.push(line);
    total += line.length;
  }
  return lines.join("").slice(0, ALT_TEXT_MAX);
}
