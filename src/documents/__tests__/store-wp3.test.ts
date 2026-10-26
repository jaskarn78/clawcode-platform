/**
 * WP3 (2026-10-25): DocumentStore changes.
 *   - source-filtered search restricts candidates to that source BEFORE
 *     scoring (it used to run a global KNN and filter afterwards);
 *   - deleteDocument also removes the documents row and duplicate rows;
 *   - exact-duplicate lookup ignores stub ("empty") and "failed" originals;
 *   - provenance columns, retry bookkeeping and the cache version stamp.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
  DocumentStore,
  MAX_INGEST_ATTEMPTS,
  documentNeedsRetry,
  migrateAddProvenanceColumns,
  type DocumentRow,
  type DocumentRowInput,
} from "../store.js";

/** Unit-ish int8 vector pointing mostly along `axis`, with a small tilt. */
function vec(axis: number, tilt = 0, tiltAxis = (axis + 1) % 384): Int8Array {
  const a = new Int8Array(384);
  a[axis] = 100;
  a[tiltAxis] = tilt;
  return a;
}

function chunk(i: number, content: string) {
  return { content, chunkIndex: i, startChar: 0, endChar: content.length };
}

function row(source: string, over: Partial<DocumentRowInput> = {}): DocumentRowInput {
  return {
    source,
    agentName: "a",
    ingestedAt: "2026-10-20T00:00:00.000Z",
    sourceKind: "discord_attachment",
    autoClassifiedClass: "medium",
    contentWeight: 1,
    agentWeightAtIngest: 1,
    ...over,
  };
}

describe("DocumentStore WP3", () => {
  let db: DatabaseType;
  let store: DocumentStore;

  beforeEach(() => {
    db = new Database(":memory:");
    sqliteVec.load(db);
    store = new DocumentStore(db);
  });

  describe("search with a source filter", () => {
    it("finds the document's chunks even when 80 other chunks are closer to the query", () => {
      // 80 distractor chunks almost identical to the query (axis 0).
      for (let d = 0; d < 40; d++) {
        store.ingest(
          `/inbox/other-${d}.pdf`,
          [chunk(0, `other ${d} a`), chunk(1, `other ${d} b`)],
          [vec(0, 5), vec(0, 6)],
        );
      }
      // The invoice: two chunks far from the query, one a bit closer.
      store.ingest(
        "/inbox/invoice.pdf",
        [chunk(0, "ACME invoice header"), chunk(1, "Total due 4820"), chunk(2, "terms")],
        [vec(10), vec(10, 60, 0), vec(20)],
      );
      const q = vec(0);

      // Unfiltered: the invoice is nowhere in the top 5.
      const global = store.search(q, 5);
      expect(global.every((r) => r.source !== "/inbox/invoice.pdf")).toBe(true);

      // Filtered: all three invoice chunks, best first.
      const filtered = store.search(q, 5, "/inbox/invoice.pdf");
      expect(filtered.map((r) => r.source)).toEqual([
        "/inbox/invoice.pdf",
        "/inbox/invoice.pdf",
        "/inbox/invoice.pdf",
      ]);
      expect(filtered[0].content).toBe("Total due 4820");
      expect(filtered[0].similarity).toBeGreaterThan(filtered[1].similarity);
    });

    it("scores a source-filtered hit exactly like the unfiltered KNN does", () => {
      store.ingest("/a.pdf", [chunk(0, "alpha")], [vec(3, 40)]);
      store.ingest("/b.pdf", [chunk(0, "beta")], [vec(7)]);
      const q = vec(3);
      const knn = store.search(q, 5).find((r) => r.source === "/a.pdf")!;
      const scoped = store.search(q, 5, "/a.pdf")[0];
      expect(scoped.similarity).toBeCloseTo(knn.similarity, 6);
    });

    it("respects the limit and returns nothing for an unknown source", () => {
      store.ingest(
        "/many.pdf",
        Array.from({ length: 12 }, (_, i) => chunk(i, `c${i}`)),
        Array.from({ length: 12 }, (_, i) => vec(i)),
      );
      expect(store.search(vec(0), 4, "/many.pdf")).toHaveLength(4);
      expect(store.search(vec(0), 4, "/missing.pdf")).toEqual([]);
    });

    it("returns provenance fields from the documents row", () => {
      store.ingest("/inbox/1790-x.png", [chunk(0, "x")], [vec(1)]);
      store.upsertDocumentRow(
        row("/inbox/1790-x.png", { filename: "x.png", userName: "jas", channelName: "ops" }),
      );
      const [hit] = store.search(vec(1), 1, "/inbox/1790-x.png");
      expect(hit).toMatchObject({
        filename: "x.png",
        userName: "jas",
        channelName: "ops",
        ingestedAt: "2026-10-20T00:00:00.000Z",
        sourceKind: "discord_attachment",
      });
    });
  });

  describe("deleteDocument", () => {
    it("removes chunks, vectors, the documents row and duplicate rows", () => {
      store.ingest("/inbox/orig.png", [chunk(0, "o")], [vec(1)]);
      store.upsertDocumentRow(row("/inbox/orig.png", { contentSha256: "sha" }));
      store.upsertDocumentRow(
        row("/inbox/dup.png", { contentSha256: "sha", duplicateOf: "/inbox/orig.png" }),
      );
      store.upsertDocumentRow(row("/inbox/keep.png"));
      expect(store.listDuplicatesOf("/inbox/orig.png").map((d) => d.source)).toEqual([
        "/inbox/dup.png",
      ]);

      expect(store.deleteDocument("/inbox/orig.png")).toBe(1);
      expect(store.getDocumentRow("/inbox/orig.png")).toBeNull();
      expect(store.getDocumentRow("/inbox/dup.png")).toBeNull();
      expect(store.getDocumentRow("/inbox/keep.png")).not.toBeNull();
      expect(store.getChunksForSource("/inbox/orig.png")).toEqual([]);
      const vecRows = db.prepare("SELECT COUNT(*) AS n FROM vec_document_chunks").get() as {
        n: number;
      };
      expect(vecRows.n).toBe(0);
      // The same bytes can now be ingested as a new original.
      expect(store.findDocumentBySha256("sha")).toBeNull();
    });
  });

  describe("exact-duplicate lookup", () => {
    it("ignores stub and failed originals so a re-send is processed", () => {
      store.upsertDocumentRow(row("/inbox/s.png", { contentSha256: "h1", ingestStatus: "empty" }));
      store.upsertDocumentRow(row("/inbox/f.png", { contentSha256: "h2", ingestStatus: "failed" }));
      store.upsertDocumentRow(row("/inbox/o.png", { contentSha256: "h3" }));
      expect(store.findDocumentBySha256("h1")).toBeNull();
      expect(store.findDocumentBySha256("h2")).toBeNull();
      expect(store.findDocumentBySha256("h3")?.source).toBe("/inbox/o.png");
    });
  });

  describe("retry bookkeeping", () => {
    it("defaults new rows to ok with zero attempts", () => {
      store.upsertDocumentRow(row("/x"));
      const r = store.getDocumentRow("/x")!;
      expect(r.ingest_status).toBe("ok");
      expect(r.ingest_attempts).toBe(0);
      expect(documentNeedsRetry(r)).toBe(false);
    });

    it("retries empty/failed rows until MAX_INGEST_ATTEMPTS", () => {
      const base = { ingest_status: "empty", ingest_attempts: 1 } as DocumentRow;
      expect(documentNeedsRetry(base)).toBe(true);
      expect(documentNeedsRetry({ ...base, ingest_status: "failed" } as DocumentRow)).toBe(true);
      expect(
        documentNeedsRetry({ ...base, ingest_attempts: MAX_INGEST_ATTEMPTS } as DocumentRow),
      ).toBe(false);
      // Legacy rows (column NULL) count as ok.
      expect(documentNeedsRetry({ ingest_status: null } as DocumentRow)).toBe(false);
    });

    it("setIngestOutcome updates only status and attempts", () => {
      store.upsertDocumentRow(row("/x", { channelId: "c1", filename: "x.pdf" }));
      store.setIngestOutcome("/x", "failed", 2);
      const r = store.getDocumentRow("/x")!;
      expect(r).toMatchObject({ ingest_status: "failed", ingest_attempts: 2, channel_id: "c1", filename: "x.pdf" });
    });

    it("counts rows referencing an archived image path", () => {
      store.upsertDocumentRow(row("/a", { sourceImagePath: "/arch/a.webp" }));
      store.upsertDocumentRow(row("/b", { sourceImagePath: "/arch/a.webp" }));
      expect(store.countImagePathReferences("/arch/a.webp")).toBe(2);
      expect(store.countImagePathReferences("/arch/none.webp")).toBe(0);
    });
  });

  describe("version stamp", () => {
    it("moves forward on ingest, upsert, priority change and delete", () => {
      const seen = [store.getVersion()];
      store.ingest("/v", [chunk(0, "v")], [vec(1)]);
      seen.push(store.getVersion());
      store.upsertDocumentRow(row("/v"));
      seen.push(store.getVersion());
      store.setDocumentPriority("/v", "high", "operator");
      seen.push(store.getVersion());
      store.setIngestOutcome("/v", "failed", 1);
      seen.push(store.getVersion());
      store.deleteDocument("/v");
      seen.push(store.getVersion());
      for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    });

    it("does not move on reads", () => {
      const v = store.getVersion();
      store.search(vec(1), 3);
      store.listSources();
      store.getDocumentRow("/nope");
      expect(store.getVersion()).toBe(v);
    });
  });

  describe("migrateAddProvenanceColumns", () => {
    it("adds the columns to a legacy documents table once", () => {
      const legacy = new Database(":memory:");
      legacy.exec(
        "CREATE TABLE documents (source TEXT PRIMARY KEY, agent_name TEXT NOT NULL, ingested_at TEXT NOT NULL, source_kind TEXT NOT NULL, auto_classified_class TEXT NOT NULL)",
      );
      legacy.exec(
        "INSERT INTO documents VALUES ('/old', 'a', '2026-01-01', 'discord_attachment', 'low')",
      );
      expect(migrateAddProvenanceColumns(legacy)).toEqual([
        "filename",
        "user_name",
        "channel_name",
        "ingest_status",
        "ingest_attempts",
      ]);
      expect(migrateAddProvenanceColumns(legacy)).toEqual([]);
      const old = legacy.prepare("SELECT * FROM documents").get() as Record<string, unknown>;
      expect(old.ingest_status).toBeNull();
      expect(old.ingest_attempts).toBe(0);
    });
  });
});
