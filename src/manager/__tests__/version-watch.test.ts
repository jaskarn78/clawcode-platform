import { describe, expect, it, vi } from "vitest";
import {
  evaluateVersions,
  fetchLatestPair,
  markSurfaced,
  renderAlert,
  renderReport,
  unsurfaced,
  SDK_REGISTRY_URL,
  type RuntimeTruth,
  type VersionWatchInput,
} from "../version-watch.js";

const NOW = Date.parse("2026-09-25T18:00:00Z");

const inLockstep: RuntimeTruth = {
  sdkVersion: "0.3.282",
  sdkClaudeCodeVersion: "2.1.282",
  binaryVersion: "2.1.282 (Claude Code)",
  source: "sdk-bundled",
  pin: "/opt/clawcode/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
  error: null,
};

function input(over: Partial<VersionWatchInput> = {}): VersionWatchInput {
  return {
    latest: { sdk: "0.3.282", cli: "2.1.282", publishedAt: "2026-09-24T15:53:58Z" },
    registryError: null,
    runtime: inLockstep,
    highestFloor: "2.1.280",
    now: NOW,
    ...over,
  };
}

describe("evaluateVersions", () => {
  it("silent when prod runs the latest pair in lockstep", () => {
    expect(evaluateVersions(input())).toEqual([]);
  });

  it("new matched pair → one finding keyed by the SDK version, with age vs the 7-day guard", () => {
    const f = evaluateVersions(input({ latest: { sdk: "0.3.283", cli: "2.1.283", publishedAt: "2026-09-23T18:00:00Z" } }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "new-pair", key: "new-pair:0.3.283" });
    expect(f[0]!.line).toContain("2.1.283");
    expect(f[0]!.line).toContain("in 5d");
    expect(f[0]!.line).toContain("update both together");
  });

  it("an older npm latest (e.g. a yanked release) is not a new pair", () => {
    expect(evaluateVersions(input({ latest: { sdk: "0.3.280", cli: "2.1.280", publishedAt: null } }))).toEqual([]);
  });

  it("flags a new pair whose CLI is below a model floor", () => {
    const f = evaluateVersions(input({ highestFloor: "2.1.290", latest: { sdk: "0.3.283", cli: "2.1.283", publishedAt: null } }));
    expect(f[0]!.line).toContain("below the model floor 2.1.290");
  });

  it("skew: binary on disk ≠ the running SDK's claudeCodeVersion (staged deps, no restart)", () => {
    const f = evaluateVersions(input({ runtime: { ...inLockstep, binaryVersion: "2.1.283 (Claude Code)" } }));
    expect(f.map((x) => x.kind)).toEqual(["skew"]);
    expect(f[0]!.key).toBe("skew:2.1.283-vs-2.1.282");
    expect(f[0]!.line).toContain("restart");
  });

  it("override is reported (rollback mode), skew is not double-reported for it", () => {
    const f = evaluateVersions(
      input({ runtime: { ...inLockstep, source: "override", pin: "/opt/clawcode/claude-pin/claude", binaryVersion: "2.1.280" } }),
    );
    expect(f.map((x) => x.kind)).toEqual(["override"]);
  });

  it("unresolved binary is reported", () => {
    const f = evaluateVersions(input({ runtime: { ...inLockstep, pin: null, source: null, binaryVersion: null, error: "missing pkg" } }));
    expect(f.map((x) => x.kind)).toEqual(["unresolved"]);
  });

});

describe("dedup state", () => {
  it("a surfaced finding is not posted again; a new key is", () => {
    const f1 = evaluateVersions(input({ latest: { sdk: "0.3.283", cli: "2.1.283", publishedAt: null } }));
    const state = markSurfaced({ surfaced: {} }, f1, NOW);
    expect(unsurfaced(f1, state)).toEqual([]);
    const f2 = evaluateVersions(input({ latest: { sdk: "0.3.284", cli: "2.1.284", publishedAt: null } }));
    expect(unsurfaced(f2, state)).toHaveLength(1);
  });
});

describe("rendering", () => {
  it("alert uses the injected cc_* icon prefix and lists each finding", () => {
    const f = evaluateVersions(input({ latest: { sdk: "0.3.283", cli: "2.1.283", publishedAt: null } }));
    const icon = (name: string, text: string) => `<:cc_${name}:1> ${text}`;
    const msg = renderAlert(f, icon);
    expect(msg).toContain("<:cc_info:1>");
    expect(msg).toContain("- ");
  });

  it("report shows runtime truth and 'in lockstep' when clean", () => {
    const r = renderReport(input(), []);
    expect(r).toContain("0.3.282");
    expect(r).toContain("in lockstep, up to date");
  });
});

describe("fetchLatestPair", () => {
  it("reads latest + claudeCodeVersion, and fetches publish time only when asked", async () => {
    const fetchJson = vi.fn(async (url: string) =>
      url.endsWith("/latest")
        ? { version: "0.3.283", claudeCodeVersion: "2.1.283" }
        : { time: { "0.3.283": "2026-09-23T18:00:00Z" } },
    );
    await expect(fetchLatestPair(fetchJson, () => false)).resolves.toEqual({ sdk: "0.3.283", cli: "2.1.283", publishedAt: null });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    await expect(fetchLatestPair(fetchJson, () => true)).resolves.toMatchObject({ publishedAt: "2026-09-23T18:00:00.000Z" });
    expect(fetchJson).toHaveBeenCalledWith(SDK_REGISTRY_URL);
  });

  it("rejects a malformed registry answer", async () => {
    await expect(fetchLatestPair(async () => ({}), () => false)).rejects.toThrow(/no version/);
  });

  it("never lets registry text ride into the admin post (strict semver only)", async () => {
    await expect(
      fetchLatestPair(async () => ({ version: "0.3.999 @everyone <https://evil>" }), () => false),
    ).rejects.toThrow(/semver/);
    const p = await fetchLatestPair(
      async (url) =>
        url.endsWith("/latest") ? { version: "0.3.283", claudeCodeVersion: "**2.1.283** @here" } : { time: { "0.3.283": "not a date" } },
      () => true,
    );
    expect(p).toEqual({ sdk: "0.3.283", cli: null, publishedAt: null });
  });
});
