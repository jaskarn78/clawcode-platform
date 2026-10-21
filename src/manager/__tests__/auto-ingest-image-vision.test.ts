/**
 * Phase 999.154 WS-3/WS-4 — image ingest: structured batched vision, exact +
 * near-duplicate dedupe, durable archive path, and refusal-proof classification.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { handleAutoIngestAttachment } from "../auto-ingest-handler.js";
import type {
  AutoIngestAttachmentParams,
  AutoIngestHandlerDeps,
} from "../auto-ingest-handler.js";
import { DocumentStore } from "../../documents/store.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { ingest as IngestEngineFn } from "../../document-ingest/index.js";
import type { MemoryStore } from "../../memory/store.js";
import type { ImageAnalysis } from "../../vision/types.js";

function freshDb(): DatabaseType {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  return db;
}

function captureLogger() {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const log = pino({ level: "debug" }, sink);
  const records = () =>
    chunks
      .join("")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { log, records };
}

const agentConfig = {
  name: "client-a-personal",
  memoryPath: "/tmp/client-a-personal-mem",
  autoIngestAttachments: true,
  ingestionPriority: "medium",
} as unknown as ResolvedAgentConfig;

const CHAIN: ImageAnalysis = {
  kind: "photo",
  summary: "Close-up of a road bike chain on a Canyon frame; rim reads PERFORMANCE LN",
  text: ["PERFORMANCE LN"],
  isChart: false,
  chartShape: null,
  importance: "low",
  entities: ["Canyon"],
};

const CHART: ImageAnalysis = {
  kind: "chart",
  summary: "AAPL daily candles",
  text: ["AAPL"],
  isChart: true,
  chartShape: "rising from 180 to 231, peak mid-August",
  importance: "high",
  entities: ["Apple"],
};

type Harness = {
  deps: AutoIngestHandlerDeps;
  docStore: DocumentStore;
  embedded: string[][];
  engineCalls: { n: number };
  analyzeImage: ReturnType<typeof vi.fn>;
};

function harness(opts: {
  db: DatabaseType;
  log: pino.Logger;
  analysis?: ImageAnalysis | null | Error;
  engineText?: string;
  bytesFor?: (path: string) => string;
  dhashFor?: (bytes: string) => string | null;
  archive?: boolean;
}): Harness {
  const docStore = new DocumentStore(opts.db);
  const embedded: string[][] = [];
  const engineCalls = { n: 0 };
  const engine = (async () => {
    engineCalls.n++;
    return {
      text: opts.engineText ?? "",
      pages: [],
      telemetry: {} as never,
    };
  }) as unknown as typeof IngestEngineFn;
  const analyzeImage = vi.fn(async () => {
    if (opts.analysis instanceof Error) throw opts.analysis;
    return opts.analysis ?? null;
  });
  const deps: AutoIngestHandlerDeps = {
    getDocumentStore: () => docStore,
    getMemoryStore: () => undefined as unknown as MemoryStore,
    embedBoth: async (texts) => {
      embedded.push([...texts]);
      return { v2: texts.map(() => new Int8Array(384)), v1: null };
    },
    getAgentConfig: () => agentConfig,
    logger: opts.log,
    engine,
    readFileFn: async (p) => Buffer.from(opts.bytesFor ? opts.bytesFor(p) : `bytes:${p}`),
    nowIso: () => "2026-09-22T20:00:00.000Z",
    analyzeImage,
    imageIngest: {
      dedupe: { exact: true, nearDupHamming: 6 },
      archive: { enabled: opts.archive ?? true, sidePx: 1568, ttlDays: 90 },
    },
    imageTools: {
      sha256: (buf) => `sha:${buf.toString()}`,
      dhash: async (buf) => (opts.dhashFor ? opts.dhashFor(buf.toString()) : null),
      archive: async (_buf, src, dir) => `${dir}/${src.split("/").pop()}.webp`,
    },
  };
  return { deps, docStore, embedded, engineCalls, analyzeImage };
}

function params(over: Partial<AutoIngestAttachmentParams> = {}): AutoIngestAttachmentParams {
  return {
    agent: "client-a-personal",
    file_path: "/tmp/client-a-personal-mem/inbox/attachments/1790-IMG_1256.jpg",
    filename: "IMG_1256.jpg",
    mime_type: "image/jpeg",
    size: 2_400_000,
    vision_analysis: null,
    channel_id: "ch",
    message_id: "m1",
    user_id: "u",
    user_name: "clientAhin",
    ...over,
  };
}

let db: DatabaseType;
beforeEach(() => {
  db = freshDb();
});

describe("image ingest — structured vision", () => {
  it("a text-free photo becomes retrievable by what it shows (summary chunk)", async () => {
    const { log } = captureLogger();
    const h = harness({ db, log, analysis: CHAIN, engineText: "" });
    const r = await handleAutoIngestAttachment(params(), h.deps);
    expect(r).toMatchObject({ ok: true, skipped: false });
    const text = h.embedded.flat().join("\n");
    expect(text).toContain("## Image summary");
    expect(text).toContain("PERFORMANCE LN");
    const row = h.docStore.getDocumentRow(params().file_path)!;
    expect(JSON.parse(row.vision_json!)).toEqual(CHAIN);
    expect(row.auto_classified_class).toBe("low");
  });

  it("chart shape comes from the same batched analysis — no second vision call", async () => {
    const { log, records } = captureLogger();
    const h = harness({ db, log, analysis: CHART, engineText: "AAPL 180 200 231" });
    await handleAutoIngestAttachment(params({ filename: "aapl.png", mime_type: "image/png" }), h.deps);
    expect(h.analyzeImage).toHaveBeenCalledTimes(1);
    const text = h.embedded.flat().join("\n");
    expect(text).toContain("## Chart shape analysis");
    expect(text).toContain("rising from 180 to 231");
    const done = records().find((x) => x.msg === "phase999.43-autoingest dispatched")!;
    expect(done).toMatchObject({ visionSource: "batch", isChart: true, reason: "image + vision importance (high, chart)" });
  });

  it("no analysis ⇒ OCR only, and a legacy refusal pre-pass cannot steer the class", async () => {
    const { log, records } = captureLogger();
    const h = harness({ db, log, analysis: null, engineText: "Dear Tara, dues" });
    await handleAutoIngestAttachment(
      params({
        vision_analysis:
          "I don't see an image attached to your message. Please provide the image file path, and I'll return the analysis in the format you requested.",
      }),
      h.deps,
    );
    const text = h.embedded.flat().join("\n");
    expect(text).not.toMatch(/don't see an image/);
    expect(text).not.toContain("## Image summary");
    const done = records().find((x) => x.msg === "phase999.43-autoingest dispatched")!;
    expect(done.visionSource).toBe("none");
    expect(String(done.reason)).not.toMatch(/matched: (return|form)/);
  });

  it("a vision failure is non-fatal", async () => {
    const { log } = captureLogger();
    const h = harness({ db, log, analysis: new Error("bridge down"), engineText: "text" });
    const r = await handleAutoIngestAttachment(params(), h.deps);
    expect(r).toMatchObject({ ok: true, skipped: false });
  });
});

describe("image ingest — dedupe", () => {
  it("an exact re-send is skipped before OCR/vision and recorded as a duplicate", async () => {
    const { log } = captureLogger();
    const h = harness({ db, log, analysis: CHAIN, engineText: "", bytesFor: () => "same-bytes" });
    await handleAutoIngestAttachment(params(), h.deps);
    const second = params({
      file_path: "/tmp/client-a-personal-mem/inbox/attachments/1791-IMG_1256.jpg",
      message_id: "m2",
    });
    const r = await handleAutoIngestAttachment(second, h.deps);
    expect(r).toMatchObject({ ok: true, skipped: true });
    expect(h.engineCalls.n).toBe(1);
    expect(h.analyzeImage).toHaveBeenCalledTimes(1);
    const dupRow = h.docStore.getDocumentRow(second.file_path)!;
    expect(dupRow.duplicate_of).toBe(params().file_path);
    // The original is still what a sha lookup returns.
    expect(h.docStore.findDocumentBySha256("sha:same-bytes")!.source).toBe(params().file_path);
  });

  it("a near-duplicate reuses the prior analysis instead of paying for another call", async () => {
    const { log, records } = captureLogger();
    const h = harness({
      db,
      log,
      analysis: CHAIN,
      engineText: "",
      dhashFor: (bytes) => (bytes.includes("1790") ? "ffffffffffffffff" : "fffffffffffffffc"),
    });
    await handleAutoIngestAttachment(params(), h.deps);
    const recompressed = params({
      file_path: "/tmp/client-a-personal-mem/inbox/attachments/1792-IMG_1256-fwd.jpg",
    });
    await handleAutoIngestAttachment(recompressed, h.deps);
    expect(h.analyzeImage).toHaveBeenCalledTimes(1);
    const done = records().filter((x) => x.msg === "phase999.43-autoingest dispatched");
    expect(done[1]).toMatchObject({ visionSource: "near-dup", nearDupOf: params().file_path });
  });
});

describe("image ingest — archive", () => {
  it("retrieval points at the durable archive copy", async () => {
    const { log } = captureLogger();
    const h = harness({ db, log, analysis: CHAIN, engineText: "" });
    await handleAutoIngestAttachment(params(), h.deps);
    expect(h.docStore.getDocumentRow(params().file_path)!.source_image_path).toBe(
      "/tmp/client-a-personal-mem/attachments-archive/1790-IMG_1256.jpg.webp",
    );
  });

  it("no memoryPath ⇒ no archive (never a shared /tmp fallback)", async () => {
    const { log } = captureLogger();
    const h = harness({ db, log, analysis: CHAIN, engineText: "" });
    const noMem = { ...agentConfig, memoryPath: undefined } as unknown as typeof agentConfig;
    const deps = { ...h.deps, getAgentConfig: () => noMem };
    await handleAutoIngestAttachment(params(), deps);
    expect(h.docStore.getDocumentRow(params().file_path)!.source_image_path).toBe(params().file_path);
  });

  it("archive disabled ⇒ inbox path, as before", async () => {
    const { log } = captureLogger();
    const h = harness({ db, log, analysis: CHAIN, engineText: "", archive: false });
    await handleAutoIngestAttachment(params(), h.deps);
    expect(h.docStore.getDocumentRow(params().file_path)!.source_image_path).toBe(params().file_path);
  });
});

describe("transcript ingest (999.156)", () => {
  it("ingests a transcript even when the agent's attachment auto-ingest is off, as HIGH / source_kind transcript", async () => {
    const { log } = captureLogger();
    const h = harness({ db, log, engineText: "SPEAKER_00: packet due Friday" });
    const off = { ...agentConfig, autoIngestAttachments: false } as unknown as typeof agentConfig;
    const deps = { ...h.deps, getAgentConfig: () => off };
    const r = await handleAutoIngestAttachment(
      params({
        file_path: "/mem/transcripts/1790095686604-Daily_92226-transcript_speakers.txt",
        filename: "1790095686604-Daily_92226-transcript_speakers.txt",
        mime_type: "text/plain",
        origin: "transcript",
      }),
      deps,
    );
    expect(r).toMatchObject({ ok: true, skipped: false, content_class: "high" });
    const row = h.docStore.getDocumentRow("/mem/transcripts/1790095686604-Daily_92226-transcript_speakers.txt")!;
    expect(row.source_kind).toBe("transcript");
    expect(h.analyzeImage).not.toHaveBeenCalled();
  });

  it("a normal attachment on a flag-off agent is still skipped", async () => {
    const { log } = captureLogger();
    const h = harness({ db, log, engineText: "x" });
    const off = { ...agentConfig, autoIngestAttachments: false } as unknown as typeof agentConfig;
    const r = await handleAutoIngestAttachment(params(), { ...h.deps, getAgentConfig: () => off });
    expect(r).toMatchObject({ ok: true, skipped: true });
  });
});
