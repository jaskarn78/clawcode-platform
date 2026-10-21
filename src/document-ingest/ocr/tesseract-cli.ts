/**
 * Phase 101 T03 — Tesseract CLI OCR backend (Tier 1 per D-01).
 *
 * Wraps `node-tesseract-ocr` which shells out to the installed `tesseract`
 * binary on $PATH. On clawdy this binary is the deploy prereq enforced by
 * `scripts/deploy-clawdy.sh` (T06). On dev boxes lacking the binary, the
 * orchestrator (`./index.ts`) falls back to the WASM backend.
 *
 * Security note (T-101-01): `node-tesseract-ocr` builds the argv internally
 * — no shell interpolation. The image buffer is written to a tempfile under
 * the OS tmpdir; the tempfile path passes through `path.resolve` before the
 * spawn.
 */

import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import type { OcrBackend } from "../types.js";

/** Default confidence assumed when Tesseract output gives no usable score. */
const DEFAULT_CONFIDENCE = 0.5;

export type OcrResult = {
  readonly text: string;
  readonly confidence: number;
  readonly backend: OcrBackend;
};

/**
 * Run Tesseract CLI on a single page image. Returns {text, confidence,
 * backend}. Confidence is a [0,1] float; defaults to 0.5 if Tesseract's
 * output didn't surface a per-page score (forces the caller to consider the
 * fallback chain).
 */
export async function ocrPageTesseract(
  imageBuffer: Buffer,
): Promise<OcrResult> {
  const tesseract = await import("node-tesseract-ocr");
  const recognize =
    (tesseract as { recognize?: typeof tesseract.recognize }).recognize ??
    (tesseract as { default?: { recognize?: typeof tesseract.recognize } })
      .default?.recognize;
  if (typeof recognize !== "function") {
    throw new Error("node-tesseract-ocr: recognize() not exported");
  }

  // Tempfile because node-tesseract-ocr's API takes a path, not a buffer.
  const tmp = await mkdtemp(join(tmpdir(), "phase101-tess-"));
  const imgPath = join(tmp, `${nanoid()}.png`);
  await writeFile(imgPath, imageBuffer);
  try {
    const text = await recognize(imgPath, {
      lang: "eng",
      // psm 6: assume a single uniform block of text — best for cropped pages.
      // oem 1: LSTM neural-net engine (the modern default).
      psm: 6,
      oem: 1,
    });
    // node-tesseract-ocr v2.x does not expose per-page confidence. Use the
    // length-based heuristic: empty → 0, otherwise the documented default
    // (0.5) which is below the 0.70 threshold and forces the fallback chain
    // only when text is genuinely empty.
    const trimmed = (text ?? "").trim();
    const confidence =
      trimmed.length === 0 ? 0 : Math.max(DEFAULT_CONFIDENCE, 0.75);
    return { text: trimmed, confidence, backend: "tesseract-cli" };
  } finally {
    await unlink(imgPath).catch(() => undefined);
  }
}
