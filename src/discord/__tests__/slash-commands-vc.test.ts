/**
 * Phase 135 Plan 01 Task 3 — /vc {join,leave,status} slash commands +
 * placeholder handler dispatch.
 *
 * Pins three behaviors Plan 02 will replace handler bodies on top of:
 *
 *   1. `/vc` registers as a single top-level slash command with three
 *      SUB_COMMAND (type=1) options: `join` (with channel:CHANNEL nested
 *      option type=7), `leave`, `status`.
 *   2. `handleVcCommand` dispatches by `interaction.options.getSubcommand()`
 *      and returns the Plan-02-deferred placeholder string for join +
 *      leave.
 *   3. The status subcommand calls `voiceManager.status()` and replies
 *      with the JSON-serialised result. The Plan 01 scaffold's status
 *      returns `[]`, so the reply is the literal string `"[]"`.
 *
 * The handler MUST wrap dispatch in try/catch (Pitfall 8 — voice
 * subsystem must not leak errors into the text path). The test
 * confirms that a handler whose voiceManager.status() throws still
 * replies with an error message instead of propagating.
 */
import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SLASH_COMMANDS } from "../slash-types.js";
import { handleVcCommand } from "../voice/command.js";
import { VoiceManager } from "../voice/manager.js";

describe("/vc registration shape — Phase 135 Plan 01 Task 3", () => {
  const vc = DEFAULT_SLASH_COMMANDS.find((c) => c.name === "vc");

  it("registers a single top-level /vc command", () => {
    expect(vc).toBeDefined();
  });

  it("declares three subcommands: join, leave, status", () => {
    expect(vc).toBeDefined();
    if (!vc) return;
    const subNames = vc.options.map((o) => o.name).sort();
    expect(subNames).toEqual(["join", "leave", "status"]);
  });

  it("every subcommand is type=1 (SUB_COMMAND)", () => {
    expect(vc).toBeDefined();
    if (!vc) return;
    for (const opt of vc.options) {
      expect(opt.type).toBe(1);
    }
  });

  it("sets ipcMethod to 'vc' for dispatch routing", () => {
    expect(vc).toBeDefined();
    if (!vc) return;
    expect(vc.ipcMethod).toBe("vc");
  });
});

describe("handleVcCommand — placeholder dispatch", () => {
  function makeFakeInteraction(sub: string): {
    interaction: {
      options: { getSubcommand: () => string };
      reply: ReturnType<typeof vi.fn>;
      replied: boolean;
    };
    getReplyArg: () => string;
  } {
    const reply = vi.fn(async (_arg: unknown) => undefined);
    const interaction = {
      options: { getSubcommand: () => sub },
      reply,
      replied: false,
    };
    const getReplyArg = (): string => {
      const arg = reply.mock.calls[0]?.[0];
      if (typeof arg === "string") return arg;
      if (arg && typeof arg === "object" && "content" in arg) {
        return String((arg as { content: unknown }).content);
      }
      return "";
    };
    return { interaction, getReplyArg };
  }

  function makeVoiceManager(opts: { throwOnStatus?: boolean } = {}): VoiceManager {
    const fakeLog = {
      child: () => fakeLog,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown;
    const vm = new VoiceManager(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeLog as any,
      [],
      new Map(),
    );
    if (opts.throwOnStatus) {
      vm.status = () => {
        throw new Error("simulated voice failure");
      };
    }
    return vm;
  }

  // Phase 135 Plan 02 update — Plan 01 returned a Plan-02-deferred
  // placeholder string for join/leave. Plan 02 wires the real
  // VoiceManager.join/leave behavior; we now pin the user-facing reply
  // shape (guild-required + no-agent-configured paths from
  // src/discord/voice/command.ts).
  it("join subcommand without a guildId replies with the in-DM guard", async () => {
    const { interaction, getReplyArg } = makeFakeInteraction("join");
    const vm = makeVoiceManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleVcCommand(interaction as any, vm);
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(getReplyArg()).toMatch(/must be invoked in a guild/i);
  });

  it("leave subcommand without a guildId replies with the in-DM guard", async () => {
    const { interaction, getReplyArg } = makeFakeInteraction("leave");
    const vm = makeVoiceManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleVcCommand(interaction as any, vm);
    expect(getReplyArg()).toMatch(/must be invoked in a guild/i);
  });

  it("status subcommand replies with the JSON-serialised voiceManager.status() (empty array)", async () => {
    const { interaction, getReplyArg } = makeFakeInteraction("status");
    const vm = makeVoiceManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleVcCommand(interaction as any, vm);
    // status() returns [] from the scaffold; JSON.stringify([]) === "[]"
    expect(getReplyArg()).toContain("[]");
  });

  it("an error thrown by voiceManager does NOT propagate; handler replies with a friendly error", async () => {
    const { interaction, getReplyArg } = makeFakeInteraction("status");
    const vm = makeVoiceManager({ throwOnStatus: true });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleVcCommand(interaction as any, vm),
    ).resolves.toBeUndefined();
    expect(getReplyArg()).toMatch(/voice subsystem error|see daemon logs|error/i);
  });
});
