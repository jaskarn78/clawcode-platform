/** `verify-claim` IPC arm — validation, routing, live fan-out, model-facing reply. */
import { describe, expect, it, beforeEach } from "vitest";
import { handleVerifyClaim, renderVerifyClaimReply, verifyClaimParamsSchema } from "../daemon-verify-claim-ipc.js";
import { registerClaimSink, resetClaimSinksForTests } from "../claim-sink.js";
import { validateClaim, type ClaimEntry } from "../claim-ledger.js";
import { evidenceFromToolUse, type EvidenceEntry } from "../evidence-ledger.js";

const evidence: EvidenceEntry[] = evidenceFromToolUse("WebFetch", "1", { url: "https://www.irs.gov/rmd" }, 1);

function fakeDeps(active: boolean) {
  const recorded: ClaimEntry[] = [];
  return {
    recorded,
    deps: {
      recordClaimForActiveTurn: (_agent: string, params: Parameters<typeof validateClaim>[0]) => {
        if (!active) return null;
        const entry: ClaimEntry = { ...validateClaim(params, evidence, "", {}), id: `c${recorded.length + 1}`, turnId: "turn-1", at: 1 };
        recorded.push(entry);
        return entry;
      },
      getActiveTurnEvidence: () => evidence,
    },
  };
}

describe("handleVerifyClaim", () => {
  beforeEach(() => resetClaimSinksForTests());

  it("records a valid claim, fans it out to the turn's sink, and replies with the effective verdict", () => {
    const { deps, recorded } = fakeDeps(true);
    const seen: string[] = [];
    registerClaimSink("turn-1", (e) => seen.push(e.id));
    const r = handleVerifyClaim(deps, { agent: "fin-client", claim: "RMDs start at 73", verdict: "verified", source: "https://irs.gov/rmd" });
    expect(r).toMatchObject({ ok: true, id: "c1", effectiveVerdict: "verified", sourceStatus: "in-ledger" });
    expect(recorded).toHaveLength(1);
    expect(seen).toEqual(["c1"]);
    expect(renderVerifyClaimReply(r)).toContain("recorded as verified");
  });

  it("downgrades a laundered source and tells the model why", () => {
    const { deps } = fakeDeps(true);
    const r = handleVerifyClaim(deps, { agent: "a", claim: "x is y", verdict: "verified", source: "https://example.com/z" });
    expect(r).toMatchObject({ ok: true, effectiveVerdict: "unverified", sourceStatus: "not-consulted" });
    expect(renderVerifyClaimReply(r)).toContain("example.com was not opened this turn");
  });

  it("rejects invalid params without throwing", () => {
    const { deps } = fakeDeps(true);
    expect(handleVerifyClaim(deps, { agent: "a", claim: "x", verdict: "verified" })).toMatchObject({ ok: false, reason: "invalid-params" });
    expect(handleVerifyClaim(deps, { agent: "a", claim: "long enough", verdict: "maybe" })).toMatchObject({ ok: false, reason: "invalid-params" });
    expect(verifyClaimParamsSchema.safeParse({ agent: "a", claim: "long enough", verdict: "verified", class: "rule", audience: "client" }).success).toBe(true);
  });

  it("no active turn → reason no-active-turn, and the reply tells the model to continue", () => {
    const { deps } = fakeDeps(false);
    const r = handleVerifyClaim(deps, { agent: "a", claim: "long enough", verdict: "verified" });
    expect(r).toEqual({ ok: false, reason: "no-active-turn" });
    expect(renderVerifyClaimReply(r)).toContain("no active turn");
  });
});
