/**
 * P2 (WS-2d) — pinned 1Password MCP child resolution.
 */
import { describe, it, expect } from "vitest";
import { resolveBrokerChildSpawn } from "../pinned-child.js";

const PKG = JSON.stringify({ bin: { "1password-mcp": "dist/cli.js" } });

describe("resolveBrokerChildSpawn", () => {
  it("pinned install present → node + resolved bin entry", () => {
    const files = new Set([
      "/pin/package.json",
      "/pin/dist/cli.js",
    ]);
    const out = resolveBrokerChildSpawn({
      dir: "/pin",
      exists: (p) => files.has(p),
      readFile: () => PKG,
    });
    expect(out).toEqual({
      command: "node",
      args: ["/pin/dist/cli.js"],
      source: "pinned",
    });
  });

  it("string-form bin and main fallback both resolve", () => {
    const files = new Set(["/pin/package.json", "/pin/index.js"]);
    for (const pkg of [
      JSON.stringify({ bin: "index.js" }),
      JSON.stringify({ main: "index.js" }),
    ]) {
      const out = resolveBrokerChildSpawn({
        dir: "/pin",
        exists: (p) => files.has(p),
        readFile: () => pkg,
      });
      expect(out.source).toBe("pinned");
      expect(out.args).toEqual(["/pin/index.js"]);
    }
  });

  it("missing install / missing entry / bad json → npx fallback (fail-open)", () => {
    // No package.json at all.
    expect(
      resolveBrokerChildSpawn({ dir: "/pin", exists: () => false }).source,
    ).toBe("npx");
    // package.json exists but the bin target doesn't.
    expect(
      resolveBrokerChildSpawn({
        dir: "/pin",
        exists: (p) => p === "/pin/package.json",
        readFile: () => PKG,
      }).source,
    ).toBe("npx");
    // Unparseable package.json.
    const out = resolveBrokerChildSpawn({
      dir: "/pin",
      exists: () => true,
      readFile: () => "not-json{",
    });
    expect(out).toEqual({
      command: "npx",
      args: ["-y", "@takescake/1password-mcp@latest"],
      source: "npx",
    });
  });
});
