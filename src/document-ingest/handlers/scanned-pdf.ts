/**
 * Phase 101 T04 — scanned-PDF handler.
 *
 * Renders each PDF page to PNG via `pdftoppm` (poppler-utils, present on
 * clawdy per the researcher's deploy probe), then resizes via sharp to
 * ≤ DIMENSION_MAX_PX. Returns BatchedPage[] with `imageBuffer` populated;
 * OCR itself is performed by the engine entrypoint after batching, not here.
 *
 * Page cap (T-101-03): renders are streamed via the OS filesystem; documents
 * over MAX_PAGES (500) reject before any rendering work to bound DoS surface.
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import sharp from "sharp";
import type { BatchedPage } from "../types.js";
import { DIMENSION_MAX_PX, MAX_PAGES, IngestError } from "../page-batch.js";

/** DPI for pdftoppm raster — 150 is the sharp/quality sweet spot for OCR. */
const RENDER_DPI = 150;

/** Spawn a child process and resolve when it exits successfully. */
function runProcess(cmd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
    });
  });
}

export async function handleScannedPdf(
  buffer: Buffer,
): Promise<readonly BatchedPage[]> {
  const tmp = await mkdtemp(join(tmpdir(), "phase101-scanned-"));
  const pdfPath = join(tmp, "input.pdf");
  const outPrefix = join(tmp, "page");

  try {
    await writeFile(pdfPath, buffer);

    // pdftoppm writes page-1.png, page-2.png, etc. argv array (no shell):
    // -r 150 sets DPI; -png picks the output format.
    await runProcess("pdftoppm", [
      "-r",
      String(RENDER_DPI),
      "-png",
      pdfPath,
      outPrefix,
    ]);

    const entries = await readdir(tmp);
    const pngs = entries
      .filter((f) => f.startsWith("page") && f.endsWith(".png"))
      .sort((a, b) => {
        // page-1.png ... page-12.png — natural numeric sort.
        const na = parseInt(a.match(/(\d+)/)?.[1] ?? "0", 10);
        const nb = parseInt(b.match(/(\d+)/)?.[1] ?? "0", 10);
        return na - nb;
      });

    if (pngs.length > MAX_PAGES) {
      throw new IngestError(`document exceeds MAX_PAGES=${MAX_PAGES}`);
    }

    const pages: BatchedPage[] = [];
    for (let i = 0; i < pngs.length; i++) {
      const raw = await readFile(join(tmp, pngs[i]));
      const meta = await sharp(raw).metadata();
      const resized = await sharp(raw)
        .resize({
          width: DIMENSION_MAX_PX,
          height: DIMENSION_MAX_PX,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();
      const resizedMeta = await sharp(resized).metadata();
      pages.push({
        pageNumber: i + 1,
        imageBuffer: resized,
        widthPx: resizedMeta.width ?? meta.width,
        heightPx: resizedMeta.height ?? meta.height,
      });
    }

    return pages;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
