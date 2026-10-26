/**
 * WP3 (2026-10-25): search_documents cache entries are invalidated by an
 * ingest, a delete and a priority change. Mirrors the daemon intercept:
 * dispatchTool keyed with withCorpusVersion(args, docStore.getVersion()).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { ToolCacheStore } from "../tool-cache-store.js";
import { dispatchTool } from "../tool-dispatch.js";
import { withCorpusVersion } from "../tool-cache-policy.js";
import { DocumentStore } from "../../documents/store.js";

let dir: string;
let cache: ToolCacheStore;
let docs: DocumentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wp3-cache-"));
  cache = new ToolCacheStore({ path: join(dir, "cache.db") });
  const db = new Database(":memory:");
  sqliteVec.load(db);
  docs = new DocumentStore(db);
});
afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

function vec(axis: number): Int8Array {
  const a = new Int8Array(384);
  a[axis] = 100;
  return a;
}

async function search(): Promise<{ hits: number; cached: boolean }> {
  const out = await dispatchTool<{ results: unknown[] }>({
    tool: "search_documents",
    args: withCorpusVersion({ query: "invoice total", limit: 5 }, docs.getVersion()),
    agentName: "fin",
    cacheStore: cache,
    maxSizeMb: 10,
    upstream: async () => ({ results: [...docs.search(vec(1), 5)] }),
  });
  if ("cached" in out && "data" in out) {
    return { hits: (out.data as { results: unknown[] }).results.length, cached: true };
  }
  return { hits: (out as { results: unknown[] }).results.length, cached: false };
}

describe("search_documents cache invalidation", () => {
  it("a search after ingest, priority change or delete is never served stale", async () => {
    expect(await search()).toEqual({ hits: 0, cached: false });
    expect(await search()).toEqual({ hits: 0, cached: true }); // cached as before

    docs.ingest("/inbox/invoice.pdf", [{ content: "Total 4820", chunkIndex: 0, startChar: 0, endChar: 10 }], [vec(1)]);
    expect(await search()).toEqual({ hits: 1, cached: false });
    expect(await search()).toEqual({ hits: 1, cached: true });

    docs.upsertDocumentRow({
      source: "/inbox/invoice.pdf",
      agentName: "fin",
      ingestedAt: new Date().toISOString(),
      sourceKind: "discord_attachment",
      autoClassifiedClass: "low",
      contentWeight: 0.5,
      agentWeightAtIngest: 1,
    });
    await search();
    docs.setDocumentPriority("/inbox/invoice.pdf", "high", "operator");
    expect((await search()).cached).toBe(false);

    docs.deleteDocument("/inbox/invoice.pdf");
    expect(await search()).toEqual({ hits: 0, cached: false });
  });
});
