/**
 * Phase 999.63 Plan 01 — financial-draft regex classifier test suite.
 *
 * TDD RED: this suite is committed BEFORE `../financial-classifier.ts`
 * exists. The import below errors out at load time — that is the
 * intended RED state. The GREEN commit (T-02) ships the implementation
 * and turns the whole suite green.
 *
 * Coverage:
 *   - POSITIVE: currency, percentage, magnitude-suffix currency, bare
 *     percentage, keyword+ticker corroboration, keyword `AUM`.
 *   - NEGATIVE: plain ops text, bare ALL-CAPS (corroborating-only
 *     ticker), empty string, numeric-but-non-financial date.
 *   - STRUCTURE: matchedTokens non-empty + lists the actual triggering
 *     substring; matchedTokens capped at MAX_MATCHED_TOKENS.
 *   - CANONICAL PIN: static-grep the source file so a future edit that
 *     deletes a keyword / token regex literal fails this test.
 *
 * The classifier is pure — no mocks needed.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  classifyFinancialDraft,
  MAX_MATCHED_TOKENS,
  type FinancialClassification,
} from "../financial-classifier.js";

describe("classifyFinancialDraft", () => {
  describe("positive cases (isFinancial === true)", () => {
    it("flags the 999.1 trigger case — `5.25%` SGOV yield — and matchedTokens includes `5.25%`", () => {
      const result = classifyFinancialDraft("The current SGOV yield is 5.25%.");
      expect(result.isFinancial).toBe(true);
      expect(result.matchedTokens).toContain("5.25%");
    });

    it("flags a currency amount with a thousands separator (`$1,200`)", () => {
      const result = classifyFinancialDraft("That fund holds $1,200 in T-bills.");
      expect(result.isFinancial).toBe(true);
      expect(result.matchedTokens.length).toBeGreaterThan(0);
      expect(result.matchedTokens).toContain("$1,200");
    });

    it("flags a currency amount with a magnitude suffix (`$1.5M`)", () => {
      const result = classifyFinancialDraft("AUM is roughly $1.5M.");
      expect(result.isFinancial).toBe(true);
      expect(result.matchedTokens).toContain("$1.5M");
    });

    // 2026-08-27 — a LONE percentage no longer fires (prod false-positive
    // class: "100% sure"). A percentage corroborated by a strong keyword does.
    it("flags a percentage corroborated by a finance keyword (`0.5%` + `yield`)", () => {
      const result = classifyFinancialDraft("The yield was 0.5% last month.");
      expect(result.isFinancial).toBe(true);
      expect(result.matchedTokens).toContain("0.5%");
    });

    it("flags a strong keyword + ticker corroboration (`VOO` + `yield` + `1.3%`)", () => {
      // `rate` is now corroborating-only — a bare `rate` + a bare ticker
      // (both corroborating) no longer flags. The strong keyword `yield`
      // (plus a percentage) triggers; ticker `VOO` corroborates and is
      // reported in matchedTokens.
      const result = classifyFinancialDraft(
        "VOO has a competitive expense ratio, yield is 1.3%.",
      );
      expect(result.isFinancial).toBe(true);
      expect(result.matchedTokens).toContain("VOO");
      expect(result.matchedTokens.some((t) => t.toLowerCase() === "yield")).toBe(
        true,
      );
    });

    it("flags the finance keyword `AUM`", () => {
      const result = classifyFinancialDraft("Their AUM grew this quarter.");
      expect(result.isFinancial).toBe(true);
      expect(result.matchedTokens.some((t) => t.toUpperCase() === "AUM")).toBe(true);
    });

    it("flags a standalone uppercase `NAV` as a finance keyword", () => {
      const result = classifyFinancialDraft("NAV is the term used here.");
      expect(result.isFinancial).toBe(true);
      expect(result.matchedTokens.some((t) => t.toUpperCase() === "NAV")).toBe(true);
    });

    it("flags a real financial draft — `$1.5M AUM in the fund`", () => {
      const result = classifyFinancialDraft("$1.5M AUM in the fund.");
      expect(result.isFinancial).toBe(true);
      expect(result.matchedTokens).toContain("$1.5M");
      expect(result.matchedTokens.some((t) => t.toUpperCase() === "AUM")).toBe(true);
    });

    it("flags a real financial draft — `the 10-year yield is 4.3%`", () => {
      const result = classifyFinancialDraft("The 10-year yield is 4.3%.");
      expect(result.isFinancial).toBe(true);
      expect(result.matchedTokens).toContain("4.3%");
      expect(result.matchedTokens.some((t) => t.toLowerCase() === "yield")).toBe(
        true,
      );
    });

    it("corroboration boundary — bare `rate` + a `4%` percentage → financial", () => {
      const result = classifyFinancialDraft("Rate climbed to 4% this month.");
      expect(result.isFinancial).toBe(true);
      // `rate` is corroborating-only but is reported once the percentage
      // strong signal has fired.
      expect(result.matchedTokens).toContain("4%");
      expect(result.matchedTokens.some((t) => t.toLowerCase() === "rate")).toBe(
        true,
      );
    });
  });

  describe("negative cases (isFinancial === false, matchedTokens === [])", () => {
    it("does NOT flag plain ops text", () => {
      const result = classifyFinancialDraft(
        "Sure, I rebooted the server and the logs look clean now.",
      );
      expect(result.isFinancial).toBe(false);
      expect(result.matchedTokens).toEqual([]);
    });

    it("does NOT flag bare ALL-CAPS words without a finance keyword or number (ticker is corroborating-only)", () => {
      const result = classifyFinancialDraft("The API and SDK docs are updated.");
      expect(result.isFinancial).toBe(false);
      expect(result.matchedTokens).toEqual([]);
    });

    it("does NOT flag the empty string", () => {
      const result = classifyFinancialDraft("");
      expect(result.isFinancial).toBe(false);
      expect(result.matchedTokens).toEqual([]);
    });

    it("does NOT flag a numeric-but-non-financial date/time (`2:30`)", () => {
      const result = classifyFinancialDraft("Let's meet at 2:30 today.");
      expect(result.isFinancial).toBe(false);
      expect(result.matchedTokens).toEqual([]);
    });

    it("does NOT flag `iterate` — `rate` is a substring, not a word", () => {
      const result = classifyFinancialDraft("I need to iterate over the list.");
      expect(result.isFinancial).toBe(false);
      expect(result.matchedTokens).toEqual([]);
    });

    it("does NOT flag `generate the migration script` — `rate` inside `generate`/`migration`", () => {
      const result = classifyFinancialDraft("Generate the migration script now.");
      expect(result.isFinancial).toBe(false);
      expect(result.matchedTokens).toEqual([]);
    });

    it("does NOT flag `rate limit` — bare word `rate` with no corroborating signal", () => {
      const result = classifyFinancialDraft("We hit the rate limit on that API.");
      expect(result.isFinancial).toBe(false);
      expect(result.matchedTokens).toEqual([]);
    });

    it("does NOT flag `navigate` — `nav` inside `navigate`, lowercase (NAV is case-sensitive)", () => {
      const result = classifyFinancialDraft("Navigate to the settings page.");
      expect(result.isFinancial).toBe(false);
      expect(result.matchedTokens).toEqual([]);
    });

    it("does NOT flag shell positional params `$1` and `$2`", () => {
      const result = classifyFinancialDraft(
        "Run the script with $1 and $2 as args.",
      );
      expect(result.isFinancial).toBe(false);
      expect(result.matchedTokens).toEqual([]);
    });

    it("corroboration boundary — a bare `rate` with NO other signal does not flag", () => {
      const result = classifyFinancialDraft(
        "Please rate this experience when done.",
      );
      expect(result.isFinancial).toBe(false);
      expect(result.matchedTokens).toEqual([]);
    });
  });

  describe("structure of the verdict", () => {
    it("returns matchedTokens === [] for every negative case and non-empty for every positive case", () => {
      const positive: FinancialClassification = classifyFinancialDraft(
        "The yield is 5.25%.",
      );
      expect(positive.matchedTokens.length).toBeGreaterThan(0);

      const negative: FinancialClassification = classifyFinancialDraft(
        "Nothing financial here at all.",
      );
      expect(negative.matchedTokens).toEqual([]);
    });

    it("caps matchedTokens at MAX_MATCHED_TOKENS even for a response stuffed with many distinct percentage tokens", () => {
      // Build a response with 100 DISTINCT percentage substrings so the cap
      // (not dedup) is what bounds the list.
      const stuffed = Array.from({ length: 100 }, (_, i) => `${i + 1}%`).join(" ");
      const result = classifyFinancialDraft(stuffed);
      expect(result.isFinancial).toBe(true);
      expect(result.matchedTokens.length).toBeLessThanOrEqual(MAX_MATCHED_TOKENS);
    });

    it("exposes MAX_MATCHED_TOKENS as a positive integer constant", () => {
      expect(Number.isInteger(MAX_MATCHED_TOKENS)).toBe(true);
      expect(MAX_MATCHED_TOKENS).toBeGreaterThan(0);
    });

    it("is deterministic — same input yields the same verdict", () => {
      const input = "The bond_yield is 4.25 % and AUM is $1.5M.";
      const a = classifyFinancialDraft(input);
      const b = classifyFinancialDraft(input);
      expect(a).toEqual(b);
    });
  });

  describe("canonical static-grep pin (regression — source must keep the keyword set + token regexes)", () => {
    const source = readFileSync(
      new URL("../financial-classifier.ts", import.meta.url),
      "utf8",
    );

    it("source pins every canonical finance keyword literal", () => {
      for (const keyword of [
        "yield",
        "rate",
        "AUM",
        "NAV",
        "basis points",
        "bps",
        "coupon",
        "dividend",
      ]) {
        expect(source).toContain(keyword);
      }
    });

    it("source pins the currency `$` regex token literal", () => {
      expect(source).toContain("\\$");
    });

    it("source pins the percentage `%` regex token literal", () => {
      expect(source).toContain("%");
    });

    it("source pins the ticker `[A-Z]{2,5}` regex token literal", () => {
      expect(source).toContain("[A-Z]{2,5}");
    });

    it("source defines and exports classifyFinancialDraft", () => {
      expect(source).toContain("classifyFinancialDraft");
      expect(source).toMatch(/export function classifyFinancialDraft/);
    });
  });
});

describe("2026-08-27 precision — lone percentage is not a figure", () => {
  it("a single percentage in prose with no other finance signal does NOT fire", () => {
    expect(classifyFinancialDraft("I am 100% sure the file landed.").isFinancial).toBe(false);
    expect(classifyFinancialDraft("Coverage is at 87% after the refactor.").isFinancial).toBe(false);
  });
  it("two distinct percentages still fire (allocation shape)", () => {
    expect(classifyFinancialDraft("46% equities, 38% bonds.").isFinancial).toBe(true);
  });
  it("one percentage corroborated by currency, keyword, or rate still fires", () => {
    expect(classifyFinancialDraft("87% of the $1.4M is in bonds.").isFinancial).toBe(true);
    expect(classifyFinancialDraft("The fund's yield is 4.2%.").isFinancial).toBe(true);
    expect(classifyFinancialDraft("A participation rate of 100%.").isFinancial).toBe(true);
  });
  it("two-letter uppercase tokens are no longer reported as tickers", () => {
    const r = classifyFinancialDraft("$1,200 to CA HQ for AAPL shares.");
    expect(r.matchedTokens).toContain("AAPL");
    expect(r.matchedTokens).not.toContain("CA");
    expect(r.matchedTokens).not.toContain("HQ");
  });
});
