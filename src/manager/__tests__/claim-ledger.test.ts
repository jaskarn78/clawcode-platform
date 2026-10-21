/** verify_claim validation — the laundering rule and its hints. */
import { describe, expect, it } from "vitest";
import { evidenceFromToolUse, evidenceFromToolResult, type EvidenceEntry } from "../evidence-ledger.js";
import { hintFor, matchSource, sanitizeClaimText, validateClaim } from "../claim-ledger.js";

const AT = 1;
const evidence: EvidenceEntry[] = [
  ...evidenceFromToolUse("WebFetch", "1", { url: "https://www.irs.gov/retirement-plans/rmd-faqs" }, AT),
  ...evidenceFromToolUse("WebFetch", "2", { url: "https://wiggin.com/article" }, AT),
  ...evidenceFromToolResult("WebSearch", "3", 'Links: [{"title":"SSA","url":"https://www.ssa.gov/benefits/retirement"}]', AT),
  ...evidenceFromToolUse("mcp__acme-db__mysql_query", "4", { sql: "SELECT * FROM client_accounts" }, AT),
  ...evidenceFromToolUse("mcp__clawcode__ingest_document", "5", { file_path: "/x/Vallejos-statement-2026-04-30.pdf" }, AT),
];

describe("matchSource", () => {
  it("exact URL, host-level (opened), table, document, bare host", () => {
    expect(matchSource("https://irs.gov/retirement-plans/rmd-faqs", evidence).status).toBe("in-ledger");
    expect(matchSource("https://www.irs.gov/other-page", evidence).status).toBe("in-ledger"); // host opened this turn
    expect(matchSource("table:client_accounts", evidence)).toMatchObject({ status: "in-ledger", tier: "client" });
    expect(matchSource("client_accounts", evidence).status).toBe("in-ledger");
    expect(matchSource("vallejos-statement-2026-04-30.pdf", evidence)).toMatchObject({ status: "in-ledger", tier: "client" });
    expect(matchSource("irs.gov", evidence).status).toBe("in-ledger");
  });
  it("a search hit that was never opened is NOT consulted (unless countFoundAsRead)", () => {
    expect(matchSource("https://ssa.gov/benefits/other", evidence).status).toBe("not-consulted");
    expect(matchSource("https://ssa.gov/benefits/retirement", evidence).status).toBe("in-ledger"); // exact URL always counts
    expect(matchSource("https://ssa.gov/benefits/other", evidence, { countFoundAsRead: true }).status).toBe("in-ledger");
  });
  it("unknown host / empty", () => {
    expect(matchSource("https://example.com/x", evidence)).toMatchObject({ status: "not-consulted", host: "example.com" });
    expect(matchSource("", evidence).status).toBe("none");
  });
});

describe("validateClaim — the laundering rule", () => {
  it("verified + consulted primary source stays verified and is ledgerBacked", () => {
    const e = validateClaim(
      { claim: "RMDs start at 73", verdict: "verified", source: "https://www.irs.gov/retirement-plans/rmd-faqs", class: "rule" },
      evidence,
      "must begin at age 73",
    );
    expect(e.effectiveVerdict).toBe("verified");
    expect(e.ledgerBacked).toBe(true);
    expect(e.sourceTier).toBe("primary");
    expect(e.quoteStatus).toBe("none");
  });
  it("verified + a source never opened → downgraded to unverified, not-consulted, with a hint", () => {
    const e = validateClaim({ claim: "x", verdict: "verified", source: "https://example.com/p" }, evidence, "");
    expect(e.effectiveVerdict).toBe("unverified");
    expect(e.sourceStatus).toBe("not-consulted");
    expect(e.ledgerBacked).toBe(false);
    expect(hintFor(e, evidence)).toContain("example.com was not opened this turn");
    expect(hintFor(e, evidence)).toContain("irs.gov");
  });
  it("verified with NO source → unverified + hint", () => {
    const e = validateClaim({ claim: "x", verdict: "verified" }, evidence, "");
    expect(e.effectiveVerdict).toBe("unverified");
    expect(e.sourceStatus).toBe("none");
    expect(hintFor(e, evidence)).toContain("No source given");
  });
  it("a RULE verified only against a secondary site is unverified (primary required); a figure is fine", () => {
    const rule = validateClaim({ claim: "in-service at 59½", verdict: "verified", source: "https://wiggin.com/article", class: "rule" }, evidence, "");
    expect(rule.effectiveVerdict).toBe("unverified");
    expect(hintFor(rule, evidence)).toContain("not a primary source");
    const fig = validateClaim({ claim: "$1.2M", verdict: "verified", source: "https://wiggin.com/article", class: "figure" }, evidence, "");
    expect(fig.effectiveVerdict).toBe("verified");
    const relaxed = validateClaim(
      { claim: "r", verdict: "verified", source: "https://wiggin.com/article", class: "rule" },
      evidence,
      "",
      { requirePrimaryForRules: false },
    );
    expect(relaxed.effectiveVerdict).toBe("verified");
  });
  it("quote check is SOFT — never changes the verdict", () => {
    const e = validateClaim(
      { claim: "x", verdict: "verified", source: "https://irs.gov/retirement-plans/rmd-faqs", quote: "must begin at age 73" },
      evidence,
      "You  must begin\nat age 73.",
    );
    expect(e.quoteStatus).toBe("verbatim");
    const miss = validateClaim(
      { claim: "x", verdict: "verified", source: "https://irs.gov/retirement-plans/rmd-faqs", quote: "nope" },
      evidence,
      "text",
    );
    expect(miss.quoteStatus).toBe("not-found");
    expect(miss.effectiveVerdict).toBe("verified");
  });
  it("unverified / not-a-claim pass through; invalid verdict → unverified; fields sanitized + capped", () => {
    expect(validateClaim({ claim: "x", verdict: "unverified" }, evidence, "").effectiveVerdict).toBe("unverified");
    expect(validateClaim({ claim: "x", verdict: "not-a-claim" }, evidence, "").effectiveVerdict).toBe("not-a-claim");
    expect(validateClaim({ claim: "x", verdict: "maybe" as never }, evidence, "").effectiveVerdict).toBe("unverified");
    const ctl = String.fromCharCode(1);
    const e = validateClaim(
      { claim: `a b${ctl}\n\n c`.padEnd(900, "z"), verdict: "unverified", audience: "client" },
      evidence,
      "",
    );
    expect(e.claim.length).toBeLessThanOrEqual(300);
    expect(e.claim).not.toContain(ctl);
    expect(e.claim).not.toContain("\n");
    expect(e.audience).toBe("client");
  });
  it("sanitizeClaimText is total", () => {
    expect(sanitizeClaimText(undefined, 10)).toBe("");
    expect(sanitizeClaimText(5, 10)).toBe("");
  });
});
