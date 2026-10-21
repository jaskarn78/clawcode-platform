/**
 * Phase 87 Plan 02 Task 2 — /clawcode-permissions inline handler tests.
 *
 * Pins the control-plane carve-out:
 *   - Inline handler fires BEFORE the generic CONTROL_COMMANDS branch
 *   - Dispatches via IPC set-permission-mode (NOT prompt routing)
 *   - Ephemeral confirmation on success, ephemeral error on failure
 *   - Unbound channel → "not bound" reply, no IPC call
 *
 * Mirrors the Phase 86 /clawcode-model test harness exactly (vi.mock the IPC
 * client, construct a minimal SlashCommandHandler, drive handleInteraction).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";

// Mock the IPC client before importing slash-commands.ts so the module-level
// binding is the mocked version.
vi.mock("../../ipc/client.js", () => ({
  sendIpcRequest: vi.fn(),
}));

import { SlashCommandHandler } from "../slash-commands.js";
import { sendIpcRequest } from "../../ipc/client.js";
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
    slashCommands: [],
    allowedModels: ["haiku", "sonnet", "opus"],
    soul: undefined,
    identity: undefined,
  } as unknown as ResolvedAgentConfig;
}

function makeStubSessionManager(): SessionManager {
  return {
    getModelForAgent: vi.fn().mockReturnValue(undefined),
    getEffortForAgent: vi.fn().mockReturnValue("medium"),
    getPermissionModeForAgent: vi.fn().mockReturnValue("default"),
  } as unknown as SessionManager;
}

type ReplyMock = ReturnType<typeof vi.fn>;

function makeInteraction(opts: {
  channelId: string;
  modeArg?: string;
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
    commandName: "clawcode-permissions",
    channelId: opts.channelId,
    isChatInputCommand: () => true,
    reply,
    editReply,
    deferReply,
    options: {
      get: (name: string) =>
        name === "mode" && opts.modeArg !== undefined
          ? { value: opts.modeArg }
          : null,
      getString: (name: string) =>
        name === "mode" && opts.modeArg !== undefined
          ? opts.modeArg
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
  } as never);
}

const boundRouting: RoutingTable = {
  channelToAgent: new Map([["chan-1", "clawdy"]]),
  agentToChannels: new Map([["clawdy", ["chan-1"]]]),
};

describe("Phase 87 CMD-02 — /clawcode-permissions inline handler", () => {
  beforeEach(() => {
    mockedSendIpcRequest.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("S1: /clawcode-permissions mode:acceptEdits dispatches IPC set-permission-mode and replies ephemerally", async () => {
    mockedSendIpcRequest.mockResolvedValue({
      ok: true,
      agent: "clawdy",
      permission_mode: "acceptEdits",
    });

    const handler = makeHandler({
      routingTable: boundRouting,
      resolvedAgents: [makeAgent("clawdy")],
    });
    const harness = makeInteraction({
      channelId: "chan-1",
      modeArg: "acceptEdits",
    });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    expect(mockedSendIpcRequest).toHaveBeenCalledTimes(1);
    const ipcArgs = mockedSendIpcRequest.mock.calls[0]!;
    expect(ipcArgs[1]).toBe("set-permission-mode");
    expect(ipcArgs[2]).toEqual({ name: "clawdy", mode: "acceptEdits" });

    // Ephemeral confirmation message mentions the mode + the agent name.
    const contents = harness.editReply.mock.calls
      .map((c) => {
        const first = c[0];
        return typeof first === "string"
          ? first
          : (first as { content?: string }).content ?? "";
      })
      .join("\n");
    expect(contents).toMatch(/acceptEdits/);
    expect(contents).toMatch(/clawdy/);

    // Defer was called with ephemeral flag (ephemeral reply contract).
    expect(harness.deferReply).toHaveBeenCalledTimes(1);
    const deferArg = harness.deferReply.mock.calls[0]?.[0] as
      | { ephemeral?: boolean }
      | undefined;
    expect(deferArg?.ephemeral).toBe(true);
  });

  it("S2: channel not bound to an agent — replies 'not bound' and does NOT call IPC", async () => {
    const handler = makeHandler({
      routingTable: {
        channelToAgent: new Map(),
        agentToChannels: new Map(),
      },
      resolvedAgents: [makeAgent("clawdy")],
    });
    const harness = makeInteraction({
      channelId: "unbound-channel",
      modeArg: "acceptEdits",
    });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    expect(mockedSendIpcRequest).not.toHaveBeenCalled();
    expect(harness.reply).toHaveBeenCalledTimes(1);
    const replyArg = harness.reply.mock.calls[0]![0] as {
      content?: string;
      ephemeral?: boolean;
    };
    expect(replyArg.ephemeral).toBe(true);
    expect(replyArg.content).toMatch(/not bound to an agent/i);
  });

  it("S3: IPC error surfaces the message ephemerally", async () => {
    mockedSendIpcRequest.mockRejectedValue(
      new Error(
        "Invalid permission mode 'foo'. Valid: default, acceptEdits, bypassPermissions, plan, dontAsk, auto",
      ),
    );

    const handler = makeHandler({
      routingTable: boundRouting,
      resolvedAgents: [makeAgent("clawdy")],
    });
    const harness = makeInteraction({
      channelId: "chan-1",
      modeArg: "foo",
    });

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(harness.interaction);

    const contents = harness.editReply.mock.calls
      .map((c) => {
        const first = c[0];
        return typeof first === "string"
          ? first
          : (first as { content?: string }).content ?? "";
      })
      .join("\n");
    expect(contents).toMatch(/Invalid permission mode/i);
    expect(contents).toMatch(/acceptEdits/);
    expect(contents).toMatch(/bypassPermissions/);
  });

  it("S4: carve-out ordering — source file has `if (commandName === \"clawcode-permissions\")` BEFORE the generic CONTROL_COMMANDS.find branch", async () => {
    // Structural check: read the file and verify the inline carve-out lives
    // above the generic control-command dispatch so the IPC path cannot be
    // short-circuited by the text-formatting branch downstream. Mirrors the
    // Phase 86 clawcode-model carve-out at line ~471.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const filePath = path.resolve(
      __dirname,
      "..",
      "slash-commands.ts",
    );
    const src = await fs.readFile(filePath, "utf8");

    const permissionsIdx = src.indexOf('commandName === "clawcode-permissions"');
    const controlFindIdx = src.indexOf("CONTROL_COMMANDS.find");

    expect(permissionsIdx).toBeGreaterThan(0);
    expect(controlFindIdx).toBeGreaterThan(0);
    // The carve-out must appear BEFORE the generic dispatch.
    expect(permissionsIdx).toBeLessThan(controlFindIdx);
  });
});
