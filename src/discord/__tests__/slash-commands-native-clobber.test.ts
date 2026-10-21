/**
 * 2026-08-07 RCA — native SDK commands must not clobber ClawCode's own rich
 * slash-command definitions, and `agent:` options must render as a picker.
 *
 * Regression being pinned: Phase 117.1-02 added `effort` and `model` to
 * ALLOWED_NATIVES, so buildNativeCommandDefs produced `clawcode-effort` /
 * `clawcode-model` with a single free-text `args` option, and CMD-04's
 * "native wins on name collision" rule let those overwrite the rich
 * DEFAULT_SLASH_COMMANDS entries. Live effect in prod: `/clawcode-effort`
 * registered with only `args`, so the handler's required `level` lookup was
 * always undefined (command unusable) and the `agent:` target option was gone
 * entirely — the operator had to ask Admin Clawdy to edit yaml + restart.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";
import { SlashCommandHandler } from "../slash-commands.js";
import type { SessionManager } from "../../manager/session-manager.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { RoutingTable } from "../types.js";
import type { SlashCommand } from "../../manager/sdk-types.js";

const putSpy = vi.fn(
  async (_route: unknown, _opts: { body: unknown }): Promise<unknown> => undefined,
);

vi.mock("discord.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("discord.js");
  class MockREST {
    setToken(_t: string): this { return this; }
    async put(route: unknown, opts: { body: unknown }): Promise<unknown> {
      return putSpy(route, opts);
    }
  }
  return {
    ...actual,
    REST: MockREST,
    Routes: {
      applicationGuildCommands: (appId: string, guildId: string) =>
        `/applications/${appId}/guilds/${guildId}/commands`,
    },
  };
});

function makeStubLogger(): Logger {
  const stub = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn(),
  };
  stub.child.mockReturnValue(stub);
  return stub as unknown as Logger;
}

function makeAgent(name: string): ResolvedAgentConfig {
  return {
    name,
    workspace: `/tmp/${name}`,
    memoryPath: `/tmp/${name}`,
    channels: [`chan-${name}`],
    model: "sonnet",
    effort: "high",
    skills: [],
    slashCommands: [],
  } as unknown as ResolvedAgentConfig;
}

type BodyCmd = {
  name: string;
  options?: Array<{ name: string; required?: boolean; choices?: Array<{ name: string; value: string }> }>;
};

/**
 * Registers with `sdkNames` reported by every agent's SDK handle and returns
 * the REST body Discord would have received.
 */
async function registerWith(
  agents: readonly ResolvedAgentConfig[],
  sdkNames: readonly string[],
): Promise<BodyCmd[]> {
  const sdkCommands: SlashCommand[] = sdkNames.map((n) => ({
    name: n,
    description: `native ${n}`,
    argumentHint: "<value>",
  })) as unknown as SlashCommand[];

  const routingTable: RoutingTable = {
    channelToAgent: new Map(agents.map((a) => [`chan-${a.name}`, a.name])),
    agentToChannels: new Map(agents.map((a) => [a.name, [`chan-${a.name}`]])),
  };
  const fakeClient = {
    user: { id: "app-1" },
    guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const handler = new SlashCommandHandler({
    routingTable,
    sessionManager: {
      getSessionHandle: () => ({
        getSupportedCommands: async () => sdkCommands,
      }),
    } as unknown as SessionManager,
    resolvedAgents: [...agents],
    botToken: "fake-token",
    client: fakeClient as never,
    log: makeStubLogger(),
    // Permissive ACL — avoids SECURITY.md filesystem reads in the test env.
    aclDeniedByAgent: new Map(agents.map((a) => [a.name, new Set<string>()])),
  } as never);

  await handler.register();
  const putArgs = putSpy.mock.calls[0] as unknown as [unknown, { body: BodyCmd[] }];
  return putArgs[1].body;
}

describe("2026-08-07 — native SDK commands must not clobber rich ClawCode defs", () => {
  beforeEach(() => putSpy.mockClear());
  afterEach(() => vi.restoreAllMocks());

  it("keeps /clawcode-effort's level dropdown + agent option when the SDK reports `effort`", async () => {
    const body = await registerWith([makeAgent("Admin Clawdy")], ["effort", "model"]);
    const effort = body.find((c) => c.name === "clawcode-effort");
    expect(effort).toBeDefined();
    const optNames = (effort?.options ?? []).map((o) => o.name);
    // The regression shape was exactly ["args"].
    expect(optNames).not.toEqual(["args"]);
    expect(optNames).toContain("level");
    expect(optNames).toContain("agent");
    const level = effort?.options?.find((o) => o.name === "level");
    expect(level?.required).toBe(true);
    expect((level?.choices ?? []).length).toBeGreaterThan(0);
  });

  it("keeps /clawcode-model's own options when the SDK reports `model`", async () => {
    const body = await registerWith([makeAgent("Admin Clawdy")], ["model"]);
    const model = body.find((c) => c.name === "clawcode-model");
    expect((model?.options ?? []).map((o) => o.name)).not.toEqual(["args"]);
  });

  it("still re-provides native commands ClawCode does NOT define (CMD-04 intent)", async () => {
    const body = await registerWith([makeAgent("Admin Clawdy")], ["cost"]);
    expect(body.some((c) => c.name === "clawcode-cost")).toBe(true);
  });
});

describe("2026-08-07 — dynamic agent: picker", () => {
  beforeEach(() => putSpy.mockClear());
  afterEach(() => vi.restoreAllMocks());

  it("injects the fleet as choices on every option named `agent`", async () => {
    const agents = [makeAgent("Admin Clawdy"), makeAgent("shopping"), makeAgent("client-a-personal")];
    const body = await registerWith(agents, []);
    const effortAgentOpt = body
      .find((c) => c.name === "clawcode-effort")
      ?.options?.find((o) => o.name === "agent");
    expect(effortAgentOpt).toBeDefined();
    expect((effortAgentOpt?.choices ?? []).map((c) => c.value)).toEqual([
      "Admin Clawdy",
      "shopping",
      "client-a-personal",
    ]);
  });

  it("leaves `agent` free-text when the fleet exceeds Discord's 25-choice cap", async () => {
    const agents = Array.from({ length: 26 }, (_, i) => makeAgent(`agent-${i}`));
    const body = await registerWith(agents, []);
    const effortAgentOpt = body
      .find((c) => c.name === "clawcode-effort")
      ?.options?.find((o) => o.name === "agent");
    expect(effortAgentOpt).toBeDefined();
    expect(effortAgentOpt?.choices).toBeUndefined();
  });

  it("does not touch options that already declare their own choices", async () => {
    const body = await registerWith([makeAgent("Admin Clawdy")], []);
    const level = body
      .find((c) => c.name === "clawcode-effort")
      ?.options?.find((o) => o.name === "level");
    // EFFORT_CHOICES, not agent names.
    expect((level?.choices ?? []).map((c) => c.value)).toContain("ultracode");
    expect((level?.choices ?? []).map((c) => c.value)).not.toContain("Admin Clawdy");
  });
});
