/**
 * 999.178 R1 — coalesced-queue-store: persist / restore / expiry.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadCoalescedQueue,
  upsertQueuedAsk,
  removeQueuedAsk,
  removeQueuedAsks,
  COALESCED_QUEUE_STALE_MS,
  type PersistedQueuedAsk,
} from "../coalesced-queue-store.js";

let dir: string;
let file: string;

function ask(overrides: Partial<PersistedQueuedAsk> = {}): PersistedQueuedAsk {
  return {
    agentName: "fin-client",
    messageId: "m1",
    channelId: "c1",
    content: "any update?",
    receivedAt: Date.now(),
    kind: "coalesced",
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "coalq-"));
  file = join(dir, "coalesced-queue.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("coalesced-queue-store", () => {
  it("round-trips asks oldest-first", async () => {
    await upsertQueuedAsk(file, ask({ messageId: "m2", receivedAt: 2000 }));
    await upsertQueuedAsk(file, ask({ messageId: "m1", receivedAt: 1000 }));
    await upsertQueuedAsk(file, ask({ messageId: "m3", receivedAt: 3000, kind: "depth1" }));

    const loaded = await loadCoalescedQueue(file, 4000);
    expect(loaded.map((a) => a.messageId)).toEqual(["m1", "m2", "m3"]);
    expect(loaded.find((a) => a.messageId === "m3")?.kind).toBe("depth1");
  });

  it("upsert replaces by messageId (idempotent restore)", async () => {
    await upsertQueuedAsk(file, ask({ messageId: "m1", content: "eta?" }));
    await upsertQueuedAsk(file, ask({ messageId: "m1", content: "we good?" }));
    const loaded = await loadCoalescedQueue(file, Date.now());
    expect(loaded).toHaveLength(1);
    expect(loaded[0].content).toBe("we good?");
  });

  it("remove deletes one; removeQueuedAsks deletes many", async () => {
    await upsertQueuedAsk(file, ask({ messageId: "m1" }));
    await upsertQueuedAsk(file, ask({ messageId: "m2" }));
    await upsertQueuedAsk(file, ask({ messageId: "m3" }));
    await removeQueuedAsk(file, "m2");
    await removeQueuedAsks(file, ["m1", "unknown"]);
    const loaded = await loadCoalescedQueue(file, Date.now());
    expect(loaded.map((a) => a.messageId)).toEqual(["m3"]);
  });

  it("drops entries older than the stale window on load", async () => {
    const now = 10 * COALESCED_QUEUE_STALE_MS;
    await upsertQueuedAsk(file, ask({ messageId: "fresh", receivedAt: now - 1000 }));
    await upsertQueuedAsk(file, ask({ messageId: "stale", receivedAt: now - COALESCED_QUEUE_STALE_MS - 1 }));
    const loaded = await loadCoalescedQueue(file, now);
    expect(loaded.map((a) => a.messageId)).toEqual(["fresh"]);
  });

  it("missing file → empty, no throw", async () => {
    const loaded = await loadCoalescedQueue(join(dir, "does-not-exist.json"), Date.now());
    expect(loaded).toEqual([]);
  });

  it("corrupt file → empty, no throw", async () => {
    await writeFile(file, "{ not json", "utf8");
    const loaded = await loadCoalescedQueue(file, Date.now());
    expect(loaded).toEqual([]);
  });

  it("a bad row drops alone, valid rows survive", async () => {
    await upsertQueuedAsk(file, ask({ messageId: "ok" }));
    // Corrupt one entry directly in the file.
    const parsed = JSON.parse(await readFile(file, "utf8"));
    parsed.asks["bad"] = { messageId: "bad" }; // missing required fields
    await writeFile(file, JSON.stringify(parsed), "utf8");
    const loaded = await loadCoalescedQueue(file, Date.now());
    expect(loaded.map((a) => a.messageId)).toEqual(["ok"]);
  });

  it("writes the file with 0600 mode", async () => {
    await upsertQueuedAsk(file, ask());
    const s = await stat(file);
    expect(s.mode & 0o777).toBe(0o600);
  });
});
