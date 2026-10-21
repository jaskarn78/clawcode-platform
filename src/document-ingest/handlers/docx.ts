/**
 * Phase 101 T04 — docx handler. Single-page text extraction via mammoth.
 */

import type { BatchedPage } from "../types.js";

export async function handleDocx(
  buffer: Buffer,
): Promise<readonly BatchedPage[]> {
  const mammoth = await import("mammoth");
  const fn =
    (mammoth as { extractRawText?: typeof mammoth.extractRawText })
      .extractRawText ??
    (mammoth as { default?: { extractRawText?: typeof mammoth.extractRawText } })
      .default?.extractRawText;
  if (typeof fn !== "function") {
    throw new Error("mammoth.extractRawText not available");
  }
  const result = await fn({ buffer });
  return [{ pageNumber: 1, text: (result.value ?? "").trim() }];
}
