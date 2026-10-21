/**
 * 999.63d/5 — inbound-prompt financial-topic gate.
 *
 * The gate decides whether the live activity trail renders. Recall
 * matters more than precision (a spurious trail is cosmetic noise; a
 * missing one is a silent turn), so the negative cases here are the
 * ones that must genuinely never arm it: machine-generated preambles
 * and ordinary chatter.
 */
import { describe, expect, it } from "vitest";

import {
  isTopicPrompt,
  TOPIC_SCAN_MAX_CHARS,
} from "../topic-prompt.js";

describe("isTopicPrompt", () => {
  it("arms on rule/eligibility questions that carry NO figures", () => {
    // The incident's shape: the load-bearing claim is an eligibility
    // rule, and the ASKER states no dollar amount.
    expect(isTopicPrompt("is he eligible to roll over yet?")).toBe(true);
    expect(isTopicPrompt("what's the 401(k) situation for them?")).toBe(
      true,
    );
    expect(isTopicPrompt("does the step-up apply here")).toBe(true);
    expect(isTopicPrompt("when does his RMD start")).toBe(true);
    expect(isTopicPrompt("compare the annuity against the index")).toBe(
      true,
    );
  });

  it("arms on figure shapes", () => {
    expect(isTopicPrompt("can they afford $1.48M in retirement?")).toBe(
      true,
    );
    expect(isTopicPrompt("is 87% equity too aggressive")).toBe(true);
  });

  it("does NOT arm on ordinary chatter", () => {
    expect(isTopicPrompt("can you resend that doc?")).toBe(false);
    expect(isTopicPrompt("thanks, looks good")).toBe(false);
    expect(isTopicPrompt("what did you do this morning")).toBe(false);
  });

  it("does NOT arm on machine-generated preambles (steer over-fire class)", () => {
    // These fired the financial steer 4x on 2026-08-26; the hot
    // `system-prompt-suppressor` trigger is mirrored here.
    expect(
      isTopicPrompt("## Session Continuity\nresuming 401(k) work"),
    ).toBe(false);
    expect(
      isTopicPrompt("# Context Health Monitor\nIRA tokens: 4"),
    ).toBe(false);
    expect(isTopicPrompt("  ## Session Continuity\n$1.5M")).toBe(false);
  });

  it("strips the Route O output-style block before matching", () => {
    // Route O prepends this to user messages; style text must neither
    // supply nor mask topic vocabulary.
    expect(
      isTopicPrompt("<output-style>brief: rate the answer</output-style>hi"),
    ).toBe(false);
    expect(
      isTopicPrompt(
        "<output-style>brief</output-style>what about his Roth?",
      ),
    ).toBe(true);
  });

  it("keeps acronyms case-sensitive so given names do not match", () => {
    // The AUM/NAV precedent: `IRA` is an account, `Ira` is a person.
    expect(isTopicPrompt("did Ira call back?")).toBe(false);
    expect(isTopicPrompt("did the IRA transfer land?")).toBe(true);
  });

  it("pins the recall-favouring matches so they are visible, not accidental", () => {
    // "rate" (FINANCE_KEYWORDS) and "trust" (RULE_DOMAIN_TERMS) are
    // generic enough to fire on ordinary chatter. That is ACCEPTED: the
    // vocabulary is single-sourced from the two verification classifiers
    // precisely so it cannot drift from them, and the cost of a false
    // positive here is one cosmetic trail on a turn that was already
    // making tool calls. Pinned so the tradeoff stays deliberate.
    expect(isTopicPrompt("what's the rate on that")).toBe(true);
    expect(isTopicPrompt("I trust your read on this")).toBe(true);
    // The quiet-turn arm means the reverse case is covered too: a
    // vocabulary miss still paints once the turn proves it is working.
  });

  it("is total on hostile / non-string input", () => {
    expect(isTopicPrompt(undefined)).toBe(false);
    expect(isTopicPrompt(null)).toBe(false);
    expect(isTopicPrompt(42)).toBe(false);
    expect(isTopicPrompt("")).toBe(false);
    expect(isTopicPrompt({})).toBe(false);
  });

  it("bounds the scan against a pathological paste", () => {
    const prompt = "x".repeat(TOPIC_SCAN_MAX_CHARS + 5000) + " 401(k)";
    const started = process.hrtime.bigint();
    // Past the scan window, so the trailing term is not seen.
    expect(isTopicPrompt(prompt)).toBe(false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(250);
  });
});
