/**
 * Phase 140 Plan 04 Task 3 — side-band discord.js (slash + threads ONLY).
 *
 * Under v3 each agent is a `claude --channels` session that owns its Discord
 * I/O through the official Channels plugin. Two things the Channels plugin
 * canNOT do for itself, and which therefore live here in a deliberately narrow
 * side-band gateway connection:
 *
 *   1. **Slash-command registration** — `PUT applicationCommands` via the REST
 *      API (the plugin subscribes to a channel; it does not own the bot's
 *      application-command set).
 *   2. **Slash-interaction forwarding** — a gateway `interactionCreate`
 *      listener that hands each `ChatInputCommandInteraction` to the daemon
 *      over an injected IPC seam (the daemon decides what each command does).
 *   3. **Thread creation** — `channel.threads.create(...)` (the Channels
 *      plugin can post into a channel but cannot create a thread).
 *
 * **What this module MUST NOT do (CONTEXT scope fence):** deliver cross-agent
 * (a2a), cron, dream, or any daemon-originated message. Those go over the
 * ClawCode channel (Plan 03 — per-agent Unix socket → MCP notification), NOT
 * over a discord.js gateway connection. Consequently:
 *
 *   - The gateway `Client` is constructed with `GatewayIntentBits.Guilds`
 *     ONLY — no message-body intents whatsoever. It cannot read message
 *     bodies, so it structurally cannot become a message-delivery path.
 *   - There is NO message-send surface anywhere in this file. A static-grep
 *     acceptance check enforces that the message-delivery tokens (the content
 *     intent + any send method) never appear in the source — count must be 0.
 *
 * DI discipline mirrors the rest of the manager: the `Client`, `REST`, and the
 * slash→IPC callback are injected behind seams, so the unit test asserts the
 * intents array, the registration payload, and the thread-create call without
 * a live gateway connection.
 *
 * See:
 *   - `src/discord/slash-commands.ts:1337` — the `new REST({version:"10"})
 *     .setToken(...)` + `rest.put(Routes.application*Commands(...), {body})`
 *     pattern this mirrors.
 *   - `src/discord/subagent-thread-spawner.ts:932` — the `threads.create(...)`
 *     precedent (autoArchiveDuration 1440).
 *   - `.planning/phases/140-claudecode-interactive-channels-backend/140-CONTEXT.md`
 *     — side-band = slash reg + thread create ONLY.
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  type ApplicationCommandDataResolvable,
  type ChatInputCommandInteraction,
  type Interaction,
} from "discord.js";

/**
 * The EXACT gateway intents this side-band connection uses. `Guilds` only —
 * enough to see guild + channel structure (needed to fetch a parent channel
 * for thread creation and to receive `interactionCreate`), but NOT message
 * content. Exported so the test can assert array equality and so the value is
 * single-sourced.
 */
export const SIDE_BAND_INTENTS = [GatewayIntentBits.Guilds] as const;

/** Default thread auto-archive (minutes) — mirrors subagent-thread-spawner. */
const DEFAULT_THREAD_AUTO_ARCHIVE_MINUTES = 1440;

/** Pino-compatible logger subset. */
export interface SideBandLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

/**
 * The minimal channel surface thread creation needs. A discord.js `TextChannel`
 * satisfies it structurally; the test passes a mock. Deliberately exposes ONLY
 * `threads.create` — NO `send` — so this module has no message-delivery reach.
 */
export interface ThreadCapableChannel {
  readonly threads: {
    create(options: {
      name: string;
      autoArchiveDuration?: number;
    }): Promise<{ readonly id: string }>;
  };
}

/** Seams injected for testability (no live gateway / REST in unit tests). */
export interface SideBandDiscordSeams {
  /**
   * The gateway client. Production constructs
   * `new Client({ intents: SIDE_BAND_INTENTS })`; the test injects a mock that
   * records `.on("interactionCreate", ...)` registrations. When omitted, the
   * real client is built (NOT connected — `start()` owns `login`).
   */
  readonly client?: Pick<Client, "on"> & {
    readonly options?: { readonly intents?: unknown };
  };
  /**
   * REST client factory. Production: `new REST({version:"10"}).setToken(token)`.
   * The test injects a fake recording `put(route, { body })`.
   */
  readonly rest?: Pick<REST, "put">;
  /**
   * Fetch a thread-capable channel by id (for `createThread`). Production wraps
   * `client.channels.fetch(id)`; the test injects a mock channel.
   */
  readonly fetchChannel?: (channelId: string) => Promise<ThreadCapableChannel>;
}

export interface SideBandDiscordOptions {
  /** Bot token for the REST client (slash registration). */
  readonly token: string;
  /** Application (client) id — the `PUT applicationCommands` route subject. */
  readonly applicationId: string;
  /**
   * Forward a slash interaction to the daemon. The ONLY outbound path from a
   * gateway event — the daemon owns what each command does. Kept as a seam so
   * the IPC contract has a single grep target.
   */
  readonly onSlashInteraction: (
    interaction: ChatInputCommandInteraction,
  ) => Promise<void> | void;
  readonly log: SideBandLogger;
  readonly seams?: SideBandDiscordSeams;
}

/**
 * The side-band gateway connection. Narrow by construction: slash registration
 * + interaction forwarding + thread creation. No message-delivery surface.
 */
export class SideBandDiscord {
  private readonly rest: Pick<REST, "put">;
  private readonly client: Pick<Client, "on"> & {
    readonly options?: { readonly intents?: unknown };
  };
  private readonly fetchChannel?: (
    channelId: string,
  ) => Promise<ThreadCapableChannel>;

  constructor(private readonly options: SideBandDiscordOptions) {
    const seams = options.seams ?? {};
    // Guilds-only client — structurally incapable of reading message content.
    this.client =
      seams.client ?? new Client({ intents: [...SIDE_BAND_INTENTS] });
    this.rest =
      seams.rest ?? new REST({ version: "10" }).setToken(options.token);
    this.fetchChannel = seams.fetchChannel;

    // Wire the slash-interaction listener immediately so a `start()` (login)
    // that connects the gateway begins forwarding without a second step.
    this.client.on("interactionCreate", (interaction: Interaction) => {
      // Only chat-input (slash) commands are forwarded — buttons, selects,
      // autocomplete, etc. are out of side-band scope.
      if (!interaction.isChatInputCommand?.()) return;
      void this.forwardInteraction(interaction);
    });
  }

  /**
   * Register the bot's application commands via REST `PUT applicationCommands`
   * (global). The daemon owns the command set; this is the single mechanism
   * the Channels plugin cannot provide. Returns the route used (for tests +
   * operator logs).
   */
  async registerCommands(
    commands: readonly ApplicationCommandDataResolvable[],
  ): Promise<void> {
    const route = Routes.applicationCommands(this.options.applicationId);
    await this.rest.put(route, { body: commands });
    this.options.log.info(
      { route, count: commands.length },
      "side-band: registered application commands",
    );
  }

  /**
   * Create a thread under a parent channel. The Channels plugin can post into
   * a channel but cannot create threads, so this is side-band's job.
   */
  async createThread(args: {
    readonly channelId: string;
    readonly name: string;
    readonly autoArchiveMinutes?: number;
  }): Promise<{ readonly id: string }> {
    if (!this.fetchChannel) {
      throw new Error(
        "side-band createThread requires a channel fetch seam (production " +
          "wraps client.channels.fetch). None was injected.",
      );
    }
    const channel = await this.fetchChannel(args.channelId);
    const thread = await channel.threads.create({
      name: args.name,
      autoArchiveDuration:
        args.autoArchiveMinutes ?? DEFAULT_THREAD_AUTO_ARCHIVE_MINUTES,
    });
    this.options.log.info(
      { channelId: args.channelId, threadId: thread.id, name: args.name },
      "side-band: created thread",
    );
    return thread;
  }

  /** Forward one slash interaction to the daemon IPC seam (best-effort). */
  private async forwardInteraction(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    try {
      await this.options.onSlashInteraction(interaction);
    } catch (err) {
      this.options.log.warn(
        {
          command: interaction.commandName,
          error: (err as Error).message,
        },
        "side-band: slash interaction forward failed",
      );
    }
  }
}
