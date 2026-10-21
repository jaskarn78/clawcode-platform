/**
 * Auto-ingest classifier (Phase 999.43 Plan 01).
 *
 * Pure-function heuristic classifier that maps a Discord attachment's metadata
 * (filename, MIME type, size, optional Phase 113 vision-pre-pass output) to a
 * two-axis priority result:
 *   - eligible: whether the attachment should be auto-ingested at all (D-06
 *     eligibility filter rejects video/audio/archives before classification)
 *   - contentClass: "high" | "medium" | "low" — Axis 2 of the D-01 spec; fed
 *     into the multiplicative score formula at retrieval time (D-02)
 *   - reason: human-readable trace of the matched cascade rung (surfaces in
 *     the `phase999.43-autoingest` structured log line — Plan 02)
 *
 * The cascade order is verbatim from CONTEXT.md `<decisions>` D-01 Axis 2.
 * Short-circuits on first match: reject → code → spreadsheet/doc → plaintext
 * → PDF → image (client-name → vision text-heavy → vision web/UI/form →
 * Screenshot heuristic → default) → fallback MEDIUM.
 *
 * NO I/O. NO LLM calls (the vision pre-pass already ran upstream — Phase 113
 * + D-05 — and its output is passed in as a string blob).
 */

/** Inputs to the classifier — all pure data, no handles or side effects. */
export type ClassifierInput = {
  readonly filename: string;
  readonly mimeType: string | null;
  readonly size: number;
  /**
   * Phase 113 vision-pre-pass output (D-05). String blob from
   * `runVisionPrePass` → `callHaikuVision`. Undefined for non-image
   * attachments or when the vision pass failed/skipped.
   */
  readonly visionAnalysis?: string;
  /**
   * Phase 999.154 — structured importance from the batched ingest vision call.
   * When present for an image it decides the class directly (after the
   * operator client-name rung). Keyword matching over free text stays only as
   * a fallback: it was steered by Haiku's refusal wording for four months
   * ("I'll return…" → HIGH, "format" → form → LOW).
   */
  readonly visionImportance?: ContentClass;
  /** Phase 999.154 — structured image kind, for the classifier reason string. */
  readonly visionKind?: string;
  /**
   * Optional operator-curated list of client-name substrings. Case-insensitive
   * substring match against `filename`. When a match hits, image attachments
   * elevate to HIGH (D-01 Axis 2: "Image, filename contains operator-set
   * client-name list → HIGH"). When absent or empty, the rung is skipped.
   */
  readonly clientNamePatterns?: readonly string[];
};

export type ContentClass = "high" | "medium" | "low";

export type ClassifierOutput = {
  readonly eligible: boolean;
  readonly contentClass: ContentClass;
  readonly reason: string;
};

// D-06 reject extensions (verbatim from CONTEXT.md). Lowercase, dot-prefixed.
const REJECT_VIDEO_EXTS: readonly string[] = [
  ".mp4",
  ".mov",
  ".webm",
  ".avi",
];
const REJECT_AUDIO_EXTS: readonly string[] = [
  ".mp3",
  ".m4a",
  ".wav",
  ".ogg",
  ".flac",
];
const REJECT_ARCHIVE_EXTS: readonly string[] = [
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
];

// D-01 Axis 2 — code files map to LOW.
const CODE_EXTS: readonly string[] = [
  ".py",
  ".js",
  ".sql",
  ".ts",
  ".tsx",
  ".jsx",
];

// D-01 Axis 2 — spreadsheet/doc map to HIGH.
const SPREADSHEET_DOC_EXTS: readonly string[] = [
  ".docx",
  ".xlsx",
  ".csv",
];

// D-01 Axis 2 — plaintext map to MEDIUM.
const PLAINTEXT_EXTS: readonly string[] = [".md", ".txt"];

// D-01 Axis 2 — PDF size threshold (bytes). >= threshold → HIGH; below → LOW.
const PDF_HIGH_SIZE_THRESHOLD = 100_000;

// D-01 Axis 2 — vision-pass keyword sets for image branch.
// Text-heavy financial-doc content → HIGH.
const VISION_HIGH_KEYWORDS: readonly string[] = [
  "statement",
  "tax",
  "brokerage",
  "balance",
  "invoice",
  "contract",
  "portfolio",
  "return",
  "1099",
  "w-2",
  "w2",
];

// Webpage/UI/form content → LOW.
const VISION_LOW_KEYWORDS: readonly string[] = [
  "webpage",
  "website",
  "form",
  "checkout",
  "ui",
  "button",
  "dropdown",
  "login",
];

// D-01 Axis 2 — filename form-keyword set used inside the Screenshot branch.
const SCREENSHOT_FORM_KEYWORDS: readonly string[] = [
  "form",
  "fill",
  "checkout",
];

// Phase 999.43-fu2 Path B T04 — chart-detection heuristic constants.
// Filename keywords commonly used for chart/graph images. Case-insensitive
// substring match against filename.
const CHART_FILENAME_KEYWORDS: readonly string[] = [
  "chart",
  "graph",
  "plot",
  "candle",
  "trend",
];

// Vision-pre-pass keyword cues — phrases the Phase 113 Haiku output uses when
// it sees axes, grids, or chart-specific visual elements. Order matters:
// more-specific terms come BEFORE their substrings ("x-axis"/"y-axis" before
// "axis") so the reason string cites the precise term that hit.
const CHART_VISION_KEYWORDS: readonly string[] = [
  "x-axis",
  "y-axis",
  "candlestick",
  "axis",
  "grid",
  "scatter",
];

// Aspect-ratio threshold for "wide image more likely to be a chart" — 1.6
// (the BACKLOG-quoted value). Wider than a 16:10 monitor, narrower than
// 16:9 — captures landscape charts/dashboards while excluding most
// near-square screenshots.
const CHART_ASPECT_RATIO_THRESHOLD = 1.6;

/**
 * Extract the lowercased extension (including the dot) from a filename.
 * Returns the empty string when the filename has no extension.
 */
function getExtension(filename: string): string {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0 || dot === lower.length - 1) return "";
  return lower.slice(dot);
}

/**
 * D-06 eligibility filter. Rejects video/audio/archive extensions before
 * classification. Pure function — used by `classifyAttachment` AND exported
 * so Plan 02 (dispatcher) can short-circuit BEFORE bothering to download a
 * 5GB .mp4 only to drop it on the floor.
 */
export function isEligibleForIngest(
  input: ClassifierInput,
): { eligible: boolean; reason: string } {
  const ext = getExtension(input.filename);
  if (REJECT_VIDEO_EXTS.includes(ext)) {
    return { eligible: false, reason: `video file rejected (${ext})` };
  }
  if (REJECT_AUDIO_EXTS.includes(ext)) {
    return { eligible: false, reason: `audio file rejected (${ext})` };
  }
  if (REJECT_ARCHIVE_EXTS.includes(ext)) {
    return { eligible: false, reason: `archive file rejected (${ext})` };
  }
  return { eligible: true, reason: "eligible" };
}

/**
 * Classify an attachment per the D-01 Axis 2 cascade. Short-circuits on first
 * match. Always returns a frozen `ClassifierOutput`.
 *
 * Cascade order (verbatim from CONTEXT.md D-01 Axis 2):
 *   1. D-06 reject → eligible:false, contentClass:"low"
 *   2. Code (.py/.js/.sql/.ts/.tsx/.jsx) → LOW
 *   3. Spreadsheet/doc (.docx/.xlsx/.csv) → HIGH
 *   4. Plaintext (.md/.txt) → MEDIUM
 *   5. PDF (.pdf): size >= 100KB → HIGH; else LOW
 *   6. Image (mimeType startsWith "image/"):
 *      6a. clientNamePatterns hits filename → HIGH
 *      6b. visionAnalysis hits VISION_HIGH_KEYWORDS → HIGH
 *      6c. visionAnalysis hits VISION_LOW_KEYWORDS → LOW
 *      6d. filename contains "screenshot": if also matches form-keywords → LOW
 *          else MEDIUM
 *      6e. default → MEDIUM
 *   7. Fallback → MEDIUM
 */
export function classifyAttachment(
  input: ClassifierInput,
): ClassifierOutput {
  // Step 1: D-06 reject filter.
  const eligibility = isEligibleForIngest(input);
  if (!eligibility.eligible) {
    return Object.freeze({
      eligible: false,
      contentClass: "low",
      reason: eligibility.reason,
    });
  }

  const ext = getExtension(input.filename);
  const filenameLower = input.filename.toLowerCase();

  // Step 2: Code files → LOW.
  if (CODE_EXTS.includes(ext)) {
    return Object.freeze({
      eligible: true,
      contentClass: "low",
      reason: `code file (${ext})`,
    });
  }

  // Step 3: Spreadsheet/doc → HIGH.
  if (SPREADSHEET_DOC_EXTS.includes(ext)) {
    return Object.freeze({
      eligible: true,
      contentClass: "high",
      reason: `spreadsheet/doc (${ext})`,
    });
  }

  // Step 4: Plaintext → MEDIUM.
  if (PLAINTEXT_EXTS.includes(ext)) {
    return Object.freeze({
      eligible: true,
      contentClass: "medium",
      reason: `plaintext (${ext})`,
    });
  }

  // Step 5: PDF — size threshold split.
  if (ext === ".pdf") {
    if (input.size >= PDF_HIGH_SIZE_THRESHOLD) {
      return Object.freeze({
        eligible: true,
        contentClass: "high",
        reason: `PDF size ${input.size} >= ${PDF_HIGH_SIZE_THRESHOLD}`,
      });
    }
    return Object.freeze({
      eligible: true,
      contentClass: "low",
      reason: `PDF size ${input.size} < ${PDF_HIGH_SIZE_THRESHOLD}`,
    });
  }

  // Step 6: Image branch.
  const isImage =
    typeof input.mimeType === "string" &&
    input.mimeType.toLowerCase().startsWith("image/");
  if (isImage) {
    // 6a: client-name match.
    if (
      input.clientNamePatterns !== undefined &&
      input.clientNamePatterns.length > 0
    ) {
      const hit = input.clientNamePatterns.find((p) =>
        filenameLower.includes(p.toLowerCase()),
      );
      if (hit !== undefined) {
        return Object.freeze({
          eligible: true,
          contentClass: "high",
          reason: `image + client-name match (${hit})`,
        });
      }
    }

    // Phase 999.154: structured vision importance wins over keywords.
    if (input.visionImportance !== undefined) {
      return Object.freeze({
        eligible: true,
        contentClass: input.visionImportance,
        reason: `image + vision importance (${input.visionImportance}${
          input.visionKind ? `, ${input.visionKind}` : ""
        })`,
      });
    }

    // 6b/6c: vision keyword cascade.
    if (typeof input.visionAnalysis === "string" && input.visionAnalysis.length > 0) {
      const visionLower = input.visionAnalysis.toLowerCase();
      const highHit = VISION_HIGH_KEYWORDS.find((k) =>
        visionLower.includes(k),
      );
      if (highHit !== undefined) {
        return Object.freeze({
          eligible: true,
          contentClass: "high",
          reason: `image + vision text-heavy (matched: ${highHit})`,
        });
      }
      const lowHit = VISION_LOW_KEYWORDS.find((k) => visionLower.includes(k));
      if (lowHit !== undefined) {
        return Object.freeze({
          eligible: true,
          contentClass: "low",
          reason: `image + vision web/UI (matched: ${lowHit})`,
        });
      }
    }

    // 6d: Screenshot heuristic.
    if (filenameLower.includes("screenshot")) {
      const formHit = SCREENSHOT_FORM_KEYWORDS.find((k) =>
        filenameLower.includes(k),
      );
      if (formHit !== undefined) {
        return Object.freeze({
          eligible: true,
          contentClass: "low",
          reason: `image + screenshot + form-keyword (${formHit})`,
        });
      }
      return Object.freeze({
        eligible: true,
        contentClass: "medium",
        reason: "image + screenshot",
      });
    }

    // 6e: default image fallback → MEDIUM.
    return Object.freeze({
      eligible: true,
      contentClass: "medium",
      reason: "image default fallback",
    });
  }

  // Step 7: All-other-types fallback → MEDIUM.
  return Object.freeze({
    eligible: true,
    contentClass: "medium",
    reason: "default fallback",
  });
}

/**
 * Phase 999.43-fu2 Path B T04 — chart-detection predicate. Pure function.
 *
 * Returns `{isChart, reason}` based on a 3-rung heuristic cascade:
 *   1. Filename keyword hit ("chart", "graph", "plot", "candle", "trend")
 *   2. Vision-analysis keyword hit ("axis", "x-axis", "y-axis", "grid",
 *      "scatter", "candlestick") — surfaces shape-cue mentions from the
 *      Phase 113 vision pre-pass output.
 *   3. Aspect-ratio gate — when dimensions are known and width/height
 *      ratio ≥ 1.6 (wide landscape → more likely a chart than a near-square
 *      screenshot or portrait photo).
 *
 * Short-circuits on first hit. When NO rung fires (or required inputs are
 * absent), returns `{isChart: false, reason: "no chart cues"}`. Used by the
 * dispatcher to decide whether to fire a SECOND Haiku 4.5 vision call with
 * the chart-specific prompt (T05).
 *
 * Inputs are all pure data — no I/O, no LLM calls. Dimensions optional;
 * absent means the rung is skipped (not treated as 0/0).
 */
export type ChartDetectionInput = {
  readonly filename: string;
  readonly visionAnalysis?: string;
  readonly dimensions?: {
    readonly widthPx: number;
    readonly heightPx: number;
  };
};

export type ChartDetectionOutput = {
  readonly isChart: boolean;
  readonly reason: string;
};

export function isChartLike(
  input: ChartDetectionInput,
): ChartDetectionOutput {
  // Rung 1: filename keyword.
  const filenameLower = input.filename.toLowerCase();
  const filenameHit = CHART_FILENAME_KEYWORDS.find((k) =>
    filenameLower.includes(k),
  );
  if (filenameHit !== undefined) {
    return Object.freeze({
      isChart: true,
      reason: `filename keyword (${filenameHit})`,
    });
  }

  // Rung 2: vision-analysis keyword.
  if (
    typeof input.visionAnalysis === "string" &&
    input.visionAnalysis.length > 0
  ) {
    const visionLower = input.visionAnalysis.toLowerCase();
    const visionHit = CHART_VISION_KEYWORDS.find((k) =>
      visionLower.includes(k),
    );
    if (visionHit !== undefined) {
      return Object.freeze({
        isChart: true,
        reason: `vision keyword (${visionHit})`,
      });
    }
  }

  // Rung 3: aspect-ratio gate. Only fires when dimensions are present
  // and both sides are positive integers (defensive — sharp.metadata()
  // can theoretically return 0 or undefined on corrupt files).
  if (
    input.dimensions !== undefined &&
    input.dimensions.widthPx > 0 &&
    input.dimensions.heightPx > 0
  ) {
    const ratio = input.dimensions.widthPx / input.dimensions.heightPx;
    if (ratio >= CHART_ASPECT_RATIO_THRESHOLD) {
      return Object.freeze({
        isChart: true,
        reason: `aspect ratio ${ratio.toFixed(2)} >= ${CHART_ASPECT_RATIO_THRESHOLD}`,
      });
    }
  }

  return Object.freeze({
    isChart: false,
    reason: "no chart cues",
  });
}
