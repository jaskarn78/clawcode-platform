/**
 * Phase 999.42 capability C / CONTEXT D7 — guards the `suggestPatches`
 * config flag: an additive-optional boolean on `agentSchema.skillDistiller`
 * defaulting `false` in `defaultsSchema` (inner + outer mirror) and in the
 * `configSchema`-when-defaults-omitted fallback.
 *
 * D7 — `suggestPatches` gates the distiller patch-suggest path: when true
 * AND a recurring trajectory's fingerprint matches an active skill's
 * `originatingFingerprint`, the distiller emits a `skill-patches/` patch
 * artifact instead of a duplicate create-draft. DEFAULT OFF means zero
 * fleet behavior change until an operator opts an agent in.
 *
 * These pure zod-parse tests pin the resolved `suggestPatches` value across
 * all three schema resolution paths so a future edit cannot silently drift
 * the default ON, and prove the field is reloadable.
 */

import { describe, it, expect } from "vitest";
import { agentSchema, defaultsSchema, configSchema } from "../schema.js";
import { RELOADABLE_FIELDS } from "../types.js";

/** Minimal valid root config — no `defaults` block at all. */
const CONFIG_NO_DEFAULTS = {
  version: 1 as const,
  agents: [{ name: "test-agent" }],
};

describe("Phase 999.42 capability C — skillDistiller.suggestPatches flag (default false)", () => {
  it("SP-1: config with NO defaults block → resolved suggestPatches is false", () => {
    // The `defaults:` key is omitted entirely → the configSchema fallback
    // object fires. Its skillDistiller.suggestPatches must be false.
    const result = configSchema.safeParse(CONFIG_NO_DEFAULTS);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaults.skillDistiller.suggestPatches).toBe(false);
    }
  });

  it("SP-2: empty defaults:{} block → resolved suggestPatches is false", () => {
    // An explicit but empty `defaults: {}` block hits the defaultsSchema
    // outer `.default({...})` mirror on the skillDistiller field.
    const result = defaultsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillDistiller).toBeDefined();
      expect(result.data.skillDistiller!.suggestPatches).toBe(false);
    }
  });

  it("SP-3: partial skillDistiller (minToolCalls:10) → suggestPatches falls through to false", () => {
    // A partial `skillDistiller: { minToolCalls: 10 }` exercises the
    // defaultsSchema INNER `.default(...)` cascade — minToolCalls is
    // explicit (10) while suggestPatches falls through to its inner
    // `.default(false)`. The other thresholds also stay at their defaults.
    const result = defaultsSchema.safeParse({
      skillDistiller: { minToolCalls: 10 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillDistiller!.minToolCalls).toBe(10);
      expect(result.data.skillDistiller!.suggestPatches).toBe(false);
      expect(result.data.skillDistiller!.minDurationMs).toBe(180000);
      expect(result.data.skillDistiller!.outcomeFilter).toEqual(["success"]);
    }
  });

  it("SP-4: per-agent skillDistiller { suggestPatches: true } → resolves to true", () => {
    // The per-agent override schema carries the optional flag verbatim —
    // a partial `agents[].skillDistiller: { suggestPatches: true }` resolves
    // to true. The resolver (loader Plan 02) merges per-agent over defaults.
    const result = agentSchema.safeParse({
      name: "opted-in-agent",
      skillDistiller: { suggestPatches: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillDistiller?.suggestPatches).toBe(true);
      // The per-agent inner fields stay optional — resolver merges defaults.
      expect(result.data.skillDistiller?.minToolCalls).toBeUndefined();
      expect(result.data.skillDistiller?.minDurationMs).toBeUndefined();
    }
  });

  it("SP-5: per-agent skillDistiller without suggestPatches → field stays undefined (resolver merges default)", () => {
    // A per-agent block specifying only minToolCalls leaves suggestPatches
    // undefined at the schema layer — the loader resolver fills it from the
    // defaults block (false). The agentSchema field is purely optional.
    const result = agentSchema.safeParse({
      name: "partial-agent",
      skillDistiller: { minToolCalls: 7 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillDistiller?.minToolCalls).toBe(7);
      expect(result.data.skillDistiller?.suggestPatches).toBeUndefined();
    }
  });

  it("SP-6: a non-boolean suggestPatches is rejected", () => {
    // Type safety — the flag is strictly boolean.
    const result = agentSchema.safeParse({
      name: "bad-agent",
      skillDistiller: { suggestPatches: "yes" },
    });
    expect(result.success).toBe(false);
  });

  it("SP-7: RELOADABLE_FIELDS includes the suggestPatches paths — a yaml flip hot-reloads", () => {
    // The patch-suggest path is read lazily at distiller-dispatch time
    // (closure-re-read blueprint). The explicit suggestPatches paths must
    // be in RELOADABLE_FIELDS so an operator's clawcode.yaml flip takes
    // effect without a daemon restart.
    expect(RELOADABLE_FIELDS.has("agents.*.skillDistiller.suggestPatches")).toBe(
      true,
    );
    expect(RELOADABLE_FIELDS.has("defaults.skillDistiller.suggestPatches")).toBe(
      true,
    );
    // The coarse skillDistiller entries (which also cover the nested field)
    // remain present — sanity that this addition is additive.
    expect(RELOADABLE_FIELDS.has("agents.*.skillDistiller")).toBe(true);
    expect(RELOADABLE_FIELDS.has("defaults.skillDistiller")).toBe(true);
  });
});
