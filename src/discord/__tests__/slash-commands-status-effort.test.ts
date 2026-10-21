/**
 * Phase 83 Plan 03 Task 1 (RED→GREEN) — /clawcode-status daemon-side short-circuit.
 *
 * EFFORT-07: the /clawcode-status reply must include a "🎚️ Effort: <level>"
 * line pulled from sessionManager.getEffortForAgent(agentName). The daemon
 * answers this command directly (no agent turn consumed), mirroring the
 * existing clawcode-effort shortcut at slash-commands.ts:266.
 *
 * Also validates (Test 2): the REST registration body forwards `choices` when
 * present on the option — Discord won't render a dropdown unless the registered
 * command carries the choices field.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";
import { SlashCommandHandler } from "../slash-commands.js";
import type { SessionManager } from "../../manager/session-manager.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { RoutingTable } from "../types.js";

// -- REST mock plumbing ------------------------------------------------------
// We intercept the `new REST().setToken().put(...)` chain used by
// SlashCommandHandler.register() and capture the body sent to Discord.
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

// ----------------------------------------------------------------------------

function makeStubLogger(): Logger {
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

function makeAgent(name: string): ResolvedAgentConfig {
  return {
    name,
    workspace: `/tmp/${name}`,
    memoryPath: `/tmp/${name}`,
    channels: ["chan-1"],
    model: "haiku",
    effort: "low",
    skills: [],
    soul: undefined,
    identity: undefined,
    slashCommands: [],
    // Fill the rest via `as unknown as` for test ergonomics — the handler only
    // reads `name`, `model`, and `slashCommands` for the status path.
  } as unknown as ResolvedAgentConfig;
}

describe("Phase 83 UI-01 — registration body forwards choices", () => {
  beforeEach(() => {
    putSpy.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes a `choices` field on clawcode-effort.options[0] in the REST body", async () => {
    const agent = makeAgent("clawdy");
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    // Fake Client surface — just enough for register().
    const fakeClient = {
      user: { id: "app-id-1" },
      guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const handler = new SlashCommandHandler({
      routingTable,
      sessionManager: {} as unknown as SessionManager,
      resolvedAgents: [agent],
      botToken: "fake-token",
      client: fakeClient as never,
      log: makeStubLogger(),
    } as never);

    await handler.register();

    expect(putSpy).toHaveBeenCalledTimes(1);
    const putArgs = putSpy.mock.calls[0] as unknown as [
      unknown,
      { body: Array<{ name: string; options: Array<{ name: string; choices?: unknown }> }> },
    ];
    const payload = putArgs[1];
    const effortCmd = payload.body.find((c) => c.name === "clawcode-effort");
    expect(effortCmd).toBeDefined();
    // Phase 100 follow-up — clawcode-effort now carries 2 options:
    //   [0] level   (required, dropdown of 8 EFFORT_CHOICES)
    //   [1] agent   (optional, free-text — target agent for #admin-clawdy ops)
    expect(effortCmd!.options).toHaveLength(2);
    const levelOpt = effortCmd!.options[0];
    expect(levelOpt.name).toBe("level");
    expect(levelOpt.choices).toBeDefined();
    // 8 choices, matching EFFORT_CHOICES (quick 260715-j1j appended
    // "ultracode" LAST — index-stable).
    const choices = levelOpt.choices as Array<{ name: string; value: string }>;
    expect(choices).toHaveLength(8);
    expect(choices.map((c) => c.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "auto",
      "off",
      "ultracode",
    ]);
    const agentOpt = effortCmd!.options[1] as {
      name: string;
      required?: boolean;
      choices?: Array<{ name: string; value: string }>;
    };
    expect(agentOpt.name).toBe("agent");
    expect(agentOpt.required).toBe(false);
    // 2026-08-07 — REVERSED from Phase 100's "free-text by design". register()
    // now injects the resolved fleet as choices on every option named `agent`,
    // so the operator picks a target from a dropdown instead of typing a name
    // (typos previously returned "Unknown agent"). Fleets larger than
    // Discord's 25-choice cap still fall back to free text — see
    // slash-commands-native-clobber.test.ts.
    expect(agentOpt.choices).toEqual([{ name: "clawdy", value: "clawdy" }]);
    // Phase 100 follow-up — clawcode-effort ships with default_member_permissions
    // "0" so non-admin users don't see it in the slash menu. Operators apply
    // per-channel hiding manually post-deploy (Discord limitation: bots can't
    // set channel-level command permissions).
    const effortCmdWithPerms = effortCmd as unknown as {
      default_member_permissions?: string;
    };
    expect(effortCmdWithPerms.default_member_permissions).toBe("0");
  });

  it("only clawcode-effort gets default_member_permissions (back-compat for other commands)", async () => {
    const agent = makeAgent("clawdy");
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const fakeClient = {
      user: { id: "app-id-1" },
      guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const handler = new SlashCommandHandler({
      routingTable,
      sessionManager: {} as unknown as SessionManager,
      resolvedAgents: [agent],
      botToken: "fake-token",
      client: fakeClient as never,
      log: makeStubLogger(),
    } as never);

    await handler.register();

    const putArgs = putSpy.mock.calls[0] as unknown as [
      unknown,
      { body: Array<{ name: string; default_member_permissions?: string }> },
    ];
    const body = putArgs[1].body;
    let effortSeen = false;
    for (const cmd of body) {
      if (cmd.name === "clawcode-effort") {
        expect(cmd.default_member_permissions).toBe("0");
        effortSeen = true;
      } else {
        expect(cmd.default_member_permissions).toBeUndefined();
      }
    }
    expect(effortSeen).toBe(true);
  });

  it("does NOT add a `choices` field to options that don't have one (back-compat)", async () => {
    const agent = makeAgent("clawdy");
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const fakeClient = {
      user: { id: "app-id-1" },
      guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const handler = new SlashCommandHandler({
      routingTable,
      sessionManager: {} as unknown as SessionManager,
      resolvedAgents: [agent],
      botToken: "fake-token",
      client: fakeClient as never,
      log: makeStubLogger(),
    } as never);

    await handler.register();
    const putArgs2 = putSpy.mock.calls[0] as unknown as [
      unknown,
      { body: Array<{ name: string; options: Array<{ name: string; choices?: unknown }> }> },
    ];
    const payload = putArgs2[1];
    // clawcode-memory has a `query` option with no choices — it must stay clean.
    const memoryCmd = payload.body.find((c) => c.name === "clawcode-memory");
    expect(memoryCmd).toBeDefined();
    const queryOpt = memoryCmd!.options.find((o) => o.name === "query");
    expect(queryOpt).toBeDefined();
    expect("choices" in queryOpt!).toBe(false);
  });
});

describe("Phase 83 EFFORT-07 — /clawcode-status daemon-side short-circuit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replies with `Think: <level>` pulled from sessionManager.getEffortForAgent", async () => {
    // Phase 93 Plan 01 — renderer replaces the legacy `🎚️ Effort: <level>`
    // line with the OpenClaw-parity options line. Effort surfaces as
    // `Think: <level>` inside `⚙️ Runtime: SDK session · Runner: n/a · Think:
    // <level> · ...`. EFFORT-07's "no LLM turn" reliability win is preserved
    // — the data still flows from sessionManager.getEffortForAgent through
    // buildStatusData.
    const agent = makeAgent("clawdy");
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const getEffortForAgent = vi.fn().mockReturnValue("max");
    // Phase 86 MODEL-07 — /clawcode-status calls getModelForAgent.
    const getModelForAgent = vi.fn().mockReturnValue(undefined);
    // Phase 93 Plan 01 — buildStatusData additionally calls these.
    const getPermissionModeForAgent = vi.fn().mockReturnValue("default");
    const getSessionHandle = vi.fn().mockReturnValue(undefined);
    const sessionManager = {
      getEffortForAgent,
      getModelForAgent,
      getPermissionModeForAgent,
      getSessionHandle,
    } as unknown as SessionManager;

    const fakeClient = {
      user: { id: "app-id-1" },
      guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const handler = new SlashCommandHandler({
      routingTable,
      sessionManager,
      resolvedAgents: [agent],
      botToken: "fake-token",
      client: fakeClient as never,
      log: makeStubLogger(),
    } as never);

    const editReply = vi.fn().mockResolvedValue(undefined);
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      commandName: "clawcode-status",
      channelId: "chan-1",
      isChatInputCommand: () => true,
      deferReply,
      editReply,
      options: {
        get: () => null,
        getString: () => null,
      },
      user: { id: "user-1" },
      id: "interaction-1",
    };

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    expect(getEffortForAgent).toHaveBeenCalledWith("clawdy");
    expect(editReply).toHaveBeenCalled();
    const allContents = editReply.mock.calls.map((c) => String(c[0]));
    // Effort surfaces inside the options line as `Think: <level>`.
    const effortLineCall = allContents.find((s) => s.includes("Think: max"));
    expect(effortLineCall).toBeDefined();
  });

  it("includes the model in the status reply", async () => {
    // Phase 93 Plan 01 — agent name no longer appears in the rich block
    // (OpenClaw /status omits it; channel binding implies the agent). The
    // model is still pinned via the `🧠 Model:` line. Updated assertion
    // mirrors the new contract.
    const agent = makeAgent("clawdy");
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const getEffortForAgent = vi.fn().mockReturnValue("xhigh");
    const getModelForAgent = vi.fn().mockReturnValue(undefined);
    const getPermissionModeForAgent = vi.fn().mockReturnValue("default");
    const getSessionHandle = vi.fn().mockReturnValue(undefined);
    const sessionManager = {
      getEffortForAgent,
      getModelForAgent,
      getPermissionModeForAgent,
      getSessionHandle,
    } as unknown as SessionManager;

    const fakeClient = {
      user: { id: "app-id-1" },
      guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const handler = new SlashCommandHandler({
      routingTable,
      sessionManager,
      resolvedAgents: [agent],
      botToken: "fake-token",
      client: fakeClient as never,
      log: makeStubLogger(),
    } as never);

    const editReply = vi.fn().mockResolvedValue(undefined);
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      commandName: "clawcode-status",
      channelId: "chan-1",
      isChatInputCommand: () => true,
      deferReply,
      editReply,
      options: {
        get: () => null,
        getString: () => null,
      },
      user: { id: "user-1" },
      id: "interaction-1",
    };

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    const contents = editReply.mock.calls.map((c) => String(c[0])).join("\n");
    // Phase 93 Plan 01 — model surfaces via the `🧠 Model:` line; falls back
    // to resolved config alias when getModelForAgent returns undefined.
    expect(contents).toContain("🧠 Model: haiku");
    // Effort surfaces inside the options line as `Think: <level>`.
    expect(contents).toContain("Think: xhigh");
  });

  it("Pitfall 6 — getEffortForAgent throw collapses to `Think: unknown` (defensive read)", async () => {
    // Phase 93 Plan 01 — Pitfall 6 closure: the new renderer's
    // buildStatusData wraps every accessor in try/catch so a thrown
    // SessionError on getEffortForAgent collapses to "unknown" placeholders
    // INSTEAD OF dropping the whole render to the legacy "Failed to read
    // status: ..." string. This test pins that contract: throwing accessors
    // must NOT yield "Failed to read status" — they yield a 9-line block
    // with `Think: unknown` and `Permissions: unknown`.
    const agent = makeAgent("clawdy");
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const getEffortForAgent = vi.fn().mockImplementation(() => {
      throw new Error("agent not running");
    });
    const getModelForAgent = vi.fn().mockImplementation(() => {
      throw new Error("agent not running");
    });
    const getPermissionModeForAgent = vi.fn().mockImplementation(() => {
      throw new Error("agent not running");
    });
    const getSessionHandle = vi.fn().mockReturnValue(undefined);
    const sessionManager = {
      getEffortForAgent,
      getModelForAgent,
      getPermissionModeForAgent,
      getSessionHandle,
    } as unknown as SessionManager;

    const fakeClient = {
      user: { id: "app-id-1" },
      guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const handler = new SlashCommandHandler({
      routingTable,
      sessionManager,
      resolvedAgents: [agent],
      botToken: "fake-token",
      client: fakeClient as never,
      log: makeStubLogger(),
    } as never);

    const editReply = vi.fn().mockResolvedValue(undefined);
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      commandName: "clawcode-status",
      channelId: "chan-1",
      isChatInputCommand: () => true,
      deferReply,
      editReply,
      options: {
        get: () => null,
        getString: () => null,
      },
      user: { id: "user-1" },
      id: "interaction-1",
    };

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    const contents = editReply.mock.calls.map((c) => String(c[0])).join("\n");
    // Pitfall 6 closure — defensive read MUST suppress the legacy error path.
    expect(contents).not.toMatch(/Failed to read status/);
    // 9-line block still emits with placeholders.
    expect(contents).toContain("Think: unknown");
    expect(contents).toContain("Permissions: unknown");
    // Falls back to configModel ("haiku" from makeAgent) when liveModel throws.
    expect(contents).toContain("🧠 Model: haiku");
  });
});

// ---------------------------------------------------------------------------
// Quick 260715-j1j (D12) — ultracode reasoning label in /clawcode-status.
//
// effortToReasoningLabel("ultracode") → "xhigh + workflow orchestration",
// surfaced in the Runtime line as `Reasoning: <label>`. Same daemon-side
// short-circuit harness as EFFORT-07 above.
// ---------------------------------------------------------------------------
describe("quick 260715-j1j — /clawcode-status ultracode reasoning label", () => {
  it("renders 'Think: ultracode' and 'Reasoning: xhigh + workflow orchestration'", async () => {
    const agent = makeAgent("clawdy");
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const getEffortForAgent = vi.fn().mockReturnValue("ultracode");
    const getModelForAgent = vi.fn().mockReturnValue(undefined);
    const getPermissionModeForAgent = vi.fn().mockReturnValue("default");
    const getSessionHandle = vi.fn().mockReturnValue(undefined);
    const sessionManager = {
      getEffortForAgent,
      getModelForAgent,
      getPermissionModeForAgent,
      getSessionHandle,
    } as unknown as SessionManager;

    const fakeClient = {
      user: { id: "app-id-1" },
      guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const handler = new SlashCommandHandler({
      routingTable,
      sessionManager,
      resolvedAgents: [agent],
      botToken: "fake-token",
      client: fakeClient as never,
      log: makeStubLogger(),
    } as never);

    const editReply = vi.fn().mockResolvedValue(undefined);
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      commandName: "clawcode-status",
      channelId: "chan-1",
      isChatInputCommand: () => true,
      deferReply,
      editReply,
      options: {
        get: () => null,
        getString: () => null,
      },
      user: { id: "user-1" },
      id: "interaction-1",
    };

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    const contents = editReply.mock.calls.map((c) => String(c[0])).join("\n");
    expect(contents).toContain("Think: ultracode");
    expect(contents).toContain("Reasoning: xhigh + workflow orchestration");
  });
});
