import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";

import {
  MemoryContextAugmenter,
  renderMemoryContext,
  type MemoryRetriever,
} from "../memory-context-augmenter.js";
import type { MemoryRetrievalResult } from "../../memory/memory-retrieval.js";

const silent = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

function chunk(
  over: Partial<MemoryRetrievalResult> = {},
): MemoryRetrievalResult {
  return {
    chunkId: "c1",
    path: "MEMORY.md",
    heading: "Standing rule",
    body: "always upload via Discord",
    fusedScore: 1,
    scoreWeight: 0,
    source: "chunk",
    ...over,
  } as MemoryRetrievalResult;
}

describe("renderMemoryContext (Phase 141)", () => {
  // WP2 (2026-10-25): headings now carry "(<kind>, <YYYY-MM-DD>)"; this test
  // used to assert the bare "### <heading>" form.
  it("wraps chunks in a <memory-context> block with heading + provenance + body", () => {
    const out = renderMemoryContext([chunk(), chunk({ heading: null, path: "memory:x", body: "b2" })]);
    expect(out).toContain('<memory-context source="hybrid-rrf" chunks="2">');
    expect(out).toContain("### Standing rule (chunk)\nalways upload via Discord");
    expect(out).toContain("### memory:x (chunk)\nb2"); // heading null → path fallback
    expect(out.endsWith("</memory-context>\n\n")).toBe(true);
  });

  it("WP2: renders '### <heading or path> (<kind>, <YYYY-MM-DD>)' for every source kind", () => {
    const out = renderMemoryContext([
      chunk({
        chunkId: "m1",
        path: "memory:m1",
        heading: null,
        source: "memory",
        sourceKind: "memory",
        createdAt: "2026-10-19T17:14:22.000Z",
        body: "staging migrations need a snapshot first",
      }),
      chunk({
        path: "/ws/memory/2026-10-12.md",
        heading: "17:14:22 [user]",
        sourceKind: "chunk",
        fileMtimeMs: Date.UTC(2026, 9, 12, 18),
        body: "daily log line",
      }),
      chunk({
        path: "document:invoice-123",
        heading: null,
        sourceKind: "document",
        fileMtimeMs: Date.UTC(2026, 9, 1, 9),
        body: "Total due 4,210.00",
      }),
      chunk({
        chunkId: "shared:f1",
        path: "shared-facts",
        heading: "Owner fact (shared by web)",
        sourceKind: "shared",
        createdAt: "2026-09-30T08:00:00.000Z",
        body: "prefers short replies",
      }),
    ]);
    expect(out).toContain("### memory:m1 (memory, 2026-10-19)\nstaging migrations need a snapshot first");
    expect(out).toContain("### 17:14:22 [user] (chunk, 2026-10-12)\ndaily log line");
    expect(out).toContain("### document:invoice-123 (document, 2026-10-01)\nTotal due 4,210.00");
    expect(out).toContain("### Owner fact (shared by web) (shared, 2026-09-30)\nprefers short replies");
  });

  it("WP2: falls back to a path-derived kind when a result has no sourceKind", () => {
    const out = renderMemoryContext([
      chunk({ chunkId: "m9", path: "memory:m9", heading: null, source: "memory", createdAt: "2026-10-02T00:00:00.000Z" }),
      chunk({ path: "document:q2", heading: "Fees" }),
      chunk({ chunkId: "shared:z", path: "shared-facts", heading: "Owner fact" }),
    ]);
    expect(out).toContain("### memory:m9 (memory, 2026-10-02)");
    expect(out).toContain("### Fees (document)");
    expect(out).toContain("### Owner fact (shared)");
  });
});

describe("MemoryContextAugmenter (Phase 141)", () => {
  const makeAug = (retriever: MemoryRetriever) =>
    new MemoryContextAugmenter({ retriever, log: silent });

  it("prepends the memory-context block on the first turn", async () => {
    const aug = makeAug(async () => [chunk()]);
    const out = await aug.augment("agent", "what's the rule?");
    expect(out.startsWith('<memory-context')).toBe(true);
    expect(out.endsWith("what's the rule?")).toBe(true);
  });

  it("returns the message unchanged for an empty query", async () => {
    const r = vi.fn(async () => [chunk()]);
    const aug = makeAug(r);
    expect(await aug.augment("agent", "   ")).toBe("   ");
    expect(r).not.toHaveBeenCalled();
  });

  it("returns the message unchanged when retrieval finds nothing", async () => {
    const aug = makeAug(async () => []);
    expect(await aug.augment("agent", "hi")).toBe("hi");
  });

  it("is FAIL-OPEN — a retriever error yields the original message", async () => {
    const aug = makeAug(async () => {
      throw new Error("retriever down");
    });
    expect(await aug.augment("agent", "hi")).toBe("hi");
  });

  it("cadence-gates: refresh on turn 1, skip 2-3, refresh on turn 4", async () => {
    const r = vi.fn(async () => [chunk()]);
    const aug = makeAug(r);
    const t1 = await aug.augment("agent", "m1");
    const t2 = await aug.augment("agent", "m2");
    const t3 = await aug.augment("agent", "m3");
    const t4 = await aug.augment("agent", "m4");
    expect(t1.startsWith("<memory-context")).toBe(true); // refresh
    expect(t2).toBe("m2"); // skip
    expect(t3).toBe("m3"); // skip
    expect(t4.startsWith("<memory-context")).toBe(true); // refresh (every 3)
    expect(r).toHaveBeenCalledTimes(2); // only the refresh turns retrieve
  });

  it("WP2: retrieves on the user's words, not the Discord <channel> envelope", async () => {
    const r = vi.fn(async (_a: string, _q: string) => [chunk()]);
    const embed = vi.fn(async (_q: string) => new Float32Array([1, 0, 0]));
    const aug = new MemoryContextAugmenter({ retriever: r, log: silent, queryEmbedder: embed });
    const wrapped =
      '<channel source="discord" chat_id="000000000000000001" message_id="1433000000000000000" user="jas" ts="2026-10-25 09:14 PDT">\n' +
      "is it safe to run the migration on staging?\n" +
      "</channel>";
    const out = await aug.augment("agent", wrapped);
    expect(out.endsWith(wrapped)).toBe(true); // the message itself is untouched
    expect(r).toHaveBeenCalledWith("agent", "is it safe to run the migration on staging?");
    expect(embed).toHaveBeenCalledWith("is it safe to run the migration on staging?");
    for (const [q] of embed.mock.calls) expect(q).not.toContain("<channel");
  });

  it("WP2: an envelope with no user words is treated as an empty query", async () => {
    const r = vi.fn(async () => [chunk()]);
    const aug = makeAug(r);
    const empty = '<channel source="discord" chat_id="1" message_id="2" user="jas" ts="t">\n\n</channel>';
    expect(await aug.augment("agent", empty)).toBe(empty);
    expect(r).not.toHaveBeenCalled();
  });

  it("tracks cadence per-agent independently", async () => {
    const r = vi.fn(async () => [chunk()]);
    const aug = makeAug(r);
    expect((await aug.augment("a", "x")).startsWith("<memory-context")).toBe(true);
    expect((await aug.augment("b", "y")).startsWith("<memory-context")).toBe(true);
    // each agent's first turn refreshes
    expect(r).toHaveBeenCalledTimes(2);
  });
});
