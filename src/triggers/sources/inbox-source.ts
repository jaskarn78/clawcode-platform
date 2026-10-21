/**
 * Phase 61 Plan 02 Task 1 -- InboxSource TriggerSource adapter.
 *
 * Watches an agent's collaboration/inbox/ directory via chokidar for new
 * message files. On each new file: read, parse, build TriggerEvent, ingest
 * through TriggerEngine, then move to processed/ via markProcessed.
 *
 * Key behaviors:
 * - ignoreInitial: true -- pre-existing files handled by poll(since) on
 *   daemon restart, NOT by the watcher (Research pitfall 3)
 * - awaitWriteFinish with configurable stabilityThreshold (default 500ms)
 * - On ingest failure, file is NOT moved to processed (retry on next cycle)
 * - poll(since) replays unprocessed messages for watermark-based replay
 *
 * This is the PRIMARY inbox delivery path. The existing heartbeat inbox
 * check (src/heartbeat/checks/inbox.ts) becomes a reconciler/fallback.
 * Plan 61-03 will handle the heartbeat coordination in daemon.ts.
 */

import { watch, type FSWatcher } from "chokidar";
import { readFile } from "node:fs/promises";
import type { Logger } from "pino";

import type { TriggerEvent, TriggerSource } from "../types.js";
import { readMessages, markProcessed, resolveKind } from "../../collaboration/inbox.js";
import type { InboxMessage, MessagePriority } from "../../collaboration/types.js";
import type { InboxAckEmitter } from "../../collaboration/inbox-ack.js";

/**
 * Constructor options for InboxSource. The `ingest` callback is bound to
 * `TriggerEngine.ingest` by daemon.ts.
 */
export type InboxSourceOptions = Readonly<{
  agentName: string;
  inboxDir: string;
  stabilityThresholdMs: number;
  targetAgent: string;
  ingest: (event: TriggerEvent) => Promise<void>;
  log: Logger;
  /**
   * Quick 260520-r70 — shared agent-to-agent ack-emitter. Invoked
   * fire-and-forget AFTER markProcessed succeeds. Optional: legacy / test
   * paths that omit it behave exactly as before. The SAME emitter
   * instance is also wired into the heartbeat reconciler (single hook).
   */
  ackEmitter?: InboxAckEmitter;
  /**
   * Phase 999.117 WS-2 — shared cross-path delivery dedupe. The SAME instance
   * the heartbeat reconciler and the Discord bridge relay hold. Optional so
   * legacy/test wiring behaves exactly as before; when absent, no dedupe.
   */
  dedupe?: { claim(deliveryId: string | undefined): boolean };
}>;

/**
 * InboxSource implements TriggerSource for filesystem inbox watching.
 *
 * - `start()` creates a chokidar watcher on the inbox directory.
 * - `stop()` closes the watcher.
 * - `poll(since)` replays unprocessed messages for watermark-based restart.
 */
export class InboxSource implements TriggerSource {
  readonly sourceId: string;

  private readonly agentName: string;
  private readonly inboxDir: string;
  private readonly stabilityThresholdMs: number;
  private readonly targetAgent: string;
  private readonly ingestFn: (event: TriggerEvent) => Promise<void>;
  private readonly log: Logger;
  private readonly ackEmitter: InboxAckEmitter | undefined;
  private readonly dedupe: InboxSourceOptions["dedupe"];

  private watcher: FSWatcher | null = null;

  constructor(options: InboxSourceOptions) {
    this.agentName = options.agentName;
    this.inboxDir = options.inboxDir;
    this.stabilityThresholdMs = options.stabilityThresholdMs;
    this.targetAgent = options.targetAgent;
    this.ingestFn = options.ingest;
    this.log = options.log;
    this.ackEmitter = options.ackEmitter;
    this.dedupe = options.dedupe;
    this.sourceId = `inbox:${options.agentName}`;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start watching the inbox directory. Uses ignoreInitial: true so
   * pre-existing files are NOT replayed on start (handled by poll(since)
   * during daemon restart via TriggerEngine.replayMissed).
   */
  start(): void {
    this.watcher = watch(this.inboxDir, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.stabilityThresholdMs,
      },
    });

    this.watcher.on("add", (filePath: string) => {
      // Fire-and-forget in production; tests extract this callback and
      // await it to ensure deterministic ordering.
      return this.handleNewFile(filePath);
    });

    this.log.info(
      { sourceId: this.sourceId, inboxDir: this.inboxDir },
      "inbox-source: started",
    );
  }

  /** Stop watching. Closes the chokidar watcher if active. */
  stop(): void {
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }
  }

  // -------------------------------------------------------------------------
  // poll -- watermark-based replay (TRIG-06)
  // -------------------------------------------------------------------------

  /**
   * Replay unprocessed messages from the inbox directory.
   *
   * When `since` is null, returns ALL unprocessed messages (first boot).
   * When `since` is a timestamp string, returns only messages with
   * timestamp > parseInt(since, 10).
   *
   * Does NOT call ingestFn -- the engine handles that during replay.
   */
  async poll(since: string | null): Promise<readonly TriggerEvent[]> {
    const messages = await readMessages(this.inboxDir);
    const sinceTs = since !== null ? parseInt(since, 10) : 0;

    // WS-0 (quick 260716-u5h) — acks never replay as turns. Mirror of the
    // watcher-path suppression in handleNewFile: an ack is an audit record;
    // boot replay through TriggerEngine would otherwise dispatch it as an
    // LLM turn (the 2026-07-16 self-echo incident class).
    const filtered = messages.filter(
      (msg) => msg.timestamp > sinceTs && resolveKind(msg) !== "ack",
    );

    const events: TriggerEvent[] = filtered.map((msg) => ({
      sourceId: this.sourceId,
      idempotencyKey: msg.id,
      targetAgent: this.targetAgent,
      payload: `[Message from ${msg.from}]: ${msg.content}`,
      timestamp: msg.timestamp,
    }));

    // Already sorted by readMessages (timestamp ascending)
    return Object.freeze(events);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Handle a new file detected by chokidar.
   * 1. Read file content
   * 2. JSON parse (skip non-JSON with warning)
   * 3. Validate InboxMessage shape (must have id, from, content, timestamp)
   * 4. Build TriggerEvent and call ingestFn
   * 5. On success, markProcessed to move to processed/
   * 6. On ingest failure, log error and leave file for retry
   */
  private async handleNewFile(filePath: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err) {
      this.log.warn(
        { filePath, error: (err as Error).message },
        "inbox-source: failed to read file",
      );
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      this.log.warn(
        { filePath },
        "inbox-source: file is not valid JSON, skipping",
      );
      return;
    }

    // Validate required InboxMessage fields
    if (
      typeof parsed["id"] !== "string" ||
      typeof parsed["from"] !== "string" ||
      typeof parsed["content"] !== "string" ||
      typeof parsed["timestamp"] !== "number"
    ) {
      this.log.warn(
        { filePath },
        "inbox-source: file missing required InboxMessage fields, skipping",
      );
      return;
    }

    // WS-0 (quick 260716-u5h) — ack messages never dispatch as turns. The
    // ack already reached the sender's channel via the post-to-agent
    // cascade; ingesting the inbox copy fed agents their own machinery
    // output as input (2026-07-16 Admin Clawdy self-echo incident).
    // markProcessed so the file doesn't replay, then stop: no ingest, no
    // ack-emitter (which is a guaranteed no-op on acks anyway).
    if (resolveKind(parsed as { kind?: InboxMessage["kind"] }) === "ack") {
      try {
        await markProcessed(this.inboxDir, parsed["id"] as string);
      } catch (err) {
        this.log.error(
          { sourceId: this.sourceId, messageId: parsed["id"], error: (err as Error).message },
          "inbox-source: markProcessed failed for suppressed ack",
        );
      }
      this.log.info(
        { sourceId: this.sourceId, messageId: parsed["id"], from: parsed["from"] },
        "inbox-source: ack suppressed (audit record, not a turn)",
      );
      return;
    }

    // Phase 999.117 WS-2 — cross-path dedupe. The same logical message can
    // reach an agent as this inbox file AND as a relayed webhook embed AND
    // (for a v3 target) as a channel push. Whichever consumer claims the
    // deliveryId first owns the turn; the rest retire their copy quietly.
    // Without this, enabling the webhook rung doubles every hop.
    const deliveryId =
      typeof parsed["deliveryId"] === "string"
        ? (parsed["deliveryId"] as string)
        : (parsed["id"] as string);
    if (this.dedupe && !this.dedupe.claim(deliveryId)) {
      try {
        await markProcessed(this.inboxDir, parsed["id"] as string);
      } catch (err) {
        this.log.error(
          { sourceId: this.sourceId, messageId: parsed["id"], error: (err as Error).message },
          "inbox-source: markProcessed failed for duplicate delivery",
        );
      }
      this.log.info(
        { sourceId: this.sourceId, messageId: parsed["id"], deliveryId },
        "inbox-source: duplicate delivery suppressed (already delivered by another path)",
      );
      return;
    }

    const event: TriggerEvent = {
      sourceId: this.sourceId,
      idempotencyKey: parsed["id"] as string,
      targetAgent: this.targetAgent,
      payload: `[Message from ${parsed["from"] as string}]: ${parsed["content"] as string}`,
      timestamp: parsed["timestamp"] as number,
    };

    try {
      await this.ingestFn(event);
    } catch (err) {
      this.log.error(
        { sourceId: this.sourceId, filePath, error: (err as Error).message },
        "inbox-source: ingest failed, file NOT moved to processed",
      );
      return;
    }

    // Ingest succeeded -- move to processed/
    try {
      await markProcessed(this.inboxDir, parsed["id"] as string);
    } catch (err) {
      this.log.error(
        { sourceId: this.sourceId, messageId: parsed["id"], error: (err as Error).message },
        "inbox-source: markProcessed failed",
      );
      // markProcessed failed — the ack must NOT fire (ack only after the
      // move succeeds). Return early to skip the hook below.
      return;
    }

    // Quick 260520-r70 — markProcessed succeeded: emit the agent-to-agent
    // ack via the shared hook (fire-and-forget). The emitter never rejects
    // (inbox-ack.ts guarantee), so a throw cannot escape handleNewFile; the
    // `void` marks the intentional non-await so the watcher is not delayed.
    if (this.ackEmitter) {
      const consumed: InboxMessage = {
        id: parsed["id"] as string,
        from: parsed["from"] as string,
        // File lives in THIS agent's inbox — `to` is always this agent.
        to: this.agentName,
        content: parsed["content"] as string,
        timestamp: parsed["timestamp"] as number,
        priority:
          parsed["priority"] === "high" || parsed["priority"] === "urgent"
            ? (parsed["priority"] as MessagePriority)
            : "normal",
        kind: resolveKind(parsed as { kind?: InboxMessage["kind"] }),
      };
      void this.ackEmitter(consumed, this.agentName);
    }
  }
}
