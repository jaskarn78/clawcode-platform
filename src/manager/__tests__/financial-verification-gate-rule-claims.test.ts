/**
 * 999.63b — gate decision-matrix tests for the RULES class.
 *
 * Pins the incident fix (unrelated WebSearch no longer satisfies the
 * rules class), the legacy byte-compat shield (`ruleClaims` absent ⇒
 * result identical), shadow mode, the hop bound, and the
 * `selectCorrective` prompt/prefix matrix.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateVerification,
  selectCorrective,
  CORRECTIVE_PROMPT,
  CORRECTION_PREFIX,
  RULE_CORRECTIVE_PROMPT,
  RULE_CORRECTION_PREFIX,
  COMBINED_CORRECTION_PREFIX,
  NO_CORRECTION_NEEDED,
  VERIFICATION_BUDGET_DEFAULTS,
  PATCH_OUTPUT_CONTRACT,
  CORRECTION_EDIT_FOOTER,
  RULE_CORRECTION_EDIT_FOOTER,
  COMBINED_CORRECTION_EDIT_FOOTER,
} from "../financial-verification-gate.js";
/**
 * VERBATIM incident correction message (posted 2026-08-26 14:35:41 UTC).
 * Kept as a local copy — importing it from the classifier test file
 * would re-register that file's suites here.
 */
const INCIDENT_CORRECTION_MESSAGE =
  "On the rollover, you're right and I had it wrong. He doesn't need to " +
  "separate. IRC 401(k)(2)(B)(i)(III) lets a plan release elective " +
  "deferrals at 59½ while still employed, and he's 65.";

/** Verbatim incident rollover claim — rules-class, NO figure shapes. */
const RULES_ONLY_DRAFT =
  "Once you separate from Acme Corp, we open a Schwab Rollover IRA and " +
  "transfer the 401(k) in kind. Nothing is sold, no tax event is " +
  "triggered, and the old account closes itself when the transfer " +
  "completes. Your only step is signing.";

/** Figures-class draft (existing suite's canonical shape). */
const FIGURES_ONLY_DRAFT = "The 10-year Treasury yield is 4.25% right now." // 2026-08-27: lone % no longer fires; `yield` corroborates;

const RULES_ENFORCED = { enabled: true, maxVerifyHops: 1 } as const;

describe("the incident pin — rules class ignores turn-level tool presence", () => {
  it("rules-only draft + unrelated WebSearch → action none BUT ruleAction re-prompt, flagged", () => {
    // 2026-08-26: the turn had unrelated WebSearches (CalPERS survivor
    // detail, document-design research). The legacy tool-presence check
    // credited them; the rules class must not.
    const r = evaluateVerification({
      response: RULES_ONLY_DRAFT,
      toolCallNames: ["WebSearch", "WebSearch"],
      verifyHopCount: 0,
      ruleClaims: RULES_ENFORCED,
    });
    expect(r.action).toBe("none");
    expect(r.ruleAction).toBe("re-prompt");
    expect(r.flagged).toBe(true);
    expect(r.ruleTokensDetected.length).toBeGreaterThan(0);
    expect(r.claimClasses).toEqual(["rules"]);
  });

  it("combined draft (figures + rules) + no tools → both classes re-prompt, one flagged verdict", () => {
    const r = evaluateVerification({
      response: `${RULES_ONLY_DRAFT}\n\n${FIGURES_ONLY_DRAFT}`,
      toolCallNames: [],
      verifyHopCount: 0,
      ruleClaims: RULES_ENFORCED,
    });
    expect(r.action).toBe("re-prompt");
    expect(r.ruleAction).toBe("re-prompt");
    expect(r.flagged).toBe(true);
    expect(r.claimClasses).toEqual(["figures", "rules"]);
  });
});

describe("legacy byte-compat shield", () => {
  it("ruleClaims absent → figures verdict identical to legacy + inert rule fields", () => {
    const legacyShape = evaluateVerification({
      response: FIGURES_ONLY_DRAFT,
      toolCallNames: [],
      verifyHopCount: 0,
    });
    expect(legacyShape.flagged).toBe(true);
    expect(legacyShape.action).toBe("re-prompt");
    expect(legacyShape.ruleAction).toBe("none");
    expect(legacyShape.ruleTokensDetected).toEqual([]);
  });

  it("ruleClaims absent → a rules-only draft stays invisible (pre-999.63b behavior)", () => {
    const r = evaluateVerification({
      response: RULES_ONLY_DRAFT,
      toolCallNames: [],
      verifyHopCount: 0,
    });
    expect(r.flagged).toBe(false);
    expect(r.action).toBe("none");
    expect(r.ruleAction).toBe("none");
    expect(r.claimClasses).toEqual([]);
  });

  it("enabled: false behaves exactly like absent", () => {
    const r = evaluateVerification({
      response: RULES_ONLY_DRAFT,
      toolCallNames: [],
      verifyHopCount: 0,
      ruleClaims: { enabled: false, maxVerifyHops: 1 },
    });
    expect(r.flagged).toBe(false);
    expect(r.ruleAction).toBe("none");
  });
});

describe("shadow mode and hop bound", () => {
  it("fleet default {enabled:true, maxVerifyHops:0} → ruleAction hop-exhausted, NOT flagged", () => {
    const r = evaluateVerification({
      response: RULES_ONLY_DRAFT,
      toolCallNames: [],
      verifyHopCount: 0,
      ruleClaims: VERIFICATION_BUDGET_DEFAULTS.ruleClaims,
    });
    expect(r.ruleAction).toBe("hop-exhausted");
    expect(r.flagged).toBe(false);
    // Shadow still reports the tokens — that IS the telemetry payload.
    expect(r.ruleTokensDetected.length).toBeGreaterThan(0);
  });

  it("hop 1 at maxVerifyHops 1 → hop-exhausted (can never loop)", () => {
    const r = evaluateVerification({
      response: RULES_ONLY_DRAFT,
      toolCallNames: [],
      verifyHopCount: 1,
      ruleClaims: RULES_ENFORCED,
    });
    expect(r.ruleAction).toBe("hop-exhausted");
    expect(r.flagged).toBe(false);
  });

  it("the incident correction message itself, evaluated at hop 1 → not flagged", () => {
    // The posted correction legitimately contains rule claims (59½,
    // rollover) — the hop-1 evaluation is what keeps it from
    // re-triggering, exactly like the figures class.
    const r = evaluateVerification({
      response: INCIDENT_CORRECTION_MESSAGE,
      toolCallNames: [],
      verifyHopCount: 1,
      ruleClaims: RULES_ENFORCED,
    });
    expect(r.flagged).toBe(false);
    expect(r.ruleAction).not.toBe("re-prompt");
  });
});

describe("selectCorrective matrix", () => {
  // 999.63c — prompts now carry the replacement output contract appended
  // ONCE by selectCorrective (deliberate change from the 999.63b exact-
  // constant pins: the correction can replace the original message, so
  // the hop must reply with the full corrected text).
  it("rules-only → rules prompt + contract, rules prefix + footer", () => {
    const s = selectCorrective({ figures: false, rules: true });
    expect(s.prompt).toBe(
      `${RULE_CORRECTIVE_PROMPT}\n\n${PATCH_OUTPUT_CONTRACT}`,
    );
    expect(s.prefix).toBe(RULE_CORRECTION_PREFIX);
    expect(s.footer).toBe(RULE_CORRECTION_EDIT_FOOTER);
  });

  it("figures-only → legacy prompt + contract, legacy prefix + footer", () => {
    const s = selectCorrective({ figures: true, rules: false });
    expect(s.prompt).toBe(
      `${CORRECTIVE_PROMPT}\n\n${PATCH_OUTPUT_CONTRACT}`,
    );
    expect(s.prefix).toBe(CORRECTION_PREFIX);
    expect(s.footer).toBe(CORRECTION_EDIT_FOOTER);
  });

  it("combined → merged prompt with the contract exactly ONCE + combined prefix + footer", () => {
    const s = selectCorrective({ figures: true, rules: true });
    expect(s.prompt).toContain(CORRECTIVE_PROMPT);
    expect(s.prompt).toContain(RULE_CORRECTIVE_PROMPT);
    expect(s.prompt.split(PATCH_OUTPUT_CONTRACT).length - 1).toBe(1);
    expect(s.prefix).toBe(COMBINED_CORRECTION_PREFIX);
    expect(s.footer).toBe(COMBINED_CORRECTION_EDIT_FOOTER);
  });

  it("patch contract: ops-array instruction + sentinel; footers pin the em-dash convention", () => {
    // B — the hop must return surgical find/replace ops with a citation,
    // inside a fenced json block; the sentinel escape hatch survives.
    expect(PATCH_OUTPUT_CONTRACT).toContain("```json");
    expect(PATCH_OUTPUT_CONTRACT).toContain('"find"');
    expect(PATCH_OUTPUT_CONTRACT).toContain('"replace"');
    expect(PATCH_OUTPUT_CONTRACT).toContain('"source"');
    expect(PATCH_OUTPUT_CONTRACT).toContain(NO_CORRECTION_NEEDED);
    expect(CORRECTION_EDIT_FOOTER).toBe(
      "*— correction applied (verified figures)*",
    );
    expect(RULE_CORRECTION_EDIT_FOOTER).toBe(
      "*— correction applied (verified rules)*",
    );
    expect(COMBINED_CORRECTION_EDIT_FOOTER).toBe(
      "*— correction applied (verified figures & rules)*",
    );
  });

  it("rules prompt mandates primary sources, bans finnhub, keeps the sentinel", () => {
    expect(RULE_CORRECTIVE_PROMPT).toContain("irs.gov");
    expect(RULE_CORRECTIVE_PROMPT).toContain("WebFetch");
    expect(RULE_CORRECTIVE_PROMPT).toContain(NO_CORRECTION_NEEDED);
    expect(RULE_CORRECTIVE_PROMPT).toContain("Do NOT use finnhub");
    expect(RULE_CORRECTIVE_PROMPT).toContain(
      "Unrelated searches this turn do not count",
    );
  });

  it("defaults object pins the shadow posture", () => {
    expect(VERIFICATION_BUDGET_DEFAULTS.ruleClaims).toEqual({
      enabled: true,
      maxVerifyHops: 0,
    });
    expect(
      Object.isFrozen(VERIFICATION_BUDGET_DEFAULTS.ruleClaims),
    ).toBe(true);
  });
});

describe("citedRuleClaimsDetected threading (999.63d)", () => {
  const CITED =
    "You cannot pledge IRA assets as collateral per " +
    "https://www.irs.gov/retirement-plans/plan-participant-employee/retirement-topics-prohibited-transactions.";

  it("rules enabled + cited pair → citedRuleClaimsDetected true on the result", () => {
    const r = evaluateVerification({
      response: CITED,
      toolCallNames: [],
      verifyHopCount: 0,
      ruleClaims: { enabled: true, maxVerifyHops: 1 },
    });
    expect(r.citedRuleClaimsDetected).toBe(true);
    // The cited pair is suppressed — no rules flag.
    expect(r.ruleAction).toBe("none");
  });

  it("rules disabled → citedRuleClaimsDetected false even with cited text", () => {
    const r = evaluateVerification({
      response: CITED,
      toolCallNames: [],
      verifyHopCount: 0,
    });
    expect(r.citedRuleClaimsDetected).toBe(false);
  });

  it("uncited rule claim → false (no citation evidence)", () => {
    const r = evaluateVerification({
      response: "You must separate from service before any 401(k) rollover.",
      toolCallNames: [],
      verifyHopCount: 0,
      ruleClaims: { enabled: true, maxVerifyHops: 0 },
    });
    expect(r.citedRuleClaimsDetected).toBe(false);
    expect(r.ruleAction).toBe("hop-exhausted");
  });

  it("999.63d ux defaults pin — every TOGGLE ships OFF", () => {
    // streamStatusMode is not a toggle: it selects WHEN the trail arms
    // once streamStatus turns it on, so it ships at its behavioural
    // default rather than "off". "auto" is what shipped 2026-08-26 —
    // "topic" would regress the 12-plan-audit blind spot, "always" would
    // regress the "not on every prompt" ask.
    expect(VERIFICATION_BUDGET_DEFAULTS.ux).toEqual({
      streamStatus: false,
      streamStatusMode: "auto",
      narrationAsTrail: false,
      sourcesFooter: "off",
      verdictReactions: false,
      modelSourcesLine: "keep",
      ledgerButton: false,
      ledgerReaction: "🧾",
      liveClaims: false,
      statusMessage: "inline", // 2026-08-27 — separate status message is opt-in
      unverifiedNotice: true,
      compactBelowChars: 300,
      sourcesCharBudget: 480,
      pendingMarker: false,
      verifiedBadge: false,
    });
  });
});
