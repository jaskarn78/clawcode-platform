/**
 * Phase 95 Plan 03 Task 1 (RED) — `/clawcode-dream` Discord slash tests.
 *
 * Mirrors slash-commands-tools.test.ts: mocks `sendIpcRequest` BEFORE
 * importing slash-commands.ts so the inline handler picks up the stub.
 *
 * Pins:
 *   DSL1: non-admin invocation → ephemeral "Admin-only command" reply WITHOUT IPC call
 *   DSL2: admin invocation → IPC call run-dream-pass made; reply is ephemeral embed
 *   DSL3: outcome.kind='completed' embed → green color, description=themedReflection
 *         (truncated 4000), fields populate counts + cost line + log path
 *   DSL4: outcome.kind='skipped' embed → yellow color, "(no result — see fields below)"
 *   DSL5: outcome.kind='failed' embed → red color, error in Outcome field
 *   DSL6: handler is INLINE-SHORT-CIRCUIT (placed BEFORE CONTROL_COMMANDS dispatch)
 *   DSL7: agent option registered as required string option
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";

// Mock the IPC client BEFORE importing slash-commands so the in-module
// `sendIpcRequest` reference is replaced by the stub.
vi.mock("../../ipc/client.js", () => ({
  sendIpcRequest: vi.fn(),
}));

import {
  SlashCommandHandler,
  renderDreamEmbed,
  isAdminClawdyInteraction,
} from "../slash-commands.js";
import { sendIpcRequest } from "../../ipc/client.js";
import type { SessionManager } from "../../manager/session-manager.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { RoutingTable } from "../types.js";

const mockedSendIpcRequest = vi.mocked(sendIpcRequest);

const ADMIN_USER_ID = "admin-clawdy-id";
const NON_ADMIN_USER_ID = "rando-user-id";

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
  } as unknown as ResolvedAgentConfig;
}

function makeHandler(opts: {
  routingTable: RoutingTable;
}): SlashCommandHandler {
  const fakeClient = {
    user: { id: "app-id-1" },
    guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  return new SlashCommandHandler({
    routingTable: opts.routingTable,
    sessionManager: {} as unknown as SessionManager,
    resolvedAgents: [makeAgent("fin-client")],
    botToken: "fake-token",
    client: fakeClient as never,
    log: makeStubLogger(),
    adminUserIds: [ADMIN_USER_ID],
  } as never);
}

function makeInteraction(opts: {
  agentArg: string;
  userId: string;
}): {
  editReply: ReturnType<typeof vi.fn>;
  deferReply: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  interaction: unknown;
} {
  const editReply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    commandName: "clawcode-dream",
    channelId: "chan-1",
    isChatInputCommand: () => true,
    deferReply,
    editReply,
    reply,
    options: {
      get: (name: string) =>
        name === "agent" ? { value: opts.agentArg } : null,
      getString: (name: string, _required?: boolean) =>
        name === "agent" ? opts.agentArg : null,
    },
    user: { id: opts.userId },
    id: "interaction-1",
  };
  return { editReply, deferReply, reply, interaction };
}

const completedResp = {
  agent: "fin-client",
  startedAt: "2026-04-25T12:00:00Z",
  outcome: {
    kind: "completed" as const,
    result: {
      newWikilinks: [],
      promotionCandidates: [],
      themedReflection: "A short themed reflection paragraph.",
      suggestedConsolidations: [],
    },
    durationMs: 1234,
    tokensIn: 100,
    tokensOut: 50,
    model: "haiku",
  },
  applied: {
    kind: "applied" as const,
    appliedWikilinkCount: 3,
    surfacedPromotionCount: 2,
    surfacedConsolidationCount: 1,
    logPath: "/tmp/dreams/2026-04-25.md",
  },
};

describe("Phase 95 Plan 03 — /clawcode-dream slash command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("DSL1: non-admin user → run-dream-pass dispatched (NO LONGER admin-gated, operator request 2026-06-02)", async () => {
    mockedSendIpcRequest.mockResolvedValue(completedResp);
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "fin-client"]]),
      agentToChannels: new Map([["fin-client", ["chan-1"]]]),
    };
    const handler = makeHandler({ routingTable });
    const { reply, deferReply, interaction } = makeInteraction({
      agentArg: "fin-client",
      userId: NON_ADMIN_USER_ID,
    });

    await (
      handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }
    ).handleInteraction(interaction);

    // /clawcode-dream is now open to all — a non-admin proceeds to the IPC call
    // instead of receiving "Admin-only command".
    expect(mockedSendIpcRequest).toHaveBeenCalledTimes(1);
    expect(mockedSendIpcRequest.mock.calls[0]![1]).toBe("run-dream-pass");
    expect(deferReply).toHaveBeenCalled();
    const adminRejected = reply.mock.calls.some((c) =>
      ((c[0] as { content?: string })?.content ?? "").toLowerCase().includes("admin"),
    );
    expect(adminRejected).toBe(false);
  });

  it("DSL2: admin user → IPC call run-dream-pass dispatched; reply is ephemeral embed", async () => {
    mockedSendIpcRequest.mockResolvedValue(completedResp);
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "fin-client"]]),
      agentToChannels: new Map([["fin-client", ["chan-1"]]]),
    };
    const handler = makeHandler({ routingTable });
    const { editReply, deferReply, interaction } = makeInteraction({
      agentArg: "fin-client",
      userId: ADMIN_USER_ID,
    });

    await (
      handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }
    ).handleInteraction(interaction);

    expect(mockedSendIpcRequest).toHaveBeenCalledTimes(1);
    const ipcCall = mockedSendIpcRequest.mock.calls[0]!;
    expect(ipcCall[1]).toBe("run-dream-pass");
    // Ephemeral defer
    expect(deferReply).toHaveBeenCalled();
    const deferArg = deferReply.mock.calls[0]![0] as
      | { ephemeral?: boolean; flags?: number }
      | undefined;
    // Either ephemeral:true (legacy) or flags === MessageFlags.Ephemeral (1<<6 = 64)
    expect(deferArg?.ephemeral === true || deferArg?.flags === 64).toBe(true);
    expect(editReply).toHaveBeenCalled();
    const editArg = editReply.mock.calls[0]![0] as { embeds?: unknown[] };
    expect(Array.isArray(editArg.embeds)).toBe(true);
    expect((editArg.embeds ?? []).length).toBe(1);
  });

  it("DSL3: completed embed → green, description=themedReflection (truncated 4000), counts + cost + log fields", () => {
    const longReflection = "x".repeat(5000);
    const resp = {
      ...completedResp,
      outcome: { ...completedResp.outcome, themedReflection: longReflection },
    };
    const embed = renderDreamEmbed("fin-client", resp);
    const data = embed.toJSON() as {
      title?: string;
      color?: number;
      description?: string;
      fields?: { name: string; value: string }[];
    };
    expect(data.color).toBe(0x2ecc71);
    expect(data.description?.length).toBeLessThanOrEqual(4000);
    expect(data.title).toContain("fin-client");
    const fieldNames = (data.fields ?? []).map((f) => f.name);
    expect(fieldNames).toEqual(
      expect.arrayContaining([
        "Outcome",
        "Wikilinks",
        "Promotion candidates",
        "Consolidations",
        "Cost",
        "Log",
      ]),
    );
    const costField = (data.fields ?? []).find((f) => f.name === "Cost")!;
    expect(costField.value).toContain("100");
    expect(costField.value).toContain("50");
    expect(costField.value).toContain("haiku");
    const logField = (data.fields ?? []).find((f) => f.name === "Log")!;
    expect(logField.value).toContain("/tmp/dreams/2026-04-25.md");
  });

  it("DSL4: skipped embed → yellow color, '(no result — see fields below)' description, skip reason in Outcome", () => {
    const resp = {
      agent: "fin-client",
      startedAt: "2026-04-25T12:00:00Z",
      outcome: { kind: "skipped" as const, reason: "disabled" as const },
      applied: {
        kind: "skipped" as const,
        reason: "no-completed-result" as const,
      },
    };
    const embed = renderDreamEmbed("fin-client", resp);
    const data = embed.toJSON() as {
      color?: number;
      description?: string;
      fields?: { name: string; value: string }[];
    };
    expect(data.color).toBe(0xf1c40f);
    expect(data.description).toContain("no result");
    const outcomeField = (data.fields ?? []).find((f) => f.name === "Outcome")!;
    expect(outcomeField.value).toContain("disabled");
  });

  it("DSL5: failed embed → red color, error in Outcome", () => {
    const resp = {
      agent: "fin-client",
      startedAt: "2026-04-25T12:00:00Z",
      outcome: { kind: "failed" as const, error: "dispatch boom" },
      applied: {
        kind: "skipped" as const,
        reason: "no-completed-result" as const,
      },
    };
    const embed = renderDreamEmbed("fin-client", resp);
    const data = embed.toJSON() as {
      color?: number;
      fields?: { name: string; value: string }[];
    };
    expect(data.color).toBe(0xe74c3c);
    const outcomeField = (data.fields ?? []).find((f) => f.name === "Outcome")!;
    expect(outcomeField.value).toContain("dispatch boom");
  });

  it("DSL6: handler is inline-short-circuit — invokes IPC for clawcode-dream WITHOUT routing through CONTROL_COMMANDS dispatch", async () => {
    mockedSendIpcRequest.mockResolvedValue(completedResp);
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "fin-client"]]),
      agentToChannels: new Map([["fin-client", ["chan-1"]]]),
    };
    const handler = makeHandler({ routingTable });
    const { interaction } = makeInteraction({
      agentArg: "fin-client",
      userId: ADMIN_USER_ID,
    });

    await (
      handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }
    ).handleInteraction(interaction);

    // Only ONE IPC call (not the generic CONTROL_COMMANDS path which would
    // call a different ipcMethod). Confirms the inline handler short-circuited.
    expect(mockedSendIpcRequest).toHaveBeenCalledTimes(1);
    expect(mockedSendIpcRequest.mock.calls[0]![1]).toBe("run-dream-pass");
  });

  it("DSL7: isAdminClawdyInteraction recognises configured admin user IDs only", () => {
    const adminInt = {
      user: { id: ADMIN_USER_ID },
      channelId: "chan-unused",
    } as unknown as Parameters<typeof isAdminClawdyInteraction>[0];
    const nonAdminInt = {
      user: { id: NON_ADMIN_USER_ID },
      channelId: "chan-unused",
    } as unknown as Parameters<typeof isAdminClawdyInteraction>[0];
    const emptyContext = {
      adminUserIds: [ADMIN_USER_ID],
      routingTable: {
        channelToAgent: new Map<string, string>(),
        agentToChannels: new Map<string, readonly string[]>(),
      },
      resolvedAgents: [],
    };
    expect(isAdminClawdyInteraction(adminInt, emptyContext)).toBe(true);
    expect(isAdminClawdyInteraction(nonAdminInt, emptyContext)).toBe(false);
  });

  // Phase 100-fu — admin gate also recognises channel-bound admin agents,
  // so operators don't need to configure adminUserIds explicitly when the
  // interaction comes from a channel routed to an `admin: true` agent.
  describe("Phase 100-fu — channel-bound admin gate", () => {
    const ADMIN_AGENT_CHANNEL = "chan-admin-clawdy";
    const NON_ADMIN_CHANNEL = "chan-fin-client";
    const UNBOUND_CHANNEL = "chan-orphan";

    const routingTable = {
      channelToAgent: new Map<string, string>([
        [ADMIN_AGENT_CHANNEL, "admin-clawdy"],
        [NON_ADMIN_CHANNEL, "fin-client"],
      ]),
      agentToChannels: new Map<string, readonly string[]>([
        ["admin-clawdy", [ADMIN_AGENT_CHANNEL]],
        ["fin-client", [NON_ADMIN_CHANNEL]],
      ]),
    };
    const resolvedAgents = [
      { name: "admin-clawdy", admin: true } as unknown as {
        readonly name: string;
        readonly admin: boolean;
      },
      { name: "fin-client", admin: false } as unknown as {
        readonly name: string;
        readonly admin: boolean;
      },
    ];

    it("AG-1: explicit user-ID allowlist match → true (back-compat)", () => {
      const interaction = {
        user: { id: ADMIN_USER_ID },
        channelId: UNBOUND_CHANNEL,
      } as unknown as Parameters<typeof isAdminClawdyInteraction>[0];
      expect(
        isAdminClawdyInteraction(interaction, {
          adminUserIds: [ADMIN_USER_ID],
          routingTable,
          resolvedAgents,
        }),
      ).toBe(true);
    });

    it("AG-2: empty user-ID allowlist + channel bound to admin agent → true", () => {
      const interaction = {
        user: { id: NON_ADMIN_USER_ID },
        channelId: ADMIN_AGENT_CHANNEL,
      } as unknown as Parameters<typeof isAdminClawdyInteraction>[0];
      expect(
        isAdminClawdyInteraction(interaction, {
          adminUserIds: [],
          routingTable,
          resolvedAgents,
        }),
      ).toBe(true);
    });

    it("AG-3: empty user-ID allowlist + channel bound to non-admin agent → false", () => {
      const interaction = {
        user: { id: NON_ADMIN_USER_ID },
        channelId: NON_ADMIN_CHANNEL,
      } as unknown as Parameters<typeof isAdminClawdyInteraction>[0];
      expect(
        isAdminClawdyInteraction(interaction, {
          adminUserIds: [],
          routingTable,
          resolvedAgents,
        }),
      ).toBe(false);
    });

    it("AG-4: empty user-ID allowlist + channel not in routingTable → false", () => {
      const interaction = {
        user: { id: NON_ADMIN_USER_ID },
        channelId: UNBOUND_CHANNEL,
      } as unknown as Parameters<typeof isAdminClawdyInteraction>[0];
      expect(
        isAdminClawdyInteraction(interaction, {
          adminUserIds: [],
          routingTable,
          resolvedAgents,
        }),
      ).toBe(false);
    });

    it("AG-5: both allowlist match AND admin-bound channel → true (either path works)", () => {
      const interaction = {
        user: { id: ADMIN_USER_ID },
        channelId: ADMIN_AGENT_CHANNEL,
      } as unknown as Parameters<typeof isAdminClawdyInteraction>[0];
      expect(
        isAdminClawdyInteraction(interaction, {
          adminUserIds: [ADMIN_USER_ID],
          routingTable,
          resolvedAgents,
        }),
      ).toBe(true);
    });
  });
});
