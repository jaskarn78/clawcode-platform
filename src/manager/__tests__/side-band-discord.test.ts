/**
 * Phase 140 Plan 04 Task 3 — side-band discord.js tests.
 *
 * Asserts the narrow contract: Guilds-only intents, slash registration via
 * REST `PUT applicationCommands`, slash-interaction → IPC forwarding, and
 * thread creation — and NOTHING else (no message-delivery surface; that is
 * grep-enforced against the source, not tested here).
 */

import { describe, it, expect, vi } from "vitest";

import {
  GatewayIntentBits,
  Routes,
  type ApplicationCommandDataResolvable,
  type ChatInputCommandInteraction,
} from "discord.js";

import {
  SideBandDiscord,
  SIDE_BAND_INTENTS,
  type SideBandDiscordSeams,
  type ThreadCapableChannel,
} from "../side-band-discord.js";

const silentLog = { info: () => {}, warn: () => {} };

/** A mock gateway client recording interactionCreate handler registration. */
function makeMockClient(): {
  client: NonNullable<SideBandDiscordSeams["client"]>;
  handlers: Map<string, (arg: unknown) => void>;
} {
  const handlers = new Map<string, (arg: unknown) => void>();
  const client = {
    options: { intents: [...SIDE_BAND_INTENTS] },
    on(event: string, handler: (arg: unknown) => void) {
      handlers.set(event, handler);
      return this;
    },
  } as unknown as NonNullable<SideBandDiscordSeams["client"]>;
  return { client, handlers };
}

describe("SideBandDiscord — intents", () => {
  it("exposes exactly [GatewayIntentBits.Guilds] (no message intent)", () => {
    expect([...SIDE_BAND_INTENTS]).toEqual([GatewayIntentBits.Guilds]);
    // And nothing message-related leaked in.
    expect([...SIDE_BAND_INTENTS]).not.toContain(GatewayIntentBits.MessageContent);
    expect([...SIDE_BAND_INTENTS]).not.toContain(GatewayIntentBits.GuildMessages);
  });
});

describe("SideBandDiscord — slash registration", () => {
  it("calls REST.put on the applicationCommands route with the command bodies", async () => {
    const put = vi.fn(
      async (_route: string, _options?: { body?: unknown }) => undefined,
    );
    const { client } = makeMockClient();
    const sb = new SideBandDiscord({
      token: "tok",
      applicationId: "app_123",
      onSlashInteraction: () => {},
      log: silentLog,
      seams: { client, rest: { put } },
    });

    const commands: ApplicationCommandDataResolvable[] = [
      { name: "status", description: "Show status" } as ApplicationCommandDataResolvable,
      { name: "restart", description: "Restart agent" } as ApplicationCommandDataResolvable,
    ];
    await sb.registerCommands(commands);

    expect(put).toHaveBeenCalledTimes(1);
    const [route, payload] = put.mock.calls[0]!;
    expect(route).toBe(Routes.applicationCommands("app_123"));
    expect(payload).toEqual({ body: commands });
  });
});

describe("SideBandDiscord — slash interaction forwarding", () => {
  it("forwards a chat-input interaction to the IPC seam", async () => {
    const onSlashInteraction = vi.fn(async () => {});
    const { client, handlers } = makeMockClient();
    new SideBandDiscord({
      token: "tok",
      applicationId: "app_123",
      onSlashInteraction,
      log: silentLog,
      seams: { client, rest: { put: vi.fn(async () => undefined) } },
    });

    const handler = handlers.get("interactionCreate");
    expect(handler).toBeDefined();

    const fakeInteraction = {
      commandName: "status",
      isChatInputCommand: () => true,
    } as unknown as ChatInputCommandInteraction;
    handler!(fakeInteraction);
    // forwardInteraction is async/fire-and-forget — let the microtask drain.
    await Promise.resolve();

    expect(onSlashInteraction).toHaveBeenCalledWith(fakeInteraction);
  });

  it("ignores non-chat-input interactions (buttons, autocomplete, etc.)", async () => {
    const onSlashInteraction = vi.fn(async () => {});
    const { client, handlers } = makeMockClient();
    new SideBandDiscord({
      token: "tok",
      applicationId: "app_123",
      onSlashInteraction,
      log: silentLog,
      seams: { client, rest: { put: vi.fn(async () => undefined) } },
    });

    const handler = handlers.get("interactionCreate")!;
    handler({ isChatInputCommand: () => false } as unknown);
    await Promise.resolve();
    expect(onSlashInteraction).not.toHaveBeenCalled();
  });
});

describe("SideBandDiscord — thread creation", () => {
  it("delegates to the channel's threads.create with name + parent", async () => {
    const create = vi.fn(async () => ({ id: "thread_999" }));
    const channel: ThreadCapableChannel = { threads: { create } };
    const fetchChannel = vi.fn(async () => channel);
    const { client } = makeMockClient();

    const sb = new SideBandDiscord({
      token: "tok",
      applicationId: "app_123",
      onSlashInteraction: () => {},
      log: silentLog,
      seams: {
        client,
        rest: { put: vi.fn(async () => undefined) },
        fetchChannel,
      },
    });

    const thread = await sb.createThread({
      channelId: "chan_42",
      name: "subagent-thread",
    });

    expect(fetchChannel).toHaveBeenCalledWith("chan_42");
    expect(create).toHaveBeenCalledWith({
      name: "subagent-thread",
      autoArchiveDuration: 1440,
    });
    expect(thread.id).toBe("thread_999");
  });

  it("throws a clear error when no channel-fetch seam is wired", async () => {
    const { client } = makeMockClient();
    const sb = new SideBandDiscord({
      token: "tok",
      applicationId: "app_123",
      onSlashInteraction: () => {},
      log: silentLog,
      seams: { client, rest: { put: vi.fn(async () => undefined) } },
    });
    await expect(
      sb.createThread({ channelId: "c", name: "n" }),
    ).rejects.toThrow(/channel fetch seam/);
  });
});
