/**
 * Cross-agent owner/tenant isolation unit pins (2026-06-27).
 *
 * The security core: a Client A-owned agent must not be able to act on a Operator-owned
 * agent via any cross-agent IPC vector. Asserts the owner boundary keys off the
 * TOKEN-VERIFIED caller (not self-reported params), admin is exempt, same-owner
 * (incl. the legit fin-* → fin-research delegate) keeps working, and tokenless
 * local calls fail open.
 */

import { describe, it, expect } from "vitest";
import {
  assertCrossAgentAllowed,
  resolveVerifiedCaller,
  enforceCrossAgentIsolation,
  CROSS_AGENT_TARGET_EXTRACTORS,
  type OwnerConfigView,
} from "../agent-owner-isolation.js";
import {
  computeAgentToken,
  AGENT_TOKEN_PARAM,
  CALLER_AGENT_PARAM,
} from "../agent-identity-token.js";

const SECRET = "a".repeat(64);

const CONFIGS: OwnerConfigView[] = [
  { name: "personal", owner: "owner_a" },
  { name: "clawdy-voice", owner: "owner_a" },
  { name: "legal-counsel", owner: "owner_a" },
  { name: "Admin Clawdy", owner: "owner_a", admin: true },
  { name: "fin-client", owner: "client_a" },
  { name: "fin-research", owner: "client_a" },
  { name: "state-contract", owner: "client_a" },
  { name: "untagged" }, // no owner
];

/** Build IPC params carrying a VALID token for `caller`. */
function withToken(
  caller: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...extra,
    [CALLER_AGENT_PARAM]: caller,
    [AGENT_TOKEN_PARAM]: computeAgentToken(SECRET, caller),
  };
}

describe("assertCrossAgentAllowed", () => {
  it("allows same-owner (the legit fin-* → fin-research delegate must keep working)", () => {
    expect(() =>
      assertCrossAgentAllowed("fin-client", "fin-research", CONFIGS),
    ).not.toThrow();
  });

  it("denies cross-owner (client_a → owner_a)", () => {
    expect(() =>
      assertCrossAgentAllowed("fin-client", "personal", CONFIGS),
    ).toThrow(/cross-owner action denied/);
  });

  it("denies the inverse too (owner_a → client_a)", () => {
    expect(() =>
      assertCrossAgentAllowed("personal", "fin-client", CONFIGS),
    ).toThrow(/cross-owner/);
  });

  it("exempts admin callers (Admin Clawdy → anyone)", () => {
    expect(() =>
      assertCrossAgentAllowed("Admin Clawdy", "fin-client", CONFIGS),
    ).not.toThrow();
    expect(() =>
      assertCrossAgentAllowed("Admin Clawdy", "personal", CONFIGS),
    ).not.toThrow();
  });

  it("allows self-targeting", () => {
    expect(() =>
      assertCrossAgentAllowed("personal", "personal", CONFIGS),
    ).not.toThrow();
  });

  it("asserts no boundary toward an untagged target", () => {
    expect(() =>
      assertCrossAgentAllowed("fin-client", "untagged", CONFIGS),
    ).not.toThrow();
  });

  it("denies an untagged caller reaching an OWNED target (fail-closed)", () => {
    expect(() =>
      assertCrossAgentAllowed("untagged", "personal", CONFIGS),
    ).toThrow(/cross-owner/);
  });
});

describe("resolveVerifiedCaller", () => {
  it("returns the caller when the token is valid", () => {
    expect(
      resolveVerifiedCaller(withToken("fin-client"), SECRET),
    ).toBe("fin-client");
  });

  it("returns null for a tokenless call (trusted local → fail open)", () => {
    expect(resolveVerifiedCaller({ from: "x" }, SECRET)).toBeNull();
  });

  it("returns null when the secret is not initialised", () => {
    expect(resolveVerifiedCaller(withToken("fin-client"), null)).toBeNull();
  });

  it("THROWS on a forged token (claimed caller != token)", () => {
    const forged = {
      [CALLER_AGENT_PARAM]: "personal",
      [AGENT_TOKEN_PARAM]: computeAgentToken(SECRET, "fin-client"), // wrong
    };
    expect(() => resolveVerifiedCaller(forged, SECRET)).toThrow(/token mismatch/);
  });
});

describe("enforceCrossAgentIsolation — end-to-end per vector", () => {
  it("denies ask-agent client_a → owner_a (the exfil vector)", () => {
    expect(() =>
      enforceCrossAgentIsolation(
        "ask-agent",
        withToken("fin-client", { to: "personal", content: "hi" }),
        CONFIGS,
        SECRET,
      ),
    ).toThrow(/cross-owner/);
  });

  it("IGNORES a spoofed self-report `from` — owner keys off the token", () => {
    // Client A agent sets from:"personal" to look like a owner_a→owner_a call; still denied.
    expect(() =>
      enforceCrossAgentIsolation(
        "ask-agent",
        withToken("fin-client", { from: "personal", to: "personal" }),
        CONFIGS,
        SECRET,
      ),
    ).toThrow(/cross-owner/);
  });

  it("allows ask-agent within the same owner", () => {
    expect(() =>
      enforceCrossAgentIsolation(
        "ask-agent",
        withToken("fin-client", { to: "fin-research" }),
        CONFIGS,
        SECRET,
      ),
    ).not.toThrow();
  });

  it("denies start-workflow run AS a owner_a agent (spoofed p.agent)", () => {
    expect(() =>
      enforceCrossAgentIsolation(
        "start-workflow",
        withToken("fin-client", { agent: "personal" }),
        CONFIGS,
        SECRET,
      ),
    ).toThrow(/cross-owner/);
  });

  it("denies spawn-subagent-thread delegateTo a owner_a agent", () => {
    expect(() =>
      enforceCrossAgentIsolation(
        "spawn-subagent-thread",
        withToken("fin-client", {
          parentAgent: "fin-client",
          delegateTo: "personal",
        }),
        CONFIGS,
        SECRET,
      ),
    ).toThrow(/cross-owner/);
  });

  it("no-ops a non-delegate spawn (no cross-agent target)", () => {
    expect(() =>
      enforceCrossAgentIsolation(
        "spawn-subagent-thread",
        withToken("fin-client", { parentAgent: "fin-client" }),
        CONFIGS,
        SECRET,
      ),
    ).not.toThrow();
  });

  it("denies post-to-agent and delegate-task cross-owner", () => {
    expect(() =>
      enforceCrossAgentIsolation(
        "post-to-agent",
        withToken("state-contract", { to: "legal-counsel" }),
        CONFIGS,
        SECRET,
      ),
    ).toThrow(/cross-owner/);
    expect(() =>
      enforceCrossAgentIsolation(
        "delegate-task",
        withToken("fin-client", { caller: "fin-client", target: "clawdy-voice" }),
        CONFIGS,
        SECRET,
      ),
    ).toThrow(/cross-owner/);
  });

  it("no-ops tokenless calls (trusted CLI/dashboard)", () => {
    expect(() =>
      enforceCrossAgentIsolation(
        "ask-agent",
        { to: "personal" },
        CONFIGS,
        SECRET,
      ),
    ).not.toThrow();
  });

  it("no-ops a method not in the cross-agent table", () => {
    expect(() =>
      enforceCrossAgentIsolation(
        "status",
        withToken("fin-client", { to: "personal" }),
        CONFIGS,
        SECRET,
      ),
    ).not.toThrow();
  });

  it("allows SEND requests to an admin agent from any owner (client_a → Admin Clawdy)", () => {
    expect(() =>
      enforceCrossAgentIsolation(
        "send-message",
        withToken("fin-client", { to: "Admin Clawdy", content: "please add a cron" }),
        CONFIGS,
        SECRET,
      ),
    ).not.toThrow();
    expect(() =>
      enforceCrossAgentIsolation(
        "delegate-task",
        withToken("fin-client", { caller: "fin-client", target: "Admin Clawdy" }),
        CONFIGS,
        SECRET,
      ),
    ).not.toThrow();
  });

  it("still DENIES reading an admin agent's history cross-owner (send-only exemption)", () => {
    expect(() =>
      enforceCrossAgentIsolation(
        "message-history",
        withToken("fin-client", { agent: "Admin Clawdy" }),
        CONFIGS,
        SECRET,
      ),
    ).toThrow(/cross-owner/);
  });

  it("still DENIES SEND to a owner_a BUSINESS (non-admin) agent — only admin targets open", () => {
    expect(() =>
      enforceCrossAgentIsolation(
        "send-message",
        withToken("fin-client", { to: "personal" }),
        CONFIGS,
        SECRET,
      ),
    ).toThrow(/cross-owner/);
  });

  it("covers every audited cross-agent method in the extractor table", () => {
    for (const m of [
      "ask-agent",
      "send-message",
      "post-to-agent",
      "spawn-subagent-thread",
      "start-workflow",
      "delegate-task",
      "message-history",
      "schedule-recurring",
      "schedule-reminder",
    ]) {
      expect(CROSS_AGENT_TARGET_EXTRACTORS[m]).toBeTypeOf("function");
    }
  });
});
