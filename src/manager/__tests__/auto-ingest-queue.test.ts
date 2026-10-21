/**
 * P1-INGESTQ / P1-RESCAN unit tests — enqueue-and-ACK, non-blocking overflow,
 * idempotent dedup, serial governed drain, and inbox rescan dedup.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import {
  AutoIngestQueue,
  MAX_QUEUE_DEPTH,
  type AutoIngestQueueDeps,
} from "../auto-ingest-queue.js";
import type { AutoIngestAttachmentParams } from "../auto-ingest-handler.js";
import type { DocumentStore } from "../../documents/store.js";

const log = pino({ level: "silent" });

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
async function waitFor(cond: () => boolean, max = 200): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error("waitFor timed out");
}

function params(filePath: string): AutoIngestAttachmentParams {
  return {
    agent: "a",
    file_path: filePath,
    filename: "f.pdf",
    mime_type: "application/pdf",
    size: 1,
    vision_analysis: null,
    channel_id: "c",
    message_id: "m",
    user_id: "u",
    user_name: "n",
  };
}

describe("AutoIngestQueue.enqueue (P1-INGESTQ)", () => {
  it("returns {queued, queueDepth} synchronously", () => {
    const q = new AutoIngestQueue();
    const handled: string[] = [];
    q.init(makeDeps({ runHandler: async (p) => { handled.push(p.file_path); } }));
    const r = q.enqueue(params("/x/1"));
    expect(r).toEqual({ queued: true, queueDepth: expect.any(Number) });
  });

  it("idempotent — re-enqueuing a tracked source does not duplicate", async () => {
    const q = new AutoIngestQueue();
    let resolveHandler: () => void = () => {};
    const gate = new Promise<void>((r) => (resolveHandler = r));
    const handled: string[] = [];
    q.init(
      makeDeps({
        runHandler: async (p) => {
          handled.push(p.file_path);
          await gate; // hold the first item in-flight
        },
      }),
    );
    q.enqueue(params("/x/dup"));
    await tick(); // let drain pick it up (now in-flight)
    const second = q.enqueue(params("/x/dup")); // same source, in-flight
    expect(second).toEqual({ queued: true, queueDepth: 0 });
    resolveHandler();
    await waitFor(() => handled.length >= 1);
    expect(handled).toEqual(["/x/dup"]); // handled ONCE, not twice
  });

  it("non-blocking overflow → {deferred} past MAX_QUEUE_DEPTH", () => {
    const q = new AutoIngestQueue();
    // Never-resolving handler so the queue stays full (first item in-flight,
    // the rest accumulate in the work-list).
    q.init(makeDeps({ runHandler: () => new Promise<void>(() => {}) }));
    // Fill the queue past the cap. One item goes in-flight via the drain on the
    // next tick, but synchronously we push until depth hits the cap.
    let lastQueued = 0;
    for (let i = 0; i < MAX_QUEUE_DEPTH + 5; i++) {
      const r = q.enqueue(params(`/x/${i}`));
      if ("queued" in r) lastQueued = i;
    }
    const overflow = q.enqueue(params("/x/overflow"));
    expect("deferred" in overflow && overflow.deferred).toBe(true);
    expect(lastQueued).toBeGreaterThanOrEqual(MAX_QUEUE_DEPTH - 1);
  });
});

describe("AutoIngestQueue drain (serial + governed)", () => {
  it("drains items serially and survives a throwing item (governor released)", async () => {
    const q = new AutoIngestQueue();
    const handled: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    q.init(
      makeDeps({
        runHandler: async (p) => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await tick();
          if (p.file_path === "/x/boom") {
            concurrent--;
            throw new Error("boom"); // must NOT wedge the gate
          }
          handled.push(p.file_path);
          concurrent--;
        },
      }),
    );
    q.enqueue(params("/x/1"));
    q.enqueue(params("/x/boom"));
    q.enqueue(params("/x/2"));
    await waitFor(() => handled.length >= 2);
    expect(handled).toEqual(["/x/1", "/x/2"]); // /x/2 drained after the throw
    expect(maxConcurrent).toBe(1); // serial (concurrency 1)
  });
});

describe("AutoIngestQueue.runRescanForAgent (P1-RESCAN)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rescan-test-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("enqueues fresh inbox files absent from docStore; skips ingested/old", async () => {
    const memoryPath = join(root, "agentmem");
    const inbox = join(memoryPath, "inbox", "attachments");
    mkdirSync(inbox, { recursive: true });
    const fresh = join(inbox, "1700000000000-new.pdf");
    const ingested = join(inbox, "1700000000001-old-ingested.pdf");
    const stale = join(inbox, "1700000000002-too-old.pdf");
    const tmp = join(inbox, "1700000000003-downloading.pdf.tmp");
    writeFileSync(fresh, "x");
    writeFileSync(ingested, "x");
    writeFileSync(stale, "x");
    writeFileSync(tmp, "x");
    // Age the stale file past 24h.
    const old = Date.now() / 1000 - 48 * 3600;
    utimesSync(stale, old, old);

    const handled: string[] = [];
    const docStore = {
      // Only the "ingested" file has a row.
      getDocumentRow: (source: string) =>
        source === ingested ? ({ source } as never) : null,
    } as unknown as DocumentStore;

    const q = new AutoIngestQueue();
    q.init(
      makeDeps({
        runHandler: async (p) => {
          handled.push(p.file_path);
        },
        getDocumentStore: () => docStore,
        listIngestAgents: () => [{ agent: "a", memoryPath }],
      }),
    );

    const r = await q.runRescanForAgent("a", memoryPath);
    expect(r.enqueued).toBe(1);
    await waitFor(() => handled.length >= 1);
    expect(handled).toEqual([fresh]); // only the fresh, un-ingested, non-.tmp file
  });

  it("is idempotent — a second rescan does not re-enqueue an in-flight/queued file", async () => {
    const memoryPath = join(root, "agentmem2");
    const inbox = join(memoryPath, "inbox", "attachments");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "1700000000000-a.pdf"), "x");

    const handled: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const q = new AutoIngestQueue();
    q.init(
      makeDeps({
        runHandler: async (p) => {
          handled.push(p.file_path);
          await gate;
        },
        getDocumentStore: () => undefined,
        listIngestAgents: () => [{ agent: "a", memoryPath }],
      }),
    );

    const first = await q.runRescanForAgent("a", memoryPath);
    expect(first.enqueued).toBe(1);
    await tick(); // item now in-flight
    const second = await q.runRescanForAgent("a", memoryPath);
    expect(second.enqueued).toBe(0); // already in-flight → skipped
    release();
    await waitFor(() => handled.length >= 1);
    expect(handled).toHaveLength(1);
  });
});

describe("AutoIngestQueue observer (P2-PROGRESS)", () => {
  it("emits onItemDone per drained item with ok=true on success", async () => {
    const q = new AutoIngestQueue();
    const events: Array<{ channelId: string; messageId: string; ok: boolean }> =
      [];
    q.setObserver({
      onItemDone: (e) =>
        events.push({ channelId: e.channelId, messageId: e.messageId, ok: e.ok }),
    });
    q.init(makeDeps({ runHandler: async () => {} }));
    q.enqueue(params("/x/1"));
    q.enqueue(params("/x/2"));
    await waitFor(() => events.length >= 2);
    expect(events).toEqual([
      { channelId: "c", messageId: "m", ok: true },
      { channelId: "c", messageId: "m", ok: true },
    ]);
  });

  it("emits ok=false when the handler throws, and keeps draining serially", async () => {
    const q = new AutoIngestQueue();
    const oks: boolean[] = [];
    q.setObserver({ onItemDone: (e) => oks.push(e.ok) });
    q.init(
      makeDeps({
        runHandler: async (p) => {
          if (p.file_path === "/x/boom") throw new Error("boom");
        },
      }),
    );
    q.enqueue(params("/x/boom"));
    q.enqueue(params("/x/ok"));
    await waitFor(() => oks.length >= 2);
    expect(oks).toEqual([false, true]);
  });

  it("a throwing observer never wedges the drain (never-drop preserved)", async () => {
    const q = new AutoIngestQueue();
    const handled: string[] = [];
    q.setObserver({
      onItemDone: () => {
        throw new Error("observer boom");
      },
    });
    q.init(makeDeps({ runHandler: async (p) => { handled.push(p.file_path); } }));
    q.enqueue(params("/x/1"));
    q.enqueue(params("/x/2"));
    await waitFor(() => handled.length >= 2);
    expect(handled).toEqual(["/x/1", "/x/2"]);
  });
});

function makeDeps(over: Partial<AutoIngestQueueDeps>): AutoIngestQueueDeps {
  return {
    runHandler: async () => ({ ok: true, skipped: true, reason: "stub" }) as never,
    logger: log,
    getDocumentStore: () => undefined,
    listIngestAgents: () => [],
    ...over,
  };
}
