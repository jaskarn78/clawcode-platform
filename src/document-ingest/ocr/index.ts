/**
 * Phase 101 T03 — OCR fallback orchestrator.
 *
 * Three-tier chain per D-01:
 *   1. Tesseract CLI       (fast, free)
 *   2. tesseract.js WASM   (slower, in-process — used when CLI unavailable)
 *   3. Claude vision       (paid; Haiku default, Sonnet on `high-precision`)
 *
 * Each tier returns when its confidence ≥ `tesseractConfidenceThreshold`
 * (default 0.70 per D-01). The chain short-circuits on the first success.
 * If every tier fails / returns below threshold, the Claude-vision result
 * is returned as-is — it's the most expensive backend and we trust its
 * output unconditionally.
 */

import type { OcrBackend, TaskHint } from "../types.js";
import { ocrPageTesseract, type OcrResult } from "./tesseract-cli.js";
import { ocrPageTesseractWasm } from "./tesseract-wasm.js";
import { ocrPageClaudeVision } from "./claude-vision.js";
import { ocrPageMistral } from "./mistral-stub.js";

/** D-01 default confidence floor for "good enough" Tesseract output. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Phase 101 Plan 02 T03 — runtime predicate consulted when an operator
 * explicitly selects `backend: 'mistral'`. The daemon edge resolves the
 * boolean from `defaults.documentIngest.allowMistralOcr` and threads it
 * through. Default `false` keeps the stub inert.
 */
export type AllowMistralOcrPredicate = () => boolean;
let allowMistralOcr: AllowMistralOcrPredicate = () => false;

/** Daemon edge sets this once at boot from `config.defaults.documentIngest`. */
export function setAllowMistralOcr(p: AllowMistralOcrPredicate): void {
  allowMistralOcr = p;
}

export type OcrPageOptions = {
  readonly taskHint?: TaskHint;
  readonly signal?: AbortSignal;
  readonly confidenceThreshold?: number;
  /**
   * Phase 101 Plan 02 T03 — explicit backend override. When unset, the
   * three-tier auto-chain runs as before. When set to `'mistral'`, gated by
   * `allowMistralOcr()` per D-08 (throws "disabled in config" when false,
   * otherwise invokes the stub which throws "not yet implemented").
   */
  readonly backend?: OcrBackend;
  /** Test seam — skip the CLI tier when running on hosts without tesseract. */
  readonly skipCli?: boolean;
  /** Test seam — skip the WASM tier when ONNX is unavailable. */
  readonly skipWasm?: boolean;
};

export type { OcrResult } from "./tesseract-cli.js";

/**
 * Three-tier OCR fallback. Returns the first tier whose confidence ≥
 * threshold, or the final Claude-vision result if all tiers underperform.
 */
export async function ocrPage(
  imageBuffer: Buffer,
  opts: OcrPageOptions = {},
): Promise<OcrResult> {
  const threshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  // Phase 101 Plan 02 T03 — explicit backend override. Bypasses the auto-chain.
  if (opts.backend === "mistral") {
    if (!allowMistralOcr()) {
      throw new Error(
        "Mistral OCR backend disabled in config " +
          "(defaults.documentIngest.allowMistralOcr=false). " +
          "Flip to true and re-run `clawcode reload` to enable. (D-08)",
      );
    }
    // The stub throws "not yet implemented" — explicit operator gate.
    return ocrPageMistral(imageBuffer, { signal: opts.signal });
  }
  if (opts.backend === "tesseract-cli") {
    return ocrPageTesseract(imageBuffer);
  }
  if (opts.backend === "tesseract-wasm") {
    return ocrPageTesseractWasm(imageBuffer);
  }
  if (opts.backend === "claude-haiku" || opts.backend === "claude-sonnet") {
    return ocrPageClaudeVision(imageBuffer, {
      taskHint: opts.backend === "claude-sonnet" ? "high-precision" : "standard",
      signal: opts.signal,
    });
  }

  // Tier 1 — Tesseract CLI.
  if (!opts.skipCli) {
    try {
      const cli = await ocrPageTesseract(imageBuffer);
      if (cli.confidence >= threshold) return cli;
    } catch {
      // CLI binary missing or crashed — slide to WASM.
    }
  }

  // Tier 2 — tesseract.js WASM.
  if (!opts.skipWasm) {
    try {
      const wasm = await ocrPageTesseractWasm(imageBuffer);
      if (wasm.confidence >= threshold) return wasm;
    } catch {
      // WASM init crashed (rare) — slide to Claude vision.
    }
  }

  // Tier 3 — Claude vision (Haiku/Sonnet per D-02).
  return ocrPageClaudeVision(imageBuffer, {
    taskHint: opts.taskHint,
    signal: opts.signal,
  });
}

/** Exported for test assertions. */
export const OCR_TIERS: ReadonlyArray<OcrBackend> = [
  "tesseract-cli",
  "tesseract-wasm",
  "claude-haiku",
  "claude-sonnet",
];
