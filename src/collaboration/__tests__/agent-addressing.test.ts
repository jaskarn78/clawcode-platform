/**
 * Phase 999.117 WS-5 — agent-name resolution tests.
 *
 * The motivating case: one production agent is named "Admin Clawdy" — a space
 * AND capitals, in a fleet where every other name is kebab-case. `to: "admin"`
 * was the natural guess, and it failed with a bare "not found" that gave the
 * sending model nothing to correct against.
 */

import { describe, it, expect } from "vitest";
import {
  resolveAgentName,
  describeResolutionFailure,
  normaliseAgentName,
} from "../agent-addressing.js";

const FLEET = [
  { name: "Admin Clawdy", aliases: ["admin", "admin-clawdy"] },
  { name: "fin-research" },
  { name: "fin-client" },
  { name: "projects" },
];

describe("resolveAgentName", () => {
  it("exact name wins", () => {
    expect(resolveAgentName("projects", FLEET)).toEqual({
      kind: "exact",
      name: "projects",
    });
  });

  it("an operator-declared alias resolves", () => {
    // An alias is stated intent, so it is matched before any fuzzy step.
    expect(resolveAgentName("admin", FLEET)).toEqual({
      kind: "alias",
      name: "Admin Clawdy",
      matched: "admin",
    });
  });

  it("resolves across case and separator differences", () => {
    for (const spelling of ["admin clawdy", "ADMIN-CLAWDY", "Admin_Clawdy", "adminclawdy"]) {
      const r = resolveAgentName(spelling, FLEET);
      expect(r.kind === "alias" || r.kind === "normalised").toBe(true);
      expect("name" in r && r.name).toBe("Admin Clawdy");
    }
  });

  it("refuses to guess between fin-research and fin-client", () => {
    // The important negative. Silently delivering to the wrong agent is worse
    // than failing — neither the sender nor the operator can tell.
    const r = resolveAgentName("fin", FLEET);
    expect(r.kind).toBe("ambiguous");
    expect(r.kind === "ambiguous" && [...r.candidates].sort()).toEqual([
      "fin-client",
      "fin-research",
    ]);
  });

  it("an unrelated name is unknown", () => {
    expect(resolveAgentName("nobody", FLEET).kind).toBe("unknown");
  });

  it("a fleet with no aliases still resolves by normalisation", () => {
    const plain = [{ name: "state-contract" }];
    expect(resolveAgentName("State Contract", plain)).toEqual({
      kind: "normalised",
      name: "state-contract",
    });
  });

  it("an empty request resolves to nothing", () => {
    expect(resolveAgentName("", FLEET).kind).toBe("unknown");
    expect(resolveAgentName("   ", FLEET).kind).toBe("unknown");
  });
});

describe("describeResolutionFailure", () => {
  it("always lists the valid targets so the next call can succeed", () => {
    const r = resolveAgentName("nobody", FLEET);
    const text = describeResolutionFailure("nobody", r, FLEET);
    expect(text).toContain("'Admin Clawdy'");
    expect(text).toContain("'projects'");
  });

  it("names the competing candidates when ambiguous", () => {
    const r = resolveAgentName("fin", FLEET);
    const text = describeResolutionFailure("fin", r, FLEET);
    expect(text).toContain("ambiguous");
    expect(text).toContain("'fin-research'");
    expect(text).toContain("'fin-client'");
  });
});

describe("normaliseAgentName", () => {
  it("folds case and separators only", () => {
    expect(normaliseAgentName("Admin Clawdy")).toBe("adminclawdy");
    expect(normaliseAgentName("fin_research")).toBe("finresearch");
    // Other punctuation is preserved — folding it would start merging
    // genuinely distinct names.
    expect(normaliseAgentName("a.b")).toBe("a.b");
  });
});
