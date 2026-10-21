/**
 * dashboard-rework — readPluginMarketplaces() assembles the verified-flagged
 * native plugin catalog from the on-disk ~/.claude/plugins state. Tested against
 * a temp fixture home (no real home dir touched).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPluginMarketplaces } from "../plugin-marketplace.js";

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "clawcode-pm-"));
  const base = join(home, ".claude", "plugins");
  mkdirSync(base, { recursive: true });

  writeFileSync(
    join(base, "known_marketplaces.json"),
    JSON.stringify({
      "claude-plugins-official": { source: { source: "github", repo: "anthropics/claude-plugins-official" } },
      "community-x": { source: { source: "github", repo: "someorg/community-x" } },
    }),
  );

  const officialDir = join(base, "marketplaces", "claude-plugins-official", ".claude-plugin");
  mkdirSync(officialDir, { recursive: true });
  writeFileSync(
    join(officialDir, "marketplace.json"),
    JSON.stringify({
      owner: { name: "Anthropic", email: "support@anthropic.com" },
      plugins: [
        { name: "agent-sdk-dev", description: "SDK kit", author: { name: "Anthropic" }, category: "development" },
        { name: "adobe-for-creativity", description: "Adobe tools", author: { name: "Adobe" }, category: "design" },
      ],
    }),
  );

  const communityDir = join(base, "marketplaces", "community-x", ".claude-plugin");
  mkdirSync(communityDir, { recursive: true });
  writeFileSync(
    join(communityDir, "marketplace.json"),
    JSON.stringify({
      owner: { name: "Some Org" },
      plugins: [{ name: "cool-thing", description: "neat", author: "someone", category: "misc" }],
    }),
  );

  writeFileSync(
    join(base, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "agent-sdk-dev@claude-plugins-official": [{ scope: "user" }] } }),
  );
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("readPluginMarketplaces", () => {
  it("flags the Anthropic-owned marketplace verified and the community one not", () => {
    const { marketplaces } = readPluginMarketplaces(home);
    const official = marketplaces.find((m) => m.name === "claude-plugins-official");
    const community = marketplaces.find((m) => m.name === "community-x");
    expect(official?.verified).toBe(true);
    expect(community?.verified).toBe(false);
    expect(official?.pluginCount).toBe(2);
    // verified marketplace sorts first
    expect(marketplaces[0]!.name).toBe("claude-plugins-official");
  });

  it("marks installed + first-party plugins and sorts verified/first-party first", () => {
    const { plugins } = readPluginMarketplaces(home);
    const sdk = plugins.find((p) => p.name === "agent-sdk-dev");
    const adobe = plugins.find((p) => p.name === "adobe-for-creativity");
    const community = plugins.find((p) => p.name === "cool-thing");

    expect(sdk).toMatchObject({
      ref: "agent-sdk-dev@claude-plugins-official",
      verified: true,
      firstParty: true,
      installed: true,
    });
    expect(adobe).toMatchObject({ verified: true, firstParty: false, installed: false });
    expect(community).toMatchObject({ verified: false, firstParty: false });
    // verified + first-party (agent-sdk-dev) is first; community last
    expect(plugins[0]!.name).toBe("agent-sdk-dev");
    expect(plugins[plugins.length - 1]!.name).toBe("cool-thing");
  });

  it("returns empty (no throw) when the plugins dir is absent", () => {
    const res = readPluginMarketplaces(join(home, "does-not-exist"));
    expect(res.marketplaces).toEqual([]);
    expect(res.plugins).toEqual([]);
  });
});
