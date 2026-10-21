#!/usr/bin/env -S npx tsx
/**
 * Phase 999.187 — recall@K against a REAL agent memory DB with the real
 * embedder. Queries run against what the agent actually holds; `expect`
 * entries match as substrings of the hit heading, path or body.
 *
 *   npx tsx scripts/memory-recall-eval.ts <memories.db> <queries.json> [k]
 *
 * queries.json: { "queries": [ { "q": "…", "expect": ["substring", …] } ] }
 * Prints recall@K and MRR for the pre-turn (14-day) and lazy (all-time)
 * paths and lists every miss with what came back instead. Run it on a COPY
 * of the DB before and after a retrieval change; the store is opened
 * normally (the porter migration may rebuild the FTS index on first open).
 */
import { readFileSync } from "node:fs";
import { MemoryStore } from "../src/memory/store.js";
import { EmbeddingService } from "../src/memory/embedder.js";
import { retrieveMemoryChunks } from "../src/memory/memory-retrieval.js";
import { clawcodeMemorySearch } from "../src/memory/tools/clawcode-memory-search.js";

const [dbPath, queriesPath, kArg] = process.argv.slice(2);
if (!dbPath || !queriesPath) {
  console.error("usage: memory-recall-eval.ts <memories.db> <queries.json> [k]");
  process.exit(2);
}
const k = Number(kArg ?? 5);
const queries = (JSON.parse(readFileSync(queriesPath, "utf8")) as { queries: { q: string; expect: string[] }[] }).queries;
const store = new MemoryStore(dbPath);
const embedder = new EmbeddingService();
const embed = (q: string) => store.embedQuery(embedder, q);

type Hit = { heading: string | null; path: string; body: string };
async function score(name: string, run: (q: string) => Promise<readonly Hit[]>): Promise<void> {
  let hits = 0;
  let rr = 0;
  const misses: string[] = [];
  for (const q of queries) {
    const res = (await run(q.q)).slice(0, k);
    const rank = res.findIndex((h) =>
      q.expect.some((e) => `${h.heading ?? ""}\n${h.path}\n${h.body}`.toLowerCase().includes(e.toLowerCase())),
    );
    if (rank >= 0) {
      hits += 1;
      rr += 1 / (rank + 1);
    } else {
      misses.push(`  MISS "${q.q}" -> ${res.map((h) => h.heading ?? h.path).join(" | ")}`);
    }
  }
  console.log(`${name}: recall@${k}=${(hits / queries.length).toFixed(2)} mrr=${(rr / queries.length).toFixed(2)} (${hits}/${queries.length})`);
  for (const m of misses) console.log(m);
}

await score("pre-turn (14d)", async (q) =>
  (await retrieveMemoryChunks({ query: q, store, embed, topK: k, timeWindowDays: 14, tokenBudget: 4000 })).map((c) => ({
    heading: c.heading,
    path: c.path,
    body: c.body,
  })),
);
await score("lazy (all time)", async (q) =>
  (await clawcodeMemorySearch({ query: q, k }, { store, embedder, agentName: "eval" })).hits.map((h) => ({
    heading: h.heading ?? null,
    path: h.path ?? "",
    body: h.snippet,
  })),
);
store.close();
