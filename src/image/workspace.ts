/**
 * Phase 72 — atomic workspace writer for generated images.
 *
 * Writes raw image bytes to
 *   `<agentWorkspace>/<subdir>/<timestamp>-<id>.<ext>`
 * with the standard `tmp + rename` atomic pattern. Parent directory is
 * created on demand (`mkdir -p`).
 *
 * Atomicity guarantees:
 *  - Writes happen to `<finalPath>.tmp` first, then `rename(2)` swaps
 *    the file into place. Readers never observe a partial file at
 *    `finalPath` (POSIX rename is atomic on the same filesystem).
 *  - If the `writeFile` step fails, we attempt to unlink the `.tmp`
 *    file (silently ignoring ENOENT) so we don't leak half-written
 *    artifacts. The original error is rethrown.
 *  - If the `rename` step fails, the `.tmp` file may still exist; we
 *    attempt to unlink it for the same reason.
 *
 * Concurrency: filename uses `Date.now() + nanoid(10)`; even
 * sub-millisecond bursts get distinct paths.
 */

import { Buffer } from "node:buffer";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";

/**
 * Atomically write `bytes` into the agent workspace and return the
 * absolute final path. Creates the target subdirectory if missing.
 *
 * @param agentWorkspace Absolute path to the agent's workspace root.
 * @param subdir         Subdirectory to write into (created if absent).
 * @param bytes          Raw image bytes (Buffer).
 * @param ext            File extension WITHOUT the leading dot (e.g. "png").
 * @returns Absolute path to the persisted file.
 */
export async function writeImageToWorkspace(
  agentWorkspace: string,
  subdir: string,
  bytes: Buffer,
  ext: string,
): Promise<string> {
  const dir = join(agentWorkspace, subdir);
  await mkdir(dir, { recursive: true });

  const filename = `${Date.now()}-${nanoid(10)}.${ext}`;
  const finalPath = join(dir, filename);
  const tmpPath = `${finalPath}.tmp`;

  try {
    await writeFile(tmpPath, bytes);
  } catch (err) {
    // No file should be at finalPath at this point — but the .tmp may
    // be partially written. Best-effort cleanup, then surface the
    // original error so callers can map it through toImageToolError.
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  try {
    await rename(tmpPath, finalPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  return finalPath;
}
