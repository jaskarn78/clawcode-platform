/**
 * Types and constants for Discord attachment handling.
 */

/**
 * Structured metadata for a single Discord attachment.
 * Immutable after construction.
 */
export type AttachmentInfo = {
  readonly name: string;
  readonly url: string;
  readonly contentType: string | null;
  readonly size: number;
  readonly proxyUrl: string;
};

/**
 * Result of attempting to download an attachment.
 * Immutable after construction.
 */
export type DownloadResult = {
  readonly success: boolean;
  readonly path: string | null;
  readonly error: string | null;
  readonly attachmentInfo: AttachmentInfo;
};

/** Maximum attachment size in bytes (25MB). Files larger than this are rejected. */
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

/** Download timeout in milliseconds (30 seconds). */
export const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Default cleanup max age in milliseconds (24 hours). */
export const DEFAULT_CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
