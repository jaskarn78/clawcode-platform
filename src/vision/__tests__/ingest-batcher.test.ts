import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { mkdtempSync, utimesSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { IngestVisionBatcher } from "../ingest-batcher.js";
import { VisionService } from "../service.js";
import { createOcrOnlyProvider } from "../providers/ocr-only.js";
import { dHashHex, hammingHex, sha256Hex } from "../image-hash.js";
import { archiveImage, sweepImageArchive } from "../image-archive.js";
import { AutoIngestQueue, inferMimeType } from "../../manager/auto-ingest-queue.js";
import { DocumentStore, migrateAddImageIngestColumns } from "../../documents/store.js";
import { classifyAttachment } from "../../documents/auto-ingest-classifier.js";
import type { AutoIngestAttachmentParams } from "../../manager/auto-ingest-handler.js";
import type { ImageAnalysis, LabeledImage, VisionProvider } from "../types.js";

const log = pino({ level: "silent" });

const item = (n: number, over: Partial<AutoIngestAttachmentParams> = {}): AutoIngestAttachmentParams => ({
  agent: "a",
  file_path: `/inbox/${n}.png`,
  filename: `${n}.png`,
  mime_type: "image/png",
  size: 1,
  vision_analysis: null,
  channel_id: "c",
  message_id: "m1",
  user_id: "u",
  user_name: "n",
  ...over,
});

const analysis = (summary: string): ImageAnalysis => ({
  kind: "photo",
  summary,
  text: [],
  isChart: false,
  chartShape: null,
  importance: "medium",
  entities: [],
});

function serviceWith(impl: VisionProvider["analyzeBatch"]) {
  const provider: VisionProvider = { id: "bridge-haiku", analyzeBatch: vi.fn(impl) };
  return {
    provider,
    service: new VisionService({ providers: [provider, createOcrOnlyProvider()], log }),
  };
}

const prepare = async (p: AutoIngestAttachmentParams): Promise<LabeledImage | null> =>
  p.filename.startsWith("bad")
    ? null
    : { id: p.file_path, filename: p.filename, mediaType: "image/jpeg", data: "AA" };

describe("IngestVisionBatcher", () => {
  it("analyzes the burst in ONE call and serves siblings from cache", async () => {
    const { provider, service } = serviceWith(async (ims) => ims.map((im) => analysis(im.filename)));
    const queued = [item(2), item(3), item(4, { message_id: "other" }), item(5, { mime_type: "application/pdf" })];
    const batcher = new IngestVisionBatcher({
      getService: () => service,
      peekQueued: (pred, limit) => queued.filter(pred).slice(0, limit),
      batchSize: 10,
      log,
      prepare,
    });
    expect((await batcher.analyze(item(1)))?.summary).toBe("1.png");
    expect(provider.analyzeBatch).toHaveBeenCalledTimes(1);
    const sent = (provider.analyzeBatch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LabeledImage[];
    expect(sent.map((s) => s.filename)).toEqual(["1.png", "2.png", "3.png"]);
    // Siblings come from cache — no further calls.
    expect((await batcher.analyze(item(2)))?.summary).toBe("2.png");
    expect((await batcher.analyze(item(3)))?.summary).toBe("3.png");
    expect(provider.analyzeBatch).toHaveBeenCalledTimes(1);
  });

  it("respects batchSize and excludes undecodable images from the call", async () => {
    const { provider, service } = serviceWith(async (ims) => ims.map((im) => analysis(im.filename)));
    const queued = [item(2, { filename: "bad2.png" }), item(3), item(4)];
    const batcher = new IngestVisionBatcher({
      getService: () => service,
      peekQueued: (pred, limit) => queued.filter(pred).slice(0, limit),
      batchSize: 3,
      log,
      prepare,
    });
    await batcher.analyze(item(1));
    const sent = (provider.analyzeBatch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LabeledImage[];
    expect(sent.map((s) => s.filename)).toEqual(["1.png", "3.png"]);
    expect(await batcher.analyze(item(2, { filename: "bad2.png" }))).toBeNull();
  });

  it("releases the drain's decode slot only around the network call (review fix)", async () => {
    const order: string[] = [];
    const { service } = serviceWith(async (ims) => {
      order.push("analyze");
      return ims.map((im) => analysis(im.filename));
    });
    const batcher = new IngestVisionBatcher({
      getService: () => service,
      peekQueued: () => [],
      batchSize: 10,
      log,
      prepare: async (p) => {
        order.push("prepare");
        return prepare(p);
      },
      releaseSlotDuring: async (fn) => {
        order.push("release");
        try {
          return await fn();
        } finally {
          order.push("reacquire");
        }
      },
    });
    await batcher.analyze(item(1));
    expect(order).toEqual(["prepare", "release", "analyze", "reacquire"]);
  });

  it("returns null when no service is configured", async () => {
    const batcher = new IngestVisionBatcher({
      getService: () => null,
      peekQueued: () => [],
      batchSize: 10,
      log,
      prepare,
    });
    expect(await batcher.analyze(item(1))).toBeNull();
  });
});

describe("image hashing (real decode)", () => {
  async function png(draw: "left" | "right" | "left-noisy"): Promise<Buffer> {
    const w = 64;
    const h = 48;
    const px = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = draw === "right" ? (x / w) * 255 : 255 - (x / w) * 255;
        if (draw === "left-noisy" && (x + y) % 7 === 0) v = Math.min(255, v + 6);
        px.fill(Math.round(v), (y * w + x) * 3, (y * w + x) * 3 + 3);
      }
    }
    return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  }

  it("near-identical images are within the threshold; different ones are far", async () => {
    const a = (await dHashHex(await png("left")))!;
    const a2 = (await dHashHex(await png("left-noisy")))!;
    const b = (await dHashHex(await png("right")))!;
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hammingHex(a, a2)).toBeLessThanOrEqual(6);
    expect(hammingHex(a, b)).toBeGreaterThan(20);
  });

  it("undecodable bytes hash to null; sha256 is deterministic", async () => {
    expect(await dHashHex(Buffer.from("not an image"))).toBeNull();
    expect(sha256Hex(Buffer.from("x"))).toBe(sha256Hex(Buffer.from("x")));
  });
});

describe("image archive", () => {
  it("writes a WebP copy and the sweep removes only expired files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "img-archive-"));
    const src = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#123456" } })
      .jpeg()
      .toBuffer();
    const out = (await archiveImage(src, "/inbox/1790-IMG_1256.jpg", join(dir, "arch"), 1568))!;
    expect(statSync(join(dir, "arch")).mode & 0o777).toBe(0o700);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(out).toBe(join(dir, "arch", "1790-IMG_1256.webp"));
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width!, meta.height!)).toBe(1568);

    const old = join(dir, "arch", "old.webp");
    writeFileSync(old, "x");
    const longAgo = (Date.now() - 100 * 86_400_000) / 1000;
    utimesSync(old, longAgo, longAgo);
    expect(await sweepImageArchive(join(dir, "arch"), 90)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(out)).toBe(true);
  });

  it("returns null for undecodable input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "img-archive-"));
    expect(await archiveImage(Buffer.from("nope"), "/inbox/x.png", dir, 1568)).toBeNull();
  });
});

describe("queue helpers", () => {
  it("peekQueued returns matching queued items in order without dequeuing", () => {
    const q = new AutoIngestQueue();
    q.enqueue(item(1));
    q.enqueue(item(2, { message_id: "m2" }));
    q.enqueue(item(3));
    expect(q.peekQueued((p) => p.message_id === "m1", 10).map((p) => p.filename)).toEqual([
      "1.png",
      "3.png",
    ]);
    expect(q.depth).toBe(3);
  });

  it("inferMimeType recovers image mimes for rescanned files", () => {
    expect(inferMimeType("IMG_1256.JPG")).toBe("image/jpeg");
    expect(inferMimeType("shot.webp")).toBe("image/webp");
    expect(inferMimeType("notes.pdf")).toBeNull();
    expect(inferMimeType("noext")).toBeNull();
  });
});

describe("documents migration + dedupe lookups", () => {
  it("adds the columns idempotently and sha lookup ignores duplicate rows", () => {
    const db = new Database(":memory:");
    sqliteVec.load(db);
    const store = new DocumentStore(db);
    expect(migrateAddImageIngestColumns(db)).toEqual([]);
    const base = {
      agentName: "a",
      ingestedAt: "2026-09-22T00:00:00.000Z",
      sourceKind: "discord_attachment" as const,
      autoClassifiedClass: "medium" as const,
      contentWeight: 1,
      agentWeightAtIngest: 1,
    };
    store.upsertDocumentRow({ ...base, source: "/dup", contentSha256: "s1", duplicateOf: "/orig" });
    expect(store.findDocumentBySha256("s1")).toBeNull();
    store.upsertDocumentRow({ ...base, source: "/orig", contentSha256: "s1", imageDhash: "00ff", visionJson: "{}" });
    expect(store.findDocumentBySha256("s1")!.source).toBe("/orig");
    expect(store.listRecentImageHashes("2026-09-01T00:00:00.000Z", 10).map((r) => r.source)).toEqual(["/orig"]);
  });
});

describe("classifier — structured importance", () => {
  it("vision importance decides the image class ahead of keyword rungs", () => {
    const out = classifyAttachment({
      filename: "image.png",
      mimeType: "image/png",
      size: 1000,
      visionAnalysis: "SUMMARY: login form",
      visionImportance: "high",
      visionKind: "screenshot",
    });
    expect(out).toMatchObject({ contentClass: "high", reason: "image + vision importance (high, screenshot)" });
  });
});
