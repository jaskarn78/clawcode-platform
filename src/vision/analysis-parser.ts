/**
 * Phase 999.154 — tolerant parser for batched vision output.
 *
 * Batching concentrates failure, so every element is validated on its own:
 * a malformed, missing, duplicated or refusal-shaped element nulls THAT image
 * only. Nothing here ever throws.
 */

import { z } from "zod/v4";
import { isVisionRefusal } from "./refusal-sentinel.js";
import {
  IMAGE_IMPORTANCE,
  IMAGE_KINDS,
  type ImageAnalysis,
  type ImageKind,
} from "./types.js";

const MAX_TEXT_ITEMS = 20;
const MAX_ENTITIES = 20;
const MAX_FIELD_CHARS = 600;

const elementSchema = z.object({
  i: z.number().int(),
  type: z.string(),
  summary: z.string().min(1),
  text: z.array(z.string()).optional(),
  is_chart: z.boolean().optional(),
  chart_shape: z.string().nullable().optional(),
  importance: z.string().optional(),
  entities: z.array(z.string()).optional(),
});

function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_FIELD_CHARS ? `${t.slice(0, MAX_FIELD_CHARS)}…` : t;
}

function toKind(raw: string): ImageKind {
  const k = raw.trim().toLowerCase();
  return (IMAGE_KINDS as readonly string[]).includes(k) ? (k as ImageKind) : "other";
}

function toImportance(raw: string | undefined): ImageAnalysis["importance"] {
  const k = (raw ?? "").trim().toLowerCase();
  return (IMAGE_IMPORTANCE as readonly string[]).includes(k)
    ? (k as ImageAnalysis["importance"])
    : "medium";
}

/** Extract the outermost JSON array from model text (fences / prose tolerated). */
export function extractJsonArray(raw: string): unknown[] | null {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseBatchAnalysis(
  raw: string,
  expectedCount: number,
): ReadonlyArray<ImageAnalysis | null> {
  const out: Array<ImageAnalysis | null> = new Array(expectedCount).fill(null);
  if (expectedCount <= 0) return out;
  if (isVisionRefusal(raw) && extractJsonArray(raw) === null) return out;

  const arr = extractJsonArray(raw);
  if (arr === null) return out;

  const seen = new Map<number, number>();
  const candidates = new Map<number, ImageAnalysis>();
  for (const el of arr) {
    const parsed = elementSchema.safeParse(el);
    if (!parsed.success) continue;
    const e = parsed.data;
    if (e.i < 1 || e.i > expectedCount) continue;
    seen.set(e.i, (seen.get(e.i) ?? 0) + 1);
    const summary = clip(e.summary);
    if (isVisionRefusal(summary)) continue;
    const isChart = e.is_chart === true;
    const chartShape =
      isChart && typeof e.chart_shape === "string" && e.chart_shape.trim().length > 0
        ? clip(e.chart_shape)
        : null;
    candidates.set(e.i, {
      kind: toKind(e.type),
      summary,
      text: (e.text ?? []).map(clip).filter((t) => t.length > 0).slice(0, MAX_TEXT_ITEMS),
      isChart,
      chartShape,
      importance: toImportance(e.importance),
      entities: (e.entities ?? [])
        .map(clip)
        .filter((t) => t.length > 0)
        .slice(0, MAX_ENTITIES),
    });
  }
  for (const [i, analysis] of candidates) {
    // A duplicated index means the model lost track of which image is which —
    // neither copy can be trusted.
    if ((seen.get(i) ?? 0) === 1) out[i - 1] = analysis;
  }
  return out;
}
