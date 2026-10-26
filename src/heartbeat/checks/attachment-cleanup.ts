/**
 * Heartbeat check that cleans up stale attachment temp files.
 *
 * Auto-discovered by HeartbeatRunner from the checks directory.
 * Removes downloaded attachment files older than 24 hours (default)
 * from each agent's attachments directory.
 *
 * WP3 (2026-10-25): sweeps the directory the Discord bridge actually
 * downloads into, `<memoryPath>/inbox/attachments` (attachmentInboxDir, the
 * same helper the bridge and the auto-ingest rescan use). It used to sweep
 * `<workspace>/attachments`, which nothing writes to, so the inbox grew
 * without bound (2,512 files on one agent).
 */

import type { CheckModule, CheckResult } from "../types.js";
import { attachmentInboxDir, cleanupAttachments } from "../../discord/attachments.js";

const attachmentCleanupCheck: CheckModule = {
  name: "attachment-cleanup",

  async execute(context): Promise<CheckResult> {
    const { agentName, sessionManager } = context;

    const agentConfig = sessionManager.getAgentConfig(agentName);
    if (!agentConfig) {
      return { status: "healthy", message: "No config available" };
    }

    const attachmentDir = attachmentInboxDir(agentConfig.memoryPath);
    const removed = await cleanupAttachments(attachmentDir);

    return {
      status: "healthy",
      message:
        removed > 0
          ? `Cleaned ${removed} stale attachment(s)`
          : "No stale attachments",
      metadata: { removed, dir: attachmentDir },
    };
  },
};

export default attachmentCleanupCheck;
