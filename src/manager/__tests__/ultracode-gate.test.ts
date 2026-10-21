/**
 * Quick 260715-j1j (D6/D13) — unit tests for the pure ultracode eligibility
 * gate (src/manager/ultracode-gate.ts).
 *
 * Contract pinned here:
 *   - Eligible ⇔ model is xhigh-capable (opus/fable family via the
 *     model-catalog: alias, `<family>@latest` sugar, pinned id, or raw-id
 *     substring fallback) AND `nativeWorkflow === true`.
 *   - Every rejection carries an operator-readable `reason` (surfaced
 *     verbatim by the /clawcode-effort ephemeral reply + set-effort IPC).
 *   - Missing config fields fail CLOSED (no model → rejected; flag
 *     undefined → rejected) — the gate can never grant by omission.
 */
import { describe, it, expect } from "vitest";
import { checkUltracodeEligibility } from "../ultracode-gate.js";

describe("checkUltracodeEligibility — eligible paths", () => {
  it("opus alias + nativeWorkflow: true → ok", () => {
    const res = checkUltracodeEligibility({ model: "opus", nativeWorkflow: true });
    expect(res).toEqual({ ok: true });
  });

  it("fable alias + nativeWorkflow: true → ok", () => {
    const res = checkUltracodeEligibility({ model: "fable", nativeWorkflow: true });
    expect(res).toEqual({ ok: true });
  });

  it("opus@latest sugar + nativeWorkflow: true → ok", () => {
    const res = checkUltracodeEligibility({
      model: "opus@latest",
      nativeWorkflow: true,
    });
    expect(res).toEqual({ ok: true });
  });

  it("pinned opus id (claude-opus-4-8) + nativeWorkflow: true → ok", () => {
    const res = checkUltracodeEligibility({
      model: "claude-opus-4-8",
      nativeWorkflow: true,
    });
    expect(res).toEqual({ ok: true });
  });

  it("raw fable id (claude-fable-5) + nativeWorkflow: true → ok", () => {
    const res = checkUltracodeEligibility({
      model: "claude-fable-5",
      nativeWorkflow: true,
    });
    expect(res).toEqual({ ok: true });
  });

  it("unpinned dated opus snapshot id falls through the substring fallback → ok", () => {
    const res = checkUltracodeEligibility({
      model: "claude-opus-4-8-20260101",
      nativeWorkflow: true,
    });
    expect(res).toEqual({ ok: true });
  });
});

describe("checkUltracodeEligibility — wrong model", () => {
  it("sonnet is rejected with the model reason (even with the flag on)", () => {
    const res = checkUltracodeEligibility({ model: "sonnet", nativeWorkflow: true });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("sonnet");
      expect(res.reason).toContain("does not support ultracode");
      expect(res.reason).toContain("opus/fable");
    }
  });

  it("haiku is rejected with the model reason", () => {
    const res = checkUltracodeEligibility({ model: "haiku", nativeWorkflow: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("does not support ultracode");
  });

  it("sonnet@latest sugar is rejected (family resolution, not substring)", () => {
    const res = checkUltracodeEligibility({
      model: "sonnet@latest",
      nativeWorkflow: true,
    });
    expect(res.ok).toBe(false);
  });

  it("pinned sonnet escape hatch (sonnet-4-6) is rejected", () => {
    const res = checkUltracodeEligibility({
      model: "sonnet-4-6",
      nativeWorkflow: true,
    });
    expect(res.ok).toBe(false);
  });
});

describe("checkUltracodeEligibility — nativeWorkflow flag", () => {
  it("opus with nativeWorkflow: false → rejected with the flag reason", () => {
    const res = checkUltracodeEligibility({ model: "opus", nativeWorkflow: false });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("nativeWorkflow");
      expect(res.reason).toContain("restart");
    }
  });

  it("opus with nativeWorkflow undefined → rejected (fail closed — resolver omits the field for the non-opted fleet)", () => {
    const res = checkUltracodeEligibility({ model: "opus" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("nativeWorkflow");
  });
});

describe("checkUltracodeEligibility — missing config fields fail closed", () => {
  it("no model → rejected with a readable reason", () => {
    const res = checkUltracodeEligibility({ nativeWorkflow: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("no resolved model");
  });

  it("empty config object → rejected", () => {
    const res = checkUltracodeEligibility({});
    expect(res.ok).toBe(false);
  });

  it("empty-string model → rejected", () => {
    const res = checkUltracodeEligibility({ model: "", nativeWorkflow: true });
    expect(res.ok).toBe(false);
  });

  it("unknown model id with no capable substring → rejected via the model reason", () => {
    const res = checkUltracodeEligibility({
      model: "claude-mystery-9",
      nativeWorkflow: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("does not support ultracode");
  });
});
