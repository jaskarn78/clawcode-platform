/**
 * Phase 115 sub-scope 2 — verify `buildSystemPromptOption` forwards
 * `excludeDynamicSections` to the SDK preset shape.
 *
 * Locked invariants:
 *   - Returned object's `type === "preset"` and `preset === "claude_code"` —
 *     Phase 52 D-01 cache-scaffolding contract.
 *   - When `stablePrefix` is non-empty, `append: stablePrefix` is preserved.
 *   - `excludeDynamicSections` field is OMITTED when the parameter was
 *     undefined (legacy callers / tests stay byte-identical to pre-115).
 *   - `excludeDynamicSections: true|false` is forwarded verbatim when passed.
 *
 * Per-agent override resolution (defaults vs agentSchema vs explicit
 * override) is exercised via the loader.test.ts suite — this file pins the
 * adapter-side contract.
 */

import { describe, it, expect } from "vitest";
import { buildSystemPromptOption } from "../session-adapter.js";

describe("Phase 115 sub-scope 2 — buildSystemPromptOption excludeDynamicSections", () => {
  it("preserves SDK preset shape when no flag passed (back-compat)", () => {
    const out = buildSystemPromptOption("identity stable prefix");
    expect(out).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "identity stable prefix",
    });
    // Ensure the field is NOT spread as `undefined` — back-compat byte-equality.
    expect(out).not.toHaveProperty("excludeDynamicSections");
  });

  it("preserves SDK preset shape with empty prefix and no flag", () => {
    const out = buildSystemPromptOption("");
    expect(out).toEqual({ type: "preset", preset: "claude_code" });
    expect(out).not.toHaveProperty("append");
    expect(out).not.toHaveProperty("excludeDynamicSections");
  });

  it("forwards excludeDynamicSections=true verbatim with non-empty prefix", () => {
    const out = buildSystemPromptOption("body", true);
    expect(out).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "body",
      excludeDynamicSections: true,
    });
  });

  it("forwards excludeDynamicSections=false verbatim with non-empty prefix", () => {
    const out = buildSystemPromptOption("body", false);
    expect(out).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "body",
      excludeDynamicSections: false,
    });
  });

  it("forwards excludeDynamicSections=true verbatim with empty prefix", () => {
    const out = buildSystemPromptOption("", true);
    expect(out).toEqual({
      type: "preset",
      preset: "claude_code",
      excludeDynamicSections: true,
    });
    expect(out).not.toHaveProperty("append");
  });

  it("preserves locked preset literal (Phase 52 D-01 cache-scaffolding contract)", () => {
    // Defensive: type and preset MUST be the SDK-locked literals or the
    // preset's auto-cache wiring is lost. Sanity-pin against silent
    // typo regressions on the shape constants.
    const out = buildSystemPromptOption("anything", true);
    expect(out.type).toBe("preset");
    expect(out.preset).toBe("claude_code");
  });

  it("does not mutate or share the input prefix string", () => {
    const prefix = "stable-prefix";
    const out = buildSystemPromptOption(prefix, true);
    if ("append" in out) {
      expect(out.append).toBe(prefix);
      // Strings are immutable in JS, but verify reference behavior — the
      // append field IS the same string (no copy needed; the SDK reads it
      // synchronously).
      expect(out.append).toBe(prefix);
    } else {
      throw new Error("append missing from non-empty prefix output");
    }
  });
});
