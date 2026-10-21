/**
 * Phase 999.154 WS-2 — images for the agent's OWN turn.
 *
 * Replaces the Haiku pre-pass on the hot path. Every attached image is placed
 * one of three ways, in upload order, under a per-turn token budget:
 *   full   — its own image block (screenshots at screenshotSidePx, photos at
 *            photoSidePx — a photo reads fine at 1024, a 9pt cell does not)
 *   sheet  — a numbered tile on a contact sheet (grid×grid per sheet); the
 *            agent Reads the local_path of any tile it needs at full size
 *            (validated 2026-09-22: Sonnet mapped 9/9 badges to the manifest
 *            and volunteered which tiles to open)
 *   path   — budget exhausted: listed with its local_path only
 * Nothing is dropped: the manifest names every image, its number and path.
 */

import sharp from "sharp";
import { MAX_INPUT_PIXELS, withImageWorkSlot } from "../manager/image-work-governor.js";
import type { SendImageInput } from "../manager/session-adapter.js";
import { numberBadgeSvg } from "./seven-segment.js";
import type { ResolvedTurnVisionConfig } from "./turn-vision-config.js";

export type TurnImageSource = {
  readonly path: string;
  readonly filename: string;
  readonly mimeType: string | null;
};

export type Placement =
  | { readonly kind: "full"; readonly block: number }
  | { readonly kind: "sheet"; readonly sheet: number; readonly block: number }
  | { readonly kind: "path"; readonly reason: "budget" | "undecodable" | "ceiling" };

export type PlannedImage = {
  readonly index: number;
  readonly source: TurnImageSource;
  readonly placement: Placement;
};

export type TurnImages = {
  readonly images: readonly SendImageInput[];
  readonly manifest: string;
  readonly plan: readonly PlannedImage[];
  readonly stats: {
    readonly total: number;
    readonly full: number;
    readonly onSheets: number;
    readonly pathOnly: number;
    readonly estimatedTokens: number;
  };
};

/**
 * Filenames are attacker-controlled and land in the FULLY-TOOLED agent's
 * turn: allowlist + length cap (the same rule as the ingest labels). The
 * local_path needs no such treatment — downloads already sanitize the name.
 */
export function safeDisplayName(filename: string): string {
  const cleaned = filename.replace(/[^\w.\- ]+/g, "_").trim();
  return (cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned) || "image";
}

/** Anthropic's image-token estimate for a W×H image. */
export function estimateImageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750);
}

export function isScreenshotLike(src: TurnImageSource): boolean {
  const mime = (src.mimeType ?? "").toLowerCase();
  if (mime === "image/png" || mime === "image/webp") return true;
  return /screen\s?shot|^image\.(png|webp)$/i.test(src.filename);
}

function fitInside(w: number, h: number, side: number): { width: number; height: number } {
  const scale = Math.min(1, side / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

type Probe = { readonly width: number; readonly height: number } | null;

export type TurnImageDeps = {
  /** Test seam: image dimensions (null ⇒ undecodable). */
  readonly probe?: (path: string) => Promise<Probe>;
  /** Test seam: render one full image → JPEG bytes. */
  readonly renderFull?: (path: string, side: number) => Promise<Buffer>;
  /** Test seam: render one contact sheet → JPEG bytes. */
  readonly renderSheet?: (
    tiles: ReadonlyArray<{ readonly path: string; readonly index: number }>,
    grid: number,
    tilePx: number,
  ) => Promise<Buffer>;
};

async function defaultProbe(path: string): Promise<Probe> {
  try {
    const meta = await withImageWorkSlot(() =>
      sharp(path, { limitInputPixels: MAX_INPUT_PIXELS }).timeout({ seconds: 5 }).metadata(),
    );
    if (!meta.width || !meta.height) return null;
    // EXIF orientations 5–8 swap the displayed axes.
    const swap = (meta.orientation ?? 1) >= 5;
    return swap ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
  } catch {
    return null;
  }
}

async function defaultRenderFull(path: string, side: number): Promise<Buffer> {
  return withImageWorkSlot(() =>
    sharp(path, { limitInputPixels: MAX_INPUT_PIXELS })
      .timeout({ seconds: 15 })
      .rotate()
      .resize(side, side, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 88 })
      .toBuffer(),
  );
}

export async function renderContactSheet(
  tiles: ReadonlyArray<{ readonly path: string; readonly index: number }>,
  grid: number,
  tilePx: number,
): Promise<Buffer> {
  const rows = Math.ceil(tiles.length / grid);
  const inner = tilePx - 8;
  const composites: sharp.OverlayOptions[] = [];
  for (let k = 0; k < tiles.length; k++) {
    const tile = tiles[k]!;
    const x = (k % grid) * tilePx;
    const y = Math.floor(k / grid) * tilePx;
    let thumb: Buffer | null = null;
    try {
      thumb = await withImageWorkSlot(() =>
        sharp(tile.path, { limitInputPixels: MAX_INPUT_PIXELS })
          .timeout({ seconds: 15 })
          .rotate()
          .resize(inner, inner, { fit: "contain", background: "#1e1e1e" })
          .flatten({ background: "#1e1e1e" })
          .png()
          .toBuffer(),
      );
    } catch {
      thumb = null; // leave the cell dark; the manifest still names it
    }
    if (thumb !== null) composites.push({ input: thumb, left: x + 4, top: y + 4 });
    composites.push({
      input: Buffer.from(numberBadgeSvg(tile.index)),
      left: x + 4,
      top: y + 4,
    });
  }
  return withImageWorkSlot(() =>
    sharp({
      create: {
        width: grid * tilePx,
        height: rows * tilePx,
        channels: 3,
        background: "#1e1e1e",
      },
    })
      .composite(composites)
      .jpeg({ quality: 85 })
      .toBuffer(),
  );
}

function manifestLine(p: PlannedImage): string {
  const where =
    p.placement.kind === "full"
      ? `full image (block ${p.placement.block})`
      : p.placement.kind === "sheet"
        ? `contact sheet ${p.placement.sheet} (block ${p.placement.block}), tile ${p.index}`
        : p.placement.reason === "undecodable"
          ? "could not be decoded — Read the file to inspect"
          : p.placement.reason === "ceiling"
            ? "not shown (per-turn image ceiling) — Read the file to view"
            : "not shown (turn image budget) — Read the file to view";
  return `#${p.index} ${safeDisplayName(p.source.filename)} — ${where} — local_path="${p.source.path}"`;
}

/**
 * Plan + render the turn's images. Never throws: a render failure demotes
 * that image (or sheet) to a path-only manifest line.
 */
export async function buildTurnImages(
  sources: readonly TurnImageSource[],
  cfg: ResolvedTurnVisionConfig["inline"],
  deps: TurnImageDeps = {},
): Promise<TurnImages> {
  const probe = deps.probe ?? defaultProbe;
  const renderFull = deps.renderFull ?? defaultRenderFull;
  const renderSheet = deps.renderSheet ?? renderContactSheet;

  // Only images that could ever be shown are decoded: anything past the
  // ceiling is listed by path without touching the shared decode governor, so
  // a flood of chained 10-attachment messages cannot monopolize it.
  const probes = await Promise.all(
    sources.map((s, i) => (i < cfg.maxImages ? probe(s.path) : Promise.resolve(undefined))),
  );
  const sheetW = cfg.contactSheet.grid * cfg.contactSheet.tilePx;
  const perSheet = cfg.contactSheet.grid * cfg.contactSheet.grid;

  let used = 0;
  let fullCount = 0;
  const placements: Array<Placement | null> = sources.map(() => null);
  const overflow: number[] = [];
  const fullSide: number[] = [];

  sources.forEach((src, i) => {
    if (i >= cfg.maxImages) {
      placements[i] = { kind: "path", reason: "ceiling" };
      return;
    }
    const dims = probes[i];
    if (dims === null || dims === undefined) {
      placements[i] = { kind: "path", reason: "undecodable" };
      return;
    }
    const side = isScreenshotLike(src) ? cfg.screenshotSidePx : cfg.photoSidePx;
    const fitted = fitInside(dims.width, dims.height, side);
    const t = estimateImageTokens(fitted.width, fitted.height);
    if (fullCount < cfg.fullResImages && used + t <= cfg.maxImageTokens) {
      used += t;
      fullCount++;
      fullSide[i] = side;
      placements[i] = { kind: "full", block: 0 };
    } else {
      overflow.push(i);
    }
  });

  // Contact sheets for the overflow, in order, while the budget allows.
  const sheets: number[][] = [];
  for (let k = 0; k < overflow.length; k += perSheet) {
    const members = overflow.slice(k, k + perSheet);
    const rows = Math.ceil(members.length / cfg.contactSheet.grid);
    const t = estimateImageTokens(sheetW, rows * cfg.contactSheet.tilePx);
    if (used + t <= cfg.maxImageTokens) {
      used += t;
      sheets.push(members);
    } else {
      for (const m of members) placements[m] = { kind: "path", reason: "budget" };
    }
  }

  // Render in block order: full images first (upload order), then sheets.
  const images: SendImageInput[] = [];
  for (let i = 0; i < sources.length; i++) {
    if (placements[i]?.kind !== "full") continue;
    try {
      const buf = await renderFull(sources[i]!.path, fullSide[i]!);
      images.push({ mediaType: "image/jpeg", data: buf.toString("base64") });
      placements[i] = { kind: "full", block: images.length };
    } catch {
      placements[i] = { kind: "path", reason: "undecodable" };
    }
  }
  let sheetNo = 0;
  for (const members of sheets) {
    try {
      const buf = await renderSheet(
        members.map((m) => ({ path: sources[m]!.path, index: m + 1 })),
        cfg.contactSheet.grid,
        cfg.contactSheet.tilePx,
      );
      images.push({ mediaType: "image/jpeg", data: buf.toString("base64") });
      sheetNo++;
      for (const m of members) placements[m] = { kind: "sheet", sheet: sheetNo, block: images.length };
    } catch {
      for (const m of members) placements[m] = { kind: "path", reason: "undecodable" };
    }
  }

  const plan: PlannedImage[] = sources.map((source, i) => ({
    index: i + 1,
    source,
    placement: placements[i] ?? { kind: "path", reason: "budget" },
  }));
  const full = plan.filter((p) => p.placement.kind === "full").length;
  const onSheets = plan.filter((p) => p.placement.kind === "sheet").length;
  const pathOnly = plan.length - full - onSheets;

  const header =
    `<attachment-images total="${plan.length}" full="${full}" on_contact_sheets="${onSheets}" path_only="${pathOnly}">`;
  const guide =
    images.length > 0
      ? "Images are numbered #1..#" +
        plan.length +
        " in upload order. The image blocks attached to this message follow the block numbers below; " +
        "contact sheets show numbered thumbnails (yellow badge = image number). " +
        "Read a local_path whenever you need an image at full resolution."
      : "No image blocks are attached to this message. Read each local_path to see an image.";
  const manifest = [header, guide, ...plan.map(manifestLine), "</attachment-images>"].join("\n");

  return {
    images,
    manifest,
    plan,
    stats: { total: plan.length, full, onSheets, pathOnly, estimatedTokens: used },
  };
}

/** Manifest-only (no image blocks) — mid-turn steers and vision mode "off". */
export function pathOnlyManifest(sources: readonly TurnImageSource[]): string {
  const plan: PlannedImage[] = sources.map((source, i) => ({
    index: i + 1,
    source,
    placement: { kind: "path", reason: "budget" },
  }));
  return [
    `<attachment-images total="${plan.length}" full="0" on_contact_sheets="0" path_only="${plan.length}">`,
    "No image blocks are attached to this message. Read each local_path to see an image.",
    ...plan.map((p) => `#${p.index} ${safeDisplayName(p.source.filename)} — local_path="${p.source.path}"`),
    "</attachment-images>",
  ].join("\n");
}

/** One-line receipt for the upload's progress message. */
export function describeTurnImages(stats: TurnImages["stats"]): string {
  const parts = [`${stats.full} full`];
  if (stats.onSheets > 0) parts.push(`${stats.onSheets} on contact sheets`);
  if (stats.pathOnly > 0) parts.push(`${stats.pathOnly} by file`);
  return `👀 Viewing all ${stats.total} images (${parts.join(" · ")})`;
}
