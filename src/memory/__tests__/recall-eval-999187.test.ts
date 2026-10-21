/**
 * Phase 999.187 — recall eval. The first measurement of retrieval QUALITY
 * this repo has had (src/benchmarks measures latency; 999.119 ran one
 * offline self-retrieval check and never kept it).
 *
 * Deterministic: a hashed bag-of-words embedder stands in for MiniLM, so
 * vector search rewards token overlap and the eval runs in CI without the
 * model. It measures the pipeline (chunking, time window, FTS, fusion,
 * budget), not the embedding model. `scripts/memory-recall-eval.ts` runs
 * the same query format against a real agent DB with the real embedder.
 *
 * Two paths are scored:
 *   - pre-turn: retrieveMemoryChunks with the 14-day window (what lands in
 *     <memory-context>). Queries marked lazyOnly are excluded here: their
 *     answers are >14 days old by design and belong to the lazy path.
 *   - lazy: clawcode_memory_search (unwindowed, k=5).
 * Floors are asserted so a regression in any stage fails the build.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryStore } from "../store.js";
import { MemoryScanner } from "../memory-scanner.js";
import { retrieveMemoryChunks } from "../memory-retrieval.js";
import { clawcodeMemorySearch } from "../tools/clawcode-memory-search.js";
import { hashEmbed } from "../eval/hash-embedder.js";
import { scoreRecall, type EvalFixture } from "../eval/recall-eval.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/recall-eval.json", import.meta.url), "utf8"),
) as EvalFixture;
const DAY = 86_400_000;
const log = { info() {}, warn() {}, debug() {}, error() {}, child() { return log; } } as never;

let tmp: string;
let store: MemoryStore;
const memoryIds = new Map<string, string>();

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "recall-eval-"));
  store = new MemoryStore(":memory:");
  const now = Date.now();
  for (const f of fixture.files) {
    const abs = join(tmp, "memory", f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
    const t = new Date(now - f.ageDays * DAY);
    utimesSync(abs, t, t);
  }
  const scanner = new MemoryScanner({ store, embed: hashEmbed, log }, tmp);
  await scanner.backfill();
  for (const m of fixture.memories) {
    const e = store.insert(
      { content: m.content, source: "manual", tags: m.tags, skipDedup: true },
      await hashEmbed(m.content),
    );
    memoryIds.set(m.key, e.id);
  }
});
afterAll(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("recall eval (999.187)", () => {
  it("pre-turn path: recall@5 >= 0.9 on in-window queries", async () => {
    const report = await scoreRecall(fixture, {
      k: 5,
      memoryIds,
      run: (q) =>
        retrieveMemoryChunks({ query: q, store, embed: hashEmbed, topK: 5, timeWindowDays: 14, tokenBudget: 4000 }),
      include: (q) => !q.lazyOnly,
    });
    console.info("recall-eval pre-turn", JSON.stringify(report.summary), JSON.stringify(report.misses));
    expect(report.summary.recallAtK).toBeGreaterThanOrEqual(0.9);
  });

  it("lazy path: recall@5 >= 0.9 on every query, including >14-day standing notes and digests", async () => {
    const report = await scoreRecall(fixture, {
      k: 5,
      memoryIds,
      run: async (q) =>
        (await clawcodeMemorySearch({ query: q, k: 5 }, { store, embedder: { embed: hashEmbed }, agentName: "eval" })).hits.map(
          (h) => ({ chunkId: h.memoryId, heading: h.heading ?? null, path: h.path ?? "", source: h.source }),
        ),
    });
    console.info("recall-eval lazy", JSON.stringify(report.summary), JSON.stringify(report.misses));
    expect(report.summary.recallAtK).toBeGreaterThanOrEqual(0.9);
  });
});
