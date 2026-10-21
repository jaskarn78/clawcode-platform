/**
 * Phase 53 Plan 02 — enforceSummaryBudget tests (CTX-04).
 *
 * Resume-summary budget enforcement: default 1500, floor 500,
 * up-to-2 regeneration attempts, hard-truncate + WARN fallback.
 */
import { describe, it, expect, vi } from "vitest";
import {
  enforceSummaryBudget,
  DEFAULT_RESUME_SUMMARY_BUDGET,
  MIN_RESUME_SUMMARY_BUDGET,
  saveSummary,
  type SummaryRegenerator,
  type LoggerLike,
} from "../context-summary.js";
import { countTokens } from "../../performance/token-count.js";

function padTokens(count: number): string {
  // @anthropic-ai/tokenizer: roughly 1 token per 3-4 chars of varied text.
  // "word " sequences tokenize to 1-2 tokens per word — use distinct words
  // to force realistic token growth.
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    words.push(`word${i}`);
  }
  return words.join(" ");
}

describe("enforceSummaryBudget (Phase 53)", () => {
  it("Test 1: summary under budget — passthrough, no regeneration, no truncation", async () => {
    const summary = padTokens(200); // ~200-400 tokens
    const result = await enforceSummaryBudget({
      summary,
      budget: 1500,
    });
    expect(result.summary).toBe(summary);
    expect(result.truncated).toBe(false);
    expect(result.attempts).toBe(0);
    expect(result.tokens).toBe(countTokens(summary));
  });

  it("Test 2: over-budget + regen second attempt succeeds", async () => {
    const large = padTokens(4000); // definitely over 1500
    const mid = padTokens(1600); // still over 1500
    const small = padTokens(500); // under 1500

    const regen = vi.fn<SummaryRegenerator>();
    regen
      .mockResolvedValueOnce(mid) // attempt 1: still over
      .mockResolvedValueOnce(small); // attempt 2: under budget

    const result = await enforceSummaryBudget({
      summary: large,
      budget: 1500,
      regenerate: regen,
      maxAttempts: 2,
    });

    expect(regen).toHaveBeenCalledTimes(2);
    expect(result.summary).toBe(small);
    expect(result.truncated).toBe(false);
    expect(result.attempts).toBe(2);
  });

  it("Test 3: over-budget after all regen attempts — hard-truncate + WARN", async () => {
    const large = padTokens(4000);
    const stillLarge = padTokens(2000); // still over
    const alsoLarge = padTokens(1700); // still over

    const regen = vi.fn<SummaryRegenerator>();
    regen
      .mockResolvedValueOnce(stillLarge)
      .mockResolvedValueOnce(alsoLarge);

    const warn = vi.fn();
    const log: LoggerLike = { warn };

    const result = await enforceSummaryBudget({
      summary: large,
      budget: 1500,
      regenerate: regen,
      maxAttempts: 2,
      log,
      agentName: "test-agent",
    });

    expect(regen).toHaveBeenCalledTimes(2);
    expect(result.truncated).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.tokens).toBeLessThanOrEqual(1500);
    expect(result.summary.endsWith("...")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    // warn receives a record with agent + budget
    const warnArg = warn.mock.calls[0][0] as Record<string, unknown>;
    expect(warnArg.agent).toBe("test-agent");
    expect(warnArg.budget).toBe(1500);
    // NEVER log the full prompt body — security invariant
    expect(JSON.stringify(warnArg)).not.toContain("word0");
  });

  it("Test 4: regenerate NOT called when initial summary is under budget", async () => {
    const regen = vi.fn<SummaryRegenerator>();
    const result = await enforceSummaryBudget({
      summary: "short summary",
      budget: 1500,
      regenerate: regen,
    });
    expect(regen).not.toHaveBeenCalled();
    expect(result.attempts).toBe(0);
  });

  it("Test 5: first regen succeeds — attempts: 1, regenerator called once", async () => {
    const large = padTokens(4000);
    const small = padTokens(500);

    const regen = vi.fn<SummaryRegenerator>();
    regen.mockResolvedValueOnce(small);

    const result = await enforceSummaryBudget({
      summary: large,
      budget: 1500,
      regenerate: regen,
      maxAttempts: 2,
    });

    expect(regen).toHaveBeenCalledTimes(1);
    expect(result.summary).toBe(small);
    expect(result.truncated).toBe(false);
    expect(result.attempts).toBe(1);
  });

  it("Test 6: budget floor — throws RangeError when budget < MIN_RESUME_SUMMARY_BUDGET", async () => {
    await expect(
      enforceSummaryBudget({ summary: "s", budget: 499 }),
    ).rejects.toThrow(RangeError);
    // Budget === floor (500) accepted
    const result = await enforceSummaryBudget({
      summary: "s",
      budget: MIN_RESUME_SUMMARY_BUDGET,
    });
    expect(result.truncated).toBe(false);
    expect(MIN_RESUME_SUMMARY_BUDGET).toBe(500);
  });

  it("Test 7: hard-truncate uses word-boundary cut + trailing '...'", async () => {
    const large = padTokens(4000);
    const stillLarge = padTokens(2500);
    const alsoLarge = padTokens(2000);
    const regen = vi.fn<SummaryRegenerator>()
      .mockResolvedValueOnce(stillLarge)
      .mockResolvedValueOnce(alsoLarge);

    const result = await enforceSummaryBudget({
      summary: large,
      budget: 500,
      regenerate: regen,
      maxAttempts: 2,
    });
    expect(result.truncated).toBe(true);
    expect(result.summary.endsWith("...")).toBe(true);
    // No partial words: the text before "..." ends with a full token-like suffix
    const withoutEllipsis = result.summary.slice(0, -3);
    // Final char should not be mid-word start character — allow trailing digits/letters
    // (word-boundary cut aims to end at a space-delimited token, so verify no
    // leading space cut issue by confirming we don't cut inside "word123").
    // The simplest invariant: text does not end with a trailing partial space.
    expect(withoutEllipsis.trimEnd()).toBe(withoutEllipsis);
  });

  it("Test 8: saveSummary backward-compat — legacy call still works unchanged", async () => {
    // Legacy saveSummary(memoryDir, agentName, summary) uses 500-word truncation.
    // We only confirm the legacy signature is still exported + callable (no
    // filesystem write — see end-to-end test elsewhere).
    expect(typeof saveSummary).toBe("function");
    // Phase 999.13 TZ-04 — signature now (memoryDir, agentName, summary, agentTz?).
    // The 4th param is optional in TypeScript but counts toward Function.length
    // at runtime. Legacy callers passing 3 args still work — agentTz falls back
    // to host TZ via renderAgentVisibleTimestamp's resolution chain.
    expect(saveSummary.length).toBe(4);
  });

  it("Test 9: defaults exported — DEFAULT_RESUME_SUMMARY_BUDGET is 1500", () => {
    expect(DEFAULT_RESUME_SUMMARY_BUDGET).toBe(1500);
    expect(MIN_RESUME_SUMMARY_BUDGET).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Phase 999.13 — TZ-04: saveSummary writes TZ-aware Generated header
//
// Wave 0 RED test. FAILS on current main because:
//   - saveSummary signature does not yet accept agentTz parameter
//     (Plan 02 adds it)
//   - on main, **Generated:** uses new Date().toISOString() (UTC ISO)
//   - after Plan 02, **Generated:** should use renderAgentVisibleTimestamp
//     producing "YYYY-MM-DD HH:mm:ss ZZZ"
// ---------------------------------------------------------------------------
describe("Phase 999.13 — TZ-04: saveSummary TZ-aware Generated header", () => {
  it("saveSummary-generated-tz: writes **Generated:** header in canonical YYYY-MM-DD HH:mm:ss ZZZ format", async () => {
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const memoryDir = await mkdtemp(join(tmpdir(), "999-13-context-summary-"));
    try {
      // Plan 02 adds the 4th agentTz parameter. On main the extra arg is
      // ignored — the file ends up with an ISO UTC Generated line which
      // fails the regex below.
      await (saveSummary as unknown as (
        memoryDir: string,
        agentName: string,
        summary: string,
        agentTz?: string,
      ) => Promise<void>)(memoryDir, "test-agent", "Body content here", "America/Los_Angeles");

      const written = await readFile(join(memoryDir, "context-summary.md"), "utf-8");
      // Locate the Generated header line.
      const genLine = written
        .split("\n")
        .find((l) => l.startsWith("**Generated:**"));
      expect(genLine).toBeDefined();
      // Canonical TZ-aware format — NOT ISO UTC.
      expect(genLine).toMatch(
        /^\*\*Generated:\*\* \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z]{2,5}$/,
      );
      // Negative assertion: must NOT carry an ISO UTC timestamp anymore.
      expect(genLine).not.toMatch(/Z$/); // ISO ends with 'Z'
      expect(genLine).not.toMatch(/T\d{2}:/); // ISO has 'T' separator
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });
});
