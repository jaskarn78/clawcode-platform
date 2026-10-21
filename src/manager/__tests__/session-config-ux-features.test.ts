/**
 * Phase 999.171 — buildSessionConfig threading of the per-agent `uxFeatures`
 * toggles (for the session-start consumers in 999.172 / 999.173).
 *
 * Byte-stability pins: with every flag off (the whole fleet today), the
 * AgentSessionConfig carries NO `uxFeatures` key, on both the main return
 * and the bootstrap-needed path.
 */
import { describe, it, expect } from "vitest";
import { buildSessionConfig, type SessionConfigDeps } from "../session-config.js";
import { resolveAgentConfig } from "../../config/loader.js";
import { defaultsSchema, agentSchema } from "../../config/schema.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

function makeResolved(agentOverrides: Record<string, unknown> = {}): ResolvedAgentConfig {
  return resolveAgentConfig(
    agentSchema.parse({ name: "personal", channels: [], ...agentOverrides }),
    defaultsSchema.parse({}),
  );
}

function makeDeps(overrides: Partial<SessionConfigDeps> = {}): SessionConfigDeps {
  return {
    tierManagers: new Map(),
    skillsCatalog: new Map(),
    allAgentConfigs: [],
    ...overrides,
  };
}

const LIVE_THINKING_ON = { liveThinking: true, statusPing: false, promptSuggestions: false, researchSubagents: false };

describe("999.171 — buildSessionConfig uxFeatures threading", () => {
  it("no uxFeatures block → no uxFeatures key on the session config (byte-stability pin)", async () => {
    const cfg = await buildSessionConfig(makeResolved(), makeDeps());
    expect("uxFeatures" in cfg).toBe(false);
  });

  it("an explicit all-false block still omits the key", async () => {
    const cfg = await buildSessionConfig(
      makeResolved({ uxFeatures: { liveThinking: false, promptSuggestions: false } }),
      makeDeps(),
    );
    expect("uxFeatures" in cfg).toBe(false);
  });

  it("liveThinking on → uxFeatures rides with all three booleans", async () => {
    const cfg = await buildSessionConfig(
      makeResolved({ uxFeatures: { liveThinking: true } }),
      makeDeps(),
    );
    expect(cfg.uxFeatures).toEqual(LIVE_THINKING_ON);
  });

  it("bootstrap-needed path matches the main path (Rule 3 symmetric edit)", async () => {
    const off = await buildSessionConfig(makeResolved(), makeDeps(), undefined, "needed");
    expect("uxFeatures" in off).toBe(false);

    const on = await buildSessionConfig(
      makeResolved({ uxFeatures: { liveThinking: true } }),
      makeDeps(),
      undefined,
      "needed",
    );
    expect(on.uxFeatures).toEqual(LIVE_THINKING_ON);
  });
});

// ---------------------------------------------------------------------------
// Phase 999.172 — promptSuggestions is a session-start option, so the
// /clawcode-ux override is resolved when the session is built (both paths),
// and machine-generated sessions never get it.
// ---------------------------------------------------------------------------
import { afterEach } from "vitest";
import { resetUxFeatureOverridesForTests, setUxFeatureOverride } from "../ux-feature-state-store.js";
import { sessionUxFeatures } from "../session-config.js";

describe("999.172 — promptSuggestions resolved at session start", () => {
  afterEach(() => resetUxFeatureOverridesForTests());

  it("config on → rides on the session config", async () => {
    const cfg = await buildSessionConfig(makeResolved({ uxFeatures: { promptSuggestions: true } }), makeDeps());
    expect(cfg.uxFeatures?.promptSuggestions).toBe(true);
  });

  it("an override ON with no config block → on (both paths)", async () => {
    setUxFeatureOverride("personal", { promptSuggestions: true });
    const main = await buildSessionConfig(makeResolved(), makeDeps());
    expect(main.uxFeatures).toEqual({ liveThinking: false, statusPing: false, promptSuggestions: true, researchSubagents: false });
    const boot = await buildSessionConfig(makeResolved(), makeDeps(), undefined, "needed");
    expect(boot.uxFeatures).toEqual(main.uxFeatures);
  });

  it("an override OFF beats config on", async () => {
    setUxFeatureOverride("personal", { promptSuggestions: false });
    const cfg = await buildSessionConfig(makeResolved({ uxFeatures: { promptSuggestions: true } }), makeDeps());
    expect("uxFeatures" in cfg).toBe(false);
  });

  it("thread / subagent / pool / fork sessions never get suggestions, even with the parent's config", () => {
    for (const name of ["personal-sub-AbC123", "personal-thread-xyz", "personal-pool-AbC123", "personal-fork-AbC123"]) {
      const ux = sessionUxFeatures({
        name,
        uxFeatures: { liveThinking: true, statusPing: false, promptSuggestions: true, researchSubagents: false },
      });
      expect(ux?.promptSuggestions).toBe(false);
      expect(ux?.liveThinking).toBe(true);
    }
  });

  it("the rest of the fleet stays byte-stable (no block, no override → no key)", async () => {
    const cfg = await buildSessionConfig(makeResolved(), makeDeps());
    expect("uxFeatures" in cfg).toBe(false);
  });
});
