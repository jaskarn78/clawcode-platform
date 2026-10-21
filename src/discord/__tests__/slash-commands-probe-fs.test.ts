/**
 * Phase 96 Plan 05 PFS- — `/clawcode-probe-fs` Discord slash command tests.
 *
 * 9th application of the inline-handler-short-circuit pattern (after
 * /clawcode-tools, /clawcode-model, /clawcode-permissions, /clawcode-skills*,
 * /clawcode-plugins-browse, /clawcode-clawhub-auth, /clawcode-sync-status,
 * /clawcode-cutover-verify, /clawcode-dream).
 *
 * Pins:
 *   PFS-HAPPY-EMBED: admin user invokes with agent='fin-client';
 *     deps.ipcClient.send returns FsProbeOutcome{kind:'completed', snapshot,
 *     durationMs:120}; expect editReply called with embed having title
 *     containing "fin-client" AND fields containing "ready" count
 *   PFS-NON-ADMIN-REFUSED: non-admin user → ephemeral reply WITHOUT IPC call
 *   PFS-PROBE-FAILURE: outcome.kind='failed' → editReply with embed showing
 *     error verbatim
 *   PFS-AGENT-NOT-RUNNING: deps.ipcClient.send rejects with
 *     `Error("agent not running")`; editReply renders error message
 *   PFS-INLINE-BEFORE-CONTROL: handler reaches BEFORE CONTROL_COMMANDS
 *     dispatch — only ONE IPC call (the probe-fs IPC, not a fallback control
 *     command IPC)
 *   PFS-DIFF-FIELD: outcome.changes (transitions since last probe) populates
 *     a "Changes since last probe" field in the embed
 *   PFS-CAP-BUDGET (vitest assertion replacing runtime grep on compiled JS):
 *     import DEFAULT_SLASH_COMMANDS + CONTROL_COMMANDS; assert
 *     `DEFAULT_SLASH_COMMANDS.length + CONTROL_COMMANDS.length <= 90`
 *     (Phase 85 Pitfall 9 — Discord 100/guild cap with 10-slot buffer)
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

import {
  SlashCommandHandler,
  renderProbeFsEmbed,
} from "../slash-commands.js";
import { sendIpcRequest } from "../../ipc/client.js";
import { CONTROL_COMMANDS, DEFAULT_SLASH_COMMANDS } from "../slash-types.js";
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

function makeHandler(): SlashCommandHandler {
  const fakeClient = {
    user: { id: "app-id-1" },
    guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const routingTable: RoutingTable = {
    channelToAgent: new Map([["chan-1", "fin-client"]]),
    agentToChannels: new Map([["fin-client", ["chan-1"]]]),
  };
  return new SlashCommandHandler({
    routingTable,
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
    commandName: "clawcode-probe-fs",
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

/**
 * Build an FsProbeOutcome 'completed' response shape that the daemon's
 * `probe-fs` IPC handler returns. Mirrors src/manager/fs-probe.ts FsProbeOutcome
 * shape — tests stub the entire wire payload so the slash handler can render
 * without spawning the daemon.
 */
function completedOutcome(): unknown {
  return {
    kind: "completed",
    snapshot: [
      [
        "/home/clawcode/.clawcode/agents/fin-client",
        {
          status: "ready",
          mode: "rw",
          lastProbeAt: "2026-04-25T20:00:00Z",
          lastSuccessAt: "2026-04-25T20:00:00Z",
        },
      ],
      [
        "/home/example-user/.openclaw/workspace-acme",
        {
          status: "ready",
          mode: "ro",
          lastProbeAt: "2026-04-25T20:00:00Z",
          lastSuccessAt: "2026-04-25T20:00:00Z",
        },
      ],
    ],
    durationMs: 120,
  };
}

function failedOutcome(): unknown {
  return {
    kind: "failed",
    error: "IPC timeout after 5000ms",
  };
}

function outcomeWithChanges(): unknown {
  return {
    kind: "completed",
    snapshot: [
      [
        "/home/clawcode/.clawcode/agents/fin-client",
        {
          status: "ready",
          mode: "rw",
          lastProbeAt: "2026-04-25T20:00:00Z",
          lastSuccessAt: "2026-04-25T20:00:00Z",
        },
      ],
      [
        "/home/example-user/.openclaw/workspace-acme",
        {
          status: "degraded",
          mode: "denied",
          lastProbeAt: "2026-04-25T20:00:00Z",
          error: "EACCES",
        },
      ],
    ],
    durationMs: 80,
    changes: [
      {
        path: "/home/example-user/.openclaw/workspace-acme",
        from: "ready",
        to: "degraded",
      },
    ],
  };
}

// Phase 999.32 — /clawcode-probe-fs slash command removed (operator cleanup).
// Daemon IPC `probe-fs` and CLI `clawcode probe fs` stay live. Tests skipped
// rather than deleted in case the slash gets re-introduced.
describe.skip("Phase 96 Plan 05 — /clawcode-probe-fs slash command (PFS-)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PFS-HAPPY-EMBED: admin invocation → IPC probe-fs called; embed rendered with agent name + ready count", async () => {
    mockedSendIpcRequest.mockResolvedValue(completedOutcome());
    const handler = makeHandler();
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
    expect(ipcCall[1]).toBe("probe-fs");
    expect((ipcCall[2] as { agent: string }).agent).toBe("fin-client");
    expect(deferReply).toHaveBeenCalled();
    expect(editReply).toHaveBeenCalled();
    const editArg = editReply.mock.calls[0]![0] as { embeds?: unknown[] };
    expect(Array.isArray(editArg.embeds)).toBe(true);
    expect((editArg.embeds ?? []).length).toBe(1);

    const embed = (editArg.embeds as { toJSON: () => unknown }[])[0]!;
    const data = embed.toJSON() as {
      title?: string;
      fields?: { name: string; value: string }[];
    };
    expect(data.title).toContain("fin-client");
    const counts = (data.fields ?? []).find(
      (f) => f.name.toLowerCase().includes("ready") || f.name.toLowerCase().includes("degraded"),
    );
    expect(counts).toBeDefined();
    // Two ready entries in the snapshot
    expect(counts?.value).toContain("2");
  });

  it("PFS-NON-ADMIN-REFUSED: non-admin user → ephemeral reply WITHOUT IPC call", async () => {
    const handler = makeHandler();
    const { reply, interaction } = makeInteraction({
      agentArg: "fin-client",
      userId: NON_ADMIN_USER_ID,
    });

    await (
      handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }
    ).handleInteraction(interaction);

    expect(mockedSendIpcRequest).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalled();
    const call = reply.mock.calls[0]![0] as { content?: string };
    expect(call.content?.toLowerCase()).toContain("admin");
  });

  it("PFS-PROBE-FAILURE: outcome.kind='failed' → embed shows verbatim error", async () => {
    mockedSendIpcRequest.mockResolvedValue(failedOutcome());
    const handler = makeHandler();
    const { editReply, interaction } = makeInteraction({
      agentArg: "fin-client",
      userId: ADMIN_USER_ID,
    });

    await (
      handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }
    ).handleInteraction(interaction);

    expect(editReply).toHaveBeenCalled();
    const editArg = editReply.mock.calls[0]![0] as { embeds?: unknown[] };
    const embed = (editArg.embeds as { toJSON: () => unknown }[])[0]!;
    const data = embed.toJSON() as {
      fields?: { name: string; value: string }[];
    };
    const errField = (data.fields ?? []).find(
      (f) => f.name.toLowerCase() === "error",
    );
    expect(errField).toBeDefined();
    expect(errField!.value).toContain("IPC timeout after 5000ms");
  });

  it("PFS-AGENT-NOT-RUNNING: IPC rejects with 'agent not running' → editReply renders error", async () => {
    mockedSendIpcRequest.mockRejectedValue(new Error("agent not running"));
    const handler = makeHandler();
    const { editReply, interaction } = makeInteraction({
      agentArg: "no-such-agent",
      userId: ADMIN_USER_ID,
    });

    await (
      handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }
    ).handleInteraction(interaction);

    expect(editReply).toHaveBeenCalled();
    const editArg = editReply.mock.calls[0]![0];
    const text =
      typeof editArg === "string"
        ? editArg
        : (editArg as { content?: string }).content ?? "";
    expect(text).toContain("agent not running");
  });

  it("PFS-INLINE-BEFORE-CONTROL (inline-short-circuit): only the probe-fs IPC method is called — control-command dispatch path NOT taken", async () => {
    mockedSendIpcRequest.mockResolvedValue(completedOutcome());
    const handler = makeHandler();
    const { interaction } = makeInteraction({
      agentArg: "fin-client",
      userId: ADMIN_USER_ID,
    });

    await (
      handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }
    ).handleInteraction(interaction);

    // Only ONE IPC call (the inline handler's probe-fs). If the inline-short-
    // circuit failed, the generic CONTROL_COMMANDS dispatch would invoke a
    // different ipcMethod (or call sendIpcRequest a second time).
    expect(mockedSendIpcRequest).toHaveBeenCalledTimes(1);
    expect(mockedSendIpcRequest.mock.calls[0]![1]).toBe("probe-fs");
  });

  it("PFS-DIFF-FIELD: outcome.changes populates a 'Changes since last probe' field", () => {
    // outcomeWithChanges() is typed `unknown` to keep the fixture
    // shape-loose; cast to the wire shape at the call boundary.
    const embed = renderProbeFsEmbed(
      "fin-client",
      outcomeWithChanges() as Parameters<typeof renderProbeFsEmbed>[1],
    );
    const data = embed.toJSON() as {
      fields?: { name: string; value: string }[];
    };
    const changesField = (data.fields ?? []).find((f) =>
      f.name.toLowerCase().includes("changes"),
    );
    expect(changesField).toBeDefined();
    expect(changesField!.value).toContain("workspace-acme");
    expect(changesField!.value.toLowerCase()).toContain("degraded");
  });

  it("PFS-CAP-BUDGET (vitest assertion replacing runtime grep): DEFAULT_SLASH_COMMANDS + CONTROL_COMMANDS ≤ 90 (Phase 85 Pitfall 9 cap)", () => {
    // After Phase 96 plan 05, count = 17 (Phase 95 baseline) + 1 (clawcode-probe-fs) = 18 of 90 budget.
    // The vitest test runs even when no compiled JS exists; covers the cap on every test pass.
    expect(
      DEFAULT_SLASH_COMMANDS.length + CONTROL_COMMANDS.length,
    ).toBeLessThanOrEqual(90);
  });
});
