/**
 * Skill-slash-commands — SlashCommandHandler integration: opt-in registration,
 * wrong-channel ephemeral reject, and dispatch routing.
 *
 * Covers:
 *   - register() emits a `/<skill>` command for an opt-in skill and NOT for a
 *     non-opted-in skill.
 *   - register() skips a skill that collides with a static command.
 *   - handleInteraction rejects `/<skill>` (ephemeral, names the holding
 *     agent) when invoked in a channel whose agent does not have the skill.
 *   - handleInteraction dispatches the natural-language turn to the bound
 *     agent when the channel's agent DOES have the skill.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RoutingTable } from "../types.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { SessionManager } from "../../manager/session-manager.js";
import type { SkillEntry, SkillsCatalog } from "../../skills/types.js";

// vi.hoisted keeps the REST.put spy alive across the discord.js mock boundary.
const { restPutSpy } = vi.hoisted(() => ({
  restPutSpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("discord.js", async () => {
  const actual = await vi.importActual<typeof import("discord.js")>("discord.js");
  class MockREST {
    setToken(_token: string): this {
      return this;
    }
    put(route: string, opts: { body: unknown }): Promise<void> {
      return restPutSpy(route, opts);
    }
  }
  return { ...actual, REST: MockREST };
});

import { SlashCommandHandler } from "../slash-commands.js";

function makeAgent(name: string, skills: readonly string[]): ResolvedAgentConfig {
  return {
    name,
    workspace: `/tmp/${name}`,
    soulFile: `/tmp/${name}/SOUL.md`,
    identityFile: `/tmp/${name}/IDENTITY.md`,
    model: "sonnet",
    channels: [],
    soul: "",
    schedules: [],
    slashCommands: [],
    heartbeat: false,
    admin: false,
    effort: "low",
    reactions: true,
    mcpServers: [],
    skills,
  } as unknown as ResolvedAgentConfig;
}

function makeCatalog(
  entries: ReadonlyArray<Partial<SkillEntry> & { name: string }>,
): SkillsCatalog {
  const map = new Map<string, SkillEntry>();
  for (const e of entries) {
    map.set(e.name, {
      name: e.name,
      description: e.description ?? `desc for ${e.name}`,
      version: null,
      path: `/skills/${e.name}`,
      ...(e.slashCommand ? { slashCommand: true } : {}),
    });
  }
  return map;
}

function makeStubLogger() {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  return log;
}

function makeSessionManager(streamReply = "skill done"): {
  sessionManager: SessionManager;
  streamFromAgent: ReturnType<typeof vi.fn>;
} {
  const streamFromAgent = vi.fn().mockResolvedValue(streamReply);
  const sessionManager = {
    streamFromAgent,
    getEffortForAgent: vi.fn().mockReturnValue("medium"),
    setEffortForAgent: vi.fn(),
    getSessionHandle: vi.fn().mockReturnValue(undefined),
    getRateLimitTrackerForAgent: vi.fn().mockReturnValue(undefined),
  } as unknown as SessionManager;
  return { sessionManager, streamFromAgent };
}

const REEL_CHANNEL = "reel-channel";
const PLAIN_CHANNEL = "plain-channel";

const routingTable: RoutingTable = {
  channelToAgent: new Map([
    [REEL_CHANNEL, "reel-agent"],
    [PLAIN_CHANNEL, "plain-agent"],
  ]),
  agentToChannels: new Map([
    ["reel-agent", [REEL_CHANNEL]],
    ["plain-agent", [PLAIN_CHANNEL]],
  ]),
};

function makeHandler(opts: {
  resolvedAgents: readonly ResolvedAgentConfig[];
  sessionManager: SessionManager;
  skillsCatalog: SkillsCatalog;
  loadedSkillsByAgent?: ReadonlyMap<string, ReadonlySet<string>>;
}): SlashCommandHandler {
  const fakeClient = {
    user: { id: "app-1" },
    guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  return new SlashCommandHandler({
    routingTable,
    sessionManager: opts.sessionManager,
    resolvedAgents: opts.resolvedAgents,
    botToken: "fake-token",
    client: fakeClient as never,
    skillsCatalog: opts.skillsCatalog,
    loadedSkillsByAgent: opts.loadedSkillsByAgent,
    log: makeStubLogger(),
  } as never);
}

function makeInteraction(opts: {
  commandName: string;
  channelId: string;
  args?: string;
}): {
  reply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  deferReply: ReturnType<typeof vi.fn>;
  interaction: unknown;
} {
  const reply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    commandName: opts.commandName,
    channelId: opts.channelId,
    isChatInputCommand: () => true,
    reply,
    editReply,
    deferReply,
    options: {
      get: (name: string) =>
        name === "args" && opts.args !== undefined
          ? { value: opts.args }
          : null,
      getString: () => "",
      getSubcommand: () => null,
    },
    user: { id: "user-1" },
    id: "interaction-1",
  };
  return { reply, editReply, deferReply, interaction };
}

type HandlerInternals = {
  handleInteraction: (i: unknown) => Promise<void>;
};

describe("skill-slash-commands — register()", () => {
  beforeEach(() => {
    restPutSpy.mockClear();
    restPutSpy.mockResolvedValue(undefined);
  });

  it("registers a `/<skill>` command ONLY for an opt-in skill", async () => {
    const catalog = makeCatalog([
      { name: "reelforge", slashCommand: true },
      { name: "market-research" }, // no flag
    ]);
    const handler = makeHandler({
      resolvedAgents: [
        makeAgent("reel-agent", ["reelforge", "market-research"]),
      ],
      sessionManager: makeSessionManager().sessionManager,
      skillsCatalog: catalog,
    });

    await handler.register();

    expect(restPutSpy).toHaveBeenCalledTimes(1);
    const body = (restPutSpy.mock.calls[0][1] as { body: Array<{ name: string }> })
      .body;
    const names = body.map((b) => b.name);
    expect(names).toContain("reelforge");
    expect(names).not.toContain("market-research");
  });

  it("skips a skill that collides with a static command name", async () => {
    const catalog = makeCatalog([
      // `clawcode-memory` is a static DEFAULT_SLASH_COMMANDS name.
      { name: "clawcode-memory", slashCommand: true },
    ]);
    const handler = makeHandler({
      resolvedAgents: [makeAgent("reel-agent", ["clawcode-memory"])],
      sessionManager: makeSessionManager().sessionManager,
      skillsCatalog: catalog,
    });

    await handler.register();

    const body = (restPutSpy.mock.calls[0][1] as { body: Array<{ name: string }> })
      .body;
    // Exactly one clawcode-memory entry — the static one, not a skill dup.
    expect(body.filter((b) => b.name === "clawcode-memory")).toHaveLength(1);
  });
});

describe("skill-slash-commands — handleInteraction dispatch + gate", () => {
  beforeEach(() => {
    restPutSpy.mockClear();
    restPutSpy.mockResolvedValue(undefined);
  });

  it("rejects (ephemeral) when the channel's agent does not have the skill", async () => {
    const catalog = makeCatalog([{ name: "reelforge", slashCommand: true }]);
    const sm = makeSessionManager();
    const handler = makeHandler({
      resolvedAgents: [
        makeAgent("reel-agent", ["reelforge"]),
        makeAgent("plain-agent", []),
      ],
      sessionManager: sm.sessionManager,
      skillsCatalog: catalog,
    });
    await handler.register(); // populates the skill-command index

    const { reply, deferReply, interaction } = makeInteraction({
      commandName: "reelforge",
      channelId: PLAIN_CHANNEL, // plain-agent has no reelforge skill
    });
    await (handler as never as HandlerInternals).handleInteraction(interaction);

    expect(reply).toHaveBeenCalledTimes(1);
    const replyArg = reply.mock.calls[0][0] as {
      content: string;
      ephemeral: boolean;
    };
    expect(replyArg.ephemeral).toBe(true);
    // Names the agent that DOES have the skill.
    expect(replyArg.content).toContain("reel-agent");
    expect(replyArg.content).toContain("reelforge");
    // No turn dispatched, no public defer.
    expect(sm.streamFromAgent).not.toHaveBeenCalled();
    expect(deferReply).not.toHaveBeenCalled();
  });

  it("dispatches the natural-language turn when the channel's agent has the skill", async () => {
    const catalog = makeCatalog([{ name: "reelforge", slashCommand: true }]);
    const sm = makeSessionManager("reel built");
    const handler = makeHandler({
      resolvedAgents: [makeAgent("reel-agent", ["reelforge"])],
      sessionManager: sm.sessionManager,
      skillsCatalog: catalog,
    });
    await handler.register();

    const { deferReply, interaction } = makeInteraction({
      commandName: "reelforge",
      channelId: REEL_CHANNEL,
      args: "topic: compounding",
    });
    await (handler as never as HandlerInternals).handleInteraction(interaction);

    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(sm.streamFromAgent).toHaveBeenCalledTimes(1);
    const [agentName, message] = sm.streamFromAgent.mock.calls[0];
    expect(agentName).toBe("reel-agent");
    // SKILL.md-pointer template with {args} substituted.
    expect(message).toBe(
      "Read the skill instructions at skills/reelforge/SKILL.md (in your workspace) and follow them to complete this request. topic: compounding",
    );
  });

  it("gate rejects when the bound agent's skill was manifest-refused (loadedSkillsByAgent)", async () => {
    const catalog = makeCatalog([{ name: "reelforge", slashCommand: true }]);
    const sm = makeSessionManager();
    // reel-agent CONFIGURES reelforge but the manifest REFUSED it (empty
    // active set). plain-agent has it active — so the command IS registered
    // (union via plain-agent). Invoking it in reel-agent's channel must hit
    // the GATE carve-out and reject, naming plain-agent.
    const handler = makeHandler({
      resolvedAgents: [
        makeAgent("reel-agent", ["reelforge"]),
        makeAgent("plain-agent", ["reelforge"]),
      ],
      sessionManager: sm.sessionManager,
      skillsCatalog: catalog,
      loadedSkillsByAgent: new Map([
        ["reel-agent", new Set<string>()], // manifest-refused
        ["plain-agent", new Set(["reelforge"])],
      ]),
    });
    await handler.register();

    const { reply, interaction } = makeInteraction({
      commandName: "reelforge",
      channelId: REEL_CHANNEL, // reel-agent — refused → gate rejects
    });
    await (handler as never as HandlerInternals).handleInteraction(interaction);

    expect(reply).toHaveBeenCalledTimes(1);
    const replyArg = reply.mock.calls[0][0] as {
      content: string;
      ephemeral: boolean;
    };
    expect(replyArg.ephemeral).toBe(true);
    // Reject names the bound agent AND the agent that actually has it.
    expect(replyArg.content).toContain("reel-agent");
    expect(replyArg.content).toContain("plain-agent");
    expect(sm.streamFromAgent).not.toHaveBeenCalled();
  });

  it("rejects (ephemeral) when `/<skill>` is invoked in an unbound channel", async () => {
    const catalog = makeCatalog([{ name: "reelforge", slashCommand: true }]);
    const sm = makeSessionManager();
    const handler = makeHandler({
      resolvedAgents: [makeAgent("reel-agent", ["reelforge"])],
      sessionManager: sm.sessionManager,
      skillsCatalog: catalog,
    });
    await handler.register();

    const { reply, deferReply, interaction } = makeInteraction({
      commandName: "reelforge",
      channelId: "unbound-channel", // not in the routing table
    });
    await (handler as never as HandlerInternals).handleInteraction(interaction);

    expect(reply).toHaveBeenCalledTimes(1);
    const replyArg = reply.mock.calls[0][0] as {
      content: string;
      ephemeral: boolean;
    };
    expect(replyArg.ephemeral).toBe(true);
    expect(replyArg.content).toContain("not bound to an agent");
    // Still names the holder so the operator knows where to go.
    expect(replyArg.content).toContain("reel-agent");
    expect(deferReply).not.toHaveBeenCalled();
    expect(sm.streamFromAgent).not.toHaveBeenCalled();
  });
});
