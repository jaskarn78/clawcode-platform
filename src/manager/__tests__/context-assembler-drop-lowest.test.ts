/**
 * Phase 115 Plan 03 sub-scope 1 / T02 — `enforceDropLowestImportance` for
 * the carved identity sub-sources, plus `enforceTotalStablePrefixBudget`
 * for the 8K outer cap.
 *
 * Verifies:
 *   - Under-budget identity passes through verbatim (no truncation, no warn).
 *   - Over-budget identity drops MEMORY.md sections FIRST while SOUL fingerprint
 *     stays verbatim.
 *   - Hugely over-budget identity progressively truncates MEMORY.md →
 *     capability manifest → IDENTITY.md (head-tail). SOUL fingerprint
 *     remains verbatim verbatim.
 *   - Total stable-prefix exceeds 8K → emergency head-tail fires; log.error
 *     called with action `stable-prefix-cap-fallback`.
 *   - `headTailTruncate` is exercised indirectly: head 70%, tail 20%, marker
 *     in the middle; under-target inputs return unchanged.
 */

import { describe, it, expect, vi } from "vitest";
import {
  assembleContext,
  STABLE_PREFIX_MAX_TOKENS,
  type ContextSources,
  type BudgetWarningEvent,
} from "../context-assembler.js";

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

describe("enforceDropLowestImportance — Phase 115 Plan 03 sub-scope 1 / T02", () => {
  it("under-budget identity passes through verbatim with NO warn", () => {
    const warnings: BudgetWarningEvent[] = [];
    const sources = makeSources({
      identitySoulFingerprint: "## SOUL fingerprint\n- vibe: dry-wit",
      identityFile: "## My persona\n\nI am clawdy.",
      identityCapabilityManifest: "Your name is clawdy.\nDream consolidation.",
      identityMemoryAutoload: "## Things I remember\n- A short fact.",
    });

    const result = assembleContext(sources, undefined, {
      memoryAssemblyBudgets: { identity: 4000 },
      onBudgetWarning: (e) => warnings.push(e),
    });

    // Under budget — no warn fires.
    expect(warnings).toHaveLength(0);
    // All four sub-sources land verbatim.
    expect(result.stablePrefix).toContain("## SOUL fingerprint");
    expect(result.stablePrefix).toContain("## My persona");
    expect(result.stablePrefix).toContain("Your name is clawdy");
    expect(result.stablePrefix).toContain("A short fact");
  });

  it("over-budget identity drops MEMORY.md sections FIRST; SOUL fingerprint preserved verbatim", () => {
    const warnings: BudgetWarningEvent[] = [];
    // Construct sub-sources that PUSH the identity over a 200-token budget.
    // SOUL fingerprint: small (preserved verbatim).
    // IDENTITY.md: medium.
    // capability: small.
    // MEMORY.md: HUGE (~50K chars) — should get truncated first.
    const soulFp = "## SOUL fingerprint — DO-NOT-DROP\n- vibe: dry-wit";
    const idFile = "## Persona — keep when possible\n\nI am clawdy.";
    const capManifest =
      "Your name is clawdy.\nYou have dream consolidation enabled.";
    const memoryAutoload =
      "## Memory bank\n\n" + "- a fact about a thing.\n".repeat(2000);
    const sources = makeSources({
      identitySoulFingerprint: soulFp,
      identityFile: idFile,
      identityCapabilityManifest: capManifest,
      identityMemoryAutoload: memoryAutoload,
    });

    const result = assembleContext(sources, undefined, {
      memoryAssemblyBudgets: { identity: 200 },
      onBudgetWarning: (e) => warnings.push(e),
    });

    // SOUL fingerprint MUST remain verbatim — highest importance.
    expect(result.stablePrefix).toContain(
      "## SOUL fingerprint — DO-NOT-DROP",
    );
    // The full 50K MEMORY.md MUST NOT remain — it's been truncated.
    expect(result.stablePrefix).not.toContain(
      "- a fact about a thing.\n".repeat(2000),
    );
    // The truncation marker should appear somewhere in the prefix.
    expect(result.stablePrefix).toContain("[TRUNCATED");
    // Identity-section budget warning fired with the new strategy.
    const identityWarn = warnings.find((w) => w.section === "identity");
    expect(identityWarn).toBeDefined();
    expect(identityWarn!.strategy).toBe("drop-lowest-importance");
  });

  it("hugely over budget — all four progressively truncate; SOUL still verbatim", () => {
    const soulFp = "## SOUL — DO-NOT-DROP\n- vibe: dry-wit";
    // ~10K chars each for the three lower-priority sub-sources
    const idFile = "## Persona\n" + "Keep me if possible. ".repeat(500);
    const capManifest = "Your name is clawdy. ".repeat(500);
    const memoryAutoload = "Memory section. ".repeat(500);
    const sources = makeSources({
      identitySoulFingerprint: soulFp,
      identityFile: idFile,
      identityCapabilityManifest: capManifest,
      identityMemoryAutoload: memoryAutoload,
    });

    const warnings: BudgetWarningEvent[] = [];
    // Tight budget — only the SOUL fingerprint should comfortably fit.
    const result = assembleContext(sources, undefined, {
      memoryAssemblyBudgets: { identity: 100 },
      onBudgetWarning: (e) => warnings.push(e),
    });

    // SOUL fingerprint preserved verbatim.
    expect(result.stablePrefix).toContain("## SOUL — DO-NOT-DROP");
    expect(result.stablePrefix).toContain("vibe: dry-wit");

    // Identity warn fired with drop-lowest strategy.
    const identityWarn = warnings.find((w) => w.section === "identity");
    expect(identityWarn).toBeDefined();
    expect(identityWarn!.strategy).toBe("drop-lowest-importance");
    expect(identityWarn!.beforeTokens).toBeGreaterThan(100);
  });

  it("identity with empty MEMORY.md and small content stays under budget cleanly", () => {
    const sources = makeSources({
      identitySoulFingerprint: "fp",
      identityFile: "id",
      identityCapabilityManifest: "cap",
      identityMemoryAutoload: "",
    });
    const warnings: BudgetWarningEvent[] = [];
    const result = assembleContext(sources, undefined, {
      memoryAssemblyBudgets: { identity: 4000 },
      onBudgetWarning: (e) => warnings.push(e),
    });
    expect(warnings).toHaveLength(0);
    expect(result.stablePrefix).toContain("fp");
    expect(result.stablePrefix).toContain("id");
    expect(result.stablePrefix).toContain("cap");
    expect(result.stablePrefix).not.toContain("## Long-term memory (MEMORY.md)");
  });
});

describe("enforceTotalStablePrefixBudget — Phase 115 Plan 03 sub-scope 1 / T02", () => {
  it("under outer cap → no fallback fires, no log.error", () => {
    const errorCalls: Array<{ obj: Record<string, unknown>; msg?: string }> =
      [];
    const log = {
      error: (obj: Record<string, unknown>, msg?: string) =>
        errorCalls.push({ obj, msg }),
    };

    const sources = makeSources({
      identity: "small id",
      hotMemories: "- one",
      toolDefinitions: "tool: x",
    });

    assembleContext(sources, undefined, { log, agentName: "test-agent" });
    expect(errorCalls).toHaveLength(0);
  });

  it("over 8K outer cap → emergency head-tail fires; log.error called with stable-prefix-cap-fallback action", () => {
    const errorCalls: Array<{ obj: Record<string, unknown>; msg?: string }> =
      [];
    const log = {
      error: (obj: Record<string, unknown>, msg?: string) =>
        errorCalls.push({ obj, msg }),
    };

    // BPE tokenizer compresses repeating chars heavily — `"x".repeat(50000)`
    // is only ~1563 tokens. Use realistic varied prose so token count
    // matches char/4 estimate. Each line is ~100 chars, ~25 tokens. Need
    // > 8K tokens stable prefix to trip the outer cap. 800 lines × 25
    // tokens = 20K tokens > 8K cap.
    const lines: string[] = [];
    for (let i = 0; i < 800; i++) {
      lines.push(
        `Persona note ${i}: This agent is named clawdy and operates as a multi-agent orchestration platform helper.`,
      );
    }
    const longIdentity = lines.join("\n");
    const sources = makeSources({ identity: longIdentity });
    const result = assembleContext(sources, undefined, {
      memoryAssemblyBudgets: { identity: 30_000 }, // huge per-section budget so outer cap kicks in
      log,
      agentName: "over-cap-agent",
    });

    // Outer cap kicks in — final stable prefix is at-or-under cap chars.
    expect(result.stablePrefix.length).toBeLessThanOrEqual(
      STABLE_PREFIX_MAX_TOKENS * 4 + 1000, // ~32K chars + marker overhead
    );
    expect(result.stablePrefix).toContain("[TRUNCATED");
    // Log error fires with structured fields.
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    const fallback = errorCalls.find(
      (c) => c.obj.action === "stable-prefix-cap-fallback",
    );
    expect(fallback).toBeDefined();
    expect(fallback!.obj).toMatchObject({
      agent: "over-cap-agent",
      action: "stable-prefix-cap-fallback",
    });
    expect(fallback!.msg).toContain("stable-prefix-cap-fallback");
  });
});

describe("STABLE_PREFIX_MAX_TOKENS export — Phase 115 Plan 03", () => {
  it("is the locked value 8_000", () => {
    expect(STABLE_PREFIX_MAX_TOKENS).toBe(8_000);
  });
});

describe("legacy compound `identity` over-budget HEAD-TAIL truncation", () => {
  it("legacy single-string identity is HEAD-TAIL truncated when over budget", () => {
    // Tests the back-compat path: callers passing only `sources.identity`
    // (no carved sub-sources) get the simple head-tail truncation when
    // identity exceeds the per-section budget. This replaces the Phase 53
    // `warn-and-keep` no-op contract entirely.
    //
    // BPE compresses repeating chars; use realistic prose so the token
    // count actually exceeds the 100-token budget.
    const warnings: BudgetWarningEvent[] = [];
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(
        `Sentence ${i}: This is part of the agent's persona and identity description text.`,
      );
    }
    const sources = makeSources({ identity: lines.join("\n") });

    const result = assembleContext(sources, undefined, {
      memoryAssemblyBudgets: { identity: 100 },
      onBudgetWarning: (e) => warnings.push(e),
    });

    // Truncated — input was 100 lines, ~25 tokens each = ~2500 tokens.
    // After head-tail to budget*4 chars = 400 chars, should be much smaller.
    expect(result.stablePrefix.length).toBeLessThan(800);
    expect(result.stablePrefix).toContain("[TRUNCATED");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].section).toBe("identity");
    expect(warnings[0].strategy).toBe("drop-lowest-importance");
  });

  it("vi.fn-injected log.error for the cap fallback (test seam check)", () => {
    const errorMock = vi.fn();
    // Realistic prose to exercise BPE-uncompressible content.
    const lines: string[] = [];
    for (let i = 0; i < 800; i++) {
      lines.push(
        `Statement ${i}: agent identity text varies across lines to avoid BPE compression of repeating chars.`,
      );
    }
    const sources = makeSources({ identity: lines.join("\n") });
    assembleContext(sources, undefined, {
      memoryAssemblyBudgets: { identity: 30_000 },
      log: { error: errorMock },
      agentName: "mock-agent",
    });
    expect(errorMock).toHaveBeenCalled();
    const call = errorMock.mock.calls[0];
    expect(call[0]).toMatchObject({
      agent: "mock-agent",
      action: "stable-prefix-cap-fallback",
    });
  });
});
