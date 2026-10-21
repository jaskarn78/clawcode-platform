/**
 * Phase 86 Plan 02 Task 2 — /clawcode-status MODEL-07 live-handle source.
 *
 * Pins:
 *   S1: /clawcode-status reads the model from sessionManager.getModelForAgent
 *       (the live handle's current model) after a setModel swap.
 *   S2: When getModelForAgent returns undefined (fresh boot, no setModel call
 *       yet), the reply falls back to resolvedAgents.find().model.
 *
 * Mirrors the Phase 83 slash-commands-status-effort.test.ts scaffolding so
 * the two suites stay in lockstep.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Logger } from "pino";
import { SlashCommandHandler } from "../slash-commands.js";
import type { SessionManager } from "../../manager/session-manager.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { RoutingTable } from "../types.js";

// -- REST mock plumbing ------------------------------------------------------
// Mirrors slash-commands-status-effort.test.ts — we don't exercise register()
// in this suite, but the mock prevents real HTTP traffic if test bleed happens.
vi.mock("discord.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("discord.js");
  class MockREST {
    setToken(_t: string): this { return this; }
    async put(_route: unknown, _opts: { body: unknown }): Promise<unknown> {
      return undefined;
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
  model: "haiku" | "sonnet" | "opus",
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
    allowedModels: ["haiku", "sonnet", "opus"],
    soul: undefined,
    identity: undefined,
  } as unknown as ResolvedAgentConfig;
}

type InteractionLike = {
  commandName: string;
  channelId: string;
  isChatInputCommand: () => boolean;
  deferReply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  options: {
    get: () => null;
    getString: () => null;
  };
  user: { id: string };
  id: string;
};

function makeInteraction(): InteractionLike {
  return {
    commandName: "clawcode-status",
    channelId: "chan-1",
    isChatInputCommand: () => true,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    options: {
      get: () => null,
      getString: () => null,
    },
    user: { id: "user-1" },
    id: "interaction-1",
  };
}

describe("Phase 86 MODEL-07 — /clawcode-status sources model from live handle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("S1: replies with `🧠 Model: <live>` pulled from getModelForAgent after a setModel swap", async () => {
    const agent = makeAgent("clawdy", "haiku"); // static config says haiku
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const getEffortForAgent = vi.fn().mockReturnValue("medium");
    // Live handle reflects a post-setModel("opus") swap — MUST override static.
    const getModelForAgent = vi.fn().mockReturnValue("opus");
    // Phase 93 Plan 01 — buildStatusData calls these new accessors; without
    // them the defensive try/catch wrapper would still emit "unknown" but
    // the spy assertions need real values to pin model-source semantics.
    const getPermissionModeForAgent = vi.fn().mockReturnValue("default");
    const getSessionHandle = vi.fn().mockReturnValue({
      sessionId: "abcdef0123456789abcdef0123456789",
      hasActiveTurn: () => false,
    });
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

    const interaction = makeInteraction();
    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    expect(getModelForAgent).toHaveBeenCalledWith("clawdy");
    const contents = interaction.editReply.mock.calls
      .map((c) => String(c[0]))
      .join("\n");
    // Phase 93 Plan 01 — renderer emits "🧠 Model:" (was "🤖 Model:" pre-93).
    expect(contents).toContain("🧠 Model: opus");
    // Static config was "haiku" — live swap must WIN.
    expect(contents).not.toMatch(/🧠 Model: haiku/);
  });

  it("S2: falls back to resolved-config model when getModelForAgent returns undefined", async () => {
    const agent = makeAgent("clawdy", "sonnet"); // static config says sonnet
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const getEffortForAgent = vi.fn().mockReturnValue("low");
    const getModelForAgent = vi.fn().mockReturnValue(undefined);
    const getPermissionModeForAgent = vi.fn().mockReturnValue("default");
    const getSessionHandle = vi.fn().mockReturnValue({
      sessionId: "abcdef0123456789abcdef0123456789",
      hasActiveTurn: () => false,
    });
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

    const interaction = makeInteraction();
    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    expect(getModelForAgent).toHaveBeenCalledWith("clawdy");
    const contents = interaction.editReply.mock.calls
      .map((c) => String(c[0]))
      .join("\n");
    // Fell back to resolvedAgents.find().model — the config-declared alias.
    // Phase 93 Plan 01 — renderer emits "🧠 Model:" (was "🤖 Model:" pre-93).
    expect(contents).toContain("🧠 Model: sonnet");
  });
});

// ---------------------------------------------------------------------------
// Phase 93 Plan 01 — S3 + S4: rich-block parity + defensive read.
//
// S3 pins the 9-line OpenClaw-parity block when the handle is healthy.
// S4 pins defensive reads — throwing accessors + missing handle still
// produce a 9-line block, never the legacy "Failed to read status" string.
// ---------------------------------------------------------------------------
describe("/clawcode-status — Phase 93 rich-block parity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("S3 renders all 9 OpenClaw-parity lines when handle is healthy", async () => {
    const agent = makeAgent("fin", "sonnet");
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "fin"]]),
      agentToChannels: new Map([["fin", ["chan-1"]]]),
    };
    const sessionManager = {
      getEffortForAgent: vi.fn().mockReturnValue("medium"),
      getModelForAgent: vi.fn().mockReturnValue("sonnet"),
      getPermissionModeForAgent: vi.fn().mockReturnValue("default"),
      getSessionHandle: vi.fn().mockReturnValue({
        sessionId: "01234567-89ab-cdef-0123-4567890abcdef",
        hasActiveTurn: () => false,
      }),
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

    const interaction = {
      ...makeInteraction(),
      channelId: "chan-1",
    };
    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const reply = String(interaction.editReply.mock.calls[0]![0]);
    expect(typeof reply).toBe("string");
    for (const prefix of [
      "🦞 ClawCode",
      "🧠 Model:",
      "🔄 Fallbacks:",
      "📚 Context:",
      "🧮 Tokens:",
      "🧵 Session:",
      "📋 Task:",
      "⚙️ Runtime:",
      "👥 Activation:",
    ]) {
      expect(reply).toContain(prefix);
    }
    expect(reply.split("\n")).toHaveLength(9);
    expect(reply).not.toContain("Failed to read status");
  });

  it("S4 defensive read — throwing accessors still render 9 lines with placeholders", async () => {
    const agent = makeAgent("fin", "haiku");
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "fin"]]),
      agentToChannels: new Map([["fin", ["chan-1"]]]),
    };
    const sessionManager = {
      getEffortForAgent: vi.fn(() => {
        throw new Error("agent not running");
      }),
      getModelForAgent: vi.fn(() => {
        throw new Error("agent not running");
      }),
      getPermissionModeForAgent: vi.fn(() => {
        throw new Error("agent not running");
      }),
      getSessionHandle: vi.fn().mockReturnValue(undefined),
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

    const interaction = {
      ...makeInteraction(),
      channelId: "chan-1",
    };
    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const reply = String(interaction.editReply.mock.calls[0]![0]);
    expect(reply.split("\n")).toHaveLength(9);
    expect(reply).not.toContain("Failed to read status");
    expect(reply).toContain("Session: unknown");
    expect(reply).toContain("Task: idle");
    // Falls back to configModel (resolvedAgents.find().model) when liveModel
    // accessor throws — agent was constructed with "haiku".
    expect(reply).toContain("Model: haiku");
  });
});
