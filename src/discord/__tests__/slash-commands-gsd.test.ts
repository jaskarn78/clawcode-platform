/**
 * Phase 100 Plan 04 — `/gsd-*` Discord slash dispatcher tests.
 *
 * 12th application of the inline-handler-short-circuit pattern (after
 * /clawcode-tools, /clawcode-model, /clawcode-permissions, /clawcode-skills*,
 * /clawcode-plugins-browse, /clawcode-clawhub-auth, /clawcode-sync-status,
 * /clawcode-cutover-verify, /clawcode-dream, /clawcode-probe-fs).
 *
 * Pins (14 tests):
 *   GSD-1  dispatch detects gsd-autonomous as long-runner → spawnInThread once
 *   GSD-2  dispatch detects gsd-plan-phase as long-runner → spawnInThread once
 *   GSD-3  dispatch detects gsd-execute-phase as long-runner → spawnInThread once
 *   GSD-4  dispatch does NOT call spawnInThread for gsd-debug (short-runner)
 *   GSD-5  dispatch does NOT call spawnInThread for gsd-quick (short-runner)
 *   GSD-6  call-order: deferReply BEFORE spawnInThread (3s race-safe)
 *   GSD-7  admin-clawdy guard: non-admin channel → editReply rejection, NO spawn
 *   GSD-8  spawnInThread receives parentAgentName='admin-clawdy'
 *   GSD-9  spawnInThread receives task = canonical /gsd:* string from formatCommandMessage
 *   GSD-10 thread name format 'gsd:autonomous:100' for input args='100'
 *   GSD-11 thread name format 'gsd:plan:100' for /gsd-plan-phase phase='100'
 *   GSD-12 thread name fallback 'gsd:autonomous' when no phaseArg
 *   GSD-13 spawnInThread fails → editReply with verbatim err.message (Phase 85 TOOL-04)
 *   GSD-14 missing subagentThreadSpawner DI → editReply 'Subagent thread spawning unavailable'
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "pino";

import { SlashCommandHandler } from "../slash-commands.js";
import type { SessionManager } from "../../manager/session-manager.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { SlashCommandDef } from "../slash-types.js";
import type { RoutingTable } from "../types.js";

const ADMIN_CLAWDY_CHANNEL = "admin-clawdy-channel-1";
const NON_ADMIN_CHANNEL = "fin-client-channel-1";

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

/**
 * Build a stand-in for the 5 GSD slashCommand entries that Plan 07 will land
 * in clawcode.yaml. Plan 04 does NOT modify clawcode.yaml — these fixture
 * entries simulate what admin-clawdy's resolved slashCommands list will look
 * like once Plan 07 ships. The handleGsdLongRunner method reads cmdDef from
 * resolvedAgents.find(...).slashCommands.find(...) so this fixture is the
 * minimal contract needed to make Task 2's GREEN code pass.
 */
function makeGsdSlashCommands(): readonly SlashCommandDef[] {
  return [
    {
      name: "gsd-autonomous",
      description: "Run all remaining phases autonomously",
      claudeCommand: "/gsd:autonomous {args}",
      options: [
        {
          name: "args",
          type: 3,
          description: "Optional flags (e.g. --from 100)",
          required: false,
        },
      ],
    },
    {
      name: "gsd-plan-phase",
      description: "Create phase plan with verification loop",
      claudeCommand: "/gsd:plan-phase {phase}",
      options: [
        {
          name: "phase",
          type: 3,
          description: "Phase number + optional flags",
          required: false,
        },
      ],
    },
    {
      name: "gsd-execute-phase",
      description: "Execute all plans in a phase",
      claudeCommand: "/gsd:execute-phase {phase}",
      options: [
        {
          name: "phase",
          type: 3,
          description: "Phase number + optional flags",
          required: false,
        },
      ],
    },
    {
      name: "gsd-debug",
      description: "Systematic debugging with persistent state",
      claudeCommand: "/gsd:debug {issue}",
      options: [
        {
          name: "issue",
          type: 3,
          description: "Issue description",
          required: true,
        },
      ],
    },
    {
      name: "gsd-quick",
      description: "Quick task with GSD guarantees",
      claudeCommand: "/gsd:quick {task}",
      options: [
        {
          name: "task",
          type: 3,
          description: "Task description",
          required: true,
        },
      ],
    },
  ];
}

function makeAdminClawdy(
  slashCommands: readonly SlashCommandDef[] = makeGsdSlashCommands(),
): ResolvedAgentConfig {
  return {
    name: "Admin Clawdy",
    workspace: "/tmp/admin-clawdy",
    memoryPath: "/tmp/admin-clawdy",
    channels: [ADMIN_CLAWDY_CHANNEL],
    model: "sonnet",
    effort: "low",
    skills: [],
    soul: undefined,
    identity: undefined,
    slashCommands,
    settingSources: ["project", "user"],
    // Phase 100 follow-up — capability-based GSD dispatch reads
    // `agent.gsd?.projectDir` instead of hardcoding "Admin Clawdy". Admin
    // Clawdy's production yaml has this set to /opt/clawcode-projects/sandbox;
    // the dev fixture mirrors that so handleGsdLongRunner accepts the agent.
    gsd: { projectDir: "/opt/clawcode-projects/sandbox" },
  } as unknown as ResolvedAgentConfig;
}

function makeClientAgent(): ResolvedAgentConfig {
  return {
    name: "fin-client",
    workspace: "/tmp/fin-client",
    memoryPath: "/tmp/fin-client",
    channels: [NON_ADMIN_CHANNEL],
    model: "sonnet",
    effort: "low",
    skills: [],
    soul: undefined,
    identity: undefined,
    slashCommands: [],
    settingSources: ["project"],
  } as unknown as ResolvedAgentConfig;
}

type SpawnInThreadResult = {
  threadId: string;
  sessionName: string;
  parentAgent: string;
  channelId: string;
};

type MockSpawner = {
  spawnInThread: ReturnType<typeof vi.fn>;
};

function makeMockSpawner(opts?: {
  rejectWith?: Error;
  resolveWith?: SpawnInThreadResult;
}): MockSpawner {
  const fn = vi.fn();
  if (opts?.rejectWith) {
    fn.mockRejectedValue(opts.rejectWith);
  } else {
    fn.mockResolvedValue(
      opts?.resolveWith ?? {
        threadId: "thread-123",
        sessionName: "admin-clawdy-sub-abc123",
        parentAgent: "Admin Clawdy",
        channelId: ADMIN_CLAWDY_CHANNEL,
      },
    );
  }
  return { spawnInThread: fn };
}

function makeRoutingTable(opts: {
  channelToAgent: Record<string, string>;
}): RoutingTable {
  const c2a = new Map(Object.entries(opts.channelToAgent));
  const a2c = new Map<string, string[]>();
  for (const [chan, agent] of c2a.entries()) {
    const list = a2c.get(agent) ?? [];
    list.push(chan);
    a2c.set(agent, list);
  }
  return {
    channelToAgent: c2a,
    agentToChannels: a2c,
  };
}

function makeHandler(opts: {
  routingTable?: RoutingTable;
  resolvedAgents?: readonly ResolvedAgentConfig[];
  subagentThreadSpawner?: MockSpawner | undefined;
}): SlashCommandHandler {
  const fakeClient = {
    user: { id: "app-id-1" },
    guilds: { cache: new Map([["guild-1", { id: "guild-1" }]]) },
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const routingTable =
    opts.routingTable ??
    makeRoutingTable({
      channelToAgent: {
        [ADMIN_CLAWDY_CHANNEL]: "Admin Clawdy",
        [NON_ADMIN_CHANNEL]: "fin-client",
      },
    });
  const resolvedAgents =
    opts.resolvedAgents ?? [makeAdminClawdy(), makeClientAgent()];

  return new SlashCommandHandler({
    routingTable,
    sessionManager: {} as unknown as SessionManager,
    resolvedAgents,
    botToken: "fake-token",
    client: fakeClient as never,
    log: makeStubLogger(),
    subagentThreadSpawner:
      opts.subagentThreadSpawner === undefined
        ? undefined
        : (opts.subagentThreadSpawner as never),
  } as never);
}

function makeInteraction(opts: {
  commandName: string;
  channelId?: string;
  options?: Record<string, string | number | boolean>;
}): {
  editReply: ReturnType<typeof vi.fn>;
  deferReply: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  interaction: unknown;
} {
  const editReply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  const optionMap = opts.options ?? {};
  const interaction = {
    commandName: opts.commandName,
    channelId: opts.channelId ?? ADMIN_CLAWDY_CHANNEL,
    guildId: "guild-1",
    isChatInputCommand: () => true,
    deferReply,
    editReply,
    reply,
    options: {
      get: (name: string) => {
        if (name in optionMap) {
          return { value: optionMap[name], name };
        }
        return null;
      },
      getString: (name: string, _required?: boolean) => {
        const v = optionMap[name];
        return typeof v === "string" ? v : null;
      },
    },
    user: { id: "operator-1" },
    id: "interaction-1",
  };
  return { editReply, deferReply, reply, interaction };
}

async function dispatch(
  handler: SlashCommandHandler,
  interaction: unknown,
): Promise<void> {
  await (
    handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }
  ).handleInteraction(interaction);
}

describe("Phase 100 — /gsd-* slash dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GSD-1: dispatch detects gsd-autonomous as long-runner → spawnInThread once", async () => {
    const spawner = makeMockSpawner();
    const handler = makeHandler({ subagentThreadSpawner: spawner });
    const { editReply, interaction } = makeInteraction({
      commandName: "gsd-autonomous",
      options: { args: "--from 100" },
    });

    await dispatch(handler, interaction);

    expect(spawner.spawnInThread).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalled();
  });

  it("GSD-2: dispatch detects gsd-plan-phase as long-runner → spawnInThread once", async () => {
    const spawner = makeMockSpawner();
    const handler = makeHandler({ subagentThreadSpawner: spawner });
    const { editReply, interaction } = makeInteraction({
      commandName: "gsd-plan-phase",
      options: { phase: "100" },
    });

    await dispatch(handler, interaction);

    expect(spawner.spawnInThread).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalled();
  });

  it("GSD-3: dispatch detects gsd-execute-phase as long-runner → spawnInThread once", async () => {
    const spawner = makeMockSpawner();
    const handler = makeHandler({ subagentThreadSpawner: spawner });
    const { editReply, interaction } = makeInteraction({
      commandName: "gsd-execute-phase",
      options: { phase: "100" },
    });

    await dispatch(handler, interaction);

    expect(spawner.spawnInThread).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalled();
  });

  it("GSD-4: dispatch does NOT call spawnInThread for gsd-debug (short-runner falls through)", async () => {
    const spawner = makeMockSpawner();
    const handler = makeHandler({ subagentThreadSpawner: spawner });
    const { interaction } = makeInteraction({
      commandName: "gsd-debug",
      options: { issue: "memory leak in tracker" },
    });

    await dispatch(handler, interaction);

    expect(spawner.spawnInThread).toHaveBeenCalledTimes(0);
  });

  it("GSD-5: dispatch does NOT call spawnInThread for gsd-quick (short-runner falls through)", async () => {
    const spawner = makeMockSpawner();
    const handler = makeHandler({ subagentThreadSpawner: spawner });
    const { interaction } = makeInteraction({
      commandName: "gsd-quick",
      options: { task: "fix typo in README" },
    });

    await dispatch(handler, interaction);

    expect(spawner.spawnInThread).toHaveBeenCalledTimes(0);
  });

  it("GSD-6: deferReply called BEFORE spawnInThread (3s Discord race-safe)", async () => {
    const spawner = makeMockSpawner();
    const handler = makeHandler({ subagentThreadSpawner: spawner });
    const { deferReply, interaction } = makeInteraction({
      commandName: "gsd-autonomous",
      options: { args: "--from 100" },
    });

    await dispatch(handler, interaction);

    expect(deferReply).toHaveBeenCalled();
    expect(spawner.spawnInThread).toHaveBeenCalled();
    const deferOrder = deferReply.mock.invocationCallOrder[0]!;
    const spawnOrder = spawner.spawnInThread.mock.invocationCallOrder[0]!;
    expect(deferOrder).toBeLessThan(spawnOrder);
  });

  it("GSD-7: admin-clawdy guard — channel bound to non-admin agent → editReply rejection, NO spawnInThread", async () => {
    const spawner = makeMockSpawner();
    const handler = makeHandler({ subagentThreadSpawner: spawner });
    const { editReply, interaction } = makeInteraction({
      commandName: "gsd-autonomous",
      channelId: NON_ADMIN_CHANNEL,
      options: { args: "--from 100" },
    });

    await dispatch(handler, interaction);

    expect(spawner.spawnInThread).toHaveBeenCalledTimes(0);
    expect(editReply).toHaveBeenCalled();
    const reply = editReply.mock.calls[0]![0] as string;
    expect(typeof reply).toBe("string");
    const replyText = reply.toLowerCase();
    // Either "restricted" or "Admin Clawdy" must appear in the rejection text
    expect(
      replyText.includes("restricted") || replyText.includes("Admin Clawdy"),
    ).toBe(true);
  });

  it("GSD-8: spawnInThread called with parentAgentName='admin-clawdy'", async () => {
    const spawner = makeMockSpawner();
    const handler = makeHandler({ subagentThreadSpawner: spawner });
    const { interaction } = makeInteraction({
      commandName: "gsd-autonomous",
      options: { args: "--from 100" },
    });

    await dispatch(handler, interaction);

    expect(spawner.spawnInThread).toHaveBeenCalledTimes(1);
    const spawnArg = spawner.spawnInThread.mock.calls[0]![0] as {
      parentAgentName: string;
    };
    expect(spawnArg.parentAgentName).toBe("Admin Clawdy");
  });

  it("GSD-9: spawnInThread called with task = canonical /gsd:autonomous --from 100 string", async () => {
    const spawner = makeMockSpawner();
    const handler = makeHandler({ subagentThreadSpawner: spawner });
    const { interaction } = makeInteraction({
      commandName: "gsd-autonomous",
      options: { args: "--from 100" },
    });

    await dispatch(handler, interaction);

    expect(spawner.spawnInThread).toHaveBeenCalledTimes(1);
    const spawnArg = spawner.spawnInThread.mock.calls[0]![0] as {
      task: string;
    };
    // claudeCommand template "/gsd:autonomous {args}" with args="--from 100"
    // → formatCommandMessage produces "/gsd:autonomous --from 100"
    expect(spawnArg.task).toBe("/gsd:autonomous --from 100");
  });

  it("GSD-10: thread name 'gsd:autonomous:100' for input args='100'", async () => {
    const spawner = makeMockSpawner();
    const handler = makeHandler({ subagentThreadSpawner: spawner });
    const { interaction } = makeInteraction({
      commandName: "gsd-autonomous",
      options: { args: "100" },
    });

    await dispatch(handler, interaction);

    expect(spawner.spawnInThread).toHaveBeenCalledTimes(1);
    const spawnArg = spawner.spawnInThread.mock.calls[0]![0] as {
      threadName: string;
    };
    expect(spawnArg.threadName).toBe("gsd:autonomous:100");
  });

  it("GSD-11: thread name 'gsd:plan:100' for /gsd-plan-phase phase='100'", async () => {
    const spawner = makeMockSpawner();
    const handler = makeHandler({ subagentThreadSpawner: spawner });
    const { interaction } = makeInteraction({
      commandName: "gsd-plan-phase",
      options: { phase: "100" },
    });

    await dispatch(handler, interaction);

    expect(spawner.spawnInThread).toHaveBeenCalledTimes(1);
    const spawnArg = spawner.spawnInThread.mock.calls[0]![0] as {
      threadName: string;
    };
    expect(spawnArg.threadName).toBe("gsd:plan:100");
  });

  it("GSD-12: thread name fallback 'gsd:autonomous' when no phaseArg given", async () => {
    const spawner = makeMockSpawner();
    const handler = makeHandler({ subagentThreadSpawner: spawner });
    const { interaction } = makeInteraction({
      commandName: "gsd-autonomous",
      options: {},
    });

    await dispatch(handler, interaction);

    expect(spawner.spawnInThread).toHaveBeenCalledTimes(1);
    const spawnArg = spawner.spawnInThread.mock.calls[0]![0] as {
      threadName: string;
    };
    expect(spawnArg.threadName).toBe("gsd:autonomous");
  });

  it("GSD-13: spawnInThread fails → editReply with verbatim err.message (Phase 85 TOOL-04)", async () => {
    const spawner = makeMockSpawner({
      rejectWith: new Error("quota exceeded"),
    });
    const handler = makeHandler({ subagentThreadSpawner: spawner });
    const { editReply, interaction } = makeInteraction({
      commandName: "gsd-autonomous",
      options: { args: "--from 100" },
    });

    await dispatch(handler, interaction);

    expect(spawner.spawnInThread).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalled();
    // Find the LAST editReply (handler may editReply twice: ack then error;
    // the verbatim error must appear in at least one of the calls).
    const allReplies = editReply.mock.calls.map(
      (c) => c[0] as string | { content?: string },
    );
    const hasVerbatim = allReplies.some((r) => {
      const text = typeof r === "string" ? r : r?.content ?? "";
      return text.includes("quota exceeded");
    });
    expect(hasVerbatim).toBe(true);
  });

  it("GSD-14: missing subagentThreadSpawner DI → editReply 'Subagent thread spawning unavailable'", async () => {
    const handler = makeHandler({ subagentThreadSpawner: undefined });
    const { editReply, interaction } = makeInteraction({
      commandName: "gsd-autonomous",
      options: { args: "--from 100" },
    });

    await dispatch(handler, interaction);

    expect(editReply).toHaveBeenCalled();
    const allReplies = editReply.mock.calls.map(
      (c) => c[0] as string | { content?: string },
    );
    const hasUnavailable = allReplies.some((r) => {
      const text = typeof r === "string" ? r : r?.content ?? "";
      return text.toLowerCase().includes("unavailable");
    });
    expect(hasUnavailable).toBe(true);
  });
});
