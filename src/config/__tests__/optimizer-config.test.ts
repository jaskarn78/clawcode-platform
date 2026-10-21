/**
 * Phase 142 — agent-optimizer config block tests.
 *
 * Mirrors the dream/voice additive-optional + default-bearing invariants:
 *   - `optimizerConfigSchema` fills field defaults.
 *   - `agents.*.optimizer` is optional (v2.x configs parse unchanged).
 *   - `defaults.optimizer` is default-bearing (enabled:false when omitted).
 */
import { describe, it, expect } from "vitest";
import {
  optimizerConfigSchema,
  agentSchema,
  defaultsSchema,
} from "../schema.js";

describe("Phase 142 — optimizerConfigSchema", () => {
  it("fills field defaults on an empty block", () => {
    const r = optimizerConfigSchema.parse({});
    expect(r.enabled).toBe(false);
    expect(r.model).toBe("opus");
    expect(r.maxActionsPerRun).toBe(3);
    expect(r.samplesPerTask).toBe(3);
    expect(r.minImprovementMargin).toBeCloseTo(0.1);
    expect(r.eligibleSkills).toEqual(["*"]);
    expect(r.cadence).toBe("manual");
    expect(r.evalSet).toBeUndefined();
  });

  it("preserves an explicit enabled + evalSet + overrides", () => {
    const r = optimizerConfigSchema.parse({
      enabled: true,
      evalSet: "optimizer/eval.yaml",
      model: "sonnet",
      maxActionsPerRun: 5,
      samplesPerTask: 1,
      minImprovementMargin: 0.25,
      eligibleSkills: ["weather", "search-first"],
      cadence: "0 4 * * *",
    });
    expect(r.enabled).toBe(true);
    expect(r.evalSet).toBe("optimizer/eval.yaml");
    expect(r.model).toBe("sonnet");
    expect(r.maxActionsPerRun).toBe(5);
    expect(r.samplesPerTask).toBe(1);
    expect(r.minImprovementMargin).toBeCloseTo(0.25);
    expect(r.eligibleSkills).toEqual(["weather", "search-first"]);
    expect(r.cadence).toBe("0 4 * * *");
  });

  it("clamps maxActionsPerRun to 1..10", () => {
    expect(optimizerConfigSchema.safeParse({ maxActionsPerRun: 0 }).success).toBe(false);
    expect(optimizerConfigSchema.safeParse({ maxActionsPerRun: 11 }).success).toBe(false);
  });

  it("clamps samplesPerTask to 1..10", () => {
    expect(optimizerConfigSchema.safeParse({ samplesPerTask: 0 }).success).toBe(false);
    expect(optimizerConfigSchema.safeParse({ samplesPerTask: 11 }).success).toBe(false);
  });

  it("clamps minImprovementMargin to 0..1", () => {
    expect(optimizerConfigSchema.safeParse({ minImprovementMargin: -0.01 }).success).toBe(false);
    expect(optimizerConfigSchema.safeParse({ minImprovementMargin: 1.01 }).success).toBe(false);
  });

  it("rejects an unknown model", () => {
    expect(optimizerConfigSchema.safeParse({ model: "gpt-4" }).success).toBe(false);
  });
});

describe("Phase 142 — additive-optional + default cascade", () => {
  it("an agent without an optimizer block parses (back-compat); optimizer undefined", () => {
    const r = agentSchema.safeParse({ name: "x" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.optimizer).toBeUndefined();
  });

  it("an agent WITH an optimizer block parses + fills inner defaults", () => {
    const r = agentSchema.safeParse({
      name: "x",
      optimizer: { enabled: true, evalSet: "e.yaml" },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.optimizer?.enabled).toBe(true);
      expect(r.data.optimizer?.evalSet).toBe("e.yaml");
      expect(r.data.optimizer?.maxActionsPerRun).toBe(3);
      expect(r.data.optimizer?.model).toBe("opus");
    }
  });

  it("defaults.optimizer is OPTIONAL (undefined when omitted) — off-by-default fleet-wide, mirrors voice/advisor", () => {
    const r = defaultsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.optimizer).toBeUndefined();
  });

  it("defaults.optimizer fills inner field defaults when present", () => {
    const r = defaultsSchema.safeParse({ optimizer: { enabled: true, evalSet: "e.yaml" } });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.optimizer?.enabled).toBe(true);
      expect(r.data.optimizer?.maxActionsPerRun).toBe(3);
      expect(r.data.optimizer?.model).toBe("opus");
    }
  });
});
