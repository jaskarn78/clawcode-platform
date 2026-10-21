/**
 * Phase 86 Plan 03 Task 1 — /clawcode-model inline handler tests (MODEL-02, MODEL-03, MODEL-06).
 *
 * Pins the replacement of the old LLM-prompt routing (claudeCommand
 * "Set my model to {model}") with direct IPC dispatch + a native
 * StringSelectMenuBuilder picker for the no-arg invocation. Also pins the
 * ephemeral allowed-list rendering when the IPC error envelope carries
 * data.kind === "model-not-allowed".
 *
 * Test groups:
 *   NO-ARG-1..5 — picker rendering, cap, select-menu dispatch, timeout, empty list
 *   ARG-1..4    — direct IPC dispatch, ModelNotAllowedError rendering, generic error, unbound channel
 *   UI-01       — structural assertion that the no-arg reply is a component payload
 *
 * Confirmation flow (Task 2) is NOT exercised here — these tests run against
 * a SessionManager stub whose getModelForAgent returns undefined (fresh-boot
 * path → no confirmation prompt). Task 2 adds a separate test file that drives
 * the confirmation path explicitly.
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

function makeAgent(
  name: string,
  allowed: ReadonlyArray<"haiku" | "sonnet" | "opus">,
): ResolvedAgentConfig {
  return {
    name,
    workspace: `/tmp/${name}`,
    memoryPath: `/tmp/${name}`,
    channels: ["chan-1"],
    model: "haiku",
    effort: "low",
    skills: [],
    slashCommands: [],
    allowedModels: allowed,
    soul: undefined,
    identity: undefined,
  } as unknown as ResolvedAgentConfig;
}

function makeAgentWithArbitraryAllowed(
  name: string,
  allowed: ReadonlyArray<string>,
): ResolvedAgentConfig {
  // Test-only: bypasses the schema's modelSchema enum check because
  // ResolvedAgentConfig is a TS type — runtime construction accepts any strings.
  return {
    name,
    workspace: `/tmp/${name}`,
    memoryPath: `/tmp/${name}`,
    channels: ["chan-1"],
    model: "haiku",
    effort: "low",
    skills: [],
    slashCommands: [],
    allowedModels: allowed,
    soul: undefined,
    identity: undefined,
  } as unknown as ResolvedAgentConfig;
}

function makeStubSessionManager(
  activeModel: string | undefined = undefined,
): SessionManager {
  return {
    getModelForAgent: vi.fn().mockReturnValue(activeModel),
    getEffortForAgent: vi.fn().mockReturnValue("medium"),
  } as unknown as SessionManager;
}

type ReplyMock = ReturnType<typeof vi.fn>;

function makeInteraction(opts: {
  channelId: string;
  modelArg?: string;
  /** 2026-09-04 — optional `agent` target option. */
  agentArg?: string;
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
    commandName: "clawcode-model",
    channelId: opts.channelId,
    isChatInputCommand: () => true,
    reply,
    editReply,
    deferReply,
    channel: {
      awaitMessageComponent,
    },
    options: {
      get: (name: string) => {
        if (name === "model" && opts.modelArg !== undefined) {
          return { value: opts.modelArg };
        }
        if (name === "agent" && opts.agentArg !== undefined) {
          return { value: opts.agentArg };
        }
        return null;
      },
      getString: (name: string) => {
        if (name === "model" && opts.modelArg !== undefined) {
          return opts.modelArg;
        }
        if (name === "agent" && opts.agentArg !== undefined) {
          return opts.agentArg;
        }
        return null;
      },
    },
    user: { id: "user-1" },
    id: "interaction-1",
  };

  return { reply, editReply, deferReply, awaitMessageComponent, interaction };
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

describe("Phase 86 MODEL-02 / MODEL-03 / MODEL-06 — /clawcode-model inline handler", () => {
  beforeEach(() => {
    mockedSendIpcRequest.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // NO-ARG path — the select-menu picker.
  // ---------------------------------------------------------------------------

  describe("NO-ARG path", () => {
    it("NO-ARG-1: renders a StringSelectMenuBuilder with one option per allowedModels entry", async () => {
      const handler = makeHandler({
        routingTable: boundRouting,
        resolvedAgents: [makeAgent("clawdy", ["haiku", "sonnet"])],
      });
      // Never resolves — this test only cares about the initial reply() call.
      const harness = makeInteraction({
        channelId: "chan-1",
        awaitMessageComponent: () => new Promise(() => {}),
      });

      // Drive handleInteraction without waiting for the select-menu collector.
      void (handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }).handleInteraction(harness.interaction);

      // Yield to the event loop so the reply() call fires before assertions.
      await new Promise((r) => setTimeout(r, 0));

      expect(harness.reply).toHaveBeenCalledTimes(1);
      const callArg = harness.reply.mock.calls[0]![0] as {
        components?: ReadonlyArray<{
          components: ReadonlyArray<{
            options: ReadonlyArray<{ data: { value: string } }>;
          }>;
        }>;
        ephemeral?: boolean;
      };
      expect(callArg.ephemeral).toBe(true);
      expect(callArg.components).toBeDefined();
      expect(callArg.components).toHaveLength(1);
      const row = callArg.components![0]!;
      expect(row.components).toHaveLength(1);
      const menu = row.components[0]!;
      const values = menu.options.map((o) => o.data.value);
      // The test's stated invariant — ONE option per allowedModels entry — holds.
      expect(values).toHaveLength(2);
      expect([...values].sort()).toEqual(["haiku", "sonnet"]);
      // Phase 999.114 — ORDER is no longer the raw allowedModels order. Options
      // are grouped strongest-family-first (sonnet rank 1 > haiku rank 0), then
      // pin -> @latest -> legacy within a family, because the list now carries
      // every historical pin and reads as a menu rather than a raw alias dump.
      expect(values).toEqual(["sonnet", "haiku"]);
      // Labels are human names now, not the bare config alias.
      const labels = (
        menu.options as ReadonlyArray<{ data: { label?: string } }>
      ).map((o) => o.data.label);
      expect(labels).toEqual(["Claude Sonnet 5", "Claude Haiku 4.5"]);
    });

    it("NO-ARG-2: caps the rendered menu at 25 options and appends an overflow note to the content", async () => {
      const many = Array.from({ length: 27 }, (_, i) => `model-${i}`);
      const handler = makeHandler({
        routingTable: boundRouting,
        resolvedAgents: [makeAgentWithArbitraryAllowed("clawdy", many)],
      });
      const harness = makeInteraction({
        channelId: "chan-1",
        awaitMessageComponent: () => new Promise(() => {}),
      });

      void (handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }).handleInteraction(harness.interaction);
      await new Promise((r) => setTimeout(r, 0));

      expect(harness.reply).toHaveBeenCalledTimes(1);
      const callArg = harness.reply.mock.calls[0]![0] as {
        content: string;
        components: ReadonlyArray<{
          components: ReadonlyArray<{ options: ReadonlyArray<unknown> }>;
        }>;
      };
      const menu = callArg.components[0]!.components[0]!;
      expect(menu.options).toHaveLength(25);
      expect(callArg.content).toMatch(/25 of 27|Showing first 25/i);
    });

    it("NO-ARG-3: select-menu interaction dispatches via IPC set-model with the chosen value", async () => {
      mockedSendIpcRequest.mockResolvedValue({
        agent: "clawdy",
        old_model: "haiku",
        new_model: "sonnet",
        persisted: true,
        persist_error: null,
        note: "Live swap + clawcode.yaml updated",
      });

      const sessionManager = makeStubSessionManager(undefined);
      const handler = makeHandler({
        routingTable: boundRouting,
        resolvedAgents: [makeAgent("clawdy", ["haiku", "sonnet"])],
        sessionManager,
      });

      const followUp = {
        values: ["sonnet"],
        user: { id: "user-1" },
        customId: "",
        update: vi.fn().mockResolvedValue(undefined),
      };
      const harness = makeInteraction({
        channelId: "chan-1",
        awaitMessageComponent: async () => followUp,
      });

      await (handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }).handleInteraction(harness.interaction);

      expect(mockedSendIpcRequest).toHaveBeenCalledTimes(1);
      const ipcArgs = mockedSendIpcRequest.mock.calls[0]!;
      expect(ipcArgs[1]).toBe("set-model");
      expect(ipcArgs[2]).toEqual({ agent: "clawdy", model: "sonnet" });
    });

    it("NO-ARG-4: awaitMessageComponent timeout replies 'Model picker timed out' and does NOT call IPC", async () => {
      const sessionManager = makeStubSessionManager(undefined);
      const handler = makeHandler({
        routingTable: boundRouting,
        resolvedAgents: [makeAgent("clawdy", ["haiku", "sonnet"])],
        sessionManager,
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

      expect(mockedSendIpcRequest).not.toHaveBeenCalled();
      const contents = harness.editReply.mock.calls
        .map((c) => {
          const first = c[0];
          return typeof first === "string" ? first : (first as { content?: string }).content ?? "";
        })
        .join("\n");
      expect(contents).toMatch(/timed out/i);
    });

    it("NO-ARG-5: empty allowedModels replies 'No models available' ephemerally and renders no menu", async () => {
      const handler = makeHandler({
        routingTable: boundRouting,
        resolvedAgents: [makeAgentWithArbitraryAllowed("clawdy", [])],
      });
      const harness = makeInteraction({
        channelId: "chan-1",
      });

      await (handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }).handleInteraction(harness.interaction);

      expect(mockedSendIpcRequest).not.toHaveBeenCalled();
      expect(harness.reply).toHaveBeenCalledTimes(1);
      const callArg = harness.reply.mock.calls[0]![0] as {
        content?: string;
        components?: unknown;
        ephemeral?: boolean;
      };
      expect(callArg.ephemeral).toBe(true);
      expect(callArg.content).toMatch(/no models available/i);
      // No components rendered for the empty case.
      expect(callArg.components ?? []).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // ARG path — direct IPC dispatch.
  // ---------------------------------------------------------------------------

  describe("ARG path", () => {
    it("ARG-1: /clawcode-model sonnet dispatches via IPC set-model and replies with new model", async () => {
      mockedSendIpcRequest.mockResolvedValue({
        agent: "clawdy",
        old_model: "haiku",
        new_model: "sonnet",
        persisted: true,
        persist_error: null,
        note: "Live swap + clawcode.yaml updated",
      });

      const handler = makeHandler({
        routingTable: boundRouting,
        resolvedAgents: [makeAgent("clawdy", ["haiku", "sonnet"])],
      });
      const harness = makeInteraction({
        channelId: "chan-1",
        modelArg: "sonnet",
      });

      await (handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }).handleInteraction(harness.interaction);

      expect(mockedSendIpcRequest).toHaveBeenCalledTimes(1);
      const ipcArgs = mockedSendIpcRequest.mock.calls[0]!;
      expect(ipcArgs[1]).toBe("set-model");
      expect(ipcArgs[2]).toEqual({ agent: "clawdy", model: "sonnet" });

      const contents = harness.editReply.mock.calls
        .map((c) => {
          const first = c[0];
          return typeof first === "string" ? first : (first as { content?: string }).content ?? "";
        })
        .join("\n");
      expect(contents).toMatch(/sonnet/);
      expect(contents).toMatch(/clawdy/);
    });

    it("ARG-2: IPC error with data.kind 'model-not-allowed' renders the allowed list ephemerally", async () => {
      const err = new Error(
        "Model 'opus' is not in the allowed list for agent 'clawdy'. Allowed: haiku, sonnet",
      );
      (err as unknown as { data?: unknown }).data = {
        kind: "model-not-allowed",
        agent: "clawdy",
        attempted: "opus",
        allowed: ["haiku", "sonnet"],
      };
      mockedSendIpcRequest.mockRejectedValue(err);

      const handler = makeHandler({
        routingTable: boundRouting,
        resolvedAgents: [makeAgent("clawdy", ["haiku", "sonnet"])],
      });
      const harness = makeInteraction({
        channelId: "chan-1",
        modelArg: "opus",
      });

      await (handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }).handleInteraction(harness.interaction);

      const contents = harness.editReply.mock.calls
        .map((c) => {
          const first = c[0];
          return typeof first === "string" ? first : (first as { content?: string }).content ?? "";
        })
        .join("\n");
      expect(contents).toMatch(/opus/);
      expect(contents).toMatch(/not allowed/i);
      expect(contents).toMatch(/haiku, sonnet/);
    });

    it("ARG-3: generic IPC error surfaces the error message ephemerally without the allowed-list branch", async () => {
      mockedSendIpcRequest.mockRejectedValue(new Error("daemon offline"));
      const handler = makeHandler({
        routingTable: boundRouting,
        resolvedAgents: [makeAgent("clawdy", ["haiku", "sonnet"])],
      });
      const harness = makeInteraction({
        channelId: "chan-1",
        modelArg: "sonnet",
      });

      await (handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }).handleInteraction(harness.interaction);

      const contents = harness.editReply.mock.calls
        .map((c) => {
          const first = c[0];
          return typeof first === "string" ? first : (first as { content?: string }).content ?? "";
        })
        .join("\n");
      expect(contents).toMatch(/daemon offline/);
      expect(contents).not.toMatch(/Allowed:/);
    });

    it("ARG-4: channel not bound to an agent — replies 'not bound' and does NOT call IPC", async () => {
      const handler = makeHandler({
        routingTable: {
          channelToAgent: new Map(),
          agentToChannels: new Map(),
        },
        resolvedAgents: [makeAgent("clawdy", ["haiku", "sonnet"])],
      });
      const harness = makeInteraction({
        channelId: "unbound-channel",
        modelArg: "sonnet",
      });

      await (handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }).handleInteraction(harness.interaction);

      expect(mockedSendIpcRequest).not.toHaveBeenCalled();
      // The reply path for an unbound channel uses interaction.reply (ephemeral), not editReply.
      const allReplies = [
        ...harness.reply.mock.calls.map((c) => c[0]),
        ...harness.editReply.mock.calls.map((c) => c[0]),
      ];
      const joined = allReplies
        .map((arg) =>
          typeof arg === "string" ? arg : (arg as { content?: string }).content ?? "",
        )
        .join("\n");
      expect(joined).toMatch(/not bound/i);
    });
  });

  // ---------------------------------------------------------------------------
  // UI-01 — structural compliance (native components, not free-text).
  // ---------------------------------------------------------------------------

  describe("UI-01 compliance", () => {
    it("no-arg reply is a components payload (StringSelectMenuBuilder), not a free-text prompt", async () => {
      const handler = makeHandler({
        routingTable: boundRouting,
        resolvedAgents: [makeAgent("clawdy", ["haiku", "sonnet", "opus"])],
      });
      const harness = makeInteraction({
        channelId: "chan-1",
        awaitMessageComponent: () => new Promise(() => {}),
      });

      void (handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }).handleInteraction(harness.interaction);
      await new Promise((r) => setTimeout(r, 0));

      expect(harness.reply).toHaveBeenCalledTimes(1);
      const callArg = harness.reply.mock.calls[0]![0] as {
        components?: unknown;
        ephemeral?: boolean;
      };
      expect(callArg.components).toBeDefined();
      expect(Array.isArray(callArg.components)).toBe(true);
      // Presence of components is the UI-01 signal. Content may optionally
      // hold a prompt string ("Pick a model..."), but it must NOT be the sole
      // UI (free-text fallback).
      expect((callArg.components as unknown[]).length).toBeGreaterThan(0);
    });
  });
  // ---------------------------------------------------------------------------
  // 2026-09-04 — optional `agent` target option.
  //
  // /clawcode-model was the ONLY per-agent mutator without an `agent` option
  // (effort/style/verify/tools/usage/dream/optimize/workflows/session-compact
  // all have one), so a model change could only be made from the target
  // agent's own channel. One `agentName` drives the allowedModels lookup, the
  // picker customId and the IPC dispatch, so these cover both paths.
  // ---------------------------------------------------------------------------

  describe("AGENT target option", () => {
    const twoAgents = [
      makeAgent("clawdy", ["haiku", "sonnet"]),
      makeAgent("other-agent", ["opus"]),
    ];

    it("AGENT-1: explicit agent retargets the ARG path — IPC carries the target, not the channel agent", async () => {
      mockedSendIpcRequest.mockResolvedValue({
        agent: "other-agent",
        old_model: "haiku",
        new_model: "opus",
        persisted: true,
        persist_error: null,
        note: "Live swap",
      });

      const handler = makeHandler({
        routingTable: boundRouting,
        resolvedAgents: twoAgents,
      });
      // channel is bound to "clawdy" — the option must win.
      const harness = makeInteraction({
        channelId: "chan-1",
        modelArg: "opus",
        agentArg: "other-agent",
      });

      await (handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }).handleInteraction(harness.interaction);

      expect(mockedSendIpcRequest).toHaveBeenCalledTimes(1);
      expect(mockedSendIpcRequest.mock.calls[0]![2]).toEqual({
        agent: "other-agent",
        model: "opus",
      });
    });

    it("AGENT-2: omitting the option keeps the channel-bound agent (no regression)", async () => {
      mockedSendIpcRequest.mockResolvedValue({
        agent: "clawdy",
        old_model: "haiku",
        new_model: "sonnet",
        persisted: true,
        persist_error: null,
        note: "Live swap",
      });

      const handler = makeHandler({
        routingTable: boundRouting,
        resolvedAgents: twoAgents,
      });
      const harness = makeInteraction({
        channelId: "chan-1",
        modelArg: "sonnet",
      });

      await (handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }).handleInteraction(harness.interaction);

      expect(mockedSendIpcRequest.mock.calls[0]![2]).toEqual({
        agent: "clawdy",
        model: "sonnet",
      });
    });

    it("AGENT-3: explicit agent works from an UNBOUND channel", async () => {
      mockedSendIpcRequest.mockResolvedValue({
        agent: "other-agent",
        old_model: "haiku",
        new_model: "opus",
        persisted: true,
        persist_error: null,
        note: "Live swap",
      });

      const handler = makeHandler({
        routingTable: {
          channelToAgent: new Map(),
          agentToChannels: new Map(),
        },
        resolvedAgents: twoAgents,
      });
      const harness = makeInteraction({
        channelId: "unbound-chan",
        modelArg: "opus",
        agentArg: "other-agent",
      });

      await (handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }).handleInteraction(harness.interaction);

      expect(mockedSendIpcRequest).toHaveBeenCalledTimes(1);
      expect(mockedSendIpcRequest.mock.calls[0]![2]).toEqual({
        agent: "other-agent",
        model: "opus",
      });
    });

    it("AGENT-4: unbound channel AND no option → explicit 'no agent was provided' reply, no IPC", async () => {
      const handler = makeHandler({
        routingTable: {
          channelToAgent: new Map(),
          agentToChannels: new Map(),
        },
        resolvedAgents: twoAgents,
      });
      const harness = makeInteraction({ channelId: "unbound-chan" });

      await (handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }).handleInteraction(harness.interaction);

      expect(mockedSendIpcRequest).not.toHaveBeenCalled();
      const content = harness.reply.mock.calls[0]![0] as { content?: string };
      expect(content.content).toMatch(/no agent was provided/i);
    });

    it("AGENT-5: NO-ARG picker renders the TARGET agent's allowedModels, not the channel agent's", async () => {
      const handler = makeHandler({
        routingTable: boundRouting,
        resolvedAgents: twoAgents,
      });
      // channel agent "clawdy" allows haiku+sonnet; target allows only opus.
      const harness = makeInteraction({
        channelId: "chan-1",
        agentArg: "other-agent",
      });

      void (handler as unknown as {
        handleInteraction: (i: unknown) => Promise<void>;
      }).handleInteraction(harness.interaction);
      await new Promise((r) => setTimeout(r, 0));

      expect(harness.reply).toHaveBeenCalledTimes(1);
      const callArg = harness.reply.mock.calls[0]![0] as {
        components?: unknown;
      };
      const json = JSON.stringify(callArg.components);
      expect(json).toContain("other-agent");
      expect(json).toContain("opus");
      expect(json).not.toContain("sonnet");
    });
  });
});
