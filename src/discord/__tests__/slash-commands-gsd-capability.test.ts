/**
 * Phase 100 follow-up — capability-based GSD dispatch (no hardcoded
 * "Admin Clawdy" name) + /gsd-set-project runtime project switcher.
 *
 * Two surfaces under test:
 *
 * 1. handleGsdLongRunner — capability check looks at the channel-bound
 *    agent's `gsd?.projectDir` field instead of hardcoding `agentName !==
 *    "Admin Clawdy"`. Previously, fin-client (which now has
 *    gsd.projectDir set to /home/example-user/.openclaw/workspace-acme/)
 *    was rejected. With the capability check, ANY GSD-enabled agent passes.
 *    Non-GSD agents (e.g. personal, fin-tax) still get rejected with a
 *    clear message that the channel's agent has no gsd.projectDir.
 *
 * 2. /gsd-set-project — new inline handler routes BEFORE GSD_LONG_RUNNERS.
 *    Validates `path` option (absolute, exists, is-directory), then sends
 *    `set-gsd-project` IPC to the daemon. The IPC is mocked here — daemon
 *    behavior is covered by gsd-project-store.test.ts + a daemon
 *    integration test (out of scope for this slash test file).
 *
 * Pins (10 tests):
 *   GSC-1  capability check accepts Admin Clawdy (has gsd.projectDir)
 *   GSC-2  capability check accepts fin-client (has gsd.projectDir)
 *   GSC-3  capability check rejects non-GSD agent (e.g. personal) with
 *          informative message that mentions the agent name + gsd.projectDir
 *   GSC-4  /gsd-set-project happy path — valid abs path → success reply
 *   GSC-5  /gsd-set-project rejects relative path
 *   GSC-6  /gsd-set-project rejects non-existent path
 *   GSC-7  /gsd-set-project rejects when calling agent has no gsd config
 *   GSC-8  /gsd-set-project sends set-gsd-project IPC with {agent, projectDir}
 *   GSC-9  /gsd-set-project — IPC failure → editReply with verbatim error
 *   GSC-10 /gsd-set-project — file (not directory) at the path → rejects
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import type { Logger } from "pino";

import { SlashCommandHandler } from "../slash-commands.js";
import type { SessionManager } from "../../manager/session-manager.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { SlashCommandDef } from "../slash-types.js";
import type { RoutingTable } from "../types.js";

const ADMIN_CLAWDY_CHANNEL = "admin-clawdy-channel-1";
const FIN_CLIENT_CHANNEL = "fin-client-channel-1";
const PERSONAL_CHANNEL = "personal-channel-1";

// ---------------------------------------------------------------------------
// IPC client mock — sendIpcRequest is what /gsd-set-project calls. We mock
// it module-wide so the slash handler dispatches into a vi.fn we control.
// ---------------------------------------------------------------------------

const { ipcSpy } = vi.hoisted(() => ({
  ipcSpy: vi.fn(),
}));

vi.mock("../../ipc/client.js", () => ({
  sendIpcRequest: ipcSpy,
}));

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

function makeAgent(opts: {
  name: string;
  channel: string;
  gsd?: { projectDir: string };
  slashCommands?: readonly SlashCommandDef[];
}): ResolvedAgentConfig {
  return {
    name: opts.name,
    workspace: `/tmp/${opts.name}`,
    memoryPath: `/tmp/${opts.name}`,
    channels: [opts.channel],
    model: "sonnet",
    effort: "low",
    skills: [],
    soul: undefined,
    identity: undefined,
    slashCommands: opts.slashCommands ?? [],
    settingSources: ["project"],
    gsd: opts.gsd,
  } as unknown as ResolvedAgentConfig;
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

type MockSpawner = {
  spawnInThread: ReturnType<typeof vi.fn>;
};

function makeMockSpawner(): MockSpawner {
  const fn = vi.fn().mockResolvedValue({
    threadId: "thread-123",
    sessionName: "sub-abc123",
    parentAgent: "Admin Clawdy",
    channelId: ADMIN_CLAWDY_CHANNEL,
  });
  return { spawnInThread: fn };
}

function makeHandler(opts: {
  resolvedAgents: readonly ResolvedAgentConfig[];
  routingTable: RoutingTable;
  spawner?: MockSpawner;
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
    resolvedAgents: opts.resolvedAgents,
    botToken: "fake-token",
    client: fakeClient as never,
    log: makeStubLogger(),
    subagentThreadSpawner: (opts.spawner ?? makeMockSpawner()) as never,
  } as never);
}

function makeInteraction(opts: {
  commandName: string;
  channelId: string;
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
    channelId: opts.channelId,
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

async function dispatch(handler: SlashCommandHandler, interaction: unknown): Promise<void> {
  await (
    handler as unknown as {
      handleInteraction: (i: unknown) => Promise<void>;
    }
  ).handleInteraction(interaction);
}

// Build a fixture set covering ALL three agent shapes:
//   Admin Clawdy → has gsd.projectDir, full slashCommands (5 originals)
//   fin-client → has gsd.projectDir, EMPTY slashCommands (auto-inherits
//     via the GSD_SLASH_COMMANDS constant — but for capability dispatch tests
//     we hand-supply the GSD slash defs so handleGsdLongRunner can find cmdDef)
//   personal → NO gsd, empty slashCommands → must be rejected
function makeGsdSlashCommands(): readonly SlashCommandDef[] {
  return [
    {
      name: "gsd-autonomous",
      description: "Run all remaining phases autonomously",
      claudeCommand: "/gsd:autonomous {args}",
      options: [
        { name: "args", type: 3, description: "args", required: false },
      ],
    },
    {
      name: "gsd-set-project",
      description: "Switch this agent's gsd.projectDir at runtime",
      claudeCommand: "",
      options: [
        { name: "path", type: 3, description: "abs path", required: true },
      ],
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  ipcSpy.mockReset();
});

describe("Phase 100 follow-up — capability-based GSD dispatch", () => {
  it("GSC-1: Admin Clawdy (has gsd.projectDir) → spawnInThread invoked", async () => {
    const spawner = makeMockSpawner();
    const handler = makeHandler({
      resolvedAgents: [
        makeAgent({
          name: "Admin Clawdy",
          channel: ADMIN_CLAWDY_CHANNEL,
          gsd: { projectDir: "/opt/clawcode-projects/sandbox" },
          slashCommands: makeGsdSlashCommands(),
        }),
      ],
      routingTable: makeRoutingTable({
        channelToAgent: { [ADMIN_CLAWDY_CHANNEL]: "Admin Clawdy" },
      }),
      spawner,
    });
    const { interaction } = makeInteraction({
      commandName: "gsd-autonomous",
      channelId: ADMIN_CLAWDY_CHANNEL,
      options: { args: "--from 100" },
    });
    await dispatch(handler, interaction);
    expect(spawner.spawnInThread).toHaveBeenCalledTimes(1);
  });

  it("GSC-2: fin-client (has gsd.projectDir) → spawnInThread invoked", async () => {
    const spawner = makeMockSpawner();
    const handler = makeHandler({
      resolvedAgents: [
        makeAgent({
          name: "fin-client",
          channel: FIN_CLIENT_CHANNEL,
          gsd: { projectDir: "/home/example-user/.openclaw/workspace-acme" },
          slashCommands: makeGsdSlashCommands(),
        }),
      ],
      routingTable: makeRoutingTable({
        channelToAgent: { [FIN_CLIENT_CHANNEL]: "fin-client" },
      }),
      spawner,
    });
    const { interaction } = makeInteraction({
      commandName: "gsd-autonomous",
      channelId: FIN_CLIENT_CHANNEL,
      options: { args: "--from 100" },
    });
    await dispatch(handler, interaction);
    expect(spawner.spawnInThread).toHaveBeenCalledTimes(1);
  });

  it("GSC-3: personal (NO gsd) → editReply rejection mentioning agent + gsd, NO spawn", async () => {
    const spawner = makeMockSpawner();
    const handler = makeHandler({
      resolvedAgents: [
        makeAgent({
          name: "personal",
          channel: PERSONAL_CHANNEL,
          // intentionally no gsd field
        }),
      ],
      routingTable: makeRoutingTable({
        channelToAgent: { [PERSONAL_CHANNEL]: "personal" },
      }),
      spawner,
    });
    const { editReply, interaction } = makeInteraction({
      commandName: "gsd-autonomous",
      channelId: PERSONAL_CHANNEL,
      options: { args: "--from 100" },
    });
    await dispatch(handler, interaction);
    expect(spawner.spawnInThread).toHaveBeenCalledTimes(0);
    expect(editReply).toHaveBeenCalled();
    const reply = editReply.mock.calls[0]![0] as string;
    const text = typeof reply === "string" ? reply : (reply as { content?: string }).content ?? "";
    // The rejection should mention either gsd, projectDir, or restricted to GSD-enabled
    const lower = text.toLowerCase();
    expect(
      lower.includes("gsd-enabled") ||
        lower.includes("projectdir") ||
        lower.includes("not a gsd") ||
        lower.includes("no gsd"),
    ).toBe(true);
    // And the agent name should appear in the rejection so operators know why
    expect(text).toContain("personal");
  });
});

describe("Phase 100 follow-up — /gsd-set-project handler", () => {
  let tmpDir: string;
  let validProjectDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), `gsd-setproj-${nanoid()}-`));
    validProjectDir = join(tmpDir, "valid-project");
    await mkdir(validProjectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function buildHandler(): SlashCommandHandler {
    return makeHandler({
      resolvedAgents: [
        makeAgent({
          name: "Admin Clawdy",
          channel: ADMIN_CLAWDY_CHANNEL,
          gsd: { projectDir: "/opt/clawcode-projects/sandbox" },
          slashCommands: makeGsdSlashCommands(),
        }),
        makeAgent({
          name: "personal",
          channel: PERSONAL_CHANNEL,
          // no gsd
        }),
      ],
      routingTable: makeRoutingTable({
        channelToAgent: {
          [ADMIN_CLAWDY_CHANNEL]: "Admin Clawdy",
          [PERSONAL_CHANNEL]: "personal",
        },
      }),
    });
  }

  it("GSC-4: happy path — valid abs path → success reply", async () => {
    ipcSpy.mockResolvedValue({ ok: true, agent: "Admin Clawdy", projectDir: validProjectDir });
    const handler = buildHandler();
    const { editReply, interaction } = makeInteraction({
      commandName: "gsd-set-project",
      channelId: ADMIN_CLAWDY_CHANNEL,
      options: { path: validProjectDir },
    });
    await dispatch(handler, interaction);
    expect(editReply).toHaveBeenCalled();
    const allReplies = editReply.mock.calls.map((c) => c[0] as string | { content?: string });
    const hasSuccess = allReplies.some((r) => {
      const text = typeof r === "string" ? r : r?.content ?? "";
      return text.includes(validProjectDir) && text.toLowerCase().includes("admin clawdy");
    });
    expect(hasSuccess).toBe(true);
  });

  it("GSC-5: rejects relative path", async () => {
    const handler = buildHandler();
    const { editReply, interaction } = makeInteraction({
      commandName: "gsd-set-project",
      channelId: ADMIN_CLAWDY_CHANNEL,
      options: { path: "./relative/path" },
    });
    await dispatch(handler, interaction);
    expect(ipcSpy).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalled();
    const allReplies = editReply.mock.calls.map((c) => c[0] as string | { content?: string });
    const hasReject = allReplies.some((r) => {
      const text = typeof r === "string" ? r : r?.content ?? "";
      return text.toLowerCase().includes("absolute");
    });
    expect(hasReject).toBe(true);
  });

  it("GSC-6: rejects non-existent path", async () => {
    const handler = buildHandler();
    const { editReply, interaction } = makeInteraction({
      commandName: "gsd-set-project",
      channelId: ADMIN_CLAWDY_CHANNEL,
      options: { path: join(tmpDir, "does-not-exist") },
    });
    await dispatch(handler, interaction);
    expect(ipcSpy).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalled();
    const allReplies = editReply.mock.calls.map((c) => c[0] as string | { content?: string });
    const hasReject = allReplies.some((r) => {
      const text = typeof r === "string" ? r : r?.content ?? "";
      const lower = text.toLowerCase();
      return lower.includes("does not exist") || lower.includes("not found") || lower.includes("missing");
    });
    expect(hasReject).toBe(true);
  });

  it("GSC-7: rejects when calling agent has no gsd config", async () => {
    const handler = buildHandler();
    const { editReply, interaction } = makeInteraction({
      commandName: "gsd-set-project",
      channelId: PERSONAL_CHANNEL, // personal has no gsd
      options: { path: validProjectDir },
    });
    await dispatch(handler, interaction);
    expect(ipcSpy).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalled();
    const allReplies = editReply.mock.calls.map((c) => c[0] as string | { content?: string });
    const hasReject = allReplies.some((r) => {
      const text = typeof r === "string" ? r : r?.content ?? "";
      const lower = text.toLowerCase();
      return lower.includes("not a gsd") || lower.includes("no gsd") || lower.includes("gsd-enabled");
    });
    expect(hasReject).toBe(true);
  });

  it("GSC-8: sends set-gsd-project IPC with {agent, projectDir}", async () => {
    ipcSpy.mockResolvedValue({ ok: true, agent: "Admin Clawdy", projectDir: validProjectDir });
    const handler = buildHandler();
    const { interaction } = makeInteraction({
      commandName: "gsd-set-project",
      channelId: ADMIN_CLAWDY_CHANNEL,
      options: { path: validProjectDir },
    });
    await dispatch(handler, interaction);
    expect(ipcSpy).toHaveBeenCalledTimes(1);
    const [_socket, method, params] = ipcSpy.mock.calls[0]!;
    expect(method).toBe("set-gsd-project");
    expect(params).toEqual({
      agent: "Admin Clawdy",
      projectDir: validProjectDir,
    });
  });

  it("GSC-9: IPC failure → editReply with verbatim error", async () => {
    ipcSpy.mockRejectedValue(new Error("daemon write failed: EACCES"));
    const handler = buildHandler();
    const { editReply, interaction } = makeInteraction({
      commandName: "gsd-set-project",
      channelId: ADMIN_CLAWDY_CHANNEL,
      options: { path: validProjectDir },
    });
    await dispatch(handler, interaction);
    expect(editReply).toHaveBeenCalled();
    const allReplies = editReply.mock.calls.map((c) => c[0] as string | { content?: string });
    const hasError = allReplies.some((r) => {
      const text = typeof r === "string" ? r : r?.content ?? "";
      return text.includes("daemon write failed: EACCES");
    });
    expect(hasError).toBe(true);
  });

  it("GSC-10: rejects when path points to a regular file (not a directory)", async () => {
    const filePath = join(tmpDir, "regular-file.txt");
    await writeFile(filePath, "hello", "utf8");
    const handler = buildHandler();
    const { editReply, interaction } = makeInteraction({
      commandName: "gsd-set-project",
      channelId: ADMIN_CLAWDY_CHANNEL,
      options: { path: filePath },
    });
    await dispatch(handler, interaction);
    expect(ipcSpy).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalled();
    const allReplies = editReply.mock.calls.map((c) => c[0] as string | { content?: string });
    const hasReject = allReplies.some((r) => {
      const text = typeof r === "string" ? r : r?.content ?? "";
      return text.toLowerCase().includes("directory");
    });
    expect(hasReject).toBe(true);
  });
});
