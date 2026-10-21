/**
 * Phase 145 Plan 01 — loader resolver wiring for the three additive
 * interactivity foundation fields:
 *
 *   1. maxTurnDurationMs — a per-session override (cascade:
 *      agent → defaults.modelOverrides[model] → defaults → 20-min default)
 *      that LIFTS the absolute turn-duration ceiling for long-running
 *      background workers (WS2). The zod min equals the existing 20-min
 *      default so an agent can only ever raise, never lower, the ceiling.
 *   2. subagentPermissionGate — a boolean flag (agent ?? defaults ?? false)
 *      that Plan 02 (WS1) reads to gate the subagent PreToolUse hook. Default
 *      OFF keeps the fleet byte-stable.
 *   3. "AskUserQuestion" added to the fleet disallowedTools default (WS3) —
 *      the non-rendering built-in is disallowed; the MCP ask_user_question
 *      tool (Plan 04) is the substitute.
 *
 * Asserts on the RESOLVED OUTPUT (ResolvedAgentConfig), mirroring the
 * Phase 999.99 loader-disallowed-tools.test.ts precedent: the schema fields
 * are `.optional()` so the parsed value short-circuits to `undefined` when
 * the key is absent, and the resolver's `??` cascade is what concretizes the
 * value at consumption time.
 */
import { describe, it, expect } from "vitest";
import { resolveAgentConfig } from "../loader.js";
import { defaultsSchema, agentSchema } from "../schema.js";
import type { AgentConfig, DefaultsConfig } from "../schema.js";
import { DEFAULT_MAX_TURN_DURATION_MS } from "../../manager/stream-stall-tracker.js";

/** Minimal raw agent → parsed AgentConfig (zod fills the rest). */
function makeAgent(overrides: Record<string, unknown> = {}): AgentConfig {
  return agentSchema.parse({ name: "primary-agent", channels: [], ...overrides });
}

/** Minimal raw defaults → parsed DefaultsConfig (zod fills the factory). */
function makeDefaults(overrides: Record<string, unknown> = {}): DefaultsConfig {
  return defaultsSchema.parse({ ...overrides });
}

describe("Phase 145-01 — resolveAgentConfig.maxTurnDurationMs cascade", () => {
  it("resolves from the agent-level override when set", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ maxTurnDurationMs: 7_200_000 }),
      makeDefaults(),
    );
    expect(resolved.maxTurnDurationMs).toBe(7_200_000);
  });

  it("resolves from defaults.modelOverrides[model] when the agent omits it", () => {
    // z.record(z.enum([...])) is exhaustive in zod v4 — every model key must
    // be present; the non-target classes carry empty override objects.
    const resolved = resolveAgentConfig(
      makeAgent({ model: "opus" }),
      makeDefaults({
        modelOverrides: {
          haiku: {},
          sonnet: {},
          opus: { maxTurnDurationMs: 5_400_000 },
        },
      }),
    );
    expect(resolved.maxTurnDurationMs).toBe(5_400_000);
  });

  it("resolves from defaults.maxTurnDurationMs when agent + modelOverride are unset", () => {
    const resolved = resolveAgentConfig(
      makeAgent(),
      makeDefaults({ maxTurnDurationMs: 3_600_000 }),
    );
    expect(resolved.maxTurnDurationMs).toBe(3_600_000);
  });

  it("falls back to the built-in DEFAULT_MAX_TURN_DURATION_MS (20 min) when nothing is set", () => {
    const resolved = resolveAgentConfig(makeAgent(), makeDefaults());
    expect(resolved.maxTurnDurationMs).toBe(DEFAULT_MAX_TURN_DURATION_MS);
    expect(resolved.maxTurnDurationMs).toBe(20 * 60_000);
  });

  it("an agent-level override beats a defaults.modelOverrides entry (cascade order)", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ model: "opus", maxTurnDurationMs: 8_000_000 }),
      makeDefaults({
        modelOverrides: {
          haiku: {},
          sonnet: {},
          opus: { maxTurnDurationMs: 5_400_000 },
        },
      }),
    );
    expect(resolved.maxTurnDurationMs).toBe(8_000_000);
  });
});

describe("Phase 145-01 — resolveAgentConfig.subagentPermissionGate", () => {
  it("resolves to false when neither agent nor defaults set it (fleet byte-stable)", () => {
    const resolved = resolveAgentConfig(makeAgent(), makeDefaults());
    expect(resolved.subagentPermissionGate).toBe(false);
  });

  it("resolves to true when the agent sets it", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ subagentPermissionGate: true }),
      makeDefaults(),
    );
    expect(resolved.subagentPermissionGate).toBe(true);
  });

  it("resolves from defaults.subagentPermissionGate when the agent omits it", () => {
    const resolved = resolveAgentConfig(
      makeAgent(),
      makeDefaults({ subagentPermissionGate: true }),
    );
    expect(resolved.subagentPermissionGate).toBe(true);
  });

  it("an agent-level value beats the defaults value (cascade order)", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ subagentPermissionGate: false }),
      makeDefaults({ subagentPermissionGate: true }),
    );
    expect(resolved.subagentPermissionGate).toBe(false);
  });
});

describe("Phase 145-01 — AskUserQuestion in the fleet disallowedTools default", () => {
  it("includes AskUserQuestion in the resolved disallowedTools for an agent that does not override the default", () => {
    const resolved = resolveAgentConfig(makeAgent(), makeDefaults());
    expect(resolved.disallowedTools).toContain("AskUserQuestion");
  });

  it("resolves the full fleet floor [ScheduleWakeup, CronCreate, AskUserQuestion]", () => {
    const resolved = resolveAgentConfig(makeAgent(), makeDefaults());
    expect(resolved.disallowedTools).toEqual([
      "ScheduleWakeup",
      "CronCreate",
      "AskUserQuestion",
    ]);
  });
});
