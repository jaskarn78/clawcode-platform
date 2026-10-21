/**
 * Phase 999.99 follow-up — RecurringScheduleStore tests.
 *
 * The durable backing for agent-created `schedule_recurring` schedules. The
 * load path MUST be fail-soft (a corrupt / version-skewed file can never block
 * daemon boot) and the write chain MUST NOT self-poison (one failed write
 * surfaces to its caller but never wedges subsequent add/cancel).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RecurringScheduleStore,
  type StoredRecurringSchedule,
} from "../recurring-schedule-store.js";

const ENTRY = (id: string, agent = "personal"): StoredRecurringSchedule => ({
  scheduleId: id,
  agentName: agent,
  cron: "*/18 * * * *",
  prompt: "regulate bedroom temp",
  createdAt: "2026-06-19T22:00:00.000Z",
});

let root: string;
function freshPath(): string {
  root = mkdtempSync(join(tmpdir(), "clawcode-recstore-"));
  return join(root, "recurring-schedules.json");
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("RecurringScheduleStore — load (fail-soft)", () => {
  it("missing file → [] (fresh first boot, no throw)", async () => {
    const store = new RecurringScheduleStore({ filePath: freshPath() });
    expect(await store.load()).toEqual([]);
  });

  it("corrupt JSON → [] (daemon must boot anyway)", async () => {
    const filePath = freshPath();
    writeFileSync(filePath, "{ this is not json");
    const store = new RecurringScheduleStore({ filePath });
    expect(await store.load()).toEqual([]);
  });

  it("invalid schema (wrong version) → []", async () => {
    const filePath = freshPath();
    writeFileSync(filePath, JSON.stringify({ version: 2, updatedAt: "", schedules: [] }));
    const store = new RecurringScheduleStore({ filePath });
    expect(await store.load()).toEqual([]);
  });

  it("a lone malformed entry is dropped (returns [] when it's the only one)", async () => {
    const filePath = freshPath();
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, updatedAt: "", schedules: [{ scheduleId: "x" }] }),
    );
    const store = new RecurringScheduleStore({ filePath });
    expect(await store.load()).toEqual([]);
  });

  it("drops ONLY the malformed entry and KEEPS the valid ones (per-entry resilience)", async () => {
    const filePath = freshPath();
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-06-19T22:00:00.000Z",
        schedules: [
          ENTRY("valid1"),
          { scheduleId: "broken", agentName: "personal" }, // missing cron/prompt/createdAt
          ENTRY("valid2"),
        ],
      }),
    );
    const store = new RecurringScheduleStore({ filePath });
    const loaded = await store.load();
    expect(loaded.map((s) => s.scheduleId).sort()).toEqual(["valid1", "valid2"]);
  });

  it("self-heals: a write after a partially-corrupt file preserves valid entries + the new one", async () => {
    const filePath = freshPath();
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: "",
        schedules: [ENTRY("keepme"), { scheduleId: "junk" }],
      }),
    );
    const store = new RecurringScheduleStore({ filePath });
    await store.add(ENTRY("added"));
    const ids = (await store.load()).map((s) => s.scheduleId).sort();
    expect(ids).toEqual(["added", "keepme"]); // junk dropped, keepme preserved
  });
});

describe("RecurringScheduleStore — add / remove", () => {
  it("add → load roundtrip persists the entry", async () => {
    const store = new RecurringScheduleStore({ filePath: freshPath() });
    await store.add(ENTRY("aaaa1111"));
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.scheduleId).toBe("aaaa1111");
    expect(loaded[0]!.cron).toBe("*/18 * * * *");
  });

  it("add upserts by scheduleId (same id replaces, no dupes)", async () => {
    const store = new RecurringScheduleStore({ filePath: freshPath() });
    await store.add(ENTRY("dup", "personal"));
    await store.add({ ...ENTRY("dup", "personal"), prompt: "updated" });
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.prompt).toBe("updated");
  });

  it("remove deletes by id; removing an absent id is a clean no-op", async () => {
    const store = new RecurringScheduleStore({ filePath: freshPath() });
    await store.add(ENTRY("keep"));
    await store.add(ENTRY("drop"));
    await store.remove("drop");
    expect((await store.load()).map((s) => s.scheduleId)).toEqual(["keep"]);
    await store.remove("never-existed"); // no throw
    expect((await store.load()).map((s) => s.scheduleId)).toEqual(["keep"]);
  });

  it("concurrent adds are serialized (no lost update)", async () => {
    const store = new RecurringScheduleStore({ filePath: freshPath() });
    await Promise.all([
      store.add(ENTRY("c1")),
      store.add(ENTRY("c2")),
      store.add(ENTRY("c3")),
    ]);
    const ids = (await store.load()).map((s) => s.scheduleId).sort();
    expect(ids).toEqual(["c1", "c2", "c3"]);
  });
});

describe("RecurringScheduleStore — write chain does NOT self-poison", () => {
  it("a failed write rejects to ITS caller but a subsequent write still succeeds", async () => {
    const filePath = freshPath();
    const store = new RecurringScheduleStore({ filePath });

    // Force the first write to fail: make `filePath` a NON-EMPTY directory so
    // the atomic `rename(tmp, filePath)` fails (can't replace a non-empty dir).
    mkdirSync(filePath);
    writeFileSync(join(filePath, "blocker"), "x");
    await expect(store.add(ENTRY("first"))).rejects.toThrow();

    // Clear the blocker; the NEXT op must succeed — proving the rejected op did
    // not poison the serialized write chain (the bug this guards against).
    rmSync(filePath, { recursive: true, force: true });
    await store.add(ENTRY("second"));
    expect((await store.load()).map((s) => s.scheduleId)).toEqual(["second"]);
  });
});
