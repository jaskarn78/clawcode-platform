/**
 * Phase 101 T04 — text-PDF handler.
 *
 * Extracts text directly via pdf-parse v2 (per page via `TextResult.pages`).
 *
 * WP3 (2026-10-25), mixed documents: a PDF is typed `text-pdf` as soon as
 * one page has a text layer, so scanned pages inside it (a stamped
 * remittance, a signature page) used to be dropped silently. Pages whose
 * text layer is empty are now rendered to PNG (pdftoppm, best effort) and
 * returned with `imageBuffer` set so the engine OCRs them exactly like the
 * scanned-PDF path. Pages that render blank (near-uniform pixels) are left
 * text-less so they never reach the paid OCR tier. When no renderer is
 * available the page stays text-less, as before.
 */

import sharp from "sharp";
import type { BatchedPage } from "../types.js";
import { DIMENSION_MAX_PX, MAX_PAGES, IngestError } from "../page-batch.js";
import { renderPdfPagesToPng, type PdfPagesRenderer } from "../pdf-render.js";

/** Pattern matching pdf-parse v2's `-- N of N --` per-page separator. */
const PAGE_SEPARATOR_RE = /--\s*\d+\s+of\s+\d+\s*--/g;

/**
 * A rendered page whose every channel has a pixel standard deviation below
 * this is treated as blank (white separator pages, empty backs).
 */
const BLANK_PAGE_MAX_STDEV = 2;

export type TextPdfOptions = {
  /** Renderer for text-less pages. Defaults to pdftoppm; null disables. */
  readonly renderPages?: PdfPagesRenderer | null;
};

type FittedPage = {
  readonly buffer: Buffer;
  readonly width?: number;
  readonly height?: number;
  readonly blank: boolean;
};

/** Resize a rendered page to the engine's pixel budget (T-101-04). */
async function fitPage(png: Buffer): Promise<FittedPage> {
  const resized = await sharp(png)
    .resize({
      width: DIMENSION_MAX_PX,
      height: DIMENSION_MAX_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  const img = sharp(resized);
  const [meta, stats] = await Promise.all([img.metadata(), img.stats()]);
  const blank = stats.channels.every((c) => c.stdev < BLANK_PAGE_MAX_STDEV);
  return { buffer: resized, width: meta.width, height: meta.height, blank };
}

export async function handleTextPdf(
  buffer: Buffer,
  opts: TextPdfOptions = {},
): Promise<readonly BatchedPage[]> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  const renderPages = opts.renderPages === undefined ? renderPdfPagesToPng : opts.renderPages;
  let perPage: ReadonlyArray<{ num: number; text: string }>;
  try {
    const result = await parser.getText();
    perPage =
      Array.isArray(result.pages) && result.pages.length > 0
        ? result.pages
        : // Older pdf-parse shapes: fall back to splitting the concatenated text.
          (result.text ?? "")
            .split(/\f/)
            .map((text, idx) => ({ num: idx + 1, text }));
  } finally {
    await parser.destroy();
  }

  if (perPage.length > MAX_PAGES) {
    throw new IngestError(`document exceeds MAX_PAGES=${MAX_PAGES}`);
  }

  const texts = perPage.map((p) => ({
    num: p.num,
    text: (p.text ?? "").replace(PAGE_SEPARATOR_RE, "").trim(),
  }));
  const textless = texts.filter((p) => p.text.length === 0).map((p) => p.num);

  let rendered: ReadonlyMap<number, Buffer> = new Map();
  if (renderPages !== null && textless.length > 0) {
    try {
      rendered = await renderPages(buffer, textless);
    } catch {
      rendered = new Map();
    }
  }

  const pages: BatchedPage[] = [];
  for (const page of texts) {
    const png = page.text.length === 0 ? rendered.get(page.num) : undefined;
    if (png === undefined) {
      pages.push({ pageNumber: page.num, text: page.text });
      continue;
    }
    try {
      const fitted = await fitPage(png);
      if (fitted.blank) {
        pages.push({ pageNumber: page.num, text: "" });
        continue;
      }
      pages.push({
        pageNumber: page.num,
        imageBuffer: fitted.buffer,
        widthPx: fitted.width,
        heightPx: fitted.height,
      });
    } catch {
      pages.push({ pageNumber: page.num, text: page.text });
    }
  }
  return pages;
}
