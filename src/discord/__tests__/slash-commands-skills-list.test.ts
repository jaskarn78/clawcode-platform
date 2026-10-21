/**
 * Phase 88 Plan 02 Task 2 — /clawcode-skills inline handler tests (L1-L6).
 *
 * Pins the installed-list view + native StringSelectMenuBuilder remove
 * picker. Mirrors /clawcode-skills-browse shape but drives the remove
 * IPC path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";

vi.mock("../../ipc/client.js", () => ({
  sendIpcRequest: vi.fn(),
}));

import { SlashCommandHandler } from "../slash-commands.js";
import { sendIpcRequest } from "../../ipc/client.js";
import type { SessionManager } from "../../manager/session-manager.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { RoutingTable } from "../types.js";

const mockedSendIpcRequest = vi.mocked(sendIpcRequest);

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

function makeAgent(name: string): ResolvedAgentConfig {
  return {
    name,
    workspace: `/tmp/${name}`,
    memoryPath: `/tmp/${name}`,
    channels: ["chan-1"],
    model: "haiku",
    effort: "low",
    skills: [],
    slashCommands: [],
    allowedModels: ["haiku", "sonnet", "opus"],
    soul: undefined,
    identity: undefined,
  } as unknown as ResolvedAgentConfig;
}

function stubSessionManager(): SessionManager {
  return {
    getModelForAgent: vi.fn().mockReturnValue(undefined),
    getEffortForAgent: vi.fn().mockReturnValue("medium"),
  } as unknown as SessionManager;
}

type ReplyMock = ReturnType<typeof vi.fn>;

function makeInteraction(opts: {
  channelId: string;
  awaitMessageComponent?: (args: unknown) => Promise<unknown>;
}): {
  reply: ReplyMock;
  editReply: ReplyMock;
  deferReply: ReplyMock;
  awaitMessageComponent: ReturnType<typeof vi.fn>;
  interaction: unknown;
} {
  const reply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const awaitMessageComponent = vi.fn(
    opts.awaitMessageComponent ??
      (async () => {
        throw new Error("awaitMessageComponent not mocked");
      }),
  );

  const interaction = {
    commandName: "clawcode-skills",
    channelId: opts.channelId,
    isChatInputCommand: () => true,
    reply,
    editReply,
    deferReply,
    channel: { awaitMessageComponent },
    options: {
      get: () => null,
      getString: () => null,
    },
    user: { id: "user-1" },
    id: "interaction-1",
  };

  return { reply, editReply, deferReply, awaitMessageComponent, interaction };
}

function makeHandler(opts: {
  routingTable: RoutingTable;
  resolvedAgents: readonly ResolvedAgentConfig[];
}): SlashCommandHandler {
  const fakeClient = {
    user: { id: "app-id-1" },
    guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  return new SlashCommandHandler({
    routingTable: opts.routingTable,
    sessionManager: stubSessionManager(),
    resolvedAgents: opts.resolvedAgents,
    botToken: "fake-token",
    client: fakeClient as never,
    log: stubLogger(),
  } as never);
}

const boundRouting: RoutingTable = {
  channelToAgent: new Map([["chan-1", "clawdy"]]),
  agentToChannels: new Map([["clawdy", ["chan-1"]]]),
};

function extractReplyContent(mockCalls: unknown[][]): string {
  return mockCalls
    .map((c) => {
      const first = c[0];
      return typeof first === "string"
        ? first
        : (first as { content?: string }).content ?? "";
    })
    .join("\n");
}

describe("Phase 88 MKT-07 / UI-01 — /clawcode-skills inline handler", () => {
  beforeEach(() => {
    mockedSendIpcRequest.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("L1: unbound channel → ephemeral 'not bound'; no IPC call", async () => {
    const handler = makeHandler({
      routingTable: { channelToAgent: new Map(), agentToChannels: new Map() },
      resolvedAgents: [makeAgent("clawdy")],
    });
    const harness = makeInteraction({ channelId: "unbound" });
    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    expect(mockedSendIpcRequest).not.toHaveBeenCalled();
    const combined = extractReplyContent([
      ...harness.reply.mock.calls,
      ...harness.editReply.mock.calls,
    ]);
    expect(combined).toMatch(/not bound/i);
  });

  it("L2: empty installed list → helpful message pointing at the dashboard Marketplace (skills-browse retired 2026-09-23)", async () => {
    mockedSendIpcRequest.mockResolvedValue({
      agent: "clawdy",
      installed: [],
      available: [],
    });
    const handler = makeHandler({
      routingTable: boundRouting,
      resolvedAgents: [makeAgent("clawdy")],
    });
    const harness = makeInteraction({ channelId: "chan-1" });
    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    const combined = extractReplyContent(harness.editReply.mock.calls);
    expect(combined).toMatch(/no skills installed|no installed skills/i);
    expect(combined).toMatch(/Marketplace/);
    expect(combined).not.toMatch(/skills-browse/);
  });

  it("L3: installed list → header + remove picker with one option per skill", async () => {
    mockedSendIpcRequest.mockResolvedValue({
      agent: "clawdy",
      installed: ["frontend-design", "tuya-ac"],
      available: [],
    });
    const handler = makeHandler({
      routingTable: boundRouting,
      resolvedAgents: [makeAgent("clawdy")],
    });
    const harness = makeInteraction({
      channelId: "chan-1",
      awaitMessageComponent: () => new Promise(() => {}),
    });
    void (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);
    await new Promise((r) => setTimeout(r, 5));

    const componentCall = harness.editReply.mock.calls.find(
      (c) =>
        typeof c[0] === "object" &&
        (c[0] as { components?: unknown }).components !== undefined,
    )?.[0] as {
      content?: string;
      components?: ReadonlyArray<{
        components: ReadonlyArray<{
          options: ReadonlyArray<{ data: { value: string } }>;
        }>;
      }>;
    };
    expect(componentCall).toBeDefined();
    // Content mentions installed-list header + the bound agent
    expect(componentCall.content).toMatch(/clawdy/);
    expect(componentCall.content).toMatch(/installed/i);
    // Menu has both installed skills
    const menu = componentCall.components![0]!.components[0]!;
    const values = menu.options.map((o) => o.data.value);
    expect(values).toEqual(["frontend-design", "tuya-ac"]);
  });

  it("L4: select → marketplace-remove happy path replies 'Removed **skill** from agent'", async () => {
    mockedSendIpcRequest
      .mockResolvedValueOnce({
        agent: "clawdy",
        installed: ["frontend-design", "tuya-ac"],
        available: [],
      })
      .mockResolvedValueOnce({
        agent: "clawdy",
        skill: "tuya-ac",
        removed: true,
        persisted: true,
        persist_error: null,
      });

    const handler = makeHandler({
      routingTable: boundRouting,
      resolvedAgents: [makeAgent("clawdy")],
    });
    const followUp = {
      values: ["tuya-ac"],
      user: { id: "user-1" },
      customId: "skills-remove:clawdy:abc",
      update: vi.fn().mockResolvedValue(undefined),
    };
    const harness = makeInteraction({
      channelId: "chan-1",
      awaitMessageComponent: async () => followUp,
    });
    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    expect(mockedSendIpcRequest).toHaveBeenCalledTimes(2);
    expect(mockedSendIpcRequest.mock.calls[1]![1]).toBe("marketplace-remove");
    expect(mockedSendIpcRequest.mock.calls[1]![2]).toEqual({
      agent: "clawdy",
      skill: "tuya-ac",
    });

    const combined = extractReplyContent(harness.editReply.mock.calls);
    expect(combined).toMatch(/removed/i);
    expect(combined).toMatch(/tuya-ac/);
    expect(combined).toMatch(/clawdy/);
  });

  it("L5: select → remove persist failed renders warning about YAML write", async () => {
    mockedSendIpcRequest
      .mockResolvedValueOnce({
        agent: "clawdy",
        installed: ["tuya-ac"],
        available: [],
      })
      .mockResolvedValueOnce({
        agent: "clawdy",
        skill: "tuya-ac",
        removed: true,
        persisted: false,
        persist_error: "EACCES: permission denied",
      });

    const handler = makeHandler({
      routingTable: boundRouting,
      resolvedAgents: [makeAgent("clawdy")],
    });
    const followUp = {
      values: ["tuya-ac"],
      user: { id: "user-1" },
      customId: "skills-remove:clawdy:abc",
      update: vi.fn().mockResolvedValue(undefined),
    };
    const harness = makeInteraction({
      channelId: "chan-1",
      awaitMessageComponent: async () => followUp,
    });
    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    const combined = extractReplyContent(harness.editReply.mock.calls);
    expect(combined).toMatch(/removed/i);
    expect(combined).toMatch(/tuya-ac/);
    expect(combined).toMatch(/persist|yaml|EACCES/i);
  });

  it("L6: picker timeout → 'timed out'; no remove IPC call", async () => {
    mockedSendIpcRequest.mockResolvedValueOnce({
      agent: "clawdy",
      installed: ["tuya-ac"],
      available: [],
    });
    const handler = makeHandler({
      routingTable: boundRouting,
      resolvedAgents: [makeAgent("clawdy")],
    });
    const harness = makeInteraction({
      channelId: "chan-1",
      awaitMessageComponent: async () => {
        throw Object.assign(new Error("collector timeout"), {
          name: "InteractionCollectorError",
        });
      },
    });
    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    // Only marketplace-list was called — no remove
    expect(mockedSendIpcRequest).toHaveBeenCalledTimes(1);
    expect(mockedSendIpcRequest.mock.calls[0]![1]).toBe("marketplace-list");

    const combined = extractReplyContent(harness.editReply.mock.calls);
    expect(combined).toMatch(/timed out/i);
  });
});
