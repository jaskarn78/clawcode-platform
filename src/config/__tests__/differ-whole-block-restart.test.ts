/**
 * Phase 999.172 (PR #190 review) — `wholeBlockCarriesRestartKey` is NOT scoped
 * to uxFeatures. Any block added or removed WHOLE (it diffs as one leaf at the
 * block path) that SETS a nested key whose own path is restart-required is now
 * classified restart-required. Stricter only: before, the coarse RELOADABLE
 * prefix made these report "hot-reloaded" while the running daemon kept the
 * boot-time value. Pinned here with the uxFeatures block, plus its hot
 * controls (a whole block with no restart key set stays hot).
 */
import { describe, expect, it } from "vitest";
import { diffConfigs } from "../differ.js";
import type { Config } from "../schema.js";

function cfg(defaults: Record<string, unknown>, agent: Record<string, unknown> = {}): Config {
  return { version: 1, defaults, mcpServers: {}, agents: [{ name: "personal", ...agent }] } as unknown as Config;
}

function change(diff: ReturnType<typeof diffConfigs>, path: string) {
  const c = diff.changes.find((x) => x.fieldPath === path);
  expect(c, `no change at ${path}: ${diff.changes.map((x) => x.fieldPath).join(", ")}`).toBeDefined();
  return c!;
}

describe("whole-block add/remove carrying a restart-required key", () => {
  it("agents.*.uxFeatures added whole with promptSuggestions set → restart-required (was hot)", () => {
    const diff = diffConfigs(cfg({}), cfg({}, { uxFeatures: { promptSuggestions: true } }));
    expect(change(diff, "agents.personal.uxFeatures").reloadable).toBe(false);
  });

  it("agents.*.uxFeatures removed whole while it set researchSubagents → restart-required", () => {
    const diff = diffConfigs(cfg({}, { uxFeatures: { researchSubagents: true } }), cfg({}));
    expect(change(diff, "agents.personal.uxFeatures").reloadable).toBe(false);
  });

  it("control: agents.*.uxFeatures added whole with only a reloadable knob stays hot", () => {
    const diff = diffConfigs(cfg({}), cfg({}, { uxFeatures: { liveThinking: true } }));
    expect(change(diff, "agents.personal.uxFeatures").reloadable).toBe(true);
  });

  it("an edit INSIDE an existing block is unchanged (leaf paths classify as before)", () => {
    const diff = diffConfigs(
      cfg({}, { uxFeatures: { liveThinking: false } }),
      cfg({}, { uxFeatures: { liveThinking: true } }),
    );
    expect(change(diff, "agents.personal.uxFeatures.liveThinking").reloadable).toBe(true);
  });
});
