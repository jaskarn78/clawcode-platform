/**
 * WP3 (2026-10-25): binary guard on the plain-text handler; mixed text and
 * scanned PDFs render and OCR their text-less pages (best effort, tested
 * with a stub renderer); engine pageTexts stay aligned with pages.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { handleText, looksBinary } from "../handlers/text.js";
import { handleTextPdf } from "../handlers/text-pdf.js";
import { contiguousRuns, renderPdfPagesToPng, type PdfPagesRenderer } from "../pdf-render.js";
import { ingest } from "../index.js";

/** Minimal valid PDF; `null` pages have no content stream (no text layer). */
function buildPdf(pages: ReadonlyArray<string | null>): Buffer {
  const pageIds: number[] = [];
  // 1 catalog, 2 pages, 3 font, then per page: page obj (+ content obj).
  let next = 4;
  const pageObjs: Array<[number, string]> = [];
  for (const text of pages) {
    const pageId = next++;
    pageIds.push(pageId);
    if (text === null) {
      pageObjs.push([pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`]);
    } else {
      const contentId = next++;
      const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
      pageObjs.push([
        pageId,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      ]);
      pageObjs.push([contentId, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]);
    }
  }
  const fixed: Array<[number, string]> = [
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`],
    [3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  ];
  const all: Array<[number, string]> = [...fixed, ...pageObjs].sort((a, b) => a[0] - b[0]);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [id, body] of all) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${all.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= all.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${all.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A PNG with real contrast (stripes), i.e. not a blank page. */
async function stripedPng(): Promise<Buffer> {
  const w = 120;
  const h = 60;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.fill(Math.floor(x / 6) % 2 ? 0 : 255, (y * w + x) * 3, (y * w + x) * 3 + 3);
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

async function whitePng(): Promise<Buffer> {
  return sharp({ create: { width: 120, height: 60, channels: 3, background: "#ffffff" } }).png().toBuffer();
}

function hasPdftoppm(): boolean {
  try {
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("plain-text handler binary guard", () => {
  it("treats NUL bytes and invalid UTF-8 as binary", async () => {
    expect(looksBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBe(true);
    expect(looksBinary(Buffer.from(Array.from({ length: 200 }, (_, i) => 0x80 + (i % 60))))).toBe(true);
    expect(looksBinary(Buffer.from("plain notes, café, 漢字"))).toBe(false);
    expect(await handleText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]))).toEqual([
      { pageNumber: 1, text: "" },
    ]);
    expect(await handleText(Buffer.from("  hello  "))).toEqual([{ pageNumber: 1, text: "hello" }]);
  });
});

describe("handleTextPdf on a mixed PDF", () => {
  const pdf = buildPdf(["Total due 4820", null, "Page three text"]);

  it("renders only the text-less page and hands it to OCR as an image", async () => {
    const requested: number[][] = [];
    const renderPages: PdfPagesRenderer = async (_buf, nums) => {
      requested.push([...nums]);
      return new Map([[2, await stripedPng()]]);
    };
    const pages = await handleTextPdf(pdf, { renderPages });
    expect(requested).toEqual([[2]]);
    expect(pages).toHaveLength(3);
    expect(pages[0]).toMatchObject({ pageNumber: 1, text: "Total due 4820" });
    expect(pages[1].pageNumber).toBe(2);
    expect(pages[1].imageBuffer).toBeInstanceOf(Buffer);
    expect(pages[1].text).toBeUndefined();
    expect(pages[2]).toMatchObject({ pageNumber: 3, text: "Page three text" });
  });

  it("leaves a blank rendered page text-less (never sent to paid OCR)", async () => {
    const pages = await handleTextPdf(pdf, {
      renderPages: async () => new Map([[2, await whitePng()]]),
    });
    expect(pages[1]).toEqual({ pageNumber: 2, text: "" });
  });

  it("is best effort: no renderer, a throwing renderer or a bad image keep the page text-less", async () => {
    for (const renderPages of [
      null,
      async () => {
        throw new Error("pdftoppm missing");
      },
      async () => new Map([[2, Buffer.from("not a png")]]),
    ] as const) {
      const pages = await handleTextPdf(pdf, { renderPages: renderPages as PdfPagesRenderer | null });
      expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
      expect(pages[1].imageBuffer).toBeUndefined();
      expect(pages[1].text).toBe("");
    }
  });

  it("does not call the renderer when every page has text", async () => {
    let called = false;
    await handleTextPdf(buildPdf(["a", "b"]), {
      renderPages: async () => {
        called = true;
        return new Map();
      },
    });
    expect(called).toBe(false);
  });
});

describe("pdf-render", () => {
  it("groups page numbers into contiguous runs", () => {
    expect(contiguousRuns([5, 2, 3, 9, 3, 0, -1])).toEqual([
      [2, 3],
      [5, 5],
      [9, 9],
    ]);
    expect(contiguousRuns([])).toEqual([]);
  });

  it.skipIf(!hasPdftoppm())("renders requested pages with pdftoppm when installed", async () => {
    const out = await renderPdfPagesToPng(buildPdf(["one", null, "three"]), [2, 3]);
    expect([...out.keys()].sort()).toEqual([2, 3]);
    const meta = await sharp(out.get(2)!).metadata();
    expect(meta.format).toBe("png");
  });
});

describe("engine pageTexts alignment", () => {
  it("keeps one pageTexts entry per page so headers can name the right page", async () => {
    // Page 2 has no text layer; with or without pdftoppm it renders blank
    // or not at all, so it contributes an empty entry instead of shifting
    // page 3 into slot 2.
    const r = await ingest(buildPdf(["alpha text", null, "gamma text"]), "mixed.pdf");
    expect(r.telemetry.type).toBe("text-pdf");
    expect(r.pageTexts).toEqual(["alpha text", "", "gamma text"]);
    expect(r.text).toBe("alpha text\n\n\n\ngamma text");
  });

  it("backend none never OCRs image pages", async () => {
    const r = await ingest(await stripedPng(), "photo.png", { backend: "none" });
    expect(r.telemetry.type).toBe("image");
    expect(r.text).toBe("");
    expect(r.pageTexts).toEqual([""]);
  });
});
