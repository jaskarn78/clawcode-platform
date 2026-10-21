/**
 * Phase 86 Plan 02 Task 2 — daemon IPC set-model handler tests (D1-D5).
 *
 * Drives the exported `handleSetModelIpc` pure function that the daemon's
 * `case "set-model":` delegates to. Mocks:
 *   - `SessionManager.setModelForAgent` via dependency injection
 *   - `updateAgentModel` via `vi.mock("../../migration/yaml-writer.js", ...)`
 *
 * Pins:
 *   D1: success — live swap first, YAML persist second, happy payload
 *   D2: allowlist rejection — ModelNotAllowedError surfaces as typed IPC error
 *   D3: persistence round-trip — post-success bytes reflect new model
 *   D4: persistence failure after live swap — no rollback, error recorded
 *   D5: agent not found — fast-fail, SessionManager NOT called
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// Hoisted mock handle for updateAgentModel — vi.mock is hoisted so we must
// reach it via a factory that captures a mutable ref.
const updateAgentModelMock = vi.fn();

vi.mock("../../migration/yaml-writer.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../migration/yaml-writer.js")
  >("../../migration/yaml-writer.js");
  return {
    ...actual,
    updateAgentModel: (...args: unknown[]) => updateAgentModelMock(...args),
  };
});

import {
  handleSetModelIpc,
  type SetModelIpcDeps,
} from "../daemon.js";
import { ManagerError } from "../../shared/errors.js";
import { ModelNotAllowedError } from "../model-errors.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { CatalogSnapshot } from "../model-resolver.js";
import type { ConfigModel } from "../../shared/model-catalog.js";

// Phase 999.114 — set-model now resolves `<family>@latest` against the
// discovered-model catalog, so the handler takes an injected snapshot + clock.
// These stubs keep the existing concrete-alias cases behaving exactly as before
// (an empty snapshot makes `resolveLatestModel` floor to the code pin).
const STUB_SNAPSHOT = (): CatalogSnapshot => [];
const STUB_NOW = () => 1_800_000_000_000;

// Phase 999.114 — widened from the 3-literal union to `ConfigModel` so fixtures
// can exercise historical pins and `<family>@latest` tracks.
function makeAgent(
  name: string,
  model: ConfigModel,
  allowedModels: ReadonlyArray<ConfigModel> = ["haiku", "sonnet", "opus"],
): ResolvedAgentConfig {
  return {
    name,
    workspace: `/tmp/${name}`,
    memoryPath: `/tmp/${name}`,
    channels: ["chan-1"],
    model,
    effort: "low",
    skills: [],
    slashCommands: [],
    allowedModels,
    soul: undefined,
    identity: undefined,
  } as unknown as ResolvedAgentConfig;
}

async function setupYamlFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cc-daemon-set-model-"));
  const configPath = join(dir, "clawcode.yaml");
  const yaml = `version: 1
defaults:
  model: sonnet
  basePath: ~/.clawcode/agents
agents:
  - name: clawdy
    workspace: ~/.clawcode/agents/clawdy
    model: haiku
    channels:
      - "111"
    mcpServers: []
`;
  await writeFile(configPath, yaml, "utf8");
  return configPath;
}

type ManagerStub = SetModelIpcDeps["manager"];

function makeManagerStub(
  // Phase 999.114 — optional: most cases only assert on the spy, and the
  // signature is now `ConfigModel` + the caller-resolved concrete id.
  setModelForAgent: (
    name: string,
    alias: ConfigModel,
    resolvedId?: string,
  ) => void = () => {},
): ManagerStub {
  const setAllAgentConfigs = vi.fn();
  return {
    setModelForAgent: vi.fn(setModelForAgent),
    setAllAgentConfigs,
  } as unknown as ManagerStub;
}

beforeEach(() => {
  updateAgentModelMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("handleSetModelIpc — Phase 86 Plan 02 (D1-D5)", () => {
  it("D1: success — calls setModelForAgent BEFORE updateAgentModel and returns persisted payload", async () => {
    const configPath = await setupYamlFixture();

    const configs: ResolvedAgentConfig[] = [makeAgent("clawdy", "haiku")];
    const callOrder: string[] = [];
    const manager = makeManagerStub((name, alias) => {
      callOrder.push(`setModel:${name}:${alias}`);
    });
    updateAgentModelMock.mockImplementationOnce((..._args: unknown[]) => {
      callOrder.push("updateAgentModel");
      return Promise.resolve({
        outcome: "updated",
        destPath: configPath,
        targetSha256: "a".repeat(64),
      });
    });

    const result = await handleSetModelIpc({
      manager,
      configs,
      configPath,
      catalogSnapshot: STUB_SNAPSHOT,
      nowMs: STUB_NOW,
      params: { agent: "clawdy", model: "sonnet" },
    });

    expect(manager.setModelForAgent).toHaveBeenCalledTimes(1);
    // Phase 999.114 — third arg is the caller-resolved concrete id, supplied
    // ONLY for a `<family>@latest` selection; `undefined` for a plain alias.
    expect(manager.setModelForAgent).toHaveBeenCalledWith("clawdy", "sonnet", undefined);
    expect(updateAgentModelMock).toHaveBeenCalledTimes(1);
    expect(updateAgentModelMock).toHaveBeenCalledWith({
      existingConfigPath: configPath,
      agentName: "clawdy",
      newModel: "sonnet",
    });
    // Order invariant: live swap BEFORE YAML persist
    expect(callOrder[0]).toMatch(/^setModel:/);
    expect(callOrder[1]).toBe("updateAgentModel");

    expect(result).toMatchObject({
      agent: "clawdy",
      old_model: "haiku",
      new_model: "sonnet",
      persisted: true,
      note: expect.stringMatching(/Live swap \+ clawcode\.yaml updated/),
    });
    // In-memory config updated too
    expect(manager.setAllAgentConfigs).toHaveBeenCalledTimes(1);
    expect(configs[0]!.model).toBe("sonnet");
  });

  // ─────────────────────────────────────────────────────────────────────
  // Phase 999.114 — `<family>@latest` live switch. Pre-999.114 this was
  // REJECTED outright ("config-time sugar"); it is now the mechanism by which
  // newly released models become available with no deploy.
  // ─────────────────────────────────────────────────────────────────────
  it("999.114: `fable@latest` resolves against the catalog for the LIVE swap but PERSISTS the tracking literal", async () => {
    const configPath = await setupYamlFixture();
    const configs: ResolvedAgentConfig[] = [
      makeAgent("clawdy", "haiku", ["haiku", "fable", "fable@latest"]),
    ];
    const manager = makeManagerStub();
    updateAgentModelMock.mockImplementation(() =>
      Promise.resolve({
        outcome: "updated",
        destPath: configPath,
        targetSha256: "a".repeat(64),
      }),
    );
    const NOW = 1_800_000_000_000;
    // A freshly-seen Fable newer than the code pin, plus two rows that MUST be
    // ignored: a CLI selector token and a long-stale row.
    const snapshot: CatalogSnapshot = [
      { model_id: "claude-fable-5-2", display_name: "Fable 5.2", family: "fable", last_seen_at: NOW },
      { model_id: "claude-fable-5[1m]", display_name: "sel", family: "fable", last_seen_at: NOW },
      { model_id: "claude-fable-9", display_name: "pulled", family: "fable", last_seen_at: NOW - 60 * 24 * 60 * 60 * 1000 },
    ];

    const result = await handleSetModelIpc({
      manager,
      configs,
      configPath,
      catalogSnapshot: () => snapshot,
      nowMs: () => NOW,
      params: { agent: "clawdy", model: "fable@latest" },
    });

    // LIVE swap targets the concrete, fresh, selectable winner...
    expect(manager.setModelForAgent).toHaveBeenCalledWith(
      "clawdy",
      "fable@latest",
      "claude-fable-5-2",
    );
    // ...and the value written to clawcode.yaml is the TRACKING literal, so the
    // agent keeps following the family instead of being silently frozen.
    expect(updateAgentModelMock).toHaveBeenCalledWith({
      existingConfigPath: configPath,
      agentName: "clawdy",
      newModel: "fable@latest",
    });
    expect(result).toMatchObject({ new_model: "fable@latest", persisted: true });
    expect(configs[0]!.model).toBe("fable@latest");
  });

  it("999.114: `@latest` floors to the code pin when the catalog has nothing fresh or selectable", async () => {
    const configPath = await setupYamlFixture();
    const configs: ResolvedAgentConfig[] = [
      makeAgent("clawdy", "haiku", ["haiku", "fable@latest"]),
    ];
    const manager = makeManagerStub();
    const NOW = 1_800_000_000_000;
    await handleSetModelIpc({
      manager,
      configs,
      configPath,
      // Only unselectable / stale rows — neither may win.
      catalogSnapshot: (): CatalogSnapshot => [
        { model_id: "fable", display_name: "bare alias", family: "fable", last_seen_at: NOW },
        { model_id: "claude-fable-7", display_name: "stale", family: "fable", last_seen_at: NOW - 60 * 24 * 60 * 60 * 1000 },
      ],
      nowMs: () => NOW,
      params: { agent: "clawdy", model: "fable@latest" },
    });
    // Floors to the pinned alias id — never to a bare name or a withdrawn model.
    expect(manager.setModelForAgent).toHaveBeenCalledWith(
      "clawdy",
      "fable@latest",
      "claude-fable-5-1",
    );
  });

  it("D2: allowlist rejection — ModelNotAllowedError maps to typed IPC error; updateAgentModel NOT called", async () => {
    const configPath = await setupYamlFixture();
    const configs: ResolvedAgentConfig[] = [
      makeAgent("clawdy", "haiku", ["haiku", "sonnet"]),
    ];
    const manager = makeManagerStub(() => {
      throw new ModelNotAllowedError("clawdy", "opus", ["haiku", "sonnet"]);
    });

    let caught: unknown;
    try {
      await handleSetModelIpc({
        manager,
        configs,
        configPath,
        catalogSnapshot: STUB_SNAPSHOT,
        nowMs: STUB_NOW,
        params: { agent: "clawdy", model: "opus" },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ManagerError);
    const me = caught as ManagerError & { code?: number; data?: unknown };
    expect(me.code).toBe(-32602);
    expect(me.data).toMatchObject({
      kind: "model-not-allowed",
      agent: "clawdy",
      attempted: "opus",
      allowed: ["haiku", "sonnet"],
    });
    expect(me.message).toMatch(/not in the allowed list/i);
    // YAML persist must NOT fire when live swap refuses
    expect(updateAgentModelMock).not.toHaveBeenCalled();
    // In-memory config must NOT be mutated
    expect(configs[0]!.model).toBe("haiku");
  });

  it("D3: persistence round-trip — re-reading the YAML shows the new model", async () => {
    // This test uses the REAL updateAgentModel (not mocked) to exercise the
    // round-trip path end-to-end. We use the actual implementation by
    // delegating from the mock to the real function.
    updateAgentModelMock.mockImplementationOnce(async (...args: unknown[]) => {
      const real = await vi.importActual<
        typeof import("../../migration/yaml-writer.js")
      >("../../migration/yaml-writer.js");
      return real.updateAgentModel(
        args[0] as Parameters<typeof real.updateAgentModel>[0],
      );
    });

    const configPath = await setupYamlFixture();
    const configs: ResolvedAgentConfig[] = [makeAgent("clawdy", "haiku")];
    const manager = makeManagerStub(() => {
      /* pass */
    });

    const result = await handleSetModelIpc({
      manager,
      configs,
      configPath,
      catalogSnapshot: STUB_SNAPSHOT,
      nowMs: STUB_NOW,
      params: { agent: "clawdy", model: "sonnet" },
    });

    expect(result).toMatchObject({ persisted: true });

    // Simulate restart by re-reading the bytes on disk
    const after = await readFile(configPath, "utf8");
    const parsed = parseYaml(after) as {
      agents: Array<{ name: string; model: string }>;
    };
    expect(parsed.agents[0]).toMatchObject({ name: "clawdy", model: "sonnet" });
  });

  it("D4: persistence failure after live swap — no rollback; error surfaced in response", async () => {
    const configPath = await setupYamlFixture();
    updateAgentModelMock.mockRejectedValueOnce(
      new Error("EACCES: simulated rename failure"),
    );

    const configs: ResolvedAgentConfig[] = [makeAgent("clawdy", "haiku")];
    let liveSwapCalled = 0;
    const manager = makeManagerStub(() => {
      liveSwapCalled++;
    });

    const result = await handleSetModelIpc({
      manager,
      configs,
      configPath,
      catalogSnapshot: STUB_SNAPSHOT,
      nowMs: STUB_NOW,
      params: { agent: "clawdy", model: "sonnet" },
    });

    // Live swap still fired once (irreversible — documented non-rollback)
    expect(liveSwapCalled).toBe(1);
    expect(updateAgentModelMock).toHaveBeenCalledTimes(1);
    // Response reflects partial state — persisted: false, error surfaced
    expect(result).toMatchObject({
      agent: "clawdy",
      old_model: "haiku",
      new_model: "sonnet",
      persisted: false,
    });
    const note = (result as { note: string }).note;
    expect(note).toMatch(/Live swap OK; persistence failed/);
    expect((result as { persist_error: string | null }).persist_error).toMatch(
      /EACCES/,
    );
  });

  it("D5: agent not found — throws ManagerError fast; SessionManager NOT called", async () => {
    const configPath = await setupYamlFixture();
    const configs: ResolvedAgentConfig[] = [makeAgent("clawdy", "haiku")];
    const manager = makeManagerStub(() => {
      /* should never be reached */
    });

    await expect(
      handleSetModelIpc({
        manager,
        configs,
        configPath,
        catalogSnapshot: STUB_SNAPSHOT,
        nowMs: STUB_NOW,
        params: { agent: "ghost", model: "sonnet" },
      }),
    ).rejects.toThrow(/Agent 'ghost' not found/);

    expect(manager.setModelForAgent).not.toHaveBeenCalled();
    expect(updateAgentModelMock).not.toHaveBeenCalled();
  });
});
