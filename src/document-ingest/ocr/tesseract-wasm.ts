/**
 * Phase 101 T03 — Tesseract WASM OCR backend (Tier 2 fallback per D-01).
 *
 * Used when the CLI backend is unavailable on the host (e.g. dev boxes
 * without `apt install tesseract-ocr`). Runs in-process via tesseract.js;
 * ~2x slower than the CLI but zero deploy prereq.
 *
 * Worker is created lazily on first call and cached for the process
 * lifetime — `tesseract.js` workers are expensive to spin up (~1s warm-up).
 */

import type { OcrBackend } from "../types.js";
import type { OcrResult } from "./tesseract-cli.js";

let workerPromise: Promise<unknown> | null = null;

async function getWorker(): Promise<unknown> {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const mod = (await import("tesseract.js")) as unknown as {
      createWorker: (lang: string) => Promise<unknown>;
    };
    return await mod.createWorker("eng");
  })();
  return workerPromise;
}

/**
 * Run tesseract.js WASM on a single page image. Same shape as the CLI
 * backend so the orchestrator (`./index.ts`) can swap them interchangeably.
 */
export async function ocrPageTesseractWasm(
  imageBuffer: Buffer,
): Promise<OcrResult> {
  const worker = (await getWorker()) as {
    recognize: (img: Buffer) => Promise<{
      data: { text: string; confidence?: number };
    }>;
  };
  const { data } = await worker.recognize(imageBuffer);
  const text = (data.text ?? "").trim();
  // tesseract.js surfaces a per-page 0-100 confidence. Normalize to [0,1].
  const raw =
    typeof data.confidence === "number" ? data.confidence / 100 : 0.5;
  const confidence = text.length === 0 ? 0 : raw;
  return {
    text,
    confidence,
    backend: "tesseract-wasm" satisfies OcrBackend,
  };
}

/** Test-only worker reset (forces re-init on next call). */
export function _resetWasmWorkerForTests(): void {
  workerPromise = null;
}
