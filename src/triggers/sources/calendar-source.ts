/**
 * Phase 61 Plan 02 Task 2 -- CalendarSource TriggerSource adapter.
 *
 * Polls Google Calendar via the google-workspace MCP server's
 * `calendar_list_events` tool. Fires once per event using a fired-ID
 * tracking map persisted in cursor_blob (trigger_state table).
 *
 * Key behaviors:
 * - MCP client spawned as long-lived subprocess via StdioClientTransport
 * - Time-window polling: [now, now + offsetMs]
 * - Once-per-event firing: Map<eventId, endTimeMs> in cursor_blob
 * - Stale ID pruning: entries older than eventRetentionDays removed
 * - transport.close() on stop to prevent MCP process leak (Pitfall 5)
 * - Timer handle .unref()ed to avoid blocking daemon shutdown
 *
 * Push channel renewal DROPPED from scope -- the google-workspace MCP
 * server does not expose a push channel API. Time-window polling with
 * fired-ID dedup is the sole calendar delivery mechanism for Phase 61.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Logger } from "pino";

import type { TriggerEvent, TriggerSource } from "../types.js";
import type { TaskStore } from "../../tasks/store.js";

/**
 * Constructor options for CalendarSource. The `ingest` callback is bound
 * to `TriggerEngine.ingest` by daemon.ts.
 */
export type CalendarSourceOptions = Readonly<{
  user: string;
  targetAgent: string;
  calendarId: string;
  pollIntervalMs: number;
  offsetMs: number;
  maxResults: number;
  eventRetentionDays: number;
  mcpServer: Readonly<{
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
  }>;
  taskStore: TaskStore;
  ingest: (event: TriggerEvent) => Promise<void>;
  log: Logger;
}>;

/** Shape of a calendar event from the MCP response. */
type CalendarEvent = Readonly<{
  id: string;
  summary?: string;
  start?: Readonly<{ dateTime?: string; date?: string }>;
  end?: Readonly<{ dateTime?: string; date?: string }>;
  [key: string]: unknown;
}>;

/**
 * CalendarSource implements TriggerSource for Google Calendar polling
 * via the MCP protocol.
 *
 * - `start()` spawns MCP client, sets up poll interval, runs initial poll
 * - `stop()` clears interval, closes MCP transport
 * - `poll(since)` returns unfired events (for replay)
 * - `_pollOnceForTest()` exposed for test access to single poll cycle
 */
export class CalendarSource implements TriggerSource {
  readonly sourceId: string;

  private readonly user: string;
  private readonly targetAgent: string;
  private readonly calendarId: string;
  private readonly pollIntervalMs: number;
  private readonly offsetMs: number;
  private readonly maxResults: number;
  private readonly eventRetentionDays: number;
  private readonly mcpServerConfig: CalendarSourceOptions["mcpServer"];
  private readonly taskStore: TaskStore;
  private readonly ingestFn: (event: TriggerEvent) => Promise<void>;
  private readonly log: Logger;

  private firedIds: Map<string, number>;
  private mcpClient: InstanceType<typeof Client> | null = null;
  private transport: InstanceType<typeof StdioClientTransport> | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(options: CalendarSourceOptions) {
    this.user = options.user;
    this.targetAgent = options.targetAgent;
    this.calendarId = options.calendarId;
    this.pollIntervalMs = options.pollIntervalMs;
    this.offsetMs = options.offsetMs;
    this.maxResults = options.maxResults;
    this.eventRetentionDays = options.eventRetentionDays;
    this.mcpServerConfig = options.mcpServer;
    this.taskStore = options.taskStore;
    this.ingestFn = options.ingest;
    this.log = options.log;
    this.sourceId = `calendar:${options.user}:${options.calendarId}`;

    // Load existing fired event IDs from cursor_blob
    const existing = this.taskStore.getTriggerState(this.sourceId);
    this.firedIds = existing?.cursor_blob
      ? new Map<string, number>(
          JSON.parse(existing.cursor_blob) as [string, number][],
        )
      : new Map<string, number>();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the calendar source. Spawns MCP client as long-lived subprocess
   * and sets up polling interval.
   *
   * Uses the `start(): void { void this._startAsync(); }` pattern to
   * preserve the TriggerSource interface's sync start() signature.
   */
  start(): void {
    void this._startAsync();
  }

  /** Stop polling and close the MCP transport. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    if (this.transport) {
      try {
        void this.transport.close();
      } catch (err) {
        this.log.warn(
          { error: (err as Error).message },
          "calendar-source: transport close error",
        );
      }
      this.transport = null;
    }

    this.mcpClient = null;
  }

  // -------------------------------------------------------------------------
  // poll -- watermark-based replay (TRIG-06)
  // -------------------------------------------------------------------------

  /**
   * Replay unfired events from the upcoming time window.
   * Returns events as TriggerEvent[] WITHOUT calling ingestFn.
   * Returns empty array if MCP client is not connected.
   */
  async poll(since: string | null): Promise<readonly TriggerEvent[]> {
    if (!this.mcpClient) {
      return [];
    }

    try {
      const events = await this.queryCalendarEvents();
      return Object.freeze(
        events
          .filter((evt) => !this.firedIds.has(evt.id))
          .map((evt) => this.buildTriggerEvent(evt)),
      );
    } catch (err) {
      this.log.error(
        { sourceId: this.sourceId, error: (err as Error).message },
        "calendar-source: poll query failed",
      );
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Test helpers
  // -------------------------------------------------------------------------

  /**
   * Execute a single poll cycle. For test access.
   * @internal
   */
  async _pollOnceForTest(): Promise<void> {
    await this.pollOnce();
  }

  /**
   * Connect the MCP client without starting the interval. For test access.
   * @internal
   */
  async _startMcpClientForTest(): Promise<void> {
    await this.connectMcpClient();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Async startup: connect MCP client, run initial poll, set interval.
   */
  private async _startAsync(): Promise<void> {
    try {
      await this.connectMcpClient();

      // Run initial poll immediately
      await this.pollOnce();

      // Set up recurring poll interval
      this.intervalHandle = setInterval(() => {
        void this.pollOnce();
      }, this.pollIntervalMs);
      this.intervalHandle.unref();

      this.log.info(
        { sourceId: this.sourceId, pollIntervalMs: this.pollIntervalMs },
        "calendar-source: started",
      );
    } catch (err) {
      this.log.error(
        { sourceId: this.sourceId, error: (err as Error).message },
        "calendar-source: start failed",
      );
    }
  }

  /**
   * Spawn and connect the MCP client to the google-workspace MCP server.
   */
  private async connectMcpClient(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.mcpServerConfig.command,
      args: [...(this.mcpServerConfig.args ?? [])],
      env: this.mcpServerConfig.env
        ? { ...this.mcpServerConfig.env }
        : undefined,
    });

    this.mcpClient = new Client({
      name: "calendar-source",
      version: "1.0.0",
    });

    await this.mcpClient.connect(this.transport);
  }

  /**
   * Execute a single poll cycle:
   * 1. Query calendar events in the upcoming time window
   * 2. Filter out already-fired events
   * 3. Ingest new events
   * 4. Prune stale IDs
   * 5. Persist cursor_blob
   */
  private async pollOnce(): Promise<void> {
    try {
      const events = await this.queryCalendarEvents();

      for (const evt of events) {
        if (this.firedIds.has(evt.id)) {
          continue;
        }

        const triggerEvent = this.buildTriggerEvent(evt);

        try {
          await this.ingestFn(triggerEvent);
        } catch (err) {
          this.log.error(
            { sourceId: this.sourceId, eventId: evt.id, error: (err as Error).message },
            "calendar-source: ingest failed for event",
          );
        }

        // Track the fired event with its end time for retention pruning
        const endTimeMs = this.extractEndTimeMs(evt);
        this.firedIds.set(evt.id, endTimeMs);
      }

      // Prune stale entries
      this.pruneStaleIds();

      // Persist fired IDs as array of [eventId, endTimeMs] tuples
      this.taskStore.upsertTriggerState(
        this.sourceId,
        String(Date.now()),
        JSON.stringify([...this.firedIds.entries()]),
      );
    } catch (err) {
      this.log.error(
        { sourceId: this.sourceId, error: (err as Error).message },
        "calendar-source: pollOnce failed",
      );
    }
  }

  /**
   * Query the google-workspace MCP server for upcoming calendar events.
   */
  private async queryCalendarEvents(): Promise<readonly CalendarEvent[]> {
    if (!this.mcpClient) {
      return [];
    }

    const now = new Date();
    const timeMax = new Date(now.getTime() + this.offsetMs);

    const result = await this.mcpClient.callTool({
      name: "calendar_list_events",
      arguments: {
        user: this.user,
        calendar_id: this.calendarId,
        time_min: now.toISOString(),
        time_max: timeMax.toISOString(),
        max_results: this.maxResults,
      },
    });

    // MCP callTool returns { content: [{ type: "text", text: "..." }] }
    const content = result as {
      content?: ReadonlyArray<{ type: string; text?: string }>;
    };

    if (!content.content?.[0]?.text) {
      return [];
    }

    try {
      const parsed = JSON.parse(content.content[0].text) as CalendarEvent[];
      return parsed;
    } catch {
      this.log.warn(
        { sourceId: this.sourceId },
        "calendar-source: failed to parse calendar response",
      );
      return [];
    }
  }

  /**
   * Build a TriggerEvent from a calendar event.
   */
  private buildTriggerEvent(evt: CalendarEvent): TriggerEvent {
    return {
      sourceId: this.sourceId,
      idempotencyKey: `cal:${evt.id}`,
      targetAgent: this.targetAgent,
      payload: evt,
      timestamp: Date.now(),
    };
  }

  /**
   * Extract end time in milliseconds from a calendar event.
   * Falls back to current time if end time cannot be parsed.
   */
  private extractEndTimeMs(evt: CalendarEvent): number {
    const endStr = evt.end?.dateTime ?? evt.end?.date;
    if (endStr) {
      const ms = new Date(endStr).getTime();
      if (!isNaN(ms)) {
        return ms;
      }
    }
    return Date.now();
  }

  /**
   * Remove fired event IDs older than eventRetentionDays past their end time.
   */
  private pruneStaleIds(): void {
    const cutoff = Date.now() - this.eventRetentionDays * 86_400_000;
    for (const [eventId, endTimeMs] of this.firedIds) {
      if (endTimeMs < cutoff) {
        this.firedIds.delete(eventId);
      }
    }
  }
}
