/**
 * Skill-slash-commands — unit tests for the pure skill-name normaliser.
 *
 * Covers: lowercase fold, `:` → `-` (plugin namespace), illegal-char
 * replacement, hyphen collapse + trim, 32-char truncation, and the
 * empty-result → null case.
 */

import { describe, it, expect } from "vitest";
import { skillNameToCommandName } from "../skill-command-names.js";

describe("skillNameToCommandName", () => {
  it("passes a clean lowercase name through unchanged", () => {
    expect(skillNameToCommandName("reelforge")).toBe("reelforge");
    expect(skillNameToCommandName("market-research")).toBe("market-research");
  });

  it("folds uppercase to lowercase", () => {
    expect(skillNameToCommandName("ReelForge")).toBe("reelforge");
    expect(skillNameToCommandName("CONTENT-ENGINE")).toBe("content-engine");
  });

  it("replaces the `:` plugin-namespace separator with `-`", () => {
    expect(skillNameToCommandName("discord:access")).toBe("discord-access");
    expect(skillNameToCommandName("discord:configure")).toBe(
      "discord-configure",
    );
  });

  it("replaces any illegal char (spaces, dots) with `-`", () => {
    expect(skillNameToCommandName("my skill")).toBe("my-skill");
    expect(skillNameToCommandName("a.b.c")).toBe("a-b-c");
  });

  it("collapses repeated `-` and trims leading/trailing `-`", () => {
    expect(skillNameToCommandName("--foo--bar--")).toBe("foo-bar");
    expect(skillNameToCommandName("a::b")).toBe("a-b");
  });

  it("collapses a multi-segment plugin name to a legal command name", () => {
    expect(skillNameToCommandName("ui-ux-pro-max:ui-ux-pro-max")).toBe(
      "ui-ux-pro-max-ui-ux-pro-max",
    );
  });

  it("truncates to 32 characters", () => {
    const long = "a".repeat(50);
    const out = skillNameToCommandName(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(32);
  });

  it("re-trims a trailing `-` exposed by truncation", () => {
    // 31 'a' then '-' then more — the slice lands the `-` at position 32.
    const name = "a".repeat(32) + "-tail";
    const out = skillNameToCommandName(name);
    expect(out).not.toBeNull();
    expect(out!.endsWith("-")).toBe(false);
  });

  it("returns null for a name that normalises to empty", () => {
    expect(skillNameToCommandName(":::")).toBeNull();
    expect(skillNameToCommandName("   ")).toBeNull();
    expect(skillNameToCommandName("")).toBeNull();
  });

  it("preserves underscores and digits (both legal)", () => {
    expect(skillNameToCommandName("skill_2")).toBe("skill_2");
  });
});
