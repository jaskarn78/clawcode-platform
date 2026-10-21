/**
 * Phase 999.154 WS-3 — one vision call per upload burst, not per image.
 *
 * The auto-ingest queue drains one attachment at a time (serial, governor-
 * bounded — unchanged). When the drain reaches the first image of a Discord
 * message, the batcher peeks at the still-queued images from the SAME message
 * (rescan-recovered files: same agent, no message id), analyzes them together
 * in one labeled call, and caches the siblings' results for when the drain
 * reaches them. Nothing is dequeued early, so never-drop and ordering hold.
 */

import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import sharp from "sharp";
import { MAX_INPUT_PIXELS } from "../manager/image-work-governor.js";
import type { AutoIngestAttachmentParams } from "../manager/auto-ingest-handler.js";
import type { VisionService } from "./service.js";
import type { ImageAnalysis, LabeledImage } from "./types.js";

/** Long side for ingest analysis — screenshots stay legible, ~1.6k tokens max. */
export const INGEST_VISION_SIDE_PX = 1280;
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MAX = 500;

export function isImageParams(p: AutoIngestAttachmentParams): boolean {
  return typeof p.mime_type === "string" && p.mime_type.toLowerCase().startsWith("image/");
}

/**
 * Same burst ⇔ same agent + same Discord message. Rescan-recovered files all
 * carry message_id "" and so batch together across uploads — deliberate: a
 * queue-overflow recovery can be hundreds of files, and one spawn per file
 * would multiply CLI overhead ~4×. Each image keeps its own `Image n` label
 * and is analyzed on its own; the parser rejects any misaligned element.
 */
export function sameBurst(a: AutoIngestAttachmentParams, b: AutoIngestAttachmentParams): boolean {
  return a.agent === b.agent && a.message_id === b.message_id;
}

export type IngestVisionBatcherDeps = {
  readonly getService: () => VisionService | null;
  /** Read-only snapshot of queued items matching `pred` (queue order). */
  readonly peekQueued: (
    pred: (p: AutoIngestAttachmentParams) => boolean,
    limit: number,
  ) => readonly AutoIngestAttachmentParams[];
  readonly batchSize: number;
  readonly log: Logger;
  /**
   * Wrap the network call so the drain's held decode slot is released while
   * waiting (daemon: withImageWorkSlotReleased). Default: run as-is.
   */
  readonly releaseSlotDuring?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Test seam: load + resize one image. Null ⇒ undecodable, excluded from the call. */
  readonly prepare?: (p: AutoIngestAttachmentParams) => Promise<LabeledImage | null>;
  readonly now?: () => number;
};

async function defaultPrepare(p: AutoIngestAttachmentParams): Promise<LabeledImage | null> {
  try {
    const raw = await readFile(p.file_path);
    const out = await sharp(raw, { limitInputPixels: MAX_INPUT_PIXELS })
      .timeout({ seconds: 15 })
      .rotate()
      .resize(INGEST_VISION_SIDE_PX, INGEST_VISION_SIDE_PX, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();
    return {
      id: p.file_path,
      filename: p.filename,
      mediaType: "image/jpeg",
      data: out.toString("base64"),
    };
  } catch {
    return null;
  }
}

type CacheEntry = { readonly analysis: ImageAnalysis | null; readonly at: number };

export class IngestVisionBatcher {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly prepare: (p: AutoIngestAttachmentParams) => Promise<LabeledImage | null>;
  private readonly now: () => number;

  constructor(private readonly deps: IngestVisionBatcherDeps) {
    this.prepare = deps.prepare ?? defaultPrepare;
    this.now = deps.now ?? Date.now;
  }

  /** Analysis for `item` — from a sibling's batch when cached, else a new batch. */
  async analyze(item: AutoIngestAttachmentParams): Promise<ImageAnalysis | null> {
    this.evict();
    const cached = this.cache.get(item.file_path);
    if (cached !== undefined) {
      this.cache.delete(item.file_path);
      return cached.analysis;
    }
    const service = this.deps.getService();
    if (service === null) return null;

    const peers = this.deps.peekQueued(
      (p) =>
        p.file_path !== item.file_path &&
        isImageParams(p) &&
        sameBurst(p, item) &&
        !this.cache.has(p.file_path),
      Math.max(0, this.deps.batchSize - 1),
    );
    const members = [item, ...peers];
    const prepared = await Promise.all(members.map((m) => this.prepare(m)));
    const callable = prepared.filter((x): x is LabeledImage => x !== null);

    const byPath = new Map<string, ImageAnalysis | null>();
    if (callable.length > 0) {
      const releaseDuring = this.deps.releaseSlotDuring ?? ((fn) => fn());
      const { results, providerId } = await releaseDuring(() => service.analyzeBatch(callable));
      callable.forEach((img, i) => byPath.set(img.id, results[i] ?? null));
      this.deps.log.info(
        {
          tag: "phase999.154-ingest-vision",
          agent: item.agent,
          messageId: item.message_id,
          batch: members.length,
          sent: callable.length,
          analyzed: results.filter((r) => r !== null).length,
          provider: providerId,
        },
        "ingest vision batch",
      );
    }
    const at = this.now();
    for (const peer of peers) {
      this.cache.set(peer.file_path, { analysis: byPath.get(peer.file_path) ?? null, at });
    }
    return byPath.get(item.file_path) ?? null;
  }

  private evict(): void {
    const cutoff = this.now() - CACHE_TTL_MS;
    for (const [k, v] of this.cache) {
      if (v.at < cutoff) this.cache.delete(k);
    }
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
