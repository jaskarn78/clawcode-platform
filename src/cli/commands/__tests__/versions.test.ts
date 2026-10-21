import { afterEach, describe, expect, it, vi } from "vitest";
import { runVersions } from "../versions.js";
import type { FleetBinaryProbe } from "../../../shared/claude-binary.js";

const logs: string[] = [];
vi.mock("../../output.js", () => ({
  cliLog: (m: string) => logs.push(m),
  cliError: (m: string) => logs.push(m),
}));
afterEach(() => {
  logs.length = 0;
});

const probe: FleetBinaryProbe = {
  pin: "/x/claude",
  source: "sdk-bundled",
  platformPackage: "@anthropic-ai/claude-agent-sdk-linux-x64",
  sha256: "a".repeat(64),
  version: "2.1.282 (Claude Code)",
  sdkVersion: "0.3.282",
  sdkClaudeCodeVersion: "2.1.282",
  error: null,
};
const registry = (sdk: string, cli: string) => async (url: string) =>
  url.endsWith("/latest") ? { version: sdk, claudeCodeVersion: cli } : { time: { [sdk]: "2026-09-24T15:53:58Z" } };

describe("clawcode versions", () => {
  it("0 and 'in lockstep' when running the latest pair", async () => {
    const code = await runVersions({}, { probe: () => probe, fetchJson: registry("0.3.282", "2.1.282"), highestFloor: async () => "2.1.280" });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("in lockstep, up to date");
  });

  it("1 with the new pair when npm is ahead", async () => {
    const code = await runVersions({}, { probe: () => probe, fetchJson: registry("0.3.283", "2.1.283"), highestFloor: async () => null });
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("0.3.283");
  });

  it("registry outage still reports local truth", async () => {
    const code = await runVersions(
      { json: true },
      {
        probe: () => probe,
        fetchJson: async () => {
          throw new Error("offline");
        },
        highestFloor: async () => null,
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(logs[0]!)).toMatchObject({ registryError: "offline", runtime: { sdkVersion: "0.3.282" } });
  });

  it("2 when no SDK is installed", async () => {
    const none = { ...probe, sdkVersion: null, sdkClaudeCodeVersion: null, pin: null, source: null, version: null, error: "missing" };
    expect(await runVersions({}, { probe: () => none, fetchJson: registry("0.3.282", "2.1.282"), highestFloor: async () => null })).toBe(2);
  });
});
