/**
 * Phase 85 Plan 03 — `/clawcode-tools` Discord slash command tests.
 *
 * Validates:
 *   - CONTROL_COMMANDS entry shape (control:true + ipcMethod:"list-mcp-status")
 *   - Empty-servers → ephemeral "No MCP servers configured for x"
 *   - Populated → EmbedBuilder with per-server fields (status emoji + last success + failures)
 *   - Verbatim last-error pass-through (TOOL-04 end-to-end)
 *   - Channel-agent inference when agent option omitted
 *   - Ephemeral error when no arg + channel not bound
 *   - Optional-server "(optional)" suffix on non-ready fields
 *   - `lastSuccessAt: null` renders "last success: never"
 *   - Pre-flight Discord-100-cap count assertion (Pitfall 9)
 *
 * Mocks `sendIpcRequest` so tests don't need a live daemon.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";

// Mock the IPC client BEFORE importing the handler module so the
// `sendIpcRequest` reference in slash-commands.ts is the mocked version.
vi.mock("../../ipc/client.js", () => ({
  sendIpcRequest: vi.fn(),
}));

import { SlashCommandHandler } from "../slash-commands.js";
import { sendIpcRequest } from "../../ipc/client.js";
import { CONTROL_COMMANDS, DEFAULT_SLASH_COMMANDS } from "../slash-types.js";
import type { SessionManager } from "../../manager/session-manager.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { RoutingTable } from "../types.js";

const mockedSendIpcRequest = vi.mocked(sendIpcRequest);

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
  sessionManager?: SessionManager;
}): SlashCommandHandler {
  const fakeClient = {
    user: { id: "app-id-1" },
    guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  return new SlashCommandHandler({
    routingTable: opts.routingTable,
    sessionManager: opts.sessionManager ?? ({} as unknown as SessionManager),
    resolvedAgents: [makeAgent("clawdy")],
    botToken: "fake-token",
    client: fakeClient as never,
    log: makeStubLogger(),
  } as never);
}

function makeInteraction(opts: {
  channelId: string;
  agentArg?: string;
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
    commandName: "clawcode-tools",
    channelId: opts.channelId,
    isChatInputCommand: () => true,
    deferReply,
    editReply,
    reply,
    options: {
      get: (name: string) =>
        opts.agentArg && name === "agent" ? { value: opts.agentArg } : null,
      getString: (name: string) =>
        opts.agentArg && name === "agent" ? opts.agentArg : null,
    },
    user: { id: "user-1" },
    id: "interaction-1",
  };
  return { editReply, deferReply, reply, interaction };
}

describe("Phase 85 Plan 03 — CONTROL_COMMANDS entry for clawcode-tools", () => {
  it("registers `clawcode-tools` as a control command with ipcMethod 'list-mcp-status'", () => {
    const entry = CONTROL_COMMANDS.find((c) => c.name === "clawcode-tools");
    expect(entry).toBeDefined();
    expect(entry!.control).toBe(true);
    expect(entry!.ipcMethod).toBe("list-mcp-status");
    expect(entry!.claudeCommand).toBe("");
  });

  it("exposes an optional string `agent` option (not required)", () => {
    const entry = CONTROL_COMMANDS.find((c) => c.name === "clawcode-tools")!;
    const agentOpt = entry.options.find((o) => o.name === "agent");
    expect(agentOpt).toBeDefined();
    expect(agentOpt!.type).toBe(3); // STRING
    expect(agentOpt!.required).toBe(false);
  });

  it("Pitfall 9 — total command count stays <=90 (Discord 100-cap guard)", () => {
    const total = CONTROL_COMMANDS.length + DEFAULT_SLASH_COMMANDS.length;
    expect(total).toBeLessThanOrEqual(90);
  });
});

describe("Phase 85 Plan 03 — /clawcode-tools inline handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replies ephemerally with 'No MCP servers configured for <agent>' when IPC returns empty servers", async () => {
    mockedSendIpcRequest.mockResolvedValue({ agent: "clawdy", servers: [] });
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const handler = makeHandler({ routingTable });
    const { editReply, deferReply, interaction } = makeInteraction({
      channelId: "chan-1",
    });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    // ephemeral via deferReply({ephemeral:true})
    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(editReply).toHaveBeenCalledWith("No MCP servers configured for clawdy");
  });

  it("builds a Discord EmbedBuilder with one field per server (status emoji + last-success + failures)", async () => {
    const nowMs = Date.now();
    mockedSendIpcRequest.mockResolvedValue({
      agent: "clawdy",
      servers: [
        {
          name: "1password",
          status: "ready",
          lastSuccessAt: nowMs - 12_000,
          lastFailureAt: null,
          failureCount: 0,
          optional: false,
          lastError: null,
        },
        {
          name: "browser",
          status: "degraded",
          lastSuccessAt: nowMs - 120_000,
          lastFailureAt: nowMs - 5_000,
          failureCount: 2,
          optional: false,
          lastError: "jsonrpc timeout",
        },
        {
          name: "search",
          status: "failed",
          lastSuccessAt: null,
          lastFailureAt: nowMs - 1_000,
          failureCount: 5,
          optional: false,
          lastError: "Failed to start: ENOENT",
        },
      ],
    });
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const handler = makeHandler({ routingTable });
    const { editReply, interaction } = makeInteraction({ channelId: "chan-1" });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    expect(editReply).toHaveBeenCalled();
    const lastCall = editReply.mock.calls[editReply.mock.calls.length - 1]![0] as {
      embeds?: Array<{ data: { title?: string; fields: Array<{ name: string; value: string }> } }>;
    };
    expect(lastCall.embeds).toBeDefined();
    expect(lastCall.embeds).toHaveLength(1);
    const embed = lastCall.embeds![0]!.data;
    expect(embed.title).toBe("MCP Tools · clawdy");
    expect(embed.fields).toHaveLength(3);

    // Field names carry status emoji + server name.
    const names = embed.fields.map((f) => f.name);
    expect(names.some((n) => n.includes("🟢") && n.includes("1password"))).toBe(true);
    expect(names.some((n) => n.includes("🟡") && n.includes("browser"))).toBe(true);
    expect(names.some((n) => n.includes("🔴") && n.includes("search"))).toBe(true);

    // Field values carry failures + last-success hints.
    const combined = embed.fields.map((f) => f.value).join("\n");
    expect(combined).toContain("failures: 0");
    expect(combined).toContain("failures: 2");
    expect(combined).toContain("failures: 5");
    expect(combined.toLowerCase()).toContain("last success");
  });

  it("TOOL-04 end-to-end — renders verbatim lastError string in the failed server's field value", async () => {
    mockedSendIpcRequest.mockResolvedValue({
      agent: "clawdy",
      servers: [
        {
          name: "search",
          status: "failed",
          lastSuccessAt: null,
          lastFailureAt: Date.now(),
          failureCount: 3,
          optional: false,
          lastError: "Failed to start: ENOENT",
        },
      ],
    });
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const handler = makeHandler({ routingTable });
    const { editReply, interaction } = makeInteraction({ channelId: "chan-1" });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    const lastCall = editReply.mock.calls[editReply.mock.calls.length - 1]![0] as {
      embeds?: Array<{ data: { fields: Array<{ name: string; value: string }> } }>;
    };
    const fields = lastCall.embeds![0]!.data.fields;
    const searchField = fields.find((f) => f.name.includes("search"))!;
    // Verbatim pass-through — no rewording, substring match allowed.
    expect(searchField.value).toContain("Failed to start: ENOENT");
  });

  it("infers agent from channel binding when the `agent` option is omitted", async () => {
    mockedSendIpcRequest.mockResolvedValue({ agent: "clawdy", servers: [] });
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const handler = makeHandler({ routingTable });
    const { interaction } = makeInteraction({ channelId: "chan-1" });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      expect.any(String),
      "list-mcp-status",
      expect.objectContaining({ agent: "clawdy" }),
    );
  });

  it("replies ephemerally with a 'not bound' error when neither the option nor the channel supplies an agent", async () => {
    const routingTable: RoutingTable = {
      channelToAgent: new Map(),
      agentToChannels: new Map(),
    };
    const handler = makeHandler({ routingTable });
    const { reply, interaction } = makeInteraction({ channelId: "chan-nobody" });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    expect(mockedSendIpcRequest).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "This channel is not bound to an agent and no agent was provided.",
      ephemeral: true,
    });
  });

  it("annotates a failed optional server with the '(optional)' suffix in its field name", async () => {
    mockedSendIpcRequest.mockResolvedValue({
      agent: "clawdy",
      servers: [
        {
          name: "image",
          status: "failed",
          lastSuccessAt: null,
          lastFailureAt: Date.now(),
          failureCount: 1,
          optional: true,
          lastError: "no api key",
        },
      ],
    });
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const handler = makeHandler({ routingTable });
    const { editReply, interaction } = makeInteraction({ channelId: "chan-1" });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    const lastCall = editReply.mock.calls[editReply.mock.calls.length - 1]![0] as {
      embeds?: Array<{ data: { fields: Array<{ name: string }> } }>;
    };
    const fields = lastCall.embeds![0]!.data.fields;
    const imgField = fields.find((f) => f.name.includes("image"))!;
    expect(imgField.name).toContain("(optional)");
  });

  // ----------------------------------------------------------------------
  // Phase 94 Plan 07 — capability-probe column tests.
  //
  // The renderer surfaces (via the shared probe-renderer.ts helper) the
  // 5-status capability-probe emoji + last-good ISO timestamp + recovery
  // suggestion + cross-agent alternatives. These tests pin the wire
  // payload → embed-field-value mapping for the new column.
  // ----------------------------------------------------------------------

  it("TLS-EMOJI-ALL — surfaces all 5 capability-probe status emojis (✅ 🟡 ⏳ 🔴 ⚪) when the IPC payload carries one of each", async () => {
    const nowMs = Date.now();
    const lastSuccessIso = new Date(nowMs - 60_000).toISOString();
    mockedSendIpcRequest.mockResolvedValue({
      agent: "clawdy",
      servers: [
        {
          name: "ready-srv",
          status: "ready",
          lastSuccessAt: nowMs - 5_000,
          lastFailureAt: null,
          failureCount: 0,
          optional: false,
          lastError: null,
          capabilityProbe: { lastRunAt: new Date(nowMs).toISOString(), status: "ready", lastSuccessAt: lastSuccessIso },
          alternatives: [],
        },
        {
          name: "degraded-srv",
          status: "degraded",
          lastSuccessAt: nowMs - 60_000,
          lastFailureAt: nowMs - 1_000,
          failureCount: 1,
          optional: false,
          lastError: "rpc timeout",
          capabilityProbe: { lastRunAt: new Date(nowMs).toISOString(), status: "degraded", error: "rpc timeout", lastSuccessAt: lastSuccessIso },
          alternatives: [],
        },
        {
          name: "reconnecting-srv",
          status: "reconnecting",
          lastSuccessAt: null,
          lastFailureAt: nowMs,
          failureCount: 2,
          optional: false,
          lastError: "transient",
          capabilityProbe: { lastRunAt: new Date(nowMs).toISOString(), status: "reconnecting", error: "transient" },
          alternatives: [],
        },
        {
          name: "failed-srv",
          status: "failed",
          lastSuccessAt: null,
          lastFailureAt: nowMs,
          failureCount: 5,
          optional: false,
          lastError: "process down",
          capabilityProbe: { lastRunAt: new Date(nowMs).toISOString(), status: "failed", error: "process down" },
          alternatives: [],
        },
        {
          name: "unknown-srv",
          status: "ready",
          lastSuccessAt: nowMs,
          lastFailureAt: null,
          failureCount: 0,
          optional: false,
          lastError: null,
          // capabilityProbe omitted → renderer falls back to "unknown" status emoji
          alternatives: [],
        },
      ],
    });
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const handler = makeHandler({ routingTable });
    const { editReply, interaction } = makeInteraction({ channelId: "chan-1" });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    const lastCall = editReply.mock.calls[editReply.mock.calls.length - 1]![0] as {
      embeds?: Array<{ data: { fields: Array<{ name: string; value: string }> } }>;
    };
    const fields = lastCall.embeds![0]!.data.fields;
    const valueByName = new Map(fields.map((f) => [f.name, f.value]));
    // Each row's value carries the capability-probe emoji on the "probe:" line.
    const ready = [...valueByName.entries()].find(([n]) => n.includes("ready-srv"))![1];
    expect(ready).toContain("✅");
    expect(ready).toContain("ready");
    const degraded = [...valueByName.entries()].find(([n]) => n.includes("degraded-srv"))![1];
    expect(degraded).toContain("🟡");
    const reconnecting = [...valueByName.entries()].find(([n]) => n.includes("reconnecting-srv"))![1];
    expect(reconnecting).toContain("⏳");
    const failed = [...valueByName.entries()].find(([n]) => n.includes("failed-srv"))![1];
    expect(failed).toContain("🔴");
    const unknown = [...valueByName.entries()].find(([n]) => n.includes("unknown-srv"))![1];
    expect(unknown).toContain("⚪");
  });

  it("TLS-ALTS-DEGRADED — for a degraded server with cross-agent alternatives, embed value contains 'Healthy alternatives:' line + agent name", async () => {
    const nowMs = Date.now();
    mockedSendIpcRequest.mockResolvedValue({
      agent: "fin-tax",
      servers: [
        {
          name: "browser",
          status: "degraded",
          lastSuccessAt: nowMs - 60_000,
          lastFailureAt: nowMs - 1_000,
          failureCount: 1,
          optional: false,
          lastError: "Executable doesn't exist at /home/clawcode/.cache/ms-playwright/chromium-1187/chrome-linux/chrome",
          capabilityProbe: {
            lastRunAt: new Date(nowMs).toISOString(),
            status: "degraded",
            error: "Executable doesn't exist at /home/clawcode/.cache/ms-playwright/chromium-1187/chrome-linux/chrome",
            lastSuccessAt: new Date(nowMs - 3_600_000).toISOString(),
          },
          alternatives: ["fin-client", "general"],
        },
      ],
    });
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "fin-tax"]]),
      agentToChannels: new Map([["fin-tax", ["chan-1"]]]),
    };
    const handler = makeHandler({ routingTable });
    const { editReply, interaction } = makeInteraction({ channelId: "chan-1" });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    const lastCall = editReply.mock.calls[editReply.mock.calls.length - 1]![0] as {
      embeds?: Array<{ data: { fields: Array<{ name: string; value: string }> } }>;
    };
    const fields = lastCall.embeds![0]!.data.fields;
    const browserField = fields.find((f) => f.name.includes("browser"))!;
    expect(browserField.value).toContain("Healthy alternatives:");
    expect(browserField.value).toContain("fin-client");
    expect(browserField.value).toContain("general");
    // Recovery suggestion surfaced for the Playwright pattern.
    expect(browserField.value).toContain("auto-recovery: npx playwright install chromium");
  });

  it("TLS-ALT-NOT-FOR-READY — ready server with alternatives in payload still does NOT render the alternatives line", async () => {
    const nowMs = Date.now();
    mockedSendIpcRequest.mockResolvedValue({
      agent: "clawdy",
      servers: [
        {
          name: "browser",
          status: "ready",
          lastSuccessAt: nowMs - 5_000,
          lastFailureAt: null,
          failureCount: 0,
          optional: false,
          lastError: null,
          capabilityProbe: {
            lastRunAt: new Date(nowMs).toISOString(),
            status: "ready",
            lastSuccessAt: new Date(nowMs - 5_000).toISOString(),
          },
          // Daemon may still ship alternatives even for ready servers; the
          // renderer is responsible for hiding the line when the server
          // itself is fine.
          alternatives: ["fin-client", "general"],
        },
      ],
    });
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const handler = makeHandler({ routingTable });
    const { editReply, interaction } = makeInteraction({ channelId: "chan-1" });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    const lastCall = editReply.mock.calls[editReply.mock.calls.length - 1]![0] as {
      embeds?: Array<{ data: { fields: Array<{ name: string; value: string }> } }>;
    };
    const fields = lastCall.embeds![0]!.data.fields;
    const browserField = fields.find((f) => f.name.includes("browser"))!;
    expect(browserField.value).not.toContain("Healthy alternatives");
    // No recovery suggestion for ready servers either.
    expect(browserField.value).not.toContain("auto-recovery");
  });

  it("renders 'last success: never' when lastSuccessAt is null", async () => {
    mockedSendIpcRequest.mockResolvedValue({
      agent: "clawdy",
      servers: [
        {
          name: "brand-new-server",
          status: "failed",
          lastSuccessAt: null,
          lastFailureAt: Date.now(),
          failureCount: 1,
          optional: false,
          lastError: "first contact failed",
        },
      ],
    });
    const routingTable: RoutingTable = {
      channelToAgent: new Map([["chan-1", "clawdy"]]),
      agentToChannels: new Map([["clawdy", ["chan-1"]]]),
    };
    const handler = makeHandler({ routingTable });
    const { editReply, interaction } = makeInteraction({ channelId: "chan-1" });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    const lastCall = editReply.mock.calls[editReply.mock.calls.length - 1]![0] as {
      embeds?: Array<{ data: { fields: Array<{ value: string }> } }>;
    };
    const fields = lastCall.embeds![0]!.data.fields;
    const value = fields[0]!.value;
    expect(value.toLowerCase()).toContain("last success: never");
  });
});
