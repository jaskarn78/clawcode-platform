/**
 * Phase 101 T03 — Tesseract CLI OCR backend (Tier 1 per D-01).
 *
 * Wraps `node-tesseract-ocr` which shells out to the installed `tesseract`
 * binary on $PATH. On clawdy this binary is the deploy prereq enforced by
 * `scripts/deploy-clawdy.sh` (T06). On dev boxes lacking the binary, the
 * orchestrator (`./index.ts`) falls back to the WASM backend.
 *
 * WP3 (2026-10-25) — confidence is real: the page is recognized with the
 * `tsv` output config, the text is rebuilt from the word rows and the
 * confidence is the mean word confidence divided by 100. Only when the tsv
 * output is unavailable (older binary, unparseable output) does the backend
 * fall back to plain text output with the fixed 0.75 confidence that the
 * previous implementation always reported.
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

/**
 * Confidence reported for non-empty text when the tsv output is
 * unavailable. Above the 0.70 chain threshold, matching the pre-WP3
 * behaviour for hosts whose tesseract cannot emit tsv.
 */
export const FALLBACK_CONFIDENCE = 0.75;

export type OcrResult = {
  readonly text: string;
  readonly confidence: number;
  readonly backend: OcrBackend;
};

/** Minimal shape of `node-tesseract-ocr`'s recognize(). */
export type TesseractRecognize = (
  imagePath: string,
  config: Record<string, unknown>,
) => Promise<string>;

export type TesseractCliOptions = {
  /** Test seam: replaces the `node-tesseract-ocr` import. */
  readonly recognize?: TesseractRecognize;
};

const BASE_CONFIG = Object.freeze({
  lang: "eng",
  // psm 6: assume a single uniform block of text — best for cropped pages.
  // oem 1: LSTM neural-net engine (the modern default).
  psm: 6,
  oem: 1,
});

/** Parsed `tsv` output: rebuilt text plus the mean word confidence (0 to 1). */
export type TesseractTsv = {
  readonly text: string;
  /** null when no word row carried a confidence. */
  readonly meanConfidence: number | null;
  readonly words: number;
};

/**
 * Parse tesseract's `tsv` renderer output. Returns null when the output is
 * not tsv (no header row), so the caller can fall back to plain text.
 *
 * Columns: level page_num block_num par_num line_num word_num left top
 * width height conf text. Word rows have level 5; their `conf` is 0 to 100.
 * Text is rebuilt line by line (words joined by a space, lines by a newline,
 * a blank line between paragraphs and blocks).
 */
export function parseTesseractTsv(output: string): TesseractTsv | null {
  const lines = output.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^level\tpage_num\t/.test(l));
  if (headerIdx === -1) return null;
  const header = lines[headerIdx].split("\t");
  const col = (name: string): number => header.indexOf(name);
  const iLevel = col("level");
  const iBlock = col("block_num");
  const iPar = col("par_num");
  const iLine = col("line_num");
  const iConf = col("conf");
  const iText = col("text");
  if ([iLevel, iBlock, iPar, iLine, iConf, iText].some((i) => i === -1)) return null;

  const pieces: string[] = [];
  let prevKey: string | null = null;
  let prevPara: string | null = null;
  let confSum = 0;
  let confCount = 0;
  let words = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.length === 0) continue;
    const cells = raw.split("\t");
    if (cells.length <= iText) continue;
    if (cells[iLevel] !== "5") continue;
    const text = cells[iText].trim();
    if (text.length === 0) continue;
    const lineKey = `${cells[iBlock]}:${cells[iPar]}:${cells[iLine]}`;
    const paraKey = `${cells[iBlock]}:${cells[iPar]}`;
    if (prevKey !== null) {
      if (paraKey !== prevPara) pieces.push("\n\n");
      else if (lineKey !== prevKey) pieces.push("\n");
      else pieces.push(" ");
    }
    pieces.push(text);
    prevKey = lineKey;
    prevPara = paraKey;
    words++;
    const conf = Number.parseFloat(cells[iConf]);
    if (Number.isFinite(conf) && conf >= 0) {
      confSum += conf;
      confCount++;
    }
  }
  return {
    text: pieces.join("").trim(),
    meanConfidence: confCount > 0 ? Math.min(1, Math.max(0, confSum / confCount / 100)) : null,
    words,
  };
}

async function loadRecognize(): Promise<TesseractRecognize> {
  const tesseract = await import("node-tesseract-ocr");
  const recognize =
    (tesseract as { recognize?: typeof tesseract.recognize }).recognize ??
    (tesseract as { default?: { recognize?: typeof tesseract.recognize } })
      .default?.recognize;
  if (typeof recognize !== "function") {
    throw new Error("node-tesseract-ocr: recognize() not exported");
  }
  return recognize as unknown as TesseractRecognize;
}

/**
 * Run Tesseract CLI on a single page image. Returns {text, confidence,
 * backend}. Confidence is the mean word confidence from the tsv output
 * (0 to 1); empty text always scores 0; FALLBACK_CONFIDENCE only when tsv
 * output is unavailable.
 */
export async function ocrPageTesseract(
  imageBuffer: Buffer,
  opts: TesseractCliOptions = {},
): Promise<OcrResult> {
  const recognize = opts.recognize ?? (await loadRecognize());

  // Tempfile because node-tesseract-ocr's API takes a path, not a buffer.
  const tmp = await mkdtemp(join(tmpdir(), "phase101-tess-"));
  const imgPath = join(tmp, `${nanoid()}.png`);
  await writeFile(imgPath, imageBuffer);
  try {
    const tsvOut = await recognize(imgPath, { ...BASE_CONFIG, presets: ["tsv"] });
    const parsed = parseTesseractTsv(tsvOut ?? "");
    if (parsed !== null) {
      const confidence =
        parsed.text.length === 0 ? 0 : (parsed.meanConfidence ?? FALLBACK_CONFIDENCE);
      return { text: parsed.text, confidence, backend: "tesseract-cli" };
    }
    // tsv unavailable: plain text with the fixed fallback confidence.
    const text = await recognize(imgPath, { ...BASE_CONFIG });
    const trimmed = (text ?? "").trim();
    const confidence = trimmed.length === 0 ? 0 : FALLBACK_CONFIDENCE;
    return { text: trimmed, confidence, backend: "tesseract-cli" };
  } finally {
    await unlink(imgPath).catch(() => undefined);
  }
}
