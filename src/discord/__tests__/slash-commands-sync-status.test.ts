/**
 * Phase 91 Plan 05 SYNC-08 — /clawcode-sync-status inline handler tests.
 *
 * Validates:
 *   SS1  IPC `list-sync-status` invoked exactly once per command invocation
 *   SS2  Happy-path response → editReply called with one green-coloured embed
 *   SS3  Conflict response → editReply called with red-coloured embed +
 *        ≥1 conflict field
 *   SS4  IPC error → editReply called with ephemeral error text, NO embed
 *   SS5  Inline handler returns BEFORE CONTROL_COMMANDS — handleControlCommand
 *        is NOT invoked for clawcode-sync-status
 *   SS6  CONTROL_COMMANDS registration — entry exists with ipcMethod
 *        "list-sync-status" and zero options
 *   SS7  Command-count invariant: CONTROL_COMMANDS + DEFAULT_SLASH_COMMANDS
 *        ≤ 90 (Discord 100/guild cap pre-flight guard — Phase 85 decision log)
 *   SS8  handleInteraction source contains the literal "clawcode-sync-status"
 *        twice (registration import + routing branch) — grep discipline from
 *        Phase 85 acceptance criteria
 *   SS9  Zero-LLM-turn guarantee — no turnDispatcher is required or invoked
 *        for this command (smoke-tested by constructing the handler WITHOUT
 *        a turnDispatcher and successfully handling the command)
 *
 * Mocks `sendIpcRequest` so tests don't need a live daemon.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

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

function makeHandler(opts?: { routingTable?: RoutingTable }): SlashCommandHandler {
  const fakeClient = {
    user: { id: "app-id-1" },
    guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const routingTable: RoutingTable = opts?.routingTable ?? {
    channelToAgent: new Map([["chan-1", "clawdy"]]),
    agentToChannels: new Map([["clawdy", ["chan-1"]]]),
  };
  return new SlashCommandHandler({
    routingTable,
    sessionManager: {} as unknown as SessionManager,
    resolvedAgents: [makeAgent("clawdy")],
    botToken: "fake-token",
    client: fakeClient as never,
    log: makeStubLogger(),
    // Deliberately no turnDispatcher — SS9 assertion that this command
    // does NOT require an LLM turn dispatcher to work.
  } as never);
}

function makeInteraction(): {
  editReply: ReturnType<typeof vi.fn>;
  deferReply: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  interaction: unknown;
} {
  const editReply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    commandName: "clawcode-sync-status",
    channelId: "chan-1",
    isChatInputCommand: () => true,
    deferReply,
    editReply,
    reply,
    options: {
      get: () => null,
      getString: () => null,
    },
    user: { id: "user-1" },
    id: "interaction-1",
  };
  return { editReply, deferReply, reply, interaction };
}

// ---------------------------------------------------------------------------
// SS6 + SS7: CONTROL_COMMANDS registration + guild-cap invariant
// ---------------------------------------------------------------------------

describe("Phase 91 Plan 05 — CONTROL_COMMANDS registration", () => {
  it("SS6: registers `clawcode-sync-status` as a control command with ipcMethod 'list-sync-status'", () => {
    const entry = CONTROL_COMMANDS.find((c) => c.name === "clawcode-sync-status");
    expect(entry).toBeDefined();
    expect(entry!.control).toBe(true);
    expect(entry!.ipcMethod).toBe("list-sync-status");
    expect(entry!.claudeCommand).toBe("");
    // Fleet-level — no per-agent argument
    expect(entry!.options).toHaveLength(0);
  });

  it("SS7: total guild command count stays ≤90 (Discord 100/guild cap guard)", () => {
    const total = CONTROL_COMMANDS.length + DEFAULT_SLASH_COMMANDS.length;
    expect(total).toBeLessThanOrEqual(90);
  });
});

// ---------------------------------------------------------------------------
// SS8: source-grep discipline (registration + routing literal present)
// ---------------------------------------------------------------------------

describe("Phase 91 Plan 05 — source-grep discipline", () => {
  it("SS8: slash-commands.ts contains 'clawcode-sync-status' literal at least twice", () => {
    const source = readFileSync(
      resolvePath(__dirname, "..", "slash-commands.ts"),
      "utf8",
    );
    const occurrences = source.split("clawcode-sync-status").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("SS8b: slash-commands.ts imports buildSyncStatusEmbed", () => {
    const source = readFileSync(
      resolvePath(__dirname, "..", "slash-commands.ts"),
      "utf8",
    );
    expect(source).toContain("buildSyncStatusEmbed");
  });

  it("SS8c: slash-commands.ts routes via list-sync-status IPC literal", () => {
    const source = readFileSync(
      resolvePath(__dirname, "..", "slash-commands.ts"),
      "utf8",
    );
    expect(source).toContain("list-sync-status");
  });
});

// ---------------------------------------------------------------------------
// SS1-SS5 + SS9: inline handler behavior
// ---------------------------------------------------------------------------

describe("Phase 91 Plan 05 — /clawcode-sync-status inline handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("SS1: invokes the `list-sync-status` IPC exactly once per command", async () => {
    mockedSendIpcRequest.mockResolvedValue({
      authoritativeSide: "openclaw",
      lastSyncedAt: null,
      conflictCount: 0,
      conflicts: [],
      lastCycle: null,
    });
    const handler = makeHandler();
    const { interaction } = makeInteraction();

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    expect(mockedSendIpcRequest).toHaveBeenCalledTimes(1);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      expect.any(String),
      "list-sync-status",
      {},
    );
  });

  it("SS2: happy-path response → editReply called with a single green-coloured embed", async () => {
    mockedSendIpcRequest.mockResolvedValue({
      authoritativeSide: "openclaw",
      lastSyncedAt: "2026-04-24T19:58:00.000Z",
      conflictCount: 0,
      conflicts: [],
      lastCycle: {
        cycleId: "cyc-happy-1",
        status: "synced",
        filesAdded: 0,
        filesUpdated: 2,
        filesRemoved: 0,
        filesSkippedConflict: 0,
        bytesTransferred: 3200,
        durationMs: 1400,
        timestamp: "2026-04-24T19:58:00.000Z",
      },
    });
    const handler = makeHandler();
    const { editReply, deferReply, interaction } = makeInteraction();

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(editReply).toHaveBeenCalledTimes(1);
    const call = editReply.mock.calls[0]![0] as {
      embeds?: Array<{ data: { color?: number; title?: string } }>;
    };
    expect(call.embeds).toHaveLength(1);
    // Green (EMBED_COLOR_HAPPY = 3066993)
    expect(call.embeds![0]!.data.color).toBe(3066993);
    expect(call.embeds![0]!.data.title).not.toContain("⚠️");
  });

  it("SS3: conflict response → editReply called with a red-coloured embed + ≥1 conflict field", async () => {
    mockedSendIpcRequest.mockResolvedValue({
      authoritativeSide: "openclaw",
      lastSyncedAt: "2026-04-24T19:58:00.000Z",
      conflictCount: 2,
      conflicts: [
        {
          path: "MEMORY.md",
          sourceHash: "a".repeat(64),
          destHash: "b".repeat(64),
          detectedAt: "2026-04-24T19:55:00.000Z",
          resolvedAt: null,
        },
        {
          path: "memory/procedures/newsletter.md",
          sourceHash: "c".repeat(64),
          destHash: "d".repeat(64),
          detectedAt: "2026-04-24T19:55:00.000Z",
          resolvedAt: null,
        },
      ],
      lastCycle: {
        cycleId: "cyc-conflict-1",
        status: "partial-conflicts",
        filesAdded: 0,
        filesUpdated: 1,
        filesRemoved: 0,
        filesSkippedConflict: 2,
        bytesTransferred: 500,
        durationMs: 1200,
        timestamp: "2026-04-24T19:58:00.000Z",
      },
    });
    const handler = makeHandler();
    const { editReply, interaction } = makeInteraction();

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    expect(editReply).toHaveBeenCalledTimes(1);
    const call = editReply.mock.calls[0]![0] as {
      embeds?: Array<{
        data: {
          color?: number;
          title?: string;
          fields?: Array<{ name: string; value: string }>;
          description?: string;
        };
      }>;
    };
    expect(call.embeds).toHaveLength(1);
    // Red (EMBED_COLOR_CONFLICT = 15158332)
    expect(call.embeds![0]!.data.color).toBe(15158332);
    expect(call.embeds![0]!.data.title).toContain("⚠️");
    expect(call.embeds![0]!.data.title).toContain("2 conflicts");

    const fields = call.embeds![0]!.data.fields ?? [];
    const conflictField = fields.find((f) => f.name.includes("MEMORY.md"));
    expect(conflictField).toBeDefined();
    // Resolve hint in description
    expect(call.embeds![0]!.data.description).toContain("clawcode sync resolve");
  });

  it("SS4: IPC error → editReply called with ephemeral error text, NO embed", async () => {
    mockedSendIpcRequest.mockRejectedValue(
      new Error("daemon socket closed: ECONNREFUSED"),
    );
    const handler = makeHandler();
    const { editReply, deferReply, interaction } = makeInteraction();

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(editReply).toHaveBeenCalledTimes(1);
    const call = editReply.mock.calls[0]![0];
    // Plain string (not an { embeds: [...] } shape)
    expect(typeof call).toBe("string");
    expect(call).toContain("Sync status unavailable");
    expect(call).toContain("ECONNREFUSED");
  });

  it("SS5: inline handler returns BEFORE CONTROL_COMMANDS generic dispatch (structural)", async () => {
    // When the inline handler fires for clawcode-sync-status, the generic
    // CONTROL_COMMANDS dispatcher (handleControlCommand) must NOT be invoked.
    // We spy on the private method via the instance.
    mockedSendIpcRequest.mockResolvedValue({
      authoritativeSide: "openclaw",
      lastSyncedAt: null,
      conflictCount: 0,
      conflicts: [],
      lastCycle: null,
    });
    const handler = makeHandler();
    // Spy on handleControlCommand — the generic CONTROL_COMMANDS dispatch.
    // If the inline handler short-circuits correctly, this should NOT be
    // called for clawcode-sync-status.
    const handleControlCommandSpy = vi.spyOn(
      handler as unknown as {
        handleControlCommand: (...args: unknown[]) => Promise<void>;
      },
      "handleControlCommand",
    );

    const { interaction } = makeInteraction();
    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    expect(handleControlCommandSpy).not.toHaveBeenCalled();
    // The inline path did fire — prove it by asserting the IPC call.
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      expect.any(String),
      "list-sync-status",
      {},
    );
  });

  it("SS9: zero-LLM-turn — handler works WITHOUT a turnDispatcher + never invokes one", async () => {
    mockedSendIpcRequest.mockResolvedValue({
      authoritativeSide: "openclaw",
      lastSyncedAt: null,
      conflictCount: 0,
      conflicts: [],
      lastCycle: null,
    });
    // handler was constructed WITHOUT turnDispatcher (see makeHandler above)
    const handler = makeHandler();
    const { editReply, interaction } = makeInteraction();

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    // editReply with an embed happened (not a "turn unavailable" text).
    expect(editReply).toHaveBeenCalledTimes(1);
    const call = editReply.mock.calls[0]![0] as { embeds?: unknown[] };
    expect(call.embeds).toBeDefined();
    // Exactly one IPC call — nothing else reached out for an LLM turn.
    expect(mockedSendIpcRequest).toHaveBeenCalledTimes(1);
  });

  it("SS2b: happy-path with never-run state → yellow embed + 'never-run' description", async () => {
    // First-boot scenario: sync-state.json missing AND sync.jsonl missing.
    // IPC returns DEFAULT_SYNC_STATE defaults (empty conflicts, null lastCycle).
    mockedSendIpcRequest.mockResolvedValue({
      authoritativeSide: "openclaw",
      lastSyncedAt: null,
      conflictCount: 0,
      conflicts: [],
      lastCycle: null,
    });
    const handler = makeHandler();
    const { editReply, interaction } = makeInteraction();

    await (handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);

    const call = editReply.mock.calls[0]![0] as {
      embeds?: Array<{ data: { color?: number; description?: string; footer?: { text: string } } }>;
    };
    expect(call.embeds![0]!.data.color).toBe(15844367); // EMBED_COLOR_WARN
    expect(call.embeds![0]!.data.description).toContain("never-run");
    expect(call.embeds![0]!.data.footer?.text).toContain("Sync has not run yet");
  });
});
