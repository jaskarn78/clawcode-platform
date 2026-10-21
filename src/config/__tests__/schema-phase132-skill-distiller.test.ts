/**
 * Phase 132 Plan 01 T-01 — zod schema additions for autonomousSkillDrafting +
 * skillDistiller block (per-agent + defaults).
 *
 * Per CONTEXT.md D-03 (eligibility defaults: minToolCalls / 180_000 /
 * ["success"]) + D-08 (default OFF fleet-wide). The minToolCalls default
 * was lowered 6→5 by Phase 999.42 capability B (CONTEXT D4 — Hermes
 * parity); minDurationMs + outcomeFilter unchanged. Pure zod-parse tests
 * — no daemon state.
 *
 * Mirrors the autoIngestAttachments precedent at schema.ts:1369 + 1822.
 */

import { describe, it, expect } from "vitest";
import { agentSchema, defaultsSchema } from "../schema.js";
import { RELOADABLE_FIELDS } from "../types.js";

describe("agentSchema.autonomousSkillDrafting + skillDistiller (Phase 132 T-01)", () => {
  it("Schema-1: accepts autonomousSkillDrafting:true + partial skillDistiller override (minToolCalls:10)", () => {
    const result = agentSchema.safeParse({
      name: "x",
      autonomousSkillDrafting: true,
      skillDistiller: { minToolCalls: 10 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autonomousSkillDrafting).toBe(true);
      expect(result.data.skillDistiller?.minToolCalls).toBe(10);
      // Per-agent fields stay optional — resolver in Plan 02 merges defaults
      expect(result.data.skillDistiller?.minDurationMs).toBeUndefined();
      expect(result.data.skillDistiller?.outcomeFilter).toBeUndefined();
    }
  });

  it("Schema-2: accepts empty agent object — back-compat with v2.x configs preserved", () => {
    const result = agentSchema.safeParse({ name: "x" });
    expect(result.success).toBe(true);
    if (result.success) {
      // Per-agent flag is optional (no .default on the agent field per D-08)
      expect(result.data.autonomousSkillDrafting).toBeUndefined();
      expect(result.data.skillDistiller).toBeUndefined();
    }
  });

  it("Schema-3: rejects negative minToolCalls with a zod issue on the path", () => {
    const result = agentSchema.safeParse({
      name: "x",
      skillDistiller: { minToolCalls: -1 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("minToolCalls"))).toBe(true);
    }
  });

  it("Schema-4: rejects bogus outcomeFilter enum values", () => {
    const result = agentSchema.safeParse({
      name: "x",
      skillDistiller: { outcomeFilter: ["bogus"] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("outcomeFilter"))).toBe(true);
    }
  });

  it("Schema-5: accepts distillerModel:sonnet (D-02 escalation knob)", () => {
    const result = agentSchema.safeParse({
      name: "x",
      skillDistiller: { distillerModel: "sonnet" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillDistiller?.distillerModel).toBe("sonnet");
    }
  });

  it("Schema-5b: accepts distillerModel:haiku (D-02 default model alias)", () => {
    const result = agentSchema.safeParse({
      name: "x",
      skillDistiller: { distillerModel: "haiku" },
    });
    expect(result.success).toBe(true);
  });
});

describe("defaultsSchema.autonomousSkillDrafting + skillDistiller (Phase 132 T-01)", () => {
  it("Defaults: empty defaults parse → autonomousSkillDrafting=false + threshold defaults", () => {
    const result = defaultsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // D-08: default OFF fleet-wide
      expect(result.data.autonomousSkillDrafting).toBe(false);
      // Threshold defaults — minToolCalls lowered 6→5 by Phase 999.42
      // capability B (CONTEXT D4 — Hermes parity); D-03's other two
      // thresholds (180_000 / ["success"]) are unchanged.
      expect(result.data.skillDistiller).toBeDefined();
      expect(result.data.skillDistiller!.minToolCalls).toBe(5);
      expect(result.data.skillDistiller!.minDurationMs).toBe(180000);
      expect(result.data.skillDistiller!.outcomeFilter).toEqual(["success"]);
    }
  });

  it("Defaults: operator widens outcomeFilter to ['success','partial']", () => {
    const result = defaultsSchema.safeParse({
      skillDistiller: { outcomeFilter: ["success", "partial"] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillDistiller!.outcomeFilter).toEqual(["success", "partial"]);
    }
  });

  it("Defaults: empty outcomeFilter rejected (nonempty constraint)", () => {
    const result = defaultsSchema.safeParse({
      skillDistiller: { outcomeFilter: [] },
    });
    expect(result.success).toBe(false);
  });
});

describe("RELOADABLE_FIELDS — Phase 132 entries (T-01)", () => {
  it("contains agents.*.autonomousSkillDrafting", () => {
    expect(RELOADABLE_FIELDS.has("agents.*.autonomousSkillDrafting")).toBe(true);
  });
  it("contains defaults.autonomousSkillDrafting", () => {
    expect(RELOADABLE_FIELDS.has("defaults.autonomousSkillDrafting")).toBe(true);
  });
  it("contains agents.*.skillDistiller", () => {
    expect(RELOADABLE_FIELDS.has("agents.*.skillDistiller")).toBe(true);
  });
  it("contains defaults.skillDistiller", () => {
    expect(RELOADABLE_FIELDS.has("defaults.skillDistiller")).toBe(true);
  });
});
