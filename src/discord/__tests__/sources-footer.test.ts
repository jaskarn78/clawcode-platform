/** Daemon-authored Sources line + verdict marks — format stability and degradation. */
import { describe, expect, it } from "vitest";
import { formatOutboundText } from "../markdown-table-wrap.js";
import { evidenceFromToolResult, evidenceFromToolUse, type EvidenceEntry } from "../../manager/evidence-ledger.js";
import { validateClaim, type ClaimEntry } from "../../manager/claim-ledger.js";
import {
  buildSourcesLine,
  composeDeliveryAnnotations,
  decideTier,
  decideVerdictMarks,
  maskedLink,
  sanitizeLabel,
  selectSources,
  stripModelSourcesBlock,
  stripVerificationSubtext,
  SUBTEXT_BLOCK,
  collapseQueriedByHost,
  buildVerificationLine,
} from "../sources-footer.js";
import { stripDivertedNarration } from "../hold-status.js";
import { icons } from "../icons.js";
import { afterEach } from "vitest";

describe("999.178 R1 — verdict lines render the warning glyph through cc_*", () => {
  const bad = { id: "c", turnId: "t", claim: "claim", verdict: "verified", effectiveVerdict: "unverified", sourceStatus: "not-consulted", sourceHost: "example.com", quoteStatus: "absent", origin: "tool", at: 1, ledgerBacked: true } as never;
  afterEach(() => icons.clear());

  it("leads the line with cc_warning when the set is loaded, and never a Unicode glyph", () => {
    icons.setAll([{ id: "77", name: "cc_warning" }]);
    const m = decideVerdictMarks({ claims: [bad], unmatchedHosts: [], correctionsApplied: 0, holdTimedOut: false, evidenceCount: 4 });
    expect(m.lines[0]).toBe("<:cc_warning:77> 1 claim unverified · react 🔍 to re-check");
    expect(m.lines[0]).not.toContain("⚠️");
    // The reaction TOKEN stays "⚠️" — it drives logic and is mapped to a
    // cc_* reaction only where the bridge calls react.
    expect(m.reaction).toBe("⚠️");
  });

  it("the FOOTER_HEAD regex strips a migrated warning line off the end", () => {
    icons.setAll([{ id: "77", name: "cc_warning" }]);
    const line = decideVerdictMarks({ claims: [bad], unmatchedHosts: [], correctionsApplied: 0, holdTimedOut: false, evidenceCount: 4 }).lines[0];
    const body = "Answer body.";
    const withFooter = `${body}${SUBTEXT_BLOCK}${line}`;
    expect(stripVerificationSubtext(withFooter)).toBe(body);
  });
});

const AT = 1;
const evidence: EvidenceEntry[] = [
  ...evidenceFromToolUse("WebFetch", "1", { url: "https://www.irs.gov/retirement-plans/rmd-faqs" }, AT),
  ...evidenceFromToolUse("mcp__clawcode__ingest_document", "2", { file_path: "/x/statement-2026-04-30.pdf" }, AT),
  ...evidenceFromToolUse("mcp__acme-db__mysql_query", "3", { sql: "select 1 from client_accounts" }, AT),
  ...evidenceFromToolResult("WebSearch", "4", 'Links: [{"title":"Retirement age","url":"https://www.ssa.gov/retire"},{"title":"junk","url":"https://junk.example/x"}]', AT),
];
function claim(over: Partial<Parameters<typeof validateClaim>[0]> & { claim: string }): ClaimEntry {
  return { ...validateClaim({ verdict: "verified", ...over }, evidence, ""), id: "c", turnId: "t", at: AT };
}

describe("selectSources", () => {
  it("opened first, then only search hits a claim rests on; unopened junk excluded", () => {
    const claims = [claim({ claim: "FRA 67", source: "https://ssa.gov/retire" })];
    const items = selectSources(evidence, claims);
    expect(items.map((i) => i.label)).toEqual([
      "irs.gov › rmd faqs",
      "statement-2026-04-30.pdf (2026-04-30)",
      "CRM › client_accounts",
      "ssa.gov › Retirement age",
    ]);
    expect(items.some((i) => i.host === "junk.example")).toBe(false);
  });
});

describe("buildSourcesLine — format stability", () => {
  const items = selectSources(evidence, [claim({ claim: "x", source: "https://ssa.gov/retire" })]);
  it("full line has ≤3 masked links, is unchanged by formatOutboundText, and has no em/en dash or pipe", () => {
    const line = buildSourcesLine(items);
    expect(line.startsWith("Sources: ")).toBe(true);
    expect((line.match(/\]\(</g) ?? []).length).toBeLessThanOrEqual(3);
    expect(formatOutboundText(line)).toBe(line);
    expect(line).not.toMatch(/[—–|`]/);
  });
  it("compact variant: one link, verdict glyph in front", () => {
    const line = buildSourcesLine(items, { compact: true, compactVerified: true });
    expect(line.startsWith("✓ verified · ")).toBe(true);
    expect((line.match(/\]\(</g) ?? []).length).toBeLessThanOrEqual(1);
    expect(line.length).toBeLessThanOrEqual(200);
  });
  it("degrades links → labels → per-host collapse under a tight budget, never exceeding it", () => {
    const many: EvidenceEntry[] = Array.from({ length: 8 }, (_, i) => evidenceFromToolUse("WebFetch", `f${i}`, { url: `https://www.irs.gov/page-${i}` }, AT)[0]!);
    const line = buildSourcesLine(selectSources(many, []), { budget: 60 });
    expect(line.length).toBeLessThanOrEqual(60);
    expect(line).not.toContain("](<");
  });
  it("masked links percent-encode breakers and suppress embeds", () => {
    const l = maskedLink("a", "https://x.com/a)b c|d>e");
    expect(l).toBe("[a](<https://x.com/a%29b%20c%7Cd%3Ee>)");
  });
  it("sanitizeLabel keeps underscores and strips mention/markdown breakers", () => {
    expect(sanitizeLabel("@everyone `client_accounts` *x* [y]")).toBe("everyone client_accounts x y");
  });
});

describe("decideTier / decideVerdictMarks", () => {
  it("tiers", () => {
    expect(decideTier({ responseChars: 100, claimCount: 0, evidenceCount: 0, clientFacing: false })).toBe("none");
    expect(decideTier({ responseChars: 100, claimCount: 1, evidenceCount: 1, clientFacing: false })).toBe("compact");
    expect(decideTier({ responseChars: 900, claimCount: 3, evidenceCount: 2, clientFacing: false })).toBe("full");
    expect(decideTier({ responseChars: 900, claimCount: 3, evidenceCount: 2, clientFacing: true })).toBe("client-facing");
  });
  it("precedence ⚠️ > ✏️ > ✅ > none, with actionable lines", () => {
    const ok = [claim({ claim: "RMD 73", source: "https://irs.gov/retirement-plans/rmd-faqs" })];
    expect(decideVerdictMarks({ claims: ok, unmatchedHosts: [], correctionsApplied: 0, holdTimedOut: false, evidenceCount: 4 })).toEqual({ reaction: "✅", lines: [], note: "" });
    const bad = [claim({ claim: "5-year clock", source: "https://example.com/z" })];
    const m = decideVerdictMarks({ claims: bad, unmatchedHosts: ["dol.gov"], correctionsApplied: 0, holdTimedOut: false, evidenceCount: 4 });
    expect(m.reaction).toBe("⚠️");
    // 2026-08-27 — one compact line with a count; the 🧾 card carries the per-claim detail.
    // 999.178 R1 — the warning glyph now renders through the registry, so with
    // no set loaded the line carries the words only (never a Unicode ⚠️).
    expect(m.lines).toEqual(["1 claim unverified · react 🔍 to re-check"]);
    // 999.151 — the same exception in plain words for the merged line: no
    // glyph (the ⚠️ REACTION carries the alarm) and no "react X to Y".
    expect(m.note).toBe("1 claim unverified");
    // Unverified claims outrank unopened hosts in the single-line policy; the
    // host warning surfaces on its own when no claim is unverified.
    const hostOnly = decideVerdictMarks({ claims: ok, unmatchedHosts: ["dol.gov"], correctionsApplied: 0, holdTimedOut: false, evidenceCount: 4 });
    expect(hostOnly.lines).toEqual(["cited, not opened: dol.gov"]);
    expect(hostOnly.note).toBe("Cited, not opened: dol.gov");
    expect(decideVerdictMarks({ claims: ok, unmatchedHosts: [], correctionsApplied: 1, holdTimedOut: false, evidenceCount: 4 }).reaction).toBe("✏️");
    expect(decideVerdictMarks({ claims: [], unmatchedHosts: [], correctionsApplied: 0, holdTimedOut: false, evidenceCount: 0 }).reaction).toBeNull();
    expect(decideVerdictMarks({ claims: ok, unmatchedHosts: [], correctionsApplied: 0, holdTimedOut: true, evidenceCount: 4 }).lines[0]).toContain("still verifying");
  });
});

describe("stripModelSourcesBlock", () => {
  it("strips a trailing Sources block and returns the hosts it named", () => {
    const r = stripModelSourcesBlock("Answer line.\n\nMore.\n\nSources:\n- https://www.irs.gov/x\n- ssa.gov");
    expect(r.text).toBe("Answer line.\n\nMore.");
    expect(r.citedHosts.sort()).toEqual(["irs.gov", "ssa.gov"]);
  });
  it("leaves a mid-body heading and inline citations alone", () => {
    const body = "Sources: intro\n" + "x\n".repeat(20) + "Per irs.gov the limit is $24,500.";
    expect(stripModelSourcesBlock(body).text).toBe(body);
  });
});

describe("composeDeliveryAnnotations", () => {
  const items = selectSources(evidence, []);
  it("appends verdict lines above the Sources line, newline-led", () => {
    const r = composeDeliveryAnnotations({ response: "Body.", tier: "full", sources: items, marks: { reaction: "⚠️", lines: ["⚠️ cited but never opened: dol.gov"], note: "Cited, not opened: dol.gov" } });
    expect(r.footer).toBe("appended");
    expect(r.deliveryText.startsWith("Body." + SUBTEXT_BLOCK + "⚠️")).toBe(true);
    expect(r.deliveryText.split("\n").pop()!.startsWith("-# Sources: ")).toBe(true);
    expect(formatOutboundText(r.deliveryText)).toBe(r.deliveryText);
  });
  it("never pushes a ≤2000 reply over 2000 — compact, then omit", () => {
    const body = "x".repeat(1990);
    const r = composeDeliveryAnnotations({ response: body, tier: "full", sources: items, marks: { reaction: "✅", lines: [], note: "" } });
    expect(r.footer).toBe("omitted-oversize");
    expect(r.deliveryText).toBe(body);
    const r2 = composeDeliveryAnnotations({ response: "x".repeat(1700), tier: "full", sources: items, marks: { reaction: "✅", lines: [], note: "" } });
    expect(r2.deliveryText.length).toBeLessThanOrEqual(2000);
    expect(["appended", "compact"]).toContain(r2.footer);
  });
  it("tier none → untouched", () => {
    expect(composeDeliveryAnnotations({ response: "hi", tier: "none", sources: [], marks: { reaction: null, lines: [], note: "" } }).deliveryText).toBe("hi");
  });
  it("stripVerificationSubtext is idempotent and only strips the trailing block", () => {
    const r = composeDeliveryAnnotations({ response: "Body.", tier: "full", sources: items, marks: { reaction: "✅", lines: [], note: "" } });
    expect(stripVerificationSubtext(r.deliveryText)).toBe("Body.");
    expect(stripVerificationSubtext("Body.")).toBe("Body.");
  });
});

describe("2026-08-27 operator fixes", () => {
  it("sanitizeLabel clips at a word boundary, not mid-word", () => {
    expect(sanitizeLabel("retirement plan and ira required minimum distributions faqs", 28))
      .toBe("retirement plan and ira");
    expect(sanitizeLabel("retirement plan and ira requ", 28)).toBe("retirement plan and ira requ"); // fits
    expect(sanitizeLabel("supercalifragilisticexpialidocious", 12)).toBe("supercalifra"); // one long word
    expect(sanitizeLabel("", 28)).toBe("");
  });

  it("stripDivertedNarration is exact-prefix only — a mismatch never truncates", () => {
    const answer = "same growth list as before minus the three most speculative.";
    const narration = "Reviewing her holdings first.";
    expect(stripDivertedNarration(`${narration} ${answer}`, narration)).toBe(answer);
    // The delivered string differs from the editor buffer (em-dash rewrite,
    // model-Sources stripping): leave it ALONE rather than slice by length.
    expect(stripDivertedNarration(answer, narration)).toBe(answer);
    expect(stripDivertedNarration(answer, "")).toBe(answer);
    // The shipped bug: a length-based slice would have returned "ame growth…".
    expect(stripDivertedNarration(answer, "x".repeat(1))).not.toMatch(/^ame /);
  });
});

describe("2026-08-27 sweep — ladder + tier", () => {
  it("three long IRS URLs keep at least one tappable link (never all-plain)", () => {
    const urls = [
      "https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-401k-and-profit-sharing-plan-contribution-limits",
      "https://www.irs.gov/retirement-plans/retirement-plan-and-ira-required-minimum-distributions-faqs",
      "https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500",
    ];
    const evidence = urls.flatMap((u, i) => evidenceFromToolUse("WebFetch", `t${i}`, { url: u }, 1));
    const line = buildSourcesLine(selectSources(evidence, [], []), {});
    expect(line).toContain("](<https://");
    expect(line.length).toBeLessThanOrEqual(480);
  });
  it("decideTier: a long sourced answer is full even with ≤1 claim; compact needs short AND little evidence", () => {
    expect(decideTier({ responseChars: 1900, claimCount: 0, evidenceCount: 19, clientFacing: false })).toBe("full");
    expect(decideTier({ responseChars: 1900, claimCount: 1, evidenceCount: 3, clientFacing: false })).toBe("full");
    expect(decideTier({ responseChars: 120, claimCount: 1, evidenceCount: 1, clientFacing: false })).toBe("compact");
    expect(decideTier({ responseChars: 120, claimCount: 0, evidenceCount: 6, clientFacing: false })).toBe("full");
    expect(decideTier({ responseChars: 120, claimCount: 0, evidenceCount: 0, clientFacing: false })).toBe("none");
  });
});

describe("2026-08-27 — verdict marks are one line at most", () => {
  const base = { correctionsApplied: 0, holdTimedOut: false, evidenceCount: 3 };
  const unv = (id: string) => ({ id, turnId: "t", claim: `claim ${id}`, verdict: "verified", effectiveVerdict: "unverified", sourceStatus: "not-consulted", sourceHost: "example.com", quoteStatus: "absent", origin: "tool", at: 1, ledgerBacked: true }) as never;
  it("collapses three unverified claims and two unopened hosts into ONE line with a count", () => {
    const m = decideVerdictMarks({ ...base, claims: [unv("a"), unv("b"), unv("c")], unmatchedHosts: ["x.com", "y.com"] });
    expect(m.reaction).toBe("⚠️");
    expect(m.lines).toHaveLength(1);
    expect(m.lines[0]).toBe("3 claims unverified · react 🔍 to re-check");
  });
  it("cited-but-unopened alone → one line naming up to two hosts", () => {
    const m = decideVerdictMarks({ ...base, claims: [], unmatchedHosts: ["investopedia.com", "nerdwallet.com", "z.com"] });
    expect(m.lines).toEqual(["cited, not opened: investopedia.com, nerdwallet.com +1"]);
  });
  it("timeout wins over everything, still one line", () => {
    const m = decideVerdictMarks({ ...base, holdTimedOut: true, claims: [unv("a")], unmatchedHosts: ["x.com"] });
    expect(m.lines).toEqual(["still verifying · sent before the check finished"]);
  });
});

describe("2026-08-28 — model Sources block anywhere, label tidy, data-API label", () => {
  it("strips a model Sources block that sits ABOVE a draft fence (not trailing)", () => {
    const reply = "SPCX is up 10%.\n\nSources: finnhub SPCX quote, 8/28 · https://www.investing.com/spcx · Sacra https://sacra.com/spacex\n\nBirthday draft, in their voice:\n\n```draft\nHappy birthday Sam!\n```";
    const r = stripModelSourcesBlock(reply);
    expect(r.text).not.toMatch(/^Sources:/m);
    expect(r.text).toContain("```draft\nHappy birthday Sam!\n```"); // fence untouched
    expect(r.citedHosts.sort()).toEqual(["investing.com", "sacra.com"]);
  });
  it("never strips inside a fence, and keeps the LAST block when there are two", () => {
    const reply = "```draft\nSources: none, this is a client note\n```\nSources: https://irs.gov/a\nbody\n\nSources: https://dol.gov/b";
    const r = stripModelSourcesBlock(reply);
    expect(r.text).toContain("Sources: none, this is a client note");
    expect(r.citedHosts).toEqual(["dol.gov"]);
  });
  it("sanitizeLabel never ends on punctuation after a clip", () => {
    expect(sanitizeLabel("SpaceX Stock: IPO Date, Valuation, Ticker, How To Buy Pre-IPO", 28)).toBe("SpaceX Stock: IPO Date");
    expect(sanitizeLabel("ends with colon:", 28)).toBe("ends with colon");
  });
  it("a data-API query renders as host › title, not CRM", () => {
    const ev = evidenceFromToolUse("mcp__finnhub__stock_quote", "t1", { symbol: "spcx" }, 1);
    const items = selectSources(ev, [], []);
    expect(items[0]?.label).toBe("finnhub.io › SPCX stock quote");
  });
});

describe("stripModelSourcesBlock — 2026-08-28 subtext / host-less lines (the 11:01 duplicate)", () => {
  it("strips a `-# Sources:` subtext line even when it names no host", () => {
    const body = "**Answer.**\n\nBody line.\n\n-# Sources: finnhub live quotes 11:01 AM PT, all ten tickers · account value/cash from your screenshot.";
    const r = stripModelSourcesBlock(body);
    expect(r.text).toBe("**Answer.**\n\nBody line.");
    expect(r.citedHosts).toEqual([]);
  });
  it("strips an italic *Sources: …* line and still reports a host when one is named", () => {
    const r = stripModelSourcesBlock("Answer.\n\n*Sources: irs.gov Pub 590-B.*");
    expect(r.text).toBe("Answer.");
    expect(r.citedHosts).toEqual(["irs.gov"]);
  });
  it("keeps a host-less block longer than two lines (prose that happens to start with Sources:)", () => {
    const body = "Sources: several\nfirst thing\nsecond thing\nthird thing\n\nTail.";
    expect(stripModelSourcesBlock(body).text).toBe(body);
  });
});

describe("collapseQueriedByHost — 2026-08-28 (ten finnhub quotes)", () => {
  const quotes = (syms: readonly string[]) =>
    syms.flatMap((sym) => evidenceFromToolUse("mcp__finnhub__stock_quote", `q-${sym}`, { symbol: sym }, 1));
  it("collapses 3+ queried entries on one host into `host › N nouns`", () => {
    const items = selectSources(quotes(["RKLB", "ASTS", "CRWV", "NBIS"]), []);
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("finnhub.io › 4 stock quotes");
    expect(buildSourcesLine(items, {})).toContain("finnhub.io › 4 stock quotes");
  });
  it("999.151 — TWO entries on a host collapse too (the operator's duplicate finnhub row)", () => {
    const items = selectSources(quotes(["RKLB", "ASTS"]), []);
    expect(items.map((i) => i.label)).toEqual(["finnhub.io › 2 stock quotes"]);
  });
  it("999.151 — a shared leading symbol survives the collapse", () => {
    // The operator's screenshot exactly: two finnhub rows for ONE symbol.
    const items = selectSources(
      [
        ...evidenceFromToolUse("mcp__finnhub__stock_quote", "q-SPCX", { symbol: "SPCX" }, 1),
        ...evidenceFromToolUse("mcp__finnhub__stock_candles", "c-SPCX", { symbol: "SPCX" }, 1),
      ],
      [],
    );
    expect(items.map((i) => i.label)).toEqual(["finnhub.io › 2 SPCX lookups"]);
  });
  it("is a no-op for read/document items", () => {
    const items = collapseQueriedByHost([
      { key: "u:1", label: "irs.gov › a", host: "irs.gov", rank: 0 },
      { key: "u:2", label: "irs.gov › b", host: "irs.gov", rank: 0 },
      { key: "u:3", label: "irs.gov › c", host: "irs.gov", rank: 0 },
    ]);
    expect(items).toHaveLength(3);
  });
});

describe("buildVerificationLine — merged footer (2026-08-28)", () => {
  const src = [
    { key: "u:1", label: "irs.gov › RMD FAQs", host: "irs.gov", rank: 0, url: "https://www.irs.gov/x" },
    { key: "g:finnhub.io", label: "finnhub.io › 9 live quotes", host: "finnhub.io", rank: 2, at: 1_700_000_000_000 },
  ];
  it("999.151 — all verified: word head, no glyph, plain labels, readable duration last", () => {
    const line = buildVerificationLine({ counted: 3, verified: 3, steps: 9, secs: 36 }, src, { tier: "full" });
    expect(line).toBe("Verified 3 claims · irs.gov › RMD FAQs · finnhub.io › 9 live quotes · <t:1700000000:t> · 36s");
    expect(line).not.toContain("](<");
    for (const glyph of ["✓", "🔎", "✅", "⚠️"]) expect(line).not.toContain(glyph);
  });
  it("partial / none / no-claims / compact / client-facing heads", () => {
    expect(buildVerificationLine({ counted: 3, verified: 2, steps: 4, secs: 10 }, [], { tier: "full" })).toBe("2 of 3 claims verified · 10s");
    expect(buildVerificationLine({ counted: 2, verified: 0, steps: 4, secs: 10 }, [], { tier: "full" })).toBe("Checked 2 claims · 10s");
    expect(buildVerificationLine({ counted: 0, verified: 0, steps: 4, secs: 10 }, [], { tier: "full" })).toBe("Checked 4 steps · 10s");
    expect(buildVerificationLine({ counted: 1, verified: 1, steps: 1, secs: 9 }, src.slice(0, 1), { tier: "compact" })).toBe("Verified · irs.gov › RMD FAQs · 9s");
    expect(buildVerificationLine({ counted: 4, verified: 4, steps: 2, secs: 5, clientFacing: true }, [], { tier: "client-facing" })).toBe("Verified 4 claims · client-facing · 5s");
  });
  it("999.151 — the exception takes the head, and the advisor rides the same row", () => {
    const line = buildVerificationLine(
      { counted: 1, verified: 0, steps: 7, secs: 296 },
      src.slice(1),
      { tier: "full", note: "1 claim unverified", advisor: "advisor consulted (Opus)" },
    );
    expect(line).toBe("1 claim unverified · finnhub.io › 9 live quotes · <t:1700000000:t> · advisor consulted (Opus) · 4m 56s");
    expect(line).not.toContain("react");
  });
  it("stays within budget by shedding sources before the head", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ key: `u:${i}`, label: `host${i}.gov › some long page title number ${i}`, host: `host${i}.gov`, rank: 0 }));
    const line = buildVerificationLine({ counted: 2, verified: 2, steps: 3, secs: 12 }, many, { tier: "full", budget: 120 });
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.startsWith("Verified 2 claims")).toBe(true);
    expect(line.endsWith("· 12s")).toBe(true);
  });
  it("composeDeliveryAnnotations with verification emits the merged line instead of Sources: and stays format-stable", () => {
    const r = composeDeliveryAnnotations({ response: "Body.", tier: "full", sources: src, marks: { reaction: "✅", lines: [], note: "" }, verification: { counted: 1, verified: 1, steps: 2, secs: 3 } });
    expect(r.deliveryText).toBe("Body.\n\n-# Verified 1 claim · irs.gov › RMD FAQs · finnhub.io › 9 live quotes · <t:1700000000:t> · 3s");
    expect(r.deliveryText).not.toContain("Sources:");
    expect(formatOutboundText(r.deliveryText)).toBe(r.deliveryText);
    expect(stripVerificationSubtext(r.deliveryText)).toBe("Body.");
    const warn = composeDeliveryAnnotations({ response: "Body.", tier: "full", sources: src, marks: { reaction: "⚠️", lines: ["⚠️ 1 claim unverified · react 🔍 to re-check"], note: "1 claim unverified" }, verification: { counted: 2, verified: 1, steps: 2, secs: 3 } });
    // 999.151 — ONE row, not two: the exception is the head of the merged line.
    expect(warn.deliveryText.split("\n").slice(-2)).toEqual(["", "-# 1 claim unverified · irs.gov › RMD FAQs · finnhub.io › 9 live quotes · <t:1700000000:t> · 3s"]);
    expect(warn.deliveryText).not.toContain("react 🔍");
  });
  /**
   * 999.151 — the constant that keeps `stripVerificationSubtext` and
   * `correction-edit`'s matchers from drifting only works if EVERY head the
   * builder can emit is in it. This round-trips all of them: add a head
   * without adding it to FOOTER_HEAD_ALTERNATION and the body comes back
   * dirty here, not in production on a correction edit.
   */
  it("every head buildVerificationLine can emit strips back off cleanly", () => {
    const cases: Array<[string, Parameters<typeof buildVerificationLine>[0], Parameters<typeof buildVerificationLine>[2]]> = [
      ["all verified", { counted: 3, verified: 3, steps: 9, secs: 36 }, { tier: "full" }],
      ["partial", { counted: 3, verified: 2, steps: 4, secs: 10 }, { tier: "full" }],
      ["checked claims", { counted: 2, verified: 0, steps: 4, secs: 10 }, { tier: "full" }],
      ["steps only", { counted: 0, verified: 0, steps: 4, secs: 10 }, { tier: "full" }],
      ["nothing at all", { counted: 0, verified: 0, steps: 0, secs: 0 }, { tier: "full" }],
      ["compact verified", { counted: 1, verified: 1, steps: 1, secs: 9 }, { tier: "compact" }],
      ["compact checked", { counted: 1, verified: 0, steps: 1, secs: 9 }, { tier: "compact" }],
      ["client-facing", { counted: 4, verified: 4, steps: 2, secs: 5, clientFacing: true }, { tier: "client-facing" }],
      ["note: unverified", { counted: 1, verified: 0, steps: 7, secs: 296 }, { tier: "full", note: "1 claim unverified" }],
      ["note: unopened host", { counted: 1, verified: 1, steps: 2, secs: 8 }, { tier: "full", note: "Cited, not opened: dol.gov" }],
      ["note: timed out", { counted: 2, verified: 0, steps: 3, secs: 61 }, { tier: "full", note: "Still verifying · sent before the check finished" }],
      ["note: unsourced", { counted: 2, verified: 0, steps: 1, secs: 4 }, { tier: "full", note: "2 claims without a consulted source" }],
      ["advisor only", { counted: 1, verified: 1, steps: 1, secs: 3 }, { tier: "full", advisor: "advisor consulted (Opus)" }],
    ];
    for (const [label, stats, opts] of cases) {
      const body = "Body." + SUBTEXT_BLOCK + buildVerificationLine(stats, src, opts);
      expect(stripVerificationSubtext(body), label).toBe("Body.");
    }
    // The standalone advisor row and the pending marker strip too.
    expect(stripVerificationSubtext("Body." + SUBTEXT_BLOCK + "Advisor consulted (Opus)")).toBe("Body.");
    expect(stripVerificationSubtext("Body." + SUBTEXT_BLOCK + "Advisor unavailable (max_uses_exceeded)")).toBe("Body.");
    expect(stripVerificationSubtext("Body." + SUBTEXT_BLOCK + "Verifying…")).toBe("Body.");
    expect(stripVerificationSubtext("Body." + SUBTEXT_BLOCK + "Re-checked 4 steps · 9s")).toBe("Body.");
    // Pre-999.151 messages still strip (glyph heads stay in the alternation).
    expect(stripVerificationSubtext("Body." + SUBTEXT_BLOCK + "🔎 checked 4 steps · 9s")).toBe("Body.");
  });

  it("a ≤2000 reply is never pushed over: the merged line degrades to compact, then omits", () => {
    const r = composeDeliveryAnnotations({ response: "x".repeat(1930), tier: "full", sources: src, marks: { reaction: "✅", lines: [], note: "" }, verification: { counted: 1, verified: 1, steps: 2, secs: 3 } });
    expect(r.deliveryText.length).toBeLessThanOrEqual(2000);
    expect(["compact", "omitted-oversize"]).toContain(r.footer);
  });
});
