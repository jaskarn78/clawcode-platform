/**
 * Phase 84 Plan 02 Task 2 — skills-linker-verifier unit tests.
 *
 * Pure-function tests against synthetic catalog + resolvedAgent fixtures.
 * No fs I/O. Locks the per-agent dry-run resolution status matrix:
 *   - linked                 — skill migrated AND in target catalog AND scope allows
 *   - missing-from-catalog   — skill in agent.skills list AND migrated AND scope allows but catalog lacks it
 *   - scope-refused          — skill migrated AND in catalog BUT scope mismatch
 *   - not-assigned           — skill migrated but no agent has it in their skills list
 */
import { describe, it, expect } from "vitest";
import type { SkillEntry, SkillsCatalog } from "../../skills/types.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import { verifySkillLinkages } from "../skills-linker-verifier.js";

function entry(
  name: string,
  path = `/home/x/.clawcode/skills/${name}`,
): SkillEntry {
  return {
    name,
    description: `desc for ${name}`,
    version: null,
    path,
  };
}

function makeCatalog(entries: readonly SkillEntry[]): SkillsCatalog {
  const m = new Map<string, SkillEntry>();
  for (const e of entries) m.set(e.name, e);
  return m;
}

// Helper — build a minimal ResolvedAgentConfig stub. Only the fields
// used by verifySkillLinkages matter (name + skills); rest can be any.
function agent(
  name: string,
  skills: readonly string[],
): ResolvedAgentConfig {
  return {
    name,
    workspace: `/home/x/.clawcode/agents/${name}`,
    memoryPath: `/home/x/.clawcode/agents/${name}/memory`,
    channels: [],
    model: "sonnet",
    effort: "medium",
    skills,
    soul: undefined,
    identity: undefined,
    memory: {
      compactionThreshold: 0.8,
      searchTopK: 10,
      consolidation: {
        enabled: true,
        weeklyThreshold: 0,
        monthlyThreshold: 0,
        schedule: "0 0 * * *",
      },
      decay: { halfLifeDays: 30, semanticWeight: 0.5, decayWeight: 0.5 },
      deduplication: { enabled: true, similarityThreshold: 0.85 },
    },
    // Most downstream fields are either optional or not touched by
    // verifySkillLinkages. Cast for test brevity.
  } as unknown as ResolvedAgentConfig;
}

describe("skills-linker-verifier — verifySkillLinkages", () => {
  it("(a) linked — fleet skill in catalog + assigned", () => {
    const catalog = makeCatalog([entry("frontend-design")]);
    const agents = [agent("general", ["frontend-design"])];
    const results = verifySkillLinkages({
      catalog,
      resolvedAgents: agents,
      migratedSkillNames: ["frontend-design"],
    });
    const gen = results.find((r) => r.agent === "general");
    expect(gen?.status).toBe("linked");
    expect(gen?.skill).toBe("frontend-design");
  });

  it("(b) missing-from-catalog — agent assigns a migrated skill but catalog lacks it", () => {
    // Scenario: apply tried to migrate a skill, wrote a 'migrated' name
    // into migratedSkillNames, but the target copy failed to materialize
    // (transient fs error / incomplete cleanup). Verifier catches it.
    const catalog = makeCatalog([]); // empty target catalog
    const agents = [agent("general", ["frontend-design"])];
    const results = verifySkillLinkages({
      catalog,
      resolvedAgents: agents,
      migratedSkillNames: ["frontend-design"],
    });
    const gen = results.find((r) => r.agent === "general");
    expect(gen?.status).toBe("missing-from-catalog");
  });

  it("(c) scope-refused — acme skill assigned to non-fin agent without force", () => {
    const catalog = makeCatalog([entry("acme-crm")]);
    const agents = [agent("clawdy", ["acme-crm"])];
    const results = verifySkillLinkages({
      catalog,
      resolvedAgents: agents,
      migratedSkillNames: ["acme-crm"],
    });
    const clawdy = results.find((r) => r.agent === "clawdy");
    expect(clawdy?.status).toBe("scope-refused");
    expect(clawdy?.reason).toMatch(/acme/);
  });

  it("(d) scope-refused overridden by force — same scenario + force:true → linked", () => {
    const catalog = makeCatalog([entry("acme-crm")]);
    const agents = [agent("clawdy", ["acme-crm"])];
    const results = verifySkillLinkages({
      catalog,
      resolvedAgents: agents,
      migratedSkillNames: ["acme-crm"],
      force: true,
    });
    const clawdy = results.find((r) => r.agent === "clawdy");
    expect(clawdy?.status).toBe("linked");
  });

  it("(e) not-assigned — skill migrated but no agent has it in their list", () => {
    const catalog = makeCatalog([entry("tuya-ac")]);
    const agents = [agent("general", ["frontend-design"])];
    const results = verifySkillLinkages({
      catalog,
      resolvedAgents: agents,
      migratedSkillNames: ["tuya-ac", "frontend-design"],
    });
    const orphan = results.find((r) => r.skill === "tuya-ac");
    expect(orphan?.status).toBe("not-assigned");
    expect(orphan?.agent).toBe("(none)");
  });

  it("(f) agent.skills entries that are NOT in migratedSkillNames are ignored (not this plan's concern)", () => {
    const catalog = makeCatalog([entry("frontend-design")]);
    // Agent also assigns 'subagent-thread' which isn't in the v2.2 migration
    // set; verifier must not error on it.
    const agents = [agent("general", ["frontend-design", "subagent-thread"])];
    const results = verifySkillLinkages({
      catalog,
      resolvedAgents: agents,
      migratedSkillNames: ["frontend-design"],
    });
    // Only frontend-design produces a per-agent row. subagent-thread is out of scope.
    const rows = results.filter((r) => r.agent === "general");
    expect(rows.length).toBe(1);
    expect(rows[0]!.skill).toBe("frontend-design");
  });
});
