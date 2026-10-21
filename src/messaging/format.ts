/**
 * Platform-neutral agent-visible message formatter.
 *
 * Mirrors `formatDiscordMessage` (src/discord/bridge.ts) but stamps the
 * originating platform into `source="<platform>"`. This is the single seam
 * where the agent learns where a message came from — the agent's prompt and
 * tools key off this wrapper exactly as they do for Discord today.
 */
import type { InboundAttachment, InboundMessage } from "./types.js";

/**
 * Render an agent-visible timestamp. Kept minimal (ISO, optional tz) — the
 * Discord path has a richer renderer, but agents only need a stable,
 * human-readable instant.
 */
function renderTimestamp(ts: Date, tz?: string): string {
  if (!tz) return ts.toISOString();
  try {
    return ts.toLocaleString("en-US", { timeZone: tz });
  } catch {
    return ts.toISOString();
  }
}

/**
 * Wrap an inbound message in the `<channel source="…">` envelope the agent
 * sees. Attribute order matches the Discord formatter so downstream parsing
 * is identical across platforms.
 */
export function formatAgentMessage(
  message: InboundMessage,
  agentTz?: string,
): string {
  const parts: string[] = [
    `<channel source="${message.platform}" chat_id="${escapeAttr(message.channelId)}" message_id="${escapeAttr(message.messageId)}" user="${escapeAttr(message.userName)}" ts="${renderTimestamp(message.ts, agentTz)}">`,
    message.text,
    `</channel>`,
  ];

  // Surface shared files. Mirrors the Discord bridge: a metadata listing plus,
  // for each downloaded file, a hint pointing the agent at the local path it
  // can Read. Files without a localPath couldn't be downloaded (e.g. missing
  // scope) — the agent at least learns they exist.
  const attachmentBlock = renderAttachments(message.attachments);
  if (attachmentBlock) parts.push(attachmentBlock);

  // When the message arrived inside a thread, tell the agent so it can keep
  // the conversation threaded. Reply routing is handled by the bridge; this
  // is purely informational context.
  if (message.threadId && message.threadId !== message.messageId) {
    parts.unshift(`(in thread ${message.threadId})`);
  }

  return parts.join("\n");
}

/** Render an attachments block (metadata + per-file Read hints), or "" if none. */
function renderAttachments(attachments: readonly InboundAttachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return "";

  const lines: string[] = ["Attachments:"];
  for (const a of attachments) {
    const type = a.mimeType ?? "unknown";
    const downloaded = a.localPath ? "" : " [not downloaded]";
    lines.push(`  - ${a.name} (${type}, ${a.sizeBytes} bytes)${downloaded}`);
  }

  const hints: string[] = [];
  for (const a of attachments) {
    if (!a.localPath) continue;
    const isImage = (a.mimeType ?? "").startsWith("image/");
    hints.push(
      isImage
        ? `(Image downloaded -- read the file at ${a.localPath} to see its contents)`
        : `(File downloaded -- read the file at ${a.localPath})`,
    );
  }

  return [lines.join("\n"), ...hints].join("\n");
}

/** Escape the five XML-significant chars so ids/names can't break the envelope. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
