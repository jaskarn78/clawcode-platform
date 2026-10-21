/**
 * Phase 101 Plan 02 T03 — Mistral OCR Tier-4 stub (D-08).
 *
 * Mistral OCR 3 is wired as an off-by-default escape hatch (see
 * `defaults.documentIngest.allowMistralOcr` in `src/config/schema.ts`). The
 * config knob defaults to `false`; when an operator flips it to `true` AND
 * calls `ingest_document --backend mistral`, the dispatcher selects this
 * stub.
 *
 * The stub exists so the dispatch table compiles and the operator-facing
 * error path is explicit: "Mistral OCR backend not yet implemented (D-08
 * stub)". The actual Mistral API client + auth is a deferred 30-LOC follow-up
 * commit that the operator implements when a specific document warrants it
 * (per 101-CONTEXT.md D-08 rationale).
 */

import type { OcrResult } from "./tesseract-cli.js";

/** Throw the documented "not yet implemented" error for the D-08 stub. */
export async function ocrPageMistral(
  _imageBuffer: Buffer,
  _opts: { signal?: AbortSignal } = {},
): Promise<OcrResult> {
  throw new Error(
    "Mistral OCR backend not yet implemented (D-08 stub). " +
      "The config knob and backend selector are wired; the API client is a " +
      "deferred follow-up commit. See 101-CONTEXT.md D-08 for rationale.",
  );
}
