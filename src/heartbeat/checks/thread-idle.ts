import type { CheckModule, CheckResult } from "../types.js";
import { DEFAULT_THREAD_CONFIG } from "../../discord/thread-types.js";
import {
  readThreadRegistry,
  getBindingsForAgent,
} from "../../discord/thread-registry.js";
import { THREAD_REGISTRY_PATH } from "../../discord/thread-types.js";

/**
 * Heartbeat check that detects and cleans up idle thread sessions.
 *
 * For each agent, reads the thread registry, finds bindings owned by this agent,
 * and removes any whose lastActivity exceeds the configured idle timeout.
 * Uses ThreadManager from CheckContext for cleanup (removeThreadSession).
 */
const threadIdleCheck: CheckModule = {
  name: "thread-idle",

  async execute(context): Promise<CheckResult> {
    const { agentName, sessionManager, threadManager } = context;

    // ThreadManager is optional -- skip if not wired
    if (!threadManager) {
      return {
        status: "healthy",
        message: "Thread manager not available",
      };
    }

    // 1. Get agent config for idle timeout
    const agentConfig = sessionManager.getAgentConfig(agentName);
    if (!agentConfig) {
      return {
        status: "healthy",
        message: "No agent config available",
      };
    }

    const idleTimeoutMinutes =
      agentConfig.threads?.idleTimeoutMinutes ??
      DEFAULT_THREAD_CONFIG.idleTimeoutMinutes;

    // 2. Read thread registry and get bindings for this agent
    const registry = await readThreadRegistry(THREAD_REGISTRY_PATH);
    const bindings = getBindingsForAgent(registry, agentName);

    if (bindings.length === 0) {
      return {
        status: "healthy",
        message: "No active thread sessions",
        metadata: { active: 0, cleaned: 0 },
      };
    }

    // 3. Check each binding for idle timeout
    const now = Date.now();
    const idleThresholdMs = idleTimeoutMinutes * 60 * 1000;
    let cleaned = 0;

    for (const binding of bindings) {
      const idleDuration = now - binding.lastActivity;
      if (idleDuration >= idleThresholdMs) {
        try {
          await threadManager.removeThreadSession(binding.threadId);
          cleaned++;
        } catch {
          /* thread cleanup is best-effort -- continue checking other threads, will retry next cycle */
        }
      }
    }

    const remaining = bindings.length - cleaned;

    if (cleaned > 0) {
      return {
        status: "healthy",
        message: `Cleaned ${cleaned} idle thread session(s), ${remaining} active`,
        metadata: { active: remaining, cleaned },
      };
    }

    return {
      status: "healthy",
      message: `${bindings.length} active thread session(s)`,
      metadata: { active: bindings.length, cleaned: 0 },
    };
  },
};

export default threadIdleCheck;
