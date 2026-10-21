/**
 * 2026-09-03 — the activity trail ("💠 working / → searching: …") is a
 * COSMETIC display and must not require financial-verification enforcement.
 *
 * The gate in bridge.ts used to be:
 *
 *   ux.streamStatus === true && isVerificationEnforced(agent, cfg.enforced)
 *
 * `isVerificationEnforced` falls back to a NAME-PREFIX rule (`fin-`,
 * `acme-`). So on `personal` — or any agent not named like a finance
 * agent — the trail could never paint no matter what the config or the
 * /clawcode-verify panel said. The only config that switched it on was
 * `verification.enforced: true`, which also arms the claim classifier on
 * every turn.
 *
 * These tests pin the prefix rule that caused it, so the coupling cannot be
 * reintroduced by someone reading `enforced` as a general on/off switch.
 */

import { describe, it, expect } from "vitest";
import {
  isVerificationEnforced,
  FINANCIAL_AGENT_PREFIXES,
} from "../financial-verification-policy.js";

describe("verification enforcement is a FINANCE rule, not a feature switch", () => {
  it("enforces finance-prefixed agents by name alone", () => {
    expect(isVerificationEnforced("fin-client", undefined)).toBe(true);
    expect(isVerificationEnforced("fin-research", undefined)).toBe(true);
  });

  it("does NOT enforce a general agent — the reason the trail never painted", () => {
    // This is the whole bug in one assertion: `personal` can never satisfy a
    // gate built on this, so anything ANDed with it is dead for that agent.
    expect(isVerificationEnforced("personal", undefined)).toBe(false);
    expect(isVerificationEnforced("shopping", undefined)).toBe(false);
    expect(isVerificationEnforced("projects", undefined)).toBe(false);
  });

  it("an explicit override wins in both directions", () => {
    // The only pre-fix way to light the trail on `personal` was this — which
    // also arms the classifier on every turn.
    expect(isVerificationEnforced("personal", true)).toBe(true);
    expect(isVerificationEnforced("fin-client", false)).toBe(false);
  });

  it("the prefix list is finance-specific", () => {
    // If this ever grows into a general allowlist, the reasoning above (and
    // the decoupling in bridge.ts) needs revisiting.
    expect([...FINANCIAL_AGENT_PREFIXES].sort()).toEqual(["fin-"]);
  });
});

describe("bridge gating — static pin", () => {
  it("streamStatusActive does NOT depend on enforcement; holdDelivery still does", async () => {
    // A behavioural test would need a full DiscordBridge; this pins the two
    // gates textually so a refactor cannot quietly re-add the coupling.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/discord/bridge.ts"),
      "utf-8",
    );

    const streamGate = src.slice(
      src.indexOf("const streamStatusActive ="),
      src.indexOf("const streamStatusActive =") + 260,
    );
    expect(streamGate).toContain("ux?.streamStatus === true");
    expect(streamGate).not.toContain("isVerificationEnforced");

    const holdGate = src.slice(
      src.indexOf("const holdDeliveryActive ="),
      src.indexOf("const holdDeliveryActive =") + 260,
    );
    // Holding a message back IS verification behaviour — correctly gated.
    expect(holdGate).toContain("isVerificationEnforced");
  });
});
