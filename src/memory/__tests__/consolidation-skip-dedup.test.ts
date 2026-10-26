/**
 * Memory overhaul 2026-10-25 (WP5) - consolidation digests are inserted with
 * skipDedup. Before, a digest whose embedding landed near an existing
 * memory merged into it (the reproduced trace break: a manual memory's
 * text was replaced by digest text). Under the non-destructive dedup it
 * would instead be dropped or retire the older memory; either way the
 * digest must simply be stored next to what exists.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../store.js";
import type { EmbeddingService } from "../embedder.js";
import { writeWeeklyDigest, writeMonthlyDigest, type ConsolidationDeps } from "../consolidation.js";

function axis(i: number): Float32Array {
  const v = new Float32Array(384);
  v[i] = 1;
  return v;
}

describe("consolidation digests skip dedup", () => {
  let dir: string;
  let store: MemoryStore;

  afterEach(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function deps(): ConsolidationDeps {
    dir = mkdtempSync(join(tmpdir(), "wp5-digest-"));
    store = new MemoryStore(":memory:");
    return {
      memoryDir: dir,
      memoryStore: store,
      // Every digest embeds identically to the manual memory below.
      embedder: { embed: async () => axis(0) } as unknown as EmbeddingService,
      summarize: async () => "unused",
    };
  }

  it("weekly and monthly digests never touch an identical-vector manual memory", async () => {
    const d = deps();
    const manual = store.insert(
      { content: "Operator prefers brief answers", source: "manual", tags: ["preference"] },
      axis(0),
    );

    await writeWeeklyDigest(
      d,
      { year: 2026, week: 5, startDate: "2026-01-26", endDate: "2026-02-01", files: ["2026-01-26.md"] },
      "## Key Facts\n- weekly digest text",
    );
    await writeMonthlyDigest(d, { year: 2026, month: 1, digestFiles: ["weekly-2026-W05.md"] }, "## Summary\nmonthly text");

    const rows = store.listRecent(10);
    expect(rows).toHaveLength(3);
    const kept = store.peekById(manual.id);
    expect(kept?.content).toBe("Operator prefers brief answers");
    expect([...(kept?.tags ?? [])]).toEqual(["preference"]);
    expect(kept?.supersededBy).toBeUndefined();
    expect(rows.filter((r) => r.source === "consolidation").map((r) => r.tags[0]).sort()).toEqual([
      "monthly-digest",
      "weekly-digest",
    ]);
  });
});
