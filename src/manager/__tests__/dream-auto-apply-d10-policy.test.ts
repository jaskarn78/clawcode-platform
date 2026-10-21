/**
 * Phase 115 Plan 05 T02 — D-10 hybrid 5-row policy tests.
 *
 * Pin every row of the D-10 table verbatim:
 *   - Row 1: newWikilinks always auto-applied
 *   - Row 2: additive promotion with score ≥ 80 → scheduled (30-min veto)
 *   - Row 2: additive promotion with score < 80 → operator-required
 *   - Row 3: mutating promotion (action=edit/merge OR targetMode=overwrite)
 *           → operator-required regardless of priorityScore (when !priority)
 *   - Row 4: suggestedConsolidations → always operator-required
 *   - Row 5: priority pass — score=70 mutating → scheduled (override)
 *   - Row 5: priority pass — operator-required count = consolidations only
 *   - VetoStore: ticking after deadline applies; veto before deadline cancels
 *   - Discord summary: built; truncates to 6000 chars; uses ✅ / ❌ contract
 */

import { describe, it, expect, vi } from "vitest";
import {
  applyDreamResultD10,
  isMutating,
  D10_AUTO_APPLY_PRIORITY_FLOOR,
  D10_VETO_WINDOW_MS,
} from "../dream-auto-apply.js";
import {
  buildPromotionSummary,
  DISCORD_EMBED_BUDGET_CHARS,
  type PromotionSummaryInput,
} from "../dream-discord-summary.js";
import { createDreamVetoStore } from "../dream-veto-store.js";
import type { DreamPassOutcome, DreamResult } from "../dream-pass.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FIXED_NOW = new Date("2026-05-08T03:00:00.000Z");

const noopLog = {
  info: (_: string) => {},
  warn: (_: string) => {},
  error: (_: string) => {},
};

function makeOutcome(result: DreamResult): DreamPassOutcome {
  return {
    kind: "completed",
    result,
    durationMs: 4200,
    tokensIn: 12_400,
    tokensOut: 1_800,
    model: "haiku",
  };
}

function emptyResult(): DreamResult {
  return {
    newWikilinks: [],
    promotionCandidates: [],
    themedReflection: "test",
    suggestedConsolidations: [],
  };
}

describe("D-10 hybrid 5-row policy", () => {
  describe("Row 1 — newWikilinks always auto-apply", () => {
    it("Row 1 always auto-applies newWikilinks regardless of priority pass", async () => {
      const applyAutoLinks = vi.fn().mockResolvedValue({ added: 3 });
      const vetoStore = {
        scheduleAutoApply: vi.fn().mockResolvedValue(undefined),
        vetoRun: vi.fn(),
        tick: vi.fn(),
        list: vi.fn(),
      };

      const outcome = makeOutcome({
        ...emptyResult(),
        newWikilinks: [
          { from: "a.md", to: "b.md", rationale: "" },
          { from: "c.md", to: "d.md", rationale: "" },
          { from: "e.md", to: "f.md", rationale: "" },
        ],
      });

      const result = await applyDreamResultD10({
        agentName: "atlas",
        outcome,
        isPriorityPass: false,
        memoryRoot: "/tmp/x",
        log: noopLog,
        vetoStore,
        nanoid: () => "run-row1",
        applyAutoLinks,
        now: () => FIXED_NOW,
      });

      expect(result.kind).toBe("applied");
      if (result.kind !== "applied") return; // narrow
      expect(result.appliedWikilinkCount).toBe(3);
      expect(applyAutoLinks).toHaveBeenCalledWith("atlas", [
        { from: "a.md", to: "b.md" },
        { from: "c.md", to: "d.md" },
        { from: "e.md", to: "f.md" },
      ]);
    });
  });

  describe("Row 2 — additive promotionCandidates ≥ 80 auto-apply with veto window", () => {
    it("Row 2 schedules score=85 additive into 30-min veto window", async () => {
      const applyAutoLinks = vi.fn().mockResolvedValue({ added: 0 });
      const scheduleAutoApply = vi.fn().mockResolvedValue(undefined);
      const vetoStore = {
        scheduleAutoApply,
        vetoRun: vi.fn(),
        tick: vi.fn(),
        list: vi.fn(),
      };

      const outcome = makeOutcome({
        ...emptyResult(),
        promotionCandidates: [
          {
            chunkId: "c1",
            currentPath: "memory/x.md",
            rationale: "",
            priorityScore: 85,
            // no action / targetMode → additive
          },
        ],
      });

      const result = await applyDreamResultD10({
        agentName: "atlas",
        outcome,
        isPriorityPass: false,
        memoryRoot: "/tmp/x",
        log: noopLog,
        vetoStore,
        nanoid: () => "run-row2-yes",
        applyAutoLinks,
        now: () => FIXED_NOW,
      });

      if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
      expect(result.autoApplyScheduled).toBe(1);
      expect(result.operatorRequiredCount).toBe(0);
      expect(scheduleAutoApply).toHaveBeenCalledTimes(1);
      const req = scheduleAutoApply.mock.calls[0][0];
      expect(req.candidates).toHaveLength(1);
      expect(req.deadline).toBe(FIXED_NOW.getTime() + D10_VETO_WINDOW_MS);
      expect(req.isPriorityPass).toBe(false);
    });

    it("Row 2 below-floor (score=70) → NOT scheduled, operator-required", async () => {
      const applyAutoLinks = vi.fn().mockResolvedValue({ added: 0 });
      const scheduleAutoApply = vi.fn();
      const vetoStore = {
        scheduleAutoApply,
        vetoRun: vi.fn(),
        tick: vi.fn(),
        list: vi.fn(),
      };

      const outcome = makeOutcome({
        ...emptyResult(),
        promotionCandidates: [
          {
            chunkId: "c1",
            currentPath: "memory/x.md",
            rationale: "",
            priorityScore: 70,
          },
        ],
      });

      const result = await applyDreamResultD10({
        agentName: "atlas",
        outcome,
        isPriorityPass: false,
        memoryRoot: "/tmp/x",
        log: noopLog,
        vetoStore,
        nanoid: () => "run-row2-no",
        applyAutoLinks,
        now: () => FIXED_NOW,
      });

      if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
      expect(result.autoApplyScheduled).toBe(0);
      expect(result.operatorRequiredCount).toBe(1);
      expect(scheduleAutoApply).not.toHaveBeenCalled();
    });
  });

  describe("Row 3 — mutating promotionCandidates always operator-required when !priority", () => {
    it("Row 3 mutating action=edit with score=90 → operator-required", async () => {
      const applyAutoLinks = vi.fn().mockResolvedValue({ added: 0 });
      const scheduleAutoApply = vi.fn();
      const vetoStore = {
        scheduleAutoApply,
        vetoRun: vi.fn(),
        tick: vi.fn(),
        list: vi.fn(),
      };

      const outcome = makeOutcome({
        ...emptyResult(),
        promotionCandidates: [
          {
            chunkId: "c1",
            currentPath: "memory/x.md",
            rationale: "",
            priorityScore: 90,
            action: "edit", // mutating
          },
        ],
      });

      const result = await applyDreamResultD10({
        agentName: "atlas",
        outcome,
        isPriorityPass: false,
        memoryRoot: "/tmp/x",
        log: noopLog,
        vetoStore,
        nanoid: () => "run-row3",
        applyAutoLinks,
        now: () => FIXED_NOW,
      });

      if (result.kind !== "applied") throw new Error("expected applied");
      expect(result.autoApplyScheduled).toBe(0);
      expect(result.operatorRequiredCount).toBe(1);
      expect(scheduleAutoApply).not.toHaveBeenCalled();
    });

    it("Row 3 targetMode=overwrite with score=95 → operator-required", async () => {
      const applyAutoLinks = vi.fn().mockResolvedValue({ added: 0 });
      const scheduleAutoApply = vi.fn();
      const vetoStore = {
        scheduleAutoApply,
        vetoRun: vi.fn(),
        tick: vi.fn(),
        list: vi.fn(),
      };

      const outcome = makeOutcome({
        ...emptyResult(),
        promotionCandidates: [
          {
            chunkId: "c1",
            currentPath: "memory/x.md",
            rationale: "",
            priorityScore: 95,
            targetMode: "overwrite",
          },
        ],
      });

      const result = await applyDreamResultD10({
        agentName: "atlas",
        outcome,
        isPriorityPass: false,
        memoryRoot: "/tmp/x",
        log: noopLog,
        vetoStore,
        nanoid: () => "run-row3-tm",
        applyAutoLinks,
        now: () => FIXED_NOW,
      });

      if (result.kind !== "applied") throw new Error("expected applied");
      expect(result.autoApplyScheduled).toBe(0);
      expect(result.operatorRequiredCount).toBe(1);
    });
  });

  describe("Row 4 — suggestedConsolidations always operator-required", () => {
    it("Row 4 consolidations always route to operator-required regardless of priority pass", async () => {
      const applyAutoLinks = vi.fn().mockResolvedValue({ added: 0 });
      const scheduleAutoApply = vi.fn().mockResolvedValue(undefined);
      const vetoStore = {
        scheduleAutoApply,
        vetoRun: vi.fn(),
        tick: vi.fn(),
        list: vi.fn(),
      };

      const outcome = makeOutcome({
        ...emptyResult(),
        suggestedConsolidations: [
          {
            sources: ["a.md", "b.md"],
            newPath: "consolidated.md",
            rationale: "",
          },
        ],
      });

      // Test under BOTH priority and non-priority — Row 4 invariant.
      for (const isPriorityPass of [false, true]) {
        const result = await applyDreamResultD10({
          agentName: "atlas",
          outcome,
          isPriorityPass,
          memoryRoot: "/tmp/x",
          log: noopLog,
          vetoStore,
          nanoid: () => `run-row4-${isPriorityPass}`,
          applyAutoLinks,
          now: () => FIXED_NOW,
        });
        if (result.kind !== "applied") throw new Error("expected applied");
        // Row 4: consolidations contribute 1 to operator-required EVERY time.
        expect(result.operatorRequiredCount).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe("Row 5 — priority pass overrides priorityScore floor + mutating gate", () => {
    it("Row 5 priority pass: score=70 mutating → scheduled (override)", async () => {
      const applyAutoLinks = vi.fn().mockResolvedValue({ added: 0 });
      const scheduleAutoApply = vi.fn().mockResolvedValue(undefined);
      const vetoStore = {
        scheduleAutoApply,
        vetoRun: vi.fn(),
        tick: vi.fn(),
        list: vi.fn(),
      };

      const outcome = makeOutcome({
        ...emptyResult(),
        promotionCandidates: [
          {
            chunkId: "c1",
            currentPath: "memory/x.md",
            rationale: "",
            priorityScore: 70, // BELOW Row-2 floor
            action: "edit", // mutating
          },
        ],
      });

      const result = await applyDreamResultD10({
        agentName: "atlas",
        outcome,
        isPriorityPass: true, // D-05 priority pass
        memoryRoot: "/tmp/x",
        log: noopLog,
        vetoStore,
        nanoid: () => "run-row5",
        applyAutoLinks,
        now: () => FIXED_NOW,
      });

      if (result.kind !== "applied") throw new Error("expected applied");
      expect(result.autoApplyScheduled).toBe(1);
      expect(result.isPriorityPass).toBe(true);
      expect(scheduleAutoApply).toHaveBeenCalledTimes(1);
      expect(scheduleAutoApply.mock.calls[0][0].isPriorityPass).toBe(true);
    });

    it("Row 5 priority pass: operator-required count = consolidations only", async () => {
      const applyAutoLinks = vi.fn().mockResolvedValue({ added: 0 });
      const scheduleAutoApply = vi.fn().mockResolvedValue(undefined);
      const vetoStore = {
        scheduleAutoApply,
        vetoRun: vi.fn(),
        tick: vi.fn(),
        list: vi.fn(),
      };

      const outcome = makeOutcome({
        ...emptyResult(),
        promotionCandidates: [
          {
            chunkId: "c1",
            currentPath: "memory/x.md",
            rationale: "",
            priorityScore: 30, // way below floor
            action: "merge",
          },
          {
            chunkId: "c2",
            currentPath: "memory/y.md",
            rationale: "",
            priorityScore: 10, // way below floor
            targetMode: "overwrite",
          },
        ],
        suggestedConsolidations: [
          {
            sources: ["a.md", "b.md"],
            newPath: "c.md",
            rationale: "",
          },
        ],
      });

      const result = await applyDreamResultD10({
        agentName: "atlas",
        outcome,
        isPriorityPass: true,
        memoryRoot: "/tmp/x",
        log: noopLog,
        vetoStore,
        nanoid: () => "run-row5-cons",
        applyAutoLinks,
        now: () => FIXED_NOW,
      });

      if (result.kind !== "applied") throw new Error("expected applied");
      // Both promotion candidates eligible (priority override) — only the
      // 1 consolidation is operator-required.
      expect(result.autoApplyScheduled).toBe(2);
      expect(result.operatorRequiredCount).toBe(1);
    });
  });

  describe("VetoStore lifecycle", () => {
    it("ticking after deadline applies; veto before deadline cancels", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "d10-veto-"));
      try {
        const store = createDreamVetoStore(tmp);
        const baseNow = FIXED_NOW.getTime();
        const deadline1 = baseNow + 1000;
        const deadline2 = baseNow + 2000;

        await store.scheduleAutoApply({
          runId: "run-pre-veto",
          agentName: "atlas",
          candidates: [
            {
              chunkId: "c1",
              currentPath: "memory/x.md",
              rationale: "",
              priorityScore: 85,
            },
          ],
          deadline: deadline1,
          isPriorityPass: false,
        });
        await store.scheduleAutoApply({
          runId: "run-survives",
          agentName: "atlas",
          candidates: [
            {
              chunkId: "c2",
              currentPath: "memory/y.md",
              rationale: "",
              priorityScore: 85,
            },
          ],
          deadline: deadline2,
          isPriorityPass: false,
        });

        // Veto run-pre-veto BEFORE deadline.
        await store.vetoRun("run-pre-veto", "operator vetoed");

        // Tick AFTER both deadlines — only run-survives applies.
        const applyFn = vi.fn().mockResolvedValue({ ok: true });
        const applied = await store.tick(new Date(deadline2 + 500), applyFn);
        expect(applied).toEqual(["run-survives"]);
        expect(applyFn).toHaveBeenCalledTimes(1);

        const list = await store.list();
        const byId = new Map(list.map((r) => [r.runId, r]));
        expect(byId.get("run-pre-veto")?.status).toBe("vetoed");
        expect(byId.get("run-survives")?.status).toBe("applied");
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it("apply callback failure → row marked expired with error", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "d10-veto-"));
      try {
        const store = createDreamVetoStore(tmp);
        const deadline = FIXED_NOW.getTime() + 100;
        await store.scheduleAutoApply({
          runId: "run-fail",
          agentName: "atlas",
          candidates: [
            {
              chunkId: "c1",
              currentPath: "memory/x.md",
              rationale: "",
              priorityScore: 85,
            },
          ],
          deadline,
          isPriorityPass: false,
        });

        const applyFn = vi.fn().mockResolvedValue({
          ok: false,
          error: "memory-edit-failed",
        });
        const applied = await store.tick(new Date(deadline + 100), applyFn);
        expect(applied).toEqual([]);

        const list = await store.list();
        const expiredRow = list.find((r) => r.runId === "run-fail");
        expect(expiredRow?.status).toBe("expired");
        expect(expiredRow?.applyError).toBe("memory-edit-failed");
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("D-11 Discord summary contract", () => {
    it("summary contains [auto-apply in 30m], [veto-required] and the veto/approve commands", () => {
      const input: PromotionSummaryInput = {
        runId: "abc123",
        agentName: "atlas",
        autoApplyCandidates: [
          {
            chunkId: "c1",
            currentPath: "memory/x.md",
            priorityScore: 85,
          },
        ],
        operatorRequiredCandidates: [
          {
            chunkId: "c2",
            currentPath: "memory/y.md",
            priorityScore: 95,
            action: "edit",
          },
        ],
        consolidations: [
          {
            sources: ["a.md", "b.md"],
            newPath: "c.md",
          },
        ],
        isPriorityPass: true,
      };
      const text = buildPromotionSummary(input);
      expect(text).toContain("[auto-apply in 30m]");
      expect(text).toContain("[veto-required]");
      expect(text).toContain("/clawcode-dream action:veto run:abc123");
      expect(text).toContain("/clawcode-dream action:approve run:abc123");
      expect(text).toContain("[dream-pass priority]");
    });

    it("summary truncates to 6000 chars when over budget; veto footer preserved", () => {
      // Build 1000 candidates — guaranteed over budget.
      const auto = Array.from({ length: 1000 }, (_, i) => ({
        chunkId: `c${i}`,
        currentPath: `memory/very-long-path-${i}-with-padding-to-blow-budget.md`,
        priorityScore: 85,
      }));
      const text = buildPromotionSummary({
        runId: "huge",
        agentName: "atlas",
        autoApplyCandidates: auto,
        operatorRequiredCandidates: [],
        consolidations: [],
        isPriorityPass: false,
      });
      expect(text.length).toBeLessThanOrEqual(DISCORD_EMBED_BUDGET_CHARS);
      expect(text).toContain("/clawcode-dream action:veto run:");
      expect(text).toContain("/clawcode-dream action:approve run:");
      expect(text).toContain("+");
      expect(text).toContain("more");
    });
  });

  describe("isMutating helper", () => {
    it("returns true for action=edit / action=merge / targetMode=overwrite", () => {
      expect(isMutating({ action: "edit" })).toBe(true);
      expect(isMutating({ action: "merge" })).toBe(true);
      expect(isMutating({ targetMode: "overwrite" })).toBe(true);
    });

    it("returns false for additive (action=add / no action / targetMode=append)", () => {
      expect(isMutating({})).toBe(false);
      expect(isMutating({ action: "add" })).toBe(false);
      expect(isMutating({ targetMode: "append" })).toBe(false);
    });
  });

  describe("D-10 floor constant", () => {
    it("D10_AUTO_APPLY_PRIORITY_FLOOR = 80 (CONTEXT.md D-10 Row 2 verbatim)", () => {
      expect(D10_AUTO_APPLY_PRIORITY_FLOOR).toBe(80);
    });

    it("D10_VETO_WINDOW_MS = 30 minutes (CONTEXT.md D-10 + D-11 verbatim)", () => {
      expect(D10_VETO_WINDOW_MS).toBe(30 * 60 * 1000);
    });
  });

  describe("Row 1 — outcome.kind !== completed → skipped", () => {
    it("non-completed outcome short-circuits to skipped", async () => {
      const applyAutoLinks = vi.fn();
      const result = await applyDreamResultD10({
        agentName: "atlas",
        outcome: { kind: "failed", error: "boom" },
        isPriorityPass: false,
        memoryRoot: "/tmp/x",
        log: noopLog,
        vetoStore: {
          scheduleAutoApply: vi.fn(),
          vetoRun: vi.fn(),
          tick: vi.fn(),
          list: vi.fn(),
        },
        nanoid: () => "run-skip",
        applyAutoLinks,
        now: () => FIXED_NOW,
      });
      expect(result.kind).toBe("skipped");
      if (result.kind !== "skipped") return;
      expect(result.reason).toBe("no-completed-result");
      expect(applyAutoLinks).not.toHaveBeenCalled();
    });
  });
});
