/**
 * Phase 999.171 — per-agent, per-feature UX override store
 * (liveThinking / promptSuggestions / researchSubagents). Persists atomically,
 * re-hydrates at boot, and wins over config while set.
 */
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { ManagerError } from "../../shared/errors.js";
import {
  DEFAULT_UX_FEATURE_STATE_PATH,
  UX_FEATURES,
  UX_FEATURE_META,
  UX_FEATURE_SLASH_NAMES,
  clearUxFeatureState,
  getUxFeatureOverrides,
  hydrateUxFeatureOverrides,
  readAllUxFeatureState,
  resetUxFeatureOverridesForTests,
  resolveUxFeature,
  setUxFeatureOverride,
  writeUxFeatureState,
} from "../ux-feature-state-store.js";

let dir: string;
let path: string;

function fakeLog() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ux-feature-state-"));
  path = join(dir, "manager", "ux-feature-state.json");
  resetUxFeatureOverridesForTests();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ux-feature constants", () => {
  it("lists the features, maps slash names, and says when each applies", () => {
    expect(UX_FEATURES).toEqual(["liveThinking", "statusPing", "promptSuggestions", "researchSubagents"]);
    expect(UX_FEATURE_SLASH_NAMES).toEqual({
      thinking: "liveThinking",
      ping: "statusPing",
      suggestions: "promptSuggestions",
      research: "researchSubagents",
    });
    expect(Object.isFrozen(UX_FEATURE_SLASH_NAMES)).toBe(true);
    expect(Object.isFrozen(UX_FEATURE_META)).toBe(true);
    expect(UX_FEATURE_META.liveThinking).toEqual({ label: "Live thinking", applies: "next-turn" });
    expect(UX_FEATURE_META.statusPing).toEqual({ label: "Status ping", applies: "next-turn" });
    expect(UX_FEATURE_META.promptSuggestions).toEqual({ label: "Prompt suggestions", applies: "restart" });
    expect(UX_FEATURE_META.researchSubagents).toEqual({ label: "Research subagents", applies: "restart" });
  });

  it("owns its own state file under ~/.clawcode/manager", () => {
    expect(DEFAULT_UX_FEATURE_STATE_PATH.endsWith(join(".clawcode", "manager", "ux-feature-state.json"))).toBe(true);
  });
});

describe("ux-feature state store (file)", () => {
  it("persists one feature for one agent and reads it back", async () => {
    const merged = await writeUxFeatureState(path, "personal", "liveThinking", true);
    expect(merged).toEqual({ liveThinking: true });
    expect(await readAllUxFeatureState(path)).toEqual({ personal: { liveThinking: true } });
  });

  it("a second write for another feature of the same agent merges", async () => {
    await writeUxFeatureState(path, "personal", "liveThinking", true);
    const merged = await writeUxFeatureState(path, "personal", "promptSuggestions", false);
    expect(merged).toEqual({ liveThinking: true, promptSuggestions: false });
    expect(await readAllUxFeatureState(path)).toEqual({
      personal: { liveThinking: true, promptSuggestions: false },
    });
  });

  it("writes to other agents leave existing agents intact", async () => {
    await writeUxFeatureState(path, "personal", "liveThinking", true);
    await writeUxFeatureState(path, "projects", "researchSubagents", true);
    expect(await readAllUxFeatureState(path)).toEqual({
      personal: { liveThinking: true },
      projects: { researchSubagents: true },
    });
  });

  it("an entry with an unknown feature key drops only that agent", async () => {
    await writeUxFeatureState(path, "personal", "liveThinking", true);
    const file = JSON.parse(await readFile(path, "utf8"));
    file.agents["projects"] = { liveThinking: true, bogusFeature: true };
    await writeFile(path, JSON.stringify(file), "utf8");
    const log = fakeLog();
    expect(await readAllUxFeatureState(path, log)).toEqual({ personal: { liveThinking: true } });
    expect(log.warn).toHaveBeenCalledWith({ agent: "projects" }, expect.any(String));
  });

  it("an entry with a non-boolean value drops only that agent", async () => {
    await writeUxFeatureState(path, "personal", "liveThinking", false);
    const file = JSON.parse(await readFile(path, "utf8"));
    file.agents["shopping"] = { liveThinking: "yes" };
    await writeFile(path, JSON.stringify(file), "utf8");
    expect(await readAllUxFeatureState(path)).toEqual({ personal: { liveThinking: false } });
  });

  it("a corrupt JSON file reads as empty", async () => {
    await writeUxFeatureState(path, "personal", "liveThinking", true);
    await writeFile(path, "{not json", "utf8");
    expect(await readAllUxFeatureState(path)).toEqual({});
  });

  it("a wrong envelope version reads as empty", async () => {
    await writeUxFeatureState(path, "personal", "liveThinking", true);
    await writeFile(path, JSON.stringify({ version: 2, updatedAt: "", agents: { personal: { liveThinking: true } } }), "utf8");
    expect(await readAllUxFeatureState(path)).toEqual({});
  });

  it("a missing file reads as empty with no warning", async () => {
    const log = fakeLog();
    expect(await readAllUxFeatureState(path, log)).toEqual({});
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("writes atomically: tmp renamed over the target, no .tmp left behind", async () => {
    await writeUxFeatureState(path, "personal", "liveThinking", true);
    await writeUxFeatureState(path, "personal", "liveThinking", false);
    const files = await readdir(join(dir, "manager"));
    expect(files).toEqual(["ux-feature-state.json"]);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.version).toBe(1);
    expect(typeof parsed.updatedAt).toBe("string");
  });

  it("concurrent writes for different features of one agent both persist (no lost update)", async () => {
    await Promise.all([
      writeUxFeatureState(path, "personal", "liveThinking", true),
      writeUxFeatureState(path, "personal", "promptSuggestions", false),
      writeUxFeatureState(path, "personal", "researchSubagents", true),
    ]);
    expect(await readAllUxFeatureState(path)).toEqual({
      personal: { liveThinking: true, promptSuggestions: false, researchSubagents: true },
    });
  });

  it("a failed write rejects for its caller but does not wedge later writes", async () => {
    // Parent path is a regular file, so mkdir fails for this one write.
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x", "utf8");
    await expect(writeUxFeatureState(join(blocker, "state.json"), "personal", "liveThinking", true)).rejects.toThrow();
    await writeUxFeatureState(path, "personal", "liveThinking", true);
    expect(await readAllUxFeatureState(path)).toEqual({ personal: { liveThinking: true } });
  });

  it("a write heals an invalid entry for the same agent instead of perpetuating it", async () => {
    await writeUxFeatureState(path, "personal", "liveThinking", true);
    const file = JSON.parse(await readFile(path, "utf8"));
    file.agents["personal"] = { liveThinking: "nope" };
    await writeFile(path, JSON.stringify(file), "utf8");
    await writeUxFeatureState(path, "personal", "promptSuggestions", true);
    expect(await readAllUxFeatureState(path)).toEqual({ personal: { promptSuggestions: true } });
  });

  it("logs only agent, feature and enabled on write", async () => {
    const log = fakeLog();
    await writeUxFeatureState(path, "personal", "liveThinking", true, log);
    expect(log.info).toHaveBeenCalledWith({ agent: "personal", feature: "liveThinking", enabled: true }, expect.any(String));
  });
});

describe("ux-feature state store — the write path fails closed (MD-04)", () => {
  it("an unreadable file (EACCES) is never overwritten: the write refuses and every agent's override survives", async () => {
    if (process.getuid?.() === 0) return; // root reads through mode 000
    await writeUxFeatureState(path, "personal", "liveThinking", true);
    await writeUxFeatureState(path, "projects", "researchSubagents", true);
    await chmod(path, 0o000);
    const log = fakeLog();
    try {
      const err = await writeUxFeatureState(path, "shopping", "liveThinking", true, log).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ManagerError);
      expect((err as Error).message).not.toContain(dir); // no filesystem path in the admin reply
      expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ filePath: path }), expect.any(String));
    } finally {
      await chmod(path, 0o600);
    }
    expect(await readAllUxFeatureState(path)).toEqual({
      personal: { liveThinking: true },
      projects: { researchSubagents: true },
    });
  });

  it("any other non-ENOENT read error (EISDIR) refuses too, and leaves nothing behind", async () => {
    await mkdir(path, { recursive: true });
    const err = await writeUxFeatureState(path, "personal", "liveThinking", true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagerError);
    expect((err as Error).message).not.toContain(dir);
    expect(await readdir(join(dir, "manager"))).toEqual(["ux-feature-state.json"]);
    expect(await readdir(path)).toEqual([]);
  });

  it("a corrupt JSON file is moved aside to <file>.corrupt-<timestamp> (warned with the path) before a fresh write", async () => {
    await writeUxFeatureState(path, "personal", "liveThinking", true);
    await writeFile(path, "{not json", "utf8");
    const log = fakeLog();
    await writeUxFeatureState(path, "shopping", "liveThinking", true, log);
    const files = (await readdir(join(dir, "manager"))).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toBe("ux-feature-state.json");
    expect(files[1]).toMatch(/^ux-feature-state\.json\.corrupt-\d+$/);
    expect(await readFile(join(dir, "manager", files[1]!), "utf8")).toBe("{not json");
    expect(await readAllUxFeatureState(path)).toEqual({ shopping: { liveThinking: true } });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: path, movedTo: join(dir, "manager", files[1]!) }),
      expect.any(String),
    );
  });

  it("an invalid envelope counts as corrupt: moved aside too, never silently replaced", async () => {
    const future = JSON.stringify({ version: 2, updatedAt: "", agents: { personal: { liveThinking: true } } });
    await mkdir(join(dir, "manager"), { recursive: true });
    await writeFile(path, future, "utf8");
    await writeUxFeatureState(path, "shopping", "liveThinking", false);
    const aside = (await readdir(join(dir, "manager"))).filter((f) => f.includes(".corrupt-"));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(dir, "manager", aside[0]!), "utf8")).toBe(future);
    expect(await readAllUxFeatureState(path)).toEqual({ shopping: { liveThinking: false } });
  });

  it("a missing file still starts fresh with no warning", async () => {
    const log = fakeLog();
    await writeUxFeatureState(path, "personal", "liveThinking", true, log);
    expect(log.warn).not.toHaveBeenCalled();
    expect(await readAllUxFeatureState(path)).toEqual({ personal: { liveThinking: true } });
  });
});

describe("ux-feature state store — reset one feature (operator 2026-09-24)", () => {
  it("resetting one of two features keeps the other, and leaves other agents untouched", async () => {
    await writeUxFeatureState(path, "personal", "liveThinking", false);
    await writeUxFeatureState(path, "personal", "promptSuggestions", true);
    await writeUxFeatureState(path, "projects", "liveThinking", true);
    const remaining = await clearUxFeatureState(path, "personal", "liveThinking");
    expect(remaining).toEqual({ promptSuggestions: true });
    expect(await readAllUxFeatureState(path)).toEqual({
      personal: { promptSuggestions: true },
      projects: { liveThinking: true },
    });
  });

  it("resetting the agent's last feature drops its entry entirely", async () => {
    await writeUxFeatureState(path, "personal", "liveThinking", false);
    await writeUxFeatureState(path, "projects", "liveThinking", true);
    expect(await clearUxFeatureState(path, "personal", "liveThinking")).toBeNull();
    const file = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(file.agents)).toEqual(["projects"]);
    expect(file.version).toBe(1);
  });

  it("resetting a feature with no override is a no-op success: the file is not rewritten", async () => {
    await writeUxFeatureState(path, "personal", "promptSuggestions", true);
    const before = await readFile(path, "utf8");
    expect(await clearUxFeatureState(path, "personal", "liveThinking")).toEqual({ promptSuggestions: true });
    expect(await clearUxFeatureState(path, "shopping", "liveThinking")).toBeNull();
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("resetting with no state file at all is a no-op success and creates nothing", async () => {
    expect(await clearUxFeatureState(path, "personal", "liveThinking")).toBeNull();
    await expect(readdir(join(dir, "manager"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("an invalid entry for the agent is dropped by a reset (the write heals it)", async () => {
    await writeUxFeatureState(path, "projects", "liveThinking", true);
    const file = JSON.parse(await readFile(path, "utf8"));
    file.agents["personal"] = { liveThinking: "nope" };
    await writeFile(path, JSON.stringify(file), "utf8");
    expect(await clearUxFeatureState(path, "personal", "liveThinking")).toBeNull();
    expect(Object.keys(JSON.parse(await readFile(path, "utf8")).agents)).toEqual(["projects"]);
  });

  it("an unreadable file (EACCES) refuses the reset like a write, and every agent's override survives", async () => {
    if (process.getuid?.() === 0) return; // root reads through mode 000
    await writeUxFeatureState(path, "personal", "liveThinking", false);
    await writeUxFeatureState(path, "projects", "researchSubagents", true);
    await chmod(path, 0o000);
    try {
      const err = await clearUxFeatureState(path, "personal", "liveThinking").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ManagerError);
      expect((err as Error).message).not.toContain(dir);
    } finally {
      await chmod(path, 0o600);
    }
    expect(await readAllUxFeatureState(path)).toEqual({
      personal: { liveThinking: false },
      projects: { researchSubagents: true },
    });
  });

  it("a corrupt file is moved aside like a write; with nothing left to reset, no fresh file is written", async () => {
    await writeUxFeatureState(path, "personal", "liveThinking", false);
    await writeFile(path, "{not json", "utf8");
    const log = fakeLog();
    expect(await clearUxFeatureState(path, "personal", "liveThinking", log)).toBeNull();
    const files = await readdir(join(dir, "manager"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^ux-feature-state\.json\.corrupt-\d+$/);
    expect(await readFile(join(dir, "manager", files[0]!), "utf8")).toBe("{not json");
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ filePath: path }), expect.any(String));
    expect(await readAllUxFeatureState(path)).toEqual({});
  });

  it("a reset queued behind writes sees them (same serialized chain)", async () => {
    await Promise.all([
      writeUxFeatureState(path, "personal", "liveThinking", true),
      writeUxFeatureState(path, "personal", "promptSuggestions", false),
      clearUxFeatureState(path, "personal", "liveThinking"),
    ]);
    expect(await readAllUxFeatureState(path)).toEqual({ personal: { promptSuggestions: false } });
  });
});

describe("ux-feature in-memory registry", () => {
  it("hydrate replaces the registry with the file contents (restart survival)", async () => {
    setUxFeatureOverride("stale-agent", { liveThinking: true });
    await writeUxFeatureState(path, "personal", "liveThinking", true);
    await writeUxFeatureState(path, "personal", "researchSubagents", false);
    expect(getUxFeatureOverrides("personal")).toBeUndefined();
    const log = fakeLog();
    const all = await hydrateUxFeatureOverrides(path, log);
    expect(all).toEqual({ personal: { liveThinking: true, researchSubagents: false } });
    expect(getUxFeatureOverrides("personal")).toEqual({ liveThinking: true, researchSubagents: false });
    expect(getUxFeatureOverrides("stale-agent")).toBeUndefined();
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it("set / clear an agent's overrides", () => {
    setUxFeatureOverride("personal", { liveThinking: false });
    expect(getUxFeatureOverrides("personal")).toEqual({ liveThinking: false });
    setUxFeatureOverride("personal", null);
    expect(getUxFeatureOverrides("personal")).toBeUndefined();
  });
});

describe("resolveUxFeature", () => {
  it("an override wins over config", () => {
    setUxFeatureOverride("personal", { liveThinking: true });
    expect(resolveUxFeature("personal", "liveThinking", { liveThinking: false })).toEqual({ enabled: true, source: "override" });
    setUxFeatureOverride("personal", { liveThinking: false });
    expect(resolveUxFeature("personal", "liveThinking", { liveThinking: true })).toEqual({ enabled: false, source: "override" });
  });

  it("without an override for that feature, config decides (undefined => off)", () => {
    expect(resolveUxFeature("personal", "liveThinking", { liveThinking: true })).toEqual({ enabled: true, source: "config" });
    expect(resolveUxFeature("personal", "liveThinking", undefined)).toEqual({ enabled: false, source: "config" });
    setUxFeatureOverride("personal", { promptSuggestions: true });
    expect(resolveUxFeature("personal", "liveThinking", { liveThinking: true })).toEqual({ enabled: true, source: "config" });
    expect(resolveUxFeature("personal", "promptSuggestions", undefined)).toEqual({ enabled: true, source: "override" });
  });
});
