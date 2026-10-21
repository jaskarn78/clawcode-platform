/**
 * Phase 101 T04 — page batching with dimension + count + bytes control (U3).
 *
 * Greedy bin-packing: accumulate pages into a batch until either
 *   - count == DEFAULT_BATCH_SIZE (5 pages), or
 *   - cumulative byte size > MAX_BATCH_BYTES (~25 MB, 5 MB headroom under
 *     Anthropic's documented 30 MB per-request ceiling).
 *
 * DIMENSION_MAX_PX (2000px) is the per-page resize budget — enforced inside
 * each image-producing handler (scanned-pdf.ts, image.ts) BEFORE pages reach
 * batchPages. The constant lives here so the rest of the engine has one
 * canonical import site (mitigation surface for T-101-04).
 *
 * MAX_PAGES (500) is the per-document hard cap (T-101-03 mitigation).
 * Documents over the cap reject with IngestError.
 */

import type { BatchedPage } from "./types.js";

/** Per-batch page count cap (Anthropic request: max 20 images, we use 5). */
export const DEFAULT_BATCH_SIZE = 5;

/** Per-batch bytes cap (~25 MB, 5 MB headroom under 30 MB API ceiling). */
export const MAX_BATCH_BYTES = 25 * 1024 * 1024;

/** Per-image long-side pixel cap. */
export const DIMENSION_MAX_PX = 2000;

/** Per-document hard cap (T-101-03 DoS mitigation). */
export const MAX_PAGES = 500;

export type BatchOptions = {
  readonly batchSize?: number;
  readonly maxBytes?: number;
};

/** Thrown by handlers / batcher on cap violations. */
export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestError";
  }
}

/**
 * Greedy-pack pages into batches under the count + bytes caps. Throws
 * IngestError if `pages.length` exceeds MAX_PAGES (T-101-03).
 *
 * Empty input returns an empty array (caller-friendly — no special-case
 * required for empty documents).
 */
export function batchPages(
  pages: readonly BatchedPage[],
  opts: BatchOptions = {},
): readonly (readonly BatchedPage[])[] {
  if (pages.length > MAX_PAGES) {
    throw new IngestError(`document exceeds MAX_PAGES=${MAX_PAGES}`);
  }

  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBytes = opts.maxBytes ?? MAX_BATCH_BYTES;

  const batches: BatchedPage[][] = [];
  let current: BatchedPage[] = [];
  let currentBytes = 0;

  for (const page of pages) {
    const pageBytes = page.imageBuffer?.byteLength ?? 0;

    // Flush before-add if this page would exceed limits.
    if (
      current.length >= batchSize ||
      (current.length > 0 && currentBytes + pageBytes > maxBytes)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }

    current.push(page);
    currentBytes += pageBytes;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}
