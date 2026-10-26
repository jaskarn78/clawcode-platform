/**
 * Phase 101 document-ingestion engine — public entrypoint.
 *
 * Flow:
 *   1. detect type via magic-byte sniff (T02)
 *   2. dispatch to per-type handler (T04) — returns BatchedPage[]
 *   3. for image-bearing handlers (scanned-pdf, image), run per-page OCR
 *      through the three-tier fallback chain (T03)
 *   4. assemble final concatenated text + telemetry
 *
 * Chunking + embedding + DB writes happen downstream at the daemon's
 * `case "ingest-document"` block (T05), not here — the engine is a pure
 * text extractor.
 */

import { basename } from "node:path";
import { detectDocumentType } from "./detect.js";
import { handleTextPdf } from "./handlers/text-pdf.js";
import { handleScannedPdf } from "./handlers/scanned-pdf.js";
import { handleDocx } from "./handlers/docx.js";
import { handleXlsx } from "./handlers/xlsx.js";
import { handleImage } from "./handlers/image.js";
import { handleText } from "./handlers/text.js";
import { ocrPage } from "./ocr/index.js";
import type {
  BatchedPage,
  DocumentType,
  IngestOptions,
  IngestResult,
  IngestTelemetry,
  OcrBackend,
} from "./types.js";

export { detectDocumentType } from "./detect.js";
export { batchPages, IngestError } from "./page-batch.js";
export {
  DEFAULT_BATCH_SIZE,
  DIMENSION_MAX_PX,
  MAX_BATCH_BYTES,
  MAX_PAGES,
} from "./page-batch.js";
export { ocrPage } from "./ocr/index.js";
export { logIngest, INGEST_LOG_TAG } from "./telemetry.js";
export type {
  DocumentType,
  OcrBackend,
  BatchedPage,
  TaskHint,
  IngestOptions,
  IngestTelemetry,
  IngestResult,
} from "./types.js";

/**
 * Phase 101 Plan 03 T03 — shared helper for computing the canonical
 * `docSlug` from an input file path. Used by both the daemon's
 * `ingest-document` handler (to build the workspace `documents/` paths +
 * the cross-ingest `path: "document:<slug>"` key) and the engine's
 * telemetry. Kept in this module (the engine's public entrypoint) so
 * there is exactly one definition.
 *
 * Algorithm:
 *   1. `basename(filePath)` → strip the extension.
 *   2. Lowercase.
 *   3. Collapse any run of non `[a-z0-9-]` characters into a single `-`.
 *   4. Trim leading + trailing `-`.
 *   5. Fall back to `"document"` if the result is empty.
 *
 * This grammar is compatible with the `DOC_SLUG_RE` regex in
 * `cross-ingest.ts` (`/^[a-z0-9-]+$/`) so the cross-ingest validator
 * never rejects a slug we just produced here.
 */
export function computeDocSlug(filePath: string): string {
  const baseFilename = basename(filePath).replace(/\.[^.]+$/, "");
  const slug = baseFilename
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "document";
}

/** Compute p50 / p95 from per-page wall-clock samples (integer ms). */
function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length)),
  );
  return sorted[idx];
}

/** Run the per-type handler. Single dispatch surface. */
async function dispatchHandler(
  type: DocumentType,
  buf: Buffer,
): Promise<readonly BatchedPage[]> {
  switch (type) {
    case "text-pdf":
      return handleTextPdf(buf);
    case "scanned-pdf":
      return handleScannedPdf(buf);
    case "docx":
      return handleDocx(buf);
    case "xlsx":
      return handleXlsx(buf);
    case "image":
      return handleImage(buf);
    case "text":
      return handleText(buf);
  }
}

/**
 * Engine entrypoint. Detects type, dispatches handler, runs per-page OCR for
 * image-bearing handlers, returns concatenated text + structured telemetry.
 */
export async function ingest(
  buf: Buffer,
  filename: string,
  opts: IngestOptions = {},
): Promise<
  IngestResult & {
    text: string;
    pages: readonly BatchedPage[];
    /**
     * WP3 — per-page text in page order (OCR output included), so callers
     * can map chunk offsets inside `text` back to a page number for the
     * contextual chunk header. `text` is `pageTexts.join("\n\n").trim()`.
     */
    pageTexts: readonly string[];
  }
> {
  const type = await detectDocumentType(buf, filename);
  const slug = basename(filename).replace(/\.[^.]+$/, "") || "document";

  // Phase 999.43-fu2 T06 — fix `phase101-ingest p95_ms` populating 0 in
  // 169/171 events (latency-review-2026-05-17.md gap #3).
  //
  // Root cause: the v1 implementation used `Date.now()` (millisecond
  // resolution) wrapped around a per-page loop body that, for text-pdf,
  // does nothing more than push an already-extracted string into an array
  // — the per-page wall-clock is consistently <1ms, so every sample
  // rounded to 0. ALL of the per-page work for text-pdf actually happens
  // inside `dispatchHandler` (parses the whole PDF up front).
  //
  // Fix is two-fold:
  //   1. Use `performance.now()` for sub-ms resolution.
  //   2. Capture dispatchHandler wall-clock and amortize it across pages
  //      so text-pdf and other "front-loaded" handlers report meaningful
  //      per-page timings rather than 0.
  // Image-bearing handlers (scanned-pdf / image) keep the per-page OCR
  // measurement they already had — the amortized dispatch time is
  // additive there too, but since OCR dominates, the shape is unchanged.
  const tDispatch0 = performance.now();
  const pages = await dispatchHandler(type, buf);
  const dispatchMs = performance.now() - tDispatch0;
  const dispatchPerPageMs =
    pages.length > 0 ? dispatchMs / pages.length : dispatchMs;

  // Per-page OCR for image-bearing handlers. The CLI tier is the default;
  // tests pass skipCli/skipWasm via direct ocrPage calls if needed.
  const perPageTimings: number[] = [];
  let ocrUsed: OcrBackend = "none";
  const pageTexts: string[] = [];

  for (const page of pages) {
    const t0 = performance.now();
    if (page.text !== undefined && page.text.length > 0) {
      pageTexts.push(page.text);
    } else if (page.imageBuffer !== undefined && opts.backend === "none") {
      // WP3 — an explicit "none" backend means no OCR at all (previously it
      // fell through the paid auto-chain).
      pageTexts.push("");
    } else if (page.imageBuffer !== undefined) {
      // Phase 101 Plan 02 T03/T04 — thread the operator's explicit backend
      // override through to ocrPage so D-08 Mistral selectability + per-tier
      // overrides work end-to-end from the ingest_document MCP tool.
      const r = await ocrPage(page.imageBuffer, {
        taskHint: opts.taskHint,
        backend: opts.backend,
      });
      pageTexts.push(r.text);
      if (ocrUsed === "none") ocrUsed = r.backend;
    }
    // Per-page wall-clock + amortized dispatch share. Rounded to integer
    // ms to keep the log line shape stable (downstream sqlite/jq filters
    // don't need to handle floats). Submillisecond per-page work still
    // contributes via the dispatch amortization, which fixes the 0/0/0
    // problem observed on text-pdf.
    perPageTimings.push(
      Math.round(performance.now() - t0 + dispatchPerPageMs),
    );
  }

  const text = pageTexts.join("\n\n").trim();
  const telemetry: IngestTelemetry = {
    docSlug: slug,
    type,
    pages: pages.length,
    ocrUsed,
    chunksCreated: 0, // populated downstream after embedder chunks the text
    p50_ms: percentile(perPageTimings, 50),
    p95_ms: percentile(perPageTimings, 95),
  };

  return {
    source: filename,
    chunksCreated: 0,
    totalChars: text.length,
    telemetry,
    text,
    pages,
    pageTexts,
  };
}
