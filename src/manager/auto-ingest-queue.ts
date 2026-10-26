/**
 * Bounded, never-drop, governed auto-ingest queue (P1-INGESTQ + P1-RESCAN).
 *
 * Process-global module singleton. The IPC `auto-ingest-attachment` case becomes
 * a thin wrapper: validate → enqueue → ACK `{queued, queueDepth}` in microseconds
 * (or `{deferred}` at the depth cap) instead of awaiting the 40-57 s handler.
 * That closes the loopback-IPC-socket-exhaustion vector (12 sockets held open
 * 40-57 s during the incident → each now closes in µs).
 *
 * Invariants:
 *  - SERIAL drain (concurrency 1). `setImmediate` between items yields the event
 *    loop so other agents' IPC / bridge / stall-tracker are never starved.
 *  - The drain holds ONE image-work governor permit around the WHOLE handler
 *    (landmine #6, try/finally). Because drain concurrency is 1, ingest holds
 *    ≤1 of the 2 permits ⇒ the vision path always keeps ≥1. The per-decode sites
 *    inside the handler MUST NOT acquire again (double-count → vision starvation,
 *    and a true deadlock if drain concurrency ever rose above 1).
 *  - NEVER-DROP: overflow past MAX_QUEUE_DEPTH returns NON-BLOCKING
 *    `{deferred}` (the file stays on disk; the socket still ACKs in µs — we do
 *    NOT block the handler, which would re-open the socket exhaustion). The
 *    on-disk inbox is the durable queue; P1-RESCAN re-enqueues from it.
 *  - The drain NEVER throws out: a failed item is logged and left on disk for
 *    the rescan to retry (idempotent overwrite-by-source on re-ingest).
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { imageWorkGovernor } from "./image-work-governor.js";
import { attachmentInboxDir } from "../discord/attachments.js";
import { documentNeedsRetry, type DocumentStore } from "../documents/store.js";
import type { AutoIngestAttachmentParams } from "./auto-ingest-handler.js";

const TAG = "p1-auto-ingest-queue";

/** Global in-memory work-list cap. The on-disk inbox is the durable queue. */
export const MAX_QUEUE_DEPTH = 200;

/**
 * Rescan only re-enqueues files younger than this. Matches the 24 h attachment
 * retention window (the attachment-cleanup check sweeps the same inbox
 * directory); older files are either already in docStore (skipped) or
 * stale. A 10-min rescan cadence gives ~144× margin inside this window.
 * WP3: a file whose row says the last attempt stored only a stub or failed
 * is re-enqueued until MAX_INGEST_ATTEMPTS (3) attempts have been made.
 */
export const RESCAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type EnqueueResult =
  | { readonly queued: true; readonly queueDepth: number }
  | {
      readonly deferred: true;
      readonly reason: string;
      readonly queueDepth: number;
    };

export type IngestAgentRef = {
  readonly agent: string;
  readonly memoryPath: string | undefined;
};

/**
 * P2-PROGRESS — emitted once per drained item (success OR failure), so an
 * in-process observer (the bridge) can render edit-in-place progress. Carries
 * the originating Discord coordinates; rescan-recovered items carry empty
 * channelId/messageId and are ignored by the progress tracker.
 */
export type IngestItemDone = {
  readonly agent: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly filePath: string;
  readonly ok: boolean;
};

/** Optional in-process observer. Set AFTER boot (the bridge subscribes once constructed). */
export type AutoIngestQueueObserver = {
  readonly onItemDone: (event: IngestItemDone) => void;
};

export type AutoIngestQueueDeps = {
  /**
   * Bound `handleAutoIngestAttachment(params, handlerDeps)`. The drain awaits it
   * but does NOT consume the result (fire-and-forget; never-drop via rescan), so
   * the return type is intentionally `unknown`.
   */
  readonly runHandler: (
    params: AutoIngestAttachmentParams,
  ) => Promise<unknown>;
  readonly logger: Logger;
  /** Per-agent DocumentStore for rescan dedup (getDocumentRow(source)). */
  readonly getDocumentStore: (agent: string) => DocumentStore | undefined;
  /** Live list of agents with autoIngestAttachments===true (for boot rescan). */
  readonly listIngestAgents: () => ReadonlyArray<IngestAgentRef>;
  /**
   * WP3 (optional): the embed-worker batch embedder (the same function the
   * handler deps use). When wired, the heartbeat re-mirror pass embeds
   * through the worker instead of inline on the main thread.
   */
  readonly embedBoth?: (
    texts: readonly string[],
    includeV1: boolean,
  ) => Promise<{ readonly v1: Float32Array[] | null; readonly v2: Int8Array[] }>;
};

export class AutoIngestQueue {
  private deps: AutoIngestQueueDeps | null = null;
  private readonly queue: AutoIngestAttachmentParams[] = [];
  private readonly queuedSources = new Set<string>();
  private readonly inFlight = new Set<string>();
  private draining = false;
  private observer: AutoIngestQueueObserver | null = null;

  /** Wire dependencies once at boot, then flush anything already queued. */
  init(deps: AutoIngestQueueDeps): void {
    this.deps = deps;
    this.scheduleDrain();
  }

  /** P2-PROGRESS — register the in-process progress observer (bridge, post-boot). */
  setObserver(observer: AutoIngestQueueObserver | null): void {
    this.observer = observer;
  }

  /**
   * Phase 999.154 WS-4 — archive retention the heartbeat sweep applies. Set at
   * boot from `defaults.imageIngest.archive.ttlDays` (the check has no config
   * handle of its own).
   */
  archiveTtlDays = 90;

  get depth(): number {
    return this.queue.length;
  }

  /** WP3: the worker embedder wired at boot, if any (see AutoIngestQueueDeps). */
  get embedBoth(): AutoIngestQueueDeps["embedBoth"] {
    return this.deps?.embedBoth;
  }

  /**
   * WP3: true when nothing is queued or being processed. The heartbeat
   * re-mirror pass only runs while the queue is idle so it never competes
   * with a live ingest.
   */
  get idle(): boolean {
    return this.queue.length === 0 && this.inFlight.size === 0;
  }

  /** True if `source` is already queued or being processed (idempotent enqueue). */
  isTracked(source: string): boolean {
    return this.inFlight.has(source) || this.queuedSources.has(source);
  }

  /**
   * Phase 999.154 — read-only snapshot of queued (not in-flight) items that
   * match `pred`, in queue order, at most `limit`. Used by the ingest vision
   * batcher to analyze a burst's images in one call; nothing is dequeued.
   */
  peekQueued(
    pred: (p: AutoIngestAttachmentParams) => boolean,
    limit: number,
  ): readonly AutoIngestAttachmentParams[] {
    const out: AutoIngestAttachmentParams[] = [];
    for (const item of this.queue) {
      if (out.length >= limit) break;
      if (pred(item)) out.push(item);
    }
    return out;
  }

  enqueue(params: AutoIngestAttachmentParams): EnqueueResult {
    const source = params.file_path;
    if (this.isTracked(source)) {
      // Already tracked — do not duplicate (idempotent; rescan relies on this).
      return { queued: true, queueDepth: this.queue.length };
    }
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      // NON-BLOCKING defer-to-disk. The file persists; the rescan re-enqueues
      // within the next cycle. We never block the caller (that would re-open the
      // IPC-socket exhaustion this queue exists to kill) and never drop.
      this.deps?.logger.warn(
        { tag: TAG, source, queueDepth: this.queue.length },
        "auto-ingest queue full — deferring to disk (rescanned next cycle)",
      );
      return {
        deferred: true,
        reason: "queue full, rescanned next cycle",
        queueDepth: this.queue.length,
      };
    }
    this.queue.push(params);
    this.queuedSources.add(source);
    this.scheduleDrain();
    return { queued: true, queueDepth: this.queue.length };
  }

  private scheduleDrain(): void {
    if (this.draining || !this.deps) return;
    this.draining = true;
    setImmediate(() => void this.drainNext());
  }

  private async drainNext(): Promise<void> {
    const deps = this.deps;
    const item = this.queue.shift();
    if (!item || !deps) {
      this.draining = false;
      return;
    }
    const source = item.file_path;
    this.queuedSources.delete(source);
    this.inFlight.add(source);
    let ok = false;
    try {
      // ONE governor permit around the whole item (landmine #6, try/finally).
      // The worker-client request timeout bounds how long this permit is held
      // even if the embed worker hangs.
      await imageWorkGovernor.acquire();
      try {
        await deps.runHandler(item);
        ok = true;
      } finally {
        imageWorkGovernor.release();
      }
    } catch (err) {
      // Never-drop: leave the file on disk for the rescan to retry. Re-ingest is
      // idempotent (overwrite-by-source on docStore + delete-by-path on memory).
      deps.logger.warn(
        { tag: TAG, source, err: errMsg(err) },
        "auto-ingest drain item failed (file persists; rescan will retry)",
      );
    } finally {
      this.inFlight.delete(source);
      // P2-PROGRESS — notify the observer (best-effort; a throwing observer must
      // NEVER wedge the never-drop drain).
      if (this.observer) {
        try {
          this.observer.onItemDone({
            agent: item.agent,
            channelId: item.channel_id,
            messageId: item.message_id,
            filePath: item.file_path,
            ok,
          });
        } catch (err) {
          deps.logger.warn(
            { tag: TAG, source, err: errMsg(err) },
            "auto-ingest progress observer threw (ignored)",
          );
        }
      }
      // Yield the event loop between items.
      setImmediate(() => void this.drainNext());
    }
  }

  /**
   * Rescan one agent's inbox: enqueue files <24 h that are NOT already in
   * docStore, NOT queued, and NOT in-flight. Idempotent. The caller gates on
   * autoIngestAttachments===true and supplies the agent's memoryPath.
   */
  async runRescanForAgent(
    agent: string,
    memoryPath: string | undefined,
  ): Promise<{ scanned: number; enqueued: number }> {
    const deps = this.deps;
    if (!deps) return { scanned: 0, enqueued: 0 };
    const dir = attachmentInboxDir(memoryPath);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      // No inbox dir yet (agent never received an attachment) — nothing to do.
      return { scanned: 0, enqueued: 0 };
    }
    const docStore = deps.getDocumentStore(agent);
    const now = Date.now();
    let scanned = 0;
    let enqueued = 0;
    for (const entry of entries) {
      if (entry.endsWith(".tmp")) continue; // download in progress
      const fullPath = join(dir, entry);
      let size: number;
      try {
        const st = await stat(fullPath);
        if (!st.isFile()) continue;
        if (now - st.mtimeMs > RESCAN_MAX_AGE_MS) continue; // <24 h only
        size = st.size;
      } catch {
        continue;
      }
      scanned++;
      // Already ingested, unless the last attempt stored only a stub or
      // failed and the attempt cap is not reached yet (WP3).
      const row = docStore?.getDocumentRow(fullPath) ?? null;
      if (row !== null && !documentNeedsRetry(row)) continue;
      if (this.isTracked(fullPath)) continue; // already queued / in-flight
      const result = this.enqueue(reconstructParams(agent, fullPath, entry, size));
      if ("queued" in result) enqueued++;
    }
    if (enqueued > 0) {
      deps.logger.info(
        { tag: TAG, agent, scanned, enqueued },
        "auto-ingest rescan re-enqueued recovered files",
      );
    }
    return { scanned, enqueued };
  }

  /** Rescan every ingest-enabled agent (boot + any all-agents sweep). */
  async runRescanAll(): Promise<{ scanned: number; enqueued: number }> {
    const deps = this.deps;
    if (!deps) return { scanned: 0, enqueued: 0 };
    let scanned = 0;
    let enqueued = 0;
    for (const { agent, memoryPath } of deps.listIngestAgents()) {
      const r = await this.runRescanForAgent(agent, memoryPath);
      scanned += r.scanned;
      enqueued += r.enqueued;
    }
    return { scanned, enqueued };
  }
}

/** Process-global singleton (the bridge is in-process with the daemon). */
export const autoIngestQueue = new AutoIngestQueue();

/**
 * Reconstruct handler params for a rescan-recovered file.
 *
 * KNOWN RESIDUAL #1 — recovered items lose Discord provenance
 * (channel_id/message_id/user are empty sentinels). They are still ingested
 * (never dropped, idempotent), just with degraded attribution. Phase 999.154:
 * the mime type is inferred from the extension so recovered IMAGES still get
 * vision analysis, dedupe and archiving (previously null → all skipped).
 */
function reconstructParams(
  agent: string,
  fullPath: string,
  entry: string,
  size: number,
): AutoIngestAttachmentParams {
  return {
    agent,
    file_path: fullPath,
    filename: entry.replace(/^\d+-/, ""), // strip the "<timestamp>-" prefix
    mime_type: inferMimeType(entry),
    size,
    vision_analysis: null,
    channel_id: "",
    message_id: "",
    user_id: "",
    user_name: "",
  };
}

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
});

/** Image mime from a filename's extension; null for anything else (unchanged path). */
export function inferMimeType(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return null;
  return IMAGE_MIME_BY_EXT[filename.slice(dot).toLowerCase()] ?? null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
