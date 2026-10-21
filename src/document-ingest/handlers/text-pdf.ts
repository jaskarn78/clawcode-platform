/**
 * Phase 101 T04 — text-PDF handler.
 *
 * Extracts text directly via pdf-parse v2 — no OCR, no image rendering. Pages
 * split on the form-feed character (\f) that pdf-parse emits as its inter-page
 * separator.
 */

import type { BatchedPage } from "../types.js";
import { MAX_PAGES, IngestError } from "../page-batch.js";

/** Pattern matching pdf-parse v2's `-- N of N --` per-page separator. */
const PAGE_SEPARATOR_RE = /\n*--\s*\d+\s+of\s+\d+\s*--\n*/g;

export async function handleTextPdf(
  buffer: Buffer,
): Promise<readonly BatchedPage[]> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const raw = result.text ?? "";
    // pdf-parse v2 separates pages with `-- N of N --` markers AND form-feeds.
    // Split on the marker first, then fall back to \f if no markers found.
    const cleaned = raw.trim();
    const splitOnMarker = cleaned.split(PAGE_SEPARATOR_RE).filter((s) => s.trim().length > 0);
    const pageTexts = splitOnMarker.length > 0 ? splitOnMarker : cleaned.split(/\f/);

    if (pageTexts.length > MAX_PAGES) {
      throw new IngestError(`document exceeds MAX_PAGES=${MAX_PAGES}`);
    }

    return pageTexts.map((text, idx) => ({
      pageNumber: idx + 1,
      text: text.trim(),
    }));
  } finally {
    await parser.destroy();
  }
}
