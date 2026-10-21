/**
 * Phase 999.154 — font-free number badges for contact-sheet tiles.
 *
 * sharp rasterizes SVG through librsvg, and text needs system fonts the
 * production host may not have (clawdy ships no webfonts). Digits drawn as
 * seven-segment rectangles render identically everywhere.
 */

const SEGMENTS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  a: [3, 0, 22, 6],
  b: [22, 3, 6, 21],
  c: [22, 24, 6, 21],
  d: [3, 42, 22, 6],
  e: [0, 24, 6, 21],
  f: [0, 3, 6, 21],
  g: [3, 21, 22, 6],
};

const DIGIT_SEGMENTS: Readonly<Record<string, string>> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgedc",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
};

const DIGIT_W = 28;
const DIGIT_H = 48;
const DIGIT_GAP = 8;
const PAD = 10;

export function badgeSize(n: number): { readonly width: number; readonly height: number } {
  const digits = String(n).length;
  return {
    width: PAD * 2 + digits * DIGIT_W + (digits - 1) * DIGIT_GAP,
    height: PAD * 2 + DIGIT_H,
  };
}

/** SVG for a yellow badge showing `n` in black seven-segment digits. */
export function numberBadgeSvg(n: number): string {
  const { width, height } = badgeSize(n);
  const rects: string[] = [];
  [...String(n)].forEach((ch, idx) => {
    const ox = PAD + idx * (DIGIT_W + DIGIT_GAP);
    for (const seg of DIGIT_SEGMENTS[ch] ?? "") {
      const [x, y, w, h] = SEGMENTS[seg]!;
      rects.push(`<rect x="${ox + x}" y="${PAD + y}" width="${w}" height="${h}" fill="#000"/>`);
    }
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#ffd400"/>` +
    rects.join("") +
    `</svg>`
  );
}
