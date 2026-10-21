/**
 * Phase 101 Plan 04 Task 1 — D-04 Wave-0 GATE smoke test.
 *
 * This test loads the actual `Xenova/bge-reranker-base` ONNX model end-to-end
 * on the dev box (~120MB download on cold cache). It is NOT mocked. The
 * Wave-0 gate (D-04) is satisfied iff this test exits 0 with a positive
 * relevance score on the canonical (query, passage) pair derived from the
 * Client C-2024 tax-return UAT artifact.
 *
 * On failure (ONNX assets missing on the Xenova repo, tokenizer compat
 * regression, runtime error), Plan 04 executor:
 *   1. DOES NOT proceed to Task 2.
 *   2. Writes 101-04-SUMMARY.md with status = `DEFERRED-TO-PHASE-101.5`.
 *   3. Returns a structured halt: `WAVE-0 GATE FAILED — U9 splits to
 *      Phase 101.5; Plan 05 should proceed without the reranker integration.`
 *
 * The 120s test timeout accommodates a cold-cache first-ever download on a
 * slow network link. Warm cache is sub-5s.
 */
import { describe, test, expect } from "vitest";
import { loadReranker, PRIMARY_MODEL } from "../../src/memory/reranker.js";

describe("Phase 101 Plan 04 — D-04 Wave-0 reranker smoke gate", () => {
  test(
    "D-04 Wave-0: Xenova/bge-reranker-base loads + scores a (query, passage) pair end-to-end",
    { timeout: 180_000 },
    async () => {
      expect(PRIMARY_MODEL).toBe("Xenova/bge-reranker-base");
      const p = await loadReranker();
      const out = await p([
        {
          text: "Client C's Schedule C net profit",
          text_pair:
            "Schedule C: Profit or Loss from Business, Net profit (line 31): $42,500",
        },
      ]);
      expect(Array.isArray(out)).toBe(true);
      expect(out).toHaveLength(1);
      expect(typeof out[0].score).toBe("number");
      // bge-reranker-base is trained to emit a positive relevance logit
      // for matched (query, passage) pairs. We don't pin an absolute
      // magnitude (the scale varies across HF revisions) — we only assert
      // the sign + finite-ness, which is what the gate actually needs.
      expect(out[0].score).toBeGreaterThan(0);
      expect(Number.isFinite(out[0].score)).toBe(true);
    },
  );
});
