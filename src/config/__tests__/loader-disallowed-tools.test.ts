/**
 * Phase 999.99 — loader resolver wiring for the fleet-wide SDK deny-list
 * (`defaults.disallowedTools`).
 *
 * The recurring-poll delivery gap (CONTEXT §2c) is half-fixed by the
 * `schedule_recurring` primitive (Plan 01); the other half is forcing agents
 * OFF the leaky SDK self-fire tools (ScheduleWakeup/CronCreate) whose turns run
 * outside the daemon's collector and buffer one-per-inbound-message. This suite
 * pins the resolver half: `resolveAgentConfig` must surface the fleet default
 * onto every primary agent's ResolvedAgentConfig.disallowedTools.
 *
 * Asserting on the RESOLVED OUTPUT (not on `defaults.disallowedTools`) is
 * deliberate: the schema field is `.default([...]).optional()`, so the PARSED
 * default short-circuits to `undefined` when the key is absent, and the
 * resolver's `?? ["ScheduleWakeup","CronCreate"]` floor is what concretizes it.
 * The Monitor-NOT-blocked test (Q3) and the operator-OVERRIDE test (proves the
 * resolver actually READS defaults rather than hardcoding the floor — a broken
 * wiring line would otherwise be masked by the `??` floor) are the two
 * discriminating cases.
 */
import { describe, it, expect } from "vitest";
import { resolveAgentConfig } from "../loader.js";
import { defaultsSchema, agentSchema } from "../schema.js";
import type { AgentConfig, DefaultsConfig } from "../schema.js";

/** Minimal raw agent → parsed AgentConfig (zod fills the rest). */
function makeAgent(overrides: Record<string, unknown> = {}): AgentConfig {
  return agentSchema.parse({ name: "primary-agent", channels: [], ...overrides });
}

/** Minimal raw defaults → parsed DefaultsConfig (zod fills the factory). */
function makeDefaults(overrides: Record<string, unknown> = {}): DefaultsConfig {
  return defaultsSchema.parse({ ...overrides });
}

describe("Phase 999.99 — resolveAgentConfig.disallowedTools (fleet block)", () => {
  it("surfaces the fleet default [ScheduleWakeup, CronCreate, AskUserQuestion] onto a resolved primary when neither side overrides", () => {
    // Phase 145 WS3 extended the fleet floor with "AskUserQuestion" (the
    // non-rendering built-in, replaced by the MCP ask_user_question tool).
    const resolved = resolveAgentConfig(makeAgent(), makeDefaults());
    expect(resolved.disallowedTools).toEqual([
      "ScheduleWakeup",
      "CronCreate",
      "AskUserQuestion",
    ]);
  });

  it("Q3: does NOT block Monitor by default — it is STEERED, not blocked", () => {
    const resolved = resolveAgentConfig(makeAgent(), makeDefaults());
    expect(resolved.disallowedTools).not.toContain("Monitor");
  });

  it("does NOT carry the recursion guard on a primary — that tool is subagent-scoped only", () => {
    const resolved = resolveAgentConfig(makeAgent(), makeDefaults());
    expect(resolved.disallowedTools).not.toContain(
      "mcp__clawcode__spawn_subagent_thread",
    );
  });

  it("READS defaults.disallowedTools (operator override) — proves the resolver wiring, not a hardcoded floor", () => {
    // The discriminating case: if the resolver hardcoded the floor instead of
    // reading `defaults.disallowedTools`, an operator who appended "Monitor"
    // would silently get the un-extended deny-list. Asserting the override
    // propagates proves the wiring is live (a broken line would be MASKED by
    // the `?? [...]` floor in the no-override cases above).
    const resolved = resolveAgentConfig(
      makeAgent(),
      makeDefaults({ disallowedTools: ["ScheduleWakeup", "CronCreate", "Monitor"] }),
    );
    expect(resolved.disallowedTools).toContain("Monitor");
    expect(resolved.disallowedTools).toEqual([
      "ScheduleWakeup",
      "CronCreate",
      "Monitor",
    ]);
  });

  it("an operator can SHRINK the deny-list (e.g. block only CronCreate) and the resolver honors it", () => {
    const resolved = resolveAgentConfig(
      makeAgent(),
      makeDefaults({ disallowedTools: ["CronCreate"] }),
    );
    expect(resolved.disallowedTools).toEqual(["CronCreate"]);
    expect(resolved.disallowedTools).not.toContain("ScheduleWakeup");
  });
});

// ---------------------------------------------------------------------------
// Quick 260715-j1j (D5/D7) — per-agent nativeWorkflow opt-out of the fleet
// Workflow block + the ultracode↔nativeWorkflow load validation.
// ---------------------------------------------------------------------------
describe("quick 260715-j1j — nativeWorkflow single-name Workflow subtraction (D5)", () => {
  // The prod fleet block ships via YAML defaults.disallowedTools (the
  // fix/workflow-stall-rca deploy appends "Workflow" there) — simulate that.
  const FLEET_WITH_WORKFLOW = [
    "ScheduleWakeup",
    "CronCreate",
    "AskUserQuestion",
    "Workflow",
  ];

  it("nativeWorkflow: true removes EXACTLY 'Workflow' — every other entry intact, order preserved", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ nativeWorkflow: true }),
      makeDefaults({ disallowedTools: FLEET_WITH_WORKFLOW }),
    );
    expect(resolved.disallowedTools).toEqual([
      "ScheduleWakeup",
      "CronCreate",
      "AskUserQuestion",
    ]);
    expect(resolved.disallowedTools).not.toContain("Workflow");
  });

  it("non-opted agent keeps the fleet list VERBATIM (including 'Workflow')", () => {
    const resolved = resolveAgentConfig(
      makeAgent(),
      makeDefaults({ disallowedTools: FLEET_WITH_WORKFLOW }),
    );
    expect(resolved.disallowedTools).toEqual(FLEET_WITH_WORKFLOW);
  });

  it("explicit nativeWorkflow: false behaves exactly like omission (fail-closed gate on === true)", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ nativeWorkflow: false }),
      makeDefaults({ disallowedTools: FLEET_WITH_WORKFLOW }),
    );
    expect(resolved.disallowedTools).toEqual(FLEET_WITH_WORKFLOW);
  });

  it("opt-in with no 'Workflow' in the fleet list is a harmless no-op (subtraction only — never weakens other entries)", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ nativeWorkflow: true }),
      makeDefaults({ disallowedTools: ["ScheduleWakeup", "CronCreate"] }),
    );
    expect(resolved.disallowedTools).toEqual(["ScheduleWakeup", "CronCreate"]);
  });

  it("threads nativeWorkflow: true onto ResolvedAgentConfig; omits the field for the non-opted fleet (byte-stable)", () => {
    const opted = resolveAgentConfig(
      makeAgent({ nativeWorkflow: true }),
      makeDefaults(),
    );
    expect(opted.nativeWorkflow).toBe(true);
    const nonOpted = resolveAgentConfig(makeAgent(), makeDefaults());
    expect("nativeWorkflow" in nonOpted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WS-0 quick 260716-u5h — per-agent ADDITIVE disallowedTools union. Closes the
// 2026-07-14 RCA finding: per-agent `disallowedTools:` in prod YAML (Harvey's
// [Bash]) was silently zod-stripped, leaving an illusion-of-security. The
// union is ADDITIVE-ONLY: agents can add blocks, never remove fleet blocks.
// ---------------------------------------------------------------------------
describe("quick 260716-u5h — per-agent additive disallowedTools union (WS-0.4)", () => {
  it("unions per-agent entries onto the fleet floor (Harvey-style [Bash])", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ disallowedTools: ["Bash"] }),
      makeDefaults(),
    );
    expect(resolved.disallowedTools).toEqual([
      "ScheduleWakeup",
      "CronCreate",
      "AskUserQuestion",
      "Bash",
    ]);
  });

  it("per-agent entries can never REMOVE a floor entry — listing a floor tool dedups, everything else survives", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ disallowedTools: ["ScheduleWakeup"] }),
      makeDefaults(),
    );
    expect(resolved.disallowedTools).toEqual([
      "ScheduleWakeup",
      "CronCreate",
      "AskUserQuestion",
    ]);
  });

  it("dedups across floor + agent, floor-first order preserved, agent additions appended in YAML order", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ disallowedTools: ["Bash", "CronCreate", "ask_agent", "Bash"] }),
      makeDefaults(),
    );
    expect(resolved.disallowedTools).toEqual([
      "ScheduleWakeup",
      "CronCreate",
      "AskUserQuestion",
      "Bash",
      "ask_agent",
    ]);
  });

  it("explicit per-agent 'Workflow' wins over the agent's own nativeWorkflow opt-out (explicit block wins)", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ nativeWorkflow: true, disallowedTools: ["Workflow"] }),
      makeDefaults({
        disallowedTools: [
          "ScheduleWakeup",
          "CronCreate",
          "AskUserQuestion",
          "Workflow",
        ],
      }),
    );
    // Subtraction removed the floor's Workflow; the explicit per-agent entry
    // re-added it at the tail.
    expect(resolved.disallowedTools).toEqual([
      "ScheduleWakeup",
      "CronCreate",
      "AskUserQuestion",
      "Workflow",
    ]);
  });

  it("omitted per-agent field → floor verbatim (fleet byte-stability regression pin)", () => {
    const resolved = resolveAgentConfig(makeAgent(), makeDefaults());
    expect(resolved.disallowedTools).toEqual([
      "ScheduleWakeup",
      "CronCreate",
      "AskUserQuestion",
    ]);
  });

  it("empty per-agent array behaves exactly like omission", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ disallowedTools: [] }),
      makeDefaults(),
    );
    expect(resolved.disallowedTools).toEqual([
      "ScheduleWakeup",
      "CronCreate",
      "AskUserQuestion",
    ]);
  });

  it("agentSchema PARSES the field (the zod-strip is actually closed, not just resolver-defaulted)", () => {
    const parsed = agentSchema.parse({
      name: "harvey-like",
      channels: [],
      disallowedTools: ["Bash", "ask_agent", "send_message", "delegate_task"],
    });
    expect(parsed.disallowedTools).toEqual([
      "Bash",
      "ask_agent",
      "send_message",
      "delegate_task",
    ]);
  });
});

describe("quick 260715-j1j — D7 resolve-time validation (effort: ultracode requires nativeWorkflow)", () => {
  it("agent-level effort: ultracode WITHOUT nativeWorkflow → resolveAgentConfig throws with a clear message", () => {
    expect(() =>
      resolveAgentConfig(makeAgent({ effort: "ultracode" }), makeDefaults()),
    ).toThrow(/ultracode requires nativeWorkflow: true/);
  });

  it("agent-level effort: ultracode WITH nativeWorkflow: true resolves fine", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ effort: "ultracode", nativeWorkflow: true }),
      makeDefaults(),
    );
    expect(resolved.effort).toBe("ultracode");
    expect(resolved.nativeWorkflow).toBe(true);
  });
});
