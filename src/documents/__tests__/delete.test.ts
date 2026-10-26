/**
 * WP3 (2026-10-25): delete_document removes chunks, the documents row,
 * duplicate rows, the memory mirror and the agent's own inbox/archive
 * copies, and never touches files outside those directories.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../../memory/store.js";
import { DocumentStore, type DocumentRowInput } from "../store.js";
import { isInsideDir, purgeDocument } from "../delete.js";
import { crossIngestToMemory, MigrationPhaseStore } from "../../document-ingest/cross-ingest.js";
import { computeDocSlug } from "../../document-ingest/index.js";

let root: string;
let inbox: string;
let archive: string;
let workspace: string;
let memory: MemoryStore;
let docs: DocumentStore;

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

async function mirror(source: string): Promise<void> {
  await crossIngestToMemory({
    agent: "agent",
    docSlug: computeDocSlug(source),
    heading: "x",
    chunks: [{ index: 0, content: "mirror body" }],
    precomputedV1: [new Float32Array(384)],
    precomputedV2: [new Int8Array(384)],
    memoryStore: memory,
    migrationPhaseStore: new MigrationPhaseStore(memory, "agent"),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wp3-delete-"));
  inbox = join(root, "mem", "inbox", "attachments");
  archive = join(root, "mem", "attachments-archive");
  workspace = join(root, "ws");
  for (const d of [inbox, archive, workspace]) mkdirSync(d, { recursive: true });
  memory = new MemoryStore(":memory:");
  docs = new DocumentStore(memory.getDatabase());
});
afterEach(() => {
  memory.close();
  rmSync(root, { recursive: true, force: true });
});

describe("purgeDocument", () => {
  it("removes chunks, rows, duplicates, mirror, inbox copies and the unshared archive copy", async () => {
    const src = join(inbox, "1790000000000-photo.png");
    const dup = join(inbox, "1790000000500-photo.png");
    const arch = join(archive, "1790000000000-photo.webp");
    for (const f of [src, dup, arch]) writeFileSync(f, "bytes");
    docs.ingest(src, [{ content: "c", chunkIndex: 0, startChar: 0, endChar: 1 }], [new Int8Array(384)]);
    docs.upsertDocumentRow(row(src, { sourceImagePath: arch, contentSha256: "s" }));
    docs.upsertDocumentRow(row(dup, { sourceImagePath: arch, duplicateOf: src, contentSha256: "s" }));
    await mirror(src);

    const r = await purgeDocument({ docStore: docs, memoryStore: memory, source: src, inboxDir: inbox, archiveDir: archive });

    expect(r.chunksDeleted).toBe(1);
    expect(r.documentRowsDeleted).toBe(2);
    expect(r.memoryChunksDeleted).toBe(1);
    expect([...r.filesRemoved].sort()).toEqual([arch, dup, src].sort());
    expect(docs.getDocumentRow(src)).toBeNull();
    expect(docs.getDocumentRow(dup)).toBeNull();
    expect(memory.getMemoryFileSha256(`document:${computeDocSlug(src)}`)).toBeNull();
    expect(existsSync(src) || existsSync(dup) || existsSync(arch)).toBe(false);
  });

  it("never deletes files outside the agent's inbox and archive dirs", async () => {
    const wsFile = join(workspace, "contract.pdf");
    writeFileSync(wsFile, "pdf");
    docs.ingest(wsFile, [{ content: "c", chunkIndex: 0, startChar: 0, endChar: 1 }], [new Int8Array(384)]);
    await mirror(wsFile);
    const r = await purgeDocument({ docStore: docs, memoryStore: memory, source: wsFile, inboxDir: inbox, archiveDir: archive });
    expect(r.chunksDeleted).toBe(1);
    expect(r.memoryChunksDeleted).toBe(1);
    expect(r.filesRemoved).toEqual([]);
    expect(existsSync(wsFile)).toBe(true);
  });

  it("keeps an archive copy another row still references, and tolerates a missing memory store", async () => {
    const src = join(inbox, "1-a.png");
    const other = join(inbox, "2-b.png");
    const arch = join(archive, "shared.webp");
    writeFileSync(arch, "x");
    docs.upsertDocumentRow(row(src, { sourceImagePath: arch }));
    docs.upsertDocumentRow(row(other, { sourceImagePath: arch }));
    const r = await purgeDocument({ docStore: docs, source: src, inboxDir: inbox, archiveDir: archive });
    expect(r.memoryChunksDeleted).toBe(0);
    expect(existsSync(arch)).toBe(true);
    expect(r.filesRemoved).toEqual([]); // the inbox file itself never existed
  });

  it("isInsideDir rejects traversal, siblings and the dir itself", () => {
    expect(isInsideDir("/a/b/c.png", "/a/b")).toBe(true);
    expect(isInsideDir("/a/b/../x.png", "/a/b")).toBe(false);
    expect(isInsideDir("/a/bb/x.png", "/a/b")).toBe(false);
    expect(isInsideDir("/a/b", "/a/b")).toBe(false);
    expect(isInsideDir("/a/b/x", undefined)).toBe(false);
  });
});
