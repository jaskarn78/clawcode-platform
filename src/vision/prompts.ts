/**
 * Phase 999.154 — batched structured image analysis prompts.
 *
 * Images arrive interleaved with `Image n (filename):` labels. The model MUST
 * echo the label number in `i`; the parser rejects any element whose index is
 * missing, out of range, or duplicated (misalignment is silent corruption).
 */

import { IMAGE_IMPORTANCE, IMAGE_KINDS } from "./types.js";

export const BATCH_VISION_SYSTEM_PROMPT =
  "You are a precise visual content analyzer. You receive labeled images and " +
  "answer ONLY with a JSON array. Describe only what is actually visible. " +
  "Never guess text you cannot read.";

export function buildBatchVisionPrompt(count: number): string {
  return [
    `You will receive ${count} image(s). Each is preceded by its label "Image n (filename):".`,
    `Return ONLY a JSON array with exactly ${count} element(s), one per labeled image, in label order:`,
    "{",
    '  "i": <the label number n>,',
    `  "type": one of ${IMAGE_KINDS.map((k) => `"${k}"`).join(" | ")},`,
    '  "summary": "1-2 sentences: what the image shows and why it matters",',
    '  "text": ["key visible text, verbatim; at most 20 items"],',
    '  "is_chart": true if it is a chart/graph/plot,',
    '  "chart_shape": "trend, axes, notable peaks/crossovers" or null when not a chart,',
    `  "importance": one of ${IMAGE_IMPORTANCE.map((k) => `"${k}"`).join(" | ")} (financial figures, documents, errors, decisions = high; casual photos, memes = low),`,
    '  "entities": ["people, organizations, products, places, amounts named or shown"]',
    "}",
    'The "i" field MUST equal the label number. No prose, no code fences.',
  ].join("\n");
}
