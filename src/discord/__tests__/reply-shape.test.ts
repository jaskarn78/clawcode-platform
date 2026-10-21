import { describe, it, expect } from "vitest";
import { measureShape, countSentences, isLabelLine } from "../reply-shape.js";

/**
 * 999.63 — reply-shape measurer. Per-field fixtures, then the three shapes
 * measured as the worst cases in #acme-client-acquisition (2026-08-28)
 * and one ideal `ledger` reply.
 */
const ZERO = {
  chars: 0, paragraphs: 0, parasOver2: 0, longestPara: 0, bulletsOver1: 0,
  figuresInProse: 0, h3: 0, h1h2: 0, labelLines: 0, subtextLines: 0,
  modelSourcesLine: false, drafts: 0, tables: 0,
};

describe("measureShape — per field", () => {
  it("empty reply is all zeros", () => {
    expect(measureShape("")).toEqual(ZERO);
  });

  it("chars is the raw length", () => {
    expect(measureShape("Yes.").chars).toBe(4);
  });

  it("paragraphs: blank-line blocks, minus fences, -# lines, headings and table rows", () => {
    const r = measureShape(
      "One.\n\n```bash\nls\n\nls -la\n```\n\n-# aside\n\n### Part\nTwo.\n\n| a | b |\n|---|---|\n| 1 | 2 |",
    );
    expect(r.paragraphs).toBe(2);
    expect(r.subtextLines).toBe(1);
    expect(r.h3).toBe(1);
    expect(r.tables).toBe(1);
  });

  it("an unclosed fence hides the rest; ```x``` on one line hides only itself", () => {
    expect(measureShape("Lead.\n```\nA. B. C.\nD. E. F.").parasOver2).toBe(0);
    expect(measureShape("```x```\nA. B. C.").parasOver2).toBe(1);
  });

  it("parasOver2 and longestPara", () => {
    const r = measureShape("A one. A two. A three.\n\nB one. B two.");
    expect(r.paragraphs).toBe(2);
    expect(r.parasOver2).toBe(1);
    expect(r.longestPara).toBe("A one. A two. A three.".length);
  });

  it("bulletsOver1 across -, •, * and 1. markers; a continuation line joins its bullet", () => {
    const r = measureShape(
      "- One sentence.\n- Two here. And two.\n• Three. Four. Five.\n* Fine.\n1. Also fine.\n2) Not fine. No.\n- Split\nacross lines. Twice.",
    );
    expect(r.bulletsOver1).toBe(4);
    expect(r.paragraphs).toBe(0);
  });

  it("figuresInProse counts $, % and comma figures only in prose lines of a 2+ sentence paragraph", () => {
    expect(measureShape("Fee is $1,234 and 12.5% on 1,000 shares. Second sentence.").figuresInProse).toBe(3);
    expect(measureShape("Fee is $1,234.56, $1.2M and 0.5 %. Second sentence.").figuresInProse).toBe(3);
    expect(measureShape("Fee is $1,234 and 12.5% on 1,000 shares.").figuresInProse).toBe(0);
    expect(measureShape("- Fee is $1,234. Second sentence.").figuresInProse).toBe(0);
    expect(measureShape("Fee: $1,234\nRate: 12.5%\nShares: 1,000").figuresInProse).toBe(0);
    // A figure on its own label line inside a prose paragraph is not "in prose".
    expect(measureShape("Fee: $1,234\nThat beats the plan. Move it now.").figuresInProse).toBe(0);
    // Years and ages are not figures.
    expect(measureShape("He is 62 in 2027. It fits.").figuresInProse).toBe(0);
  });

  it("h3 vs h1h2 (#### is neither)", () => {
    const r = measureShape("# Big\n## Medium\n### Small\n#### Tiny\nText");
    expect(r.h1h2).toBe(2);
    expect(r.h3).toBe(1);
    expect(r.paragraphs).toBe(1);
  });

  it("labelLines: `Label: value`, emphasis stripped; not headings, URLs, Sources, or bold lead-ins", () => {
    const r = measureShape(
      [
        "Rate: 5.2%",
        "Term: 10 years",
        "**Fee:** $50",
        "Balance: **$1.2M** (as of Aug 27).",
        "https://irs.gov/pub590",
        "### Heading: not a label",
        "Sources: irs.gov",
        "**Why this works:** because the match is computed on pre-tax deferrals only. That is the rule.",
        "A very long label that runs past twenty eight chars: x",
        "- Bullet: not a label line",
      ].join("\n"),
    );
    expect(r.labelLines).toBe(4);
    expect(isLabelLine("Next step: call Tuesday to confirm the rollover paperwork")).toBe(true);
    expect(isLabelLine("lowercase: no")).toBe(false);
  });

  it("subtextLines counts `-# ` lines only", () => {
    const r = measureShape("-# one\n-# two\n-#not subtext");
    expect(r.subtextLines).toBe(2);
    expect(r.paragraphs).toBe(1);
  });

  it("modelSourcesLine variants", () => {
    for (const l of [
      "Sources: irs.gov",
      "-# Sources: [irs](<https://irs.gov>)",
      "**Sources:** a",
      "References: b",
      "Citations : c",
      "source: d",
      "  Source: e",
      "```draft\nHi.\nSources: inside a draft\n```",
    ]) {
      expect(measureShape(l).modelSourcesLine, l).toBe(true);
    }
    for (const l of ["The sources: are here", "Sourcesx: y", "No sources line", "Source of funds: IRA"]) {
      expect(measureShape(l).modelSourcesLine, l).toBe(false);
    }
  });

  it("drafts counts closed client-facing fences only, and hides their content", () => {
    const r = measureShape(
      "```draft\nOne. Two. Three.\n```\n\n```email\nOne\n```\n```bash\nls\n```\n```text\nunclosed",
    );
    expect(r.drafts).toBe(2);
    expect(r.parasOver2).toBe(0);
    expect(r.paragraphs).toBe(0);
  });

  it("tables by delimiter row; a bare --- rule is not a table", () => {
    const r = measureShape("| a | b |\n|---|---|\n| 1 | 2 |\n\ntext\n\n| c |\n| :--- |\n| 3 |\n\n---");
    expect(r.tables).toBe(2);
    expect(r.paragraphs).toBe(2);
  });
});

describe("countSentences — abbreviation, decimal and emphasis guards", () => {
  it.each([
    ["The U.S. limit is $7,000 (e.g. for 2025). See Pub. 590-B.", 2],
    ["Mr. Smith met Dr. Jones vs. Ms. Lee, i.e. the whole team.", 1],
    ["The rate is 1.5 today, or 12.5% after fees.", 1],
    ["**Yes.** Move it now!", 2],
    ['He said "no." Then left?', 2],
    ["No terminator at all", 1],
    ["Wait... what", 2],
    ["", 0],
  ])("%s -> %d", (s, n) => {
    expect(countSentences(s)).toBe(n);
  });
});

describe("measured worst cases (fin-client, 2026-08-28) and the ideal ledger reply", () => {
  it("a 1,300-char single bullet carrying five sentences", () => {
    const sentence =
      "The rollover keeps the pre-tax dollars in a traditional IRA where growth stays deferred until " +
      "distributions begin, and nothing on this year's return changes under the schedule the plan " +
      "administrator described in the packet that arrived last week from the custodian";
    const bullet = "- " + Array.from({ length: 5 }, () => sentence).join(". ") + ".";
    expect(bullet.length).toBeGreaterThanOrEqual(1300);
    const r = measureShape(bullet);
    expect(r.bulletsOver1).toBe(1);
    expect(r.paragraphs).toBe(0);
    expect(r.parasOver2).toBe(0);
    expect(r.h3).toBe(0);
  });

  it("a paragraph hiding three $ figures", () => {
    const r = measureShape(
      "The account holds $1.2M across two custodians. Moving $400,000 to the Roth this year adds " +
      "$96,000 of ordinary income. That pushes the bracket.",
    );
    expect(r.figuresInProse).toBe(3);
    expect(r.parasOver2).toBe(1);
    expect(r.labelLines).toBe(0);
    expect(r.paragraphs).toBe(1);
  });

  it("**bold** lead + prose as the only structure", () => {
    const r = measureShape(
      "**Why pre-tax for the base:** the match is computed on pre-tax deferrals only, so moving the " +
      "base to Roth would forfeit part of it. The catch-up is separate. Put that in Roth.\n\n" +
      "**What I would do:** keep the base pre-tax. Direct the catch-up to Roth. Revisit in January.",
    );
    expect(r.paragraphs).toBe(2);
    expect(r.parasOver2).toBe(2);
    expect(r.labelLines).toBe(0);
    expect(r.h3).toBe(0);
    expect(r.subtextLines).toBe(0);
  });

  it("an ideal ledger-shaped reply", () => {
    const r = measureShape(
      [
        "**Roll the 401(k) into the IRA now; the fee math favors it.**",
        "",
        "### Cost today",
        "Plan fee: **0.85%**",
        "IRA fee: **0.20%**",
        "Annual saving: **$2,600**",
        "",
        "### What changes",
        "- The match stops on the last payroll before the transfer.",
        "- Nothing moves until the custodian confirms the ACAT form.",
        "",
        "-# Fee figures are from the 2025 plan disclosure; call the administrator to confirm the current schedule.",
      ].join("\n"),
    );
    expect(r.parasOver2).toBe(0);
    expect(r.figuresInProse).toBe(0);
    expect(r.h3).toBe(2);
    expect(r.labelLines).toBeGreaterThanOrEqual(2);
    expect(r.h1h2).toBe(0);
    expect(r.bulletsOver1).toBe(0);
    expect(r.subtextLines).toBe(1);
    expect(r.modelSourcesLine).toBe(false);
    expect(r.paragraphs).toBe(2);
  });
});
