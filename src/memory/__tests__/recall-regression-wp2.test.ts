/**
 * Memory overhaul WP2 (2026-10-25): recall regression with asserted floors.
 *
 * Each scenario from src/memory/eval/recall-regression.ts gets its own store
 * and workspace: the background corpus plus the scenario's planted fact are
 * written to disk, indexed by the real MemoryScanner (so the WP2 chunker is
 * exercised), saved memories go through MemoryStore.insert, and the query
 * runs through retrieveMemoryChunks with the production pre-turn arguments
 * (topK 5, 14-day window, 1500-token budget, the locked exclude-tag list).
 * The embedder is the hashed bag-of-words stand-in truncated to MiniLM's
 * 200 words, so the run is deterministic and needs no model.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryStore } from "../store.js";
import { MemoryScanner } from "../memory-scanner.js";
import { retrieveMemoryChunks } from "../memory-retrieval.js";
import { MINILM_MAX_WORDS } from "../embedder.js";
import { hashEmbed } from "../eval/hash-embedder.js";
import {
  PRODUCTION_EXCLUDE_TAGS,
  backgroundCorpus,
  scoreScenario,
  summarizeRegression,
  truncatingEmbedder,
  wp2RegressionScenarios,
  type RegressionScenario,
  type ScenarioScore,
} from "../eval/recall-regression.js";

const DAY = 86_400_000;
const log = { info() {}, warn() {}, debug() {}, error() {}, child() { return log; } } as never;
const embed = truncatingEmbedder(hashEmbed, MINILM_MAX_WORDS);

const roots: string[] = [];
const stores: MemoryStore[] = [];
const scores = new Map<string, ScenarioScore>();
const longSectionChunks: { heading: string | null; words: number; hasNeedle: boolean }[] = [];

async function runScenario(scenario: RegressionScenario, now: number): Promise<ScenarioScore> {
  const ws = mkdtempSync(join(tmpdir(), `wp2-recall-${scenario.name}-`));
  roots.push(ws);
  const store = new MemoryStore(":memory:");
  stores.push(store);
  const background = backgroundCorpus();
  for (const f of [...background.files, ...scenario.files]) {
    const abs = join(ws, "memory", f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
    const t = new Date(now - f.ageDays * DAY);
    utimesSync(abs, t, t);
  }
  await new MemoryScanner({ store, embed, log }, ws).backfill();
  for (const m of [...background.memories, ...scenario.memories]) {
    store.insert(
      {
        content: m.content,
        source: "manual",
        tags: m.tags ? [...m.tags] : [],
        ...(m.importance !== undefined ? { importance: m.importance } : {}),
        skipDedup: true,
      },
      await embed(m.content),
    );
  }
  if (scenario.name === "long-section") {
    const db = store.getDatabase();
    const rows = db
      .prepare("SELECT heading, body FROM memory_chunks WHERE path LIKE ? ORDER BY chunk_index")
      .all("%-1430.md") as { heading: string | null; body: string }[];
    for (const r of rows) {
      longSectionChunks.push({
        heading: r.heading,
        words: r.body.trim().split(/\s+/).length,
        hasNeedle: r.body.includes(scenario.needle),
      });
    }
  }
  const results = await retrieveMemoryChunks({
    query: scenario.query,
    store,
    embed,
    topK: 5,
    timeWindowDays: 14,
    tokenBudget: 1500,
    excludeTags: PRODUCTION_EXCLUDE_TAGS,
    agent: "wp2-eval",
    now,
  });
  return scoreScenario(scenario, results);
}

beforeAll(async () => {
  const now = Date.now();
  for (const scenario of wp2RegressionScenarios()) {
    scores.set(scenario.name, await runScenario(scenario, now));
  }
}, 120_000);

afterAll(() => {
  for (const s of stores) s.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("WP2 recall regression (planted facts, pre-turn path)", () => {
  it("covers the five WP2 scenarios", () => {
    expect([...scores.keys()]).toEqual([
      "envelope-query",
      "old-dated-note",
      "vault-vs-dated",
      "flush-flood",
      "long-section",
    ]);
  });

  for (const name of ["envelope-query", "old-dated-note", "vault-vs-dated", "flush-flood", "long-section"]) {
    it(`scenario ${name}: planted fact within its rank floor`, () => {
      const s = scores.get(name)!;
      if (!s.passed) console.info("wp2-recall miss", name, JSON.stringify(s));
      expect(s.problems).toEqual([]);
      expect(s.passed).toBe(true);
    });
  }

  // Floors. The run is deterministic; at the time of writing the ranks are
  // 1, 2, 1, 1, 4 (MRR 0.75). The MRR floor sits just under that so any
  // ranking regression in one scenario fails the build.
  it("floors: every planted fact returned, MRR >= 0.7", () => {
    const report = summarizeRegression([...scores.values()]);
    console.info(
      "wp2-recall summary",
      JSON.stringify({ passed: report.passed, recall: report.recall, mrr: report.mrr }),
      JSON.stringify(report.scenarios.map((s) => [s.name, s.rank])),
    );
    expect(report.recall).toBe(1);
    expect(report.passed).toBe(report.scenarios.length);
    expect(report.mrr).toBeGreaterThanOrEqual(0.7);
  });

  it("long-section: the 3,000-word section is indexed as parts that fit the embedder", () => {
    expect(longSectionChunks.length).toBeGreaterThanOrEqual(13);
    for (const c of longSectionChunks) {
      expect(c.heading).toMatch(/^Project Alpha notes \(part \d+\/\d+\)$/);
      expect(c.words).toBeLessThanOrEqual(220);
    }
    const withNeedle = longSectionChunks.filter((c) => c.hasNeedle);
    expect(withNeedle).toHaveLength(1);
    expect(withNeedle[0]!.heading).toBe(
      `Project Alpha notes (part ${longSectionChunks.length}/${longSectionChunks.length})`,
    );
  });
});
