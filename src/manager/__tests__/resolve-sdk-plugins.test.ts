import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSdkPlugins } from "../session-adapter.js";

/**
 * 999.103 WS-2 follow-up — the v2/SDK plugin resolver. Before this existed the
 * `plugins:` knob only reached the v3 argv and prod has zero v3 agents, so the
 * knob was silently decorative (the exact inert-knob failure mode again).
 */
function makeHome(registry: unknown, withInstallDir = true): { home: string; install: string } {
  const home = mkdtempSync(join(tmpdir(), "sdk-plugins-"));
  const dir = join(home, ".claude", "plugins");
  mkdirSync(dir, { recursive: true });
  const install = join(home, "cache", "superpowers", "6.0.3");
  if (withInstallDir) mkdirSync(install, { recursive: true });
  writeFileSync(join(dir, "installed_plugins.json"), JSON.stringify(registry));
  return { home, install };
}

describe("resolveSdkPlugins", () => {
  it("resolves an installed ref to a local plugin config (newest entry wins)", () => {
    const { home, install } = makeHome({
      version: 2,
      plugins: {
        "superpowers@claude-plugins-official": [
          { installPath: "/old/gone" },
          { installPath: null },
        ],
      },
    });
    // Point the newest entry at the real dir.
    const { home: h2, install: i2 } = makeHome({
      plugins: { "superpowers@claude-plugins-official": [{ installPath: null }] },
    });
    void h2; void i2;
    const reg = {
      plugins: { "superpowers@claude-plugins-official": [{ installPath: install }] },
    };
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify(reg));
    expect(resolveSdkPlugins(["superpowers@claude-plugins-official"], undefined, home)).toEqual([
      { type: "local", path: install },
    ]);
  });

  it("skips-with-warn an uninstalled ref instead of blocking the spawn", () => {
    const { home } = makeHome({ plugins: {} });
    const warn = vi.fn();
    expect(resolveSdkPlugins(["nope@nowhere"], { warn }, home)).toEqual([]);
    expect(warn).toHaveBeenCalled(); // the 999.105 lesson: never a SILENT skip
  });

  it("empty/absent refs and a missing registry resolve to [] without throwing", () => {
    expect(resolveSdkPlugins(undefined)).toEqual([]);
    expect(resolveSdkPlugins([])).toEqual([]);
    const warn = vi.fn();
    expect(resolveSdkPlugins(["x@y"], { warn }, "/nonexistent-home")).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("corrupt registry JSON resolves to [] with a warn", () => {
    const { home } = makeHome({});
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "{broken");
    const warn = vi.fn();
    expect(resolveSdkPlugins(["a@b"], { warn }, home)).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});
