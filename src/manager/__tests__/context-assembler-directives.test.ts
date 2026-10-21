/**
 * Phase 94 Plan 06 — TOOL-10 D-10 D-09 D-07
 *
 * context-assembler integration tests for the systemPromptDirectives block.
 *
 * Contract:
 *   - When sources.systemPromptDirectives is non-empty, the assembler
 *     prepends it as the FIRST element of stableParts (BEFORE identity →
 *     BEFORE Available Tools block).
 *   - When all directives are disabled (empty source), the stable prefix
 *     is identical to the no-directives baseline (no marker comments,
 *     deterministic for prompt-cache hash stability).
 *   - Output is byte-deterministic across calls for cache stability.
 */
import { describe, it, expect } from "vitest";
import {
  assembleContext,
  type ContextSources,
} from "../context-assembler.js";

function makeSources(overrides: Partial<ContextSources> = {}): ContextSources {
  return {
    identity: "I am test-agent.",
    hotMemories: "",
    toolDefinitions: "- browser: take screenshots",
    graphContext: "",
    discordBindings: "",
    contextSummary: "",
    ...overrides,
  } as ContextSources;
}

describe("context-assembler — systemPromptDirectives prepend (Phase 94 TOOL-10)", () => {
  it("REG-ASSEMBLER-PREPENDS: directive block lands BEFORE the Available Tools block in stable prefix", () => {
    const directiveBlock =
      "When you produce a file the user wants to access, ALWAYS upload via Discord and return the CDN URL.";
    const sources = makeSources({
      // New ContextSources field: pre-rendered directive block from
      // resolveSystemPromptDirectives (joined "\n\n").
      systemPromptDirectives: directiveBlock,
    } as Partial<ContextSources>);

    const out = assembleContext(sources);

    // Directive substring present
    expect(out.stablePrefix).toContain("ALWAYS upload via Discord");
    // Tools block also present
    expect(out.stablePrefix).toContain("Available Tools");
    // Directive comes BEFORE the tools block (character index ordering)
    const directiveIdx = out.stablePrefix.indexOf("ALWAYS upload via Discord");
    const toolsIdx = out.stablePrefix.indexOf("## Available Tools");
    expect(directiveIdx).toBeGreaterThanOrEqual(0);
    expect(toolsIdx).toBeGreaterThan(directiveIdx);
  });

  it("REG-ASSEMBLER-PREPENDS-FIRST: directive block is the FIRST element of stable prefix (before identity)", () => {
    const directiveBlock = "Directive line one.";
    const sources = makeSources({
      identity: "I am test-agent.",
      systemPromptDirectives: directiveBlock,
    } as Partial<ContextSources>);

    const out = assembleContext(sources);

    // The stable prefix begins with the directive block — directives are
    // operator-mandated rules and lead the prefix so the LLM sees them
    // BEFORE persona / tools.
    expect(out.stablePrefix.startsWith(directiveBlock)).toBe(true);
  });

  it("REG-ASSEMBLER-EMPTY-WHEN-DISABLED: empty directives source produces stable prefix without directive marker (matches no-directives baseline)", () => {
    const baseline = assembleContext(makeSources());

    const withEmpty = assembleContext(
      makeSources({ systemPromptDirectives: "" } as Partial<ContextSources>),
    );

    // Empty directive source → stable prefix is byte-identical to baseline.
    // No marker comments, no leading whitespace — prompt-cache stability
    // requires deterministic output.
    expect(withEmpty.stablePrefix).toBe(baseline.stablePrefix);
    // Sanity: directive text NOT present anywhere
    expect(withEmpty.stablePrefix).not.toContain("ALWAYS upload via Discord");
  });

  it("REG-DETERMINISTIC: assembling twice with the same directive source produces byte-identical stable prefix", () => {
    const sources = makeSources({
      systemPromptDirectives:
        "When you produce a file, ALWAYS upload via Discord.",
    } as Partial<ContextSources>);

    const a = assembleContext(sources);
    const b = assembleContext(sources);
    expect(a.stablePrefix).toBe(b.stablePrefix);
  });
});
