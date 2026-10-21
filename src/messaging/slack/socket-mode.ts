/**
 * Slack Socket Mode connection — receive events over a WebSocket with NO
 * public HTTP endpoint (works behind Tailscale / a firewall).
 *
 * Protocol (https://docs.slack.dev/apis/events-api/using-socket-mode/):
 *   1. POST apps.connections.open with the app-level token (xapp-…) → wss URL.
 *   2. Open the WebSocket. Slack sends a `hello`, then `events_api` envelopes.
 *   3. ACK every envelope immediately by echoing its `envelope_id`.
 *   4. On a `disconnect` envelope, or socket close/error, reconnect (a fresh
 *      apps.connections.open each time — the URL is single-use + expiring).
 */
import { WebSocket, type RawData } from "ws";
import type { Logger } from "pino";
import { slackApiCall } from "./web-api.js";
import type { SlackInteractivePayload } from "./interactive.js";

/** A shared file on a Slack message (`event.files[]`; loosely typed). */
export type SlackFile = {
  readonly id?: string;
  readonly name?: string;
  readonly title?: string;
  readonly mimetype?: string;
  readonly filetype?: string;
  readonly size?: number;
  /** Auth-required download URL (needs the bot token + `files:read`). */
  readonly url_private?: string;
  readonly url_private_download?: string;
  readonly [key: string]: unknown;
};

/** A Slack event payload (loosely typed — we only read a few fields). */
export type SlackEvent = {
  readonly type: string;
  readonly subtype?: string;
  readonly channel?: string;
  readonly user?: string;
  readonly text?: string;
  readonly ts?: string;
  readonly thread_ts?: string;
  readonly bot_id?: string;
  readonly channel_type?: string;
  readonly files?: readonly SlackFile[];
  readonly [key: string]: unknown;
};

type Envelope = {
  readonly type: string;
  readonly envelope_id?: string;
  readonly reason?: string;
  /**
   * Two distinct payload shapes ride the same Socket Mode connection:
   *  - `events_api` → `{ event }` (a Slack message/etc event)
   *  - `interactive` → a `block_actions` payload (NO nested `event`)
   * Union them so onFrame can dispatch each to its own handler. The
   * `payload?.event` access events_api relies on stays valid (event is
   * optional on the union).
   */
  readonly payload?: {
    readonly event?: SlackEvent;
  } & Partial<SlackInteractivePayload>;
};

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** If no frame (event OR ping) arrives within this window, force a reconnect. */
const STALE_CONNECTION_MS = 90_000;

export class SlackSocketMode {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private handler: ((event: SlackEvent) => void) | null = null;
  /**
   * Phase 145 WS3 (Plan 07) — the registered Block Kit interaction handler.
   * Slack delivers a `block_actions` click as a `type:"interactive"` envelope
   * (distinct from `events_api`); previously such envelopes were ACK'd then
   * DROPPED (LANDMINE A). Registered via {@link onInteractive}; dispatched in
   * {@link onFrame} after the ACK.
   */
  private interactiveHandler: ((payload: SlackInteractivePayload) => void) | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;

  constructor(
    private readonly appToken: string,
    private readonly log: Logger,
  ) {}

  onEvent(handler: (event: SlackEvent) => void): void {
    this.handler = handler;
  }

  /**
   * Register the Block Kit interaction handler. Mirrors {@link onEvent}; the
   * interactive (`block_actions`) envelope is a separate path from message
   * events, so it has its own handler slot.
   */
  onInteractive(handler: (payload: SlackInteractivePayload) => void): void {
    this.interactiveHandler = handler;
  }

  /** Open the connection and keep it alive (reconnecting) until `stop()`. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
    this.staleTimer = setInterval(() => this.checkStale(), 15_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private checkStale(): void {
    if (this.stopped || this.lastFrameAt === 0) return;
    if (Date.now() - this.lastFrameAt > STALE_CONNECTION_MS) {
      this.log.warn("slack socket-mode connection stale; forcing reconnect");
      this.reconnect();
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let url: string;
    try {
      const res = await slackApiCall("apps.connections.open", this.appToken, {}, this.log);
      url = String(res.url ?? "");
      if (!url) throw new Error("apps.connections.open returned no url");
    } catch (err) {
      this.log.error({ err }, "slack apps.connections.open failed; backing off");
      this.scheduleReconnect();
      return;
    }

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.log.info("slack socket-mode connected");
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.lastFrameAt = Date.now();
    });

    ws.on("message", (data: RawData) => this.onFrame(data));

    // Slack keeps an idle connection alive with ws-level ping frames (~every
    // 30s). These are NOT "message" events, so without counting them the
    // stale-watchdog would false-positive on any quiet connection and churn
    // reconnects (~every 90s) — which also risks dropping a message posted
    // during a reconnect gap. Count ping/pong toward liveness.
    ws.on("ping", () => {
      this.lastFrameAt = Date.now();
    });
    ws.on("pong", () => {
      this.lastFrameAt = Date.now();
    });

    ws.on("error", (err: Error) => {
      this.log.warn({ err }, "slack socket-mode error");
    });

    ws.on("close", () => {
      if (this.stopped) return;
      this.log.warn("slack socket-mode closed; reconnecting");
      this.scheduleReconnect();
    });
  }

  private onFrame(data: RawData): void {
    this.lastFrameAt = Date.now();
    let envelope: Envelope;
    try {
      envelope = JSON.parse(data.toString()) as Envelope;
    } catch {
      return;
    }

    if (envelope.type === "hello") return;

    if (envelope.type === "disconnect") {
      this.log.info({ reason: envelope.reason }, "slack requested disconnect");
      this.reconnect();
      return;
    }

    // ACK every envelope that carries an id, immediately, before processing.
    if (envelope.envelope_id && this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      } catch (err) {
        this.log.warn({ err }, "slack envelope ack failed");
      }
    }

    if (envelope.type === "events_api") {
      const event = envelope.payload?.event;
      if (event && this.handler) {
        try {
          this.handler(event);
        } catch (err) {
          this.log.error({ err }, "slack event handler threw (non-fatal)");
        }
      }
      return;
    }

    // Phase 145 WS3 (Plan 07) — Block Kit interactions arrive as a SEPARATE
    // `type:"interactive"` envelope (no nested `event`). Previously ACK'd then
    // dropped (LANDMINE A). Dispatch the payload to the interactive handler
    // here, AFTER the ACK above so ack-before-dispatch is preserved. A handler
    // throw is non-fatal (mirrors the events_api branch).
    if (envelope.type === "interactive") {
      const payload = envelope.payload as SlackInteractivePayload | undefined;
      if (payload && this.interactiveHandler) {
        try {
          this.interactiveHandler(payload);
        } catch (err) {
          this.log.error({ err }, "slack interactive handler threw (non-fatal)");
        }
      }
    }
  }

  private reconnect(): void {
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    setTimeout(() => {
      void this.connect();
    }, delay);
  }
}
