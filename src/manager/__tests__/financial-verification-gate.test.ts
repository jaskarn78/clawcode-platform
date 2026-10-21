/**
 * Phase 999.63 Plan 03 T-01 — decision-core tests for the financial-
 * verification gate.
 *
 * `evaluateVerification` is a pure function: given a draft
 * response, the tool-call names observed this turn, and the verify-hop
 * count, it returns a structured verdict. These tests pin the full
 * decision matrix (CONTEXT.md D2/D3/D4) — no mocks, no I/O.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  evaluateVerification,
  VERIFICATION_TOOL_SUBSTRINGS,
  figuresVerbatimInToolResults,
  MAX_VERIFY_HOPS,
  CORRECTIVE_PROMPT,
  CORRECTION_PREFIX,
  NO_CORRECTION_NEEDED,
} from "../financial-verification-gate.js";

describe("evaluateVerification — decision matrix", () => {
  it("non-financial draft + no tools + hop 0 → not flagged, action none", () => {
    const result = evaluateVerification({
      response: "I rebooted the server and the deploy is green.",
      toolCallNames: [],
      verifyHopCount: 0,
    });
    expect(result.flagged).toBe(false);
    expect(result.action).toBe("none");
    expect(result.financialTokensDetected).toEqual([]);
    expect(result.verificationToolsCalled).toEqual([]);
  });

  it("financial draft + verification tool called + hop 0 → not flagged, action none", () => {
    const result = evaluateVerification({
      response: "The current 10-year yield is 4.25%.",
      toolCallNames: ["mcp__finnhub__stock_quote"],
      verifyHopCount: 0,
    });
    expect(result.flagged).toBe(false);
    expect(result.action).toBe("none");
    expect(result.verificationToolsCalled.length).toBeGreaterThan(0);
    expect(result.verificationToolsCalled).toContain("mcp__finnhub__stock_quote");
  });

  it("financial draft + non-verification tool only + hop 0 → flagged, action re-prompt", () => {
    const result = evaluateVerification({
      response: "The fund AUM grew to $1.5B this quarter.",
      toolCallNames: ["mcp__discord__send"],
      verifyHopCount: 0,
    });
    expect(result.flagged).toBe(true);
    expect(result.action).toBe("re-prompt");
    expect(result.verificationToolsCalled).toEqual([]);
    expect(result.financialTokensDetected.length).toBeGreaterThan(0);
  });

  it("financial draft + NO tools + hop 0 → flagged, action re-prompt", () => {
    const result = evaluateVerification({
      response: "Treasuries are paying a 5% coupon right now.",
      toolCallNames: [],
      verifyHopCount: 0,
    });
    expect(result.flagged).toBe(true);
    expect(result.action).toBe("re-prompt");
  });

  it("financial draft + no verification + hop 1 (>= MAX) → not flagged, action hop-exhausted", () => {
    const result = evaluateVerification({
      response: "The dividend yield is 3.1%.",
      toolCallNames: [],
      verifyHopCount: 1,
    });
    expect(result.flagged).toBe(false);
    expect(result.action).toBe("hop-exhausted");
    // financialTokensDetected still reported so telemetry on the corrective
    // turn shows WHAT figures shipped unverified.
    expect(result.financialTokensDetected.length).toBeGreaterThan(0);
  });

  it("web_search substring matches mcp__search__web_search → counted as verification", () => {
    const result = evaluateVerification({
      response: "Inflation is running at 3.4% per the latest print.",
      toolCallNames: ["mcp__search__web_search"],
      verifyHopCount: 0,
    });
    expect(result.flagged).toBe(false);
    expect(result.action).toBe("none");
    expect(result.verificationToolsCalled).toContain("mcp__search__web_search");
  });

  it("bond_yield substring matches mcp__finnhub__bond_yield → counted as verification", () => {
    const result = evaluateVerification({
      response: "The 2-year is at 4.8%.",
      toolCallNames: ["mcp__finnhub__bond_yield"],
      verifyHopCount: 0,
    });
    expect(result.flagged).toBe(false);
    expect(result.action).toBe("none");
    expect(result.verificationToolsCalled).toContain("mcp__finnhub__bond_yield");
  });

  it("any mcp__finnhub__* tool counts as verification (finnhub substring)", () => {
    const result = evaluateVerification({
      response: "AAPL is up — trading near $200.",
      toolCallNames: ["mcp__finnhub__quote"],
      verifyHopCount: 0,
    });
    expect(result.flagged).toBe(false);
    expect(result.verificationToolsCalled).toContain("mcp__finnhub__quote");
  });

  it("verification tool present alongside non-verification tools → still not flagged", () => {
    const result = evaluateVerification({
      response: "The price is $432.10.",
      toolCallNames: ["mcp__discord__send", "mcp__search__web_search", "Read"],
      verifyHopCount: 0,
    });
    expect(result.flagged).toBe(false);
    expect(result.action).toBe("none");
    expect(result.verificationToolsCalled).toEqual(["mcp__search__web_search"]);
  });

  it("empty / non-string response → not flagged, action none", () => {
    const result = evaluateVerification({
      response: "",
      toolCallNames: [],
      verifyHopCount: 0,
    });
    expect(result.flagged).toBe(false);
    expect(result.action).toBe("none");
  });

  it("hop count above MAX still resolves to hop-exhausted, never re-prompt", () => {
    const result = evaluateVerification({
      // 2026-08-27 — fixture needs a corroborated figure now that a lone
      // percentage is not a signal; `rate` + one percentage still fires.
      response: "The rate climbed to 6%.",
      toolCallNames: [],
      verifyHopCount: 5,
    });
    expect(result.action).toBe("hop-exhausted");
    expect(result.flagged).toBe(false);
  });
});

describe("financial-verification-gate constants — canonical pins", () => {
  it("MAX_VERIFY_HOPS is 1 (single-hop loop bound, CONTEXT.md D4)", () => {
    expect(MAX_VERIFY_HOPS).toBe(1);
  });

  it("VERIFICATION_TOOL_SUBSTRINGS contains the pinned whitelist entries", () => {
    expect(VERIFICATION_TOOL_SUBSTRINGS).toContain("finnhub");
    expect(VERIFICATION_TOOL_SUBSTRINGS).toContain("stock_quote");
    expect(VERIFICATION_TOOL_SUBSTRINGS).toContain("bond_yield");
    expect(VERIFICATION_TOOL_SUBSTRINGS).toContain("web_search");
  });

  it("CORRECTIVE_PROMPT instructs the agent to verify figures", () => {
    expect(CORRECTIVE_PROMPT.length).toBeGreaterThan(0);
    expect(CORRECTIVE_PROMPT.toLowerCase()).toContain("verif");
  });

  it("CORRECTION_PREFIX is the labelled correction marker", () => {
    expect(CORRECTION_PREFIX).toContain("Correction");
  });

  it("NO_CORRECTION_NEEDED is an exported, non-empty sentinel string", () => {
    expect(typeof NO_CORRECTION_NEEDED).toBe("string");
    expect(NO_CORRECTION_NEEDED.length).toBeGreaterThan(0);
    expect(NO_CORRECTION_NEEDED).toBe("NO_CORRECTION_NEEDED");
  });

  it("CORRECTIVE_PROMPT exposes the NO_CORRECTION_NEEDED false-positive escape hatch", () => {
    expect(CORRECTIVE_PROMPT).toContain(NO_CORRECTION_NEEDED);
  });

  it("STATIC-GREP: the source file pins VERIFICATION_TOOL_SUBSTRINGS entries so the whitelist cannot be silently emptied", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(here, "..", "financial-verification-gate.ts"),
      "utf8",
    );
    expect(src).toContain("VERIFICATION_TOOL_SUBSTRINGS");
    expect(src).toContain('"finnhub"');
    expect(src).toContain('"stock_quote"');
    expect(src).toContain('"bond_yield"');
    expect(src).toContain('"web_search"');
  });
});

describe("2026-08-27 precision — client records count as verification", () => {
  it("CRM / document-ingest tools satisfy the figures-class tool check", () => {
    for (const name of [
      "mcp__acme-db__mysql_query",
      "mcp__clawcode__ingest_document",
    ]) {
      expect(VERIFICATION_TOOL_SUBSTRINGS.some((s) => name.toLowerCase().includes(s))).toBe(true);
    }
  });
  it("generic Read / Bash still do NOT", () => {
    for (const name of ["Read", "Bash", "Grep"]) {
      expect(VERIFICATION_TOOL_SUBSTRINGS.some((s) => name.toLowerCase().includes(s))).toBe(false);
    }
  });
});

describe("2026-08-27 — figures-class provenance via tool-result text", () => {
  const draft = "Net worth is $1,977,109 with 84% in bonds.";
  it("every figure verbatim in tool results → verified, no re-prompt", () => {
    const r = evaluateVerification({
      response: draft,
      toolCallNames: ["Read"],
      verifyHopCount: 0,
      toolResultText: "Statement 2026-04-30\nTotal $1,977,109\nBond allocation 84% of holdings",
    });
    expect(r.action).toBe("none");
    expect(r.flagged).toBe(false);
    expect(r.figureProvenance).toBe("tool-results");
  });
  it("one figure missing from tool results → still re-prompts", () => {
    const r = evaluateVerification({
      response: draft,
      toolCallNames: ["Read"],
      verifyHopCount: 0,
      toolResultText: "Total $1,977,109",
    });
    expect(r.action).toBe("re-prompt");
    expect(r.figureProvenance).toBeUndefined();
  });
  it("no tool text / no figure tokens never widens the verified set", () => {
    expect(figuresVerbatimInToolResults(["$5"], undefined)).toBe(false);
    expect(figuresVerbatimInToolResults(["yield"], "yield 4%")).toBe(false);
    expect(figuresVerbatimInToolResults([], "anything")).toBe(false);
  });
  it("whitespace is collapsed on both sides; nothing else is normalised", () => {
    expect(figuresVerbatimInToolResults(["$ 1,200"], "paid $\n1,200 today")).toBe(true);
    expect(figuresVerbatimInToolResults(["$1.5M"], "1,500,000")).toBe(false);
  });
});
