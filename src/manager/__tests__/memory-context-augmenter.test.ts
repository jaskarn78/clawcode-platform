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
  it("wraps chunks in a <memory-context> block with heading + body", () => {
    const out = renderMemoryContext([chunk(), chunk({ heading: null, path: "memory:x", body: "b2" })]);
    expect(out).toContain('<memory-context source="hybrid-rrf" chunks="2">');
    expect(out).toContain("### Standing rule\nalways upload via Discord");
    expect(out).toContain("### memory:x\nb2"); // heading null → path fallback
    expect(out.endsWith("</memory-context>\n\n")).toBe(true);
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

  it("tracks cadence per-agent independently", async () => {
    const r = vi.fn(async () => [chunk()]);
    const aug = makeAug(r);
    expect((await aug.augment("a", "x")).startsWith("<memory-context")).toBe(true);
    expect((await aug.augment("b", "y")).startsWith("<memory-context")).toBe(true);
    // each agent's first turn refreshes
    expect(r).toHaveBeenCalledTimes(2);
  });
});
