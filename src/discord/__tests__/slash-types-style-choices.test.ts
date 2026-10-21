import { describe, it, expect } from "vitest";
import { DEFAULT_SLASH_COMMANDS, STYLE_CHOICES } from "../slash-types.js";
import { OUTPUT_STYLES, getOutputStyle } from "../../manager/output-styles/roster.js";
import { outputStyleSchema } from "../../config/schema.js";

/**
 * 999.105 — drift guards for the three-way sync: config enum <-> roster <->
 * STYLE_CHOICES (slash-types is import-free by convention, so the choices are
 * literals and THESE tests are the sync mechanism).
 */
describe("STYLE_CHOICES <-> roster <-> schema sync", () => {
  it("every schema id appears exactly once in the roster", () => {
    const rosterIds = OUTPUT_STYLES.map((s) => s.id);
    expect([...rosterIds].sort()).toEqual([...outputStyleSchema.options].sort());
    expect(new Set(rosterIds).size).toBe(rosterIds.length);
  });

  it("every roster id appears as a choice value, plus exactly `status`", () => {
    const choiceValues = STYLE_CHOICES.map((c) => c.value).sort();
    const expected = [...OUTPUT_STYLES.map((s) => s.id), "status"].sort();
    expect(choiceValues).toEqual(expected);
  });

  it("choice names fit Discord's 100-char cap", () => {
    for (const c of STYLE_CHOICES) expect(c.name.length).toBeLessThanOrEqual(100);
  });

  it("default has NO block; every other style has one under 120 words", () => {
    // "default" must clear, never inject "be default" (unreachable baseline).
    expect(getOutputStyle("default")?.block).toBeUndefined();
    for (const s of OUTPUT_STYLES) {
      if (s.id === "default") continue;
      expect(s.block, s.id).toBeDefined();
      expect(s.block!.split(/\s+/).length, `${s.id} word count`).toBeLessThanOrEqual(120);
    }
  });

  it("no block prescribes voice or persona (form-not-voice filter)", () => {
    // Cheap tripwire: persona vocabulary should never appear in a block.
    for (const s of OUTPUT_STYLES) {
      if (!s.block) continue;
      expect(s.block.toLowerCase()).not.toMatch(/persona|act as|pretend|character|speak like/);
    }
  });
});

describe("/clawcode-style command entry", () => {
  const cmd = DEFAULT_SLASH_COMMANDS.find((c) => c.name === "clawcode-style");

  it("exists and is visible to EVERYONE (2026-08-14 operator decision)", () => {
    expect(cmd).toBeDefined();
    // No defaultMemberPermissions gate - style is cosmetic, any user/channel.
    expect(cmd!.defaultMemberPermissions).toBeUndefined();
  });

  it("style option is required with the choices dropdown", () => {
    expect(cmd!.options[0].name).toBe("style");
    expect(cmd!.options[0].required).toBe(true);
    expect(cmd!.options[0].choices).toBe(STYLE_CHOICES);
  });

  it("agent option is exactly lowercase 'agent' with NO static choices", () => {
    // The fleet-dropdown injection is a case-sensitive equality check on the
    // option name, and static choices would take precedence and kill it.
    const agentOpt = cmd!.options[1];
    expect(agentOpt.name).toBe("agent");
    expect(agentOpt.required).toBe(false);
    expect(agentOpt.choices).toBeUndefined();
  });
});
