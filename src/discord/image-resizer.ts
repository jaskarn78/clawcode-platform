/**
 * Image resize helper for the vision pre-pass pipeline (Phase 113).
 *
 * Anthropic bills based on image pixel count. Resizing to ≤1568px on the
 * longest side before the Haiku vision call cuts billed pixel cost ~30-60%
 * with negligible quality loss for screenshot analysis.
 */

import sharp from "sharp";
import {
  withImageWorkSlot,
  MAX_INPUT_PIXELS,
} from "../manager/image-work-governor.js";

const MAX_SIDE_PX = 1568;

/**
 * P1-TIMEOUT — hard wall-clock wall on the libvips decode. Native
 * `sharp.timeout()` cancels the decode at the C level (unlike AbortController /
 * Promise.race, which abandon the JS promise while the native thread keeps
 * running and keeps holding the governor slot). The only lever that frees a
 * wedged decode.
 */
const RESIZE_TIMEOUT_SECONDS = 15;

/**
 * Resize an image file so neither dimension exceeds 1568px.
 * Preserves aspect ratio. Does not upscale images already within bounds.
 * Output is PNG (lossless, consistent with screenshot content).
 *
 * P1-GATE — the CPU-bound decode runs inside the process-global image-work
 * governor (`withImageWorkSlot`). The slot is held ONLY for the decode and is
 * released when `toBuffer()` settles — i.e. BEFORE the caller's downstream
 * Haiku network call. This is the vision path's single governor acquisition;
 * the caller (`runVisionPrePass`) must NOT acquire again (that would
 * double-count the permit).
 */
export async function resizeImageForVision(filePath: string): Promise<Buffer> {
  return withImageWorkSlot(() =>
    sharp(filePath, { limitInputPixels: MAX_INPUT_PIXELS })
      .timeout({ seconds: RESIZE_TIMEOUT_SECONDS })
      .resize(MAX_SIDE_PX, MAX_SIDE_PX, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer(),
  );
}
