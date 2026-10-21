/**
 * Phase 124 Plan 03 — `/clawcode-session-compact <agent>` Discord slash tests.
 *
 * Mirrors dream-slash.test.ts: mocks `sendIpcRequest` BEFORE importing
 * slash-commands.ts so the inline handler picks up the stub.
 *
 * Pins:
 *   T01-R1: DEFAULT_SLASH_COMMANDS contains the `clawcode-session-compact` entry
 *           with admin permissions + required `agent` string option
 *           (silent-path-bifurcation guard — registration is the actual
 *           production path, not just the handler).
 *   T02-G1: non-admin invocation → ephemeral "Admin-only command" reply
 *           WITHOUT any IPC call and WITHOUT a deferReply.
 *   T02-G2: admin invocation → no admin-only refusal; deferReply IS called.
 *   T03-H1: admin happy-path → sendIpcRequest("compact-session", {agent})
 *           called once; editReply called with an embed.
 *   T03-H2: renderCompactEmbed(success) → title contains agent, color green,
 *           fields populate tokens_before/after/summary_written/forked_to/
 *           memories_created.
 *   T04-E1: each of the four named error codes
 *           (AGENT_NOT_RUNNING / DAEMON_NOT_READY / ERR_TURN_TOO_LONG /
 *           AGENT_NOT_INITIALIZED) → red embed with the code verbatim.
 *   T04-E2: thrown IPC error → red embed with the thrown message.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";

// Mock the IPC client BEFORE importing slash-commands so the in-module
// `sendIpcRequest` reference is replaced by the stub.
vi.mock("../../ipc/client.js", () => ({
  sendIpcRequest: vi.fn(),
}));

import { CONTROL_COMMANDS } from "../slash-types.js";
import {
  SlashCommandHandler,
  renderCompactEmbed,
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
    commandName: "clawcode-session-compact",
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

const successPayload = {
  ok: true as const,
  tokens_before: 50_000,
  tokens_after: 8_000,
  summary_written: true,
  // Phase 999.75 Part B — native /compact performs no fork; null on that path.
  forked_to: null,
  memories_created: 12,
  live_reduced: true,
};

describe("Phase 124 Plan 03 — /clawcode-session-compact slash command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("T-01 — registration", () => {
    it("T01-R1: CONTROL_COMMANDS contains the clawcode-session-compact entry with admin permissions + required agent option", () => {
      const def = CONTROL_COMMANDS.find(
        (c) => c.name === "clawcode-session-compact",
      );
      expect(def).toBeDefined();
      expect(def?.ipcMethod).toBe("compact-session");
      expect(def?.control).toBe(true);
      // Admin-only API-surface gate (Phase 117 precedent).
      expect(
        (def as { defaultMemberPermissions?: string } | undefined)
          ?.defaultMemberPermissions,
      ).toBe("0");
      // Required string `agent` option.
      const opt = def?.options[0];
      expect(opt?.name).toBe("agent");
      expect(opt?.type).toBe(3); // STRING
      expect(opt?.required).toBe(true);
    });
  });

  describe("T-02 — admin gate", () => {
    it("T02-G1: non-admin → ephemeral 'Admin-only command' WITHOUT IPC call and WITHOUT deferReply", async () => {
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

      expect(mockedSendIpcRequest).not.toHaveBeenCalled();
      expect(deferReply).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledTimes(1);
      const call = reply.mock.calls[0]![0] as { content?: string };
      expect(call.content?.toLowerCase()).toContain("admin");
    });

    it("T02-G2: admin → no admin-only refusal; deferReply IS called ephemerally", async () => {
      mockedSendIpcRequest.mockResolvedValue(successPayload);
      const routingTable: RoutingTable = {
        channelToAgent: new Map([["chan-1", "fin-client"]]),
        agentToChannels: new Map([["fin-client", ["chan-1"]]]),
      };
      const handler = makeHandler({ routingTable });
      const { reply, deferReply, interaction } = makeInteraction({
        agentArg: "fin-client",
        userId: ADMIN_USER_ID,
      });

      await (
        handler as unknown as {
          handleInteraction: (i: unknown) => Promise<void>;
        }
      ).handleInteraction(interaction);

      // No admin-only refusal reply.
      const refusalCall = reply.mock.calls.find((c) =>
        ((c[0] as { content?: string })?.content ?? "")
          .toLowerCase()
          .includes("admin-only"),
      );
      expect(refusalCall).toBeUndefined();
      // Ephemeral defer.
      expect(deferReply).toHaveBeenCalled();
      const deferArg = deferReply.mock.calls[0]![0] as
        | { ephemeral?: boolean; flags?: number }
        | undefined;
      expect(deferArg?.ephemeral === true || deferArg?.flags === 64).toBe(true);
    });
  });

  describe("T-03 — happy path + success embed", () => {
    it("T03-H1: admin happy-path → IPC call compact-session dispatched; editReply with embed", async () => {
      mockedSendIpcRequest.mockResolvedValue(successPayload);
      const routingTable: RoutingTable = {
        channelToAgent: new Map([["chan-1", "fin-client"]]),
        agentToChannels: new Map([["fin-client", ["chan-1"]]]),
      };
      const handler = makeHandler({ routingTable });
      const { editReply, interaction } = makeInteraction({
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
      expect(ipcCall[1]).toBe("compact-session");
      expect(ipcCall[2]).toEqual({ agent: "fin-client" });

      expect(editReply).toHaveBeenCalled();
      const editArg = editReply.mock.calls[0]![0] as { embeds?: unknown[] };
      expect(Array.isArray(editArg.embeds)).toBe(true);
      expect((editArg.embeds ?? []).length).toBe(1);
    });

    it("T03-H2: renderCompactEmbed(success) → title contains agent, color green, all 5 fields populate", () => {
      const embed = renderCompactEmbed("fin-client", successPayload);
      const data = embed.toJSON() as {
        title?: string;
        color?: number;
        fields?: { name: string; value: string }[];
      };
      expect(data.color).toBe(0x2ecc71);
      expect(data.title).toContain("fin-client");
      const fieldNames = (data.fields ?? []).map((f) => f.name);
      // Phase 999.75 Part B — "Forked to" replaced by "Live window reduced".
      expect(fieldNames).toEqual(
        expect.arrayContaining([
          "Tokens before",
          "Tokens after",
          "Summary written",
          "Memories created",
          "Live window reduced",
        ]),
      );
      const tokensBefore = (data.fields ?? []).find(
        (f) => f.name === "Tokens before",
      )!;
      expect(tokensBefore.value).toContain("50000");
      const summary = (data.fields ?? []).find(
        (f) => f.name === "Summary written",
      )!;
      expect(summary.value.toLowerCase()).toContain("yes");
      const liveReduced = (data.fields ?? []).find(
        (f) => f.name === "Live window reduced",
      )!;
      expect(liveReduced.value.toLowerCase()).toContain("yes");
      const memories = (data.fields ?? []).find(
        (f) => f.name === "Memories created",
      )!;
      expect(memories.value).toContain("12");
    });

    it("T03-H3: renderCompactEmbed(success, tokens=null) → 'n/a' for tokens, summary 'no' when false", () => {
      const embed = renderCompactEmbed("fin-client", {
        ok: true,
        tokens_before: null,
        tokens_after: null,
        summary_written: false,
        forked_to: null,
        memories_created: 0,
        live_reduced: false,
        skip_reason: "seam_not_wired",
      });
      const data = embed.toJSON() as {
        fields?: { name: string; value: string }[];
      };
      const tokensBefore = (data.fields ?? []).find(
        (f) => f.name === "Tokens before",
      )!;
      expect(tokensBefore.value.toLowerCase()).toContain("n/a");
      const summary = (data.fields ?? []).find(
        (f) => f.name === "Summary written",
      )!;
      expect(summary.value.toLowerCase()).toContain("no");
    });
  });

  describe("T-04 — error-code propagation", () => {
    const namedErrors = [
      "AGENT_NOT_RUNNING",
      "DAEMON_NOT_READY",
      "ERR_TURN_TOO_LONG",
      "AGENT_NOT_INITIALIZED",
    ] as const;

    for (const code of namedErrors) {
      it(`T04-E1: error code ${code} → red embed with the code verbatim in description`, () => {
        const embed = renderCompactEmbed("fin-client", {
          ok: false,
          error: code,
          message: "fixture message",
        });
        const data = embed.toJSON() as {
          title?: string;
          color?: number;
          description?: string;
        };
        expect(data.color).toBe(0xe74c3c);
        expect(data.title).toContain("fin-client");
        expect(data.description).toContain(code);
        expect(data.description).toContain("fixture message");
      });
    }

    it("T04-E2: admin invocation with IPC throw → red embed with thrown message", async () => {
      mockedSendIpcRequest.mockRejectedValue(new Error("ipc boom"));
      const routingTable: RoutingTable = {
        channelToAgent: new Map([["chan-1", "fin-client"]]),
        agentToChannels: new Map([["fin-client", ["chan-1"]]]),
      };
      const handler = makeHandler({ routingTable });
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
      const editArg = editReply.mock.calls[0]![0] as {
        embeds?: { toJSON: () => { color?: number; description?: string } }[];
      };
      const json = editArg.embeds?.[0]?.toJSON();
      expect(json?.color).toBe(0xe74c3c);
      expect(json?.description).toContain("ipc boom");
    });

    it("T04-E3: IPC error response → editReply with red embed (no thrown error)", async () => {
      mockedSendIpcRequest.mockResolvedValue({
        ok: false,
        error: "ERR_TURN_TOO_LONG",
        message: "Turn has been in-flight for 720s (budget 600s).",
      });
      const routingTable: RoutingTable = {
        channelToAgent: new Map([["chan-1", "fin-client"]]),
        agentToChannels: new Map([["fin-client", ["chan-1"]]]),
      };
      const handler = makeHandler({ routingTable });
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
      const editArg = editReply.mock.calls[0]![0] as {
        embeds?: { toJSON: () => { color?: number; description?: string } }[];
      };
      const json = editArg.embeds?.[0]?.toJSON();
      expect(json?.color).toBe(0xe74c3c);
      expect(json?.description).toContain("ERR_TURN_TOO_LONG");
      expect(json?.description).toContain("720s");
    });
  });
});
