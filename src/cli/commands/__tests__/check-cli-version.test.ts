import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheckCliVersion } from "../check-cli-version.js";
import type { FleetBinaryProbe } from "../../../shared/claude-binary.js";

const floors = async () => [
  { model: "opus", minCliVersion: "2.1.280", source: 'agent "personal".model', inUse: true },
];

const bundled: FleetBinaryProbe = {
  pin: "/opt/clawcode/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
  source: "sdk-bundled",
  platformPackage: "@anthropic-ai/claude-agent-sdk-linux-x64",
  sha256: "a".repeat(64),
  version: "2.1.282 (Claude Code)",
  sdkVersion: "0.3.282",
  sdkClaudeCodeVersion: "2.1.282",
  error: null,
};

const logs: string[] = [];
vi.mock("../../output.js", () => ({
  cliLog: (m: string) => logs.push(m),
  cliError: (m: string) => logs.push(m),
}));

afterEach(() => {
  logs.length = 0;
});

describe("check-cli-version (999.169)", () => {
  it("passes when the SDK-bundled binary is in lockstep and above every floor", async () => {
    expect(await runCheckCliVersion({ json: true }, { loadRequirements: floors, probeFleet: () => bundled })).toBe(0);
    const json = JSON.parse(logs[0]!);
    expect(json).toMatchObject({ binarySource: "sdk-bundled", sdk: { version: "0.3.282", claudeCodeVersion: "2.1.282" } });
    expect(json.lockstep.kind).toBe("ok");
    expect(json).toHaveProperty("highestRequired", "2.1.280");
  });

  it("BLOCKS when the binary drifted from its SDK (the daemon would refuse to boot)", async () => {
    const drifted = { ...bundled, version: "2.1.280 (Claude Code)" };
    expect(await runCheckCliVersion({}, { loadRequirements: floors, probeFleet: () => drifted })).toBe(1);
    expect(logs.join("\n")).toMatch(/BLOCKED/);
  });

  it("BLOCKS when there is no binary to spawn, even with no declared floors", async () => {
    const missing = { ...bundled, pin: null, source: null, version: null, error: "pkg missing" };
    expect(await runCheckCliVersion({}, { loadRequirements: async () => [], probeFleet: () => missing })).toBe(1);
  });

  it("BLOCKS on a floor the binary misses (999.159 behaviour kept)", async () => {
    const old = { ...bundled, version: "2.1.276", sdkClaudeCodeVersion: "2.1.276", sdkVersion: "0.3.276" };
    expect(await runCheckCliVersion({}, { loadRequirements: floors, probeFleet: () => old })).toBe(1);
  });

  it("--bin (prod override) evaluates that binary: floors enforced, lockstep only warns", async () => {
    const code = await runCheckCliVersion(
      { bin: "/opt/clawcode/claude-pin/claude", json: true },
      { loadRequirements: floors, probeVersion: () => "2.1.280 (Claude Code)" },
    );
    expect(code).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({ binarySource: "override", probedFrom: "/opt/clawcode/claude-pin/claude" });
  });

  it("--installed-version skips the local probe entirely (push path)", async () => {
    const probeFleet = vi.fn(() => bundled);
    expect(await runCheckCliVersion({ installedVersion: "2.1.282" }, { loadRequirements: floors, probeFleet })).toBe(0);
    expect(probeFleet).not.toHaveBeenCalled();
  });

  describe("--expect-manifest (binary integrity)", () => {
    const manifest = {
      sdkVersion: "0.3.282",
      claudeCodeVersion: "2.1.282",
      platformPackage: "@anthropic-ai/claude-agent-sdk-linux-x64",
      binaryVersion: "2.1.282 (Claude Code)",
      sha256: "a".repeat(64),
      recordedAt: "2026-09-25T00:00:00.000Z",
    };

    it("passes when the installed binary matches the build's recorded sha256", async () => {
      const code = await runCheckCliVersion(
        { expectManifest: "/m.json", json: true },
        { loadRequirements: floors, probeFleet: () => bundled, readManifest: () => manifest },
      );
      expect(code).toBe(0);
      expect(JSON.parse(logs[0]!).integrity).toEqual({ kind: "ok", sha256: "a".repeat(64) });
    });

    it("BLOCKS a tampered binary (same SDK package, different bytes)", async () => {
      const tampered = { ...bundled, sha256: "b".repeat(64) };
      const code = await runCheckCliVersion(
        { expectManifest: "/m.json" },
        { loadRequirements: floors, probeFleet: () => tampered, readManifest: () => manifest },
      );
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/sha256/);
    });

    it("does not compare against a manifest for a different SDK version (stale manifest)", async () => {
      const code = await runCheckCliVersion(
        { expectManifest: "/m.json" },
        { loadRequirements: floors, probeFleet: () => ({ ...bundled, sha256: "c".repeat(64) }), readManifest: () => ({ ...manifest, sdkVersion: "0.3.281" }) },
      );
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/integrity not checked/);
    });

    it("a missing manifest is reported, never a silent pass or a block", async () => {
      const code = await runCheckCliVersion(
        { expectManifest: "/nope.json" },
        { loadRequirements: floors, probeFleet: () => bundled, readManifest: () => null },
      );
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/no readable manifest/);
    });
  });

  it("unprobeable version with floors → 2 (never a silent pass)", async () => {
    const unprobeable = { ...bundled, version: null };
    expect(await runCheckCliVersion({}, { loadRequirements: floors, probeFleet: () => unprobeable })).toBe(2);
  });
});
