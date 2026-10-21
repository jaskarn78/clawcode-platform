/**
 * Phase 100 follow-up — auto-inheritance of GSD slash commands.
 *
 * Pins the registration-time merge: when ANY agent has `gsd?.projectDir` set,
 * the GSD_SLASH_COMMANDS constant gets injected into the per-guild REST body.
 * When NO agent has gsd.projectDir, no /gsd-* entries appear in the body.
 *
 * Phase 999.21 — entries are now NESTED subcommands under a single
 * `/get-shit-done` top-level command instead of 19 flat `gsd-*` entries.
 * The registration emits ONE composite Discord body item with 19 type=1
 * (SUB_COMMAND) children. The pins are updated to reflect the new shape:
 * the GSD-enabled-agent assertion now checks that ONE composite entry
 * appears with all 19 expected subcommand names; the no-GSD-agent assertion
 * checks that NO `get-shit-done` entry appears at all.
 *
 * Pins (3 tests):
 *   GSR-1  At least one GSD-enabled agent → 1 composite get-shit-done body
 *          item with 19 subcommand options
 *   GSR-2  No GSD-enabled agent → no get-shit-done entry registered, no
 *          flat /gsd-* commands either
 *   GSR-3  Multiple GSD-enabled agents → composite get-shit-done appears
 *          exactly ONCE (deduped) with 19 subcommands
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedAgentConfig } from "../../shared/types.js";

// Hoisted REST.put spy (mirrors slash-commands-register.test.ts pattern).
const { restPutSpy } = vi.hoisted(() => ({
  restPutSpy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("discord.js", async () => {
  const actual = await vi.importActual<typeof import("discord.js")>("discord.js");
  class MockREST {
    setToken(_token: string): this {
      return this;
    }
    put(route: string, opts: { body: unknown }): Promise<void> {
      return restPutSpy(route, opts);
    }
  }
  return {
    ...actual,
    REST: MockREST,
  };
});

import { SlashCommandHandler } from "../slash-commands.js";
import { GSD_SLASH_COMMANDS } from "../slash-types.js";
import type { SessionManager } from "../../manager/session-manager.js";

type SubOption = {
  name: string;
  type: number;
  description?: string;
  required?: boolean;
  options?: SubOption[];
};

type BodyEntry = {
  name: string;
  description?: string;
  options?: SubOption[];
};

function makeAgent(opts: {
  name: string;
  gsd?: { projectDir: string };
}): ResolvedAgentConfig {
  return {
    name: opts.name,
    workspace: `/tmp/${opts.name}`,
    memoryPath: `/tmp/${opts.name}`,
    channels: [],
    model: "sonnet",
    effort: "low",
    skills: [],
    soul: undefined,
    identity: undefined,
    slashCommands: [],
    settingSources: ["project"],
    gsd: opts.gsd,
    allowedModels: ["haiku", "sonnet", "opus"],
  } as unknown as ResolvedAgentConfig;
}

function makeSessionManagerStub(): SessionManager {
  return {
    getSessionHandle(_name: string) {
      return undefined;
    },
  } as unknown as SessionManager;
}

describe("Phase 100 follow-up — auto-inheritance of GSD_SLASH_COMMANDS at register time (Phase 999.21 nested form)", () => {
  beforeEach(() => {
    restPutSpy.mockClear();
    restPutSpy.mockResolvedValue(undefined);
  });

  it("GSR-1: at least one GSD-enabled agent → composite /get-shit-done body item with 19 subcommands", async () => {
    const agent = makeAgent({
      name: "Admin Clawdy",
      gsd: { projectDir: "/opt/clawcode-projects/sandbox" },
    });
    const client = {
      user: { id: "bot-123" },
      guilds: { cache: new Map([["guild-1", {}]]) },
    } as unknown as import("discord.js").Client;

    const handler = new SlashCommandHandler({
      routingTable: { channelToAgent: new Map(), agentToChannels: new Map() },
      sessionManager: makeSessionManagerStub(),
      resolvedAgents: [agent],
      botToken: "test-token",
      client,
    } as never);

    await handler.register();

    expect(restPutSpy).toHaveBeenCalledTimes(1);
    const [_route, opts] = restPutSpy.mock.calls[0]!;
    const body = (opts as { body: BodyEntry[] }).body;

    // Phase 999.21 — exactly ONE composite top-level entry named
    // get-shit-done; no flat gsd-* leaks through.
    const composites = body.filter((b) => b.name === "get-shit-done");
    expect(composites).toHaveLength(1);
    const composite = composites[0]!;
    expect(composite.options).toBeDefined();
    expect(Array.isArray(composite.options)).toBe(true);
    expect(composite.options).toHaveLength(19);

    // Every child is a SUB_COMMAND (type=1) and matches a stripped name
    // from GSD_SLASH_COMMANDS.
    const expectedSubNames = new Set(GSD_SLASH_COMMANDS.map((c) => c.name));
    const childNames = new Set<string>();
    for (const child of composite.options!) {
      expect(child.type).toBe(1);
      childNames.add(child.name);
    }
    expect(childNames).toEqual(expectedSubNames);

    // No flat gsd-* top-level entries leak through anywhere in the body.
    const flatLeaks = body.filter((b) => b.name.startsWith("gsd-"));
    expect(flatLeaks).toHaveLength(0);
  });

  it("GSR-2: NO GSD-enabled agent → no /get-shit-done entry, no flat /gsd-* entries", async () => {
    const agent = makeAgent({ name: "personal" });
    const client = {
      user: { id: "bot-123" },
      guilds: { cache: new Map([["guild-1", {}]]) },
    } as unknown as import("discord.js").Client;

    const handler = new SlashCommandHandler({
      routingTable: { channelToAgent: new Map(), agentToChannels: new Map() },
      sessionManager: makeSessionManagerStub(),
      resolvedAgents: [agent],
      botToken: "test-token",
      client,
    } as never);

    await handler.register();

    expect(restPutSpy).toHaveBeenCalledTimes(1);
    const [_route, opts] = restPutSpy.mock.calls[0]!;
    const body = (opts as { body: BodyEntry[] }).body;
    const names = body.map((b) => b.name);
    expect(names).not.toContain("get-shit-done");
    const flatLeaks = names.filter((n) => n.startsWith("gsd-"));
    expect(flatLeaks).toEqual([]);
  });

  it("GSR-3: multiple GSD-enabled agents → composite /get-shit-done appears exactly ONCE (deduped)", async () => {
    const adminClawdy = makeAgent({
      name: "Admin Clawdy",
      gsd: { projectDir: "/opt/clawcode-projects/sandbox" },
    });
    const clientAgent = makeAgent({
      name: "fin-client",
      gsd: { projectDir: "/home/example-user/.openclaw/workspace-acme" },
    });
    const client = {
      user: { id: "bot-123" },
      guilds: { cache: new Map([["guild-1", {}]]) },
    } as unknown as import("discord.js").Client;

    const handler = new SlashCommandHandler({
      routingTable: { channelToAgent: new Map(), agentToChannels: new Map() },
      sessionManager: makeSessionManagerStub(),
      resolvedAgents: [adminClawdy, clientAgent],
      botToken: "test-token",
      client,
    } as never);

    await handler.register();

    expect(restPutSpy).toHaveBeenCalledTimes(1);
    const [_route, opts] = restPutSpy.mock.calls[0]!;
    const body = (opts as { body: BodyEntry[] }).body;
    const composites = body.filter((b) => b.name === "get-shit-done");
    expect(composites).toHaveLength(1);
    expect(composites[0]!.options).toHaveLength(19);
    // Each subcommand name must appear exactly once.
    const counts = new Map<string, number>();
    for (const child of composites[0]!.options!) {
      counts.set(child.name, (counts.get(child.name) ?? 0) + 1);
    }
    for (const cmd of GSD_SLASH_COMMANDS) {
      expect(counts.get(cmd.name)).toBe(1);
    }
  });
});
