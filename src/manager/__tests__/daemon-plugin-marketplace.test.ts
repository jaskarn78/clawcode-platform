/**
 * Phase 90 Plan 05 HUB-02 / HUB-04 — daemon plugin marketplace IPC handler tests (DM-P1..P5).
 *
 * Drives the two exported pure functions the daemon delegates to:
 *   - handleMarketplaceListPluginsIpc
 *   - handleMarketplaceInstallPluginIpc
 *
 * Pins:
 *   DM-P1: list plugins happy — installed + available (catalog minus installed)
 *   DM-P2: install plugin happy — fetches manifest → calls installer → installed outcome
 *   DM-P3: install config-missing propagated from installer
 *   DM-P4: install rate-limited → outcome propagated via mapFetchErrorToOutcome
 *   DM-P5: agent not found → ManagerError; no install attempted
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";

import {
  handleMarketplaceListPluginsIpc,
  handleMarketplaceInstallPluginIpc,
  type MarketplacePluginsIpcDeps,
} from "../daemon.js";
import { ManagerError } from "../../shared/errors.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type {
  ClawhubPluginListItem,
  ClawhubPluginsResponse,
} from "../../marketplace/clawhub-client.js";
import { ClawhubRateLimitedError } from "../../marketplace/clawhub-client.js";
import type { PluginInstallOutcome } from "../../marketplace/install-plugin.js";
import { createClawhubCache } from "../../marketplace/clawhub-cache.js";

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
  mcpServers: readonly (
    | string
    | { name: string; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
  )[] = [],
): ResolvedAgentConfig {
  return {
    name,
    workspace: `/tmp/ws-${name}`,
    memoryPath: `/tmp/mem-${name}`,
    channels: ["chan-1"],
    model: "haiku",
    effort: "low",
    skills: [],
    slashCommands: [],
    allowedModels: ["haiku", "sonnet", "opus"],
    mcpServers,
  } as unknown as ResolvedAgentConfig;
}

function pluginItem(
  name: string,
  overrides: Partial<ClawhubPluginListItem> = {},
): ClawhubPluginListItem {
  return Object.freeze({
    name,
    latestVersion: "1.0.0",
    displayName: name,
    summary: `summary-${name}`,
    runtimeId: name,
    family: "code-plugin",
    ...overrides,
  });
}

function baseDeps(
  configs: ResolvedAgentConfig[],
  overrides: Partial<MarketplacePluginsIpcDeps> = {},
): MarketplacePluginsIpcDeps {
  return {
    configs,
    configPath: "/tmp/clawcode.yaml",
    clawhubBaseUrl: "http://localhost/mock",
    clawhubAuthToken: undefined,
    cache: createClawhubCache<ClawhubPluginsResponse>(60_000),
    log: stubLogger(),
    ...overrides,
  };
}

describe("Phase 90 Plan 05 — plugin marketplace IPC handlers", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  // ---------------------------------------------------------------------
  // DM-P1 — handleMarketplaceListPluginsIpc
  // ---------------------------------------------------------------------

  it("DM-P1: list — returns installed + available (catalog minus installed)", async () => {
    const configs = [
      makeAgent("clawdy", [
        // One installed as a YAMLMap inline def
        {
          name: "existing-plugin",
          command: "cmd",
          args: [],
          env: {},
        },
      ]),
    ];
    const response: ClawhubPluginsResponse = Object.freeze({
      items: Object.freeze([
        pluginItem("existing-plugin"),
        pluginItem("new-plugin"),
        pluginItem("another-plugin"),
      ]),
      nextCursor: null,
    });
    const fetchPlugins = vi.fn().mockResolvedValue(response);

    const deps = baseDeps(configs, { fetchPlugins });
    const result = await handleMarketplaceListPluginsIpc({
      ...deps,
      params: { agent: "clawdy" },
    });

    expect(fetchPlugins).toHaveBeenCalledTimes(1);
    expect(result.agent).toBe("clawdy");
    expect(result.installed).toEqual(["existing-plugin"]);
    const availableNames = result.available.map((p) => p.name);
    expect(availableNames).toEqual(["new-plugin", "another-plugin"]);
  });

  it("DM-P1b: list — string-ref mcpServers entries counted as installed", async () => {
    const configs = [makeAgent("clawdy", ["acme-db" as unknown as string])];
    const response: ClawhubPluginsResponse = Object.freeze({
      items: Object.freeze([
        pluginItem("acme-db"),
        pluginItem("new-plugin"),
      ]),
      nextCursor: null,
    });
    const deps = baseDeps(configs, {
      fetchPlugins: vi.fn().mockResolvedValue(response),
    });
    const result = await handleMarketplaceListPluginsIpc({
      ...deps,
      params: { agent: "clawdy" },
    });
    expect(result.installed).toEqual(["acme-db"]);
    expect(result.available.map((p) => p.name)).toEqual(["new-plugin"]);
  });

  it("DM-P5: list — agent not found → ManagerError", async () => {
    const configs = [makeAgent("clawdy")];
    const deps = baseDeps(configs, {
      fetchPlugins: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    });
    await expect(
      handleMarketplaceListPluginsIpc({
        ...deps,
        params: { agent: "ghost" },
      }),
    ).rejects.toThrow(/Agent 'ghost' not found/);
  });

  it("DM-P4: list — rate-limited fetch → empty available (fail open)", async () => {
    const configs = [makeAgent("clawdy")];
    const fetchPlugins = vi
      .fn()
      .mockRejectedValue(new ClawhubRateLimitedError(30_000, "rate-limited"));
    const deps = baseDeps(configs, { fetchPlugins });
    const result = await handleMarketplaceListPluginsIpc({
      ...deps,
      params: { agent: "clawdy" },
    });
    expect(result.available).toHaveLength(0);
    expect(result.installed).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // DM-P2 / DM-P3 — handleMarketplaceInstallPluginIpc
  // ---------------------------------------------------------------------

  it("DM-P2: install plugin happy — list → downloadManifest → installPlugin → installed", async () => {
    const configs = [makeAgent("clawdy")];
    const response: ClawhubPluginsResponse = Object.freeze({
      items: Object.freeze([
        pluginItem("test-plugin", {
          manifestUrl: "http://example.com/manifest",
        }),
      ]),
      nextCursor: null,
    });
    const manifest = Object.freeze({
      name: "test-plugin",
      description: "desc",
      version: "1.2.3",
      command: "my-cmd",
      args: Object.freeze([]),
      env: {},
    });
    const fetchPlugins = vi.fn().mockResolvedValue(response);
    const downloadManifest = vi.fn().mockResolvedValue(manifest);
    const installPlugin = vi.fn().mockResolvedValue(
      Object.freeze({
        kind: "installed",
        plugin: "test-plugin",
        pluginVersion: "1.2.3",
        entry: {
          name: "test-plugin",
          command: "my-cmd",
          args: [],
          env: {},
        },
      }) as PluginInstallOutcome,
    );

    const deps = baseDeps(configs, {
      fetchPlugins,
      downloadManifest,
      installPlugin,
    });
    const outcome = await handleMarketplaceInstallPluginIpc({
      ...deps,
      params: {
        agent: "clawdy",
        plugin: "test-plugin",
        configInputs: {},
      },
    });

    expect(fetchPlugins).toHaveBeenCalledTimes(1);
    expect(downloadManifest).toHaveBeenCalledTimes(1);
    expect(downloadManifest.mock.calls[0]![0]).toMatchObject({
      manifestUrl: "http://example.com/manifest",
    });
    expect(installPlugin).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("installed");
  });

  it("DM-P3: install config-missing — outcome propagated from installer", async () => {
    const configs = [makeAgent("clawdy")];
    const response: ClawhubPluginsResponse = Object.freeze({
      items: Object.freeze([pluginItem("test-plugin")]),
      nextCursor: null,
    });
    const manifest = Object.freeze({
      name: "test-plugin",
      description: "",
      version: "1.0.0",
      command: "cmd",
      args: Object.freeze([]),
      env: {
        REQUIRED_FIELD: {
          default: null,
          required: true,
          sensitive: false,
        },
      },
    });
    const deps = baseDeps(configs, {
      fetchPlugins: vi.fn().mockResolvedValue(response),
      downloadManifest: vi.fn().mockResolvedValue(manifest),
      installPlugin: vi.fn().mockResolvedValue(
        Object.freeze({
          kind: "config-missing",
          plugin: "test-plugin",
          missing_field: "REQUIRED_FIELD",
        }) as PluginInstallOutcome,
      ),
    });
    const outcome = await handleMarketplaceInstallPluginIpc({
      ...deps,
      params: { agent: "clawdy", plugin: "test-plugin", configInputs: {} },
    });
    expect(outcome.kind).toBe("config-missing");
    if (outcome.kind === "config-missing") {
      expect(outcome.missing_field).toBe("REQUIRED_FIELD");
    }
  });

  it("DM-P4: install plugin not in catalog → not-in-catalog", async () => {
    const configs = [makeAgent("clawdy")];
    const deps = baseDeps(configs, {
      fetchPlugins: vi.fn().mockResolvedValue({
        items: [pluginItem("other-plugin")],
        nextCursor: null,
      }),
      downloadManifest: vi.fn(),
      installPlugin: vi.fn(),
    });
    const outcome = await handleMarketplaceInstallPluginIpc({
      ...deps,
      params: { agent: "clawdy", plugin: "missing-plugin", configInputs: {} },
    });
    expect(outcome.kind).toBe("not-in-catalog");
  });

  it("DM-P4b: install rate-limited → outcome propagated via mapFetchErrorToOutcome", async () => {
    const configs = [makeAgent("clawdy")];
    const deps = baseDeps(configs, {
      fetchPlugins: vi
        .fn()
        .mockRejectedValue(new ClawhubRateLimitedError(45_000, "rate-limited")),
    });
    const outcome = await handleMarketplaceInstallPluginIpc({
      ...deps,
      params: { agent: "clawdy", plugin: "any", configInputs: {} },
    });
    expect(outcome.kind).toBe("rate-limited");
    if (outcome.kind === "rate-limited") {
      expect(outcome.retryAfterMs).toBe(45_000);
    }
  });

  it("DM-P5: install — agent not found → ManagerError; no install attempted", async () => {
    const configs = [makeAgent("clawdy")];
    const installPlugin = vi.fn();
    const deps = baseDeps(configs, { installPlugin });
    await expect(
      handleMarketplaceInstallPluginIpc({
        ...deps,
        params: { agent: "ghost", plugin: "any", configInputs: {} },
      }),
    ).rejects.toThrow(/Agent 'ghost' not found/);
    expect(installPlugin).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Phase 93 Plan 03 — fallback URL regression (DPM-93-1)
  //
  // The handler at daemon.ts:1116-1118 implements:
  //   const manifestUrl =
  //     item.manifestUrl ??
  //     `${baseUrl}/api/v1/plugins/${encodeURIComponent(item.name)}/manifest`;
  //
  // This regression pin ensures item.manifestUrl is preferred when present
  // and the fallback fires only when item.manifestUrl is undefined. Per
  // RESEARCH §Pitfall 5, the fallback URL is intentionally NOT modified —
  // every probed URL shape returns 404 for unpublished plugins like
  // hivemind, and the registry is the source of truth. Changing the
  // fallback would just relocate the 404.
  // -----------------------------------------------------------------------
  describe("Phase 93 Plan 03 — fallback URL regression", () => {
    it("DPM-93-1 prefers item.manifestUrl when present, falls back only when undefined", async () => {
      const configs = [makeAgent("clawdy")];

      // --- Case A: item.manifestUrl SET → that exact URL is used ---
      const respWithUrl: ClawhubPluginsResponse = Object.freeze({
        items: Object.freeze([
          pluginItem("with-url", {
            manifestUrl: "https://override.example/manifest",
          }),
        ]),
        nextCursor: null,
      });
      const manifestA = Object.freeze({
        name: "with-url",
        description: "",
        version: "1.0.0",
        command: "cmd",
        args: Object.freeze([]),
        env: {},
      });
      const dlA = vi.fn().mockResolvedValue(manifestA);
      const installA = vi.fn().mockResolvedValue(
        Object.freeze({
          kind: "installed",
          plugin: "with-url",
          pluginVersion: "1.0.0",
          entry: { name: "with-url", command: "cmd", args: [], env: {} },
        }) as PluginInstallOutcome,
      );
      const depsA = baseDeps(configs, {
        fetchPlugins: vi.fn().mockResolvedValue(respWithUrl),
        downloadManifest: dlA,
        installPlugin: installA,
      });
      await handleMarketplaceInstallPluginIpc({
        ...depsA,
        params: { agent: "clawdy", plugin: "with-url", configInputs: {} },
      });
      expect(dlA).toHaveBeenCalledTimes(1);
      expect(dlA.mock.calls[0]![0]).toMatchObject({
        manifestUrl: "https://override.example/manifest",
      });

      // --- Case B: item.manifestUrl UNDEFINED → fallback URL is used ---
      // pluginItem() helper omits manifestUrl by default, so this exercises
      // the `??` fallback branch verbatim.
      const respWithoutUrl: ClawhubPluginsResponse = Object.freeze({
        items: Object.freeze([pluginItem("no-url")]),
        nextCursor: null,
      });
      const manifestB = Object.freeze({
        name: "no-url",
        description: "",
        version: "1.0.0",
        command: "cmd",
        args: Object.freeze([]),
        env: {},
      });
      const dlB = vi.fn().mockResolvedValue(manifestB);
      const installB = vi.fn().mockResolvedValue(
        Object.freeze({
          kind: "installed",
          plugin: "no-url",
          pluginVersion: "1.0.0",
          entry: { name: "no-url", command: "cmd", args: [], env: {} },
        }) as PluginInstallOutcome,
      );
      const depsB = baseDeps(configs, {
        fetchPlugins: vi.fn().mockResolvedValue(respWithoutUrl),
        downloadManifest: dlB,
        installPlugin: installB,
      });
      await handleMarketplaceInstallPluginIpc({
        ...depsB,
        params: { agent: "clawdy", plugin: "no-url", configInputs: {} },
      });
      expect(dlB).toHaveBeenCalledTimes(1);
      const fallbackArg = dlB.mock.calls[0]![0] as { manifestUrl: string };
      // Baseline URL trimmed + canonical path; encodeURIComponent ensures
      // identifier-shaped names round-trip unchanged. baseUrl in baseDeps
      // is "http://localhost/mock" (trailing-slash safe).
      expect(fallbackArg.manifestUrl).toBe(
        "http://localhost/mock/api/v1/plugins/no-url/manifest",
      );
    });
  });
});
