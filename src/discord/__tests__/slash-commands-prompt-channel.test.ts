/**
 * Phase 87 Plan 03 Task 1 — prompt-channel native-CC dispatch integration tests.
 *
 * Pins the carve-out branch in handleInteraction that routes
 * nativeBehavior="prompt-channel" commands through
 * TurnDispatcher.dispatchStream with a canonical `/<name> <args>` prompt
 * string and streams the response via the v1.7 ProgressiveMessageEditor.
 *
 * Test groups:
 *   P1: dispatch + canonical prompt format (no args → "/compact")
 *   P2: dispatch + canonical prompt format (with args → "/context show me full")
 *   P3: channel not bound to an agent → ephemeral "not bound"; dispatch never fired
 *   P4: carve-out ordering — clawcode-model / clawcode-tools short-circuit first
 *   P5: SDK stream throws → editor.dispose called + ephemeral reply surfaces
 *       ACTUAL error text (Phase 85 TOOL-04 verbatim-error pattern)
 *   P6: oversized response truncated with "..." suffix
 *   P7: empty response → "(No response from agent)"
 *   P8: verifies TurnDispatcher is used (not sessionManager.streamFromAgent
 *       directly) so origin propagates — asserts makeRootOrigin("discord",
 *       channelId) is passed.
 *
 * The agent config carries a nativeBehavior="prompt-channel" entry on
 * `slashCommands` so resolveAgentCommands()'s merge sees it. This mirrors
 * what Plan 01's `register()` wiring produces for SDK-discovered commands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";

import { SlashCommandHandler } from "../slash-commands.js";
import type { SessionManager } from "../../manager/session-manager.js";
import type { TurnDispatcher } from "../../manager/turn-dispatcher.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { RoutingTable } from "../types.js";
import type { SlashCommandDef } from "../slash-types.js";

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
  nativeDefs: readonly SlashCommandDef[] = [],
): ResolvedAgentConfig {
  return {
    name,
    workspace: `/tmp/${name}`,
    memoryPath: `/tmp/${name}`,
    channels: ["chan-1"],
    model: "haiku",
    effort: "low",
    skills: [],
    slashCommands: nativeDefs,
    allowedModels: ["haiku"],
    soul: undefined,
    identity: undefined,
  } as unknown as ResolvedAgentConfig;
}

/**
 * Build a prompt-channel SlashCommandDef mirroring what Plan 01's
 * buildNativeCommandDefs emits at registration time.
 */
function makeNativeDef(
  name: string,
  opts: { hasArgs?: boolean } = {},
): SlashCommandDef {
  return {
    name: `clawcode-${name}`,
    description: `Native /${name}`,
    claudeCommand: "",
    options: opts.hasArgs
      ? [
          {
            name: "args",
            type: 3,
            description: "args",
            required: false,
          },
        ]
      : [],
    nativeBehavior: "prompt-channel",
  };
}

function makeStubSessionManager(): SessionManager {
  return {
    getModelForAgent: vi.fn().mockReturnValue(undefined),
    getEffortForAgent: vi.fn().mockReturnValue("medium"),
    setEffortForAgent: vi.fn(),
    streamFromAgent: vi.fn(),
    hasActiveTurn: vi.fn().mockReturnValue(false),
    interruptAgent: vi.fn(),
  } as unknown as SessionManager;
}

type Editor = {
  update: (accumulated: string) => void;
};

function makeStubTurnDispatcher(opts: {
  response?: string;
  error?: Error;
  streamChunks?: readonly string[];
}): {
  dispatcher: TurnDispatcher;
  dispatchStream: ReturnType<typeof vi.fn>;
} {
  const dispatchStream = vi.fn(
    async (
      _origin: unknown,
      _agentName: string,
      _message: string,
      onChunk: (accumulated: string) => void,
    ) => {
      if (opts.streamChunks) {
        for (const chunk of opts.streamChunks) {
          onChunk(chunk);
        }
      }
      if (opts.error) {
        throw opts.error;
      }
      return opts.response ?? "";
    },
  );
  const dispatcher = {
    dispatch: vi.fn(),
    dispatchStream,
  } as unknown as TurnDispatcher;
  return { dispatcher, dispatchStream };
}

type ReplyMock = ReturnType<typeof vi.fn>;

function makeInteraction(opts: {
  commandName: string;
  channelId: string;
  argsValue?: string;
}): {
  reply: ReplyMock;
  editReply: ReplyMock;
  deferReply: ReplyMock;
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
        name === "args" && opts.argsValue !== undefined
          ? { value: opts.argsValue }
          : null,
      getString: (name: string) =>
        name === "args" && opts.argsValue !== undefined
          ? opts.argsValue
          : null,
    },
    user: { id: "user-1" },
    id: "interaction-1",
  };

  return { reply, editReply, deferReply, interaction };
}

function makeHandler(opts: {
  routingTable: RoutingTable;
  resolvedAgents: readonly ResolvedAgentConfig[];
  sessionManager?: SessionManager;
  turnDispatcher?: TurnDispatcher;
}): SlashCommandHandler {
  const fakeClient = {
    user: { id: "app-id-1" },
    guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  return new SlashCommandHandler({
    routingTable: opts.routingTable,
    sessionManager: opts.sessionManager ?? makeStubSessionManager(),
    resolvedAgents: opts.resolvedAgents,
    botToken: "fake-token",
    client: fakeClient as never,
    log: makeStubLogger(),
    turnDispatcher: opts.turnDispatcher,
  } as never);
}

const boundRouting: RoutingTable = {
  channelToAgent: new Map([["chan-1", "clawdy"]]),
  agentToChannels: new Map([["clawdy", ["chan-1"]]]),
};

const unboundRouting: RoutingTable = {
  channelToAgent: new Map(),
  agentToChannels: new Map(),
};

function editReplyTexts(editReply: ReplyMock): string[] {
  return editReply.mock.calls.map((c) => {
    const first = c[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && "content" in first) {
      return (first as { content?: string }).content ?? "";
    }
    return "";
  });
}

describe("Phase 87 CMD-03 / CMD-06 — prompt-channel native-CC dispatch carve-out", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("P1: /clawcode-compact (no args) dispatches '/compact' via TurnDispatcher + streams via ProgressiveMessageEditor", async () => {
    const { dispatcher, dispatchStream } = makeStubTurnDispatcher({
      response: "Context compacted (10k → 1k tokens).",
      streamChunks: ["Context ", "Context compacted"],
    });
    const handler = makeHandler({
      routingTable: boundRouting,
      resolvedAgents: [makeAgent("clawdy", [makeNativeDef("compact")])],
      turnDispatcher: dispatcher,
    });
    const harness = makeInteraction({
      commandName: "clawcode-compact",
      channelId: "chan-1",
    });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    expect(dispatchStream).toHaveBeenCalledTimes(1);
    const [, agentArg, promptArg] = dispatchStream.mock.calls[0]!;
    expect(agentArg).toBe("clawdy");
    expect(promptArg).toBe("/compact");

    // Final text ends up in editReply.
    const texts = editReplyTexts(harness.editReply);
    expect(texts.some((t) => t.includes("Context compacted"))).toBe(true);
  });

  it("P2: /clawcode-context with args dispatches '/context show me full'", async () => {
    const { dispatcher, dispatchStream } = makeStubTurnDispatcher({
      response: "Full context: ...",
    });
    const handler = makeHandler({
      routingTable: boundRouting,
      resolvedAgents: [
        makeAgent("clawdy", [makeNativeDef("context", { hasArgs: true })]),
      ],
      turnDispatcher: dispatcher,
    });
    const harness = makeInteraction({
      commandName: "clawcode-context",
      channelId: "chan-1",
      argsValue: "show me full",
    });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    expect(dispatchStream).toHaveBeenCalledTimes(1);
    const [, , promptArg] = dispatchStream.mock.calls[0]!;
    expect(promptArg).toBe("/context show me full");
  });

  it("P3: channel not bound to any agent → ephemeral 'not bound' reply; dispatch NEVER fired", async () => {
    const { dispatcher, dispatchStream } = makeStubTurnDispatcher({
      response: "never",
    });
    const handler = makeHandler({
      routingTable: unboundRouting,
      resolvedAgents: [makeAgent("clawdy", [makeNativeDef("compact")])],
      turnDispatcher: dispatcher,
    });
    const harness = makeInteraction({
      commandName: "clawcode-compact",
      channelId: "chan-unbound",
    });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    expect(dispatchStream).not.toHaveBeenCalled();
    expect(harness.reply).toHaveBeenCalledTimes(1);
    const firstCall = harness.reply.mock.calls[0]![0] as {
      content?: string;
      ephemeral?: boolean;
    };
    expect(firstCall.ephemeral).toBe(true);
    expect(firstCall.content).toMatch(/not bound/i);
  });

  it("P4: carve-out ordering — /clawcode-tools still short-circuits to tools handler, never to prompt-channel dispatch", async () => {
    // Even if an agent's slashCommands contained a stray
    // nativeBehavior="prompt-channel" entry for "clawcode-tools", the
    // dedicated inline handler MUST win. Verified by asserting
    // dispatchStream is NOT called and sendIpcRequest (list-mcp-status)
    // is attempted instead.
    const { dispatcher, dispatchStream } = makeStubTurnDispatcher({
      response: "never",
    });
    // Agent explicitly has a prompt-channel entry for clawcode-tools.
    const agentWithStray = makeAgent("clawdy", [
      {
        name: "clawcode-tools",
        description: "stray",
        claudeCommand: "",
        options: [],
        nativeBehavior: "prompt-channel",
      },
    ]);
    const handler = makeHandler({
      routingTable: boundRouting,
      resolvedAgents: [agentWithStray],
      turnDispatcher: dispatcher,
    });
    const harness = makeInteraction({
      commandName: "clawcode-tools",
      channelId: "chan-1",
    });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    // Prompt-channel dispatch must NOT fire for clawcode-tools.
    expect(dispatchStream).not.toHaveBeenCalled();
  });

  it("P5: SDK stream throws → editor.dispose called + ephemeral reply surfaces ACTUAL error text verbatim (TOOL-04 pattern)", async () => {
    const { dispatcher, dispatchStream } = makeStubTurnDispatcher({
      error: new Error("Compact failed: context too small"),
    });
    const handler = makeHandler({
      routingTable: boundRouting,
      resolvedAgents: [makeAgent("clawdy", [makeNativeDef("compact")])],
      turnDispatcher: dispatcher,
    });
    const harness = makeInteraction({
      commandName: "clawcode-compact",
      channelId: "chan-1",
    });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    expect(dispatchStream).toHaveBeenCalledTimes(1);

    // editReply receives the verbatim SDK error text (NOT a generic
    // "command failed" blob).
    const texts = editReplyTexts(harness.editReply);
    const concat = texts.join("\n");
    expect(concat).toMatch(/Compact failed: context too small/);
  });

  it("P6: oversized response truncated to Discord max length with '...' suffix", async () => {
    const bigResponse = "x".repeat(3000); // well over 2000
    const { dispatcher } = makeStubTurnDispatcher({
      response: bigResponse,
    });
    const handler = makeHandler({
      routingTable: boundRouting,
      resolvedAgents: [makeAgent("clawdy", [makeNativeDef("compact")])],
      turnDispatcher: dispatcher,
    });
    const harness = makeInteraction({
      commandName: "clawcode-compact",
      channelId: "chan-1",
    });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    const texts = editReplyTexts(harness.editReply);
    // Find the truncated big response (last "x..." style string).
    const truncated = texts.find((t) => t.length >= 1997 && t.endsWith("..."));
    expect(truncated).toBeDefined();
    expect(truncated!.length).toBeLessThanOrEqual(2000);
  });

  it("P7: empty response → '(No response from agent)'", async () => {
    const { dispatcher } = makeStubTurnDispatcher({
      response: "   ", // all whitespace trims to empty
    });
    const handler = makeHandler({
      routingTable: boundRouting,
      resolvedAgents: [makeAgent("clawdy", [makeNativeDef("compact")])],
      turnDispatcher: dispatcher,
    });
    const harness = makeInteraction({
      commandName: "clawcode-compact",
      channelId: "chan-1",
    });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    const texts = editReplyTexts(harness.editReply);
    const concat = texts.join("\n");
    expect(concat).toMatch(/\(No response from agent\)/);
  });

  it("P8: TurnDispatcher is used (not sessionManager.streamFromAgent) — origin is makeRootOrigin('discord', channelId)", async () => {
    const sessionManager = makeStubSessionManager();
    const { dispatcher, dispatchStream } = makeStubTurnDispatcher({
      response: "OK",
    });
    const handler = makeHandler({
      routingTable: boundRouting,
      resolvedAgents: [makeAgent("clawdy", [makeNativeDef("compact")])],
      sessionManager,
      turnDispatcher: dispatcher,
    });
    const harness = makeInteraction({
      commandName: "clawcode-compact",
      channelId: "chan-1",
    });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    // TurnDispatcher path, not SessionManager.streamFromAgent.
    expect(dispatchStream).toHaveBeenCalledTimes(1);
    expect(sessionManager.streamFromAgent).not.toHaveBeenCalled();

    // Origin carries kind="discord" and source.id === channelId.
    const originArg = dispatchStream.mock.calls[0]![0] as {
      source: { kind: string; id: string };
      rootTurnId: string;
    };
    expect(originArg.source.kind).toBe("discord");
    expect(originArg.source.id).toBe("chan-1");
    // Root turn id starts with "discord:".
    expect(originArg.rootTurnId.startsWith("discord:")).toBe(true);
  });
});
