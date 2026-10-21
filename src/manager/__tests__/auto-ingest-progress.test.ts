/**
 * P2-PROGRESS — AutoIngestProgress unit tests.
 *
 * Most cases drive a fake editor (asserts the counting + finalize logic). The
 * last case drives a REAL ProgressiveMessageEditor (asserts the requirement: the
 * message ends at ✅ N/N and a coalesced "k/N" never lands after the flush).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import {
  AutoIngestProgress,
  type ProgressEditor,
} from "../auto-ingest-progress.js";
import { ProgressiveMessageEditor } from "../../discord/streaming.js";

const log = pino({ level: "silent" });

/** Fake editor — `flush()` takes no arg (mirrors ProgressiveMessageEditor); the
 *  "displayed" content is the latest `update()` text. */
class FakeEditor implements ProgressEditor {
  updates: string[] = [];
  flushCount = 0;
  update(text: string): void {
    this.updates.push(text);
  }
  async flush(): Promise<void> {
    this.flushCount += 1;
  }
  get displayed(): string | null {
    return this.updates.length ? this.updates[this.updates.length - 1]! : null;
  }
}

function done(channelId: string, messageId: string, ok = true) {
  return { channelId, messageId, ok };
}

describe("AutoIngestProgress", () => {
  it("seeds 0/N, edits in place, and finalizes to ✅ N/N", () => {
    const p = new AutoIngestProgress({ logger: log });
    const ed = new FakeEditor();
    p.seedBatch("c1", "m1", 12, ed);
    expect(ed.updates[0]).toBe("📥 Ingesting 0/12 files…");
    expect(p.activeBatches).toBe(1);

    for (let i = 0; i < 12; i++) p.onItemDone(done("c1", "m1"));

    expect(ed.updates).toContain("📥 Ingesting 11/12 files…");
    expect(ed.displayed).toBe("✅ Ingested 12/12 files"); // final content
    expect(ed.flushCount).toBe(1);
    expect(p.activeBatches).toBe(0); // evicted
  });

  it("counts failed items toward processed (never-drop retries via rescan)", () => {
    const p = new AutoIngestProgress({ logger: log });
    const ed = new FakeEditor();
    p.seedBatch("c1", "m1", 2, ed);
    p.onItemDone(done("c1", "m1", false));
    p.onItemDone(done("c1", "m1", true));
    expect(ed.displayed).toBe("✅ Ingested 2/2 files");
    expect(ed.flushCount).toBe(1);
  });

  it("ignores items with empty channel/message ids (rescan-recovered)", () => {
    const p = new AutoIngestProgress({ logger: log });
    const ed = new FakeEditor();
    p.seedBatch("c1", "m1", 3, ed);
    p.onItemDone(done("", ""));
    p.onItemDone(done("c1", "m1"));
    expect(ed.displayed).toBe("📥 Ingesting 1/3 files…"); // only the real item counted
    expect(ed.flushCount).toBe(0); // still 1/3, not finalized
  });

  it("ignores items for an unknown batch key", () => {
    const p = new AutoIngestProgress({ logger: log });
    const ed = new FakeEditor();
    p.seedBatch("c1", "m1", 2, ed);
    p.onItemDone(done("c1", "OTHER"));
    expect(ed.updates).toEqual(["📥 Ingesting 0/2 files…"]); // untouched
    expect(ed.flushCount).toBe(0);
  });

  it("does not seed below the >=2 threshold", () => {
    const p = new AutoIngestProgress({ logger: log });
    const ed = new FakeEditor();
    p.seedBatch("c1", "m1", 1, ed);
    expect(ed.updates).toEqual([]);
    expect(p.activeBatches).toBe(0);
  });

  it("ignores a duplicate seed for the same key", () => {
    const p = new AutoIngestProgress({ logger: log });
    const ed1 = new FakeEditor();
    const ed2 = new FakeEditor();
    p.seedBatch("c1", "m1", 2, ed1);
    p.seedBatch("c1", "m1", 2, ed2); // dup — ignored
    expect(ed2.updates).toEqual([]);
    expect(p.activeBatches).toBe(1);
  });

  it("does not double-finalize when a late item arrives after completion", () => {
    const p = new AutoIngestProgress({ logger: log });
    const ed = new FakeEditor();
    p.seedBatch("c1", "m1", 2, ed);
    p.onItemDone(done("c1", "m1"));
    p.onItemDone(done("c1", "m1")); // finalizes
    expect(ed.flushCount).toBe(1);
    p.onItemDone(done("c1", "m1")); // late/stray — ignored (batch evicted)
    expect(ed.flushCount).toBe(1);
    expect(ed.displayed).toBe("✅ Ingested 2/2 files");
  });

  describe("partial finalize via inactivity timer", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("finalizes a stalled (overflow-deferred) batch with truthful wording", () => {
      const p = new AutoIngestProgress({ logger: log, idleTimeoutMs: 1000 });
      const ed = new FakeEditor();
      p.seedBatch("c1", "m1", 12, ed);
      for (let i = 0; i < 10; i++) p.onItemDone(done("c1", "m1")); // 10/12
      expect(ed.flushCount).toBe(0);

      vi.advanceTimersByTime(1001);

      expect(ed.displayed).toBe(
        "✅ Ingested 10/12 files (rest queued — finishing in the background)",
      );
      expect(ed.flushCount).toBe(1);
      expect(p.activeBatches).toBe(0); // TTL evicted
    });

    it("activity resets the timer (no premature finalize)", () => {
      const p = new AutoIngestProgress({ logger: log, idleTimeoutMs: 1000 });
      const ed = new FakeEditor();
      p.seedBatch("c1", "m1", 4, ed);
      vi.advanceTimersByTime(800);
      p.onItemDone(done("c1", "m1")); // resets timer
      vi.advanceTimersByTime(800);
      expect(ed.flushCount).toBe(0);
      vi.advanceTimersByTime(300);
      expect(ed.flushCount).toBe(1);
      expect(ed.displayed).toBe(
        "✅ Ingested 1/4 files (rest queued — finishing in the background)",
      );
    });
  });

  describe("real ProgressiveMessageEditor integration", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("message ends at ✅ N/N (never a stale k/N), and rapid updates coalesce", async () => {
      const sent: string[] = [];
      const editor = new ProgressiveMessageEditor({
        editFn: async (content: string) => {
          sent.push(content);
        },
        editIntervalMs: 1500,
        log,
      });
      const p = new AutoIngestProgress({ logger: log });
      p.seedBatch("c1", "m1", 12, editor);
      for (let i = 0; i < 12; i++) p.onItemDone(done("c1", "m1"));

      // Drain the editor's throttle timer + in-flight serialization chain.
      await vi.runAllTimersAsync();

      // The decisive assertion: the FINAL content the editFn received is ✅,
      // not a stale "k/N" (which would happen if flush didn't win / ignored arg).
      expect(sent.at(-1)).toBe("✅ Ingested 12/12 files");
      // Coalescing: the throttle merged the middle increments (far fewer than 13).
      expect(sent.length).toBeLessThan(13);
      expect(sent).not.toContain("📥 Ingesting 12/12 files…"); // ✅ line, not a "12/12" progress line
    });
  });
});
