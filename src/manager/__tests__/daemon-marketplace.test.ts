/**
 * Phase 88 Plan 02 Task 1 — daemon marketplace IPC handler tests (M1-M11).
 *
 * Drives the three exported pure functions the daemon delegates to:
 *   - handleMarketplaceListIpc
 *   - handleMarketplaceInstallIpc
 *   - handleMarketplaceRemoveIpc
 *
 * Mocks:
 *   - loadMarketplaceCatalog + installSingleSkill + updateAgentSkills
 *     via per-test DI (no vi.mock() needed — the handlers accept optional
 *     DI fields on MarketplaceIpcDeps, defaulting to the real impls).
 *   - scanSkillsDirectory + linkAgentSkills via the same DI hooks.
 *
 * Pins:
 *   M1: marketplace-list happy path — installed + available (catalog minus installed)
 *   M2: marketplace-list — agent not found → ManagerError
 *   M3: marketplace-install happy — order: installSingleSkill → scanCatalog → linkSkills
 *   M4: marketplace-install — blocked-secret-scan → no rewire
 *   M5: marketplace-install — rejected-scope → no rewire
 *   M6: marketplace-install — installed-persist-failed → rewire STILL runs
 *   M7: marketplace-install — not-in-catalog → no rewire
 *   M8: marketplace-install — agent not found → ManagerError BEFORE install fires
 *   M9: marketplace-remove happy → updateAgentSkills called with op:"remove"
 *  M10: marketplace-remove persist EACCES → removed:true, persisted:false
 *  M11: IPC_METHODS contains the three new entries
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";

import {
  handleMarketplaceListIpc,
  handleMarketplaceInstallIpc,
  handleMarketplaceRemoveIpc,
  type MarketplaceIpcDeps,
} from "../daemon.js";
import { ManagerError } from "../../shared/errors.js";
import { IPC_METHODS } from "../../ipc/protocol.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { MarketplaceEntry } from "../../marketplace/catalog.js";
import type { SkillInstallOutcome } from "../../marketplace/install-single-skill.js";
import type { SkillsCatalog } from "../../skills/types.js";

function stubLogger(): Logger {
  const stub = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
  stub.child.mockReturnValue(stub);
  return stub as unknown as Logger;
}

function makeAgent(
  name: string,
  skills: readonly string[] = [],
): ResolvedAgentConfig {
  return {
    name,
    workspace: `/tmp/ws-${name}`,
    memoryPath: `/tmp/mem-${name}`,
    channels: ["chan-1"],
    model: "haiku",
    effort: "low",
    skills,
    slashCommands: [],
    allowedModels: ["haiku", "sonnet", "opus"],
    soul: undefined,
    identity: undefined,
    skillsPath: "/tmp/skills",
  } as unknown as ResolvedAgentConfig;
}

function entry(
  name: string,
  category: "acme" | "personal" | "fleet" = "fleet",
): MarketplaceEntry {
  return Object.freeze({
    name,
    description: `desc-${name}`,
    category,
    source: "local" as const,
    skillDir: `/tmp/src/${name}`,
  });
}

function baseDeps(
  configs: ResolvedAgentConfig[],
  overrides: Partial<MarketplaceIpcDeps> = {},
): MarketplaceIpcDeps {
  return {
    configs,
    configPath: "/tmp/clawcode.yaml",
    marketplaceSources: [],
    localSkillsPath: "/tmp/skills",
    skillsTargetDir: "/tmp/skills",
    ledgerPath: "/tmp/ledger.jsonl",
    log: stubLogger(),
    ...overrides,
  };
}

describe("Phase 88 Plan 02 Task 1 — marketplace IPC handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // M1-M2 — handleMarketplaceListIpc
  // -------------------------------------------------------------------------

  it("M1: list — returns installed + available (catalog minus installed)", async () => {
    const configs = [makeAgent("clawdy", ["frontend-design"])];
    const catalog: readonly MarketplaceEntry[] = [
      entry("frontend-design"),
      entry("tuya-ac"),
      entry("new-reel"),
    ];
    const loadCatalog = vi.fn().mockResolvedValue(catalog);

    const deps = baseDeps(configs, { loadCatalog });
    const result = await handleMarketplaceListIpc({
      ...deps,
      params: { agent: "clawdy" },
    });

    expect(loadCatalog).toHaveBeenCalledTimes(1);
    expect(result.agent).toBe("clawdy");
    expect(result.installed).toEqual(["frontend-design"]);
    // available = catalog minus already-installed
    const availableNames = result.available.map((e) => e.name);
    expect(availableNames).toEqual(["tuya-ac", "new-reel"]);
  });

  it("M2: list — agent not found → ManagerError", async () => {
    const configs = [makeAgent("clawdy")];
    const deps = baseDeps(configs, {
      loadCatalog: vi.fn().mockResolvedValue([]),
    });
    await expect(
      handleMarketplaceListIpc({
        ...deps,
        params: { agent: "ghost" },
      }),
    ).rejects.toThrow(/Agent 'ghost' not found/);
  });

  // -------------------------------------------------------------------------
  // M3-M8 — handleMarketplaceInstallIpc
  // -------------------------------------------------------------------------

  it("M3: install happy — order: installSingleSkill → scanCatalog → linkSkills; rewired:true", async () => {
    const configs = [makeAgent("clawdy", [])];
    const catalog: readonly MarketplaceEntry[] = [entry("frontend-design")];
    const installed: SkillInstallOutcome = Object.freeze({
      kind: "installed" as const,
      skill: "frontend-design",
      targetPath: "/tmp/skills/frontend-design",
      targetHash: "a".repeat(64),
    });

    const callOrder: string[] = [];
    const loadCatalog = vi.fn(async () => {
      callOrder.push("loadCatalog");
      return catalog;
    });
    const installSkill = vi.fn(async () => {
      callOrder.push("installSkill");
      return installed;
    });
    const scanCatalog = vi.fn(async () => {
      callOrder.push("scanCatalog");
      return new Map() as SkillsCatalog;
    });
    const linkSkills = vi.fn(async () => {
      callOrder.push("linkSkills");
    });

    const deps = baseDeps(configs, {
      loadCatalog,
      installSkill,
      scanCatalog,
      linkSkills,
    });

    const result = await handleMarketplaceInstallIpc({
      ...deps,
      params: { agent: "clawdy", skill: "frontend-design" },
    });

    // Install runs, then rewire (scan → link)
    expect(callOrder).toEqual([
      "loadCatalog",
      "installSkill",
      "scanCatalog",
      "linkSkills",
    ]);
    expect(result.outcome).toEqual(installed);
    expect(result.rewired).toBe(true);
    // In-memory skills mirror updated
    expect(configs[0]!.skills).toEqual(["frontend-design"]);
  });

  it("M4: install — blocked-secret-scan → no rewire", async () => {
    const configs = [makeAgent("clawdy")];
    const catalog: readonly MarketplaceEntry[] = [entry("acme-crm")];
    const outcome: SkillInstallOutcome = Object.freeze({
      kind: "blocked-secret-scan" as const,
      skill: "acme-crm",
      offender: "SKILL.md:20 (high-entropy)",
    });
    const installSkill = vi.fn().mockResolvedValue(outcome);
    const scanCatalog = vi.fn().mockResolvedValue(new Map() as SkillsCatalog);
    const linkSkills = vi.fn();

    const deps = baseDeps(configs, {
      loadCatalog: vi.fn().mockResolvedValue(catalog),
      installSkill,
      scanCatalog,
      linkSkills,
    });

    const result = await handleMarketplaceInstallIpc({
      ...deps,
      params: { agent: "clawdy", skill: "acme-crm" },
    });

    expect(result.outcome).toEqual(outcome);
    expect(result.rewired).toBe(false);
    expect(scanCatalog).not.toHaveBeenCalled();
    expect(linkSkills).not.toHaveBeenCalled();
    expect(configs[0]!.skills).toEqual([]);
  });

  it("M5: install — rejected-scope → no rewire", async () => {
    const configs = [makeAgent("fin-research")];
    const catalog: readonly MarketplaceEntry[] = [entry("tuya-ac", "personal")];
    const outcome: SkillInstallOutcome = Object.freeze({
      kind: "rejected-scope" as const,
      skill: "tuya-ac",
      agent: "fin-research",
      skillScope: "personal" as const,
      agentScope: "acme" as const,
    });
    const installSkill = vi.fn().mockResolvedValue(outcome);
    const scanCatalog = vi.fn();
    const linkSkills = vi.fn();

    const deps = baseDeps(configs, {
      loadCatalog: vi.fn().mockResolvedValue(catalog),
      installSkill,
      scanCatalog,
      linkSkills,
    });
    const result = await handleMarketplaceInstallIpc({
      ...deps,
      params: { agent: "fin-research", skill: "tuya-ac" },
    });
    expect(result.outcome).toEqual(outcome);
    expect(result.rewired).toBe(false);
    expect(scanCatalog).not.toHaveBeenCalled();
    expect(linkSkills).not.toHaveBeenCalled();
  });

  it("M6: install — installed-persist-failed → rewire STILL runs (copy succeeded)", async () => {
    const configs = [makeAgent("clawdy")];
    const catalog: readonly MarketplaceEntry[] = [entry("frontend-design")];
    const outcome: SkillInstallOutcome = Object.freeze({
      kind: "installed-persist-failed" as const,
      skill: "frontend-design",
      targetPath: "/tmp/skills/frontend-design",
      targetHash: "a".repeat(64),
      persist_error: "EACCES",
    });
    const installSkill = vi.fn().mockResolvedValue(outcome);
    const scanCatalog = vi.fn().mockResolvedValue(new Map() as SkillsCatalog);
    const linkSkills = vi.fn();

    const deps = baseDeps(configs, {
      loadCatalog: vi.fn().mockResolvedValue(catalog),
      installSkill,
      scanCatalog,
      linkSkills,
    });
    const result = await handleMarketplaceInstallIpc({
      ...deps,
      params: { agent: "clawdy", skill: "frontend-design" },
    });
    expect(result.outcome).toEqual(outcome);
    expect(result.rewired).toBe(true);
    expect(scanCatalog).toHaveBeenCalledTimes(1);
    expect(linkSkills).toHaveBeenCalledTimes(1);
  });

  it("M7: install — not-in-catalog → no rewire", async () => {
    const configs = [makeAgent("clawdy")];
    const outcome: SkillInstallOutcome = Object.freeze({
      kind: "not-in-catalog" as const,
      skill: "does-not-exist",
    });
    const installSkill = vi.fn().mockResolvedValue(outcome);
    const scanCatalog = vi.fn();
    const linkSkills = vi.fn();

    const deps = baseDeps(configs, {
      loadCatalog: vi.fn().mockResolvedValue([]),
      installSkill,
      scanCatalog,
      linkSkills,
    });
    const result = await handleMarketplaceInstallIpc({
      ...deps,
      params: { agent: "clawdy", skill: "does-not-exist" },
    });
    expect(result.outcome).toEqual(outcome);
    expect(result.rewired).toBe(false);
    expect(scanCatalog).not.toHaveBeenCalled();
    expect(linkSkills).not.toHaveBeenCalled();
  });

  it("M8: install — agent not found → ManagerError BEFORE installSingleSkill fires", async () => {
    const configs = [makeAgent("clawdy")];
    const installSkill = vi.fn();
    const loadCatalog = vi.fn().mockResolvedValue([]);
    const deps = baseDeps(configs, { loadCatalog, installSkill });

    await expect(
      handleMarketplaceInstallIpc({
        ...deps,
        params: { agent: "ghost", skill: "frontend-design" },
      }),
    ).rejects.toBeInstanceOf(ManagerError);
    expect(installSkill).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // M9-M10 — handleMarketplaceRemoveIpc
  // -------------------------------------------------------------------------

  it("M9: remove happy — updateAgentSkills(op:'remove') → {removed:true, persisted:true}", async () => {
    const configs = [makeAgent("clawdy", ["tuya-ac"])];
    const updateSkills = vi.fn().mockResolvedValue({
      outcome: "updated" as const,
      destPath: "/tmp/clawcode.yaml",
      targetSha256: "a".repeat(64),
    });
    const deps = baseDeps(configs, { updateSkills });

    const result = await handleMarketplaceRemoveIpc({
      ...deps,
      params: { agent: "clawdy", skill: "tuya-ac" },
    });

    expect(updateSkills).toHaveBeenCalledTimes(1);
    expect(updateSkills).toHaveBeenCalledWith({
      existingConfigPath: "/tmp/clawcode.yaml",
      agentName: "clawdy",
      skillName: "tuya-ac",
      op: "remove",
    });
    expect(result).toMatchObject({
      agent: "clawdy",
      skill: "tuya-ac",
      removed: true,
      persisted: true,
      persist_error: null,
    });
    // In-memory skills list updated
    expect(configs[0]!.skills).toEqual([]);
  });

  it("M10: remove — updateAgentSkills throws EACCES → {removed:true, persisted:false, persist_error}", async () => {
    const configs = [makeAgent("clawdy", ["tuya-ac"])];
    const updateSkills = vi
      .fn()
      .mockRejectedValue(new Error("EACCES: simulated persist failure"));
    const deps = baseDeps(configs, { updateSkills });

    const result = await handleMarketplaceRemoveIpc({
      ...deps,
      params: { agent: "clawdy", skill: "tuya-ac" },
    });

    expect(result.removed).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.persist_error).toMatch(/EACCES/);
  });

  // -------------------------------------------------------------------------
  // M11 — IPC_METHODS extension
  // -------------------------------------------------------------------------

  it("M11: IPC_METHODS contains marketplace-list, marketplace-install, marketplace-remove", () => {
    const methods: readonly string[] = IPC_METHODS as unknown as readonly string[];
    expect(methods).toContain("marketplace-list");
    expect(methods).toContain("marketplace-install");
    expect(methods).toContain("marketplace-remove");
  });
});

describe("Phase 93 Plan 02 — defaultClawhubBaseUrl plumbing", () => {
  it("M12 handleMarketplaceListIpc forwards defaultClawhubBaseUrl to loadCatalog", async () => {
    const configs = [makeAgent("fin")];
    const loadCatalog = vi.fn().mockResolvedValue([] as readonly MarketplaceEntry[]);
    const deps = baseDeps(configs, {
      loadCatalog,
      defaultClawhubBaseUrl: "https://example.test",
    });

    await handleMarketplaceListIpc({
      ...deps,
      params: { agent: "fin" },
    });

    expect(loadCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultClawhubBaseUrl: "https://example.test" }),
    );
  });
});
