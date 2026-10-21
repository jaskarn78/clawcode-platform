/**
 * Phase 130 — `defineSkill` helper.
 *
 * Authors of `SKILL.md`-backed skills call `defineSkill(manifest)` in any
 * companion `.ts` (or, in Plan 02+, the loader passes the parsed frontmatter
 * through this helper). The helper Zod-parses the manifest and either
 * returns the typed manifest unchanged or throws a structured error listing
 * each offending field.
 *
 * Mirrors OpenClaw's `plugin-sdk` `defineSkill` shape (idioms only — ClawCode
 * is its own runtime).
 *
 * See `.planning/phases/130-manifest-driven-plugin-sdk/130-CONTEXT.md` D-02a.
 */
import { SkillManifestSchema, type SkillManifest } from "./manifest-schema.js";

export function defineSkill(manifest: SkillManifest): SkillManifest {
  const result = SkillManifestSchema.safeParse(manifest);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid skill manifest:\n${issues}`);
  }
  return result.data;
}
