import { describe, it, expect, vi } from "vitest";
import { applyDocumentPriorityWeight } from "../memory-retrieval.js";

/**
 * Phase 999.43 Plan 03 Task 2 — memory-retrieval applies D-02 priority
 * weighting to `document:` prefix candidates from cross-ingested chunks.
 *
 * The helper is a pure function — no DB, no embedder. It takes a list of
 * Hydrated-shaped candidates (path/fusedScore) plus a getDocumentRow
 * deps closure that maps a `document:<slug>` path to the documents row.
 *
 * Tests:
 *   1. Multiplicative weighting — `document:` candidates are scaled by
 *      agentWeight × contentWeight × recencyBoost; non-document candidates
 *      pass through unchanged.
 *   2. Missing documents row → multipliers default to 1.0 (no throw).
 *   3. agentWeight param is threaded through (0.7 LOW agent reflected).
 */

type StubRow = {
  content_priority_weight: number;
  ingested_at: string;
};

function makeCandidate(path: string, fusedScore: number) {
  return {
    chunkId: `c-${path}`,
    path,
    heading: null,
    body: `body for ${path}`,
    file_mtime_ms: Date.now(),
    fusedScore,
    scoreWeight: 0,
    source: "chunk" as const,
  };
}

describe("applyDocumentPriorityWeight (Phase 999.43 D-02)", () => {
  it("Test 1: multiplies document: candidates by D-02 weights; passes through non-doc candidates", () => {
    const now = Date.now();
    const oneDayAgo = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();

    const rows: Record<string, StubRow> = {
      "client-c-statement": { content_priority_weight: 1.5, ingested_at: oneDayAgo },
      "receipt": { content_priority_weight: 0.5, ingested_at: oneDayAgo },
      "old-doc": {
        content_priority_weight: 1.5,
        ingested_at: eightDaysAgo,
      },
    };

    const candidates = [
      makeCandidate("document:client-c-statement", 0.1),
      makeCandidate("document:receipt", 0.1),
      makeCandidate("document:old-doc", 0.1),
      makeCandidate("memory:foo", 0.1), // non-doc; pass-through
      makeCandidate("/memory/vault/style.md", 0.1), // non-doc; pass-through
    ];

    const result = applyDocumentPriorityWeight(candidates, {
      getDocumentRow: (slug: string) => rows[slug] ?? null,
      agentWeight: 1.5,
      now,
    });

    expect(result).toHaveLength(5);

    const byPath = new Map(result.map((r) => [r.path, r]));
    // HIGH content + 1d age + agent 1.5: 0.1 × 1.5 × 1.5 × 1.3 = 0.2925
    expect(byPath.get("document:client-c-statement")!.weightedFused).toBeCloseTo(
      0.2925,
      4,
    );
    // LOW content + 1d age + agent 1.5: 0.1 × 1.5 × 0.5 × 1.3 = 0.0975
    expect(byPath.get("document:receipt")!.weightedFused).toBeCloseTo(
      0.0975,
      4,
    );
    // HIGH content + 8d age (no boost) + agent 1.5: 0.1 × 1.5 × 1.5 × 1.0
    expect(byPath.get("document:old-doc")!.weightedFused).toBeCloseTo(
      0.225,
      4,
    );
    // Non-doc: weightedFused === fusedScore (pass-through).
    expect(byPath.get("memory:foo")!.weightedFused).toBeCloseTo(0.1, 6);
    expect(byPath.get("/memory/vault/style.md")!.weightedFused).toBeCloseTo(
      0.1,
      6,
    );
  });

  it("Test 2: missing documents row → multipliers all 1.0 (no throw)", () => {
    const candidates = [makeCandidate("document:unknown-doc", 0.05)];
    const result = applyDocumentPriorityWeight(candidates, {
      // Always returns null — simulates Phase 101-leftover chunk with no
      // provenance row.
      getDocumentRow: () => null,
      agentWeight: 1.0,
    });
    expect(result).toHaveLength(1);
    // 0.05 × 1.0 × 1.0 × 1.0 = 0.05
    expect(result[0].weightedFused).toBeCloseTo(0.05, 6);
  });

  it("Test 3: agentWeight 0.7 (LOW priority agent) scales document candidates", () => {
    const now = Date.now();
    const oneDayAgo = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();

    const candidates = [makeCandidate("document:work-doc", 0.1)];
    const result = applyDocumentPriorityWeight(candidates, {
      getDocumentRow: () => ({
        content_priority_weight: 1.0,
        ingested_at: oneDayAgo,
      }),
      agentWeight: 0.7,
      now,
    });
    expect(result).toHaveLength(1);
    // 0.1 × 0.7 × 1.0 × 1.3 = 0.091
    expect(result[0].weightedFused).toBeCloseTo(0.091, 5);
  });

  it("Test 5 (quick-260521-437): honors a shortened recencyWindowMs — 3-day-old doc loses the boost under a 2-day window", () => {
    const now = Date.now();
    const oneDayAgo = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
    const threeDaysAgo = new Date(
      now - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const twoDayWindowMs = 2 * 24 * 60 * 60 * 1000;

    const rows: Record<string, StubRow> = {
      "fresh-doc": { content_priority_weight: 1.0, ingested_at: oneDayAgo },
      "stale-doc": {
        content_priority_weight: 1.0,
        ingested_at: threeDaysAgo,
      },
    };

    const candidates = [
      makeCandidate("document:fresh-doc", 0.1),
      makeCandidate("document:stale-doc", 0.1),
    ];

    const result = applyDocumentPriorityWeight(candidates, {
      getDocumentRow: (slug: string) => rows[slug] ?? null,
      agentWeight: 1.0,
      recencyWindowMs: twoDayWindowMs,
      now,
    });

    const byPath = new Map(result.map((r) => [r.path, r]));
    // 1-day-old doc is WITHIN the 2-day window → 1.3 boost:
    // 0.1 × 1.0 × 1.0 × 1.3 = 0.13
    expect(byPath.get("document:fresh-doc")!.weightedFused).toBeCloseTo(
      0.13,
      5,
    );
    // 3-day-old doc is OUTSIDE the 2-day window → no boost:
    // 0.1 × 1.0 × 1.0 × 1.0 = 0.1
    expect(byPath.get("document:stale-doc")!.weightedFused).toBeCloseTo(
      0.1,
      5,
    );
  });

  it("Test 6 (quick-260521-437): omitting recencyWindowMs falls back to the legacy 7-day window", () => {
    const now = Date.now();
    const threeDaysAgo = new Date(
      now - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const candidates = [makeCandidate("document:legacy-doc", 0.1)];
    const result = applyDocumentPriorityWeight(candidates, {
      getDocumentRow: () => ({
        content_priority_weight: 1.0,
        ingested_at: threeDaysAgo,
      }),
      agentWeight: 1.0,
      // recencyWindowMs intentionally OMITTED — legacy 7-day window applies.
      now,
    });
    // 3 days < 7 days → STILL gets the 1.3 boost (back-compat):
    // 0.1 × 1.0 × 1.0 × 1.3 = 0.13
    expect(result[0].weightedFused).toBeCloseTo(0.13, 5);
  });

  it("Test 4: emits phase999.43-weight log line when applied count > 0", () => {
    const now = Date.now();
    const oneDayAgo = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
    const debug = vi.fn();
    // 2 doc candidates: one with provenance row (counted in appliedCount),
    // one without (counted in skippedCount). 1 non-doc pass-through is NOT
    // counted in either bucket (helper only tracks document: candidates).
    const candidates = [
      makeCandidate("document:doc-a", 0.1),
      makeCandidate("document:unknown-doc", 0.1),
      makeCandidate("memory:foo", 0.1),
    ];
    applyDocumentPriorityWeight(candidates, {
      getDocumentRow: (slug: string) =>
        slug === "doc-a"
          ? { content_priority_weight: 1.5, ingested_at: oneDayAgo }
          : null,
      agentWeight: 1.5,
      now,
      logger: { debug },
    });
    // One info-level log fired with the structured shape.
    const calls = debug.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [payload] = calls[0];
    expect(payload).toMatchObject({
      tag: "phase999.43-weight",
      appliedCount: 1,
      skippedCount: 1,
      agentWeight: 1.5,
    });
  });
});
