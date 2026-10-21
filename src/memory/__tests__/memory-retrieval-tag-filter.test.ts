/**
 * Phase 115 sub-scope 4 — verify `retrieveMemoryChunks` filters memories
 * whose tags intersect the configured `excludeTags` list before RRF fusion.
 *
 * Locked invariants:
 *   - Default `excludeTags: []` (parameter omitted) returns ALL memories
 *     including session-summary / mid-session / raw-fallback (legacy
 *     pre-115 behavior — no filter active).
 *   - Locked tag list ["session-summary","mid-session","raw-fallback"]
 *     drops memories tagged with ANY of those values; preserves
 *     "manual" / "episode" / untagged memories.
 *   - The chunks-side ranker is untouched — only memories-side filters
 *     fire (memory_chunks rows from MEMORY.md don't carry these tags).
 *   - When the filter drops ≥1 row, the diagnostic log fires with
 *     {action,agent,dropped,excludeTags}.
 *   - The memory-side filter happens AFTER hydration (using tags already
 *     returned by getMemoryForRetrieval) — no extra DB query, no N+1.
 *
 * Strategy: insert memories with various tag sets, run retrieve with
 * different excludeTags configurations, assert the surviving set.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryStore } from "../store.js";
import { retrieveMemoryChunks } from "../memory-retrieval.js";

let store: MemoryStore;

// Deterministic 384-dim embedder shared across query + all memories so
// vec-search returns ALL memories at uniform distance (filter-by-tag is
// the discriminator, not vec rank).
const FIXED_VEC = new Float32Array(384).fill(0.1);
const embed = async (_text: string): Promise<Float32Array> => FIXED_VEC;

beforeEach(() => {
  store = new MemoryStore(":memory:");
});

afterEach(() => {
  store.close();
});

/** Insert a memory with the given tags and content, returning its id. */
function seedMemory(content: string, tags: readonly string[]): string {
  const entry = store.insert(
    { content, source: "manual", tags, skipDedup: true },
    FIXED_VEC,
  );
  return entry.id;
}

describe("Phase 115 sub-scope 4 — retrieveMemoryChunks excludeTags filter", () => {
  it("default empty excludeTags returns ALL memories (legacy behavior)", async () => {
    seedMemory("memory tagged session-summary content", ["session-summary"]);
    seedMemory("memory tagged manual content", ["manual"]);
    seedMemory("memory tagged episode content", ["episode"]);

    const out = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 10,
      timeWindowDays: 14,
      // excludeTags omitted → filter disabled
    });
    // All 3 memories survive; chunks side has no rows so only memories
    // appear in the result.
    expect(out.length).toBe(3);
    const bodies = out.map((r) => r.body).sort();
    expect(bodies).toEqual([
      "memory tagged episode content",
      "memory tagged manual content",
      "memory tagged session-summary content",
    ]);
    // All sourced from `memory` (no chunks seeded).
    expect(out.every((r) => r.source === "memory")).toBe(true);
  });

  it("locked Phase 115 list drops session-summary / mid-session / raw-fallback memories", async () => {
    seedMemory("session-summary body", ["session-summary"]);
    seedMemory("mid-session body", ["mid-session"]);
    seedMemory("raw-fallback body", ["raw-fallback"]);
    seedMemory("manual body", ["manual"]);
    seedMemory("episode body", ["episode"]);

    const out = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 10,
      timeWindowDays: 14,
      excludeTags: ["session-summary", "mid-session", "raw-fallback"],
    });
    // 3 dropped, 2 survive.
    expect(out.length).toBe(2);
    const bodies = out.map((r) => r.body).sort();
    expect(bodies).toEqual(["episode body", "manual body"]);
  });

  it("memory tagged with BOTH excluded AND non-excluded tags is dropped", async () => {
    // Defensive: a memory with mixed tags MUST be dropped if ANY tag
    // intersects the exclusion list. Pollution-feedback semantics.
    seedMemory("mixed tags body", ["manual", "session-summary"]);
    seedMemory("clean body", ["manual"]);

    const out = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 10,
      timeWindowDays: 14,
      excludeTags: ["session-summary"],
    });
    expect(out.length).toBe(1);
    expect(out[0].body).toBe("clean body");
  });

  it("untagged memories survive any excludeTags configuration", async () => {
    seedMemory("untagged body", []);
    seedMemory("excluded body", ["session-summary"]);

    const out = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 10,
      timeWindowDays: 14,
      excludeTags: ["session-summary", "mid-session", "raw-fallback"],
    });
    expect(out.length).toBe(1);
    expect(out[0].body).toBe("untagged body");
  });

  it("explicit empty excludeTags array disables filtering (operator opt-out)", async () => {
    seedMemory("session-summary body", ["session-summary"]);
    seedMemory("manual body", ["manual"]);

    const out = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 10,
      timeWindowDays: 14,
      excludeTags: [], // operator explicitly opted out per-agent
    });
    expect(out.length).toBe(2);
  });

  it("custom excludeTags list (operator override) drops only listed tags", async () => {
    seedMemory("session-summary body", ["session-summary"]);
    seedMemory("archived body", ["archived-pending"]);
    seedMemory("manual body", ["manual"]);

    // Operator extends the default with a custom tag.
    const out = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 10,
      timeWindowDays: 14,
      excludeTags: ["archived-pending"],
    });
    expect(out.length).toBe(2);
    const bodies = out.map((r) => r.body).sort();
    expect(bodies).toEqual(["manual body", "session-summary body"]);
  });

  it("emits [diag] phase115-tag-filter log when ≥1 row dropped", async () => {
    seedMemory("dropped body", ["session-summary"]);
    seedMemory("kept body", ["manual"]);

    const debug = vi.fn();
    await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 10,
      timeWindowDays: 14,
      excludeTags: ["session-summary"],
      log: { debug },
      agent: "test-agent",
    });
    expect(debug).toHaveBeenCalledTimes(1);
    const [obj, msg] = debug.mock.calls[0];
    expect(obj).toMatchObject({
      action: "phase115-tag-filter",
      agent: "test-agent",
      dropped: 1,
      excludeTags: ["session-summary"],
    });
    expect(msg).toContain("phase115-tag-filter");
  });

  it("does NOT log when zero rows dropped (no false positives)", async () => {
    seedMemory("kept body", ["manual"]);

    const debug = vi.fn();
    await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 10,
      timeWindowDays: 14,
      excludeTags: ["session-summary", "mid-session", "raw-fallback"],
      log: { debug },
      agent: "test-agent",
    });
    expect(debug).not.toHaveBeenCalled();
  });

  it("filter is independent of token budget (filter applies before truncation)", async () => {
    // Fill with mostly-excluded memories + 1 keeper. Then squeeze the
    // budget. The keeper MUST appear regardless — filter drops happen
    // BEFORE the cumulative-chars cap.
    for (let i = 0; i < 5; i++) {
      seedMemory(`session-summary entry ${i}`.padEnd(2000, "x"), ["session-summary"]);
    }
    seedMemory("the one keeper".padEnd(100, "x"), ["manual"]);

    const out = await retrieveMemoryChunks({
      query: "anything",
      store,
      embed,
      topK: 10,
      timeWindowDays: 14,
      tokenBudget: 100, // tight cap
      excludeTags: ["session-summary"],
    });
    // The 5 session-summary memories were dropped before the budget
    // pass even ran on them. The single keeper survives via the
    // always-emit-first-chunk guard.
    expect(out.length).toBe(1);
    expect(out[0].body.startsWith("the one keeper")).toBe(true);
  });
});
