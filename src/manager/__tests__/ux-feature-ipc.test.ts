/**
 * Phase 999.171 — pure `set-ux-feature` IPC handler: validates agent / feature
 * / state against allowlists, writes file + registry together, and reports the
 * effective state, its source, and when the change applies.
 */
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManagerError } from "../../shared/errors.js";
import { handleSetUxFeature } from "../ux-feature-ipc.js";
import {
  getUxFeatureOverrides,
  readAllUxFeatureState,
  resetUxFeatureOverridesForTests,
  resolveUxFeature,
  setUxFeatureOverride,
  type UxFeatureOverrides,
} from "../ux-feature-state-store.js";

let dir: string;
let path: string;

const CONFIG: Record<string, UxFeatureOverrides | undefined> = {
  personal: { liveThinking: false },
  projects: { liveThinking: true },
  shopping: undefined,
};

/**
 * Thread / subagent sessions DO have a config (a snapshot of the parent's),
 * so a manager lookup finds them; they are not configured agents.
 */
const SESSION_SNAPSHOTS: Record<string, UxFeatureOverrides> = {
  "personal-thread-1234567890": { liveThinking: true },
  "personal-sub-AbC123": { liveThinking: true },
};

function getConfigFeatures(agentOrSession: string): UxFeatureOverrides | undefined | null {
  if (Object.hasOwn(SESSION_SNAPSHOTS, agentOrSession)) return SESSION_SNAPSHOTS[agentOrSession];
  return Object.hasOwn(CONFIG, agentOrSession) ? CONFIG[agentOrSession] : null;
}

function isConfiguredAgent(agent: string): boolean {
  return Object.hasOwn(CONFIG, agent);
}

function call(params: Record<string, unknown>) {
  return handleSetUxFeature({ params, getConfigFeatures, isConfiguredAgent, filePath: path });
}

async function expectNoFileWritten(): Promise<void> {
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ux-feature-ipc-"));
  path = join(dir, "manager", "ux-feature-state.json");
  resetUxFeatureOverridesForTests();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("handleSetUxFeature — writes", () => {
  it("on writes the file and the registry, and reports the override", async () => {
    const result = await call({ agent: "personal", feature: "liveThinking", state: "on" });
    expect(result).toEqual({
      agent: "personal",
      feature: "liveThinking",
      state: "on",
      enabled: true,
      source: "override",
      configEnabled: false,
      applies: "next-turn",
    });
    expect(await readAllUxFeatureState(path)).toEqual({ personal: { liveThinking: true } });
    expect(getUxFeatureOverrides("personal")).toEqual({ liveThinking: true });
  });

  it("off overrides a config that says on, and reports configEnabled", async () => {
    const result = await call({ agent: "projects", feature: "thinking", state: "off" });
    expect(result).toMatchObject({ feature: "liveThinking", state: "off", enabled: false, source: "override", configEnabled: true });
    expect(getUxFeatureOverrides("projects")).toEqual({ liveThinking: false });
  });

  it("toggling a second feature merges with the first in file and registry", async () => {
    await call({ agent: "personal", feature: "thinking", state: "on" });
    const result = await call({ agent: "personal", feature: "research", state: "on" });
    expect(result).toMatchObject({ feature: "researchSubagents", enabled: true, applies: "restart" });
    expect(getUxFeatureOverrides("personal")).toEqual({ liveThinking: true, researchSubagents: true });
    expect(await readAllUxFeatureState(path)).toEqual({ personal: { liveThinking: true, researchSubagents: true } });
  });
});

describe("handleSetUxFeature — an unreadable state file (MD-04)", () => {
  it("on refuses with a short ManagerError the slash reply can show, and the registry is not touched", async () => {
    await mkdir(path, { recursive: true }); // readFile -> EISDIR, not ENOENT
    const err = await call({ agent: "personal", feature: "thinking", state: "on" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagerError);
    const msg = (err as Error).message;
    expect(msg).toContain("not overwritten");
    expect(msg).not.toContain(dir);
    expect(msg.length).toBeLessThan(200);
    expect(getUxFeatureOverrides("personal")).toBeUndefined();
  });
});

describe("handleSetUxFeature — reset (operator 2026-09-24)", () => {
  it("an override off over config on resolves on again right after reset, with no restart or hydrate", async () => {
    await call({ agent: "projects", feature: "thinking", state: "off" });
    expect(resolveUxFeature("projects", "liveThinking", CONFIG.projects)).toEqual({ enabled: false, source: "override" });

    const result = await call({ agent: "projects", feature: "thinking", state: "reset" });
    expect(result).toEqual({
      agent: "projects",
      feature: "liveThinking",
      state: "reset",
      enabled: true,
      source: "config",
      configEnabled: true,
      applies: "next-turn",
    });
    // The next turn's gate reads the in-memory registry: config governs now.
    expect(getUxFeatureOverrides("projects")).toBeUndefined();
    expect(resolveUxFeature("projects", "liveThinking", CONFIG.projects)).toEqual({ enabled: true, source: "config" });
    expect(await readAllUxFeatureState(path)).toEqual({});
  });

  it("reset clears ONE feature: the agent's other overrides stay, in the file and in memory", async () => {
    await call({ agent: "personal", feature: "thinking", state: "on" });
    await call({ agent: "personal", feature: "research", state: "on" });
    const result = await call({ agent: "personal", feature: "thinking", state: "reset" });
    expect(result).toMatchObject({ state: "reset", enabled: false, source: "config" });
    expect(getUxFeatureOverrides("personal")).toEqual({ researchSubagents: true });
    expect(await readAllUxFeatureState(path)).toEqual({ personal: { researchSubagents: true } });
  });

  it("the in-memory registry drops only that feature, even when the file no longer holds the agent", async () => {
    setUxFeatureOverride("personal", { liveThinking: true, promptSuggestions: false });
    await call({ agent: "personal", feature: "thinking", state: "reset" });
    expect(getUxFeatureOverrides("personal")).toEqual({ promptSuggestions: false });
  });

  it("reset with no override is a no-op success that reports the config value and writes nothing", async () => {
    const result = await call({ agent: "personal", feature: "thinking", state: "reset" });
    expect(result).toMatchObject({ state: "reset", enabled: false, source: "config", configEnabled: false });
    await expectNoFileWritten();
    expect(getUxFeatureOverrides("personal")).toBeUndefined();
  });

  it("reset on an unreadable state file refuses with the short write-path error and leaves memory alone", async () => {
    await mkdir(path, { recursive: true }); // readFile -> EISDIR
    setUxFeatureOverride("projects", { liveThinking: false });
    const err = await call({ agent: "projects", feature: "thinking", state: "reset" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagerError);
    expect((err as Error).message).toContain("not overwritten");
    expect((err as Error).message).not.toContain(dir);
    expect(getUxFeatureOverrides("projects")).toEqual({ liveThinking: false });
  });
});

describe("handleSetUxFeature — status", () => {
  it("status performs no write and reports the config value", async () => {
    const result = await call({ agent: "projects", feature: "liveThinking", state: "status" });
    expect(result).toEqual({
      agent: "projects",
      feature: "liveThinking",
      state: "status",
      enabled: true,
      source: "config",
      configEnabled: true,
      applies: "next-turn",
    });
    await expectNoFileWritten();
    expect(getUxFeatureOverrides("projects")).toBeUndefined();
  });

  it("state is optional and defaults to status; absent config reads as off", async () => {
    const result = await call({ agent: "shopping", feature: "thinking" });
    expect(result).toMatchObject({ state: "status", enabled: false, source: "config", configEnabled: false });
    // JSON has no undefined: an explicit null is the same "not given".
    expect(await call({ agent: "shopping", feature: "thinking", state: null })).toMatchObject({ state: "status" });
    await expectNoFileWritten();
  });

  it("status after an override reports source override", async () => {
    await call({ agent: "personal", feature: "thinking", state: "on" });
    const result = await call({ agent: "personal", feature: "thinking", state: "status" });
    expect(result).toMatchObject({ state: "status", enabled: true, source: "override", configEnabled: false });
  });

  it("accepts slash names and canonical names for every feature", async () => {
    const pairs: Array<[string, string]> = [
      ["thinking", "liveThinking"],
      ["suggestions", "promptSuggestions"],
      ["research", "researchSubagents"],
      ["liveThinking", "liveThinking"],
      ["promptSuggestions", "promptSuggestions"],
      ["researchSubagents", "researchSubagents"],
    ];
    for (const [input, canonical] of pairs) {
      const result = await call({ agent: "personal", feature: input });
      expect(result.feature).toBe(canonical);
    }
    expect((await call({ agent: "personal", feature: "suggestions" })).applies).toBe("restart");
  });
});

describe("handleSetUxFeature — 999.172 restart pending", () => {
  const withStarted = (started: UxFeatureOverrides | undefined) => (params: Record<string, unknown>) =>
    handleSetUxFeature({ params, getConfigFeatures, isConfiguredAgent, getStartedFeatures: () => started, filePath: path });

  it("on, while the running session started without suggestions → restartPending true", async () => {
    const r = await withStarted({ promptSuggestions: false })({ agent: "personal", feature: "suggestions", state: "on" });
    expect(r).toMatchObject({ enabled: true, applies: "restart", restartPending: true });
  });

  it("on, while the running session already has them → restartPending false", async () => {
    const r = await withStarted({ promptSuggestions: true })({ agent: "personal", feature: "suggestions", state: "on" });
    expect(r.restartPending).toBe(false);
  });

  it("agent not running (no started info) → restartPending omitted", async () => {
    const r = await withStarted(undefined)({ agent: "personal", feature: "suggestions", state: "status" });
    expect("restartPending" in r).toBe(false);
  });

  it("a next-turn feature never reports restartPending", async () => {
    const r = await withStarted({ promptSuggestions: true })({ agent: "personal", feature: "thinking", state: "on" });
    expect("restartPending" in r).toBe(false);
  });
});

describe("handleSetUxFeature — rejects invalid input without writing", () => {
  it("unknown agent throws ManagerError and writes nothing", async () => {
    await expect(call({ agent: "nobody", feature: "thinking", state: "on" })).rejects.toBeInstanceOf(ManagerError);
    await expectNoFileWritten();
    expect(getUxFeatureOverrides("nobody")).toBeUndefined();
  });

  it("MD-01: a thread or subagent session name is rejected with a clear message, though the session has a config", async () => {
    for (const agent of Object.keys(SESSION_SNAPSHOTS)) {
      for (const state of ["on", "off", "status", "reset"]) {
        const err = await call({ agent, feature: "thinking", state }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ManagerError);
        const msg = (err as Error).message;
        expect(msg).toContain("parent agent");
        expect(msg).not.toContain(agent); // never echoes the input
      }
      expect(getUxFeatureOverrides(agent)).toBeUndefined();
    }
    await expectNoFileWritten();
  });

  it("missing, empty or non-string agent throws ManagerError", async () => {
    await expect(call({ feature: "thinking", state: "on" })).rejects.toBeInstanceOf(ManagerError);
    await expect(call({ agent: "", feature: "thinking", state: "on" })).rejects.toBeInstanceOf(ManagerError);
    await expect(call({ agent: "   ", feature: "thinking", state: "on" })).rejects.toBeInstanceOf(ManagerError);
    await expect(call({ agent: 42, feature: "thinking", state: "on" })).rejects.toBeInstanceOf(ManagerError);
    await expectNoFileWritten();
  });

  it("a feature outside the allowlist throws ManagerError listing allowed values, never echoing the input", async () => {
    for (const feature of ["bogus-evil", "constructor", "__proto__", "toString", undefined, 7]) {
      const err = await call({ agent: "personal", feature, state: "on" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ManagerError);
      const msg = (err as Error).message;
      expect(msg).toContain("thinking");
      expect(msg).toContain("suggestions");
      expect(msg).toContain("research");
      expect(msg).not.toContain("evil");
    }
    await expectNoFileWritten();
    expect(getUxFeatureOverrides("personal")).toBeUndefined();
  });

  it("a state outside on|off|status throws ManagerError listing allowed values, never echoing the input", async () => {
    for (const state of ["RESET", "ON", "clear", "evil-state", "", 1, true]) {
      const err = await call({ agent: "personal", feature: "thinking", state }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ManagerError);
      const msg = (err as Error).message;
      expect(msg).toContain("on | off | status");
      expect(msg).not.toContain("evil");
    }
    await expectNoFileWritten();
  });
});
