/**
 * Phase 999.98 Plan 01 Task 3 — Fable model resolution + advisor-allow unit pins.
 *
 * Asserts the EXACT representation production passes at the advisor gate: the
 * RESOLVED executor id (what `shouldEnableAdvisor` hands to
 * `advisorAllowedForExecutor` after `resolveModelId`), NOT the config alias.
 * A test against the alias would pass while production (which resolves first)
 * silently no-ops the gate — so these assertions are deliberately on the
 * resolved-id form.
 */

import { describe, it, expect } from "vitest";
import {
  resolveModelId,
  advisorAllowedForExecutor,
  advisorPairingValid,
  resolveAdvisorModel,
} from "../model-resolver.js";

describe("model-resolver — Fable alias (Phase 999.98 D2)", () => {
  it("resolveModelId('fable') resolves to the pinned claude-fable-5-1 id", () => {
    expect(resolveModelId("fable")).toBe("claude-fable-5-1");
  });

  it("a fully-qualified fable id passes through unchanged", () => {
    expect(resolveModelId("claude-fable-5")).toBe("claude-fable-5");
  });

  it("the existing aliases still resolve (no regression from the fable add)", () => {
    expect(resolveModelId("opus")).toBe("claude-opus-5-5");
    expect(resolveModelId("sonnet")).toBe("claude-sonnet-5");
    expect(resolveModelId("haiku")).toBe("claude-haiku-4-5");
  });

  it("an unknown full id still passes through (generic-resolver contract)", () => {
    expect(resolveModelId("some-future-model-9")).toBe("some-future-model-9");
  });
});

describe("model-resolver — advisorAllowedForExecutor (Phase 999.98 D3 → 2026-08-28 pairing)", () => {
  // 2026-08-28 — Fable is advisor-compatible again (Fable advises Fable,
  // verified on 2.1.210). The family flag no longer carries the pairing rule;
  // `advisorPairingValid` does, by rank.
  it("returns true for the resolved Fable id (pairing decides, not the family)", () => {
    expect(advisorAllowedForExecutor("claude-fable-5")).toBe(true);
    expect(advisorAllowedForExecutor(resolveModelId("fable"))).toBe(true);
  });

  it("returns true for the resolved Opus id (advisor allowed as today)", () => {
    expect(advisorAllowedForExecutor("claude-opus-4-8")).toBe(true);
    expect(advisorAllowedForExecutor(resolveModelId("opus"))).toBe(true);
  });

  it("returns true for sonnet/haiku resolved ids", () => {
    expect(advisorAllowedForExecutor(resolveModelId("sonnet"))).toBe(true);
    expect(advisorAllowedForExecutor(resolveModelId("haiku"))).toBe(true);
  });
});

describe("model-resolver — advisorPairingValid (2026-08-28, advisor >= executor by family rank)", () => {
  it("fable executor: only a fable advisor is valid; opus (the fleet default) is rejected", () => {
    expect(advisorPairingValid("claude-fable-5", "claude-fable-5")).toEqual({ ok: true });
    expect(advisorPairingValid("claude-fable-5", resolveAdvisorModel("fable"))).toEqual({ ok: true });
    const bad = advisorPairingValid("claude-fable-5", resolveAdvisorModel("opus"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/less capable/);
  });
  it("opus/sonnet/haiku executors accept an equal-or-stronger advisor, reject a weaker one", () => {
    expect(advisorPairingValid("claude-opus-5", "claude-opus-5").ok).toBe(true);
    // Phase 999.114 — CORRECTED from `true`. Family rank is equal here (both
    // opus), which is why the rank-only check accepted this pair — but it is
    // the exact pairing Anthropic rejects, verbatim from the 400 recorded in
    // ADVISOR_MODEL_ALIASES: `tools.N.model: 'claude-opus-4-8' cannot be used
    // as an advisor when the request model is 'claude-opus-5'`. The guard now
    // also compares WITHIN-family version, so a known-dead pair fails closed.
    expect(advisorPairingValid("claude-opus-5", "claude-opus-4-8").ok).toBe(false);
    // ...while an equal or NEWER same-family advisor still passes.
    expect(advisorPairingValid("claude-opus-4-8", "claude-opus-5").ok).toBe(true);
    // Cross-family stays governed by RANK, not version — a numerically lower
    // version in a stronger family is valid (the API's own example, below).
    expect(advisorPairingValid("claude-fable-5-1", "claude-fable-5").ok).toBe(false);
    expect(advisorPairingValid("claude-fable-5", "claude-fable-5-1").ok).toBe(true);
    expect(advisorPairingValid("claude-opus-5", "claude-fable-5").ok).toBe(true);
    expect(advisorPairingValid("claude-sonnet-5", "claude-opus-4-7").ok).toBe(true); // the API's own example
    expect(advisorPairingValid("claude-haiku-4-5", "claude-sonnet-5").ok).toBe(true);
    expect(advisorPairingValid("claude-opus-5", "claude-sonnet-5").ok).toBe(false);
    expect(advisorPairingValid("claude-sonnet-5", "claude-haiku-4-5").ok).toBe(false);
  });
  it("unknown ids are rejected, never guessed (the env flag bypasses the CLI check)", () => {
    expect(advisorPairingValid("gpt-5", "claude-opus-5").ok).toBe(false);
    expect(advisorPairingValid("claude-opus-5", "not-a-model").ok).toBe(false);
  });
  it("the fable advisor alias resolves to the concrete id", () => {
    // Phase 999.114 — the advisor pin moves in LOCKSTEP with the executor pin.
    expect(resolveAdvisorModel("fable")).toBe("claude-fable-5-1");
    expect(resolveAdvisorModel("claude-fable-5-1")).toBe("claude-fable-5-1");
    // Explicit rollback pin still resolves to itself.
    expect(resolveAdvisorModel("claude-fable-5")).toBe("claude-fable-5");
  });
});
