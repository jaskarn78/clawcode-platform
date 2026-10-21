/**
 * Phase 999.42 Plan 06 T-03 — skill-patch-embed module tests.
 *
 * Covers `buildSkillPatchEmbed` (pending-patch summary). The operator action
 * renderer went with the retired /patch-skill, /approve-patch and
 * /reject-patch commands (2026-09-23).
 */
import { describe, expect, it } from "vitest";
import { buildSkillPatchEmbed, type SkillPatchRecord } from "../skill-patch-embed.js";

function makeRecord(overrides: Partial<SkillPatchRecord> = {}): SkillPatchRecord {
  return {
    patchId: "find-clients-by-industry-2026-05-20-120000-abc123def456",
    slug: "find-clients-by-industry",
    patchClass: "patch",
    currentVersion: "1.0.0",
    bumpedVersion: "1.0.1",
    sourceSessionId: "sess-abc123",
    draftedAt: "2026-05-20T12:00:00Z",
    ...overrides,
  };
}

describe("skill-patch-embed (Phase 999.42 Plan 06 T-03)", () => {
  it("SP-01: buildSkillPatchEmbed title names the patched skill slug", () => {
    const embed = buildSkillPatchEmbed(makeRecord());
    const json = embed.toJSON();
    expect(json.title).toContain("Skill patch proposed");
    expect(json.title).toContain("find-clients-by-industry");
  });

  it("SP-02: buildSkillPatchEmbed renders class + version transition + source + patch-id", () => {
    const embed = buildSkillPatchEmbed(makeRecord());
    const fields = embed.toJSON().fields ?? [];
    const byName = (n: string) => fields.find((f) => f.name === n)?.value;
    expect(byName("Class")).toBe("patch");
    expect(byName("Version")).toBe("1.0.0 → 1.0.1");
    expect(byName("Source session")).toBe("sess-abc123");
    expect(byName("Patch id")).toContain(
      "find-clients-by-industry-2026-05-20-120000-abc123def456",
    );
  });

  it("SP-03: buildSkillPatchEmbed footer points at the patch file, not the retired commands", () => {
    const r = makeRecord();
    const footer = buildSkillPatchEmbed(r).toJSON().footer?.text ?? "";
    expect(footer).toContain(`skill-patches/${r.patchId}.patch.md`);
    expect(footer).not.toMatch(/\/(approve|reject)-patch/);
  });
});
