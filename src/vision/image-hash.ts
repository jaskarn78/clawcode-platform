/**
 * Phase 999.154 — content hashes for image dedupe.
 *
 * - sha256: exact duplicate (same bytes re-sent) → skip ingest entirely.
 * - dHash: 64-bit difference hash on a 9×8 greyscale thumbnail; Hamming
 *   distance ≤ threshold ⇒ near-duplicate (re-screenshot, recompressed
 *   forward) → reuse the prior analysis instead of paying for another call.
 */

import { createHash } from "node:crypto";
import sharp from "sharp";
import { MAX_INPUT_PIXELS } from "../manager/image-work-governor.js";

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * dHash as 16 hex chars, or null when the bytes don't decode. The caller must
 * already hold an image-work governor permit (auto-ingest drain does).
 */
export async function dHashHex(buf: Buffer): Promise<string | null> {
  try {
    const px = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS })
      .timeout({ seconds: 5 })
      .rotate()
      .greyscale()
      .resize(9, 8, { fit: "fill" })
      .raw()
      .toBuffer();
    let bits = 0n;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const left = px[y * 9 + x]!;
        const right = px[y * 9 + x + 1]!;
        bits = (bits << 1n) | (left > right ? 1n : 0n);
      }
    }
    return bits.toString(16).padStart(16, "0");
  } catch {
    return null;
  }
}

export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x > 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
