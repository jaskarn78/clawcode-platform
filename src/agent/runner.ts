import type { Logger } from "pino";
import { logger } from "../shared/logger.js";
import type { SessionAdapter, SessionHandle } from "../manager/session-adapter.js";
import type { AgentSessionConfig } from "../manager/types.js";

/**
 * Minimal bridge interface required by AgentRunner.
 * Allows injection of the real DiscordBridge or a mock in tests.
 */
export type BridgeLike = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

/**
 * Configuration for AgentRunner.
 */
export type AgentRunnerOptions = {
  /** Session config passed to the adapter on each (re)start. */
  readonly sessionConfig: AgentSessionConfig;
  /** Adapter that creates and resumes Claude Code sessions. */
  readonly sessionAdapter: SessionAdapter;
  /** Discord bridge (or compatible mock) to connect. */
  readonly discordBridge: BridgeLike;
  /** Maximum crash restarts before giving up (default: 3). */
  readonly maxRestarts?: number;
  /** Base backoff delay in ms between restarts (default: 1000). Doubles each attempt. */
  readonly backoffBaseMs?: number;
  /** Called when maxRestarts is exhausted and runner stops permanently. */
  readonly onExhausted?: () => void;
  readonly log?: Logger;
};

/**
 * Standalone agent runner.
 *
 * Starts a single Claude Code agent session and connects it to Discord.
 * Handles crash recovery with exponential backoff up to `maxRestarts`.
 * Does NOT require the full daemon (no IPC socket, registry, or heartbeat).
 */
export class AgentRunner {
  private readonly sessionConfig: AgentSessionConfig;
  private readonly sessionAdapter: SessionAdapter;
  private readonly discordBridge: BridgeLike;
  private readonly maxRestarts: number;
  private readonly backoffBaseMs: number;
  private readonly onExhausted: (() => void) | undefined;
  private readonly log: Logger;

  private handle: SessionHandle | null = null;
  private running = false;
  private restartCount = 0;
  private bridgeStarted = false;

  constructor(options: AgentRunnerOptions) {
    this.sessionConfig = options.sessionConfig;
    this.sessionAdapter = options.sessionAdapter;
    this.discordBridge = options.discordBridge;
    this.maxRestarts = options.maxRestarts ?? 3;
    this.backoffBaseMs = options.backoffBaseMs ?? 1000;
    this.onExhausted = options.onExhausted;
    this.log = options.log ?? logger;
  }

  /**
   * Start the agent session and Discord bridge.
   * @throws if already running
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error(`AgentRunner for '${this.sessionConfig.name}' is already running`);
    }
    this.running = true;
    this.restartCount = 0;

    if (!this.bridgeStarted) {
      await this.discordBridge.start();
      this.bridgeStarted = true;
      this.log.info({ agent: this.sessionConfig.name }, "discord bridge started");
    }

    await this.createSession();
  }

  /**
   * Stop the agent session and Discord bridge gracefully.
   */
  async stop(): Promise<void> {
    if (!this.running && !this.bridgeStarted) {
      return;
    }
    this.running = false;

    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }

    if (this.bridgeStarted) {
      await this.discordBridge.stop();
      this.bridgeStarted = false;
    }

    this.log.info({ agent: this.sessionConfig.name }, "agent runner stopped");
  }

  /**
   * Create a new session and attach crash handler.
   */
  private async createSession(): Promise<void> {
    this.log.info(
      { agent: this.sessionConfig.name, restart: this.restartCount },
      "starting agent session",
    );

    const handle = await this.sessionAdapter.createSession(this.sessionConfig);
    this.handle = handle;

    handle.onError((err) => {
      this.log.warn(
        { agent: this.sessionConfig.name, error: err.message, restartCount: this.restartCount },
        "agent session crashed",
      );
      void this.handleCrash();
    });

    handle.onEnd(() => {
      if (this.running) {
        this.log.info({ agent: this.sessionConfig.name }, "agent session ended");
      }
    });
  }

  /**
   * Handle a crash: apply backoff delay then restart, or exhaust.
   */
  private async handleCrash(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.handle = null;
    this.restartCount += 1;

    if (this.restartCount > this.maxRestarts) {
      this.log.error(
        { agent: this.sessionConfig.name, restartCount: this.restartCount, maxRestarts: this.maxRestarts },
        "max restarts exceeded — agent runner stopping",
      );
      this.running = false;
      this.onExhausted?.();
      return;
    }

    const delayMs = this.backoffBaseMs * Math.pow(2, this.restartCount - 1);
    this.log.info(
      { agent: this.sessionConfig.name, delayMs, attempt: this.restartCount },
      "restarting after crash",
    );

    await new Promise((resolve) => setTimeout(resolve, delayMs));

    if (!this.running) {
      return;
    }

    await this.createSession();
  }
}
