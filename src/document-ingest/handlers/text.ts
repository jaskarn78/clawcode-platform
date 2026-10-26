/**
 * Phase 101 T04 — plain-text handler. Single page, UTF-8 decode.
 *
 * WP3 (2026-10-25): detection falls back to "text" for any type it does not
 * recognize, so a binary file (a .pptx, an undecodable image, an unknown
 * blob) used to be decoded as UTF-8 and embedded as garbage. Buffers that
 * look binary now produce an empty page; the caller then stores a stub
 * instead of the bytes.
 */

import type { BatchedPage } from "../types.js";

/** Bytes inspected by the binary heuristic (the same window git uses). */
const BINARY_SNIFF_BYTES = 8000;

/**
 * True when the buffer looks like binary data: a NUL byte in the first
 * 8000 bytes, or more than 10% U+FFFD replacement characters after UTF-8
 * decoding (invalid byte sequences).
 */
export function looksBinary(buffer: Buffer): boolean {
  const head = buffer.subarray(0, BINARY_SNIFF_BYTES);
  if (head.includes(0)) return true;
  const decoded = head.toString("utf-8");
  if (decoded.length === 0) return false;
  let replacements = 0;
  for (const ch of decoded) if (ch === "�") replacements++;
  return replacements / decoded.length > 0.1;
}

export async function handleText(
  buffer: Buffer,
): Promise<readonly BatchedPage[]> {
  if (looksBinary(buffer)) return [{ pageNumber: 1, text: "" }];
  return [{ pageNumber: 1, text: buffer.toString("utf-8").trim() }];
}
