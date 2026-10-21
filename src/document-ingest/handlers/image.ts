/**
 * Phase 101 T04 — image handler. Single page with resized imageBuffer.
 * Sharp resize to ≤ DIMENSION_MAX_PX (T-101-04 mitigation).
 */

import sharp from "sharp";
import type { BatchedPage } from "../types.js";
import { DIMENSION_MAX_PX } from "../page-batch.js";

export async function handleImage(
  buffer: Buffer,
): Promise<readonly BatchedPage[]> {
  const resized = await sharp(buffer)
    .resize({
      width: DIMENSION_MAX_PX,
      height: DIMENSION_MAX_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  const meta = await sharp(resized).metadata();
  return [
    {
      pageNumber: 1,
      imageBuffer: resized,
      widthPx: meta.width,
      heightPx: meta.height,
    },
  ];
}
