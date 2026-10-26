/**
 * WP3 (2026-10-25): tesseract-cli confidence comes from the tsv word
 * confidences; the fixed 0.75 is only a fallback when tsv is unavailable.
 */
import { describe, it, expect } from "vitest";
import {
  FALLBACK_CONFIDENCE,
  ocrPageTesseract,
  parseTesseractTsv,
  type TesseractRecognize,
} from "../ocr/tesseract-cli.js";

const HEADER = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";

function tsv(rows: Array<[number, number, number, number, number, string]>): string {
  // [block, par, line, word, conf, text]
  const lines = [HEADER, "1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t"];
  for (const [b, p, l, w, conf, text] of rows) {
    lines.push(`5\t1\t${b}\t${p}\t${l}\t${w}\t0\t0\t10\t10\t${conf}\t${text}`);
  }
  return lines.join("\n") + "\n";
}

describe("parseTesseractTsv", () => {
  it("rebuilds lines and paragraphs and averages word confidence", () => {
    const out = parseTesseractTsv(
      tsv([
        [1, 1, 1, 1, 96, "Total"],
        [1, 1, 1, 2, 90, "due"],
        [1, 1, 2, 1, 84, "$4,820.00"],
        [2, 1, 1, 1, 70, "Thanks"],
      ]),
    );
    expect(out).toEqual({
      text: "Total due\n$4,820.00\n\nThanks",
      meanConfidence: 0.85,
      words: 4,
    });
  });

  it("returns null for plain-text output", () => {
    expect(parseTesseractTsv("Total due 4820\n")).toBeNull();
  });

  it("ignores non-word rows and negative confidences", () => {
    const out = parseTesseractTsv(tsv([[1, 1, 1, 1, -1, "x"]]));
    expect(out).toEqual({ text: "x", meanConfidence: null, words: 1 });
  });
});

describe("ocrPageTesseract", () => {
  it("reports the tsv mean confidence (low for garbage, so the chain falls through)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const recognize: TesseractRecognize = async (_p, cfg) => {
      calls.push(cfg);
      return tsv([
        [1, 1, 1, 1, 31, "l|1"],
        [1, 1, 1, 2, 22, "~~"],
      ]);
    };
    const r = await ocrPageTesseract(Buffer.from("png"), { recognize });
    expect(r.backend).toBe("tesseract-cli");
    expect(r.text).toBe("l|1 ~~");
    expect(r.confidence).toBeCloseTo(0.265, 5);
    expect(calls).toHaveLength(1);
    expect(calls[0].presets).toEqual(["tsv"]);
  });

  it("falls back to plain text at 0.75 only when tsv output is unavailable", async () => {
    const recognize: TesseractRecognize = async (_p, cfg) =>
      cfg.presets ? "not tsv at all" : "Plain OCR text\n";
    const r = await ocrPageTesseract(Buffer.from("png"), { recognize });
    expect(r).toEqual({ text: "Plain OCR text", confidence: FALLBACK_CONFIDENCE, backend: "tesseract-cli" });
  });

  it("falls back to plain text when the tsv call throws", async () => {
    const recognize: TesseractRecognize = async (_p, cfg) => {
      if (cfg.presets) throw new Error("read_params_file: Can't open tsv");
      return "ok text";
    };
    const r = await ocrPageTesseract(Buffer.from("png"), { recognize });
    expect(r.confidence).toBe(FALLBACK_CONFIDENCE);
    expect(r.text).toBe("ok text");
  });

  it("scores empty text 0 and rethrows when the binary is missing", async () => {
    const empty: TesseractRecognize = async () => tsv([]);
    expect((await ocrPageTesseract(Buffer.from("png"), { recognize: empty })).confidence).toBe(0);
    const missing: TesseractRecognize = async () => {
      throw new Error("tesseract: command not found");
    };
    await expect(ocrPageTesseract(Buffer.from("png"), { recognize: missing })).rejects.toThrow(
      /not found/,
    );
  });
});
