/**
 * WP3 (2026-10-25): cross-ingest mirror heading, and the re-mirror pass that
 * rebuilds missing `document:<slug>` mirrors from stored document chunks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../../memory/store.js";
import { DocumentStore, type DocumentRowInput } from "../../documents/store.js";
import { chunkWithContext, stripChunkHeader } from "../../documents/chunk-context.js";
import { crossIngestToMemory, MigrationPhaseStore } from "../cross-ingest.js";
import {
  displayFilenameFor,
  findDocumentsMissingMirror,
  mirrorPathFor,
  remirrorMissingDocuments,
  REMIRROR_MAX_FAILURES,
  type RemirrorEmbed,
  type RemirrorState,
} from "../remirror.js";

type MirrorRow = { path: string; heading: string | null; body: string; chunk_index: number };

function words(n: number, prefix = "w"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
}

const embed: RemirrorEmbed = async (texts) => ({
  v1: texts.map(() => new Float32Array(384).fill(0.01)),
  v2: texts.map(() => new Int8Array(384).fill(1)),
});

function row(source: string, over: Partial<DocumentRowInput> = {}): DocumentRowInput {
  return {
    source,
    agentName: "agent",
    ingestedAt: "2026-10-21T09:00:00.000Z",
    sourceKind: "discord_attachment",
    autoClassifiedClass: "medium",
    contentWeight: 1,
    agentWeightAtIngest: 1,
    ...over,
  };
}

function freshState(): RemirrorState {
  return { failures: new Map(), unmirrorable: new Set() };
}

let memory: MemoryStore;
let docs: DocumentStore;

beforeEach(() => {
  memory = new MemoryStore(":memory:");
  docs = new DocumentStore(memory.getDatabase());
});
afterEach(() => memory.close());

function mirrorRows(path: string): MirrorRow[] {
  return memory
    .getDatabase()
    .prepare("SELECT path, heading, body, chunk_index FROM memory_chunks WHERE path = ? ORDER BY chunk_index")
    .all(path) as MirrorRow[];
}

/** Store a document the way the ingest paths do (headered 500-token chunks). */
function storeDocument(source: string, text: string, filename: string): void {
  const chunks = chunkWithContext(text, { filename, uploadedAt: "2026-10-21T09:00:00Z" });
  docs.ingest(source, chunks, chunks.map(() => new Int8Array(384).fill(2)));
}

describe("crossIngestToMemory heading", () => {
  it("stores the given filename as the heading on every mirror row", async () => {
    await crossIngestToMemory({
      agent: "agent",
      docSlug: "1790-invoice-pdf",
      heading: "invoice.pdf",
      chunks: [
        { index: 0, content: "a" },
        { index: 1, content: "b" },
      ],
      precomputedV1: [new Float32Array(384), new Float32Array(384)],
      precomputedV2: [new Int8Array(384), new Int8Array(384)],
      memoryStore: memory,
      migrationPhaseStore: new MigrationPhaseStore(memory, "agent"),
    });
    const rows = mirrorRows("document:1790-invoice-pdf");
    expect(rows.map((r) => r.heading)).toEqual(["invoice.pdf", "invoice.pdf"]);
    // FTS indexes the heading too.
    const fts = memory
      .getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM memory_chunks_fts WHERE memory_chunks_fts MATCH 'invoice'")
      .get() as { n: number };
    expect(fts.n).toBe(2);
  });

  it("falls back to the slug, never null", async () => {
    await crossIngestToMemory({
      agent: "agent",
      docSlug: "notes",
      heading: "   ",
      chunks: [{ index: 0, content: "x" }],
      precomputedV1: [new Float32Array(384)],
      precomputedV2: [new Int8Array(384)],
      memoryStore: memory,
      migrationPhaseStore: new MigrationPhaseStore(memory, "agent"),
    });
    expect(mirrorRows("document:notes")[0].heading).toBe("notes");
  });
});

describe("remirrorMissingDocuments", () => {
  it("rebuilds a missing mirror at about 300 words with header and filename heading", async () => {
    const source = "/mem/inbox/attachments/1790000000000-statement.pdf";
    storeDocument(source, words(1000), "statement.pdf");
    docs.upsertDocumentRow(
      row(source, { filename: "statement.pdf", userName: "jas", channelName: "finance" }),
    );
    expect(findDocumentsMissingMirror(docs, memory)).toEqual([source]);

    const r = await remirrorMissingDocuments({
      agent: "agent",
      docStore: docs,
      memoryStore: memory,
      embed,
      state: freshState(),
    });
    expect(r).toMatchObject({ missing: 1, remirrored: 1, failed: 0 });

    const rows = mirrorRows(mirrorPathFor(source));
    expect(rows.length).toBe(4); // 1000 words at 300 with 30 overlap
    expect(rows.every((x) => x.heading === "statement.pdf")).toBe(true);
    expect(rows[0].body.split("\n")[0]).toBe(
      "Document: statement.pdf | uploaded 2026-10-21 | from jas in #finance | part 1/4",
    );
    for (const x of rows) {
      expect(stripChunkHeader(x.body).split(" ").length).toBeLessThanOrEqual(300);
    }
    // The rebuilt text is the original word sequence (no duplicated overlap).
    const bodyWords = rows.flatMap((x, i) =>
      stripChunkHeader(x.body).split(" ").slice(i === 0 ? 0 : 30),
    );
    expect(bodyWords.join(" ")).toBe(words(1000));

    // Second pass: nothing missing.
    expect(findDocumentsMissingMirror(docs, memory)).toEqual([]);
    const again = await remirrorMissingDocuments({
      agent: "agent", docStore: docs, memoryStore: memory, embed, state: freshState(),
    });
    expect(again.remirrored).toBe(0);
  });

  it("skips stub and failed ingests", async () => {
    storeDocument("/inbox/stub.png", "Image stub.png; no text could be extracted", "stub.png");
    docs.upsertDocumentRow(row("/inbox/stub.png", { ingestStatus: "empty", ingestAttempts: 1 }));
    expect(findDocumentsMissingMirror(docs, memory)).toEqual([]);
  });

  it("derives the filename from the inbox path when the row has none", () => {
    expect(displayFilenameFor("/m/inbox/attachments/1790000000000-IMG_1.jpg")).toBe("IMG_1.jpg");
    expect(displayFilenameFor("/ws/homelab/INVENTORY.md")).toBe("INVENTORY.md");
    expect(displayFilenameFor("/x", "orig.pdf")).toBe("orig.pdf");
  });

  it("gives up on a source after repeated failures so it cannot block the backlog", async () => {
    storeDocument("/a.txt", words(50), "a.txt");
    storeDocument("/b.txt", words(50), "b.txt");
    const state = freshState();
    const failing: RemirrorEmbed = async (texts) => {
      if (texts.some((t) => t.includes("Document: a.txt"))) throw new Error("embed down");
      return embed(texts);
    };
    for (let i = 0; i < REMIRROR_MAX_FAILURES; i++) {
      await remirrorMissingDocuments({
        agent: "agent", docStore: docs, memoryStore: memory, embed: failing, maxDocuments: 1, state,
      });
      if (i === 0) {
        // /a.txt sorts first and fails; /b.txt waits because maxDocuments is 1.
        expect(mirrorRows(mirrorPathFor("/b.txt"))).toHaveLength(0);
      }
    }
    expect(state.unmirrorable.has("/a.txt")).toBe(true);
    const r = await remirrorMissingDocuments({
      agent: "agent", docStore: docs, memoryStore: memory, embed: failing, maxDocuments: 1, state,
    });
    expect(r.remirrored).toBe(1);
    expect(mirrorRows(mirrorPathFor("/b.txt")).length).toBeGreaterThan(0);
  });

  it("stops after the chunk budget but always mirrors at least one document", async () => {
    storeDocument("/1.txt", words(1000), "1.txt");
    storeDocument("/2.txt", words(1000), "2.txt");
    const r = await remirrorMissingDocuments({
      agent: "agent", docStore: docs, memoryStore: memory, embed, chunkBudget: 2, state: freshState(),
    });
    expect(r.remirrored).toBe(1);
    expect(findDocumentsMissingMirror(docs, memory)).toHaveLength(1);
  });
});
