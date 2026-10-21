/**
 * 2026-08-27 — `baseAgentName` + the fork-aware verify-claim lookup.
 *
 * Prod incident: fin-client answered a fully-sourced turn from a FORKED
 * session, so `CLAWCODE_AGENT` (and therefore the MCP tool's `agent` param)
 * was `fin-client-fork-iotYXl`. The trace collector only ever exists
 * under the BASE name, so all four `verify_claim` calls came back "no active
 * turn to attach this claim to" and the claim ledger stayed empty — the reply
 * shipped with a bare ⚠️ despite three IRS pages having been opened.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { baseAgentName, buildForkConfig, buildForkName } from "../fork.js";
import { handleVerifyClaim } from "../daemon-verify-claim-ipc.js";

describe("baseAgentName", () => {
  it("strips the fork suffix and leaves ordinary names alone", () => {
    expect(baseAgentName("fin-client-fork-iotYXl")).toBe("fin-client");
    expect(baseAgentName("fin-client")).toBe("fin-client");
    expect(baseAgentName("Admin Clawdy")).toBe("Admin Clawdy");
    // Round-trips whatever buildForkName produces.
    expect(baseAgentName(buildForkName("state-contract"))).toBe("state-contract");
    // A name that merely CONTAINS "-fork-" mid-string is untouched.
    expect(baseAgentName("a-fork-of-mine")).toBe("a-fork-of-mine");
    // Wrong-length suffix is not a fork name.
    expect(baseAgentName("agent-fork-abc")).toBe("agent-fork-abc");
  });
});

describe("verify_claim from a forked session", () => {
  const params = {
    agent: "fin-client-fork-iotYXl",
    claim: "2026 elective deferral limit is $24,500",
    verdict: "verified" as const,
    source: "https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026",
  };

  it("records against the BASE agent's active turn", () => {
    const seen: string[] = [];
    const record = vi.fn().mockImplementation((agent: string) => {
      seen.push(agent);
      return {
        id: "c1", turnId: "t1", claim: params.claim, verdict: "verified",
        effectiveVerdict: "verified", sourceStatus: "in-ledger", sourceHost: "irs.gov",
        quoteStatus: "absent", origin: "tool", at: 1, ledgerBacked: true,
      };
    });
    // Mirrors the daemon arm: collector exists ONLY under the base name.
    const collectorFor = (a: string) => (a === "fin-client" ? {} : undefined);
    const res = handleVerifyClaim(
      {
        recordClaimForActiveTurn: (a: string, p: never, o: never) => {
          const owner = collectorFor(a) ? a : baseAgentName(a);
          return collectorFor(owner) ? record(owner, p, o) : null;
        },
        getActiveTurnEvidence: () => [],
      } as never,
      params as never,
    );
    expect(seen).toEqual(["fin-client"]);
    expect(res).toMatchObject({ ok: true, effectiveVerdict: "verified" });
  });

  it("regression: a base-name-only lookup drops the claim (the shipped bug)", () => {
    const res = handleVerifyClaim(
      {
        recordClaimForActiveTurn: (a: string) => (a === "fin-client" ? ({} as never) : null),
        getActiveTurnEvidence: () => [],
      } as never,
      params as never,
    );
    expect(res).toMatchObject({ ok: false, reason: "no-active-turn" });
  });

  it("the daemon arm resolves the collector owner (static pin)", () => {
    const src = readFileSync(new URL("../daemon.ts", import.meta.url), "utf8");
    const arm = src.slice(src.indexOf('case "verify-claim"'), src.indexOf('case "set-verification"'));
    expect(arm).toContain("baseAgentName(a)");
    expect(arm.match(/baseAgentName\(a\)/g) ?? []).toHaveLength(2); // record + evidence
  });
});

describe("fork prompt", () => {
  it("tells the fork not to call ask_advisor (a fork IS the advisor mechanism)", () => {
    const cfg = buildForkConfig(
      { name: "fin-client", soul: "You are Client A's analyst." } as never,
      "fin-client-fork-iotYXl",
    );
    expect(cfg.soul).toContain("Do NOT call the `ask_advisor` tool");
    expect(cfg.soul).toContain("You are Client A's analyst."); // parent soul preserved
    expect(cfg.name).toBe("fin-client-fork-iotYXl");
  });
});
