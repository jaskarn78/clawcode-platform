/**
 * Vision pre-pass pipeline (Phase 113).
 *
 * For each successfully downloaded image attachment, runs in parallel:
 *   1. resizeImageForVision() — local sharp resize to ≤1568px (cuts API cost)
 *   2. callHaikuVision()      — structured extraction via Haiku 4.5 (direct OAuth)
 *
 * Returns Map<localPath, analysisText>. Failures per image are silently
 * dropped — the bridge falls back to the existing file-path hint on miss.
 */

import type { Logger } from "pino";
import type { DownloadResult } from "./attachment-types.js";
import { isImageAttachment } from "./attachments.js";
import { resizeImageForVision } from "./image-resizer.js";
import { callHaikuVision } from "../manager/haiku-direct.js";

const VISION_SYSTEM_PROMPT =
  "You are a visual content analyzer. Respond ONLY with the requested structured analysis. No commentary, no preamble.";

const VISION_USER_PROMPT =
  "Analyze this image concisely. Output exactly these fields:\n" +
  "TYPE: [screenshot|diagram|photo|chart|other]\n" +
  "SUMMARY: [1-2 sentence description of what is shown]\n" +
  "TEXT: [key visible text as a bullet list; truncate after 20 items]\n" +
  "UI_STATE: [notable UI state, errors, or warnings — write 'none' if not applicable]";

export type VisionPrePassConfig = {
  readonly timeoutMs: number;
};

/**
 * P1-EAGERCAP — per-turn cap on EAGER (inline, awaited-before-turn-dispatch)
 * vision analyses. A burst of N images runs vision on at most the first
 * MAX_EAGER_IMAGES; the tail still flows to auto-ingest (never dropped) and
 * `formatDiscordMessage` emits a truthful "deferred" stub for it. Bounds inline
 * TTFT to a finite value (~6-8s) independent of N.
 *
 * Single source of truth — `formatDiscordMessage` (bridge.ts) imports this to
 * decide the deferred-stub boundary, so the slice and the stub stay in sync.
 */
export const MAX_EAGER_IMAGES = 3;

/**
 * Run the vision pre-pass for all successfully downloaded image attachments.
 *
 * Fires all images in parallel. Each image: resize → Haiku vision call.
 * Individual failures are logged as warnings and excluded from the result map.
 * Never throws — callers get an empty Map on total failure.
 */
export async function runVisionPrePass(
  results: readonly DownloadResult[],
  config: VisionPrePassConfig,
  log: Logger,
): Promise<Map<string, string>> {
  const imageResults = results.filter(
    (r): r is DownloadResult & { path: string } =>
      r.success && r.path !== null && isImageAttachment(r.attachmentInfo.contentType),
  );

  if (imageResults.length === 0) return new Map();

  // P1-EAGERCAP — only the first MAX_EAGER_IMAGES are analyzed eagerly. The
  // governor (inside resizeImageForVision) still caps concurrent decodes at 2;
  // this caps the COUNT of eager Haiku calls per turn so a 12- or 100-image
  // burst cannot serialize the hot path into a multi-minute stall.
  const eager = imageResults.slice(0, MAX_EAGER_IMAGES);

  const entries = await Promise.all(
    eager.map(async (r) => {
      const path = r.path;
      const t0 = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const buffer = await resizeImageForVision(path);
        const analysis = await callHaikuVision(
          VISION_SYSTEM_PROMPT,
          VISION_USER_PROMPT,
          buffer,
          "image/png",  // resizeImageForVision always outputs PNG regardless of input format
          { signal: controller.signal },
        );
        if (!analysis) return null;
        log.info(
          { path, latencyMs: Date.now() - t0, chars: analysis.length },
          "vision_pre_pass_ok",
        );
        return [path, analysis] as const;
      } catch (err) {
        log.warn(
          { path, err: (err as Error).message, latencyMs: Date.now() - t0 },
          "vision_pre_pass_failed",
        );
        return null;
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  return new Map(
    entries.filter((e): e is [string, string] => e !== null),
  );
}
