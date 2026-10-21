/**
 * Phase 999.171 — per-agent `uxFeatures` toggles: schema, resolution and
 * reload classification.
 *
 * liveThinking only gates rendering (the bridge re-reads the resolved config
 * per message), so it must be hot-reloadable. promptSuggestions and
 * researchSubagents are session-start options (999.172 / 999.173) and must
 * report "requires restart". The differ classification is the single gate
 * that decides whether ConfigReloader republishes the live config map, so
 * these tests assert it directly.
 */
import { describe, expect, it } from "vitest";

import { diffConfigs } from "../differ.js";
import { resolveAgentConfig } from "../loader.js";
import { agentSchema, defaultsSchema } from "../schema.js";
import type { Config } from "../schema.js";

function configWith(uxFeatures: Record<string, unknown> | undefined): Config {
  const agent = agentSchema.parse({
    name: "personal",
    ...(uxFeatures !== undefined ? { uxFeatures } : {}),
  });
  return {
    version: 1,
    defaults: defaultsSchema.parse({}),
    mcpServers: {},
    agents: [agent],
  } as unknown as Config;
}

describe("uxFeatures schema", () => {
  it("is absent when the agent omits the block", () => {
    const parsed = agentSchema.parse({ name: "a" });
    expect(parsed.uxFeatures).toBeUndefined();
  });

  it("keeps a declared liveThinking flag", () => {
    const parsed = agentSchema.parse({ name: "a", uxFeatures: { liveThinking: true } });
    expect(parsed.uxFeatures?.liveThinking).toBe(true);
  });

  it("rejects a non-boolean flag", () => {
    const result = agentSchema.safeParse({ name: "a", uxFeatures: { liveThinking: "yes" } });
    expect(result.success).toBe(false);
  });

  it("ignores (strips) an unknown key instead of failing the whole config load", () => {
    const result = agentSchema.safeParse({
      name: "a",
      uxFeatures: { liveThinking: true, liveThinkng: true },
    });
    expect(result.success).toBe(true);
    const ux = result.success ? result.data.uxFeatures : undefined;
    expect(ux).toBeDefined();
    expect("liveThinkng" in (ux as object)).toBe(false);
    expect(ux?.liveThinking).toBe(true);
  });
});

describe("uxFeatures resolution", () => {
  const defaults = defaultsSchema.parse({});

  it("resolves an omitted block to all flags false", () => {
    const resolved = resolveAgentConfig(agentSchema.parse({ name: "a" }), defaults);
    expect(resolved.uxFeatures).toEqual({
      liveThinking: false,
      statusPing: false,
      promptSuggestions: false,
      researchSubagents: false,
    });
  });

  it("resolves a partial block, filling the missing flags with false", () => {
    const resolved = resolveAgentConfig(
      agentSchema.parse({ name: "a", uxFeatures: { liveThinking: true } }),
      defaults,
    );
    expect(resolved.uxFeatures).toEqual({
      liveThinking: true,
      statusPing: false,
      promptSuggestions: false,
      researchSubagents: false,
    });
  });
});

describe("uxFeatures reload classification", () => {
  it("adding the whole block with liveThinking is hot-reloadable", () => {
    const diff = diffConfigs(configWith(undefined), configWith({ liveThinking: true }));
    const change = diff.changes.find((c) => c.fieldPath.includes("uxFeatures"));
    expect(change).toBeDefined();
    expect(change!.fieldPath).toBe("agents.personal.uxFeatures");
    expect(change!.reloadable).toBe(true);
    expect(diff.hasReloadableChanges).toBe(true);
  });

  it("editing liveThinking inside an existing block is hot-reloadable", () => {
    const diff = diffConfigs(
      configWith({ liveThinking: true }),
      configWith({ liveThinking: false }),
    );
    const change = diff.changes.find((c) => c.fieldPath.includes("uxFeatures"));
    expect(change?.fieldPath).toBe("agents.personal.uxFeatures.liveThinking");
    expect(change?.reloadable).toBe(true);
    expect(diff.hasReloadableChanges).toBe(true);
  });

  it("editing promptSuggestions alone requires a restart", () => {
    const diff = diffConfigs(
      configWith({ liveThinking: true, promptSuggestions: false }),
      configWith({ liveThinking: true, promptSuggestions: true }),
    );
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]!.reloadable).toBe(false);
    expect(diff.hasReloadableChanges).toBe(false);
  });

  it("editing researchSubagents alone requires a restart", () => {
    const diff = diffConfigs(
      configWith({ liveThinking: true }),
      configWith({ liveThinking: true, researchSubagents: true }),
    );
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]!.reloadable).toBe(false);
    expect(diff.hasReloadableChanges).toBe(false);
  });
});

describe("999.172 — whole-block add/remove carrying a session-start key", () => {
  it("adding the block with promptSuggestions on requires a restart", () => {
    const diff = diffConfigs(configWith(undefined), configWith({ promptSuggestions: true }));
    const change = diff.changes.find((c) => c.fieldPath.includes("uxFeatures"));
    expect(change?.fieldPath).toBe("agents.personal.uxFeatures");
    expect(change?.reloadable).toBe(false);
    expect(diff.hasNonReloadableChanges).toBe(true);
  });

  it("removing a block that had promptSuggestions on requires a restart", () => {
    const diff = diffConfigs(configWith({ liveThinking: true, promptSuggestions: true }), configWith(undefined));
    const change = diff.changes.find((c) => c.fieldPath.includes("uxFeatures"));
    expect(change?.reloadable).toBe(false);
  });

  it("adding the block with liveThinking only (session-start keys defaulted false) stays hot", () => {
    const diff = diffConfigs(configWith(undefined), configWith({ liveThinking: true, promptSuggestions: false }));
    const change = diff.changes.find((c) => c.fieldPath.includes("uxFeatures"));
    expect(change?.reloadable).toBe(true);
  });
});
