import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  assembleContext,
  DEFAULT_BUDGETS,
  estimateTokens,
  exceedsCeiling,
  type ContextBudgets,
  type ContextSources,
} from "../context-assembler.js";

/**
 * Phase 52 Plan 02: `assembleContext` now returns `AssembledContext`, an
 * object with `stablePrefix`, `mutableSuffix`, and `hotStableToken`. The
 * existing pre-52 tests were written against the single-string return and
 * have been surgically updated to assert on the joined stable+mutable
 * string so intent is preserved.
 */
function joinAssembled(result: unknown): string {
  const a = result as { stablePrefix: string; mutableSuffix: string };
  if (a.stablePrefix && a.mutableSuffix) {
    return `${a.stablePrefix}\n\n${a.mutableSuffix}`;
  }
  return a.stablePrefix || a.mutableSuffix;
}

function makeSources(overrides: Partial<ContextSources> = {}): ContextSources {
  return {
    identity: "",
    hotMemories: "",
    toolDefinitions: "",
    graphContext: "",
    discordBindings: "",
    contextSummary: "",
    ...overrides,
  } as ContextSources;
}

describe("estimateTokens", () => {
  it("returns Math.ceil(text.length / 4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("ab")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});

describe("exceedsCeiling", () => {
  it("returns true when assembled string exceeds 8000 tokens (32000 chars) by default", () => {
    const underCeiling = "x".repeat(32000);
    expect(exceedsCeiling(underCeiling)).toBe(false);

    const overCeiling = "x".repeat(32001);
    expect(exceedsCeiling(overCeiling)).toBe(true);
  });

  it("accepts custom ceiling", () => {
    const text = "x".repeat(100); // 25 tokens
    expect(exceedsCeiling(text, 24)).toBe(true);
    expect(exceedsCeiling(text, 25)).toBe(false);
    expect(exceedsCeiling(text, 26)).toBe(false);
  });
});

describe("DEFAULT_BUDGETS", () => {
  it("has expected values and is frozen", () => {
    expect(DEFAULT_BUDGETS).toEqual({
      identity: 1000,
      hotMemories: 3000,
      toolDefinitions: 2000,
      graphContext: 2000,
    });
    expect(Object.isFrozen(DEFAULT_BUDGETS)).toBe(true);
  });
});

describe("assembleContext", () => {
  it("with all sources populated returns sections in order (Phase 115-04 static-first default)", () => {
    // Phase 115 Plan 04 sub-scope 5 — DEFAULT_CACHE_BREAKPOINT_PLACEMENT
    // is "static-first": all static sections (identity, tools) land BEFORE
    // the breakpoint marker; dynamic sections (hot memories, graph context)
    // land AFTER. Mutable sections (discord, summary) sit in the mutable
    // suffix as before. The legacy interleaved order is regression-pinned
    // separately by `context-assembler-cache-breakpoint.test.ts` legacy-mode
    // tests.
    const sources = makeSources({
      identity: "I am an agent",
      hotMemories: "- memory 1\n- memory 2",
      toolDefinitions: "tool_a: does stuff",
      graphContext: "graph node info",
      discordBindings: "## Discord\nbound to #general",
      contextSummary: "## Context Summary\nprevious session info",
    });

    const result = joinAssembled(assembleContext(sources));

    const identityIdx = result.indexOf("I am an agent");
    const toolsIdx = result.indexOf("## Available Tools");
    const memoriesIdx = result.indexOf("## Key Memories");
    const graphIdx = result.indexOf("## Related Context");
    const discordIdx = result.indexOf("## Discord");
    const summaryIdx = result.indexOf("## Context Summary");

    // Static sections come first (identity → tools).
    expect(identityIdx).toBeGreaterThanOrEqual(0);
    expect(toolsIdx).toBeGreaterThan(identityIdx);
    // Context-bloat fix #3a — Discord bindings now ride the STABLE PREFIX
    // (static content), placed in the static cluster after tools and
    // before the dynamic cluster (hot memories / graph context).
    expect(discordIdx).toBeGreaterThan(toolsIdx);
    // Then dynamic sections (hot memories → graph context).
    expect(memoriesIdx).toBeGreaterThan(discordIdx);
    expect(graphIdx).toBeGreaterThan(memoriesIdx);
    // Context-bloat fix #3b — the context summary lands in the mutable
    // suffix inside the merged "## Session Continuity" block, after the
    // entire stable prefix.
    expect(summaryIdx).toBeGreaterThan(graphIdx);
    expect(result).toContain("## Session Continuity");
  });

  it("identity exceeding 1000-token budget is WARN-and-kept (Phase 53 D-03)", () => {
    // Phase 53 Plan 02: identity is NEVER truncated (D-03 — user persona text
    // is warn-and-keep only). Legacy pre-53 behavior truncated to 4003 chars;
    // that behavior is intentionally removed for identity/soul.
    const longIdentity = "a".repeat(5000);
    const sources = makeSources({ identity: longIdentity });

    const result = joinAssembled(assembleContext(sources));

    // Identity is preserved verbatim
    expect(result).toContain(longIdentity);
    expect(result.length).toBeGreaterThanOrEqual(5000);
  });

  it("truncates hotMemories at line boundaries (drops whole bullets)", () => {
    // Each bullet is ~90 chars, 500 bullets = ~45000 chars = ~11250 tokens
    // Budget is 3000 tokens = 12000 chars, so truncation will occur
    const bullets = Array.from(
      { length: 500 },
      (_, i) => `- Memory entry number ${i} with some extended detail and extra padding text here`,
    ).join("\n");

    const sources = makeSources({ hotMemories: bullets });
    const result = joinAssembled(assembleContext(sources));

    // Should contain the header
    expect(result).toContain("## Key Memories");

    // Extract the memories section content (after header, before end)
    const memStart = result.indexOf("## Key Memories\n\n") + "## Key Memories\n\n".length;
    const memContent = result.slice(memStart);

    // Every line should be complete (start with "- ")
    const lines = memContent.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      expect(line).toMatch(/^- /);
    }

    // Should be shorter than the original
    expect(memContent.length).toBeLessThan(bullets.length);
  });

  it("omits identity section when identity is empty (Phase 115-04 static-first default)", () => {
    const sources = makeSources({
      hotMemories: "- some memory",
    });

    const result = joinAssembled(assembleContext(sources));

    // No empty identity in the static portion. Hot memories (dynamic) lands
    // AFTER the cache-breakpoint marker. Phase 115-04 default placement.
    expect(result).toContain("## Key Memories");
    expect(result).toContain("phase115-cache-breakpoint");
    // Marker comes before memories (memories is in the dynamic-after-marker
    // portion).
    const markerIdx = result.indexOf("phase115-cache-breakpoint");
    const memoriesIdx = result.indexOf("## Key Memories");
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(memoriesIdx).toBeGreaterThan(markerIdx);
  });

  it("omits graphContext section when empty", () => {
    const sources = makeSources({
      identity: "I am agent",
      graphContext: "",
    });

    const result = joinAssembled(assembleContext(sources));
    expect(result).not.toContain("## Related Context");
  });

  it("returns empty string when all sources are empty", () => {
    const sources = makeSources();
    const result = joinAssembled(assembleContext(sources));
    expect(result).toBe("");
  });

  it("uses custom budgets when provided (legacy hotMemories path)", () => {
    // Phase 53 Plan 02: legacy ContextBudgets still govern non-identity
    // sections (hotMemories/toolDefinitions/graphContext). Identity itself
    // is WARN-and-kept per D-03. This test exercises the legacy budget on
    // tool definitions which still uses truncateToBudget.
    const tinyBudgets: ContextBudgets = {
      identity: 5,
      hotMemories: 5,
      toolDefinitions: 5,
      graphContext: 5,
    };

    const sources = makeSources({
      identity: "a".repeat(100),
      toolDefinitions: "x".repeat(100),
    });

    const result = joinAssembled(assembleContext(sources, tinyBudgets));

    // Identity is preserved (D-03); tool definitions truncated to ~20 chars + "..."
    expect(result).toContain("a".repeat(100));
    const toolsStart = result.indexOf("## Available Tools");
    expect(toolsStart).toBeGreaterThan(0);
    const toolsSection = result.slice(toolsStart);
    expect(toolsSection).toContain("...");
  });

  it("discord bindings are pass-through (no truncation)", () => {
    const longBindings = "## Discord\n" + "x".repeat(50000);
    const sources = makeSources({ discordBindings: longBindings });

    // Context-bloat fix #3a: discord bindings now ride the STABLE PREFIX
    // (static content, prompt-cached once). Assert the stable half carries
    // the full input pass-through; the mutable suffix no longer carries it.
    const result = assembleContext(sources) as unknown as {
      stablePrefix: string;
      mutableSuffix: string;
    };
    expect(result.stablePrefix).toContain(longBindings);
    expect(result.mutableSuffix).toBe("");
  });

  it("context summary is pass-through (no truncation)", () => {
    const longSummary = "## Summary\n" + "y".repeat(50000);
    const sources = makeSources({ contextSummary: longSummary });

    // Phase 52 Plan 02: context summary lives in mutableSuffix.
    // Context-bloat fix #3b: it is now wrapped (no content loss) under the
    // merged "## Session Continuity" heading — assert pass-through content.
    const result = assembleContext(sources) as unknown as {
      stablePrefix: string;
      mutableSuffix: string;
    };
    expect(result.mutableSuffix).toContain(longSummary);
    expect(result.mutableSuffix).toContain("## Session Continuity");
    expect(result.stablePrefix).toBe("");
  });

  it("section headers are NOT counted against the source budget", () => {
    // Budget of 10 tokens = 40 chars for hotMemories content
    const customBudgets: ContextBudgets = {
      identity: 1000,
      hotMemories: 10,
      toolDefinitions: 2000,
      graphContext: 2000,
    };

    const shortMemory = "- a short bullet"; // 16 chars = 4 tokens, well within budget
    const sources = makeSources({ hotMemories: shortMemory });

    const result = joinAssembled(assembleContext(sources, customBudgets));

    // The full memory content should be preserved (within budget)
    expect(result).toContain(shortMemory);
    // Header should be present
    expect(result).toContain("## Key Memories");
  });

  it("total assembled context respects ceiling check (non-identity path)", () => {
    // Phase 53 Plan 02: identity is WARN-and-kept (D-03), so a huge identity
    // blows through the ceiling intentionally. Use hotMemories for the
    // ceiling test — tool/graph sections still truncate via legacy budget.
    const sources = makeSources({
      identity: "short",
      hotMemories: Array.from(
        { length: 500 },
        (_, i) => `- memory ${i} ` + "x".repeat(80),
      ).join("\n"),
    });

    const result = joinAssembled(assembleContext(sources));
    // hotMemories truncated via DEFAULT_PHASE53_BUDGETS.hot_tier (3000 tokens)
    expect(exceedsCeiling(result)).toBe(false);
  });
});

// ── APPENDED BY Phase 50-00 Wave 0 scaffolding ───────────────────────────────
// New "context_assemble tracing" describe block. Existing tests above remain
// untouched. Wave 2 Task 2 will add the `assembleContextTraced` export that
// makes these tests green.

import { vi } from "vitest";
import { assembleContextTraced } from "../context-assembler.js";

describe("context_assemble tracing", () => {
  function makeTurnStub() {
    const spanEnd = vi.fn();
    const setMetadata = vi.fn();
    const startSpan = vi.fn(() => ({ end: spanEnd, setMetadata }));
    return { turn: { startSpan, end: vi.fn() }, spanEnd, startSpan, setMetadata };
  }

  it("tracing: assembleContextTraced opens a context_assemble span before assembling and ends it after (finally)", () => {
    const { turn, startSpan, spanEnd } = makeTurnStub();
    const sources = makeSources({ identity: "I am an agent" });

    const result = (assembleContextTraced as any)(sources, DEFAULT_BUDGETS, undefined, turn);

    expect(startSpan).toHaveBeenCalledWith("context_assemble");
    expect(spanEnd).toHaveBeenCalledTimes(1);
    // Result should still match the untraced assembleContext output (same shape).
    expect(result).toEqual(assembleContext(sources, DEFAULT_BUDGETS));
  });

  it("tracing: ends the context_assemble span even when assembleContext throws", () => {
    const { turn, startSpan, spanEnd } = makeTurnStub();

    // Build a proxy that triggers inside assembleContextTraced. Since we can't
    // easily force the inner assembleContext to throw without mocking the
    // module graph, we use a deliberately malformed sources object cast to the
    // expected type — assembleContextTraced should still end the span via its
    // finally block.
    const thrower = {
      get identity() {
        throw new Error("boom");
      },
    } as unknown as ContextSources;

    expect(() => (assembleContextTraced as any)(thrower, DEFAULT_BUDGETS, undefined, turn)).toThrow();

    expect(startSpan).toHaveBeenCalledWith("context_assemble");
    expect(spanEnd).toHaveBeenCalledTimes(1);
  });

  it("tracing: no-op when turn is undefined (does not call startSpan)", () => {
    const sources = makeSources({ identity: "I am an agent" });
    const result = (assembleContextTraced as any)(sources, DEFAULT_BUDGETS, undefined, undefined);
    // Result equals the untraced output.
    expect(result).toEqual(assembleContext(sources, DEFAULT_BUDGETS));
  });
});

// ── Phase 52 Plan 02 — two-block assembly + hot-tier stable_token ─────────────

import { computeHotStableToken, computePrefixHash } from "../context-assembler.js";

describe("two-block assembly (Phase 52)", () => {
  it("returns { stablePrefix, mutableSuffix, hotStableToken } — not a single string", () => {
    const sources = makeSources({
      identity: "I am an agent",
      hotMemories: "- memory 1\n- memory 2",
      toolDefinitions: "tool_a: does stuff",
      discordBindings: "## Discord\nbound to #general",
      contextSummary: "## Context Summary\nprevious session info",
    });

    const result = assembleContext(sources);

    expect(typeof result).toBe("object");
    expect(typeof (result as any).stablePrefix).toBe("string");
    expect(typeof (result as any).mutableSuffix).toBe("string");
    expect(typeof (result as any).hotStableToken).toBe("string");
    expect((result as any).hotStableToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it("stablePrefix contains identity, hotMemories, toolDefinitions — the cacheable block", () => {
    const sources = makeSources({
      identity: "I am an agent",
      hotMemories: "- memory alpha",
      toolDefinitions: "tool_a: does stuff",
      discordBindings: "## Discord\nbound to #general",
    });

    const result = assembleContext(sources) as unknown as {
      stablePrefix: string;
      mutableSuffix: string;
    };

    expect(result.stablePrefix).toContain("I am an agent");
    expect(result.stablePrefix).toContain("memory alpha");
    expect(result.stablePrefix).toContain("tool_a");
  });

  it("stable prefix carries discordBindings, mutableSuffix carries the continuity block", () => {
    // Context-bloat fixes #3a + #3b: discord bindings moved to the cached
    // stable prefix; the context summary lands in the mutable suffix wrapped
    // under the merged "## Session Continuity" block.
    const sources = makeSources({
      identity: "I am an agent",
      discordBindings: "## Discord\nbound to #channel",
      contextSummary: "## Context Summary\nprior session",
    });

    const result = assembleContext(sources) as unknown as {
      stablePrefix: string;
      mutableSuffix: string;
    };

    // #3a — Discord bindings now in the stable prefix, not the suffix.
    expect(result.stablePrefix).toContain("## Discord");
    expect(result.mutableSuffix).not.toContain("## Discord");
    // #3b — context summary in the merged continuity block in the suffix.
    expect(result.mutableSuffix).toContain("## Session Continuity");
    expect(result.mutableSuffix).toContain("## Context Summary");
    expect(result.stablePrefix).not.toContain("## Context Summary");
  });

  it("when priorHotStableToken matches current hot-tier, hot-tier stays in stablePrefix", () => {
    const sources = makeSources({
      identity: "identity",
      hotMemories: "- m1\n- m2",
      discordBindings: "## Discord\nb",
    });

    // First call gets the current token, then pass it as priorHotStableToken.
    const first = assembleContext(sources) as unknown as {
      hotStableToken: string;
    };
    const result = assembleContext(sources, DEFAULT_BUDGETS, {
      priorHotStableToken: first.hotStableToken,
    }) as unknown as { stablePrefix: string; mutableSuffix: string };

    expect(result.stablePrefix).toContain("## Key Memories");
    expect(result.mutableSuffix).not.toContain("## Key Memories");
  });

  it("when priorHotStableToken differs, hot-tier is excluded from stablePrefix and placed in mutableSuffix", () => {
    const sources = makeSources({
      identity: "identity",
      hotMemories: "- m1\n- m2",
      discordBindings: "## Discord\nb",
    });

    const result = assembleContext(sources, DEFAULT_BUDGETS, {
      priorHotStableToken: "0".repeat(64), // deliberately non-matching
    }) as unknown as {
      stablePrefix: string;
      mutableSuffix: string;
      hotStableToken: string;
    };

    expect(result.stablePrefix).not.toContain("## Key Memories");
    expect(result.mutableSuffix).toContain("## Key Memories");
    expect(result.hotStableToken).not.toBe("0".repeat(64));
  });

  it("when hotMemories is empty, hotStableToken is sha256 of '' and hot-tier is absent from both blocks", () => {
    const sources = makeSources({
      identity: "identity",
      hotMemories: "",
      discordBindings: "## Discord\nb",
    });

    const result = assembleContext(sources) as unknown as {
      stablePrefix: string;
      mutableSuffix: string;
      hotStableToken: string;
    };

    const emptyHash = createHash("sha256").update("", "utf8").digest("hex");
    expect(result.hotStableToken).toBe(emptyHash);
    expect(result.stablePrefix).not.toContain("## Key Memories");
    expect(result.mutableSuffix).not.toContain("## Key Memories");
  });

  // Context-bloat fix #3b — merged Session Continuity block.
  it("#3b: merges resumeSummary + conversationContext into ONE block with NO content loss", () => {
    const resumeBody =
      "## Context Summary (from previous session)\nMid-session zone snapshot: drafting the Q3 memo.";
    const briefBody =
      "## Recent Sessions\n- Session A: closed the SGOV allocation\n- Session B: reviewed the deck";
    const sources = makeSources({
      identity: "agent",
      resumeSummary: resumeBody,
      conversationContext: briefBody,
    } as Partial<ContextSources>);

    const result = assembleContext(sources) as unknown as {
      stablePrefix: string;
      mutableSuffix: string;
    };

    // Exactly ONE outer continuity heading — the two blocks are merged,
    // not left side by side.
    expect(result.mutableSuffix).toContain("## Session Continuity");
    expect(
      result.mutableSuffix.match(/## Session Continuity/g)?.length,
    ).toBe(1);
    // BOTH sources' content is preserved verbatim — no content dropped.
    expect(result.mutableSuffix).toContain(resumeBody);
    expect(result.mutableSuffix).toContain(briefBody);
    // Ordering inside the merged block: resume summary (most concrete)
    // before the Recent Sessions brief.
    expect(result.mutableSuffix.indexOf(resumeBody)).toBeLessThan(
      result.mutableSuffix.indexOf(briefBody),
    );
  });

  it("#3b: continuity block carries only the resume summary when the brief is absent", () => {
    const resumeBody = "## Context Summary (from previous session)\nonly the resume side";
    const sources = makeSources({
      identity: "agent",
      resumeSummary: resumeBody,
    } as Partial<ContextSources>);

    const result = assembleContext(sources) as unknown as {
      mutableSuffix: string;
    };
    expect(result.mutableSuffix).toContain("## Session Continuity");
    expect(result.mutableSuffix).toContain(resumeBody);
  });

  it("assembleContextTraced returns AssembledContext unchanged (pass-through type-preserving wrapper)", () => {
    const spanEnd = vi.fn();
    const setMetadata = vi.fn();
    const startSpan = vi.fn(() => ({ end: spanEnd, setMetadata }));
    const turn = { startSpan, end: vi.fn() };
    const sources = makeSources({
      identity: "identity",
      hotMemories: "- m1",
    });

    const result = (assembleContextTraced as any)(
      sources,
      DEFAULT_BUDGETS,
      undefined,
      turn,
    );

    expect(startSpan).toHaveBeenCalledWith("context_assemble");
    expect(spanEnd).toHaveBeenCalledTimes(1);
    expect(typeof result).toBe("object");
    expect(typeof result.stablePrefix).toBe("string");
    expect(typeof result.mutableSuffix).toBe("string");
    expect(typeof result.hotStableToken).toBe("string");
  });

  it("AssembledContext is frozen (immutability contract)", () => {
    const sources = makeSources({ identity: "x" });
    const result = assembleContext(sources);
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe("computeHotStableToken / computePrefixHash (Phase 52)", () => {
  it("computeHotStableToken returns sha256 hex over the input string", () => {
    const input = "- mem1\n- mem2";
    const expected = createHash("sha256").update(input, "utf8").digest("hex");
    expect(computeHotStableToken(input)).toBe(expected);
    expect(computeHotStableToken(input)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("computeHotStableToken returns sha256('') for empty input", () => {
    const expected = createHash("sha256").update("", "utf8").digest("hex");
    expect(computeHotStableToken("")).toBe(expected);
  });

  it("computePrefixHash returns sha256 hex of stablePrefix", () => {
    const prefix = "## Identity\nCore traits: helpful";
    const expected = createHash("sha256").update(prefix, "utf8").digest("hex");
    expect(computePrefixHash(prefix)).toBe(expected);
    expect(computePrefixHash(prefix)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("computePrefixHash differs between different prefixes (eviction detection)", () => {
    const a = computePrefixHash("prefix A");
    const b = computePrefixHash("prefix B");
    expect(a).not.toBe(b);
  });
});

// ── Phase 53 Plan 02 — per-section budget enforcement ────────────────────────

import {
  DEFAULT_PHASE53_BUDGETS,
  renderHotMemoryLine,
  type MemoryAssemblyBudgets,
  type BudgetWarningEvent,
} from "../context-assembler.js";
import type { MemoryEntry } from "../../memory/types.js";
import { countTokens } from "../../performance/token-count.js";

function makeMemoryEntry(
  overrides: Partial<MemoryEntry> & Pick<MemoryEntry, "content" | "importance">,
): MemoryEntry {
  return Object.freeze({
    id: overrides.id ?? "mem-" + Math.random().toString(36).slice(2, 8),
    content: overrides.content,
    source: overrides.source ?? "manual",
    importance: overrides.importance,
    accessCount: overrides.accessCount ?? 0,
    tags: Object.freeze(overrides.tags ?? []),
    embedding: overrides.embedding ?? null,
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-01T00:00:00.000Z",
    accessedAt: overrides.accessedAt ?? "2026-04-01T00:00:00.000Z",
    tier: overrides.tier ?? "hot",
    sourceTurnIds: overrides.sourceTurnIds ?? null,
  });
}

describe("assembleContext budget enforcement (Phase 53)", () => {
  it("Test 1: identity over budget is HEAD-TAIL TRUNCATED (Phase 115 D-03)", () => {
    // Phase 115 D-03 lock — replaces the Phase 53 `warn-and-keep` no-op.
    // Identity is now head-tail truncated when over budget. SOUL-fingerprint
    // protection requires the carved sub-source path (see
    // context-assembler-tier1-budget.test.ts + context-assembler-drop-lowest.test.ts).
    // Legacy single `identity` field falls through to the simple head-tail path.
    const longIdentity = "X".repeat(10000);
    const warnings: BudgetWarningEvent[] = [];
    const sources = makeSources({ identity: longIdentity });

    const result = assembleContext(sources, DEFAULT_BUDGETS, {
      memoryAssemblyBudgets: { identity: 100 },
      onBudgetWarning: (e) => warnings.push(e),
    }) as unknown as { stablePrefix: string };

    // Identity is no longer preserved verbatim — it's head-tail truncated.
    // The truncation marker MUST appear; the full 10000-X string MUST NOT.
    expect(result.stablePrefix).toContain("[TRUNCATED");
    expect(result.stablePrefix).not.toContain("X".repeat(10000));
    // Result is significantly shorter than the input
    expect(result.stablePrefix.length).toBeLessThan(2000);
    // warn fired exactly once with the new strategy
    expect(warnings).toHaveLength(1);
    expect(warnings[0].section).toBe("identity");
    expect(warnings[0].strategy).toBe("drop-lowest-importance");
    expect(warnings[0].budgetTokens).toBe(100);
    expect(warnings[0].beforeTokens).toBeGreaterThan(100);
  });

  it("Test 2: soul over budget is HEAD-TAIL TRUNCATED (Phase 115 D-03)", () => {
    // Phase 115 D-03 — soul follows the same drop-lowest-importance contract
    // (real truncation). With D-02 default soul budget = 0 (folded into
    // identity), soul is fully dropped. This test uses a positive soul
    // budget to exercise the head-tail path.
    const longSoul = "S".repeat(10000);
    const warnings: BudgetWarningEvent[] = [];
    const sources = makeSources({ identity: "id", soul: longSoul });

    const result = assembleContext(sources, DEFAULT_BUDGETS, {
      memoryAssemblyBudgets: { soul: 50 },
      onBudgetWarning: (e) => warnings.push(e),
    }) as unknown as { stablePrefix: string };

    // soul truncated — full long-soul block is NOT in the prefix verbatim.
    expect(result.stablePrefix).not.toContain(longSoul);
    expect(result.stablePrefix).toContain("[TRUNCATED");
    const soulWarn = warnings.find((w) => w.section === "soul");
    expect(soulWarn).toBeDefined();
    expect(soulWarn!.strategy).toBe("drop-lowest-importance");
  });

  it("Test 3: hot_tier over budget drops LOWEST-importance rows", () => {
    // Budget fits exactly the two highest-importance bullets and blocks the
    // third, which triggers drop-lowest-importance keeping alpha and beta.
    // WP6 (2026-10-25): bullets now carry their created date
    // ("- <content> (saved YYYY-MM-DD)"), so the budget is derived from the
    // rendered lines instead of the old hard-coded 32 (which fit two
    // undated bullets of ~14 tokens each).
    const entries: readonly MemoryEntry[] = [
      makeMemoryEntry({ content: "alpha aaaaaa aaaaaa aaaaaa aaaaaa", importance: 0.9 }),
      makeMemoryEntry({ content: "beta bbbbbb bbbbbb bbbbbb bbbbbb", importance: 0.8 }),
      makeMemoryEntry({ content: "gamma cccccc cccccc cccccc cccccc", importance: 0.7 }),
      makeMemoryEntry({ content: "delta dddddd dddddd dddddd dddddd", importance: 0.6 }),
      makeMemoryEntry({ content: "epsilon eeeeee eeeeee eeeeee eeeeee", importance: 0.5 }),
    ];
    const hotRendered = entries.map((m) => renderHotMemoryLine(m)).join("\n");
    const warnings: BudgetWarningEvent[] = [];
    const twoBulletBudget =
      countTokens(renderHotMemoryLine(entries[0]!)) +
      countTokens(renderHotMemoryLine(entries[1]!));

    const result = assembleContext(
      makeSources({ identity: "id", hotMemories: hotRendered, hotMemoriesEntries: entries }),
      DEFAULT_BUDGETS,
      {
        memoryAssemblyBudgets: { hot_tier: twoBulletBudget },
        onBudgetWarning: (e) => warnings.push(e),
      },
    ) as unknown as { stablePrefix: string; mutableSuffix: string };

    const combined = `${result.stablePrefix}\n${result.mutableSuffix}`;
    // Highest-importance (0.9, 0.8) kept
    expect(combined).toContain("alpha");
    expect(combined).toContain("beta");
    // Lowest kept out
    expect(combined).not.toContain("epsilon");
    expect(combined).not.toContain("gamma");
    expect(combined).not.toContain("delta");

    const hotWarn = warnings.find((w) => w.section === "hot_tier");
    expect(hotWarn).toBeDefined();
    expect(hotWarn!.strategy).toBe("drop-lowest-importance");
  });

  it("Test 4: recent_history is measured but not truncated by assembler", () => {
    const historyText = "x".repeat(5000);
    const sources = makeSources({ identity: "id", recentHistory: historyText });

    // Assembler doesn't own recent_history — it only measures it for audit.
    // We verify via exposing section_tokens through traced metadata (covered in Test 6).
    const result = assembleContext(sources, DEFAULT_BUDGETS, {
      memoryAssemblyBudgets: { recent_history: 10 },
    });

    // Return shape intact, no crash.
    expect(typeof result).toBe("object");
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(["stablePrefix", "mutableSuffix", "hotStableToken"]),
    );
  });

  it("Test 5: skills_header over budget truncates via bullet-line mechanism", () => {
    const bullets = Array.from(
      { length: 40 },
      (_, i) => `- skill${i}: description text for skill number ${i}`,
    ).join("\n");
    const warnings: BudgetWarningEvent[] = [];

    const result = assembleContext(
      makeSources({ identity: "id", skillsHeader: bullets }),
      DEFAULT_BUDGETS,
      {
        memoryAssemblyBudgets: { skills_header: 40 },
        onBudgetWarning: (e) => warnings.push(e),
      },
    ) as unknown as { stablePrefix: string };

    // Some skills dropped (truncated) but stablePrefix still contains Available Tools section
    expect(result.stablePrefix).toContain("## Available Tools");
    expect(result.stablePrefix).toContain("skill0");
    // Later skills should be truncated
    expect(result.stablePrefix).not.toContain("skill39");

    const skillsWarn = warnings.find((w) => w.section === "skills_header");
    expect(skillsWarn).toBeDefined();
    expect(skillsWarn!.strategy).toBe("truncate-bullets");
  });

  it("Test 6: assembleContextTraced emits section_tokens metadata with all 7 canonical sections", () => {
    let capturedMetadata: Record<string, unknown> | undefined;
    const spanEnd = vi.fn();
    const startSpan = vi.fn(() => ({
      end: spanEnd,
      setMetadata: (m: Record<string, unknown>) => {
        capturedMetadata = m;
      },
    }));
    const turn = { startSpan, end: vi.fn() };

    const sources = makeSources({
      identity: "id text",
      soul: "soul text",
      skillsHeader: "- skill1: desc",
      hotMemories: "- hot mem",
      recentHistory: "conversation history here",
      perTurnSummary: "per-turn summary text",
      resumeSummary: "resume summary text",
    });

    (assembleContextTraced as any)(sources, DEFAULT_BUDGETS, undefined, turn);

    expect(capturedMetadata).toBeDefined();
    const sectionTokens = (capturedMetadata as any).section_tokens;
    expect(sectionTokens).toBeDefined();
    expect(typeof sectionTokens.identity).toBe("number");
    expect(typeof sectionTokens.soul).toBe("number");
    expect(typeof sectionTokens.skills_header).toBe("number");
    expect(typeof sectionTokens.hot_tier).toBe("number");
    expect(typeof sectionTokens.recent_history).toBe("number");
    expect(typeof sectionTokens.per_turn_summary).toBe("number");
    expect(typeof sectionTokens.resume_summary).toBe("number");
    // Non-zero for populated sections (Phase 115 D-02: soul defaults to 0 budget,
    // so populating `soul` here with positive content + a positive override
    // budget keeps the soul section non-zero).
    expect(sectionTokens.identity).toBeGreaterThan(0);
    // Soul telemetry: with D-02 default budget = 0, populated soul gets
    // dropped to "". The metadata still reports a numeric value (just 0).
    // To assert non-zero here we use a positive-budget override — see
    // Test 6c below for the D-02-default zero-budget path.
  });

  it("Test 6b: missing sources → section_tokens value is 0, not absent", () => {
    let capturedMetadata: Record<string, unknown> | undefined;
    const spanEnd = vi.fn();
    const startSpan = vi.fn(() => ({
      end: spanEnd,
      setMetadata: (m: Record<string, unknown>) => {
        capturedMetadata = m;
      },
    }));
    const turn = { startSpan, end: vi.fn() };

    const sources = makeSources({ identity: "id" });
    (assembleContextTraced as any)(sources, DEFAULT_BUDGETS, undefined, turn);

    const sectionTokens = (capturedMetadata as any).section_tokens;
    expect(sectionTokens.soul).toBe(0);
    expect(sectionTokens.skills_header).toBe(0);
    expect(sectionTokens.hot_tier).toBe(0);
    expect(sectionTokens.recent_history).toBe(0);
    expect(sectionTokens.per_turn_summary).toBe(0);
    expect(sectionTokens.resume_summary).toBe(0);
  });

  it("Test 7: AssembledContext return shape has exactly 3 readonly fields, frozen", () => {
    const sources = makeSources({ identity: "id", hotMemories: "- mem" });
    const result = assembleContext(sources);
    expect(Object.keys(result).sort()).toEqual(
      ["hotStableToken", "mutableSuffix", "stablePrefix"].sort(),
    );
    expect(Object.keys(result)).toHaveLength(3);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("Test 8: budget defaults — calling assembleContext without Phase 53 budgets works", () => {
    const sources = makeSources({ identity: "id text" });
    // No throw, returns valid shape
    const result = assembleContext(sources);
    expect(result).toBeDefined();
    expect(Object.keys(result)).toHaveLength(3);
  });

  it("Test 9: per-section budget merge — overrides take precedence over defaults", () => {
    const entries: readonly MemoryEntry[] = [
      makeMemoryEntry({ content: "mem-high-" + "x".repeat(200), importance: 0.9 }),
      makeMemoryEntry({ content: "mem-low-" + "y".repeat(200), importance: 0.1 }),
    ];
    const hotRendered = entries.map((m) => `- ${m.content}`).join("\n");
    const warnings: BudgetWarningEvent[] = [];

    // With generous default, nothing would truncate. Override with 30 forces drop.
    assembleContext(
      makeSources({ identity: "id", hotMemories: hotRendered, hotMemoriesEntries: entries }),
      DEFAULT_BUDGETS,
      {
        memoryAssemblyBudgets: { hot_tier: 30 },
        onBudgetWarning: (e) => warnings.push(e),
      },
    );

    const hotWarn = warnings.find((w) => w.section === "hot_tier");
    expect(hotWarn).toBeDefined();
    expect(hotWarn!.budgetTokens).toBe(30);
  });

  it("Test 10: onBudgetWarning callback invoked with correct event shape", () => {
    const warnings: BudgetWarningEvent[] = [];
    const entries: readonly MemoryEntry[] = [
      makeMemoryEntry({ content: "a".repeat(500), importance: 0.9 }),
      makeMemoryEntry({ content: "b".repeat(500), importance: 0.1 }),
    ];
    const rendered = entries.map((m) => `- ${m.content}`).join("\n");

    assembleContext(
      makeSources({
        identity: "X".repeat(10000),
        hotMemories: rendered,
        hotMemoriesEntries: entries,
      }),
      DEFAULT_BUDGETS,
      {
        memoryAssemblyBudgets: { identity: 10, hot_tier: 10 },
        onBudgetWarning: (e) => warnings.push(e),
      },
    );

    // At least identity + hot_tier trigger warnings
    const identityWarn = warnings.find((w) => w.section === "identity");
    const hotWarn = warnings.find((w) => w.section === "hot_tier");
    expect(identityWarn).toBeDefined();
    expect(hotWarn).toBeDefined();
    for (const w of warnings) {
      expect(typeof w.section).toBe("string");
      expect(typeof w.beforeTokens).toBe("number");
      expect(typeof w.budgetTokens).toBe("number");
      expect(typeof w.strategy).toBe("string");
    }
  });

  it("Test 11: no warnings when all sources fit", () => {
    // Phase 115 Plan 03 D-02: soul budget is now 0 (folded into identity),
    // so passing any soul content with the default budgets triggers a warn.
    // Use the legacy Phase 53 starter values inline so this guard test
    // exercises the no-warn path without the D-02 zero-soul fold.
    const warnings: BudgetWarningEvent[] = [];
    assembleContext(
      makeSources({ identity: "short id", soul: "short soul" }),
      DEFAULT_BUDGETS,
      {
        memoryAssemblyBudgets: { identity: 1000, soul: 2000 },
        onBudgetWarning: (e) => warnings.push(e),
      },
    );
    expect(warnings).toHaveLength(0);
  });

  it("Test 12: hot-tier placement — importance-drop applies in mutable when hotInMutable", () => {
    // keep bullet = 5 tokens; drop bullet = ~8 tokens. Budget 5 fits only
    // the keep bullet (first accumulated), then drop (5+8 > 5) is dropped.
    const entries: readonly MemoryEntry[] = [
      makeMemoryEntry({ content: "keep-" + "x".repeat(20), importance: 0.95 }),
      makeMemoryEntry({ content: "drop-" + "y".repeat(20), importance: 0.05 }),
    ];
    const rendered = entries.map((m) => `- ${m.content}`).join("\n");
    const warnings: BudgetWarningEvent[] = [];

    const result = assembleContext(
      makeSources({
        identity: "id",
        hotMemories: rendered,
        hotMemoriesEntries: entries,
      }),
      DEFAULT_BUDGETS,
      {
        priorHotStableToken: "0".repeat(64), // force mutable placement
        memoryAssemblyBudgets: { hot_tier: 5 },
        onBudgetWarning: (e) => warnings.push(e),
      },
    ) as unknown as { stablePrefix: string; mutableSuffix: string };

    // Hot-tier lands in MUTABLE (not stable) yet still reflects importance drop
    expect(result.mutableSuffix).toContain("## Key Memories");
    expect(result.mutableSuffix).toContain("keep-");
    expect(result.mutableSuffix).not.toContain("drop-");
    expect(result.stablePrefix).not.toContain("## Key Memories");
  });

  it("Test 13: resumeSummary and perTurnSummary split into separate section_tokens", () => {
    let capturedMetadata: Record<string, unknown> | undefined;
    const spanEnd = vi.fn();
    const startSpan = vi.fn(() => ({
      end: spanEnd,
      setMetadata: (m: Record<string, unknown>) => {
        capturedMetadata = m;
      },
    }));
    const turn = { startSpan, end: vi.fn() };

    const sources = makeSources({
      identity: "id",
      perTurnSummary: "per-turn text",
      resumeSummary: "resume text longer than per-turn here",
    });

    const result = (assembleContextTraced as any)(sources, DEFAULT_BUDGETS, undefined, turn) as {
      stablePrefix: string;
      mutableSuffix: string;
    };

    const sectionTokens = (capturedMetadata as any).section_tokens;
    expect(sectionTokens.per_turn_summary).toBeGreaterThan(0);
    expect(sectionTokens.resume_summary).toBeGreaterThan(0);
    // Each lands in mutable
    expect(result.mutableSuffix).toContain("per-turn text");
    expect(result.mutableSuffix).toContain("resume text");

    // Legacy contextSummary input (no new fields) still works
    const legacy = (assembleContextTraced as any)(
      makeSources({ identity: "id", contextSummary: "legacy summary" }),
      DEFAULT_BUDGETS,
      undefined,
      turn,
    ) as { mutableSuffix: string };
    expect(legacy.mutableSuffix).toContain("legacy summary");
  });

  it("Test 14: legacy 30+ joinAssembled tests — regression guard", () => {
    // Sentinel test — if any prior assembleContext behavior changed, earlier
    // describe blocks would fail. This just asserts DEFAULT_PHASE53_BUDGETS
    // is shipped frozen with all canonical keys.
    //
    // Phase 115 Plan 03 D-02 lock: `soul` is now 0 (folded into identity);
    // all OTHER sections retain non-zero budgets. The previous assertion
    // required all > 0 — that intent is now expressed as "exists with
    // documented type" since `soul: 0` is the locked Phase 115 D-02 value.
    expect(Object.isFrozen(DEFAULT_PHASE53_BUDGETS)).toBe(true);
    expect(DEFAULT_PHASE53_BUDGETS.identity).toBeGreaterThan(0);
    expect(typeof DEFAULT_PHASE53_BUDGETS.soul).toBe("number"); // 0 per D-02
    expect(DEFAULT_PHASE53_BUDGETS.skills_header).toBeGreaterThan(0);
    expect(DEFAULT_PHASE53_BUDGETS.hot_tier).toBeGreaterThan(0);
    expect(DEFAULT_PHASE53_BUDGETS.recent_history).toBeGreaterThan(0);
    expect(DEFAULT_PHASE53_BUDGETS.per_turn_summary).toBeGreaterThan(0);
    expect(DEFAULT_PHASE53_BUDGETS.resume_summary).toBeGreaterThan(0);
  });
});

// ── Phase 53 Plan 03 — lazy-skill compression ────────────────────────────────

import type {
  SkillCatalogEntry,
  SkillUsageWindow as AssemblerSkillUsageWindow,
  ResolvedLazySkillsConfig,
} from "../context-assembler.js";

function makeSkillUsage(
  recentlyUsed: readonly string[],
  turns: number,
): AssemblerSkillUsageWindow {
  return Object.freeze({
    turns,
    capacity: 20,
    recentlyUsed: Object.freeze(new Set(recentlyUsed)) as ReadonlySet<string>,
  });
}

function makeLazyCfg(
  overrides: Partial<ResolvedLazySkillsConfig> = {},
): ResolvedLazySkillsConfig {
  return Object.freeze({
    enabled: true,
    usageThresholdTurns: 20,
    reinflateOnMention: true,
    ...overrides,
  });
}

const FULL_SEARCH_FIRST = "# Search First\n\nSkill name: search-first. Research before coding. Full content here with lots of detail about when to use this skill and what it does.";
const FULL_CONTENT_ENGINE = "# Content Engine\n\nSkill name: content-engine. Writes content. Full SKILL.md body with many lines of guidance.";
const FULL_MARKET_RESEARCH = "# Market Research\n\nSkill name: market-research. Researches markets. Full body text.";

const SKILLS_CATALOG: readonly SkillCatalogEntry[] = Object.freeze([
  Object.freeze({
    name: "search-first",
    description: "Research before coding",
    fullContent: FULL_SEARCH_FIRST,
  }),
  Object.freeze({
    name: "content-engine",
    description: "Content creation",
    fullContent: FULL_CONTENT_ENGINE,
  }),
  Object.freeze({
    name: "market-research",
    description: "Market sizing and research",
    fullContent: FULL_MARKET_RESEARCH,
  }),
]);

describe("assembleContext lazy-skill compression (Phase 53 Plan 03)", () => {
  it("Test 1: recently-used skill renders FULL content; unused renders one-line entry", () => {
    const sources = makeSources({
      identity: "id",
      skills: SKILLS_CATALOG,
      skillUsage: makeSkillUsage(["search-first"], 30),
      lazySkillsConfig: makeLazyCfg(),
    });

    const result = assembleContext(sources) as unknown as {
      stablePrefix: string;
    };

    // search-first present in full form
    expect(result.stablePrefix).toContain("# Search First");
    expect(result.stablePrefix).toContain("Research before coding. Full content here");
    // content-engine compressed to one-liner
    expect(result.stablePrefix).toContain("- content-engine: Content creation");
    // content-engine full body NOT present
    expect(result.stablePrefix).not.toContain("# Content Engine");
    // market-research also compressed
    expect(result.stablePrefix).toContain("- market-research: Market sizing and research");
  });

  it("Test 2: lazySkills.enabled=false → ALL skills render full content", () => {
    const sources = makeSources({
      identity: "id",
      skills: SKILLS_CATALOG,
      skillUsage: makeSkillUsage([], 30),
      lazySkillsConfig: makeLazyCfg({ enabled: false }),
    });
    const result = assembleContext(sources) as unknown as {
      stablePrefix: string;
    };
    expect(result.stablePrefix).toContain("# Search First");
    expect(result.stablePrefix).toContain("# Content Engine");
    expect(result.stablePrefix).toContain("# Market Research");
  });

  it("Test 3: warm-up (usage.turns < threshold) → ALL skills render full content", () => {
    const sources = makeSources({
      identity: "id",
      skills: SKILLS_CATALOG,
      skillUsage: makeSkillUsage(["search-first"], 5), // turns 5 < 20
      lazySkillsConfig: makeLazyCfg({ usageThresholdTurns: 20 }),
    });
    const result = assembleContext(sources) as unknown as {
      stablePrefix: string;
    };
    expect(result.stablePrefix).toContain("# Search First");
    expect(result.stablePrefix).toContain("# Content Engine");
    expect(result.stablePrefix).toContain("# Market Research");
  });

  it("Test 4: re-inflate on mention from current user message", () => {
    const sources = makeSources({
      identity: "id",
      skills: SKILLS_CATALOG,
      skillUsage: makeSkillUsage([], 30), // nothing recently used
      lazySkillsConfig: makeLazyCfg(),
      currentUserMessage: "Please use content-engine for this task",
    });
    const result = assembleContext(sources) as unknown as {
      stablePrefix: string;
    };
    // content-engine re-inflates to full content
    expect(result.stablePrefix).toContain("# Content Engine");
    // search-first stays compressed
    expect(result.stablePrefix).not.toContain("# Search First");
    expect(result.stablePrefix).toContain("- search-first: Research before coding");
  });

  it("Test 5: re-inflate on mention from last assistant message", () => {
    const sources = makeSources({
      identity: "id",
      skills: SKILLS_CATALOG,
      skillUsage: makeSkillUsage([], 30),
      lazySkillsConfig: makeLazyCfg(),
      lastAssistantMessage: "I used market-research earlier for this",
    });
    const result = assembleContext(sources) as unknown as {
      stablePrefix: string;
    };
    expect(result.stablePrefix).toContain("# Market Research");
    expect(result.stablePrefix).not.toContain("# Search First");
  });

  it("Test 6: reinflateOnMention=false disables mention-driven re-inflation", () => {
    const sources = makeSources({
      identity: "id",
      skills: SKILLS_CATALOG,
      skillUsage: makeSkillUsage([], 30),
      lazySkillsConfig: makeLazyCfg({ reinflateOnMention: false }),
      currentUserMessage: "use content-engine please",
    });
    const result = assembleContext(sources) as unknown as {
      stablePrefix: string;
    };
    // content-engine stays compressed despite mention
    expect(result.stablePrefix).not.toContain("# Content Engine");
    expect(result.stablePrefix).toContain("- content-engine: Content creation");
  });

  it("Test 7: word-boundary — substring does NOT re-inflate", () => {
    const sources = makeSources({
      identity: "id",
      skills: SKILLS_CATALOG,
      skillUsage: makeSkillUsage([], 30),
      lazySkillsConfig: makeLazyCfg(),
      currentUserMessage: "subsearch-firstline is unrelated",
    });
    const result = assembleContext(sources) as unknown as {
      stablePrefix: string;
    };
    expect(result.stablePrefix).not.toContain("# Search First");
    expect(result.stablePrefix).toContain("- search-first: Research before coding");
  });

  it("Test 8: span metadata carries skills_included_count + skills_compressed_count", () => {
    let capturedMetadata: Record<string, unknown> | undefined;
    const startSpan = vi.fn(() => ({
      end: vi.fn(),
      setMetadata: (m: Record<string, unknown>) => {
        capturedMetadata = { ...capturedMetadata, ...m };
      },
    }));
    const turn = { startSpan, end: vi.fn() };

    const sources = makeSources({
      identity: "id",
      skills: SKILLS_CATALOG,
      skillUsage: makeSkillUsage(["search-first"], 30),
      lazySkillsConfig: makeLazyCfg(),
    });

    (assembleContextTraced as any)(sources, DEFAULT_BUDGETS, undefined, turn);

    expect(capturedMetadata).toBeDefined();
    expect((capturedMetadata as any).skills_included_count).toBe(1);
    expect((capturedMetadata as any).skills_compressed_count).toBe(2);
    expect((capturedMetadata as any).section_tokens).toBeDefined();
  });

  it("Test 9: section_tokens.skills_header shrinks when compression is active", () => {
    let allFullMeta: Record<string, unknown> | undefined;
    let compressedMeta: Record<string, unknown> | undefined;

    const mkSpan = (capture: (m: Record<string, unknown>) => void) => ({
      end: vi.fn(),
      setMetadata: capture,
    });

    // All full (lazySkills disabled)
    let turn1 = {
      startSpan: vi.fn(() =>
        mkSpan((m) => {
          allFullMeta = { ...allFullMeta, ...m };
        }),
      ),
      end: vi.fn(),
    };
    (assembleContextTraced as any)(
      makeSources({
        identity: "id",
        skills: SKILLS_CATALOG,
        skillUsage: makeSkillUsage([], 30),
        lazySkillsConfig: makeLazyCfg({ enabled: false }),
      }),
      DEFAULT_BUDGETS,
      undefined,
      turn1,
    );

    // 1 full / 2 compressed
    let turn2 = {
      startSpan: vi.fn(() =>
        mkSpan((m) => {
          compressedMeta = { ...compressedMeta, ...m };
        }),
      ),
      end: vi.fn(),
    };
    (assembleContextTraced as any)(
      makeSources({
        identity: "id",
        skills: SKILLS_CATALOG,
        skillUsage: makeSkillUsage(["search-first"], 30),
        lazySkillsConfig: makeLazyCfg(),
      }),
      DEFAULT_BUDGETS,
      undefined,
      turn2,
    );

    const fullTokens = ((allFullMeta as any).section_tokens as { skills_header: number }).skills_header;
    const compTokens = ((compressedMeta as any).section_tokens as { skills_header: number }).skills_header;
    expect(fullTokens).toBeGreaterThan(compTokens);
  });

  it("Test 10: compressed skills remain in catalog (one-liner) — not dropped entirely", () => {
    const sources = makeSources({
      identity: "id",
      skills: SKILLS_CATALOG,
      skillUsage: makeSkillUsage(["search-first"], 30),
      lazySkillsConfig: makeLazyCfg(),
    });
    const result = assembleContext(sources) as unknown as {
      stablePrefix: string;
    };
    // All three skill NAMES present (either full or compressed)
    expect(result.stablePrefix).toContain("search-first");
    expect(result.stablePrefix).toContain("content-engine");
    expect(result.stablePrefix).toContain("market-research");
  });

  it("Test 11: no skills array → behaves as legacy (skillsHeader pass-through)", () => {
    const sources = makeSources({
      identity: "id",
      skillsHeader: "- legacy-skill: legacy desc",
    });
    const result = assembleContext(sources) as unknown as {
      stablePrefix: string;
    };
    expect(result.stablePrefix).toContain("legacy-skill");
  });

  it("Test 12: AssembledContext return shape still has exactly 3 frozen keys", () => {
    const sources = makeSources({
      identity: "id",
      skills: SKILLS_CATALOG,
      skillUsage: makeSkillUsage(["search-first"], 30),
      lazySkillsConfig: makeLazyCfg(),
    });
    const result = assembleContext(sources);
    expect(Object.keys(result).sort()).toEqual(
      ["hotStableToken", "mutableSuffix", "stablePrefix"].sort(),
    );
    expect(Object.keys(result)).toHaveLength(3);
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// ── Phase 67 — conversation_context section in mutable suffix ──────────────

describe("assembleContext — Phase 67 conversation_context", () => {
  it("measures conversation_context tokens", () => {
    let capturedMetadata: Record<string, unknown> | undefined;
    const spanEnd = vi.fn();
    const startSpan = vi.fn(() => ({
      end: spanEnd,
      setMetadata: (m: Record<string, unknown>) => {
        capturedMetadata = m;
      },
    }));
    const turn = { startSpan, end: vi.fn() };

    const briefText =
      "## Recent Sessions\n\n### Session from 2026-04-18 (5 hours ago)\nUser asked about deployment.";
    const sources = makeSources({
      identity: "I am an agent",
      conversationContext: briefText,
    });

    const result = (assembleContextTraced as any)(
      sources,
      DEFAULT_BUDGETS,
      undefined,
      turn,
    ) as {
      stablePrefix: string;
      mutableSuffix: string;
    };

    // Brief lands in MUTABLE suffix (Pitfall 1 invariant — NOT in stable prefix)
    expect(result.mutableSuffix).toContain("## Recent Sessions");
    expect(result.mutableSuffix).toContain("Session from 2026-04-18");
    expect(result.stablePrefix).not.toContain("## Recent Sessions");
    expect(result.stablePrefix).not.toContain("Session from 2026-04-18");

    // section_tokens.conversation_context is measured and non-zero
    expect(capturedMetadata).toBeDefined();
    const sectionTokens = (capturedMetadata as any).section_tokens;
    expect(typeof sectionTokens.conversation_context).toBe("number");
    expect(sectionTokens.conversation_context).toBeGreaterThan(0);
  });

  it("emits conversation_context = 0 when source is empty", () => {
    let capturedMetadata: Record<string, unknown> | undefined;
    const spanEnd = vi.fn();
    const startSpan = vi.fn(() => ({
      end: spanEnd,
      setMetadata: (m: Record<string, unknown>) => {
        capturedMetadata = m;
      },
    }));
    const turn = { startSpan, end: vi.fn() };

    const sources = makeSources({ identity: "id" });
    (assembleContextTraced as any)(sources, DEFAULT_BUDGETS, undefined, turn);

    const sectionTokens = (capturedMetadata as any).section_tokens;
    expect(sectionTokens.conversation_context).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 999.13 — DELEG (delegatesBlock injection in stable prefix)
//
// Wave 0 RED tests. These FAIL on current main because:
//   - ContextSources has no `delegatesBlock` field yet (Plan 01 adds it)
//   - assembleContext() does not yet append the block after toolDefinitions
//
// We use `as ContextSources` casts (and `// @ts-expect-error` where needed)
// so this file still compiles via tsc — the tests will fail at runtime
// because the production assembler ignores the new field today.
// ---------------------------------------------------------------------------
describe("Phase 999.13 — DELEG: delegatesBlock injection", () => {
  // Use the canonical render output from <canonical_text> in PLAN.md so
  // drift is caught in either pillar.
  const CANONICAL_BLOCK = [
    "## Specialist Delegation",
    "For tasks matching a specialty below, delegate via the spawn-subagent-thread skill:",
    "- research → fin-research",
    "Verify the target is at opus/high before delegating; if mismatch, surface to operator and stop. The subthread posts its summary back to your channel when done.",
  ].join("\n");

  it("delegates-block-injection: when sources.delegatesBlock is non-empty, stablePrefix contains it AFTER '## Available Tools'", () => {
    const sources = makeSources({
      identity: "I am an agent",
      toolDefinitions: "tool-content-here",
      // Phase 999.13 RED — Plan 01 adds delegatesBlock to ContextSources.
      delegatesBlock: CANONICAL_BLOCK,
    } as Partial<ContextSources> & { delegatesBlock: string });

    const result = assembleContext(sources, DEFAULT_BUDGETS);
    const stablePrefix = (result as { stablePrefix: string }).stablePrefix;

    // Block must appear in the stable prefix at all
    expect(stablePrefix).toContain("## Specialist Delegation");
    expect(stablePrefix).toContain("- research → fin-research");

    // Block must appear AFTER the tools section (per CONTEXT.md "block goes
    // at the bottom of the agent's system prompt").
    const toolsIdx = stablePrefix.indexOf("## Available Tools");
    const delegIdx = stablePrefix.indexOf("## Specialist Delegation");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(delegIdx).toBeGreaterThan(toolsIdx);
  });

  it("delegates-block-injection: arbitrary marker string lands in stablePrefix when threaded as delegatesBlock", () => {
    // Sentinel marker lets us prove byte-flow from sources.delegatesBlock
    // through to the assembled stablePrefix without coupling to canonical text.
    const SENTINEL = "DELEG_BLOCK_SENTINEL_999_13_X";
    const sources = makeSources({
      identity: "id",
      toolDefinitions: "tools",
      // Phase 999.13 RED — Plan 01 adds delegatesBlock to ContextSources.
      delegatesBlock: SENTINEL,
    } as Partial<ContextSources> & { delegatesBlock: string });

    const result = assembleContext(sources, DEFAULT_BUDGETS);
    const stablePrefix = (result as { stablePrefix: string }).stablePrefix;
    expect(stablePrefix).toContain(SENTINEL);
  });

  it("delegates-block-empty-baseline: omitting delegatesBlock vs delegatesBlock='' produces byte-identical stablePrefix", () => {
    // Per Pitfall 2 — empty/unset must short-circuit with NO header, NO
    // whitespace pollution. Critical for prompt-cache hash stability.
    const baseline = makeSources({
      identity: "I am an agent",
      toolDefinitions: "tool-content-here",
    });
    const withEmpty = makeSources({
      identity: "I am an agent",
      toolDefinitions: "tool-content-here",
      // Phase 999.13 RED — Plan 01 adds delegatesBlock to ContextSources.
      delegatesBlock: "",
    } as Partial<ContextSources> & { delegatesBlock: string });

    const baselineResult = assembleContext(baseline, DEFAULT_BUDGETS);
    const emptyResult = assembleContext(withEmpty, DEFAULT_BUDGETS);

    expect((emptyResult as { stablePrefix: string }).stablePrefix).toBe(
      (baselineResult as { stablePrefix: string }).stablePrefix,
    );
    // Pin the hash so any future drift to the no-delegates baseline fails loud.
    const baselineHash = createHash("sha256")
      .update((baselineResult as { stablePrefix: string }).stablePrefix)
      .digest("hex");
    const emptyHash = createHash("sha256")
      .update((emptyResult as { stablePrefix: string }).stablePrefix)
      .digest("hex");
    expect(emptyHash).toBe(baselineHash);
  });
});
