/**
 * WP3 (2026-10-25): shared pdftoppm page rendering.
 *
 * `renderPdfPagesToPng` rasterizes selected pages of a PDF buffer to PNG via
 * `pdftoppm -f A -l B` (poppler-utils, the documented deploy prereq). The
 * PDF is written to a temp file once and each contiguous run of requested
 * pages is rendered with one pdftoppm call. The scanned-PDF handler renders
 * whole documents with the same process runner and DPI; the text-PDF
 * handler uses this for pages that have no text layer.
 *
 * Best effort by design: when the binary is missing or a render fails the
 * affected pages are simply absent from the returned map and the caller
 * leaves them text-less.
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

/**
 * Renderer contract the text-PDF handler accepts (injectable for tests):
 * PNG buffers keyed by 1-based page number. Pages that could not be
 * rendered are missing from the map.
 */
export type PdfPagesRenderer = (
  pdf: Buffer,
  pageNumbers: readonly number[],
) => Promise<ReadonlyMap<number, Buffer>>;

/** Group sorted, de-duplicated page numbers into contiguous [first, last] runs. */
export function contiguousRuns(pageNumbers: readonly number[]): Array<[number, number]> {
  const sorted = [...new Set(pageNumbers)]
    .filter((n) => Number.isInteger(n) && n >= 1)
    .sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs;
}

/** Page number from a pdftoppm output name such as `page-07.png`. */
function pageFromOutputName(name: string): number | null {
  const m = /-(\d+)\.png$/.exec(name);
  return m ? Number.parseInt(m[1], 10) : null;
}

export const renderPdfPagesToPng: PdfPagesRenderer = async (pdf, pageNumbers) => {
  const out = new Map<number, Buffer>();
  const runs = contiguousRuns(pageNumbers);
  if (runs.length === 0) return out;
  let tmp: string | null = null;
  try {
    tmp = await mkdtemp(join(tmpdir(), "phase101-page-"));
    const pdfPath = join(tmp, "input.pdf");
    await writeFile(pdfPath, pdf);
    for (const [first, last] of runs) {
      const outPrefix = join(tmp, `run${first}`);
      try {
        await runProcess("pdftoppm", [
          "-r",
          String(RENDER_DPI),
          "-png",
          "-f",
          String(first),
          "-l",
          String(last),
          pdfPath,
          outPrefix,
        ]);
      } catch {
        // Missing binary or a bad page range: leave these pages unrendered.
        continue;
      }
    }
    for (const name of await readdir(tmp)) {
      if (!name.startsWith("run") || !name.endsWith(".png")) continue;
      const page = pageFromOutputName(name);
      if (page === null) continue;
      out.set(page, await readFile(join(tmp, name)));
    }
    return out;
  } catch {
    return out;
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
};
