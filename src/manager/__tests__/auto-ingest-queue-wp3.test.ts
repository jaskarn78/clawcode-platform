/**
 * WP3 (2026-10-25): the inbox rescan re-enqueues a file whose row says the
 * last attempt stored only a stub or failed, until MAX_INGEST_ATTEMPTS.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { AutoIngestQueue } from "../auto-ingest-queue.js";
import type { DocumentRow, DocumentStore } from "../../documents/store.js";

const log = pino({ level: "silent" });

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rescan-wp3-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("AutoIngestQueue rescan retries (WP3)", () => {
  it("re-enqueues empty/failed rows under the attempt cap only", async () => {
    const memoryPath = join(root, "mem");
    const inbox = join(memoryPath, "inbox", "attachments");
    mkdirSync(inbox, { recursive: true });
    const files = {
      ok: join(inbox, "1-ok.pdf"),
      legacy: join(inbox, "2-legacy.pdf"),
      emptyRetry: join(inbox, "3-empty.png"),
      failedRetry: join(inbox, "4-failed.pdf"),
      exhausted: join(inbox, "5-exhausted.png"),
      fresh: join(inbox, "6-fresh.pdf"),
    };
    for (const f of Object.values(files)) writeFileSync(f, "x");
    const rows: Record<string, Partial<DocumentRow>> = {
      [files.ok]: { ingest_status: "ok", ingest_attempts: 1 },
      [files.legacy]: { ingest_status: null },
      [files.emptyRetry]: { ingest_status: "empty", ingest_attempts: 1 },
      [files.failedRetry]: { ingest_status: "failed", ingest_attempts: 2 },
      [files.exhausted]: { ingest_status: "empty", ingest_attempts: 3 },
    };
    const docStore = {
      getDocumentRow: (s: string) => (rows[s] ? ({ source: s, ...rows[s] } as DocumentRow) : null),
    } as unknown as DocumentStore;

    const handled: string[] = [];
    const q = new AutoIngestQueue();
    q.init({
      runHandler: async (p) => {
        handled.push(p.file_path);
      },
      logger: log,
      getDocumentStore: () => docStore,
      listIngestAgents: () => [],
    });
    const r = await q.runRescanForAgent("a", memoryPath);
    expect(r).toEqual({ scanned: 6, enqueued: 3 });
    for (let i = 0; i < 50 && handled.length < 3; i++) await new Promise((res) => setImmediate(res));
    expect(handled.sort()).toEqual([files.emptyRetry, files.failedRetry, files.fresh].sort());
    expect(q.idle).toBe(true);
  });
});
