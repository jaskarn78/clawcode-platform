/**
 * Phase 140 Plan 02 Task 2 — `pty-liveness` heartbeat check.
 *
 * Composite health for v3 (`claude-code-interactive`) agents: the agent is
 * `healthy` only when its supervised `claude --channels` PTY is alive AND the
 * ClawCode channel MCP reports `ready`. A dead PTY (or a tripped restart
 * circuit breaker) is `critical`; an alive PTY whose channel MCP has not yet
 * finished its readiness handshake is `warning` (still warming, not dead).
 *
 * Auto-discovered by `HeartbeatRunner` from the checks directory (default
 * export, mirrors `attachment-cleanup.ts`).
 *
 * **Backend gate (must not flap masking/SDK agents):** an agent whose resolved
 * backend !== "claude-code-interactive" returns `healthy` immediately. The v3
 * supervisor only exists for interactive-channels agents; the daemon's
 * SDK/masking agents have no PTY, so this check is a no-op for them.
 *
 * **Status mapping note:** the plan's prose says "unhealthy" / "degraded", but
 * the real `CheckStatus` union is `healthy | warning | critical`
 * (`src/heartbeat/types.ts`). So "unhealthy" → `critical` and "degraded" →
 * `warning` — the exact plan-vs-types mapping the `mcp-reconnect` check
 * already documents (its test header pins the same convention).
 *
 * Inputs come through the heartbeat `CheckContext` via two optional getter
 * seams (Plan 02 additions, wired live by Plan 03/04):
 *   - `getPtyState(agent)` → `PtySupervisor.getState()` (or undefined).
 *   - `getChannelMcpReady(agent)` → channel-server readiness boolean.
 * Tests inject fakes; production wires the live supervisor registry + channel
 * readiness signal. A v3 agent with no `getPtyState` getter is treated as
 * dead (the supervisor is not wired ⇒ no live PTY ⇒ critical).
 */

import type { CheckContext, CheckResult } from "../types.js";
import type { PtyState } from "../../llm-runtime/supervisors/pty-supervisor.js";

/** The backend value that owns a supervised `claude --channels` PTY. */
const V3_BACKEND = "claude-code-interactive";

/**
 * A PTY is "alive" when a child is running or a restart is in-flight. `idle`
 * (constructed, never spawned), `stopped` (intentionally killed), and
 * `circuit-open` (restart storm tripped the breaker) are all "dead" for
 * liveness purposes.
 */
function isPtyAlive(state: PtyState): boolean {
  return state === "running" || state === "restarting";
}

const ptyLivenessCheck = {
  name: "pty-liveness",

  async execute(context: CheckContext): Promise<CheckResult> {
    const { agentName, sessionManager } = context;

    const agentConfig = sessionManager.getAgentConfig(agentName);
    // No config (cannot resolve backend) → don't flap; treat as healthy no-op.
    if (!agentConfig) {
      return { status: "healthy", message: "No config available" };
    }

    // Backend gate — non-v3 agents have no PTY; never flap masking/SDK agents.
    const backend = agentConfig.llmRuntime?.backend;
    if (backend !== V3_BACKEND) {
      return {
        status: "healthy",
        message: `Not a ${V3_BACKEND} agent (backend=${backend ?? "default"})`,
        metadata: { backend: backend ?? null, applies: false },
      };
    }

    // v3 agent — read PTY state. A missing getter means no supervisor is
    // wired for this agent ⇒ no live PTY ⇒ dead.
    const ptyState = context.getPtyState?.(agentName);
    if (ptyState === undefined || !isPtyAlive(ptyState)) {
      return {
        status: "critical",
        message:
          ptyState === undefined
            ? "PTY supervisor not wired (no live claude --channels child)"
            : `PTY not alive (state=${ptyState})`,
        metadata: { ptyState: ptyState ?? null, alive: false },
      };
    }

    // PTY alive — gate on channel MCP readiness.
    const mcpReady = context.getChannelMcpReady?.(agentName) === true;
    if (!mcpReady) {
      return {
        status: "warning",
        message: `PTY alive (${ptyState}) but channel MCP not ready`,
        metadata: { ptyState, mcpReady: false },
      };
    }

    return {
      status: "healthy",
      message: `PTY alive (${ptyState}) and channel MCP ready`,
      metadata: { ptyState, mcpReady: true },
    };
  },
};

export default ptyLivenessCheck;
