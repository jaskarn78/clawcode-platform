import { describe, it, expect } from "vitest";
import {
  NEWSREADER_400_WOFF2_BASE64,
  NEWSREADER_600_WOFF2_BASE64,
  PLEX_MONO_400_WOFF2_BASE64,
  PLEX_MONO_600_WOFF2_BASE64,
  PLEX_COND_700_WOFF2_BASE64,
  PLEX_SANS_400_WOFF2_BASE64,
  PLEX_SANS_600_WOFF2_BASE64,
  fontFaceCss,
} from "../style/fonts.js";

/**
 * fonts.ts is generated, and a corrupted payload fails SILENTLY: Chromium drops
 * an undecodable @font-face and falls back, so the PDF still renders - in the
 * wrong typeface, in production only. These assertions are the tripwire.
 *
 * (This is not hypothetical. An earlier revision stored each payload as a
 * ~1,500-deep chain of `"..." + "..."`, which segfaulted tsc; the mechanical fix
 * for that silently dropped the last chunk of every font.)
 */
describe("embedded report fonts", () => {
  const faces = [
    ["Newsreader 400", NEWSREADER_400_WOFF2_BASE64],
    ["Newsreader 600", NEWSREADER_600_WOFF2_BASE64],
    ["IBM Plex Mono 400", PLEX_MONO_400_WOFF2_BASE64],
    ["IBM Plex Mono 600", PLEX_MONO_600_WOFF2_BASE64],
    ["IBM Plex Sans Condensed 700", PLEX_COND_700_WOFF2_BASE64],
    ["IBM Plex Sans 400", PLEX_SANS_400_WOFF2_BASE64],
    ["IBM Plex Sans 600", PLEX_SANS_600_WOFF2_BASE64],
  ] as const;

  for (const [name, payload] of faces) {
    it(`${name} decodes to a structurally valid woff2`, () => {
      const buf = Buffer.from(payload, "base64");
      // wOF2 magic. A truncated or re-wrapped payload loses this or the length.
      expect(buf.subarray(0, 4).toString("latin1")).toBe("wOF2");
      // Byte 8..12 is the total sfnt length: nonzero means a real font table.
      expect(buf.readUInt32BE(8)).toBeGreaterThan(0);
      // Exact round-trip catches any truncation the magic bytes would survive.
      expect(buf.toString("base64")).toBe(payload);
      expect(buf.byteLength).toBeGreaterThan(4_000);
    });
  }

  it("the @font-face block references every payload", () => {
    const css = fontFaceCss();
    for (const [, payload] of faces) {
      expect(css).toContain(`data:font/woff2;base64,${payload}`);
    }
    expect(css).toContain('font-family: "Newsreader"');
    expect(css).toContain('font-family: "IBM Plex Mono"');
    // `swap` would make the rendered face a race against a one-shot render.
    expect(css).not.toContain("font-display: swap");
  });
});
