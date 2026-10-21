/**
 * Phase 87 Plan 01 Task 2 — SlashCommandHandler.register() integration +
 * static-grep regression pin.
 *
 * Coverage:
 *   1. STATIC-GREP REGRESSION — walks src/ (excluding __tests__/) and asserts
 *      NO hardcoded native-command array literal exists. Pattern:
 *        /const\s+(NATIVE_COMMANDS|SDK_COMMANDS|INIT_COMMANDS|CC_COMMANDS)\s*=\s*\[/
 *      A failure means someone tried to re-introduce a hardcoded list —
 *      that's explicitly forbidden by CMD-01 and the code review pin rejects
 *      it without any debate.
 *
 *   2. REGISTER INTEGRATION — stubs `discord.js.REST.put`, constructs a
 *      SlashCommandHandler with a fake SessionManager that returns a
 *      handle whose getSupportedCommands() resolves to a fixed SlashCommand[],
 *      calls `register()`, and asserts:
 *        - the REST body contains `clawcode-<name>` entries for the
 *          prompt-channel SDK commands
 *        - the REST body contains control-plane SDK commands
 *        - ACL-denied names are NOT in the REST body
 *        - the body count stays <= 90 per guild (CMD-07)
 *
 *   3. CAP VIOLATION — when the total exceeds 90, register throws before
 *      rest.put is called (negative-path pin via spy assertion).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static-grep regression pin
// ---------------------------------------------------------------------------

describe("Phase 87 CMD-01 — static-grep regression pin", () => {
  const FORBIDDEN_PATTERN =
    /const\s+(NATIVE_COMMANDS|SDK_COMMANDS|INIT_COMMANDS|CC_COMMANDS)\s*=\s*\[/;
  const SRC_ROOT = resolve(__dirname, "..", "..");

  function walk(dir: string, out: string[]): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        // Exclude __tests__ directories — test fixtures MAY legitimately
        // use these names in string literals we're asserting against.
        if (e.name === "__tests__") continue;
        if (e.name === "node_modules") continue;
        walk(full, out);
      } else if (e.isFile() && e.name.endsWith(".ts")) {
        out.push(full);
      }
    }
  }

  it("no hardcoded native-command array literal exists anywhere in src/", () => {
    // Belt-and-suspenders: statSync catches broken symlinks gracefully.
    try {
      statSync(SRC_ROOT);
    } catch {
      throw new Error(`src root missing: ${SRC_ROOT}`);
    }
    const files: string[] = [];
    walk(SRC_ROOT, files);

    const offenders: Array<{ file: string; match: string }> = [];
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      const match = content.match(FORBIDDEN_PATTERN);
      if (match) {
        offenders.push({ file, match: match[0] });
      }
    }

    // Fail message lists every offender so a reviewer sees the full picture.
    expect(
      offenders,
      `Found hardcoded native-command array literal(s):\n${offenders
        .map((o) => `  ${o.file}: ${o.match}`)
        .join("\n")}\n\n` +
        "CMD-01 forbids hardcoded native-command lists. Discovery MUST go " +
        "through SessionHandle.getSupportedCommands() at registration time.",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Register integration — stub REST + Client, assert body shape.
// ---------------------------------------------------------------------------

// `vi.hoisted` keeps the spy alive across the discord.js mock boundary.
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
import type { SessionHandle } from "../../manager/session-adapter.js";
import type { SessionManager } from "../../manager/session-manager.js";
import type { SlashCommand } from "../../manager/sdk-types.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

/**
 * Minimal SessionManager stub — the register path only calls
 * `getSessionHandle(name)`, so we stub that one method.
 */
function makeSessionManagerStub(
  handlesByName: Record<string, SessionHandle>,
): SessionManager {
  return {
    getSessionHandle(name: string): SessionHandle | undefined {
      return handlesByName[name];
    },
  } as unknown as SessionManager;
}

/** Minimal SessionHandle stub that only implements getSupportedCommands. */
function makeHandleStub(cmds: readonly SlashCommand[]): SessionHandle {
  return {
    getSupportedCommands: vi.fn().mockResolvedValue(cmds),
  } as unknown as SessionHandle;
}

/** Minimal ResolvedAgentConfig stub. Only the register() path fields are set. */
function makeAgentConfig(
  name: string,
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    name,
    workspace: `/tmp/${name}`,
    memoryPath: `/tmp/${name}/memory`,
    channels: [],
    model: "sonnet",
    effort: "low",
    allowedModels: ["haiku", "sonnet", "opus"],
    skills: [],
    soul: undefined,
    identity: undefined,
    memory: {
      compactionThreshold: 0,
      searchTopK: 5,
      consolidation: {
        enabled: false,
        weeklyThreshold: 7,
        monthlyThreshold: 30,
        schedule: "0 0 * * 0",
      },
      decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 },
      deduplication: { enabled: false, similarityThreshold: 0.95 },
    },
    heartbeat: {
      enabled: false,
      intervalSeconds: 60,
      checkTimeoutSeconds: 5,
      contextFill: { warningThreshold: 0.75, criticalThreshold: 0.9 },
    },
    skillsPath: `/tmp/${name}/skills`,
    schedules: [],
    admin: false,
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 60, maxThreadSessions: 5 },
    reactions: false,
    mcpServers: [],
    slashCommands: [],
    ...overrides,
  } as ResolvedAgentConfig;
}

/**
 * Stub discord.js Client that the handler stores. Only `user.id` and
 * `guilds.cache.keys()` are touched in register().
 */
function makeClientStub(): { cache: { keys: () => string[] } } {
  return {} as never;
}

describe("SlashCommandHandler.register — native-CC discovery + merge (Phase 87 CMD-01/04/05/07)", () => {
  beforeEach(() => {
    restPutSpy.mockClear();
    restPutSpy.mockResolvedValue(undefined);
  });

  afterEach(() => {
    restPutSpy.mockClear();
  });

  it("builds clawcode-<name> entries from SDK-reported commands + filters ACL-denied", async () => {
    const handle = makeHandleStub([
      { name: "compact", description: "Compact context", argumentHint: "" },
      { name: "model", description: "Switch model", argumentHint: "<name>" },
      { name: "init", description: "Init", argumentHint: "" },
    ]);
    const sessionManager = makeSessionManagerStub({ "agent-a": handle });
    const agent = makeAgentConfig("agent-a");

    const client = {
      user: { id: "bot-123" },
      guilds: { cache: new Map([["guild-1", {}]]) },
    } as unknown as import("discord.js").Client;

    const handler = new SlashCommandHandler({
      routingTable: new Map(),
      sessionManager,
      resolvedAgents: [agent],
      botToken: "test-token",
      client,
      aclDeniedByAgent: { "agent-a": new Set(["init"]) },
    } as unknown as ConstructorParameters<typeof SlashCommandHandler>[0]);

    await handler.register();

    expect(restPutSpy).toHaveBeenCalledTimes(1);
    const [, opts] = restPutSpy.mock.calls[0];
    const body = (opts as { body: Array<{ name: string }> }).body;
    const names = body.map((b) => b.name);

    expect(names).toContain("clawcode-compact");
    expect(names).toContain("clawcode-model");
    expect(names).not.toContain("clawcode-init");
    expect(body.length).toBeLessThanOrEqual(90);
  });

  it("registers native entries even when the agent has NO custom slashCommands", async () => {
    const handle = makeHandleStub([
      { name: "help", description: "Help", argumentHint: "" },
    ]);
    const sessionManager = makeSessionManagerStub({ "agent-a": handle });
    const agent = makeAgentConfig("agent-a", { slashCommands: [] });

    const client = {
      user: { id: "bot-123" },
      guilds: { cache: new Map([["guild-1", {}]]) },
    } as unknown as import("discord.js").Client;

    const handler = new SlashCommandHandler({
      routingTable: new Map(),
      sessionManager,
      resolvedAgents: [agent],
      botToken: "test-token",
      client,
    } as unknown as ConstructorParameters<typeof SlashCommandHandler>[0]);

    await handler.register();

    const [, opts] = restPutSpy.mock.calls[0];
    const body = (opts as { body: Array<{ name: string }> }).body;
    const names = body.map((b) => b.name);
    expect(names).toContain("clawcode-help");
  });

  it("CMD-07 — throws and does NOT call rest.put when body > 90 commands per guild", async () => {
    // Phase 117.1-02 — under the post-117.1-02 allowlist policy SDK-reported
    // commands that aren't in {model, permissions, effort, compact, cost,
    // help} are skipped at classification time, so flooding the SDK channel
    // can no longer breach the cap (that's the whole point of T02). The
    // cap path is still reachable via per-agent yaml configuration, so we
    // pin the same negative-path here by stuffing 120 entries into the
    // agent's static `slashCommands` config directly. If the cap pre-flight
    // ever regresses, this test catches it just like the SDK-flood version
    // used to.
    const stressDefs = Array.from({ length: 120 }, (_, i) => ({
      name: `stress-cmd-${i}`,
      description: `Stress ${i}`,
      claudeCommand: "",
      options: [] as const,
    }));
    const sdkHandle = makeHandleStub([]);
    const sessionManager = makeSessionManagerStub({ "agent-a": sdkHandle });
    const agent = makeAgentConfig("agent-a", {
      slashCommands: stressDefs as unknown as ResolvedAgentConfig["slashCommands"],
    });

    const client = {
      user: { id: "bot-123" },
      guilds: { cache: new Map([["guild-1", {}]]) },
    } as unknown as import("discord.js").Client;

    const handler = new SlashCommandHandler({
      routingTable: new Map(),
      sessionManager,
      resolvedAgents: [agent],
      botToken: "test-token",
      client,
    } as unknown as ConstructorParameters<typeof SlashCommandHandler>[0]);

    // register() catches the pre-flight throw internally (existing behavior
    // logs errors per guild) — so the test asserts rest.put was NEVER called
    // despite the body being over-cap.
    await handler.register();
    expect(restPutSpy).not.toHaveBeenCalled();
  });

  it("per-guild dedupe survives across 15-agent fleet (no explosion)", async () => {
    // Multiple agents with identical SDK commands — register must dedupe by
    // name, NOT per-agent-multiply (would blow past the 90 cap fast).
    const cmds: SlashCommand[] = [
      { name: "compact", description: "Compact", argumentHint: "" },
      { name: "help", description: "Help", argumentHint: "" },
    ];
    const handlesByName: Record<string, SessionHandle> = {};
    const agents: ResolvedAgentConfig[] = [];
    for (let i = 0; i < 15; i++) {
      const name = `agent-${i}`;
      handlesByName[name] = makeHandleStub(cmds);
      agents.push(makeAgentConfig(name));
    }
    const sessionManager = makeSessionManagerStub(handlesByName);

    const client = {
      user: { id: "bot-123" },
      guilds: { cache: new Map([["guild-1", {}]]) },
    } as unknown as import("discord.js").Client;

    const handler = new SlashCommandHandler({
      routingTable: new Map(),
      sessionManager,
      resolvedAgents: agents,
      botToken: "test-token",
      client,
    } as unknown as ConstructorParameters<typeof SlashCommandHandler>[0]);

    await handler.register();

    expect(restPutSpy).toHaveBeenCalledTimes(1);
    const [, opts] = restPutSpy.mock.calls[0];
    const body = (opts as { body: Array<{ name: string }> }).body;
    const names = body.map((b) => b.name);
    // Dedupe worked: the two native commands appear exactly once.
    expect(names.filter((n) => n === "clawcode-compact")).toHaveLength(1);
    expect(names.filter((n) => n === "clawcode-help")).toHaveLength(1);
  });
});
