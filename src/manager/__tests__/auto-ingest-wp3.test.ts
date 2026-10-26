/**
 * WP3 (2026-10-25): auto-ingest handler.
 *   - contextual header on every document chunk;
 *   - memory mirror re-chunked to about 300 words, heading = filename;
 *   - empty extraction stores a stub (never raw bytes), marks the row
 *     "empty" and counts attempts; failures are recorded the same way;
 *   - a rescan-recovered retry keeps the first attempt's provenance;
 *   - an exact re-send of a stub original is processed, not deduped.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import pino from "pino";
import { MemoryStore } from "../../memory/store.js";
import { DocumentStore, documentNeedsRetry, MAX_INGEST_ATTEMPTS } from "../../documents/store.js";
import { stripChunkHeader } from "../../documents/chunk-context.js";
import { computeDocSlug } from "../../document-ingest/index.js";
import type { ingest as IngestEngineFn } from "../../document-ingest/index.js";
import {
  handleAutoIngestAttachment,
  type AutoIngestAttachmentParams,
  type AutoIngestHandlerDeps,
} from "../auto-ingest-handler.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { ImageAnalysis } from "../../vision/types.js";

const log = pino({ level: "silent" });

const agentConfig = {
  name: "fin",
  workspace: "/tmp/fin",
  memoryPath: undefined,
  autoIngestAttachments: true,
  ingestionPriority: "medium",
} as unknown as ResolvedAgentConfig;

function words(n: number, prefix = "w"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
}

type Harness = {
  deps: AutoIngestHandlerDeps;
  docs: DocumentStore;
  embedCalls: Array<{ texts: string[]; includeV1: boolean }>;
  engineCalls: { n: number };
};

let memory: MemoryStore;

function harness(opts: {
  engineText?: string | (() => string);
  pageTexts?: string[];
  engineThrows?: boolean;
  analysis?: ImageAnalysis | null;
  withMemory?: boolean;
  bytes?: string;
}): Harness {
  const docs = new DocumentStore(memory.getDatabase());
  const embedCalls: Harness["embedCalls"] = [];
  const engineCalls = { n: 0 };
  const engine = (async () => {
    engineCalls.n++;
    if (opts.engineThrows) throw new Error("engine exploded");
    const text = typeof opts.engineText === "function" ? opts.engineText() : (opts.engineText ?? "");
    return { text, pages: [], pageTexts: opts.pageTexts ?? [text], telemetry: {} as never };
  }) as unknown as typeof IngestEngineFn;
  const deps: AutoIngestHandlerDeps = {
    getDocumentStore: () => docs,
    getMemoryStore: () => (opts.withMemory === false ? undefined : memory),
    embedBoth: async (texts, includeV1) => {
      embedCalls.push({ texts: [...texts], includeV1 });
      return {
        v2: texts.map(() => new Int8Array(384).fill(1)),
        v1: includeV1 ? texts.map(() => new Float32Array(384).fill(0.01)) : null,
      };
    },
    getAgentConfig: () => agentConfig,
    logger: log,
    engine,
    readFileFn: async () => Buffer.from(opts.bytes ?? "\u0089PNG\r\n\u001a\n\u0000\u0000IHDR binary"),
    nowIso: () => "2026-10-25T10:00:00.000Z",
    analyzeImage: async () => opts.analysis ?? null,
    imageIngest: {
      dedupe: { exact: true, nearDupHamming: 0 },
      archive: { enabled: false, sidePx: 1568, ttlDays: 90 },
    },
    imageTools: {
      sha256: (buf) => `sha:${buf.toString("latin1")}`,
      dhash: async () => null,
      archive: async () => null,
    },
  };
  return { deps, docs, embedCalls, engineCalls };
}

function params(over: Partial<AutoIngestAttachmentParams> = {}): AutoIngestAttachmentParams {
  return {
    agent: "fin",
    file_path: "/mem/inbox/attachments/1790000000000-statement.pdf",
    filename: "statement.pdf",
    mime_type: "application/pdf",
    size: 250_000,
    vision_analysis: null,
    channel_id: "c1",
    message_id: "m1",
    user_id: "u1",
    user_name: "jas",
    channel_name: "finance",
    ...over,
  };
}

function mirror(source: string): Array<{ heading: string | null; body: string }> {
  return memory
    .getDatabase()
    .prepare("SELECT heading, body FROM memory_chunks WHERE path = ? ORDER BY chunk_index")
    .all(`document:${computeDocSlug(source)}`) as Array<{ heading: string | null; body: string }>;
}

beforeEach(() => {
  memory = new MemoryStore(":memory:");
});
afterEach(() => memory.close());

describe("contextual headers and the memory mirror", () => {
  it("writes the header into every document chunk and re-chunks the mirror to about 300 words", async () => {
    const pageTexts = [words(600, "a"), words(400, "b")];
    const h = harness({ engineText: pageTexts.join("\n\n"), pageTexts });
    const r = await handleAutoIngestAttachment(params(), h.deps);
    expect(r).toMatchObject({ ok: true, skipped: false });

    const chunks = h.docs.getChunksForSource(params().file_path);
    expect(chunks).toHaveLength(3); // 1000 words at 375 with 38 overlap
    expect(chunks[0].content.split("\n")[0]).toBe(
      "Document: statement.pdf | uploaded 2026-10-25 | from jas in #finance | page 1 | part 1/3",
    );
    // Chunk 3 starts at word 674, which is on page 2.
    expect(chunks[2].content.split("\n")[0]).toContain("| page 2 | part 3/3");

    const rows = mirror(params().file_path);
    expect(rows).toHaveLength(4); // 1000 words at 300 with 30 overlap
    expect(rows.every((x) => x.heading === "statement.pdf")).toBe(true);
    for (const x of rows) {
      expect(x.body.startsWith("Document: statement.pdf | uploaded 2026-10-25")).toBe(true);
      expect(stripChunkHeader(x.body).split(" ").length).toBeLessThanOrEqual(300);
    }

    // Document chunks embed v2 only; the mirror gets its own v1 + v2 call.
    expect(h.embedCalls.map((c) => [c.texts.length, c.includeV1])).toEqual([
      [3, false],
      [4, true],
    ]);

    const row = h.docs.getDocumentRow(params().file_path)!;
    expect(row).toMatchObject({
      filename: "statement.pdf",
      user_name: "jas",
      channel_name: "finance",
      ingest_status: "ok",
      ingest_attempts: 1,
    });
  });

  it("omits the channel when the bridge did not send one", async () => {
    const h = harness({ engineText: "short text" });
    await handleAutoIngestAttachment(params({ channel_name: undefined }), h.deps);
    const [c] = h.docs.getChunksForSource(params().file_path);
    expect(c.content).toBe(
      "Document: statement.pdf | uploaded 2026-10-25 | from jas | part 1/1\nshort text",
    );
  });
});

describe("empty extraction", () => {
  const image = params({
    file_path: "/mem/inbox/attachments/1790000000001-logo.png",
    filename: "logo.png",
    mime_type: "image/png",
    size: 40_000,
  });

  it("stores a one-line stub instead of the raw bytes and does not mirror it", async () => {
    const h = harness({ engineText: "", analysis: null });
    const r = await handleAutoIngestAttachment(image, h.deps);
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ skipped: true });
    expect((r as { reason: string }).reason).toMatch(/stub.*attempt 1 of 3/);

    const chunks = h.docs.getChunksForSource(image.file_path);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(
      "Document: logo.png | uploaded 2026-10-25 | from jas in #finance | part 1/1\n" +
        "Image logo.png uploaded 2026-10-25; no text could be extracted",
    );
    expect(chunks[0].content).not.toMatch(/PNG|IHDR/);
    expect(mirror(image.file_path)).toEqual([]);
    const row = h.docs.getDocumentRow(image.file_path)!;
    expect(row).toMatchObject({ ingest_status: "empty", ingest_attempts: 1 });
    expect(documentNeedsRetry(row)).toBe(true);
  });

  it("is retried at most MAX_INGEST_ATTEMPTS times, keeping the first attempt's provenance", async () => {
    const h = harness({ engineText: "", analysis: null });
    await handleAutoIngestAttachment(image, h.deps);
    // Rescan-recovered retries carry empty Discord sentinels.
    const recovered = {
      ...image,
      channel_id: "",
      message_id: "",
      user_id: "",
      user_name: "",
      channel_name: undefined,
    };
    await handleAutoIngestAttachment(recovered, h.deps);
    await handleAutoIngestAttachment(recovered, h.deps);
    const row = h.docs.getDocumentRow(image.file_path)!;
    expect(row).toMatchObject({
      ingest_status: "empty",
      ingest_attempts: MAX_INGEST_ATTEMPTS,
      channel_id: "c1",
      message_id: "m1",
      user_id: "u1",
      user_name: "jas",
      channel_name: "finance",
      ingested_at: "2026-10-25T10:00:00.000Z",
    });
    expect(documentNeedsRetry(row)).toBe(false);
    expect(h.docs.getChunksForSource(image.file_path)[0].content).toContain("from jas in #finance");
  });

  it("a later successful retry replaces the stub and mirrors the text", async () => {
    let text = "";
    const h = harness({ engineText: () => text, analysis: null });
    await handleAutoIngestAttachment(image, h.deps);
    text = "ACME Corp logo with tagline";
    const r = await handleAutoIngestAttachment(image, h.deps);
    expect(r).toMatchObject({ ok: true, skipped: false });
    expect(h.docs.getDocumentRow(image.file_path)).toMatchObject({ ingest_status: "ok", ingest_attempts: 2 });
    expect(h.docs.getChunksForSource(image.file_path)[0].content).toContain("ACME Corp logo");
    expect(mirror(image.file_path)).toHaveLength(1);
  });

  it("an exact re-send of a stub original is processed instead of recorded as a duplicate", async () => {
    const h = harness({ engineText: "", analysis: null, bytes: "same" });
    await handleAutoIngestAttachment(image, h.deps);
    const resend = { ...image, file_path: "/mem/inbox/attachments/1790000000002-logo.png", message_id: "m2" };
    await handleAutoIngestAttachment(resend, h.deps);
    expect(h.engineCalls.n).toBe(2);
    expect(h.docs.getDocumentRow(resend.file_path)?.duplicate_of ?? null).toBeNull();
  });

  it("never chunks raw bytes for a non-image file either", async () => {
    const h = harness({ engineText: "" });
    await handleAutoIngestAttachment(params({ file_path: "/mem/inbox/attachments/1-blob.bin", filename: "blob.bin", mime_type: null }), h.deps);
    const [c] = h.docs.getChunksForSource("/mem/inbox/attachments/1-blob.bin");
    expect(stripChunkHeader(c.content)).toBe("File blob.bin uploaded 2026-10-25; no text could be extracted");
  });
});

describe("failed attempts", () => {
  it("records a chunk-less failed row and counts attempts", async () => {
    const h = harness({ engineThrows: true });
    const r1 = await handleAutoIngestAttachment(params(), h.deps);
    expect(r1).toMatchObject({ ok: false });
    let row = h.docs.getDocumentRow(params().file_path)!;
    expect(row).toMatchObject({ ingest_status: "failed", ingest_attempts: 1, filename: "statement.pdf" });
    expect(h.docs.getChunksForSource(params().file_path)).toEqual([]);
    await handleAutoIngestAttachment(params(), h.deps);
    await handleAutoIngestAttachment(params(), h.deps);
    row = h.docs.getDocumentRow(params().file_path)!;
    expect(row.ingest_attempts).toBe(3);
    expect(documentNeedsRetry(row)).toBe(false);
  });
});
