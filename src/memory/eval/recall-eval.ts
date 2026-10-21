/**
 * Phase 999.187 — recall@K scorer shared by the CI eval
 * (src/memory/__tests__/recall-eval-999187.test.ts) and the on-box script
 * (scripts/memory-recall-eval.ts). Pure: the caller supplies `run`.
 */

export interface EvalFile {
  readonly path: string;
  readonly ageDays: number;
  readonly content: string;
}
export interface EvalMemory {
  readonly key: string;
  readonly content: string;
  readonly tags?: readonly string[];
}
export interface EvalQuery {
  readonly q: string;
  /** Chunk headings (files) or memory keys that count as a hit. Any one suffices. */
  readonly expect: readonly string[];
  /** The answer is older than the pre-turn window by design; skip on that path. */
  readonly lazyOnly?: boolean;
}
export interface EvalFixture {
  readonly files: readonly EvalFile[];
  readonly memories: readonly EvalMemory[];
  readonly queries: readonly EvalQuery[];
}

export interface EvalHit {
  readonly chunkId: string;
  readonly heading: string | null;
  readonly path: string;
  readonly source: "chunk" | "memory";
}

export interface RecallReport {
  readonly summary: {
    readonly queries: number;
    readonly hits: number;
    readonly recallAtK: number;
    readonly mrr: number;
  };
  readonly misses: readonly {
    readonly q: string;
    readonly expect: readonly string[];
    readonly got: readonly string[];
  }[];
}

export async function scoreRecall(
  fixture: EvalFixture,
  opts: {
    readonly k: number;
    /** memory key → id, so a query can expect a saved memory. */
    readonly memoryIds: ReadonlyMap<string, string>;
    readonly run: (query: string) => Promise<readonly EvalHit[]>;
    readonly include?: (q: EvalQuery) => boolean;
  },
): Promise<RecallReport> {
  const idToKey = new Map<string, string>();
  for (const [key, id] of opts.memoryIds) idToKey.set(id, key);
  const queries = fixture.queries.filter((q) => (opts.include ? opts.include(q) : true));
  let hits = 0;
  let rrSum = 0;
  const misses: { q: string; expect: readonly string[]; got: readonly string[] }[] = [];
  for (const q of queries) {
    const results = (await opts.run(q.q)).slice(0, opts.k);
    const labels = results.map((r) =>
      r.source === "memory" ? (idToKey.get(r.chunkId) ?? r.chunkId) : (r.heading ?? r.path),
    );
    const rank = labels.findIndex((l) => q.expect.includes(l));
    if (rank >= 0) {
      hits += 1;
      rrSum += 1 / (rank + 1);
    } else {
      misses.push({ q: q.q, expect: q.expect, got: labels });
    }
  }
  const n = queries.length;
  return Object.freeze({
    summary: { queries: n, hits, recallAtK: n === 0 ? 0 : hits / n, mrr: n === 0 ? 0 : rrSum / n },
    misses: Object.freeze(misses),
  });
}
