/**
 * Phase 999.154 — terminal fallback: no vision model. Every image maps to
 * null, which callers render truthfully (OCR text only, path hints).
 */

import type { VisionProvider } from "../types.js";

export function createOcrOnlyProvider(): VisionProvider {
  return {
    id: "ocr-only",
    async analyzeBatch(images) {
      return images.map(() => null);
    },
  };
}
