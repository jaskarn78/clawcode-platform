/**
 * Phase 999.187 — owner facts: higher floor, and the lazy search sees them.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../store.js";
import { SharedFactsStore, SHARED_FACT_MIN_SIMILARITY, ownerFactsAsChunks } from "../shared-facts-store.js";
import { clawcodeMemorySearch } from "../tools/clawcode-memory-search.js";

function unit(axis: number, mix = 0): Float32Array {
  const v = new Float32Array(384);
  v[axis] = 1;
  if (mix) {
    v[(axis + 1) % 384] = mix;
    const n = Math.hypot(1, mix);
    v[axis] /= n;
    v[(axis + 1) % 384] /= n;
  }
  return v;
}

let tmp: string;
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("owner facts (999.187)", () => {
  it("the floor is 0.5: a 0.45-similar fact is dropped, a 0.9-similar one kept", () => {
    tmp = mkdtempSync(join(tmpdir(), "owner-facts-"));
    const shared = new SharedFactsStore(join(tmp, "shared.db"));
    shared.save({ owner: "owner_a", content: "prefers brief answers", sourceAgent: "shopping" }, unit(0));
    expect(SHARED_FACT_MIN_SIMILARITY).toBe(0.5);
    // cos(unit(0), unit(0, 2)) = 1/sqrt(5) ≈ 0.447 → below the floor.
    expect(ownerFactsAsChunks(shared, "owner_a", unit(0, 2))).toHaveLength(0);
    // cos(unit(0), unit(0, 0.5)) = 1/sqrt(1.25) ≈ 0.894 → kept.
    expect(ownerFactsAsChunks(shared, "owner_a", unit(0, 0.5)).map((c) => c.body)).toEqual(["prefers brief answers"]);
    shared.close();
  });

  it("clawcode_memory_search appends the owner's matching facts after the agent's own hits", async () => {
    tmp = mkdtempSync(join(tmpdir(), "owner-facts-"));
    const shared = new SharedFactsStore(join(tmp, "shared.db"));
    shared.save({ owner: "owner_a", content: "runs 40 miles a week", sourceAgent: "personal" }, unit(0));
    const store = new MemoryStore(":memory:");
    const q = unit(0);
    const res = await clawcodeMemorySearch(
      { query: "how much does owner_a run" },
      { store, embedder: { embed: async () => q }, agentName: "shopping", ownerFacts: { store: shared, owner: "owner_a", embed: async () => q } },
    );
    expect(res.hits.map((h) => h.snippet)).toEqual(["runs 40 miles a week"]);
    expect(res.hits[0]?.memoryId).toMatch(/^shared:/);
    // Another owner sees nothing.
    const other = await clawcodeMemorySearch(
      { query: "how much does owner_a run" },
      { store, embedder: { embed: async () => q }, agentName: "x", ownerFacts: { store: shared, owner: "client_a", embed: async () => q } },
    );
    expect(other.hits).toHaveLength(0);
    store.close();
    shared.close();
  });
});
