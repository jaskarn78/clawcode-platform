/**
 * 2026-08-26 — `verification` (and its deprecated alias) must be
 * RELOADABLE.
 *
 * Found while renaming the key on prod: a yaml edit touching ONLY this
 * block produced a diff with zero reloadable changes, so
 * ConfigReloader.applyChanges early-returned BEFORE setAllAgentConfigs.
 * The live config map kept the boot snapshot and the edit did nothing
 * until the next restart — while the incident plan documents
 * ruleClaims.maxVerifyHops / holdDelivery / pendingMarker as "hot flips".
 *
 * These assert the differ's classification directly, because that is the
 * single gate that decides whether the republish happens.
 */
import { describe, expect, it } from "vitest";

import { diffConfigs } from "../differ.js";
import { agentSchema, defaultsSchema } from "../schema.js";
import type { Config } from "../schema.js";

function withAgentBlock(key: "verification" | "financialVerification", streamStatus: boolean): Config {
  const agent = agentSchema.parse({
    name: "fin-client",
    [key]: { ux: { streamStatus } },
  });
  return {
    version: 1,
    defaults: defaultsSchema.parse({}),
    mcpServers: {},
    agents: [agent],
  } as unknown as Config;
}

function withDefaultsBlock(key: "verification" | "financialVerification", streamStatus: boolean): Config {
  return {
    version: 1,
    defaults: defaultsSchema.parse({ [key]: { ux: { streamStatus } } }),
    mcpServers: {},
    agents: [],
  } as unknown as Config;
}

describe("verification block is hot-reloadable", () => {
  it("a verification-only edit on an agent is classified reloadable", () => {
    const diff = diffConfigs(
      withAgentBlock("verification", true),
      withAgentBlock("verification", false),
    );
    const change = diff.changes.find((c) =>
      c.fieldPath.includes("verification"),
    );
    expect(change).toBeDefined();
    expect(change!.reloadable).toBe(true);
    // THE gate: false here means applyChanges returns before republishing.
    expect(diff.hasReloadableChanges).toBe(true);
  });

  it("a verification-only edit on defaults is classified reloadable", () => {
    const diff = diffConfigs(
      withDefaultsBlock("verification", true),
      withDefaultsBlock("verification", false),
    );
    expect(diff.hasReloadableChanges).toBe(true);
  });

  it("the deprecated alias stays hot for as long as it is accepted", () => {
    // An alias that resolves but is not hot would be a half-migration trap.
    const diff = diffConfigs(
      withAgentBlock("financialVerification", true),
      withAgentBlock("financialVerification", false),
    );
    expect(diff.hasReloadableChanges).toBe(true);
  });

  it("renaming the key in place is itself a reloadable diff", () => {
    // The exact prod edit that surfaced this: same values, key renamed.
    const diff = diffConfigs(
      withAgentBlock("financialVerification", true),
      withAgentBlock("verification", true),
    );
    expect(diff.hasReloadableChanges).toBe(true);
  });
});
