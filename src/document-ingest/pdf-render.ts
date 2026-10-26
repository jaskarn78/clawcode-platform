/**
 * WP3 (2026-10-25) — shared pdftoppm page rendering.
 *
 * `renderPdfPageToPng` rasterizes ONE page of a PDF buffer to a PNG via
 * `pdftoppm -f N -l N` (poppler-utils, the documented deploy prereq). The
 * scanned-PDF handler renders whole documents the same way; the text-PDF
 * handler uses this per-page variant for pages that have no text layer.
 *
 * Best effort by design: when the binary is missing or the render fails the
 * promise resolves to null and the caller leaves the page text-less.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

/** DPI for pdftoppm raster. 150 is the sharp/quality sweet spot for OCR. */
export const RENDER_DPI = 150;

/** Spawn a child process and resolve when it exits successfully. */
export function runProcess(cmd: string, args: readonly string[]): Promise<void> {
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

/** Renderer contract the text-PDF handler accepts (injectable for tests). */
export type PdfPageRenderer = (
  pdf: Buffer,
  pageNumber: number,
) => Promise<Buffer | null>;

/**
 * Render page `pageNumber` (1-based) of `pdf` to a PNG buffer, or null when
 * rendering is unavailable or fails.
 */
export const renderPdfPageToPng: PdfPageRenderer = async (pdf, pageNumber) => {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return null;
  let tmp: string | null = null;
  try {
    tmp = await mkdtemp(join(tmpdir(), "phase101-page-"));
    const pdfPath = join(tmp, "input.pdf");
    const outPrefix = join(tmp, "page");
    await writeFile(pdfPath, pdf);
    await runProcess("pdftoppm", [
      "-r",
      String(RENDER_DPI),
      "-png",
      "-f",
      String(pageNumber),
      "-l",
      String(pageNumber),
      pdfPath,
      outPrefix,
    ]);
    const entries = await readdir(tmp);
    const png = entries.find((f) => f.startsWith("page") && f.endsWith(".png"));
    if (!png) return null;
    return await readFile(join(tmp, png));
  } catch {
    return null;
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
};
