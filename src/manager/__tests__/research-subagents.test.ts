import { afterEach, describe, expect, it } from "vitest";
import {
  RESEARCH_DEFAULTS,
  RESEARCHER_AGENT_TYPE,
  buildResearchSdkOptions,
  resolveResearchSession,
} from "../research-subagents.js";
import {
  resetUxFeatureOverridesForTests,
  setUxFeatureOverride,
} from "../ux-feature-state-store.js";

const base = {
  name: "personal",
  uxFeatures: { researchSubagents: true },
  deliveryAttributedStream: true,
};

afterEach(() => resetUxFeatureOverridesForTests());

describe("resolveResearchSession (999.173)", () => {
  it("on with defaults when the toggle and attributed stream are on", () => {
    const r = resolveResearchSession(base);
    expect(RESEARCH_DEFAULTS.model).toBe("opus");
    expect(r).toEqual({
      model: "opus",
      effort: RESEARCH_DEFAULTS.effort,
      maxTurns: RESEARCH_DEFAULTS.maxTurns,
      maxConcurrent: 4,
      holdTimeoutMs: 20 * 60_000,
      deniedTools: [],
      allowBash: false,
      usageGuard: { reduceAt: 0.7, blockAt: 0.85 },
      budgets: { maxToolCalls: 60, maxSessionToolCalls: 180, maxMinutes: 15 },
      autoRoute: false,
    });
  });

  it("off without the attributed stream (no demux, no card, no sink)", () => {
    expect(resolveResearchSession({ ...base, deliveryAttributedStream: false })).toBeUndefined();
  });

  it("off for thread / sub / pool / fork worker sessions", () => {
    for (const name of ["personal-sub-abc123", "personal-via-x-abc123", "personal-pool-abc123", "personal-fork-abc123"]) {
      expect(resolveResearchSession({ ...base, name })).toBeUndefined();
    }
  });

  it("the /clawcode-ux override wins over yaml, both directions", () => {
    setUxFeatureOverride("personal", { researchSubagents: false });
    expect(resolveResearchSession(base)).toBeUndefined();
    setUxFeatureOverride("personal", { researchSubagents: true });
    expect(resolveResearchSession({ ...base, uxFeatures: { researchSubagents: false } })).toBeDefined();
  });

  it("applies yaml knobs and never lets maxConcurrent exceed 4", () => {
    const r = resolveResearchSession({
      ...base,
      research: { model: "haiku", effort: "low", maxTurns: 10, maxConcurrent: 2, holdTimeoutMinutes: 5 },
    });
    expect(r).toEqual({
      model: "haiku",
      configModel: "haiku",
      effort: "low",
      maxTurns: 10,
      maxConcurrent: 2,
      holdTimeoutMs: 300_000,
      deniedTools: [],
      allowBash: false,
      usageGuard: { reduceAt: 0.7, blockAt: 0.85 },
      budgets: { maxToolCalls: 60, maxSessionToolCalls: 180, maxMinutes: 15 },
      autoRoute: false,
    });
  });

  it("carries the tool knobs: explicit tools, extra denials, allowBash", () => {
    const r = resolveResearchSession({
      ...base,
      research: { tools: ["Read", "mcp__finnhub__quote"], deniedTools: ["mcp__brave"], allowBash: true },
    });
    expect(r).toMatchObject({ tools: ["Read", "mcp__finnhub__quote"], deniedTools: ["mcp__brave"], allowBash: true });
  });
});

describe("buildResearchSdkOptions (999.173)", () => {
  it("{} when research is off (byte-identical options for the fleet)", () => {
    expect(buildResearchSdkOptions(undefined)).toEqual({});
  });

  it("carries the researcher definition + progress summaries + per-task stop", () => {
    const opts = buildResearchSdkOptions(resolveResearchSession(base));
    expect(opts.agentProgressSummaries).toBe(true);
    expect(opts.perTaskStopAffordance).toBe(true);
    const def = opts.agents![RESEARCHER_AGENT_TYPE]!;
    expect(def.background).toBe(true);
    expect(def.model).toBe("opus");
    expect(def.effort).toBe("medium");
    // Inherit the agent's tools (SDK native: `tools` omitted) ...
    expect("tools" in def).toBe(false);
    // ... minus everything with side effects.
    for (const denied of [
      "Agent", "Task", "Workflow", "Write", "Edit", "NotebookEdit", "Bash",
      "mcp__1password",
      "mcp__clawcode__start_workflow", "mcp__clawcode__spawn_subagent_thread", "mcp__clawcode__post_to_agent",
      "mcp__clawcode__send_message", "mcp__clawcode__ask_agent", "mcp__clawcode__schedule_reminder",
      "mcp__clawcode__cancel_schedule", "mcp__clawcode__clawcode_share_file", "mcp__clawcode__send_attachment",
      "mcp__clawcode__post_cv2_embed",
    ]) {
      expect(def.disallowedTools).toContain(denied);
    }
    for (const kept of ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "mcp__clawcode__memory_lookup", "mcp__clawcode__read_thread"]) {
      expect(def.disallowedTools).not.toContain(kept);
    }
    expect(def.description).toMatch(/deep dive/i);
    expect(def.description).toMatch(/2-4 in parallel/);
  });

  it("allowBash keeps Bash; an explicit tools list is passed through; deniedTools are appended", () => {
    const def = buildResearchSdkOptions(
      resolveResearchSession({
        ...base,
        research: { allowBash: true, tools: ["Read", "mcp__finnhub__quote"], deniedTools: ["mcp__playwright__browser_evaluate"] },
      }),
    ).agents![RESEARCHER_AGENT_TYPE]!;
    expect(def.disallowedTools).not.toContain("Bash");
    expect(def.tools).toEqual(["Read", "mcp__finnhub__quote"]);
    expect(def.disallowedTools).toContain("mcp__playwright__browser_evaluate");
    // Deny still wins over an explicit list.
    expect(def.disallowedTools).toContain("Write");
  });
});

describe("research.autoRoute (research-route.ts)", () => {
  it("carries research.autoRoute into the session config, default false", () => {
    const base = { name: "fin-client", uxFeatures: { researchSubagents: true }, deliveryAttributedStream: true } as const;
    expect(resolveResearchSession(base)?.autoRoute).toBe(false);
    expect(resolveResearchSession({ ...base, research: { autoRoute: true } })?.autoRoute).toBe(true);
  });
});
