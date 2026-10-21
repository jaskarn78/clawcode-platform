/**
 * Phase 999.154 — provider-neutral image analysis seam.
 *
 * Every Claude-vision consumer outside the agent's own turn (auto-ingest
 * classification, chart shape, image summaries, the health canary) goes
 * through a `VisionProvider`. A provider may FAIL, but it may never return
 * fiction: an image it could not truthfully analyze maps to `null`, and every
 * caller treats `null` as "no vision" (OCR text still lands).
 */

export type ImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

/** One image queued for analysis. `id` is caller-owned (typically the path). */
export type LabeledImage = {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: ImageMediaType;
  /** Raw base64, already resized for vision. */
  readonly data: string;
};

export const IMAGE_KINDS = [
  "screenshot",
  "photo",
  "chart",
  "diagram",
  "document",
  "other",
] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

export const IMAGE_IMPORTANCE = ["high", "medium", "low"] as const;
export type ImageImportance = (typeof IMAGE_IMPORTANCE)[number];

export type ImageAnalysis = {
  readonly kind: ImageKind;
  readonly summary: string;
  readonly text: readonly string[];
  readonly isChart: boolean;
  /** Trend / shape / axes description; null unless `isChart`. */
  readonly chartShape: string | null;
  readonly importance: ImageImportance;
  readonly entities: readonly string[];
};

export type VisionProviderId = "bridge-haiku" | "ocr-only";

export type VisionCallOptions = {
  readonly signal?: AbortSignal;
};

export interface VisionProvider {
  readonly id: VisionProviderId;
  /**
   * Analyze images in order. The result has exactly `images.length` entries;
   * entry `n` belongs to `images[n]`. Throws on a transport failure (the
   * service fails over); returns `null` entries for images it could not
   * analyze truthfully.
   */
  analyzeBatch(
    images: ReadonlyArray<LabeledImage>,
    opts?: VisionCallOptions,
  ): Promise<ReadonlyArray<ImageAnalysis | null>>;
}

/** Render an analysis as the plain-text form the classifier + chunker consume. */
export function renderAnalysisText(a: ImageAnalysis): string {
  const lines = [`TYPE: ${a.kind}`, `SUMMARY: ${a.summary}`];
  if (a.text.length > 0) {
    lines.push("TEXT:", ...a.text.map((t) => `- ${t}`));
  }
  if (a.entities.length > 0) lines.push(`ENTITIES: ${a.entities.join(", ")}`);
  return lines.join("\n");
}
