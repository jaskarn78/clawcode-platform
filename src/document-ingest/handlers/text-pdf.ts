/**
 * Phase 101 T04 — text-PDF handler.
 *
 * Extracts text directly via pdf-parse v2 (per-page via `TextResult.pages`).
 *
 * WP3 (2026-10-25) — mixed documents: a PDF is typed `text-pdf` as soon as
 * one page has a text layer, so scanned pages inside it (a stamped
 * remittance, a signature page) used to be dropped silently. Pages whose
 * text layer is empty are now rendered to PNG (pdftoppm, best effort) and
 * returned with `imageBuffer` set so the engine OCRs them exactly like the
 * scanned-PDF path. When no renderer is available the page stays text-less,
 * as before.
 */

import sharp from "sharp";
import type { BatchedPage } from "../types.js";
import { DIMENSION_MAX_PX, MAX_PAGES, IngestError } from "../page-batch.js";
import { renderPdfPageToPng, type PdfPageRenderer } from "../pdf-render.js";

/** Pattern matching pdf-parse v2's `-- N of N --` per-page separator. */
const PAGE_SEPARATOR_RE = /--\s*\d+\s+of\s+\d+\s*--/g;

export type TextPdfOptions = {
  /** Page renderer for text-less pages. Defaults to pdftoppm; null disables. */
  readonly renderPage?: PdfPageRenderer | null;
};

/** Resize a rendered page to the engine's pixel budget (T-101-04). */
async function fitPage(png: Buffer): Promise<{ buffer: Buffer; width?: number; height?: number }> {
  const resized = await sharp(png)
    .resize({
      width: DIMENSION_MAX_PX,
      height: DIMENSION_MAX_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  const meta = await sharp(resized).metadata();
  return { buffer: resized, width: meta.width, height: meta.height };
}

export async function handleTextPdf(
  buffer: Buffer,
  opts: TextPdfOptions = {},
): Promise<readonly BatchedPage[]> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  const renderPage = opts.renderPage === undefined ? renderPdfPageToPng : opts.renderPage;
  try {
    const result = await parser.getText();
    const perPage: ReadonlyArray<{ num: number; text: string }> =
      Array.isArray(result.pages) && result.pages.length > 0
        ? result.pages
        : // Older pdf-parse shapes: fall back to splitting the concatenated text.
          (result.text ?? "")
            .split(/\f/)
            .map((text, idx) => ({ num: idx + 1, text }));

    if (perPage.length > MAX_PAGES) {
      throw new IngestError(`document exceeds MAX_PAGES=${MAX_PAGES}`);
    }

    const pages: BatchedPage[] = [];
    for (const page of perPage) {
      const text = (page.text ?? "").replace(PAGE_SEPARATOR_RE, "").trim();
      if (text.length > 0 || renderPage === null) {
        pages.push({ pageNumber: page.num, text });
        continue;
      }
      // No text layer on this page: render it for OCR, best effort.
      let rendered: Buffer | null = null;
      try {
        rendered = await renderPage(buffer, page.num);
      } catch {
        rendered = null;
      }
      if (rendered === null) {
        pages.push({ pageNumber: page.num, text });
        continue;
      }
      try {
        const fitted = await fitPage(rendered);
        pages.push({
          pageNumber: page.num,
          imageBuffer: fitted.buffer,
          widthPx: fitted.width,
          heightPx: fitted.height,
        });
      } catch {
        pages.push({ pageNumber: page.num, text });
      }
    }
    return pages;
  } finally {
    await parser.destroy();
  }
}
