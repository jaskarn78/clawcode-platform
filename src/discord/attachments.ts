/**
 * Discord attachment handling: download, format metadata, and cleanup.
 * Pure functions with no bridge coupling -- used by Plan 02 integration.
 */

import { mkdir, writeFile, rename, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Collection } from "discord.js";
import type { Attachment } from "discord.js";
import type { AttachmentInfo, DownloadResult } from "./attachment-types.js";
import {
  MAX_ATTACHMENT_SIZE,
  DOWNLOAD_TIMEOUT_MS,
  DEFAULT_CLEANUP_MAX_AGE_MS,
} from "./attachment-types.js";

/**
 * Sanitize a filename by replacing non-alphanumeric characters (except dots and dashes)
 * with underscores.
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-]/g, "_");
}

/**
 * The per-agent inbox directory where downloaded attachments land (Phase 75
 * SHARED-01: memoryPath, not workspace, so attachments stay in the receiving
 * agent's private inbox on shared-workspace setups).
 *
 * SINGLE SOURCE OF TRUTH — the bridge writes here and the auto-ingest rescan
 * reads here. Both MUST go through this helper so the reconstructed `source`
 * (an absolute file path) matches byte-for-byte what was ingested; a path
 * mismatch would defeat `docStore.getDocumentRow(source)` dedup and cause
 * duplicate ingestion under a second source key.
 */
export function attachmentInboxDir(memoryPath: string | undefined): string {
  return join(memoryPath ?? "/tmp", "inbox", "attachments");
}

/**
 * Extract AttachmentInfo from a discord.js Message attachments collection.
 *
 * @param messageAttachments - discord.js Collection<string, Attachment>
 * @returns Immutable array of AttachmentInfo
 */
export function extractAttachments(
  messageAttachments: Collection<string, Attachment>,
): readonly AttachmentInfo[] {
  return messageAttachments.map((att) => ({
    name: att.name ?? "unknown",
    url: att.url,
    contentType: att.contentType,
    size: att.size,
    proxyUrl: att.proxyURL,
  }));
}

/**
 * Check if a content type represents an image.
 *
 * @param contentType - MIME content type or null
 * @returns true if content type starts with "image/"
 */
export function isImageAttachment(contentType: string | null): boolean {
  if (contentType === null) return false;
  return contentType.startsWith("image/");
}

/**
 * Download a single attachment from Discord CDN to a local file.
 * Uses atomic write pattern (write to .tmp, then rename).
 * Rejects files over MAX_ATTACHMENT_SIZE without downloading.
 * Applies AbortController timeout.
 *
 * @param info - Attachment metadata
 * @param targetDir - Directory to save downloaded files
 * @param timeoutMs - Download timeout in ms (default DOWNLOAD_TIMEOUT_MS)
 * @returns DownloadResult with success/failure details
 */
export async function downloadAttachment(
  info: AttachmentInfo,
  targetDir: string,
  timeoutMs: number = DOWNLOAD_TIMEOUT_MS,
): Promise<DownloadResult> {
  // Size check before downloading
  if (info.size > MAX_ATTACHMENT_SIZE) {
    return {
      success: false,
      path: null,
      error: `File "${info.name}" (${info.size} bytes) exceeds maximum size of ${MAX_ATTACHMENT_SIZE} bytes`,
      attachmentInfo: info,
    };
  }

  try {
    await mkdir(targetDir, { recursive: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(info.url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return {
        success: false,
        path: null,
        error: `HTTP ${response.status} fetching "${info.name}"`,
        attachmentInfo: info,
      };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const sanitized = sanitizeFilename(info.name);
    const filename = `${Date.now()}-${sanitized}`;
    const filePath = join(targetDir, filename);
    const tmpPath = `${filePath}.tmp`;

    // Atomic write: write to .tmp then rename
    await writeFile(tmpPath, buffer);
    await rename(tmpPath, filePath);

    return {
      success: true,
      path: filePath,
      error: null,
      attachmentInfo: info,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      path: null,
      error: `Download failed for "${info.name}": ${message}`,
      attachmentInfo: info,
    };
  }
}

/**
 * Download all attachments in parallel.
 * Logs warnings for failures and oversized files.
 *
 * @param attachments - Array of attachment metadata
 * @param targetDir - Directory to save downloaded files
 * @param log - Optional pino logger
 * @returns Array of DownloadResults
 */
export async function downloadAllAttachments(
  attachments: readonly AttachmentInfo[],
  targetDir: string,
  log?: Logger,
): Promise<readonly DownloadResult[]> {
  const results = await Promise.all(
    attachments.map((info) => downloadAttachment(info, targetDir)),
  );

  if (log) {
    for (const result of results) {
      if (!result.success) {
        log.warn(
          { name: result.attachmentInfo.name, error: result.error },
          "Attachment download failed",
        );
      }
    }
  }

  return results;
}

/**
 * Format download results as structured XML-like metadata for bridge consumption.
 * Returns empty string for empty array.
 *
 * @param results - Array of download results
 * @returns Formatted metadata string
 */
export function formatAttachmentMetadata(results: readonly DownloadResult[]): string {
  if (results.length === 0) return "";

  const lines = results.map((r) => {
    const attrs = [
      `name="${r.attachmentInfo.name}"`,
      `type="${r.attachmentInfo.contentType ?? "unknown"}"`,
      `size="${r.attachmentInfo.size}"`,
    ];

    if (r.success && r.path !== null) {
      attrs.push(`local_path="${r.path}"`);
    } else if (r.error !== null) {
      attrs.push(`error="${r.error}"`);
    }

    return `  <attachment ${attrs.join(" ")} />`;
  });

  return `<attachments>\n${lines.join("\n")}\n</attachments>`;
}

/**
 * Remove downloaded attachment files older than maxAgeMs from a directory.
 *
 * @param dir - Directory to clean up
 * @param maxAgeMs - Maximum file age in milliseconds (default 24 hours)
 * @returns Number of files removed
 */
export async function cleanupAttachments(
  dir: string,
  maxAgeMs: number = DEFAULT_CLEANUP_MAX_AGE_MS,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }

  const now = Date.now();
  let removed = 0;

  for (const entry of entries) {
    const filePath = join(dir, entry);
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;

      const ageMs = now - fileStat.mtimeMs;
      if (ageMs > maxAgeMs) {
        await unlink(filePath);
        removed++;
      }
    } catch {
      // Skip files that can't be stat'd or removed
    }
  }

  return removed;
}
