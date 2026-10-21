/**
 * Phase 999.173 — buildSessionConfig decides research subagents at session
 * build, on both the main and bootstrap-needed returns (Rule 3), and omits the
 * field for everyone else (byte-stability).
 */
import { afterEach, describe, it, expect } from "vitest";
import { buildSessionConfig, type SessionConfigDeps } from "../session-config.js";
import { resolveAgentConfig } from "../../config/loader.js";
import { defaultsSchema, agentSchema } from "../../config/schema.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import {
  resetUxFeatureOverridesForTests,
  setUxFeatureOverride,
} from "../ux-feature-state-store.js";

function makeResolved(
  agentOverrides: Record<string, unknown> = {},
  attributed = true,
): ResolvedAgentConfig {
  return resolveAgentConfig(
    agentSchema.parse({ name: "personal", channels: [], ...agentOverrides }),
    defaultsSchema.parse(attributed ? { delivery: { attributedStream: true } } : {}),
  );
}

function makeDeps(): SessionConfigDeps {
  return { tierManagers: new Map(), skillsCatalog: new Map(), allAgentConfigs: [] };
}

afterEach(() => resetUxFeatureOverridesForTests());

describe("999.173 — buildSessionConfig research subagents", () => {
  it("off by default → no researchSubagents key (byte-stability pin)", async () => {
    const cfg = await buildSessionConfig(makeResolved(), makeDeps());
    expect("researchSubagents" in cfg).toBe(false);
  });

  it("toggle on + attributed stream → settings with defaults", async () => {
    const cfg = await buildSessionConfig(makeResolved({ uxFeatures: { researchSubagents: true } }), makeDeps());
    expect(cfg.researchSubagents).toEqual({
      model: "opus",
      parentModelFamily: "haiku",
      effort: "medium",
      maxTurns: 25,
      maxConcurrent: 4,
      holdTimeoutMs: 20 * 60_000,
      deniedTools: [],
      allowBash: false,
      usageGuard: { reduceAt: 0.7, blockAt: 0.85 },
      budgets: { maxToolCalls: 60, maxSessionToolCalls: 180, maxMinutes: 15 },
      autoRoute: false,
    });
  });

  it("toggle on WITHOUT the attributed stream → off", async () => {
    const cfg = await buildSessionConfig(makeResolved({ uxFeatures: { researchSubagents: true } }, false), makeDeps());
    expect("researchSubagents" in cfg).toBe(false);
  });

  it("the /clawcode-ux override is resolved at session build", async () => {
    setUxFeatureOverride("personal", { researchSubagents: true });
    const cfg = await buildSessionConfig(makeResolved(), makeDeps());
    expect(cfg.researchSubagents).toBeDefined();
  });

  it("yaml knobs flow through", async () => {
    const cfg = await buildSessionConfig(
      makeResolved({ uxFeatures: { researchSubagents: true }, research: { model: "haiku", maxConcurrent: 2 } }),
      makeDeps(),
    );
    expect(cfg.researchSubagents).toMatchObject({ model: "haiku", maxConcurrent: 2 });
  });

  it("bootstrap-needed path matches the main path (Rule 3)", async () => {
    const off = await buildSessionConfig(makeResolved(), makeDeps(), undefined, "needed");
    expect("researchSubagents" in off).toBe(false);
    const on = await buildSessionConfig(
      makeResolved({ uxFeatures: { researchSubagents: true } }),
      makeDeps(),
      undefined,
      "needed",
    );
    expect(on.researchSubagents).toBeDefined();
  });
});
