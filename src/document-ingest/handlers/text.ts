/**
 * Phase 101 T04 — plain-text handler. Single page, UTF-8 decode.
 */

import type { BatchedPage } from "../types.js";

export async function handleText(
  buffer: Buffer,
): Promise<readonly BatchedPage[]> {
  return [{ pageNumber: 1, text: buffer.toString("utf-8").trim() }];
}
