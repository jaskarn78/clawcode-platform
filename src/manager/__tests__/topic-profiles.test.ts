/**
 * 999.63d/6 — per-agent topic profiles.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOPIC_PROFILE,
  MAX_EXTRA_TERMS,
  MAX_TERM_CHARS,
  isTopicProfileName,
  resolveTopicProfile,
} from "../topic-profiles.js";
import { isTopicPrompt } from "../topic-prompt.js";

const finance = resolveTopicProfile("finance");
const legal = resolveTopicProfile("legal");
const none = resolveTopicProfile("none");

describe("topic profiles", () => {
  it("different agents get different topics from the same prompt", () => {
    const money = "can he roll over the 401(k) yet?";
    const contract = "does the MSA have a cure period before termination?";

    expect(isTopicPrompt(money, finance)).toBe(true);
    expect(isTopicPrompt(money, legal)).toBe(false);

    expect(isTopicPrompt(contract, legal)).toBe(true);
    expect(isTopicPrompt(contract, finance)).toBe(false);
  });

  it("'none' never arms on topic — the trail falls to the quiet path only", () => {
    expect(isTopicPrompt("can he roll over the 401(k)? $1.4M at 87%", none)).toBe(
      false,
    );
  });

  it("numericShapes is per-profile: a dollar figure is not a legal question", () => {
    expect(isTopicPrompt("is $1.48M enough", finance)).toBe(true);
    expect(isTopicPrompt("is $1.48M enough", legal)).toBe(false);
  });

  it("extraTerms widen a profile without displacing the built-ins", () => {
    const p = resolveTopicProfile("finance", ["suitability review"]);
    expect(isTopicPrompt("start the suitability review", p)).toBe(true);
    // built-ins survive
    expect(isTopicPrompt("what about his Roth?", p)).toBe(true);
    // and the unwidened profile is unaffected (frozen base, new object)
    expect(isTopicPrompt("start the suitability review", finance)).toBe(false);
  });

  it("an ALL-CAPS extra term joins the case-sensitive acronym set", () => {
    // Same rule the built-ins use for IRA vs the given name "Ira".
    const p = resolveTopicProfile("finance", ["ACAT2"]);
    expect(isTopicPrompt("did the ACAT2 clear?", p)).toBe(true);
    expect(isTopicPrompt("acat2 lowercase should not match", p)).toBe(false);
  });

  it("caps operator-supplied terms in count and length", () => {
    const many = Array.from({ length: MAX_EXTRA_TERMS + 25 }, (_, i) => `zzterm${i}`);
    const p = resolveTopicProfile("finance", many);
    expect(p.terms.length + p.acronyms.length).toBeLessThanOrEqual(
      finance.terms.length + finance.acronyms.length + MAX_EXTRA_TERMS,
    );
    const long = "y".repeat(MAX_TERM_CHARS + 100);
    const p2 = resolveTopicProfile("finance", [long]);
    for (const t of p2.terms) expect(t.length).toBeLessThanOrEqual(MAX_TERM_CHARS);
  });

  it("regex metacharacters in an extra term are literal, not a pattern", () => {
    const p = resolveTopicProfile("finance", ["a.*b"]);
    expect(isTopicPrompt("a.*b", p)).toBe(true);
    // would match everything if the term were compiled as a pattern
    expect(isTopicPrompt("axxxb", p)).toBe(false);
  });

  it("an unknown profile name falls back rather than throwing", () => {
    // Cosmetic display decision — a config typo must not take a turn down.
    expect(resolveTopicProfile("nonsense").name).toBe(DEFAULT_TOPIC_PROFILE);
    expect(resolveTopicProfile(undefined).name).toBe(DEFAULT_TOPIC_PROFILE);
    expect(isTopicProfileName("finance")).toBe(true);
    expect(isTopicProfileName("nonsense")).toBe(false);
  });

  it("the default profile keeps the pre-profile behaviour", () => {
    // isTopicPrompt with no profile arg must still be the finance gate.
    expect(isTopicPrompt("when does his RMD start")).toBe(true);
    expect(isTopicPrompt("can you resend that doc?")).toBe(false);
  });

  it("hostile extra terms cannot break resolution", () => {
    const p = resolveTopicProfile("finance", [
      "", "   ", 42 as unknown as string, null as unknown as string,
    ]);
    expect(p.terms.length).toBe(finance.terms.length);
  });
});
