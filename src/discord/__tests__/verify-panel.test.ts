/**
 * 999.63d/8 — `/clawcode-verify` interactive panel.
 *
 * The builders are pure so the Discord-shape invariants (row cap, option
 * cap, correct default marked) are testable without a client — the
 * dispatch-layer bug in 999.63d/7 was exactly the class of thing unit
 * tests of the store could not see.
 */
import { describe, expect, it } from "vitest";

import {
  buildVerifyPanelComponents,
  parseVerifyPanelId,
  renderVerifyPanelText,
  VERIFY_MODE_CHOICES,
  VERIFY_PROFILE_CHOICES,
  type VerifyPanelState,
} from "../slash-commands.js";

const base: VerifyPanelState = {
  agent: "fin-client",
  agents: ["fin-client", "personal", "projects"],
  enabled: true,
  mode: "auto",
  profile: "finance",
  fromOverride: false,
};

function rows(state: VerifyPanelState): any[] {
  return buildVerifyPanelComponents(state) as any[];
}
function comp(state: VerifyPanelState, customIdPrefix: string): any {
  return rows(state)
    .flatMap((r) => r.components)
    .find((c: any) => String(c.custom_id).startsWith(customIdPrefix));
}

describe("verify panel", () => {
  it("stays within Discord's 5-action-row cap", () => {
    expect(rows(base).length).toBeLessThanOrEqual(5);
  });

  it("marks the CURRENT value as the selected default on every select", () => {
    // Without this the panel opens showing a placeholder and the operator
    // cannot tell what is actually in force.
    const st = { ...base, mode: "topic", profile: "legal" };
    const mode = comp(st, "cv:mode");
    const profile = comp(st, "cv:profile");
    expect(mode.options.find((o: any) => o.default).value).toBe("topic");
    expect(profile.options.find((o: any) => o.default).value).toBe("legal");
  });

  it("offers every mode and profile the command accepts", () => {
    const mode = comp(base, "cv:mode");
    const profile = comp(base, "cv:profile");
    expect(mode.options.map((o: any) => o.value)).toEqual(
      VERIFY_MODE_CHOICES.map((c) => c.value),
    );
    expect(profile.options.map((o: any) => o.value)).toEqual(
      VERIFY_PROFILE_CHOICES.map((c) => c.value),
    );
  });

  it("every option carries a description — the labels alone are jargon", () => {
    for (const c of [comp(base, "cv:mode"), comp(base, "cv:profile")]) {
      for (const o of c.options) {
        expect(String(o.description ?? "").length).toBeGreaterThan(0);
        expect(String(o.label).length).toBeLessThanOrEqual(100);
        expect(String(o.description).length).toBeLessThanOrEqual(100);
      }
    }
  });

  it("omits the agent select when there is only one agent", () => {
    const solo = { ...base, agents: ["fin-client"] };
    expect(comp(solo, "cv:agent")).toBeUndefined();
    expect(comp(base, "cv:agent")).toBeDefined();
  });

  it("caps the agent select at Discord's 25-option limit", () => {
    const many = Array.from({ length: 60 }, (_, i) => `agent-${i}`);
    const sel = comp({ ...base, agents: many }, "cv:agent");
    expect(sel.options.length).toBeLessThanOrEqual(25);
    // the current agent is always present even if it sorts past 25
    expect(sel.options.some((o: any) => o.value === base.agent)).toBe(true);
  });

  it("disables Reset when there is nothing to reset", () => {
    const btn = (st: VerifyPanelState) => comp(st, "cv:reset");
    expect(btn(base).disabled).toBe(true);
    expect(btn({ ...base, fromOverride: true }).disabled).toBe(false);
  });

  it("says plainly when the trail is off rather than implying it works", () => {
    const text = renderVerifyPanelText({ ...base, enabled: false });
    expect(text).toContain("off");
    expect(text).toContain("streamStatus");
  });

  it("labels whether the live value came from config or the panel", () => {
    expect(renderVerifyPanelText(base)).toContain("from config");
    expect(renderVerifyPanelText({ ...base, fromOverride: true })).toContain(
      "set here",
    );
  });

  it("round-trips its own customIds and rejects foreign ones", () => {
    expect(parseVerifyPanelId("cv:mode:fin-client")).toEqual({
      field: "mode",
      agent: "fin-client",
    });
    // agent names contain hyphens — the parser must not split on them
    expect(parseVerifyPanelId("cv:agent:client-a-personal-clawdy")?.agent).toBe(
      "client-a-personal-clawdy",
    );
    expect(parseVerifyPanelId("cv:reset:a")?.field).toBe("reset");
    expect(parseVerifyPanelId("pp:something:q0")).toBeNull();
    expect(parseVerifyPanelId("tools-refresh:a")).toBeNull();
  });

  it("keeps every customId inside Discord's 100-char cap", () => {
    const long = "a".repeat(80);
    for (const r of rows({ ...base, agent: long, agents: [long] })) {
      for (const c of r.components) {
        expect(String(c.custom_id).length).toBeLessThanOrEqual(100);
      }
    }
  });
});
