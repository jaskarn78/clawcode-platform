/**
 * Slack inbound-file download orchestration.
 *
 * Slack `url_private` links are auth-gated (bot token + `files:read`), so the
 * agent can't fetch a shared screenshot itself. The daemon downloads the bytes
 * here into a temp dir and stamps `localPath` onto each attachment — the agent
 * (running `bypassPermissions`, so its Read tool can open any path) then reads
 * the file directly. Mirrors the Discord bridge's attachment-download step,
 * with age-based cleanup so downloads don't grow unbounded.
 */
import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import type { Logger } from "pino";
import type { InboundAttachment, InboundMessage } from "../types.js";
import type { SlackWebClient } from "./web-api.js";

/** Per-file size ceiling (mirrors Discord's MAX_ATTACHMENT_SIZE). */
const MAX_SLACK_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Delete downloaded files older than this (mirrors Discord's 24h cleanup). */
const CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Don't sweep the dir more than once per this interval. */
const CLEANUP_THROTTLE_MS = 60 * 60 * 1000;

let lastCleanupAt = 0;

/** The shared temp dir Slack attachments are downloaded into. */
function attachmentsDir(): string {
  return join(tmpdir(), "clawcode-slack-attachments");
}

/**
 * Download every attachment on a message to the temp dir, returning a copy of
 * the message with `localPath` set on each file that downloaded successfully.
 * Best-effort and fail-open: a file that fails to download keeps its
 * metadata-only attachment (no `localPath`) so the agent still learns it
 * exists. Never throws.
 */
export async function downloadSlackAttachments(
  web: SlackWebClient,
  message: InboundMessage,
  log: Logger,
): Promise<InboundMessage> {
  const atts = message.attachments;
  if (!atts || atts.length === 0) return message;

  const dir = attachmentsDir();
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    log.warn({ err }, "slack attachment dir create failed; surfacing metadata only");
    return message;
  }

  void cleanupOldAttachments(dir, log); // throttled, fire-and-forget

  const enriched = await Promise.all(
    atts.map((a, idx) => downloadOne(web, message.messageId, idx, a, dir, log)),
  );
  return { ...message, attachments: enriched };
}

async function downloadOne(
  web: SlackWebClient,
  messageId: string,
  idx: number,
  attachment: InboundAttachment,
  dir: string,
  log: Logger,
): Promise<InboundAttachment> {
  if (!attachment.url) return attachment;
  try {
    const bytes = await web.downloadFile(attachment.url, MAX_SLACK_ATTACHMENT_BYTES);
    const dest = join(dir, safeFileName(messageId, idx, attachment.name));
    await writeFile(dest, bytes);
    return { ...attachment, localPath: dest };
  } catch (err) {
    log.warn(
      { err, name: attachment.name },
      "slack attachment download failed (surfacing metadata only)",
    );
    return attachment;
  }
}

/**
 * Build a collision-resistant, traversal-safe local filename:
 * `<sanitized-messageId>-<idx>-<sanitized-name>`. The message ts is unique per
 * channel and the index disambiguates multiple files on one message.
 */
function safeFileName(messageId: string, idx: number, name: string): string {
  const base = basename(name || "file").slice(-100);
  const safeName = base.replace(/[^A-Za-z0-9._-]/g, "_") || "file";
  const safeId = messageId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safeId}-${idx}-${safeName}`;
}

/**
 * Delete attachments older than CLEANUP_MAX_AGE_MS. Throttled to at most once
 * per CLEANUP_THROTTLE_MS (module-level), best-effort, never throws.
 */
export async function cleanupOldAttachments(dir: string, log: Logger): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_THROTTLE_MS) return;
  lastCleanupAt = now;
  try {
    const entries = await readdir(dir);
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry);
        try {
          const info = await stat(path);
          if (info.isFile() && now - info.mtimeMs > CLEANUP_MAX_AGE_MS) {
            await unlink(path);
          }
        } catch {
          /* ignore per-entry errors */
        }
      }),
    );
  } catch (err) {
    log.debug({ err, dir }, "slack attachment cleanup sweep failed (non-fatal)");
  }
}

/** Test-only: reset the throttle so cleanup runs on the next call. */
export function __resetCleanupThrottleForTest(): void {
  lastCleanupAt = 0;
}
