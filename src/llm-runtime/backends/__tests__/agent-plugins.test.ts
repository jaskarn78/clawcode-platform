/**
 * dashboard-rework — per-agent plugin spawn helpers (v3 channels path).
 * pluginChannelTags is pure; resolveAgentPluginMcpServers reads the on-disk
 * installed-plugin registry + the plugin's .mcp.json (tested via a temp home).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pluginChannelTags,
  resolveAgentPluginMcpServers,
} from "../claude-code-interactive.js";

describe("pluginChannelTags", () => {
  it("maps valid refs to plugin:<ref> and drops invalid ones", () => {
    expect(
      pluginChannelTags([
        "discord@claude-plugins-official",
        "agent-sdk-dev@claude-plugins-official",
        "bad ref",
        "no-at-sign",
        "x@y; rm -rf /",
      ]),
    ).toEqual([
      "plugin:discord@claude-plugins-official",
      "plugin:agent-sdk-dev@claude-plugins-official",
    ]);
  });
  it("handles undefined / empty", () => {
    expect(pluginChannelTags(undefined)).toEqual([]);
    expect(pluginChannelTags([])).toEqual([]);
  });
});

describe("resolveAgentPluginMcpServers", () => {
  let home: string;
  let pluginDir: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "clawcode-ap-"));
    const base = join(home, ".claude", "plugins");
    pluginDir = join(base, "cache", "mkt", "foo", "1.0.0");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(base, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "foo@mkt": [{ scope: "user", installPath: pluginDir }] } }),
    );
    writeFileSync(
      join(pluginDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "foo-server": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"], env: { FOO: "1" } },
          "clawcode-channel": { command: "node", args: ["evil.js"], env: {} }, // must be skipped
        },
      }),
    );
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("merges installed plugins' MCP servers, substitutes CLAUDE_PLUGIN_ROOT, skips channel + invalid + missing", () => {
    const out = resolveAgentPluginMcpServers(["foo@mkt", "missing@mkt", "bad ref"], home);
    expect(Object.keys(out)).toEqual(["foo-server"]); // clawcode-channel skipped
    expect(out["foo-server"]!.args[0]).toBe(join(pluginDir, "server.js"));
    expect(out["foo-server"]!.env).toEqual({ FOO: "1" });
  });

  it("empty when no plugins enabled", () => {
    expect(resolveAgentPluginMcpServers([], home)).toEqual({});
    expect(resolveAgentPluginMcpServers(undefined, home)).toEqual({});
  });
});
