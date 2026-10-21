/**
 * P1-RESCAN — periodic inbox rescan check.
 *
 * Makes "never-drop" literally true: every 10 minutes (per agent with
 * autoIngestAttachments===true) it walks the agent's inbox/attachments dir and
 * re-enqueues any file <24 h that is NOT already in docStore, queued, or
 * in-flight. Recovers deferred-at-overflow items, restart-lost items, and
 * crashed-mid-ingest items. Idempotent (overwrite-by-source on re-ingest).
 *
 * Registered STATICALLY in check-registry.ts — there is no readdir-based
 * discovery (a file not in CHECK_REGISTRY silently never runs).
 */

import type { CheckModule, CheckResult } from "../types.js";
import { autoIngestQueue } from "../../manager/auto-ingest-queue.js";
import { attachmentArchiveDir, sweepImageArchive } from "../../vision/image-archive.js";
import { sweepTranscriptRequests } from "../../transcription/request-meta.js";

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
    if (agentConfig.autoIngestAttachments !== true) {
      return { status: "healthy", message: "auto-ingest disabled for agent" };
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

    return {
      status: "healthy",
      message:
        enqueued > 0
          ? `Re-enqueued ${enqueued} recovered attachment(s)`
          : "No recovered attachments",
      metadata: { scanned, enqueued, archiveRemoved },
    };
  },
};

export default autoIngestRescanCheck;
