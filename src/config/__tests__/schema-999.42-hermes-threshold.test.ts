/**
 * Phase 999.42 capability B — guards the Hermes-parity minToolCalls
 * default (5) and proves Phase 132 D-03's other thresholds are intact +
 * per-agent overrides still win.
 *
 * Phase 132 D-03 locked the out-of-band skill distiller's default
 * eligibility thresholds at 6 / 180_000 / ["success"]. Hermes Agent
 * auto-creates skills at 5+ tool calls. Phase 999.42 capability B
 * (CONTEXT D4) lowers ONLY the tool-call count 6→5 for Hermes parity;
 * minDurationMs + outcomeFilter stay exactly as Phase 132 D-03 set them.
 *
 * These pure zod-parse tests pin the resolved value across all three
 * schema resolution paths so a future edit cannot silently drift the
 * Hermes-parity threshold back to 6.
 *
 * ===========================================================================
 * TRIAL-COHORT EXPANSION CHECKLIST  (Phase 999.42 capability B — CONTEXT D4)
 * ===========================================================================
 * The minToolCalls 6→5 change is the CODE half of capability B. The OPERATOR
 * half — expanding which agents actually distill skills — is a post-phase
 * action, NOT performed by this autonomous chain. This checklist is the
 * operator-facing expansion path; it is lifted verbatim into 999.42-04-SUMMARY.md.
 *
 *  1. CURRENT COHORT. Phase 132 D-08 trial cohort = Admin Clawdy ONLY.
 *     `autonomousSkillDrafting: true` was flipped on Admin Clawdy on
 *     2026-05-17 (Phase 132 Plan 04 SUMMARY). No other agent distills.
 *
 *  2. SOAK-READINESS GATE (before expanding the cohort). Review the Admin
 *     Clawdy soak window:
 *         journalctl -u clawcode -g phase132-skill-draft
 *     Count drafts staged vs. approved vs. rejected. Expansion is
 *     appropriate only if the staged-but-noise rate is low — i.e. drafts
 *     are mostly genuine, not proliferation noise. This is an OPERATOR
 *     JUDGMENT call; there is no auto-gate.
 *
 *  3. EXPANSION TARGETS (per CONTEXT D4). Add `research`, then `projects` —
 *     code-reasoning-heavy agents with a recoverable failure surface.
 *     Do NOT add `fin-client` or `acme-content-creator`: they are
 *     user-facing / Client A-active and must not absorb drafting noise.
 *
 *  4. EXPANSION MECHANISM. Set per-agent `autonomousSkillDrafting: true` in
 *     the production `clawcode.yaml` on `clawdy`, then `clawcode reload`.
 *     The field is RELOADABLE (Phase 132 Plan 01) — no daemon bounce
 *     required. This is a POST-PHASE OPERATOR ACTION: it touches production
 *     config and is gated on the step-2 soak review. It is NOT an
 *     autonomous task and is NOT performed by Phase 999.42.
 *
 *  5. THRESHOLD INERTNESS FOR NON-COHORT AGENTS. The new `minToolCalls: 5`
 *     default applies fleet-wide the moment this phase's code is deployed —
 *     BUT only agents with `autonomousSkillDrafting: true` actually run the
 *     distiller. So the 6→5 threshold change is INERT for every non-cohort
 *     agent until an operator opts it in via step 4. Deploying this phase
 *     changes zero behavior for the fleet until the cohort is expanded.
 * ===========================================================================
 */

import { describe, it, expect } from "vitest";
import { agentSchema, defaultsSchema, configSchema } from "../schema.js";

/** Minimal valid root config — no `defaults` block at all. */
const CONFIG_NO_DEFAULTS = {
  version: 1 as const,
  agents: [{ name: "test-agent" }],
};

describe("Phase 999.42 capability B — Hermes-parity minToolCalls default (5)", () => {
  it("Hermes-1: config with NO defaults block → resolved minToolCalls is 5", () => {
    // configSchema.defaults uses `.default(() => ({...}))` — when the
    // `defaults:` key is omitted entirely, the configSchema fallback
    // object fires. That fallback's skillDistiller.minToolCalls must be 5.
    const result = configSchema.safeParse(CONFIG_NO_DEFAULTS);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaults.skillDistiller.minToolCalls).toBe(5);
    }
  });

  it("Hermes-2: empty defaults:{} block → resolved minToolCalls is 5", () => {
    // An explicit but empty `defaults: {}` block hits the defaultsSchema
    // outer `.default({...})` mirror on the skillDistiller field.
    const result = defaultsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillDistiller).toBeDefined();
      expect(result.data.skillDistiller!.minToolCalls).toBe(5);
    }
  });

  it("Hermes-3: partial defaults override (minToolCalls:10) → 10, other thresholds still default", () => {
    // A partial `skillDistiller: { minToolCalls: 10 }` exercises the
    // defaultsSchema INNER `.default(...)` cascade — minToolCalls is
    // explicit (10), while minDurationMs + outcomeFilter fall through to
    // their inner defaults (180000 / ["success"]).
    const result = defaultsSchema.safeParse({
      skillDistiller: { minToolCalls: 10 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillDistiller!.minToolCalls).toBe(10);
      expect(result.data.skillDistiller!.minDurationMs).toBe(180000);
      expect(result.data.skillDistiller!.outcomeFilter).toEqual(["success"]);
    }
  });

  it("Hermes-4: per-agent skillDistiller override (minToolCalls:6) still wins over the new 5 default", () => {
    // The per-agent override schema is untouched — a partial
    // `agents[].skillDistiller: { minToolCalls: 6 }` resolves to 6, not 5.
    // The resolver (loader Plan 02) merges per-agent over defaults; the
    // schema layer simply preserves the explicit per-agent value.
    const result = agentSchema.safeParse({
      name: "override-agent",
      skillDistiller: { minToolCalls: 6 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skillDistiller?.minToolCalls).toBe(6);
      // Per-agent inner fields stay optional — resolver merges defaults
      expect(result.data.skillDistiller?.minDurationMs).toBeUndefined();
      expect(result.data.skillDistiller?.outcomeFilter).toBeUndefined();
    }
  });

  it("Hermes-5: minDurationMs + outcomeFilter defaults are UNCHANGED — capability B did not move them", () => {
    // Capability B is one number. Pin the two thresholds Phase 132 D-03
    // owns to prove they did not drift: minDurationMs stays 180000,
    // outcomeFilter stays ["success"], in BOTH resolution paths.
    const fromDefaults = defaultsSchema.safeParse({});
    expect(fromDefaults.success).toBe(true);
    if (fromDefaults.success) {
      expect(fromDefaults.data.skillDistiller!.minDurationMs).toBe(180000);
      expect(fromDefaults.data.skillDistiller!.outcomeFilter).toEqual(["success"]);
    }

    const fromConfigFallback = configSchema.safeParse(CONFIG_NO_DEFAULTS);
    expect(fromConfigFallback.success).toBe(true);
    if (fromConfigFallback.success) {
      const sd = fromConfigFallback.data.defaults.skillDistiller;
      expect(sd.minDurationMs).toBe(180000);
      expect(sd.outcomeFilter).toEqual(["success"]);
    }
  });
});
