/**
 * WS-1 (999.99 structural delivery) — buildSessionConfig threading of the
 * attributed-stream pair (attributedStream flag + onOrphanTurnOutput sink).
 *
 * Byte-stability pins: with the gate OFF, NEITHER field appears on the
 * AgentSessionConfig — the non-canary fleet's config shape is unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import { buildSessionConfig, type SessionConfigDeps } from "../session-config.js";
import { resolveAgentConfig } from "../../config/loader.js";
import { defaultsSchema, agentSchema } from "../../config/schema.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

function makeResolved(agentOverrides: Record<string, unknown> = {}): ResolvedAgentConfig {
  return resolveAgentConfig(
    agentSchema.parse({ name: "canary", channels: [], ...agentOverrides }),
    defaultsSchema.parse({}),
  );
}

function makeDeps(overrides: Partial<SessionConfigDeps> = {}): SessionConfigDeps {
  return {
    tierManagers: new Map(),
    skillsCatalog: new Map(),
    allAgentConfigs: [],
    ...overrides,
  };
}

describe("WS-1 — buildSessionConfig attributed-stream threading", () => {
  it("gate OFF → neither attributedStream nor onOrphanTurnOutput on the session config (byte-stability pin)", async () => {
    const cfg = await buildSessionConfig(makeResolved(), makeDeps({
      orphanDeliveryCallbackFactory: () => () => undefined,
    }));
    expect("attributedStream" in cfg).toBe(false);
    expect("onOrphanTurnOutput" in cfg).toBe(false);
  });

  it("gate ON + factory wired → both fields present; the callback is the factory product", async () => {
    const sink = vi.fn();
    const factory = vi.fn(() => sink);
    const cfg = await buildSessionConfig(
      makeResolved({ delivery: { attributedStream: true } }),
      makeDeps({ orphanDeliveryCallbackFactory: factory }),
    );
    expect(cfg.attributedStream).toBe(true);
    expect(factory).toHaveBeenCalledWith({ agentName: "canary" });
    expect(cfg.onOrphanTurnOutput).toBe(sink);
  });

  it("gate ON without a factory (tests/bootstrap) → flag rides alone, sink omitted", async () => {
    const cfg = await buildSessionConfig(
      makeResolved({ delivery: { attributedStream: true } }),
      makeDeps(),
    );
    expect(cfg.attributedStream).toBe(true);
    expect("onOrphanTurnOutput" in cfg).toBe(false);
  });
});
