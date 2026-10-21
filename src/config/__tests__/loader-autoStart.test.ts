/**
 * Phase 100 follow-up — per-agent autoStart flag propagation through the
 * loader.
 *
 * The flag determines whether the daemon's auto-start loop boots an agent on
 * `startDaemon` (autoStart=true, default) or skips it so the operator must
 * `clawcode start <name>` manually (autoStart=false). The schema accepts the
 * field with default true; the loader must thread it through `resolveAgentConfig`
 * into `ResolvedAgentConfig.autoStart` with the documented precedence:
 *
 *   agent.autoStart (when set) wins → defaults.autoStart → schema default true
 *
 * Tests:
 *   AS-1: agent with autoStart:false → resolved.autoStart === false
 *   AS-2: agent without autoStart → defaults to true (back-compat)
 *   AS-3: defaults.autoStart can override the schema default for the whole fleet
 *   AS-4: explicit agent.autoStart wins over defaults.autoStart
 */

import { describe, it, expect } from "vitest";
import { resolveAgentConfig } from "../loader.js";
import { agentSchema, defaultsSchema } from "../schema.js";
import type { AgentConfig, DefaultsConfig } from "../schema.js";

describe("resolveAgentConfig - autoStart (Phase 100 follow-up)", () => {
  // Reuse the production zod defaults for a minimal, schema-true fixture.
  function makeDefaults(overrides: Record<string, unknown> = {}): DefaultsConfig {
    return defaultsSchema.parse(overrides);
  }

  function makeAgent(overrides: Record<string, unknown> = {}): AgentConfig {
    return agentSchema.parse({
      name: "test-agent",
      ...overrides,
    });
  }

  it("AS-1: agent with autoStart: false → resolved config has autoStart === false (operator opt-out)", () => {
    const defaults = makeDefaults();
    const agent = makeAgent({ autoStart: false });
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.autoStart).toBe(false);
  });

  it("AS-2: agent without autoStart field → defaults to true (back-compat for v2.6 yaml configs)", () => {
    const defaults = makeDefaults();
    const agent = makeAgent(); // no autoStart
    const resolved = resolveAgentConfig(agent, defaults);
    // The schema default + loader fallback both land on true — existing
    // 11-agent fleet sees zero behavior change.
    expect(resolved.autoStart).toBe(true);
  });

  it("AS-3: defaults.autoStart: false can override the schema default for the whole fleet (operator can flip the polarity)", () => {
    const defaults = makeDefaults({ autoStart: false });
    // Agent omits autoStart — it inherits the fleet-wide default.
    const agent = makeAgent();
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.autoStart).toBe(false);
  });

  it("AS-4: explicit agent.autoStart wins over defaults.autoStart (per-agent override beats fleet-wide default)", () => {
    // Fleet-wide says false, but this one agent opts back in.
    const defaults = makeDefaults({ autoStart: false });
    const agent = makeAgent({ autoStart: true });
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.autoStart).toBe(true);
  });

  it("AS-5: resolveAgentConfig does NOT mutate the input agent object (immutability)", () => {
    const defaults = makeDefaults();
    const agent = makeAgent({ autoStart: false });
    const before = JSON.parse(JSON.stringify(agent));
    resolveAgentConfig(agent, defaults);
    expect(agent).toEqual(before);
    expect(agent.autoStart).toBe(false);
  });
});
