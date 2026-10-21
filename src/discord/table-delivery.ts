/**
 * Outbound table planner — the async counterpart of `formatOutboundText`.
 *
 * `formatOutboundText` is sync and text-only (it runs on every streaming
 * edit). At FINAL delivery we can afford one more step: wide numeric grids
 * that have no readable text form become PNG cards attached to the message,
 * and a one-line subtext placeholder marks where the table was. Everything
 * else still goes through the text renderer. Fail-open: any rendering error
 * → plain `formatOutboundText` result, no files.
 *
 * Which tables become images (all must hold):
 *   - adaptive mode, `image.enabled`;
 *   - ≥ `image.minColumns` columns, 1..`image.maxRows` data rows;
 *   - aligned monospace width exceeds `mobileColumnBudget` (a fence would
 *     scroll sideways on a phone — narrow grids stay text);
 *   - grid-like: ≥ 70 % of non-first-column cells are ≤ 18 chars and no
 *     cell exceeds `image.maxCellChars` (prose-like tables stay cards).
 */

import { buildTableSvg } from "./table-image/table-image.js";
import {
  DEFAULT_TABLE_IMAGE_CONFIG,
  findMarkdownTables,
  formatOutboundTextWith,
  getTableRenderConfig,
  type ParsedTable,
  type TableImageConfig,
  type TableRenderConfig,
} from "./markdown-table-wrap.js";

/** One attachment produced by the planner. `anchor` = the placeholder line it belongs under. */
export interface OutboundFile {
  readonly attachment: Buffer;
  readonly name: string;
  readonly description?: string;
  readonly anchor?: string;
}

export interface OutboundPlan {
  readonly text: string;
  readonly files: readonly OutboundFile[];
}

export interface PlanOptions {
  readonly cfg?: TableRenderConfig;
  /** Injected renderer (tests). */
  readonly render?: (svg: string, scale: number) => Promise<Buffer>;
  readonly log?: { warn: (o: object, m: string) => void };
}

const SHORT_CELL_CHARS = 18;
const GRID_SHORT_SHARE = 0.7;
const MAX_IMAGES_PER_MESSAGE = 4;
const CAPTION_MAX_CHARS = 70;

function imageCfg(cfg: TableRenderConfig): TableImageConfig {
  return cfg.image ?? DEFAULT_TABLE_IMAGE_CONFIG;
}

export function isImageWorthy(t: ParsedTable, cfg: TableRenderConfig): boolean {
  const img = imageCfg(cfg);
  if (cfg.mode !== "adaptive" || !img.enabled) return false;
  if (t.nCols < img.minColumns) return false;
  if (t.rows.length === 0 || t.rows.length > img.maxRows) return false;
  if (t.alignedWidth <= cfg.mobileColumnBudget) return false;
  if (t.maxCellChars > img.maxCellChars) return false;
  const cells = t.rows.flatMap((r) => r.slice(1)).filter((c) => c.trim().length > 0);
  if (cells.length === 0) return false;
  const short = cells.filter((c) => c.length <= SHORT_CELL_CHARS).length;
  return short / cells.length >= GRID_SHORT_SHARE;
}

/** A heading / bold line immediately above the table becomes the card title. */
export function captionFor(lines: readonly string[], t: ParsedTable): string {
  for (let i = t.start - 1; i >= Math.max(0, t.start - 2); i--) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const stripped = raw.replace(/^#{1,3}\s+/, "").replace(/^\*\*(.+?)\*\*:?$/, "$1").replace(/:$/, "").trim();
    const heading = /^#{1,3}\s/.test(raw) || /^\*\*.+\*\*:?$/.test(raw) || raw.endsWith(":");
    if (heading && stripped.length > 0 && stripped.length <= CAPTION_MAX_CHARS) return stripped;
    break;
  }
  const h0 = (t.header[0] ?? "").trim();
  return h0.length >= 2 ? h0 : "Table";
}

export function placeholderLine(
  title: string,
  nRows: number,
  nCols: number,
  index: number,
  total = 1,
  opts: { readonly titleFromHeading?: boolean } = {},
): string {
  // 2026-08-27 sweep — the reader doesn't need "6 rows × 6 columns", and when
  // the title was lifted from the heading directly above, repeating it here
  // read as a stutter. Word-boundary clip (same class of bug as sanitizeLabel).
  const cleaned = title.replace(/[*_`~|>\[\]]/g, "").replace(/\s+/g, " ").trim();
  let safe = cleaned;
  if (safe.length > CAPTION_MAX_CHARS) {
    const cut = safe.slice(0, CAPTION_MAX_CHARS);
    const sp = cut.lastIndexOf(" ");
    safe = (sp > CAPTION_MAX_CHARS / 2 ? cut.slice(0, sp) : cut).trim();
  }
  safe = safe.replace(/[\s,;:.\-–—·]+$/u, "");
  const which = total > 1 ? `table ${index} of ${total} below` : "table below";
  const hint = nRows > 12 ? " · tap to expand" : "";
  const label = opts.titleFromHeading || safe.length === 0 ? "" : `${safe} · `;
  return `-# 📊 ${label}${which}${hint}`;
}

/** Matches a `placeholderLine` output (any title, any index). */
export const TABLE_PLACEHOLDER_RE = /^-# 📊 .*\btable(?: \d+ of \d+)? below(?: · tap to expand)?$/u;

/**
 * 2026-08-28 — when the PNG card rides the SAME message the reader sees it
 * directly under the text, so a mid-body "📊 table below" marker is noise
 * (the 11:41 screenshot had it between the answer line and the body). Only
 * the single-message exit strips; chunked legs keep the marker because
 * `chunkIndexForFile` uses it to place each card on its chunk.
 */
export function stripTablePlaceholders(text: string): string {
  const kept = text.split("\n").filter((l) => !TABLE_PLACEHOLDER_RE.test(l.trim()));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
}

/** True when the caption for `t` came from a heading immediately above it. */
export function captionFromHeading(lines: readonly string[], t: ParsedTable): boolean {
  for (let i = t.start - 1; i >= Math.max(0, t.start - 2); i--) {
    const raw = lines[i].trim();
    if (!raw) continue;
    return /^#{1,3}\s/.test(raw) || /^\*\*.+\*\*:?$/.test(raw) || raw.endsWith(":");
  }
  return false;
}

/**
 * Plan the final delivery of `raw`: image-worthy tables → PNG files +
 * placeholder lines; then the standard text renderer over the remainder.
 */
export async function planOutboundTables(raw: string, opts: PlanOptions = {}): Promise<OutboundPlan> {
  const cfg = opts.cfg ?? getTableRenderConfig();
  const fallback = (): OutboundPlan => ({ text: formatOutboundTextWith(raw, cfg), files: [] });
  if (!raw || cfg.mode !== "adaptive" || !imageCfg(cfg).enabled) return fallback();
  try {
    const lines = raw.split("\n");
    const candidates = findMarkdownTables(lines).filter((t) => isImageWorthy(t, cfg)).slice(0, MAX_IMAGES_PER_MESSAGE);
    if (candidates.length === 0) return fallback();
    // Lazy: the rasteriser carries the embedded font module (~270 KB) and the
    // native resvg binding — neither belongs in the bridge/daemon import graph.
    const render =
      opts.render ??
      (async (svg: string, scale: number) => {
        const { renderSvgToPng } = await import("./table-image/render-png.js");
        return renderSvgToPng(svg, { scale });
      });
    const files: OutboundFile[] = [];
    const replacements: Array<{ start: number; end: number; line: string }> = [];
    let index = 0;
    for (const t of candidates) {
      const title = captionFor(lines, t);
      const layout = buildTableSvg({ header: t.header, rows: t.rows, aligns: t.aligns, title });
      const png = await render(layout.svg, imageCfg(cfg).scale);
      index += 1;
      const anchor = placeholderLine(title, t.rows.length, t.nCols, index, candidates.length, {
        titleFromHeading: captionFromHeading(lines, t),
      });
      files.push({ attachment: png, name: `table-${index}.png`, description: layout.alt, anchor });
      replacements.push({ start: t.start, end: t.end, line: anchor });
    }
    // Splice bottom-up so earlier indices stay valid.
    const out = [...lines];
    for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
      out.splice(r.start, r.end - r.start, r.line);
    }
    return { text: formatOutboundTextWith(out.join("\n"), cfg), files };
  } catch (err) {
    opts.log?.warn({ error: err instanceof Error ? err.message : String(err) }, "table image planning failed — text fallback");
    return fallback();
  }
}

/** Index of the chunk a file belongs to: first chunk containing its anchor, else the last. */
export function chunkIndexForFile(chunks: readonly string[], file: OutboundFile): number {
  if (file.anchor) {
    const i = chunks.findIndex((c) => c.includes(file.anchor as string));
    if (i >= 0) return i;
  }
  return Math.max(0, chunks.length - 1);
}
