/**
 * Phase 999.187 — standing notes never expire from retrieval.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyTimeWindowFilter, isStandingMemoryPath } from "../memory-chunks.js";
import { MemoryStore } from "../store.js";
import { retrieveMemoryChunks } from "../memory-retrieval.js";
import { clawcodeMemorySearch } from "../tools/clawcode-memory-search.js";

const DAY = 86_400_000;
const now = Date.UTC(2026, 8, 29);
const old = now - 60 * DAY;

describe("isStandingMemoryPath", () => {
  it("cue files, digests, vault, procedures and documents are standing", () => {
    expect(isStandingMemoryPath("/ws/memory/2026-07-01-remember-Ab_9.md")).toBe(true);
    expect(isStandingMemoryPath("/ws/memory/digests/weekly-2026-W27.md")).toBe(true);
    expect(isStandingMemoryPath("/ws/memory/vault/rules.md")).toBe(true);
    expect(isStandingMemoryPath("/ws/memory/procedures/deploy.md")).toBe(true);
    expect(isStandingMemoryPath("document:tax-2025")).toBe(true);
  });
  it("daily logs and flush files are dated", () => {
    expect(isStandingMemoryPath("/ws/memory/2026-07-01.md")).toBe(false);
    expect(isStandingMemoryPath("/ws/memory/2026-07-01-1430.md")).toBe(false);
    expect(isStandingMemoryPath("/ws/memory/2026-07-01-subagent-x.md")).toBe(false);
  });
});

describe("applyTimeWindowFilter (999.187)", () => {
  const chunks = [
    { path: "/ws/memory/2026-07-01-remember-Ab_9.md", file_mtime_ms: old },
    { path: "/ws/memory/digests/weekly-2026-W27.md", file_mtime_ms: old },
    { path: "/ws/memory/2026-07-01.md", file_mtime_ms: old },
    { path: "/ws/memory/2026-09-28.md", file_mtime_ms: now - DAY },
  ];
  it("keeps a 60-day-old cue file and digest; drops the 60-day-old daily log", () => {
    const paths = applyTimeWindowFilter(chunks, 14, now).map((c) => c.path);
    expect(paths).toContain("/ws/memory/2026-07-01-remember-Ab_9.md");
    expect(paths).toContain("/ws/memory/digests/weekly-2026-W27.md");
    expect(paths).toContain("/ws/memory/2026-09-28.md");
    expect(paths).not.toContain("/ws/memory/2026-07-01.md");
  });
  it("days <= 0 disables the window entirely", () => {
    expect(applyTimeWindowFilter(chunks, 0, now)).toHaveLength(4);
    expect(applyTimeWindowFilter(chunks, -1, now)).toHaveLength(4);
  });
});

describe("clawcode_memory_search reaches older context", () => {
  let store: MemoryStore;
  const vec = new Float32Array(384).fill(0.1);
  const embed = async (_q: string) => vec;
  beforeEach(() => {
    store = new MemoryStore(":memory:");
    store.insertMemoryChunk({
      path: "/ws/memory/2026-05-01.md",
      chunkIndex: 0,
      heading: "May decision",
      body: "we chose sqlite-vec over faiss",
      tokenCount: 8,
      scoreWeight: 0,
      fileMtimeMs: now - 150 * DAY,
      fileSha256: "a",
      embedding: vec,
    });
  });
  afterEach(() => store.close());

  // WP2 (2026-10-25): the pre-turn window is a soft multiplier by default,
  // so the only relevant note is returned even when it is old. This test
  // used to assert the pre-turn path returned nothing; the hard mode keeps
  // that behavior and is asserted below.
  it("the lazy tool and the soft pre-turn path both return a 150-day-old daily-log chunk; the hard window does not", async () => {
    const lazy = await clawcodeMemorySearch({ query: "sqlite-vec faiss" }, { store, embedder: { embed }, agentName: "a" });
    expect(lazy.hits.map((h) => h.heading)).toContain("May decision");
    const soft = await retrieveMemoryChunks({ query: "sqlite-vec faiss", store, embed, timeWindowDays: 14, now });
    expect(soft.map((r) => r.heading)).toEqual(["May decision"]);
    const hard = await retrieveMemoryChunks({
      query: "sqlite-vec faiss",
      store,
      embed,
      timeWindowDays: 14,
      timeWindowMode: "hard",
      now,
    });
    expect(hard).toHaveLength(0);
  });
});
