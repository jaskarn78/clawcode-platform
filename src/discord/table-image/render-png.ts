/**
 * Rasterise a table SVG to PNG with resvg, using the embedded JetBrains
 * Mono subset. The font files are materialised once under the manager dir
 * (resvg 2.x loads fonts from paths, not buffers); system fonts are never
 * consulted so the output is identical on every host.
 *
 * Lazy-imports `@resvg/resvg-js` (native) so a missing/broken binding only
 * disables images — callers fail open to the text renderer.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { JETBRAINS_MONO_BOLD_B64, JETBRAINS_MONO_REGULAR_B64 } from "./fonts.generated.js";

let fontPaths: readonly string[] | null = null;

function fontDir(): string {
  const base = process.env.CLAWCODE_FONT_CACHE_DIR
    ?? join(process.env.CLAWCODE_HOME ?? join(homedir(), ".clawcode"), "manager", "fonts");
  try {
    mkdirSync(base, { recursive: true });
    return base;
  } catch {
    const fallback = join(tmpdir(), "clawcode-fonts");
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

/** Write the embedded fonts to disk once (content-hashed names → idempotent). */
export function ensureFontFiles(): readonly string[] {
  if (fontPaths) return fontPaths;
  const dir = fontDir();
  const out: string[] = [];
  for (const [name, b64] of [
    ["JetBrainsMono-Regular", JETBRAINS_MONO_REGULAR_B64],
    ["JetBrainsMono-Bold", JETBRAINS_MONO_BOLD_B64],
  ] as const) {
    const buf = Buffer.from(b64, "base64");
    const hash = createHash("sha256").update(buf).digest("hex").slice(0, 8);
    const p = join(dir, `${name}-${hash}.ttf`);
    if (!existsSync(p)) writeFileSync(p, buf, { mode: 0o644 });
    out.push(p);
  }
  fontPaths = out;
  return out;
}

export interface RenderPngOptions {
  /** Device scale factor (2 = crisp on retina/mobile). */
  readonly scale?: number;
}

export async function renderSvgToPng(svg: string, opts: RenderPngOptions = {}): Promise<Buffer> {
  const { Resvg } = await import("@resvg/resvg-js");
  const fonts = ensureFontFiles();
  const r = new Resvg(svg, {
    fitTo: { mode: "zoom", value: opts.scale ?? 2 },
    font: {
      loadSystemFonts: false,
      fontFiles: [...fonts],
      defaultFontFamily: "JetBrains Mono",
    },
  });
  return Buffer.from(r.render().asPng());
}
