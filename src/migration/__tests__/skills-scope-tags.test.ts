/**
 * Phase 84 Plan 02 Task 1 — skills-scope-tags unit tests.
 *
 * Locks the scope table (P1 skills) and the allow/refuse rules for
 * linking skills to agents by family (acme / personal / fleet).
 */
import { describe, it, expect } from "vitest";
import {
  SCOPE_TAGS,
  scopeForAgent,
  canLinkSkillToAgent,
} from "../skills-scope-tags.js";

describe("skills-scope-tags — SCOPE_TAGS map", () => {
  it("contains all 5 P1 skills with expected scopes", () => {
    expect(SCOPE_TAGS.get("acme-crm")).toBe("acme");
    expect(SCOPE_TAGS.get("new-reel")).toBe("acme");
    expect(SCOPE_TAGS.get("frontend-design")).toBe("fleet");
    expect(SCOPE_TAGS.get("self-improving-agent")).toBe("fleet");
    expect(SCOPE_TAGS.get("tuya-ac")).toBe("personal");
  });
});

describe("skills-scope-tags — scopeForAgent", () => {
  it("fin- prefix → acme", () => {
    expect(scopeForAgent("fin-client")).toBe("acme");
    expect(scopeForAgent("fin-research")).toBe("acme");
    expect(scopeForAgent("fin-tax")).toBe("acme");
  });
  it("clawdy / owner_a → personal", () => {
    expect(scopeForAgent("clawdy")).toBe("personal");
    expect(scopeForAgent("owner_a")).toBe("personal");
  });
  it("everything else → fleet", () => {
    expect(scopeForAgent("general")).toBe("fleet");
    expect(scopeForAgent("projects")).toBe("fleet");
    expect(scopeForAgent("research")).toBe("fleet");
    expect(scopeForAgent("test-agent")).toBe("fleet");
  });
});

describe("skills-scope-tags — canLinkSkillToAgent", () => {
  it("(a) acme-crm + fin-client → true", () => {
    expect(canLinkSkillToAgent("acme-crm", "fin-client")).toBe(true);
  });

  it("(b) acme-crm + clawdy (personal) → false", () => {
    expect(canLinkSkillToAgent("acme-crm", "clawdy")).toBe(false);
  });

  it("(c) acme-crm + clawdy + force=true → true", () => {
    expect(
      canLinkSkillToAgent("acme-crm", "clawdy", { force: true }),
    ).toBe(true);
  });

  it("(d) frontend-design (fleet) + clawdy → true", () => {
    expect(canLinkSkillToAgent("frontend-design", "clawdy")).toBe(true);
  });

  it("(e) tuya-ac (personal) + fin-client → false", () => {
    expect(canLinkSkillToAgent("tuya-ac", "fin-client")).toBe(false);
  });

  it("(f) tuya-ac (personal) + clawdy → true", () => {
    expect(canLinkSkillToAgent("tuya-ac", "clawdy")).toBe(true);
  });

  it("(g) unknown skill (not in SCOPE_TAGS) defaults to fleet — allowed everywhere", () => {
    expect(canLinkSkillToAgent("random-unknown-skill", "fin-research")).toBe(
      true,
    );
    expect(canLinkSkillToAgent("random-unknown-skill", "clawdy")).toBe(true);
    expect(canLinkSkillToAgent("random-unknown-skill", "general")).toBe(true);
  });

  it("(h) new-reel (acme) + general (fleet agent) → false", () => {
    expect(canLinkSkillToAgent("new-reel", "general")).toBe(false);
  });
});
