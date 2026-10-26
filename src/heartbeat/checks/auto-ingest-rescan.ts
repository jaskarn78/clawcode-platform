/**
 * P1-RESCAN — periodic inbox rescan check.
 *
 * Makes "never-drop" literally true: every 10 minutes (per agent with
 * autoIngestAttachments===true) it walks the agent's inbox/attachments dir and
 * re-enqueues any file <24 h that is NOT already in docStore, queued, or
 * in-flight. Recovers deferred-at-overflow items, restart-lost items, and
 * crashed-mid-ingest items. Idempotent (overwrite-by-source on re-ingest).
 *
 * WP3 (2026-10-25): the same cycle also re-mirrors documents whose
 * `document_chunks` exist but whose `document:<slug>` memory mirror is
 * missing (a failed best-effort cross-ingest, or documents ingested before
 * the mirror existed). This runs for every agent with a document store,
 * including agents that only use the manual ingest_document tool, and only
 * while the ingest queue is idle. It embeds through the embed worker when
 * the queue was given one at boot, otherwise inline with the daemon's
 * embedder at a smaller per-cycle budget (see remirror.ts), and runs
 * detached from the
 * check (one pass per agent at a time) so the heartbeat's per-check timeout
 * never cuts it off; the check reports the last completed pass.
 *
 * Registered STATICALLY in check-registry.ts — there is no readdir-based
 * discovery (a file not in CHECK_REGISTRY silently never runs).
 */

import type { CheckModule, CheckResult } from "../types.js";
import { autoIngestQueue } from "../../manager/auto-ingest-queue.js";
import { attachmentArchiveDir, sweepImageArchive } from "../../vision/image-archive.js";
import { sweepTranscriptRequests } from "../../transcription/request-meta.js";
import {
  remirrorMissingDocuments,
  type RemirrorEmbed,
  type RemirrorResult,
} from "../../document-ingest/remirror.js";
import type { SessionManager } from "../../manager/session-manager.js";

/**
 * Phase 999.154 WS-4 — archive TTL sweep piggybacks on this 10-min check but
 * runs at most every 6 h per agent (a readdir + stat per archived file).
 */
const ARCHIVE_SWEEP_EVERY_MS = 6 * 3_600_000;
const lastArchiveSweep = new Map<string, number>();

async function maybeSweepArchive(
  agentName: string,
  memoryPath: string | undefined,
  ttlDays: number,
): Promise<number> {
  const now = Date.now();
  if (now - (lastArchiveSweep.get(agentName) ?? 0) < ARCHIVE_SWEEP_EVERY_MS) return 0;
  lastArchiveSweep.set(agentName, now);
  return sweepImageArchive(attachmentArchiveDir(memoryPath), ttlDays, now);
}

/** Mirror chunks per cycle when embedding inline on the main thread. */
export const INLINE_REMIRROR_CHUNK_BUDGET = 100;

/** Worker-backed v1 + v2 embedding, when the queue was wired with one. */
function workerEmbed(): RemirrorEmbed | null {
  const embedBoth = autoIngestQueue.embedBoth;
  if (!embedBoth) return null;
  return async (texts) => {
    const { v1, v2 } = await embedBoth(texts, true);
    if (!v1) throw new Error("embed worker returned no v1 vectors");
    return { v1, v2 };
  };
}

/** Inline v1 + v2 embedding with the daemon's shared embedder. */
function inlineEmbed(sessionManager: SessionManager): RemirrorEmbed {
  return async (texts) => {
    const embedder = sessionManager.getEmbedder();
    const v1: Float32Array[] = [];
    const v2: Int8Array[] = [];
    for (const t of texts) {
      v1.push(await embedder.embed(t));
      v2.push(await embedder.embedV2(t));
    }
    return { v1, v2 };
  };
}

/** Agents with a re-mirror pass running, and each agent's last completed pass. */
const remirrorInFlight = new Set<string>();
const lastRemirror = new Map<string, RemirrorResult>();

/** Last completed re-mirror pass for an agent (undefined before the first). */
export function lastRemirrorResult(agentName: string): RemirrorResult | undefined {
  return lastRemirror.get(agentName);
}

/**
 * Start a detached re-mirror pass for an agent unless one is already
 * running. Returns the pass's promise (for tests), or null when skipped.
 */
export function startRemirrorForAgent(
  agentName: string,
  sessionManager: SessionManager,
  embed?: RemirrorEmbed,
): Promise<RemirrorResult | null> | null {
  if (remirrorInFlight.has(agentName)) return null;
  remirrorInFlight.add(agentName);
  return runRemirrorForAgent(agentName, sessionManager, embed)
    .then((r) => {
      if (r) lastRemirror.set(agentName, r);
      return r;
    })
    .finally(() => {
      remirrorInFlight.delete(agentName);
    });
}

/**
 * WP3: re-mirror pass for one agent. Skipped (null) when the agent has no
 * open document or memory store, or while the ingest queue is busy. Never
 * throws.
 */
export async function runRemirrorForAgent(
  agentName: string,
  sessionManager: SessionManager,
  embed?: RemirrorEmbed,
): Promise<RemirrorResult | null> {
  if (!autoIngestQueue.idle) return null;
  const docStore = sessionManager.getDocumentStore(agentName);
  const memoryStore = sessionManager.getMemoryStore(agentName);
  if (!docStore || !memoryStore) return null;
  const viaWorker = embed === undefined ? workerEmbed() : null;
  const chosen = embed ?? viaWorker ?? inlineEmbed(sessionManager);
  try {
    return await remirrorMissingDocuments({
      agent: agentName,
      docStore,
      memoryStore,
      embed: chosen,
      // Explicit embedders (tests) and the worker get the default budget.
      ...(embed === undefined && viaWorker === null
        ? { chunkBudget: INLINE_REMIRROR_CHUNK_BUDGET }
        : {}),
    });
  } catch {
    return null;
  }
}

const autoIngestRescanCheck: CheckModule = {
  name: "auto-ingest-rescan",
  // 10 minutes (seconds). 24 h retention ÷ 10 min ≈ 144× margin.
  interval: 600,

  async execute(context): Promise<CheckResult> {
    const { agentName, sessionManager } = context;

    const agentConfig = sessionManager.getAgentConfig(agentName);
    if (!agentConfig) {
      return { status: "healthy", message: "No config available" };
    }

    void startRemirrorForAgent(agentName, sessionManager);
    const remirror = lastRemirrorResult(agentName);
    const remirrored = remirror?.remirrored ?? 0;

    if (agentConfig.autoIngestAttachments !== true) {
      return {
        status: "healthy",
        message:
          remirrored > 0
            ? `auto-ingest disabled for agent; re-mirrored ${remirrored} document(s)`
            : "auto-ingest disabled for agent",
        metadata: { remirrored, remirrorMissing: remirror?.missing ?? 0 },
      };
    }

    const { scanned, enqueued } = await autoIngestQueue.runRescanForAgent(
      agentName,
      agentConfig.memoryPath,
    );
    // 999.156 — transcript-request sidecars share the archive sweep's cadence.
    if (agentConfig.memoryPath && Date.now() - (lastArchiveSweep.get(agentName) ?? 0) >= ARCHIVE_SWEEP_EVERY_MS) {
      void sweepTranscriptRequests(agentConfig.memoryPath).catch(() => 0);
    }
    const archiveRemoved = await maybeSweepArchive(
      agentName,
      agentConfig.memoryPath,
      autoIngestQueue.archiveTtlDays,
    );

    const parts: string[] = [
      enqueued > 0
        ? `Re-enqueued ${enqueued} recovered attachment(s)`
        : "No recovered attachments",
    ];
    if (remirrored > 0) parts.push(`re-mirrored ${remirrored} document(s)`);
    return {
      status: "healthy",
      message: parts.join("; "),
      metadata: {
        scanned,
        enqueued,
        archiveRemoved,
        remirrored,
        remirrorMissing: remirror?.missing ?? 0,
      },
    };
  },
};

export default autoIngestRescanCheck;
