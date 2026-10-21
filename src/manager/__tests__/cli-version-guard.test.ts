/**
 * Phase 999.159 — the boot gate that would have caught both outages.
 *
 * These start from a PROD-SHAPED config (multiple agents, a mix of explicit and
 * inherited models, an advisor pin, a picker allowlist) rather than an empty
 * object — per feedback_test_from_a_populated_world: the empty-world tests are
 * the ones that pass while production breaks.
 */
import { describe, expect, it } from "vitest";
import {
  checkCliVersion,
  collectCliVersionRequirements,
  formatCliVersionFailure,
  lookupMinCliVersion,
  checkClaudeBinaryLockstep,
  isLockstepFatal,
  formatLockstepFailure,
} from "../cli-version-guard.js";

/** Shaped after the live fleet: 8 agents, most on `opus`, one on haiku. */
const prodLikeConfig = {
  defaults: {
    model: "haiku",
    allowedModels: ["haiku", "sonnet", "opus", "fable"],
    advisor: { model: "opus" },
  },
  agents: [
    { name: "personal", model: "opus" },
    { name: "state-contract", model: "opus" },
    { name: "fin-client", model: "opus" },
    { name: "side-project", model: "opus" },
    { name: "shopping", model: "sonnet" },
    { name: "projects", model: "sonnet" },
    // No explicit model — inherits defaults.model.
    { name: "client-a-personal" },
    { name: "Admin", model: "opus" },
  ],
} as const;

describe("lookupMinCliVersion", () => {
  it("reads the floor from an alias key", () => {
    expect(lookupMinCliVersion("opus")).toBe("2.1.280");
    expect(lookupMinCliVersion("fable")).toBe("2.1.257");
  });

  it("reads the floor from a concrete model id too", () => {
    // Config carries aliases, but advisor/override paths can carry ids — a
    // floor that only matched one shape would be a silent half-check.
    expect(lookupMinCliVersion("claude-opus-5-5")).toBe("2.1.280");
    expect(lookupMinCliVersion("claude-fable-5-1")).toBe("2.1.257");
  });

  it("returns null for models with no declared floor", () => {
    expect(lookupMinCliVersion("haiku")).toBeNull();
    expect(lookupMinCliVersion("sonnet")).toBeNull();
    // A superseded pin kept for rollback has no floor of its own.
    expect(lookupMinCliVersion("opus-5")).toBeNull();
  });

  it("resolves `<family>@latest` to the highest floor in the family", () => {
    expect(lookupMinCliVersion("opus@latest")).toBe("2.1.280");
  });

  it("returns null for an unknown model rather than throwing", () => {
    expect(lookupMinCliVersion("claude-does-not-exist")).toBeNull();
  });
});

describe("collectCliVersionRequirements", () => {
  it("finds the in-use opus agents and the advisor pin", () => {
    const reqs = collectCliVersionRequirements(prodLikeConfig);
    const inUse = reqs.filter((r) => r.inUse);
    expect(inUse.map((r) => r.source)).toEqual([
      "defaults.advisor.model",
      'agent "personal".model',
      'agent "state-contract".model',
      'agent "fin-client".model',
      'agent "side-project".model',
      'agent "Admin".model',
    ]);
    expect(inUse.every((r) => r.minCliVersion === "2.1.280")).toBe(true);
  });

  it("marks allowlist entries as selectable, not in use", () => {
    const reqs = collectCliVersionRequirements(prodLikeConfig);
    const selectable = reqs.filter((r) => !r.inUse);
    // `opus` and `fable` both declare floors; haiku/sonnet do not.
    expect(selectable.map((r) => r.model)).toEqual(["opus", "fable"]);
  });

  it("does not attribute an inherited model to the agent that omitted it", () => {
    const reqs = collectCliVersionRequirements(prodLikeConfig);
    expect(reqs.some((r) => r.source.includes("client-a-personal"))).toBe(false);
  });

  it("ignores models with no floor, so a haiku-only fleet has no requirements", () => {
    const reqs = collectCliVersionRequirements({
      defaults: { model: "haiku" },
      agents: [{ name: "a", model: "haiku" }, { name: "b", model: "sonnet" }],
    });
    expect(reqs).toEqual([]);
  });

  it("survives a config with no defaults and no agents", () => {
    expect(collectCliVersionRequirements({})).toEqual([]);
  });
});

describe("checkCliVersion — the two outages", () => {
  it("🚨 blocks the 2026-09-22 shape: binary 2.1.257, agents on Opus 5.5", () => {
    const verdict = checkCliVersion(
      "2.1.257 (Claude Code)",
      collectCliVersionRequirements(prodLikeConfig),
    );
    expect(verdict.blocking.length).toBeGreaterThan(0);
    expect(verdict.highestRequired).toBe("2.1.280");
    expect(verdict.installed).toBe("2.1.257");
  });

  it("🚨 blocks the 2026-09-01 shape: binary 2.1.158, an agent on Fable 5.1", () => {
    const verdict = checkCliVersion("2.1.158 (Claude Code)", [
      ...collectCliVersionRequirements({
        defaults: { model: "haiku" },
        agents: [{ name: "fin-research", model: "fable" }],
      }),
    ]);
    expect(verdict.blocking).toHaveLength(1);
    expect(verdict.blocking[0]!.model).toBe("fable");
    expect(verdict.highestRequired).toBe("2.1.257");
  });

  it("passes on the binary prod actually runs today", () => {
    const verdict = checkCliVersion(
      "2.1.280 (Claude Code)",
      collectCliVersionRequirements(prodLikeConfig),
    );
    expect(verdict.blocking).toEqual([]);
    expect(verdict.selectableUnmet).toEqual([]);
  });

  it("warns rather than blocks when only a selectable model is unmet", () => {
    // Binary satisfies every model in USE, but not `fable` in the allowlist.
    const verdict = checkCliVersion("2.1.257", [
      { model: "haiku", minCliVersion: "2.1.0", source: "defaults.model", inUse: true },
      { model: "fable", minCliVersion: "2.1.280", source: "defaults.allowedModels", inUse: false },
    ]);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.selectableUnmet).toHaveLength(1);
    expect(verdict.selectableUnmet[0]!.model).toBe("fable");
  });

  it("does NOT block on an unprobeable binary, but still reports the target", () => {
    // A failed --version probe proves nothing and must never be the reason 8
    // agents stay down.
    const verdict = checkCliVersion(null, collectCliVersionRequirements(prodLikeConfig));
    expect(verdict.blocking).toEqual([]);
    expect(verdict.installed).toBeNull();
    expect(verdict.highestRequired).toBe("2.1.280");
  });

  it("treats an empty version string as unprobeable", () => {
    const verdict = checkCliVersion("   ", collectCliVersionRequirements(prodLikeConfig));
    expect(verdict.installed).toBeNull();
    expect(verdict.blocking).toEqual([]);
  });
});

describe("formatCliVersionFailure", () => {
  it("names the model, its origin, and the remediation command", () => {
    const verdict = checkCliVersion("2.1.257", [
      { model: "opus", minCliVersion: "2.1.280", source: 'agent "personal".model', inUse: true },
    ]);
    const msg = formatCliVersionFailure(verdict);
    expect(msg).toContain("installed 2.1.257");
    expect(msg).toContain("opus");
    expect(msg).toContain('agent "personal".model');
    // 999.169 — `clawcode update` never moved the binary; the fix is the SDK pin.
    expect(msg).not.toContain("clawcode update");
    expect(msg).toContain("@anthropic-ai/claude-agent-sdk");
    expect(msg).toContain("claudeCodeVersion >= 2.1.280");
    expect(msg).toContain("CLAWCODE_CLAUDE_BIN");
  });
});

describe("checkClaudeBinaryLockstep (999.169)", () => {
  const base = {
    source: "sdk-bundled" as const,
    version: "2.1.282 (Claude Code)",
    sdkVersion: "0.3.282",
    sdkClaudeCodeVersion: "2.1.282",
    error: null,
    pin: "/opt/clawcode/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
  };

  it("ok when the bundled binary is exactly the SDK's claudeCodeVersion", () => {
    expect(checkClaudeBinaryLockstep(base).kind).toBe("ok");
  });

  it("mismatch (fatal) when the binary drifted from the SDK's matched version", () => {
    const v = checkClaudeBinaryLockstep({ ...base, version: "2.1.280 (Claude Code)" });
    expect(v).toMatchObject({ kind: "mismatch", installed: "2.1.280", expected: "2.1.282" });
    expect(isLockstepFatal(v)).toBe(true);
    expect(formatLockstepFailure(v)).toMatch(/npm ci/);
    expect(formatLockstepFailure(v)).toMatch(/CLAWCODE_CLAUDE_BIN/);
  });

  it("unresolved (fatal) when there is no binary to spawn", () => {
    const v = checkClaudeBinaryLockstep({ ...base, pin: null, source: null, version: null, error: "missing pkg" });
    expect(v.kind).toBe("unresolved");
    expect(isLockstepFatal(v)).toBe(true);
    expect(formatLockstepFailure(v)).toContain("missing pkg");
  });

  it("an explicit override is a loud warning, never fatal (it is the rollback path)", () => {
    const v = checkClaudeBinaryLockstep({ ...base, source: "override", version: "2.1.280 (Claude Code)" });
    expect(v.kind).toBe("override");
    expect(isLockstepFatal(v)).toBe(false);
  });

  it("unverifiable (warn) when the probe or the SDK declaration is missing", () => {
    expect(checkClaudeBinaryLockstep({ ...base, version: null }).kind).toBe("unverifiable");
    expect(checkClaudeBinaryLockstep({ ...base, sdkClaudeCodeVersion: null }).kind).toBe("unverifiable");
    expect(isLockstepFatal(checkClaudeBinaryLockstep({ ...base, version: null }))).toBe(false);
  });
});
