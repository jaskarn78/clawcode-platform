/**
 * Phase 84 Plan 02 Task 2 — per-agent skill linker verification.
 *
 * Pure function, NO fs I/O. Replicates the resolution half of
 * `src/skills/linker.ts` (catalog lookup by skill name) WITHOUT
 * creating symlinks. Used after `clawcode migrate openclaw skills
 * apply` copies skills into `~/.clawcode/skills/`, to confirm every
 * agent's declared skill list resolves against the freshly-scanned
 * target catalog.
 *
 * Status vocabulary (LinkVerification.status):
 *   - `linked`               — skill in catalog + scope allows agent
 *   - `missing-from-catalog` — skill in migratedSkillNames but catalog
 *                              lacks it (copy probably failed)
 *   - `scope-refused`        — skill in catalog but scope rules
 *                              (skills-scope-tags.ts) refuse the agent
 *   - `not-assigned`         — skill migrated but no agent has it in
 *                              their assigned skills list (informational)
 *
 * The real linker (src/skills/linker.ts) does NOT have a dryRun mode;
 * this verifier is a read-only mirror of its resolution logic so we
 * can validate migration success before any startup-time daemon
 * link attempts create noise.
 */
import type { SkillsCatalog } from "../skills/types.js";
import type { ResolvedAgentConfig } from "../shared/types.js";
import {
  SCOPE_TAGS,
  canLinkSkillToAgent,
  scopeForAgent,
} from "./skills-scope-tags.js";

export type LinkVerificationStatus =
  | "linked"
  | "missing-from-catalog"
  | "scope-refused"
  | "not-assigned";

export type LinkVerification = {
  readonly agent: string;
  readonly skill: string;
  readonly status: LinkVerificationStatus;
  readonly reason?: string;
};

export type VerifySkillLinkagesOptions = {
  readonly catalog: SkillsCatalog;
  readonly resolvedAgents: readonly ResolvedAgentConfig[];
  readonly migratedSkillNames: readonly string[];
  readonly force?: boolean;
};

/**
 * Walk every resolved agent's `skills:` list + the migrated skills
 * universe and return per-(agent, skill) verifications. Also emits a
 * `not-assigned` row for each migrated skill that no agent references
 * (informational — catches skills we migrated but forgot to wire).
 *
 * Invariants:
 *   - Input collections are NOT mutated.
 *   - Skills NOT in `migratedSkillNames` are silently ignored (agent
 *     may legitimately have other v1.x skills — this plan only cares
 *     about the v2.2 migration set).
 *   - Result order: agent-rows in iteration order, then not-assigned
 *     rows in migratedSkillNames order.
 */
export function verifySkillLinkages(
  opts: VerifySkillLinkagesOptions,
): readonly LinkVerification[] {
  const { catalog, resolvedAgents, migratedSkillNames, force } = opts;
  const migratedSet = new Set(migratedSkillNames);
  const results: LinkVerification[] = [];
  const assignedSkills = new Set<string>();

  for (const agent of resolvedAgents) {
    for (const skill of agent.skills) {
      if (!migratedSet.has(skill)) continue;
      assignedSkills.add(skill);
      const allowed = canLinkSkillToAgent(skill, agent.name, { force });
      if (!allowed) {
        const skillScope = SCOPE_TAGS.get(skill) ?? "fleet";
        const agentScope = scopeForAgent(agent.name);
        results.push({
          agent: agent.name,
          skill,
          status: "scope-refused",
          reason: `skill scope=${skillScope} vs agent scope=${agentScope}`,
        });
        continue;
      }
      if (!catalog.has(skill)) {
        results.push({
          agent: agent.name,
          skill,
          status: "missing-from-catalog",
          reason:
            "skill not in target ~/.clawcode/skills/ after migration — copy likely failed",
        });
        continue;
      }
      results.push({ agent: agent.name, skill, status: "linked" });
    }
  }

  for (const skill of migratedSkillNames) {
    if (assignedSkills.has(skill)) continue;
    results.push({
      agent: "(none)",
      skill,
      status: "not-assigned",
      reason: "skill migrated but no agent has it in their skills: list",
    });
  }

  return results;
}
