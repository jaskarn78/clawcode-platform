/**
 * Phase 999.82 Plan 03 (2026-05-27) — regression pin for the subagent
 * v3-inheritance revert.
 *
 * BACKGROUND (Phase 140, commit `6147c0db`): a delegated subagent inherits the
 * SOURCE agent's whole config (incl. `llmRuntime`) via the spread at
 * `SubagentThreadSpawner.spawnInThread`. When the source is a v3
 * (`claude-code-interactive`) chat agent, the subagent inherited that backend →
 * spawned as an inert-Query `--channels` session → `streamFromAgent` got no
 * tokens → the Phase 127 stall tracker false-tripped → "⚠️ a tool wedged". The
 * interim fix FORCED the v2 SDK backend in `buildSubagentOverrides`.
 *
 * 999.82 REVERT (this plan): the optimal solution is for a v3 parent's subagent
 * to run as a v3 `--channels` session dispatched over its OWN channel (Plan 04
 * fixes that dispatch, replacing the `streamFromAgent` path that wedged). So the
 * interim v2-force is removed — the override no longer sets `llmRuntime` at all,
 * and the subagent INHERITS the source agent's backend (a v3 parent → v3
 * subagent; a v2 parent → v2 subagent). `failoverChain` still flows through via
 * the source-config spread at the spawn site (not via this override slice).
 *
 * These tests pin:
 *   (1) the override slice no longer carries `llmRuntime` — backend is inherited
 *   (2) the merged spawn-site shape keeps the source backend (v3 stays v3,
 *       v2 stays v2)
 *   (3) failoverChain is preserved in the merged config (source spread)
 *   (4) EVERY memory/heartbeat leak-prevention override (D-01..D-04) is STILL
 *       present in the override slice — only the `llmRuntime` force was reverted
 *       (`feedback_silent_path_bifurcation` + threat T-999.82-03-03).
 */
import { describe, it, expect } from "vitest";

import { buildSubagentOverrides } from "../subagent-config-overrides.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

/** Minimal source config — only the fields buildSubagentOverrides reads. */
function srcConfig(backend: string): ResolvedAgentConfig {
  return {
    heartbeat: { enabled: true, intervalSeconds: 60, timeoutSeconds: 10 },
    memory: { conversation: { flushIntervalMinutes: 15 } },
    llmRuntime: { backend, failoverChain: ["openai"] },
  } as unknown as ResolvedAgentConfig;
}

describe("buildSubagentOverrides — backend inheritance (Phase 999.82 v2-force revert)", () => {
  it("does NOT set llmRuntime in the override slice (backend is inherited from source)", () => {
    const src = srcConfig("claude-code-interactive");
    const ov = buildSubagentOverrides(src, src, false);
    // The interim v2-force set `ov.llmRuntime.backend = "anthropic-agent-sdk"`.
    // After the revert the override carries NO llmRuntime field at all.
    expect("llmRuntime" in ov).toBe(false);
    expect(ov.llmRuntime).toBeUndefined();
  });

  it("a v3 source's subagent keeps the v3 backend (merged spawn-site shape)", () => {
    const src = srcConfig("claude-code-interactive");
    const merged = {
      ...src,
      ...buildSubagentOverrides(src, src, false),
    } as ResolvedAgentConfig;
    // Inherited from the source spread — NOT forced to v2.
    expect(merged.llmRuntime?.backend).toBe("claude-code-interactive");
  });

  it("a v2 source's subagent keeps the v2 SDK backend (merged spawn-site shape)", () => {
    const src = srcConfig("anthropic-agent-sdk");
    const merged = {
      ...src,
      ...buildSubagentOverrides(src, src, false),
    } as ResolvedAgentConfig;
    expect(merged.llmRuntime?.backend).toBe("anthropic-agent-sdk");
  });

  it("preserves the source failoverChain in the merged config (source spread)", () => {
    const src = srcConfig("claude-code-interactive");
    const merged = {
      ...src,
      ...buildSubagentOverrides(src, src, false),
    } as ResolvedAgentConfig;
    expect(merged.llmRuntime?.failoverChain).toEqual(["openai"]);
  });
});

describe("buildSubagentOverrides — memory/heartbeat leak guards intact (D-01..D-04)", () => {
  // Threat T-999.82-03-03: only the llmRuntime force is reverted. EVERY
  // memory/heartbeat override that prevents the 999.57 leak surfaces MUST stay.
  it("D-01 — heartbeat.enabled is false (spread of source's heartbeat shape)", () => {
    const src = srcConfig("claude-code-interactive");
    const ov = buildSubagentOverrides(src, src, false);
    expect(ov.heartbeat).toBeDefined();
    expect(ov.heartbeat?.enabled).toBe(false);
    // Source's required fields are spread through (shape preserved).
    expect(ov.heartbeat?.intervalSeconds).toBe(60);
  });

  it("D-02 — memoryAutoLoad is false (blocks MEMORY.md auto-load)", () => {
    const src = srcConfig("claude-code-interactive");
    const ov = buildSubagentOverrides(src, src, false);
    expect(ov.memoryAutoLoad).toBe(false);
  });

  it("D-04 — memoryRetrievalTopK and tokenBudget are 0 (blocks hybrid-RRF retrieval)", () => {
    const src = srcConfig("claude-code-interactive");
    const ov = buildSubagentOverrides(src, src, false);
    expect(ov.memoryRetrievalTopK).toBe(0);
    expect(ov.memoryRetrievalTokenBudget).toBe(0);
  });

  it("D-03 — memoryScannerEnabled false + memoryFlushIntervalMs marker present", () => {
    const src = srcConfig("claude-code-interactive");
    const ov = buildSubagentOverrides(src, src, false);
    expect(ov.memoryScannerEnabled).toBe(false);
    expect(ov.memoryFlushIntervalMs).toBe(900_000);
  });

  it("Finding 4 — memory.conversation.flushIntervalMinutes is 0 when source supplies the block", () => {
    const src = srcConfig("claude-code-interactive");
    const ov = buildSubagentOverrides(src, src, false);
    expect(ov.memory?.conversation?.flushIntervalMinutes).toBe(0);
  });

  it("Pitfall 3 — memory.conversation stays undefined when the source omits it (no partial shape)", () => {
    const src = {
      heartbeat: { enabled: true, intervalSeconds: 60, timeoutSeconds: 10 },
      memory: {},
      llmRuntime: { backend: "claude-code-interactive", failoverChain: [] },
    } as unknown as ResolvedAgentConfig;
    const ov = buildSubagentOverrides(src, src, false);
    expect(ov.memory?.conversation).toBeUndefined();
  });
});
