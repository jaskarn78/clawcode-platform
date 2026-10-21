/**
 * Phase 999.154 — Haiku via the `claude` binary (stream-json envelope).
 *
 * One spawn per chunk of ≤ maxBatch labeled images: measured 2026-09-22, a
 * 9-image labeled batch cost ~$0.004/image vs ~$0.02 for a single-image call
 * (per-spawn CLI overhead dominates), ~20 s wall. Ingest-path only — never
 * wire this into a user turn's time-to-first-token.
 */

import { runHaikuViaBridge } from "../../bridge/haiku-via-bridge.js";
import { parseBatchAnalysis } from "../analysis-parser.js";
import { safeDisplayName } from "../turn-images.js";
import { BATCH_VISION_SYSTEM_PROMPT, buildBatchVisionPrompt } from "../prompts.js";
import type {
  ImageAnalysis,
  LabeledImage,
  VisionCallOptions,
  VisionProvider,
} from "../types.js";

export const DEFAULT_MAX_BATCH = 10;

export class VisionTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionTransportError";
  }
}

export type BridgeHaikuDeps = {
  readonly run?: typeof runHaikuViaBridge;
  readonly maxBatch?: number;
  readonly site?: "ingest-vision" | "vision-canary";
};

export function labelFor(n: number, filename: string): string {
  // Filenames are user-controlled; keep the label a label, not an instruction.
  return `Image ${n} (${safeDisplayName(filename)}):`;
}

export function createBridgeHaikuProvider(deps: BridgeHaikuDeps = {}): VisionProvider {
  const run = deps.run ?? runHaikuViaBridge;
  const maxBatch = Math.max(1, deps.maxBatch ?? DEFAULT_MAX_BATCH);
  const site = deps.site ?? "ingest-vision";

  async function analyzeChunk(
    chunk: ReadonlyArray<LabeledImage>,
    opts: VisionCallOptions,
  ): Promise<ReadonlyArray<ImageAnalysis | null>> {
    const result = await run({
      site,
      systemPrompt: BATCH_VISION_SYSTEM_PROMPT,
      userPrompt: buildBatchVisionPrompt(chunk.length),
      model: "haiku",
      images: chunk.map((img, idx) => ({
        mediaType: img.mediaType,
        data: img.data,
        label: labelFor(idx + 1, img.filename),
      })),
      signal: opts.signal,
    });
    if (!result.succeeded) {
      throw new VisionTransportError("bridge call failed (see phase999.58-haiku-direct log)");
    }
    return parseBatchAnalysis(result.text, chunk.length);
  }

  return {
    id: "bridge-haiku",
    async analyzeBatch(images, opts = {}) {
      const out: Array<ImageAnalysis | null> = [];
      for (let start = 0; start < images.length; start += maxBatch) {
        const chunk = images.slice(start, start + maxBatch);
        out.push(...(await analyzeChunk(chunk, opts)));
      }
      return out;
    },
  };
}
