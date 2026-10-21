/**
 * P2 (memory program) — clawcode-mcp sidecar runtime dial.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveClawcodeMcpSpawn } from "../loader.js";
import { defaultsSchema } from "../schema.js";

describe("defaults.sidecarRuntime schema", () => {
  it("defaults to bundled; accepts slim; rejects unknown", () => {
    expect(defaultsSchema.parse({}).sidecarRuntime).toBeUndefined();
    expect(
      defaultsSchema.parse({ sidecarRuntime: {} }).sidecarRuntime,
    ).toEqual({ clawcodeMcp: "bundled" });
    expect(
      defaultsSchema.parse({ sidecarRuntime: { clawcodeMcp: "slim" } })
        .sidecarRuntime,
    ).toEqual({ clawcodeMcp: "slim" });
    expect(() =>
      defaultsSchema.parse({ sidecarRuntime: { clawcodeMcp: "tiny" } }),
    ).toThrow();
  });
});

describe("resolveBrokerShimCommand — P5 Stage 0c", () => {
  it("static → Go binary --type 1password; node → classic CLI rollback", async () => {
    const { resolveBrokerShimCommand } = await import("../loader.js");
    expect(resolveBrokerShimCommand("static")).toEqual({
      command: "/opt/clawcode/bin/clawcode-mcp-shim",
      args: ["--type", "1password"],
    });
    expect(resolveBrokerShimCommand("node")).toEqual({
      command: "clawcode",
      args: ["mcp-broker-shim", "--pool", "1password"],
    });
  });

  it("schema: defaults.shimRuntime.broker defaults to static; per-agent stays optional", async () => {
    const { defaultsSchema, agentSchema } = await import("../schema.js");
    expect(
      defaultsSchema.parse({ shimRuntime: {} }).shimRuntime?.broker,
    ).toBe("static");
    expect(
      agentSchema.parse({ name: "x", shimRuntime: {} }).shimRuntime?.broker,
    ).toBeUndefined();
  });
});

describe("resolveClawcodeMcpSpawn", () => {
  it("bundled → classic `clawcode mcp` spawn", () => {
    expect(resolveClawcodeMcpSpawn("bundled")).toEqual({
      command: "clawcode",
      args: ["mcp"],
    });
  });

  it("slim with the built entry present → node + standalone path", () => {
    const out = resolveClawcodeMcpSpawn("slim", {
      standalonePath: "/opt/clawcode/dist/channels/clawcode-mcp-standalone.js",
      exists: () => true,
    });
    expect(out).toEqual({
      command: "node",
      args: ["/opt/clawcode/dist/channels/clawcode-mcp-standalone.js"],
    });
  });

  it("slim with the entry MISSING → bundled fallback + p2-sidecar-resolver warn (fail-open)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = resolveClawcodeMcpSpawn("slim", {
        standalonePath: "/nope/clawcode-mcp-standalone.js",
        exists: () => false,
      });
      expect(out).toEqual({ command: "clawcode", args: ["mcp"] });
      const hits = warnSpy.mock.calls.filter(
        (c) => c[0] === "p2-sidecar-resolver",
      );
      expect(hits.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
