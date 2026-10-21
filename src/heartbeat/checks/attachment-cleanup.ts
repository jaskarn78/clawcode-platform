/**
 * Heartbeat check that cleans up stale attachment temp files.
 *
 * Auto-discovered by HeartbeatRunner from the checks directory.
 * Removes downloaded attachment files older than 24 hours (default)
 * from each agent's attachments directory.
 */

import { join } from "node:path";
import type { CheckModule, CheckResult } from "../types.js";
import { cleanupAttachments } from "../../discord/attachments.js";

const attachmentCleanupCheck: CheckModule = {
  name: "attachment-cleanup",

  async execute(context): Promise<CheckResult> {
    const { agentName, sessionManager } = context;

    const agentConfig = sessionManager.getAgentConfig(agentName);
    if (!agentConfig) {
      return { status: "healthy", message: "No config available" };
    }

    const attachmentDir = join(agentConfig.workspace, "attachments");
    const removed = await cleanupAttachments(attachmentDir);

    return {
      status: "healthy",
      message:
        removed > 0
          ? `Cleaned ${removed} stale attachment(s)`
          : "No stale attachments",
      metadata: { removed },
    };
  },
};

export default attachmentCleanupCheck;
