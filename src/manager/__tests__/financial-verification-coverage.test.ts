/**
 * 2026-07-31 — silently-inert-gate coverage guard tests (pure).
 */
import { describe, it, expect } from "vitest";
import { checkVerificationToolCoverage } from "../financial-verification-policy.js";
import { VERIFICATION_TOOL_SUBSTRINGS } from "../financial-verification-gate.js";

const check = (
  mcpServerNames: readonly string[],
  disallowedTools: readonly string[] = [],
) =>
  checkVerificationToolCoverage({
    mcpServerNames,
    disallowedTools,
    verificationSubstrings: VERIFICATION_TOOL_SUBSTRINGS,
  });

describe("checkVerificationToolCoverage", () => {
  it("covered via a finnhub server (case-insensitive)", () => {
    const r = check(["Finnhub", "playwright"], ["WebSearch"]);
    expect(r.covered).toBe(true);
    expect(r.matchedBy).toContain("server:Finnhub");
  });

  it("covered via native WebSearch when not disallowed", () => {
    const r = check(["playwright", "acme-db"]);
    expect(r.covered).toBe(true);
    expect(r.matchedBy).toContain("native:WebSearch");
  });

  it("uncovered when WebSearch disallowed and no matching server", () => {
    // 2026-08-27 — `acme-db` moved OUT of this fixture: the CRM now
    // counts as a verification source for client figures (see the
    // whitelist), so an agent carrying it is legitimately covered.
    const r = check(["playwright", "google-workspace"], ["WebSearch"]);
    expect(r.covered).toBe(false);
    expect(r.matchedBy).toEqual([]);
  });

  it("2026-08-27 — the CRM server counts as coverage (client records are a primary source)", () => {
    const r = check(["playwright", "acme-db"], ["WebSearch"]);
    expect(r.covered).toBe(true);
    expect(r.matchedBy).toContain("server:acme-db");
  });

  it("brave-search server counts", () => {
    const r = check(["brave-search"], ["websearch"]);
    expect(r.covered).toBe(true);
    expect(r.matchedBy).toContain("server:brave-search");
  });
});
