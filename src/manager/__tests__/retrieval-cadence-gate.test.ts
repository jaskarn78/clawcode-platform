/**
 * Phase 999.187 — retrieval cadence: K turns OR a topic shift.
 */
import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";
import { MemoryContextAugmenter, RetrievalCadenceGate, TOPIC_SHIFT_MIN_COSINE } from "../memory-context-augmenter.js";

const silent = { warn() {}, info() {}, error() {}, debug() {} } as unknown as Logger;

function axis(i: number): Float32Array {
  const v = new Float32Array(384);
  v[i] = 1;
  return v;
}
/** "topic A" → axis 0, "topic B" → axis 1, everything else → axis 0. */
const embedByTopic = async (q: string) => (q.includes("topic B") ? axis(1) : axis(0));

describe("RetrievalCadenceGate", () => {
  it("without an embedder it is the pre-999.187 rule: turns 1, 4, 7 …", async () => {
    const g = new RetrievalCadenceGate();
    const out: boolean[] = [];
    for (let i = 0; i < 7; i++) out.push((await g.shouldRefresh("a", `q${i}`)).refresh);
    expect(out).toEqual([true, false, false, true, false, false, true]);
  });

  it("refreshes on turn 2 when the query drifts to another topic", async () => {
    const g = new RetrievalCadenceGate(embedByTopic);
    expect((await g.shouldRefresh("a", "topic A please")).reason).toBe("first");
    expect((await g.shouldRefresh("a", "more on topic A")).reason).toBe("hold");
    const shift = await g.shouldRefresh("a", "now about topic B");
    expect(shift).toEqual({ refresh: true, reason: "topic-shift" });
    // The shift resets the reference: staying on B holds again.
    expect((await g.shouldRefresh("a", "still topic B")).reason).toBe("hold");
  });

  it("the cadence cap still applies on a stable topic", async () => {
    const g = new RetrievalCadenceGate(embedByTopic);
    await g.shouldRefresh("a", "topic A");
    await g.shouldRefresh("a", "topic A");
    await g.shouldRefresh("a", "topic A");
    expect((await g.shouldRefresh("a", "topic A")).reason).toBe("cadence");
  });

  it("an embedder failure falls back to the K-turn rule (hold)", async () => {
    const g = new RetrievalCadenceGate(async () => {
      throw new Error("model not loaded");
    });
    expect((await g.shouldRefresh("a", "x")).refresh).toBe(true);
    expect((await g.shouldRefresh("a", "y")).refresh).toBe(false);
  });

  it("state is per agent", async () => {
    const g = new RetrievalCadenceGate(embedByTopic);
    await g.shouldRefresh("a", "topic A");
    expect((await g.shouldRefresh("b", "topic B")).reason).toBe("first");
  });

  it("WP2: compares the user's words, not the shared Discord envelope", async () => {
    const seen: string[] = [];
    const g = new RetrievalCadenceGate(async (q) => {
      seen.push(q);
      return embedByTopic(q);
    });
    const wrap = (text: string, id: string) =>
      `<channel source="discord" chat_id="000000000000000001" message_id="${id}" user="jas" ts="2026-10-25 09:14 PDT">\n${text}\n</channel>`;
    expect((await g.shouldRefresh("a", wrap("topic A please", "1"))).reason).toBe("first");
    expect((await g.shouldRefresh("a", wrap("now about topic B", "2"))).reason).toBe("topic-shift");
    expect(seen).toEqual(["topic A please", "now about topic B"]);
  });

  it("WP2: an envelope with no words never reaches the embedder", async () => {
    const embed = vi.fn(embedByTopic);
    const g = new RetrievalCadenceGate(embed);
    await g.shouldRefresh("a", "topic A");
    const verdict = await g.shouldRefresh("a", '<channel source="discord" user="jas" ts="t">\n</channel>');
    expect(verdict.reason).toBe("hold");
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("exports the threshold", () => {
    expect(TOPIC_SHIFT_MIN_COSINE).toBe(0.75);
  });
});

describe("MemoryContextAugmenter with a query embedder", () => {
  it("injects a fresh block on a topic shift at turn 2", async () => {
    const retriever = vi.fn(async (_a: string, q: string) => [
      { chunkId: "c", path: "p", heading: q, body: "b", fusedScore: 1, scoreWeight: 0, source: "chunk" as const },
    ]);
    const aug = new MemoryContextAugmenter({ retriever, log: silent, queryEmbedder: embedByTopic });
    expect(await aug.augment("a", "topic A")).toContain("<memory-context");
    expect(await aug.augment("a", "topic A again")).toBe("topic A again");
    expect(await aug.augment("a", "switch to topic B")).toContain("### switch to topic B");
    expect(retriever).toHaveBeenCalledTimes(2);
  });
});
