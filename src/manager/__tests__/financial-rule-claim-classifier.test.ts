/**
 * 999.63b T-01 — rule-claim classifier tests.
 *
 * Fixture discipline per the codebase convention (silence-sentinel /
 * result-quality): VERBATIM prod strings from the 2026-08-26
 * fin-client incident (Vallejos 401(k) + F&G annuity double-error)
 * and the 31-day retraction history, plus true negatives and structure
 * pins. `classifyRuleClaims` is pure — no mocks, no I/O.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  classifyRuleClaims,
  MAX_RULE_TOKENS,
  RULE_DOMAIN_TERMS,
  RULE_DOMAIN_ACRONYMS,
  RULE_MODAL_TERMS,
  PRIMARY_SOURCE_HOSTS,
} from "../financial-rule-claim-classifier.js";

/**
 * VERBATIM incident text — the wrong rollover claim recovered from the
 * correcting edit's old_string (session bbf47635…, line 8025). Note the
 * closing "Your only step is signing." carries no domain noun of its own:
 * it flags ONLY because "only step" sits within the proximity window of
 * the paragraph's "401(k)" — the bare sentence is out of regex reach
 * (the honest limit that motivates the phase-2 claims manifest).
 */
const ROLLOVER_PARAGRAPH =
  "Once you separate from Acme Corp, we open a Schwab Rollover IRA and " +
  "transfer the 401(k) in kind. Nothing is sold, no tax event is " +
  "triggered, and the old account closes itself when the transfer " +
  "completes. Your only step is signing.";

/**
 * VERBATIM incident text — the wrong 225% recommendation (session line
 * 7568 excerpt). Percentages make it FIGURES-class; it carries no
 * modal+domain pair, no age shape, no citation — pinning that the rules
 * class does NOT double-flag a pure recommendation paragraph.
 */
const ANNUITY_PARAGRAPH =
  "If certainty matters more: move everything to the Fixed Interest " +
  "Option at 1.50%. If the death benefit matters more: move to the Two " +
  "Year GS Global Factor with Par and Fee at 225%. It is the highest " +
  "participation rate on the entire menu.";

describe("incident fixtures (2026-08-26)", () => {
  it("rollover paragraph → rule claims (pair path: 'Once you' / 'only step' × Rollover/IRA/401(k))", () => {
    const r = classifyRuleClaims(ROLLOVER_PARAGRAPH);
    expect(r.hasRuleClaims).toBe(true);
    expect(r.matchedRuleTokens.length).toBeGreaterThan(0);
  });

  it("bare 'Your only step is signing.' does NOT flag standalone (no domain noun in reach)", () => {
    const r = classifyRuleClaims("Your only step is signing.");
    expect(r.hasRuleClaims).toBe(false);
  });

  it("annuity 225% paragraph alone → NOT rules-class (figures-class territory)", () => {
    const r = classifyRuleClaims(ANNUITY_PARAGRAPH);
    expect(r.hasRuleClaims).toBe(false);
  });

  it("full incident doc (both paragraphs) → rules-class via the rollover text", () => {
    const r = classifyRuleClaims(
      `${ROLLOVER_PARAGRAPH}\n\n${ANNUITY_PARAGRAPH}`,
    );
    expect(r.hasRuleClaims).toBe(true);
  });
});

describe("shape positives", () => {
  const positives: Array<[string, string]> = [
    [
      "modal + age + domain",
      "You must wait until 59½ to take an IRA distribution.",
    ],
    [
      "penalty-free + only if + in-service + 59.5",
      "Withdrawals are penalty-free at 59.5 only if the plan allows in-service distributions.",
    ],
    ["RMD age with linking verb", "The RMD age is 73 for your cohort."],
    ["IRC citation shape", "Under IRC §401(a)(9), distributions must begin."],
    ["Pub. 590 citation shape", "See Pub. 590-B for the details."],
  ];
  for (const [label, text] of positives) {
    it(`${label} → flags`, () => {
      expect(classifyRuleClaims(text).hasRuleClaims).toBe(true);
    });
  }
});

describe("historical retraction categories (31-day scan) — rules-positive", () => {
  const positives: Array<[string, string]> = [
    [
      "trust/estate (08-09)",
      "A revocable trust cannot remove assets from your estate.",
    ],
    [
      "ACAT taxability (08-14)",
      "An ACAT transfer is not a taxable event; your cost basis carries over.",
    ],
    [
      "LPOA generalization (08-14)",
      "The LPOA allows me to place trades in every account you hold.",
    ],
    [
      "fractional shares (08-18)",
      "Schwab cannot transfer fractional shares in kind.",
    ],
    [
      "cost-basis step-up vs property tax (08-21)",
      "Only if you inherit the home do you get a step-up in cost basis.",
    ],
  ];
  for (const [label, text] of positives) {
    it(`${label} → flags`, () => {
      expect(classifyRuleClaims(text).hasRuleClaims).toBe(true);
    });
  }
});

describe("historical retraction categories — rules-NEGATIVE (figures-class or neither)", () => {
  const negatives: Array<[string, string]> = [
    ["stale quote passthrough (07-27)", "IRBO closed at $34.12 on July 17."],
    [
      "EPS conflation (07-27)",
      "ServiceNow earnings go from $1.60 to $5.00, a triple.",
    ],
    [
      "family-farm number (08-19)",
      "The family farm figure is about $7,100 per year, not $10,000.",
    ],
    ["markdown scope (08-23)", "The 3% markdown applies to the Boyd account."],
  ];
  for (const [label, text] of negatives) {
    it(`${label} → does not flag as rules`, () => {
      expect(classifyRuleClaims(text).hasRuleClaims).toBe(false);
    });
  }
});

describe("true negatives — suppressions", () => {
  it("question form is the DESIRED behavior — never flags", () => {
    const r = classifyRuleClaims(
      "Do you know if your plan allows in-service rollovers?",
    );
    expect(r.hasRuleClaims).toBe(false);
  });

  it(">-quoted user text is not an agent assertion", () => {
    const r = classifyRuleClaims(
      "> he doesn't need to separate from harris to roll over his 401k\n\nGood catch — checking now.",
    );
    expect(r.hasRuleClaims).toBe(false);
  });

  it("primary-source-cited segment is treated as verified", () => {
    const r = classifyRuleClaims(
      "Per https://www.irs.gov/retirement-plans/plan-participant-employee/401k-resource-guide, you must include the distribution in gross income unless you roll it over.",
    );
    expect(r.hasRuleClaims).toBe(false);
  });

  it("explicit verification-delegation hedge suppresses the pair", () => {
    const r = classifyRuleClaims(
      "You may not be eligible for the in-service option — confirm with your plan administrator before we file anything.",
    );
    expect(r.hasRuleClaims).toBe(false);
  });

  it("modal without any domain term (plain ops text) never flags", () => {
    const r = classifyRuleClaims(
      "You must restart the daemon before the config applies.",
    );
    expect(r.hasRuleClaims).toBe(false);
  });

  it("domain term without any modal never flags", () => {
    const r = classifyRuleClaims(
      "We opened your Roth IRA today and the paperwork went through.",
    );
    expect(r.hasRuleClaims).toBe(false);
  });

  it("modal and domain beyond the proximity window never pair", () => {
    const filler = "The quarterly report covers operations in detail. ".repeat(
      5,
    );
    const r = classifyRuleClaims(
      `Reports must be filed by Friday. ${filler}The estate documents arrived.`,
    );
    expect(r.hasRuleClaims).toBe(false);
  });

  it("uppercase-only acronyms: the given name 'Ira' never matches IRA", () => {
    const r = classifyRuleClaims("You must call Ira before Friday.");
    expect(r.hasRuleClaims).toBe(false);
  });

  it("soft hedges deliberately still flag (anti-gaming)", () => {
    const r = classifyRuleClaims(
      "Typically you must separate from service before a 401(k) rollover.",
    );
    expect(r.hasRuleClaims).toBe(true);
  });
});

describe("structure pins", () => {
  it("matchedRuleTokens is capped at MAX_RULE_TOKENS", () => {
    const bomb = Array.from(
      { length: 50 },
      (_, i) => `You must take the RMD from IRA number ${i}.`,
    ).join(" ");
    const r = classifyRuleClaims(bomb);
    expect(r.hasRuleClaims).toBe(true);
    expect(r.matchedRuleTokens.length).toBeLessThanOrEqual(MAX_RULE_TOKENS);
  });

  it("term arrays are frozen", () => {
    expect(Object.isFrozen(RULE_DOMAIN_TERMS)).toBe(true);
    expect(Object.isFrozen(RULE_DOMAIN_ACRONYMS)).toBe(true);
    expect(Object.isFrozen(RULE_MODAL_TERMS)).toBe(true);
    expect(Object.isFrozen(PRIMARY_SOURCE_HOSTS)).toBe(true);
  });

  it("empty / non-string input → clean negative", () => {
    expect(classifyRuleClaims("")).toEqual({
      hasRuleClaims: false,
      matchedRuleTokens: [],
      citedRuleClaimsDetected: false,
    });
  });

  it("static-grep pin: core term literals present in source (T-01 convention)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(here, "..", "financial-rule-claim-classifier.ts"),
      "utf-8",
    );
    for (const literal of [
      '"rollover"',
      '"in-service"',
      '"participation rate"',
      '"ACAT"',
      '"IRA"',
      '"must"',
      '"only if"',
      '"once you"',
      '"irs.gov"',
    ]) {
      expect(src).toContain(literal);
    }
  });
});

/**
 * 999.63d — citedRuleClaimsDetected: the ✅ verified-inline badge signal.
 * A pair suppressed by an in-segment primary-source citation is positive
 * evidence of inline verification; question/delegation suppression is not.
 */
describe("citedRuleClaimsDetected (999.63d)", () => {
  it("cited pair only → cited=true, hasRuleClaims=false", () => {
    const r = classifyRuleClaims(
      "You cannot pledge IRA assets as loan collateral per " +
        "https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-prohibited-transactions.",
    );
    expect(r.hasRuleClaims).toBe(false);
    expect(r.citedRuleClaimsDetected).toBe(true);
  });

  it("cited + uncited mix → both true", () => {
    const r = classifyRuleClaims(
      "You cannot pledge IRA assets per https://www.irs.gov/pub/irs-pdf/p590a.pdf.\n" +
        "Separately, you must complete the rollover within the transfer window.",
    );
    // The 590 citation ALSO fires the citation path (Pub. 590 shape is a
    // URL here, not the `Pub. 590` literal — so hasRuleClaims comes from
    // the second, uncited pair).
    expect(r.hasRuleClaims).toBe(true);
    expect(r.citedRuleClaimsDetected).toBe(true);
  });

  it("question-suppressed pair → cited=false", () => {
    const r = classifyRuleClaims(
      "Do you know if your plan says you must wait before a rollover?",
    );
    expect(r.hasRuleClaims).toBe(false);
    expect(r.citedRuleClaimsDetected).toBe(false);
  });

  it("delegation-hedge-suppressed pair → cited=false", () => {
    const r = classifyRuleClaims(
      "A rollover may not be available every year, confirm with your plan administrator.",
    );
    expect(r.hasRuleClaims).toBe(false);
    expect(r.citedRuleClaimsDetected).toBe(false);
  });

  it("cross-segment pair with the URL in a DIFFERENT segment → fires, cited=false", () => {
    const r = classifyRuleClaims(
      "Here is the source: https://www.irs.gov/retirement-plans.\n" +
        "So you must start the rollover\nbefore the IRA custodian closes the window.",
    );
    // The modal+domain pair spans segments without a citation in either
    // paired segment — recall-leaning: it fires, and it is NOT cited.
    expect(r.hasRuleClaims).toBe(true);
    expect(r.citedRuleClaimsDetected).toBe(false);
  });

  it("non-primary host URL does not suppress and does not count as cited", () => {
    const r = classifyRuleClaims(
      "You must complete the rollover within 60 days per https://www.myannuitystore.com/rules.",
    );
    expect(r.hasRuleClaims).toBe(true);
    expect(r.citedRuleClaimsDetected).toBe(false);
  });
});
