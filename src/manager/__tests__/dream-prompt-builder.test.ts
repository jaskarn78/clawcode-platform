import { describe, it, expect } from "vitest";

/**
 * Phase 95 Plan 01 Task 1 — dream prompt builder tests (RED).
 *
 * Pin D-02/D-03 invariants:
 *   - P1: systemPrompt contains the verbatim "<agent>'s reflection daemon"
 *     template literal (after agent-name substitution)
 *   - P2: userPrompt embeds 4 ## sections (Recent memory chunks /
 *     MEMORY.md / Recent conversation summaries / Existing wikilinks)
 *   - P3: estimatedInputTokens ≤ 32_000 even when input has 1000 chunks
 *     of 100 tokens each (oldest-first truncation kicks in)
 *   - P4: oldest-first truncation — chunks sorted lastModified DESC pre-
 *     truncate; survivors are most-recent
 *   - P5: empty memoryMd / empty summaries / empty graphEdges all degrade
 *     gracefully ("(none)" placeholder, no throw)
 *
 * Module under test does not exist yet — imports fail (RED).
 */

import {
  buildDreamPrompt,
  DREAM_PROMPT_INPUT_TOKEN_BUDGET,
  type DreamPromptInput,
  type MemoryChunk,
  type ConversationSummary,
} from "../dream-prompt-builder.js";

function chunk(
  id: string,
  body: string,
  lastModifiedIso: string,
  path = `memory/${id}.md`,
): MemoryChunk {
  return {
    id,
    path,
    body,
    lastModified: new Date(lastModifiedIso),
  };
}

function summary(id: string, content: string): ConversationSummary {
  return {
    sessionId: id,
    summary: content,
    endedAt: new Date("2026-04-25T11:00:00.000Z"),
  };
}

describe("buildDreamPrompt — D-02 context assembler", () => {
  it("BUDGET-CONST: DREAM_PROMPT_INPUT_TOKEN_BUDGET === 32_000", () => {
    expect(DREAM_PROMPT_INPUT_TOKEN_BUDGET).toBe(32_000);
  });

  it("P1: systemPrompt contains verbatim '<agent>'s reflection daemon' template (D-03 verbatim)", () => {
    const input: DreamPromptInput = {
      agentName: "fin-client",
      recentChunks: [],
      memoryMd: "",
      recentSummaries: [],
      graphEdges: "",
    };
    const { systemPrompt } = buildDreamPrompt(input);
    expect(systemPrompt).toContain("fin-client's reflection daemon");
    // The verbatim D-03 schema-output instruction
    expect(systemPrompt).toContain("Output JSON ONLY");
    expect(systemPrompt).toContain("newWikilinks");
    expect(systemPrompt).toContain("promotionCandidates");
    expect(systemPrompt).toContain("themedReflection");
    expect(systemPrompt).toContain("suggestedConsolidations");
  });

  it("P2: userPrompt embeds all 4 ## sections", () => {
    const input: DreamPromptInput = {
      agentName: "clawdy",
      recentChunks: [
        chunk("a", "alpha body", "2026-04-25T10:00:00Z", "memory/a.md"),
      ],
      memoryMd: "# Core memory\nThings I remember.",
      recentSummaries: [summary("s1", "Talked about deploys.")],
      graphEdges: '{"edges":[]}',
    };
    const { userPrompt } = buildDreamPrompt(input);
    expect(userPrompt).toContain("## Recent memory chunks");
    expect(userPrompt).toContain("## MEMORY.md");
    expect(userPrompt).toContain("## Recent conversation summaries");
    expect(userPrompt).toContain("## Existing wikilinks");
    // Body content present
    expect(userPrompt).toContain("alpha body");
    expect(userPrompt).toContain("Things I remember.");
    expect(userPrompt).toContain("Talked about deploys.");
  });

  it("P3: estimatedInputTokens ≤ 32_000 even with 1000 chunks × 100 tokens (truncation)", () => {
    // 100 tokens ≈ 400 chars under chars/4 heuristic
    const longBody = "x".repeat(400);
    const recentChunks = Array.from({ length: 1000 }, (_, i) =>
      chunk(`c${i}`, longBody, `2026-04-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`),
    );
    const input: DreamPromptInput = {
      agentName: "test",
      recentChunks,
      memoryMd: "",
      recentSummaries: [],
      graphEdges: "",
    };
    const { estimatedInputTokens } = buildDreamPrompt(input);
    expect(estimatedInputTokens).toBeLessThanOrEqual(DREAM_PROMPT_INPUT_TOKEN_BUDGET);
  });

  it("P4: oldest-first truncation keeps most-recent chunks (sort DESC, drop oldest)", () => {
    // 5 chunks dated Apr-20..Apr-24; budget tuned to admit only the 3 newest.
    // Use distinctive bodies so we can grep which survived.
    const recentChunks = [
      chunk("c20", "BODY-APRIL-20", "2026-04-20T10:00:00Z"),
      chunk("c21", "BODY-APRIL-21", "2026-04-21T10:00:00Z"),
      chunk("c22", "BODY-APRIL-22", "2026-04-22T10:00:00Z"),
      chunk("c23", "BODY-APRIL-23", "2026-04-23T10:00:00Z"),
      chunk("c24", "BODY-APRIL-24", "2026-04-24T10:00:00Z"),
    ];
    // No truncation triggered with 5 small chunks — all survive but ORDER
    // must be DESC (newest first) so dropped-from-tail removes oldest.
    const input: DreamPromptInput = {
      agentName: "test",
      recentChunks,
      memoryMd: "",
      recentSummaries: [],
      graphEdges: "",
    };
    const { userPrompt } = buildDreamPrompt(input);
    // All 5 survive (small payload):
    expect(userPrompt).toContain("BODY-APRIL-24");
    expect(userPrompt).toContain("BODY-APRIL-23");
    expect(userPrompt).toContain("BODY-APRIL-22");
    expect(userPrompt).toContain("BODY-APRIL-21");
    expect(userPrompt).toContain("BODY-APRIL-20");
    // Order: newest must appear before oldest in the rendered prompt.
    const idx24 = userPrompt.indexOf("BODY-APRIL-24");
    const idx20 = userPrompt.indexOf("BODY-APRIL-20");
    expect(idx24).toBeGreaterThan(0);
    expect(idx20).toBeGreaterThan(idx24);

    // Now build a payload that triggers truncation: 5 chunks of large bodies
    // sized so only the 3 newest fit under a tight cap. Since DREAM_PROMPT_INPUT_TOKEN_BUDGET
    // is 32_000 but we can't lower it, simulate truncation by stuffing each
    // chunk with enough bytes that 5 exceeds 32k tokens but 3 fits.
    // 32_000 tokens ≈ 128_000 chars. Per-chunk body of 35_000 chars = ~8_750 tokens
    // → 5 chunks ≈ 43_750 tokens (over) → truncation drops 2 oldest.
    const big = "Y".repeat(35_000);
    const bigChunks = [
      chunk("c20", `OLDEST-20-${big}`, "2026-04-20T10:00:00Z"),
      chunk("c21", `${big}-OLDISH-21`, "2026-04-21T10:00:00Z"),
      chunk("c22", `${big}-MIDDLE-22-${big}`, "2026-04-22T10:00:00Z"),
      chunk("c23", `${big}-NEWISH-23`, "2026-04-23T10:00:00Z"),
      chunk("c24", `${big}-NEWEST-24`, "2026-04-24T10:00:00Z"),
    ];
    const truncResult = buildDreamPrompt({
      agentName: "test",
      recentChunks: bigChunks,
      memoryMd: "",
      recentSummaries: [],
      graphEdges: "",
    });
    expect(truncResult.estimatedInputTokens).toBeLessThanOrEqual(DREAM_PROMPT_INPUT_TOKEN_BUDGET);
    // Two oldest dropped:
    expect(truncResult.userPrompt).not.toContain("OLDEST-20");
    expect(truncResult.userPrompt).not.toContain("OLDISH-21");
    // Newest two survived (at least):
    expect(truncResult.userPrompt).toContain("NEWEST-24");
    expect(truncResult.userPrompt).toContain("NEWISH-23");
  });

  it("P5: empty inputs degrade gracefully — '(none)' placeholders, no throw", () => {
    const input: DreamPromptInput = {
      agentName: "lonely-agent",
      recentChunks: [],
      memoryMd: "",
      recentSummaries: [],
      graphEdges: "",
    };
    const { userPrompt, estimatedInputTokens } = buildDreamPrompt(input);
    expect(userPrompt).toContain("## Recent memory chunks");
    expect(userPrompt).toContain("## MEMORY.md");
    expect(userPrompt).toContain("## Recent conversation summaries");
    expect(userPrompt).toContain("## Existing wikilinks");
    // Each empty section gets a "(none)" placeholder
    expect(userPrompt).toContain("(none)");
    expect(estimatedInputTokens).toBeGreaterThan(0);
    expect(estimatedInputTokens).toBeLessThanOrEqual(DREAM_PROMPT_INPUT_TOKEN_BUDGET);
  });
});

// ---------------------------------------------------------------------------
// Phase 107 DREAM-OUT-01 — fallback envelope rule (rule 6)
//
// Pin the schema-correct fallback envelope contract: when the LLM cannot
// produce valid JSON, it must output the exact 4-field empty envelope
// matching dreamResultSchema. Existing rules 1-5 must remain unchanged
// (Phase 95 static-grep regression rules).
// ---------------------------------------------------------------------------
describe("Phase 107 DREAM-OUT-01 fallback envelope rule", () => {
  const baseInput: DreamPromptInput = {
    agentName: "clawdy",
    recentChunks: [],
    memoryMd: "",
    recentSummaries: [],
    graphEdges: "",
  };

  it("rule 6 present in system prompt", () => {
    const { systemPrompt } = buildDreamPrompt(baseInput);
    expect(systemPrompt).toMatch(/6\.\s+If you cannot produce valid JSON/);
  });

  it("schema-correct fallback envelope literal embedded verbatim", () => {
    const { systemPrompt } = buildDreamPrompt(baseInput);
    expect(systemPrompt).toContain(
      '{"newWikilinks":[],"promotionCandidates":[],"themedReflection":"","suggestedConsolidations":[]}',
    );
  });

  it("fallback envelope keys exactly match dreamResultSchema", () => {
    const { systemPrompt } = buildDreamPrompt(baseInput);
    // All 4 schema keys appear in the fallback envelope literal.
    expect(systemPrompt).toMatch(
      /newWikilinks.*promotionCandidates.*themedReflection.*suggestedConsolidations/,
    );
  });

  it("forbidden-preamble examples include 'Noted'", () => {
    const { systemPrompt } = buildDreamPrompt(baseInput);
    expect(systemPrompt).toMatch(/Noted/);
  });

  it("existing rules 1-5 preserved (Phase 95 regression pin)", () => {
    const { systemPrompt } = buildDreamPrompt(baseInput);
    expect(systemPrompt).toMatch(
      /1\.\s+Your response MUST be valid JSON, parseable by JSON\.parse/,
    );
    expect(systemPrompt).toMatch(/2\.\s+The FIRST character MUST be '\{'/);
    expect(systemPrompt).toMatch(/3\.\s+The LAST character MUST be '\}'/);
    expect(systemPrompt).toMatch(/4\.\s+NO markdown code fences/);
    expect(systemPrompt).toMatch(
      /5\.\s+NO explanation text before or after the JSON object/,
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 999.13 — TZ-04: dream prompt timestamps (chunk lastModified + summary endedAt)
//
// Open Question 2 LOCKED YES — Plan 02 must convert renderChunk (line 115)
// and renderSummary (line 122) to TZ-aware timestamps when threaded an
// agentTz. The dream-pass agent reads these prompts as agent-visible
// context.
//
// Wave 0 RED: on main, both lines emit ISO UTC via toISOString(). After
// Plan 02, threading agentTz produces "YYYY-MM-DD HH:mm:ss ZZZ".
// ---------------------------------------------------------------------------
describe("Phase 999.13 — TZ-04: dream prompt TZ-aware timestamps", () => {
  it("dream-prompt-tz-timestamps: chunk lastModified + summary endedAt render in canonical TZ-aware format when agentTz threaded", () => {
    const input: DreamPromptInput = {
      agentName: "fin-client",
      recentChunks: [
        chunk("c1", "chunk body", "2026-04-30T18:32:51.000Z"),
      ],
      memoryMd: "",
      recentSummaries: [
        {
          sessionId: "s1",
          summary: "summary body",
          endedAt: new Date("2026-04-30T18:32:51.000Z"),
        },
      ],
      graphEdges: "",
    };
    // Phase 999.13 TZ-04 (Q2=YES) — DreamPromptInput.agentTz threads through
    // renderChunk + renderSummary to produce TZ-aware timestamps.
    const { userPrompt } = buildDreamPrompt({
      ...input,
      agentTz: "America/Los_Angeles",
    });
    // Canonical TZ-aware timestamp must appear (renderChunk + renderSummary).
    // With agentTz=America/Los_Angeles, 2026-04-30T18:32:51Z → 2026-04-30 11:32:51 PDT
    expect(userPrompt).toContain("2026-04-30 11:32:51 PDT");
    // Negative assertion: ISO UTC literal must NOT appear.
    expect(userPrompt).not.toContain("2026-04-30T18:32:51.000Z");
  });

  /**
   * Phase 999.113 WS-2 — the budget must hold when the NON-CHUNK sections
   * alone blow it. Before this, the tightening loop exited as soon as
   * `chunks` emptied, regardless of budget, so MEMORY.md / summaries /
   * graph-edges shipped unbounded. That is what silently killed Admin
   * Clawdy's dream pass for 14 days (its assembled prompt ran 3.5x the
   * declared cap and the request was rejected outright).
   */
  describe("WS-2: budget is enforced for non-chunk sections", () => {
    // 32K tokens ≈ 128K chars under the chars/4 heuristic. Use 4x that so
    // every single section is independently over budget.
    const HUGE = "y".repeat(DREAM_PROMPT_INPUT_TOKEN_BUDGET * 4 * 4);

    it("honours the budget with ZERO chunks and an oversized MEMORY.md", () => {
      const { estimatedInputTokens } = buildDreamPrompt({
        agentName: "Admin Clawdy",
        recentChunks: [],
        memoryMd: HUGE,
        recentSummaries: [],
        graphEdges: "",
      });
      expect(estimatedInputTokens).toBeLessThanOrEqual(
        DREAM_PROMPT_INPUT_TOKEN_BUDGET,
      );
    });

    it("honours the budget with an oversized graph-edges snapshot", () => {
      const { estimatedInputTokens } = buildDreamPrompt({
        agentName: "Admin Clawdy",
        recentChunks: [],
        memoryMd: "",
        recentSummaries: [],
        graphEdges: HUGE,
      });
      expect(estimatedInputTokens).toBeLessThanOrEqual(
        DREAM_PROMPT_INPUT_TOKEN_BUDGET,
      );
    });

    it("honours the budget when EVERY section is oversized at once", () => {
      const summaries: ConversationSummary[] = Array.from(
        { length: 5 },
        (_, i) => ({
          sessionId: `s${i}`,
          summary: HUGE,
          endedAt: new Date(`2026-04-${10 + i}T00:00:00.000Z`),
        }),
      );
      const { estimatedInputTokens } = buildDreamPrompt({
        agentName: "Admin Clawdy",
        recentChunks: [chunk("c1", HUGE, "2026-04-30T18:32:51.000Z")],
        memoryMd: HUGE,
        recentSummaries: summaries,
        graphEdges: HUGE,
      });
      expect(estimatedInputTokens).toBeLessThanOrEqual(
        DREAM_PROMPT_INPUT_TOKEN_BUDGET,
      );
    });

    it("leaves an already-under-budget prompt untouched", () => {
      const input: DreamPromptInput = {
        agentName: "personal",
        recentChunks: [chunk("c1", "short body", "2026-04-30T18:32:51.000Z")],
        memoryMd: "# MEMORY\n\nsmall",
        recentSummaries: [],
        graphEdges: "a -> b",
      };
      const { userPrompt, estimatedInputTokens } = buildDreamPrompt(input);
      expect(estimatedInputTokens).toBeLessThanOrEqual(
        DREAM_PROMPT_INPUT_TOKEN_BUDGET,
      );
      // No spurious degradation: content intact, no truncation marker.
      expect(userPrompt).toContain("small");
      expect(userPrompt).toContain("a -> b");
      expect(userPrompt).not.toContain("truncated to fit");
    });
  });
});

// ── Phase 999.119 pass 2 — O(n) budget loops must be byte-identical to the
// original re-render-per-drop algorithm, and fast. ─────────────────────────
import { renderAgentVisibleTimestamp } from "../../shared/agent-visible-time.js";

/** The pre-999.119 algorithm, kept verbatim as the equivalence oracle. */
function referenceBuild(input: DreamPromptInput, systemPrompt: string): { userPrompt: string; estimatedInputTokens: number } {
  const CHARS_PER_TOKEN = 4;
  const MARKER = "\n\n…[truncated to fit the dream prompt budget]";
  const estimateTokens = (t: string): number => Math.ceil(t.length / CHARS_PER_TOKEN);
  const truncateWithMarker = (s: string, maxChars: number): string => {
    if (s.length <= maxChars) return s;
    if (maxChars <= MARKER.length) return s.slice(0, Math.max(0, maxChars));
    return s.slice(0, maxChars - MARKER.length) + MARKER;
  };
  const shrinkToFit = (section: string, renderedPrompt: string): string => {
    const overflowTokens = estimateTokens(systemPrompt + renderedPrompt) - DREAM_PROMPT_INPUT_TOKEN_BUDGET;
    if (overflowTokens <= 0) return section;
    return truncateWithMarker(section, Math.max(0, section.length - overflowTokens * CHARS_PER_TOKEN - MARKER.length));
  };
  const renderChunk = (c: DreamPromptInput["recentChunks"][number]): string =>
    `### ${c.path} (id=${c.id}, lastModified=${renderAgentVisibleTimestamp(c.lastModified, input.agentTz)})\n\n${c.body}`;
  const renderSummary = (s: DreamPromptInput["recentSummaries"][number]): string =>
    `### Session ${s.sessionId} (ended ${renderAgentVisibleTimestamp(s.endedAt, input.agentTz)})\n\n${s.summary}`;
  let chunks = [...input.recentChunks].sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  let graphEdges = input.graphEdges;
  let summaries = [...input.recentSummaries];
  let memoryMd = input.memoryMd;
  const render = (): string => {
    const chunkSection = chunks.length === 0 ? "(none)" : chunks.map(renderChunk).join("\n\n");
    const memorySection = memoryMd.trim().length === 0 ? "(none)" : memoryMd;
    const summarySection = summaries.length === 0 ? "(none)" : summaries.map(renderSummary).join("\n\n");
    const wikiSection = graphEdges.trim().length === 0 ? "(none)" : graphEdges;
    return `## Recent memory chunks\n\n${chunkSection}\n\n## MEMORY.md\n\n${memorySection}\n\n## Recent conversation summaries\n\n${summarySection}\n\n## Existing wikilinks\n\n${wikiSection}`;
  };
  const overBudget = (p: string): boolean => estimateTokens(systemPrompt + p) > DREAM_PROMPT_INPUT_TOKEN_BUDGET;
  let userPrompt = render();
  while (overBudget(userPrompt) && chunks.length > 0) { chunks = chunks.slice(0, -1); userPrompt = render(); }
  if (overBudget(userPrompt)) { graphEdges = shrinkToFit(graphEdges, userPrompt); userPrompt = render(); }
  while (overBudget(userPrompt) && summaries.length > 0) { summaries = summaries.slice(0, -1); userPrompt = render(); }
  if (overBudget(userPrompt)) { memoryMd = shrinkToFit(memoryMd, userPrompt); userPrompt = render(); }
  if (overBudget(userPrompt)) {
    userPrompt = truncateWithMarker(userPrompt, Math.max(0, DREAM_PROMPT_INPUT_TOKEN_BUDGET * CHARS_PER_TOKEN - systemPrompt.length));
  }
  return { userPrompt, estimatedInputTokens: estimateTokens(systemPrompt + userPrompt) };
}

/** Deterministic PRNG so a failure is reproducible. */
function lcg(seed: number): () => number {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
}

describe("Phase 999.119 pass 2 — O(n) truncation", () => {
  it("is byte-identical to the original algorithm across randomized over- and under-budget inputs", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = lcg(seed);
      const n = Math.floor(rnd() * 45);
      const recentChunks = Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        path: `memory/2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, "0")}.md`,
        body: "b".repeat(Math.floor(rnd() * 9000)),
        lastModified: new Date(Date.UTC(2026, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28), Math.floor(rnd() * 24))),
      }));
      const recentSummaries = Array.from({ length: Math.floor(rnd() * 5) }, (_, i) => ({
        sessionId: `s${i}`,
        summary: "s".repeat(Math.floor(rnd() * 6000)),
        endedAt: new Date(Date.UTC(2026, 5, 1 + i)),
      }));
      const input: DreamPromptInput = {
        agentName: `agent-${seed}`,
        recentChunks,
        memoryMd: rnd() < 0.3 ? "   " : "m".repeat(Math.floor(rnd() * 40000)),
        recentSummaries,
        graphEdges: rnd() < 0.3 ? "" : "g".repeat(Math.floor(rnd() * 60000)),
        agentTz: "America/Los_Angeles",
      };
      const actual = buildDreamPrompt(input);
      const expected = referenceBuild(input, actual.systemPrompt);
      expect(actual.userPrompt, `seed ${seed}`).toBe(expected.userPrompt);
      expect(actual.estimatedInputTokens, `seed ${seed}`).toBe(expected.estimatedInputTokens);
      expect(actual.estimatedInputTokens).toBeLessThanOrEqual(DREAM_PROMPT_INPUT_TOKEN_BUDGET);
    }
  });

  it("truncates 1,000 × 400-char chunks in well under a second", () => {
    const recentChunks = Array.from({ length: 1000 }, (_, i) => ({
      id: `c${i}`,
      path: `memory/${i}.md`,
      body: "x".repeat(400),
      lastModified: new Date(Date.UTC(2026, 3, 1 + (i % 28))),
    }));
    const t0 = performance.now();
    const result = buildDreamPrompt({ agentName: "perf", recentChunks, memoryMd: "", recentSummaries: [], graphEdges: "" });
    const elapsed = performance.now() - t0;
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(DREAM_PROMPT_INPUT_TOKEN_BUDGET);
    expect(elapsed).toBeLessThan(1000);
  });
});
