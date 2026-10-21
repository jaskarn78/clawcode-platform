/**
 * Phase 100 follow-up — `/clawcode-effort` admin-clawdy channel guard +
 * optional `agent:` target.
 *
 * Behavior contract (mirrors handleGsdLongRunner guard at slash-commands.ts:1942):
 *   - Invocation from any non-admin-clawdy channel → reply with restriction
 *     message; sessionManager.setEffortForAgent NOT called.
 *   - Invocation from #admin-clawdy without `agent:` option → applies effort
 *     to admin-clawdy (channel-bound default).
 *   - Invocation from #admin-clawdy with `agent: <known>` → applies effort
 *     to that target agent.
 *   - Invocation from #admin-clawdy with `agent: <unknown>` → reply with
 *     unknown-agent error; sessionManager.setEffortForAgent NOT called.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RoutingTable } from "../types.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { SessionManager } from "../../manager/session-manager.js";
import { SlashCommandHandler } from "../slash-commands.js";
import { UltracodeNotAllowedError } from "../../manager/model-errors.js";
import { checkUltracodeEligibility } from "../../manager/ultracode-gate.js";

function makeAgent(name: string): ResolvedAgentConfig {
  // Test fixture omits many optional fields on ResolvedAgentConfig — the
  // SUT under test only reads name/admin/effort, so we cast through
  // `unknown` rather than fabricating every nested zod-default.
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
  } as unknown as ResolvedAgentConfig;
}

function makeStubLogger(): {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  child: () => unknown;
} {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  return log;
}

function makeStubSessionManager(opts: {
  knownAgents: readonly string[];
}): {
  sessionManager: SessionManager;
  setEffortForAgent: ReturnType<typeof vi.fn>;
  getAgentConfig: ReturnType<typeof vi.fn>;
} {
  const setEffortForAgent = vi.fn();
  const getAgentConfig = vi.fn((name: string) =>
    opts.knownAgents.includes(name)
      ? ({ name } as Partial<ResolvedAgentConfig>)
      : undefined,
  );
  const sessionManager = {
    setEffortForAgent,
    getAgentConfig,
    getEffortForAgent: vi.fn().mockReturnValue("medium"),
    getModelForAgent: vi.fn().mockReturnValue(undefined),
    streamFromAgent: vi.fn(),
    hasActiveTurn: vi.fn().mockReturnValue(false),
    interruptAgent: vi.fn(),
  } as unknown as SessionManager;
  return { sessionManager, setEffortForAgent, getAgentConfig };
}

function makeInteraction(opts: {
  channelId: string;
  level: string;
  agent?: string;
}): {
  editReply: ReturnType<typeof vi.fn>;
  interaction: unknown;
} {
  const editReply = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    commandName: "clawcode-effort",
    channelId: opts.channelId,
    isChatInputCommand: () => true,
    reply,
    editReply,
    deferReply,
    options: {
      get: (name: string) => {
        if (name === "level") return { value: opts.level };
        if (name === "agent" && opts.agent !== undefined)
          return { value: opts.agent };
        return null;
      },
    },
    user: { id: "user-1" },
    id: "interaction-1",
  };
  return { editReply, interaction };
}

function makeHandler(opts: {
  routingTable: RoutingTable;
  resolvedAgents: readonly ResolvedAgentConfig[];
  sessionManager: SessionManager;
}): SlashCommandHandler {
  const fakeClient = {
    user: { id: "app-id-1" },
    guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  return new SlashCommandHandler({
    routingTable: opts.routingTable,
    sessionManager: opts.sessionManager,
    resolvedAgents: opts.resolvedAgents,
    botToken: "fake-token",
    client: fakeClient as never,
    log: makeStubLogger(),
  } as never);
}

const ADMIN_CHANNEL = "admin-channel-id";
const FIN_CHANNEL = "fin-channel-id";

const routingTable: RoutingTable = {
  channelToAgent: new Map([
    [ADMIN_CHANNEL, "Admin Clawdy"],
    [FIN_CHANNEL, "fin-client"],
  ]),
  agentToChannels: new Map([
    ["Admin Clawdy", [ADMIN_CHANNEL]],
    ["fin-client", [FIN_CHANNEL]],
  ]),
};

describe("Phase 100 follow-up — /clawcode-effort admin-clawdy guard", () => {
  let stub: ReturnType<typeof makeStubSessionManager>;
  let handler: SlashCommandHandler;

  beforeEach(() => {
    stub = makeStubSessionManager({
      knownAgents: ["Admin Clawdy", "fin-client"],
    });
    handler = makeHandler({
      routingTable,
      resolvedAgents: [makeAgent("Admin Clawdy"), makeAgent("fin-client")],
      sessionManager: stub.sessionManager,
    });
  });

  it("EG1: non-admin-clawdy channel → restricted message, NO setEffortForAgent", async () => {
    const { editReply, interaction } = makeInteraction({
      channelId: FIN_CHANNEL,
      level: "high",
    });
    await (handler as never as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);
    expect(stub.setEffortForAgent).not.toHaveBeenCalled();
    const restrictedReplies = editReply.mock.calls.filter((c) =>
      String(c[0]).includes("restricted to #admin-clawdy"),
    );
    expect(restrictedReplies.length).toBeGreaterThanOrEqual(1);
  });

  it("EG2: #admin-clawdy without agent option → applies to admin-clawdy", async () => {
    const { interaction } = makeInteraction({
      channelId: ADMIN_CHANNEL,
      level: "high",
    });
    await (handler as never as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);
    expect(stub.setEffortForAgent).toHaveBeenCalledTimes(1);
    expect(stub.setEffortForAgent).toHaveBeenCalledWith("Admin Clawdy", "high");
  });

  it("EG3: #admin-clawdy with agent: fin-client → applies to fin-client", async () => {
    const { interaction } = makeInteraction({
      channelId: ADMIN_CHANNEL,
      level: "max",
      agent: "fin-client",
    });
    await (handler as never as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);
    expect(stub.setEffortForAgent).toHaveBeenCalledTimes(1);
    expect(stub.setEffortForAgent).toHaveBeenCalledWith(
      "fin-client",
      "max",
    );
    expect(stub.getAgentConfig).toHaveBeenCalledWith("fin-client");
  });

  it("EG4: #admin-clawdy with agent: <unknown> → unknown-agent reply, NO setEffortForAgent", async () => {
    const { editReply, interaction } = makeInteraction({
      channelId: ADMIN_CHANNEL,
      level: "low",
      agent: "ghost-agent",
    });
    await (handler as never as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);
    expect(stub.setEffortForAgent).not.toHaveBeenCalled();
    const unknownReplies = editReply.mock.calls.filter((c) =>
      String(c[0]).includes("Unknown agent"),
    );
    expect(unknownReplies.length).toBeGreaterThanOrEqual(1);
  });

  it("EG5: #admin-clawdy with invalid level → invalid-level reply, NO setEffortForAgent", async () => {
    const { editReply, interaction } = makeInteraction({
      channelId: ADMIN_CHANNEL,
      level: "ultra-mega-high",
    });
    await (handler as never as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);
    expect(stub.setEffortForAgent).not.toHaveBeenCalled();
    const invalidReplies = editReply.mock.calls.filter((c) =>
      String(c[0]).includes("Invalid effort level"),
    );
    expect(invalidReplies.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Quick 260715-j1j (D6/D8) — /clawcode-effort ultracode gate surfacing.
//
// `ultracode` passes the validLevels check (derives from effortSchema.options
// after D8), then SessionManager.setEffortForAgent runs the eligibility gate.
// A gate rejection throws UltracodeNotAllowedError — the handler must render
// its operator-readable reason as the ephemeral reply (not a generic
// "Failed to set effort"). The reasons asserted here come from the REAL gate
// (checkUltracodeEligibility) so the reply text can never drift from it.
// ---------------------------------------------------------------------------
describe("quick 260715-j1j — /clawcode-effort ultracode gate rejections", () => {
  function makeGatedHandler(agentConfig: {
    model?: string;
    nativeWorkflow?: boolean;
  }): {
    handler: SlashCommandHandler;
    setEffortForAgent: ReturnType<typeof vi.fn>;
  } {
    // Stub SessionManager that mirrors the REAL gate placement: level
    // "ultracode" runs checkUltracodeEligibility over the agent config and
    // throws the typed error on rejection (exactly what
    // SessionManager.setEffortForAgent does).
    const setEffortForAgent = vi.fn((name: string, level: string) => {
      if (level === "ultracode") {
        const res = checkUltracodeEligibility(agentConfig);
        if (!res.ok) throw new UltracodeNotAllowedError(name, res.reason);
      }
    });
    const sessionManager = {
      setEffortForAgent,
      getAgentConfig: vi.fn((name: string) => ({ name, ...agentConfig })),
      getEffortForAgent: vi.fn().mockReturnValue("medium"),
      getModelForAgent: vi.fn().mockReturnValue(undefined),
      streamFromAgent: vi.fn(),
      hasActiveTurn: vi.fn().mockReturnValue(false),
      interruptAgent: vi.fn(),
    } as unknown as SessionManager;
    const handler = makeHandler({
      routingTable,
      resolvedAgents: [makeAgent("Admin Clawdy"), makeAgent("fin-client")],
      sessionManager,
    });
    return { handler, setEffortForAgent };
  }

  it("UG1: wrong model (sonnet) → reply carries the gate's model reason", async () => {
    const { handler } = makeGatedHandler({ model: "sonnet", nativeWorkflow: true });
    const { editReply, interaction } = makeInteraction({
      channelId: ADMIN_CHANNEL,
      level: "ultracode",
    });
    await (handler as never as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);
    const rejections = editReply.mock.calls.filter((c) =>
      String(c[0]).includes("does not support ultracode"),
    );
    expect(rejections.length).toBeGreaterThanOrEqual(1);
  });

  it("UG2: nativeWorkflow off (opus) → reply carries the gate's flag reason", async () => {
    const { handler } = makeGatedHandler({ model: "opus", nativeWorkflow: false });
    const { editReply, interaction } = makeInteraction({
      channelId: ADMIN_CHANNEL,
      level: "ultracode",
    });
    await (handler as never as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);
    const rejections = editReply.mock.calls.filter((c) =>
      String(c[0]).includes("nativeWorkflow"),
    );
    expect(rejections.length).toBeGreaterThanOrEqual(1);
    // The generic failure prefix must NOT be the rendering path.
    const generic = editReply.mock.calls.filter((c) =>
      String(c[0]).includes("Failed to set effort"),
    );
    expect(generic).toHaveLength(0);
  });

  it("UG3: eligible agent (opus + nativeWorkflow) → accepted, success reply", async () => {
    const { handler, setEffortForAgent } = makeGatedHandler({
      model: "opus",
      nativeWorkflow: true,
    });
    const { editReply, interaction } = makeInteraction({
      channelId: ADMIN_CHANNEL,
      level: "ultracode",
    });
    await (handler as never as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);
    expect(setEffortForAgent).toHaveBeenCalledWith("Admin Clawdy", "ultracode");
    const successes = editReply.mock.calls.filter((c) =>
      String(c[0]).includes("Effort set to **ultracode**"),
    );
    expect(successes.length).toBeGreaterThanOrEqual(1);
  });

  it("UG4: 'ultracode' passes the validLevels check (no 'Invalid effort level' reply — D8 schema-derived)", async () => {
    const { handler } = makeGatedHandler({ model: "sonnet", nativeWorkflow: false });
    const { editReply, interaction } = makeInteraction({
      channelId: ADMIN_CHANNEL,
      level: "ultracode",
    });
    await (handler as never as {
      handleInteraction: (i: unknown) => Promise<void>;
    }).handleInteraction(interaction);
    const invalidReplies = editReply.mock.calls.filter((c) =>
      String(c[0]).includes("Invalid effort level"),
    );
    expect(invalidReplies).toHaveLength(0);
  });
});
