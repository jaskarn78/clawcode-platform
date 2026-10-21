/**
 * WS-1 (999.99 structural delivery) — loader cascade for the
 * turn-attributed stream gate (`delivery.attributedStream`).
 *
 * agent.delivery ?? defaults.delivery ?? false, with spread-conditional
 * OMIT when false so the non-canary fleet's resolved shape stays
 * byte-identical (regression pin).
 */
import { describe, it, expect } from "vitest";
import { resolveAgentConfig } from "../loader.js";
import { defaultsSchema, agentSchema } from "../schema.js";
import type { AgentConfig, DefaultsConfig } from "../schema.js";

function makeAgent(overrides: Record<string, unknown> = {}): AgentConfig {
  return agentSchema.parse({ name: "canary-agent", channels: [], ...overrides });
}

function makeDefaults(overrides: Record<string, unknown> = {}): DefaultsConfig {
  return defaultsSchema.parse({ ...overrides });
}

describe("WS-1 — deliveryAttributedStream loader cascade", () => {
  it("omitted everywhere → field ABSENT from the resolved config (fleet byte-stability pin)", () => {
    const resolved = resolveAgentConfig(makeAgent(), makeDefaults());
    expect("deliveryAttributedStream" in resolved).toBe(false);
  });

  it("agent-level delivery.attributedStream: true → resolved true (canary shape)", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ delivery: { attributedStream: true } }),
      makeDefaults(),
    );
    expect(resolved.deliveryAttributedStream).toBe(true);
  });

  it("defaults-level delivery.attributedStream: true floors onto every agent", () => {
    const resolved = resolveAgentConfig(
      makeAgent(),
      makeDefaults({ delivery: { attributedStream: true } }),
    );
    expect(resolved.deliveryAttributedStream).toBe(true);
  });

  it("agent-level false BEATS defaults-level true (per-agent opt-out)", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ delivery: { attributedStream: false } }),
      makeDefaults({ delivery: { attributedStream: true } }),
    );
    expect("deliveryAttributedStream" in resolved).toBe(false);
  });

  it("explicit false everywhere behaves exactly like omission", () => {
    const resolved = resolveAgentConfig(
      makeAgent({ delivery: { attributedStream: false } }),
      makeDefaults({ delivery: { attributedStream: false } }),
    );
    expect("deliveryAttributedStream" in resolved).toBe(false);
  });

  it("agentSchema PARSES the delivery block (not zod-stripped)", () => {
    const parsed = agentSchema.parse({
      name: "x",
      channels: [],
      delivery: { attributedStream: true },
    });
    expect(parsed.delivery?.attributedStream).toBe(true);
  });
});
