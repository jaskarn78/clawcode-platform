import { describe, it, expect } from "vitest";

import type { CheckContext } from "../../types.js";
import type { ResolvedAgentConfig } from "../../../shared/types.js";
import type { PtyState } from "../../../llm-runtime/supervisors/pty-supervisor.js";

import ptyLivenessCheck from "../pty-liveness.js";

/**
 * Phase 140 Plan 02 Task 2 — `pty-liveness` heartbeat check tests.
 *
 * Covers all four <behavior> rows:
 *   1. healthy        — PTY alive AND channel MCP ready
 *   2. critical       — PTY dead OR circuit-open ("unhealthy" in the plan's
 *                       prose; the real CheckStatus union is
 *                       healthy|warning|critical — see src/heartbeat/types.ts
 *                       — so "unhealthy"→critical, "degraded"→warning. Same
 *                       plan-vs-types mapping the mcp-reconnect check already
 *                       documents.)
 *   3. warning        — PTY alive but channel MCP not yet ready ("degraded")
 *   4. healthy (no-op) — agent NOT on the claude-code-interactive backend
 *                        (the check must not flap masking/SDK agents)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(
  backend: ResolvedAgentConfig["llmRuntime"] extends infer T
    ? T extends { backend: infer B }
      ? B
      : never
    : never,
): ResolvedAgentConfig {
  return {
    name: "test-agent",
    workspace: "/home/agent/ws",
    llmRuntime: { backend, failoverChain: [] },
  } as unknown as ResolvedAgentConfig;
}

function makeContext(opts: {
  backend?: Parameters<typeof makeConfig>[0];
  noConfig?: boolean;
  ptyState?: PtyState;
  mcpReady?: boolean;
}): CheckContext {
  const config = opts.noConfig
    ? undefined
    : makeConfig(opts.backend ?? "claude-code-interactive");

  const sessionManager = {
    getAgentConfig: (_name: string) => config,
  } as unknown as CheckContext["sessionManager"];

  return {
    agentName: "test-agent",
    sessionManager,
    getPtyState:
      opts.ptyState !== undefined ? (_a: string) => opts.ptyState : undefined,
    getChannelMcpReady:
      opts.mcpReady !== undefined ? (_a: string) => opts.mcpReady! : undefined,
  } as unknown as CheckContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pty-liveness heartbeat check", () => {
  it("default export satisfies CheckModule: name === 'pty-liveness' and has execute", () => {
    expect(ptyLivenessCheck.name).toBe("pty-liveness");
    expect(typeof ptyLivenessCheck.execute).toBe("function");
  });

  it("row 1 — healthy when PTY is running AND channel MCP is ready", async () => {
    const ctx = makeContext({ ptyState: "running", mcpReady: true });
    const r = await ptyLivenessCheck.execute(ctx);
    expect(r.status).toBe("healthy");
  });

  it("row 2a — critical when the PTY is dead (stopped)", async () => {
    const ctx = makeContext({ ptyState: "stopped", mcpReady: true });
    const r = await ptyLivenessCheck.execute(ctx);
    expect(r.status).toBe("critical");
  });

  it("row 2b — critical when the circuit breaker is open", async () => {
    const ctx = makeContext({ ptyState: "circuit-open", mcpReady: true });
    const r = await ptyLivenessCheck.execute(ctx);
    expect(r.status).toBe("critical");
  });

  it("row 3 — warning (degraded) when the PTY is alive but the channel MCP is not ready", async () => {
    const ctx = makeContext({ ptyState: "running", mcpReady: false });
    const r = await ptyLivenessCheck.execute(ctx);
    expect(r.status).toBe("warning");
  });

  it("row 4 — healthy no-op for an agent on a non-v3 backend (anthropic-agent-sdk)", async () => {
    const ctx = makeContext({
      backend: "anthropic-agent-sdk",
      // even with a dead PTY state present, a non-v3 agent must NOT flap:
      ptyState: "stopped",
      mcpReady: false,
    });
    const r = await ptyLivenessCheck.execute(ctx);
    expect(r.status).toBe("healthy");
  });

  it("row 4 (codex) — healthy no-op for a codex-cli agent too", async () => {
    const ctx = makeContext({
      backend: "codex-cli",
      ptyState: "stopped",
      mcpReady: false,
    });
    const r = await ptyLivenessCheck.execute(ctx);
    expect(r.status).toBe("healthy");
  });

  it("returns healthy when no agent config is available (cannot resolve backend → don't flap)", async () => {
    const ctx = makeContext({ noConfig: true });
    const r = await ptyLivenessCheck.execute(ctx);
    expect(r.status).toBe("healthy");
  });

  it("a v3 agent with the PTY state getter missing reports critical (supervisor not wired = dead)", async () => {
    // v3 backend, but getPtyState undefined (no supervisor registered).
    const ctx = makeContext({ mcpReady: true });
    const r = await ptyLivenessCheck.execute(ctx);
    expect(r.status).toBe("critical");
  });

  it("restarting counts as alive (not dead) — warning when MCP not ready, healthy when ready", async () => {
    const degraded = await ptyLivenessCheck.execute(
      makeContext({ ptyState: "restarting", mcpReady: false }),
    );
    expect(degraded.status).toBe("warning");
    const healthy = await ptyLivenessCheck.execute(
      makeContext({ ptyState: "restarting", mcpReady: true }),
    );
    expect(healthy.status).toBe("healthy");
  });
});
