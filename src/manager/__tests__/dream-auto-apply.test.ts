import { describe, it, expect, vi } from "vitest";

/**
 * Phase 95 Plan 02 Task 1 — applyDreamResult auto-apply tests (RED).
 *
 * Pin D-04 contract + MEMORY.md invariant:
 *   - A1: completed outcome with 3 newWikilinks → applyAutoLinks called once
 *         with the 3 entries; returns {kind:'applied', appliedWikilinkCount:3}
 *   - A2: skipped outcome → applyAutoLinks NEVER called; returns
 *         {kind:'skipped', reason:'no-completed-result'}
 *   - A3: failed outcome → applyAutoLinks NEVER called; returns
 *         {kind:'skipped', reason:'no-completed-result'}
 *   - A4: completed with 0 newWikilinks → applyAutoLinks called with [] (not
 *         skipped — empty list is a valid 'applied' outcome with count=0)
 *   - A5: completed with promotionCandidates+suggestedConsolidations populated
 *         → those flow into writeDreamLog but applyAutoLinks signature has no
 *         "promote" or "consolidate" parameter (surfacing only)
 *   - A6: applyAutoLinks throws → returns {kind:'failed'}; writeDreamLog STILL
 *         called (operator gets a log entry even when application fails)
 *   - A7: writeDreamLog throws AFTER successful applyAutoLinks → returns
 *         {kind:'failed', error:'dream-log-write-failed: ...'}; wikilinks ARE
 *         persisted (no rollback)
 *   - A8: renderDreamLogSection output for completed-with-promotions fixture
 *         contains literal phrases "consider promoting" and "operator review"
 *         — promotion candidates SURFACE, never written to MEMORY.md
 *
 * Modules under test do not exist yet — imports fail (RED).
 */

import {
  applyDreamResult,
  type DreamApplyOutcome,
  type ApplyDreamResultDeps,
} from "../dream-auto-apply.js";
import { renderDreamLogSection } from "../dream-log-writer.js";
import type { DreamPassOutcome, DreamResult } from "../dream-pass.js";

const FIXED_NOW = new Date("2026-04-25T03:07:42.000Z");

const COMPLETED_RESULT: DreamResult = {
  newWikilinks: [
    { from: "memory/a.md", to: "memory/b.md", rationale: "Both reference deploy." },
    { from: "memory/c.md", to: "memory/d.md", rationale: "Same incident." },
    { from: "memory/e.md", to: "memory/f.md", rationale: "Routing pattern." },
  ],
  promotionCandidates: [
    {
      chunkId: "chunk-routing",
      currentPath: "memory/vault/openclaw-routing.md",
      rationale: "Referenced 4 times in last 24h.",
      priorityScore: 80,
    },
  ],
  themedReflection: "Recent activity centered on deploy debugging.",
  suggestedConsolidations: [
    {
      sources: ["memory/a.md", "memory/b.md"],
      newPath: "memory/consolidations/deploy.md",
      rationale: "Same incident across 2 files.",
    },
  ],
};

const COMPLETED_OUTCOME: DreamPassOutcome = {
  kind: "completed",
  result: COMPLETED_RESULT,
  durationMs: 4200,
  tokensIn: 12_400,
  tokensOut: 1_800,
  model: "haiku",
};

const noopLog = {
  info: (_: string) => {},
  warn: (_: string) => {},
  error: (_: string) => {},
};

function buildDeps(
  overrides: Partial<ApplyDreamResultDeps> = {},
): ApplyDreamResultDeps {
  const applyAutoLinks: ApplyDreamResultDeps["applyAutoLinks"] =
    overrides.applyAutoLinks ??
    vi.fn<ApplyDreamResultDeps["applyAutoLinks"]>(async (_agent, links) => ({
      added: links.length,
    }));
  const writeDreamLog: ApplyDreamResultDeps["writeDreamLog"] =
    overrides.writeDreamLog ??
    vi.fn<ApplyDreamResultDeps["writeDreamLog"]>(async () => ({
      logPath: "/tmp/dreams/2026-04-25.md",
      appended: false,
    }));
  return {
    applyAutoLinks,
    writeDreamLog,
    memoryRoot: overrides.memoryRoot ?? "/tmp/memory",
    now: overrides.now ?? (() => FIXED_NOW),
    log: overrides.log ?? noopLog,
  };
}

describe("applyDreamResult — D-04 additive-only auto-applier", () => {
  it("A1: completed outcome with 3 newWikilinks invokes applyAutoLinks once with 3 entries", async () => {
    const applyAutoLinks = vi.fn<ApplyDreamResultDeps["applyAutoLinks"]>(async (_a, links) => ({
      added: links.length,
    }));
    const deps = buildDeps({ applyAutoLinks });
    const out = await applyDreamResult("atlas", COMPLETED_OUTCOME, deps);
    expect(applyAutoLinks).toHaveBeenCalledTimes(1);
    expect(applyAutoLinks).toHaveBeenCalledWith("atlas", [
      { from: "memory/a.md", to: "memory/b.md" },
      { from: "memory/c.md", to: "memory/d.md" },
      { from: "memory/e.md", to: "memory/f.md" },
    ]);
    expect(out.kind).toBe("applied");
    if (out.kind === "applied") {
      expect(out.appliedWikilinkCount).toBe(3);
      expect(out.surfacedPromotionCount).toBe(1);
      expect(out.surfacedConsolidationCount).toBe(1);
    }
  });

  it("A2: skipped outcome short-circuits — applyAutoLinks never called", async () => {
    const applyAutoLinks = vi.fn();
    const writeDreamLog = vi.fn();
    const deps = buildDeps({ applyAutoLinks, writeDreamLog });
    const skipped: DreamPassOutcome = { kind: "skipped", reason: "disabled" };
    const out = await applyDreamResult("atlas", skipped, deps);
    expect(applyAutoLinks).not.toHaveBeenCalled();
    expect(writeDreamLog).not.toHaveBeenCalled();
    expect(out).toEqual({ kind: "skipped", reason: "no-completed-result" });
  });

  it("A3: failed outcome short-circuits — applyAutoLinks never called", async () => {
    const applyAutoLinks = vi.fn();
    const writeDreamLog = vi.fn();
    const deps = buildDeps({ applyAutoLinks, writeDreamLog });
    const failed: DreamPassOutcome = { kind: "failed", error: "boom" };
    const out = await applyDreamResult("atlas", failed, deps);
    expect(applyAutoLinks).not.toHaveBeenCalled();
    expect(writeDreamLog).not.toHaveBeenCalled();
    expect(out).toEqual({ kind: "skipped", reason: "no-completed-result" });
  });

  it("A4: completed with 0 newWikilinks — applyAutoLinks called with [] (count=0 is valid 'applied')", async () => {
    const emptyResult: DreamResult = { ...COMPLETED_RESULT, newWikilinks: [] };
    const outcome: DreamPassOutcome = { ...COMPLETED_OUTCOME, result: emptyResult };
    const applyAutoLinks = vi.fn(async () => ({ added: 0 }));
    const deps = buildDeps({ applyAutoLinks });
    const out = await applyDreamResult("atlas", outcome, deps);
    expect(applyAutoLinks).toHaveBeenCalledTimes(1);
    expect(applyAutoLinks).toHaveBeenCalledWith("atlas", []);
    expect(out.kind).toBe("applied");
    if (out.kind === "applied") expect(out.appliedWikilinkCount).toBe(0);
  });

  it("A5: promotionCandidates + suggestedConsolidations flow into writeDreamLog (surfaced, not applied)", async () => {
    const writeDreamLog = vi.fn<ApplyDreamResultDeps["writeDreamLog"]>(async () => ({
      logPath: "/tmp/dreams/x.md",
      appended: false,
    }));
    const deps = buildDeps({ writeDreamLog });
    await applyDreamResult("atlas", COMPLETED_OUTCOME, deps);
    expect(writeDreamLog).toHaveBeenCalledTimes(1);
    const call = writeDreamLog.mock.calls[0]![0];
    expect(call.entry.result.promotionCandidates).toHaveLength(1);
    expect(call.entry.result.suggestedConsolidations).toHaveLength(1);
    // Verify the auto-applier signature: only applyAutoLinks for additive,
    // nothing in the deps surface that auto-promotes or auto-consolidates.
    expect(deps).not.toHaveProperty("applyPromotion");
    expect(deps).not.toHaveProperty("applyConsolidation");
  });

  it("A6: applyAutoLinks throws → failed outcome; writeDreamLog STILL called", async () => {
    const applyAutoLinks = vi.fn(async () => {
      throw new Error("link-store unavailable");
    });
    const writeDreamLog = vi.fn<ApplyDreamResultDeps["writeDreamLog"]>(async () => ({
      logPath: "/tmp/dreams/x.md",
      appended: false,
    }));
    const deps = buildDeps({ applyAutoLinks, writeDreamLog });
    const out = await applyDreamResult("atlas", COMPLETED_OUTCOME, deps);
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.error).toContain("link-store unavailable");
    expect(writeDreamLog).toHaveBeenCalledTimes(1);
  });

  it("A7: writeDreamLog throws AFTER successful applyAutoLinks → failed; wikilinks NOT rolled back", async () => {
    const applyAutoLinks = vi.fn(async () => ({ added: 3 }));
    const writeDreamLog = vi.fn(async () => {
      throw new Error("disk full");
    });
    const deps = buildDeps({ applyAutoLinks, writeDreamLog });
    const out = await applyDreamResult("atlas", COMPLETED_OUTCOME, deps);
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.error).toContain("dream-log-write-failed");
      expect(out.error).toContain("disk full");
    }
    // applyAutoLinks was called once, no rollback (no second un-apply call)
    expect(applyAutoLinks).toHaveBeenCalledTimes(1);
  });

  it("A8 (CRITICAL — MEMORY.md invariant): renderDreamLogSection surfaces promotions for operator review", () => {
    const md = renderDreamLogSection({
      timestamp: FIXED_NOW,
      idleMinutes: 35,
      model: "haiku",
      result: COMPLETED_RESULT,
      tokensIn: 12_400,
      tokensOut: 1_800,
      durationMs: 4_200,
    });
    expect(md).toContain("consider promoting");
    expect(md).toContain("operator review");
    // Pin: dream-log-writer / auto-applier never WRITES to MEMORY.md
    expect(md).not.toMatch(/writeFile.*MEMORY\.md/);
  });
});
