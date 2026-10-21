/**
 * Phase 999.154 WS-4 — durable image archive.
 *
 * The inbox keeps originals 24 h. That is why the 2026-05-19..09-22 vision
 * contamination could not be re-analyzed: the sources were gone. Every
 * ingested image now also lands as a resized WebP under
 * `<memoryPath>/attachments-archive/`, kept `ttlDays`, and the document row's
 * `source_image_path` points at it so retrieval hands the agent a file that
 * still exists.
 */

import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import { MAX_INPUT_PIXELS } from "../manager/image-work-governor.js";

export function attachmentArchiveDir(memoryPath: string | undefined): string {
  return join(memoryPath ?? "/tmp", "attachments-archive");
}

/** Archive file name for an inbox path: `<inbox-basename-without-ext>.webp`. */
export function archiveFileName(sourcePath: string): string {
  const base = basename(sourcePath);
  return `${base.slice(0, base.length - extname(base).length)}.webp`;
}

/**
 * Write the archived copy; returns its path, or null when the image cannot be
 * decoded/written (non-fatal — ingest continues with the inbox path). Caller
 * holds the image-work governor permit.
 */
export async function archiveImage(
  buf: Buffer,
  sourcePath: string,
  dir: string,
  sidePx: number,
): Promise<string | null> {
  try {
    const out = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS })
      .timeout({ seconds: 15 })
      .rotate()
      .resize(sidePx, sidePx, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const dest = join(dir, archiveFileName(sourcePath));
    await writeFile(dest, out, { mode: 0o600 });
    return dest;
  } catch {
    return null;
  }
}

/** Delete archived files older than `ttlDays`. Returns the number removed. */
export async function sweepImageArchive(
  dir: string,
  ttlDays: number,
  now: number = Date.now(),
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = now - ttlDays * 86_400_000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".webp")) continue;
    const full = join(dir, entry);
    try {
      const st = await stat(full);
      if (st.isFile() && st.mtimeMs < cutoff) {
        await unlink(full);
        removed++;
      }
    } catch {
      // raced with another sweep / manual delete — ignore
    }
  }
  return removed;
}
