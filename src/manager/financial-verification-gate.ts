/**
 * Phase 999.63 Plan 03 — financial-data verification enforcement gate
 * (pure decision core).
 *
 * The heart of Phase 999.63. Composes the prior two plans into a single
 * pure decision:
 *   - Plan 01's `classifyFinancialDraft` answers "does this draft emit
 *     financial figures?" (currency / percentage / finance keywords).
 *   - Plan 02's per-turn `recentToolCallNames` answers "did this turn call
 *     a verification tool?".
 *
 * `evaluateVerification` combines them: a draft that emits
 * financial figures WITHOUT firing a verification tool this turn is
 * flagged for a corrective re-prompt — UNLESS the verify-hop count has
 * already reached `MAX_VERIFY_HOPS` (the D4 single-hop loop bound), in
 * which case the gate fails open (`hop-exhausted`).
 *
 * Per CONTEXT.md:
 *   - D2 — verification is an enforced precondition, not advisory hope.
 *   - D3 — regex-only classification (Plan 01); the gate errs toward
 *     flagging (a false positive costs one re-prompt; a false negative
 *     ships a stale number).
 *   - D4 — exactly ONE corrective hop. `MAX_VERIFY_HOPS = 1` bounds the
 *     loop: the corrective turn carries `verifyHopCount = 1`, so the gate
 *     run on it returns `hop-exhausted` and issues no further re-prompt.
 *
 * This module is PURE: no I/O, no logging, no dispatch, no `Date`. All
 * side effects (corrective dispatch, telemetry emit, correction post)
 * live in the dispatcher's `runVerificationGate` helper. That
 * keeps this decision core fully unit-testable.
 *
 * Verification-tool detection is SUBSTRING-based, not exact-name. SDK MCP
 * tools are named `mcp__<server>__<tool>` (e.g. `mcp__finnhub__quote`,
 * `mcp__search__web_search`). A substring whitelist tolerates server-name
 * variation while still matching the real recorded names:
 *   - `finnhub`     → every `mcp__finnhub__*` tool (quote / stock_quote /
 *                     bond_yield / company_profile / ...).
 *   - `stock_quote` / `bond_yield` → explicit finnhub quote tools, kept
 *                     in the whitelist as belt-and-suspenders even though
 *                     `finnhub` already subsumes them.
 *   - `web_search`  → the search MCP's `mcp__search__web_search` tool.
 * See the SUMMARY's verification-tool-name research note for why the
 * substrings were validated by code-path analysis (no live trace DB).
 */

import { classifyFinancialDraft } from "./financial-classifier.js";
import { classifyRuleClaims } from "./financial-rule-claim-classifier.js";

/**
 * Maximum number of corrective verify hops. `1` means: the original turn
 * may trigger exactly ONE corrective re-prompt; the corrective turn
 * (carrying `verifyHopCount = 1`) can trigger none. This is the D4 loop
 * bound — a hard guard against an unbounded re-prompt loop.
 */
export const MAX_VERIFY_HOPS = 1;

/**
 * 2026-07-31 adaptive verify budget — single-source runtime defaults for
 * the `verification.*` budget knobs. Consumed by:
 *   - `src/config/schema.ts` — the defaults-surface `.default()` values,
 *   - `src/manager/financial-verification-runner.ts` — the final `??`
 *     fallback when no config block resolved.
 * Keeping schema defaults and runtime fallbacks on ONE frozen object is
 * what prevents the ".optional() schema vs divergent ?? fallback"
 * landmine.
 *
 * Threshold rationale:
 *   - `skipIfTurnMsOver` 120 s — a 2-minute turn is already tool-heavy
 *     (where the gate usually finds a verification tool anyway) and past
 *     interactive patience; stacking a 30-120 s corrective hop on top is
 *     the phantom-typing / wedge-adjacent regime from the 2026-07-31
 *     incident. Sits well under every stall/turn ceiling, so a skip never
 *     races wedge machinery.
 *   - `shrinkIfTurnMsOver` 30 s — "moderately heavy": the hop still runs
 *     but at `low` effort, bounding thinking spend and hop latency.
 *   - `deferMs` 2 s — long enough to catch a rapid-fire follow-up (the
 *     common phantom-typing trigger), short enough that a posted
 *     correction still reads as attached to the answer.
 */
export const VERIFICATION_BUDGET_DEFAULTS = Object.freeze({
  maxVerifyHops: MAX_VERIFY_HOPS,
  skipIfTurnMsOver: 120_000,
  shrinkIfTurnMsOver: 30_000,
  deferMs: 2_000,
  /**
   * 999.63b — rule-claim class defaults. `enabled: true` +
   * `maxVerifyHops: 0` = fleet-wide SHADOW: classification + telemetry run
   * everywhere the gate is enforced, but the corrective hop never
   * dispatches for the rules class until an operator raises the per-agent
   * `verification.ruleClaims.maxVerifyHops`. Splitting the knob
   * this way reuses the existing, ops-understood "maxVerifyHops 0 =
   * telemetry-only" idiom instead of inventing a tri-state.
   */
  ruleClaims: Object.freeze({ enabled: true, maxVerifyHops: 0 }),
  /**
   * C (2026-08-26) — pre-delivery HOLD mode. OFF fleet-wide: the gate
   * stays post-hoc (deliver, then correct). A per-agent
   * `verification.holdDelivery: true` moves verification BEFORE
   * delivery for that agent: draft streaming is replaced by a placeholder,
   * clean turns deliver immediately, flagged turns hold up to
   * `holdTimeoutMs` for the patch hop, and any timeout/error fails open
   * to deliver-then-correct (the post-hoc path becomes the backstop).
   * Token-neutral relative to post-hoc — same hop, different sequencing.
   */
  holdDelivery: false,
  holdTimeoutMs: 45_000,
  /**
   * 999.63d "verified streaming" — cosmetic UX knobs, all OFF fleet-wide.
   *   - streamStatus:  live "💠 *searching the web…*" status in the message
   *     slot during pre-text tool phases; the first draft chunk streams
   *     over it (draft streaming is never suppressed — that is hold mode).
   *   - pendingMarker: append "-# Verifying…" to a flagged delivered
   *     message while the corrective hop runs; stripped on completion.
   *   - verifiedBadge: ✅ reaction on turns whose rule claims all carried
   *     inline primary-source citations (or whose figures were verified by
   *     an in-turn tool). Honest in shadow — the evidence is in the
   *     visible message, independent of whether the hop is armed.
   */
  ux: Object.freeze({
    streamStatus: false,
    streamStatusMode: "auto" as const,
    narrationAsTrail: false,
    sourcesFooter: "off" as const,
    verdictReactions: false,
    modelSourcesLine: "keep" as const,
    ledgerButton: false,
    ledgerReaction: "🧾",
    liveClaims: false,
    statusMessage: "inline" as const,
    unverifiedNotice: true,
    compactBelowChars: 300,
    sourcesCharBudget: 480,
    pendingMarker: false,
    verifiedBadge: false,
  }),
});

/**
 * A tool-call name counts as a verification tool when it CONTAINS any of
 * these substrings, compared CASE-INSENSITIVELY (2026-07-31 hardening —
 * the native SDK tool is `WebSearch`, which a case-sensitive `web_search`
 * match could never see). Matches the SDK `mcp__<server>__<tool>` naming
 * format.
 *
 *   - `finnhub`      → every `mcp__finnhub__*` tool.
 *   - `stock_quote` / `bond_yield` → explicit finnhub tools, belt-and-
 *                      suspenders.
 *   - `web_search`   → `mcp__search__web_search` (search MCP).
 *   - `websearch`    → the SDK-native `WebSearch` tool (lowercased).
 *   - `brave-search` → `mcp__brave-search__search` — the brave MCP's tool
 *                      is literally named `search`, so the server-name
 *                      substring is the narrowest reliable hook.
 *
 * Bare `search` is deliberately ABSENT: it would match memory/document
 * search tools (`clawcode_memory_search`, `search_documents`, …) and let
 * a non-financial lookup silently pass stale numbers.
 *
 * Frozen so the whitelist cannot be mutated at runtime, and pinned by the
 * T-01 static-grep regression test — a future edit that empties the
 * whitelist (which would make the gate silently inert, the worst failure
 * mode) fails that test.
 */
export const VERIFICATION_TOOL_SUBSTRINGS: readonly string[] = Object.freeze([
  "finnhub",
  "stock_quote",
  "bond_yield",
  "web_search",
  "websearch",
  "brave-search",
  // 2026-08-27 — a client's own records ARE the primary source for client
  // figures (the house-standards rule the steer itself cites: "product
  // terms -> the client's own documents on file"). Reading the CRM or
  // ingesting a statement in the same turn is verification for the figures
  // class; treating it as "no verification" was the bulk of the 40/day
  // false re-prompts on fin-client. Generic `Read`/`Bash` stay OUT —
  // reading your own notes is not a source.
  "acme-db",
  "mysql_query",
  "ingest_document",
]);

/**
 * Sentinel reply an agent emits on a corrective review when it did NOT
 * actually emit financial figures needing verification — i.e. the
 * classifier produced a FALSE POSITIVE (the numbers were code, dates,
 * version strings, IDs, counts, or otherwise non-financial). When the
 * corrective turn replies with exactly this string (trimmed), the
 * dispatcher suppresses the correction post entirely: no awkward "false
 * positive — nothing to verify" message ever leaks to the user.
 *
 * This is a DISPATCHER-level escape hatch. The pure
 * `evaluateVerification` decision core stays sentinel-unaware;
 * sentinel handling lives only in `runVerificationGate`.
 */
export const NO_CORRECTION_NEEDED = "NO_CORRECTION_NEEDED";

/**
 * Static prompt sent to the agent on a corrective re-prompt. Code-defined
 * constant (NOT user-controlled) — no prompt-injection surface; the agent
 * receiving it is the same trusted agent that produced the draft.
 *
 * Includes an explicit escape hatch: if, on review, the agent did NOT
 * emit financial figures needing verification (the classifier false-
 * positived on code / dates / version strings / IDs / counts), it must
 * reply with EXACTLY `NO_CORRECTION_NEEDED` so the dispatcher suppresses
 * the correction post.
 */
export const CORRECTIVE_PROMPT: string =
  "You emitted financial figures (yields / prices / rates / AUM / " +
  "regulatory amounts) without verifying them this turn. Call finnhub " +
  "(stock_quote / bond_yield) or web_search to confirm each number " +
  "against a current source, then restate your answer with verified, " +
  "current figures.\n\n" +
  "If, on review, you did NOT actually emit financial figures needing " +
  "verification — the numbers were code, dates, version strings, IDs, " +
  "counts, or otherwise non-financial — reply with EXACTLY the string " +
  `${NO_CORRECTION_NEEDED} and nothing else.`;

/**
 * Prefix on the corrective response posted as a labelled correction
 * message (CONTEXT.md D5 — the correction is a SEPARATE message, not a
 * mutation of the original draft's delivery).
 */
// 999.178 R1 — glyph-free. The visible search icon is added where the
// correction is delivered (financial-verification-runner) so this pure,
// cycle-safe module keeps no dependency on the icon registry.
export const CORRECTION_PREFIX = "Correction (verified figures):\n";

/**
 * 999.63b — corrective prompt for the RULES class. Posture difference
 * from the figures prompt: figures get re-quoted from a live source;
 * rules get a CITATION or a RETRACTION — there is no "current value" to
 * fetch, only authority. finnhub is explicitly banned (market-data tools
 * cannot verify a rule), and turn-level tool activity is explicitly
 * discounted ("unrelated searches do not count") — the incident's
 * unrelated WebSearches are exactly what the legacy tool-presence check
 * would have credited.
 */
export const RULE_CORRECTIVE_PROMPT: string =
  "You asserted regulatory, eligibility, or procedural rules " +
  "(retirement-account rules, tax treatment, eligibility ages, penalty " +
  "conditions, brokerage/transfer/estate procedure) without verifying " +
  "them this turn. For EACH rule you asserted: verify it against a " +
  "PRIMARY source — web_search / WebFetch of irs.gov, the controlling " +
  "regulation, or the client's plan documents on file — then either " +
  "restate the rule with its citation (source name + URL or document) or " +
  "explicitly retract and correct it. Do NOT use finnhub or market-data " +
  "tools for this — they cannot verify rules. Unrelated searches this " +
  "turn do not count: each rule needs its own confirming source.\n\n" +
  "If, on review, you did NOT assert any such rule — the flagged text " +
  "was a question, quoted user text, a hypothetical, or already carried " +
  "a correct primary-source citation — reply with EXACTLY the string " +
  `${NO_CORRECTION_NEEDED} and nothing else.`;

/** 999.63b — correction-message prefix for the rules class (D5 sibling). */
export const RULE_CORRECTION_PREFIX = "Correction (verified rules):\n";

/** 999.63b — prefix when one hop corrects BOTH claim classes. */
export const COMBINED_CORRECTION_PREFIX =
  "Correction (verified figures & rules):\n";

/**
 * 999.63c/B (token optimization, 2026-08-26) — output contract appended
 * (once, by `selectCorrective`) to the corrective prompt. The hop replies
 * with a MINIMAL PATCH — find/replace operations plus a citation per op —
 * instead of regenerating the full message. Correction output tokens are
 * then proportional to the ERROR, not the message (~80-90% cut on the hop
 * path). The runner applies the ops locally to the original draft; the
 * patched full text feeds the in-place edit, and the ops render as a
 * compact note on the fallback-post path.
 *
 * Ops are applied in order against the evolving text, first occurrence
 * only, all-or-nothing (see `financial-correction-patch.ts`).
 */
export const PATCH_OUTPUT_CONTRACT: string =
  "OUTPUT CONTRACT: reply with a fenced ```json code block containing ONLY " +
  'a JSON array of surgical patch operations, shaped [{"find": "<exact ' +
  'text copied verbatim from your previous message>", "replace": ' +
  '"<corrected text>", "source": "<citation URL or document that verifies ' +
  'the correction>"}]. Keep each op minimal — patch only the claims that ' +
  "need correcting, copying `find` exactly (it is string-matched against " +
  "your previous message). No prose outside the code block. If nothing " +
  "needs correction reply with EXACTLY the string " +
  `${NO_CORRECTION_NEEDED} and nothing else.`;

/**
 * 999.63c — italic footer appended to an in-place corrected message.
 * Same visual convention as the advisor / steered-mid-turn footers
 * (bridge.ts single-mutation-point block). Appended AFTER
 * `formatOutboundText` runs — the formatter strips em-dashes from prose
 * and would otherwise eat the `—`.
 */
export const CORRECTION_EDIT_FOOTER = "*— correction applied (verified figures)*";

/** 999.63c — edit footer for the rules class. */
export const RULE_CORRECTION_EDIT_FOOTER =
  "*— correction applied (verified rules)*";

/** 999.63c — edit footer when one hop corrected both claim classes. */
export const COMBINED_CORRECTION_EDIT_FOOTER =
  "*— correction applied (verified figures & rules)*";

/**
 * 999.63b — pure prompt/prefix selection for the corrective hop. With
 * MAX_VERIFY_HOPS = 1 a second class-specific hop is impossible by
 * construction, so the combined case is ONE hop with a merged prompt and
 * a single correction message. The sentinel semantics are shared:
 * `NO_CORRECTION_NEEDED` means NEITHER class needed correction.
 * Defensive default: called with neither class true, it returns the
 * figures pair (the caller should not do that).
 */
export function selectCorrective(claimClasses: {
  readonly figures: boolean;
  readonly rules: boolean;
}): { readonly prompt: string; readonly prefix: string; readonly footer: string } {
  const { figures, rules } = claimClasses;
  // 999.63c — the replacement contract is composed here (ONCE, at the
  // single selection point) rather than baked into each base prompt, so
  // the combined case doesn't carry it twice.
  if (figures && rules) {
    return {
      prompt:
        `${CORRECTIVE_PROMPT}\n\nADDITIONALLY: ${RULE_CORRECTIVE_PROMPT}` +
        `\n\n${PATCH_OUTPUT_CONTRACT}`,
      prefix: COMBINED_CORRECTION_PREFIX,
      footer: COMBINED_CORRECTION_EDIT_FOOTER,
    };
  }
  if (rules) {
    return {
      prompt: `${RULE_CORRECTIVE_PROMPT}\n\n${PATCH_OUTPUT_CONTRACT}`,
      prefix: RULE_CORRECTION_PREFIX,
      footer: RULE_CORRECTION_EDIT_FOOTER,
    };
  }
  return {
    prompt: `${CORRECTIVE_PROMPT}\n\n${PATCH_OUTPUT_CONTRACT}`,
    prefix: CORRECTION_PREFIX,
    footer: CORRECTION_EDIT_FOOTER,
  };
}

/**
 * The action the gate decided for a single evaluation.
 *   - `none`          — not flagged: the turn was non-financial OR a
 *                       verification tool already fired.
 *   - `re-prompt`     — flagged: a corrective re-prompt should be issued.
 *   - `hop-exhausted` — flagged on a corrective turn (hop >= MAX): fail
 *                       open, issue NO further re-prompt (D4 bound).
 *   - `error`         — gate-internal failure: fail open. NOT produced by
 *                       the pure decision fn; emitted by the dispatcher's
 *                       helper when its try/catch traps a throw.
 */
export type VerificationAction =
  | "none"
  | "re-prompt"
  | "hop-exhausted"
  | "error";

/** Structured verdict from `evaluateVerification`. */
export interface VerificationResult {
  /**
   * True when the draft is financial AND no verification tool fired this
   * turn AND `verifyHopCount < MAX_VERIFY_HOPS`. When true, the dispatcher
   * should issue exactly one corrective re-prompt.
   */
  readonly flagged: boolean;
  /**
   * The finance-shaped tokens Plan 01's classifier detected in the draft
   * (capped by `MAX_MATCHED_TOKENS`). Empty when the draft is not
   * financial. Surfaced verbatim in the `phase999.63-verify` telemetry.
   */
  readonly financialTokensDetected: readonly string[];
  /**
   * The subset of `toolCallNames` that matched the verification-tool
   * whitelist. Non-empty means the turn DID verify (FIGURES class only —
   * the rules class never consults tool presence, see `ruleAction`).
   */
  readonly verificationToolsCalled: readonly string[];
  /**
   * The decided action for the FIGURES class — semantics byte-identical
   * to pre-999.63b (ops grep-gates count on this). The rules-class
   * verdict lives in `ruleAction`.
   */
  readonly action: VerificationAction;
  /**
   * 2026-08-27 — set when the figures class was satisfied by provenance
   * (every figure verbatim in this turn's tool results) rather than by a
   * whitelisted tool NAME. Absent otherwise.
   */
  readonly figureProvenance?: "tool-results";
  /**
   * 999.63b additive — rule-claim tokens detected in the draft. Empty
   * when the rules path is disabled or nothing matched.
   */
  readonly ruleTokensDetected: readonly string[];
  /**
   * 999.63b additive — the decided action for the RULES class. `none`
   * when the rules path is disabled or no rule claims were detected.
   * Tool presence is deliberately NOT consulted: an agent that genuinely
   * verified a rule has the citation available to put in the draft, and
   * the classifier's primary-source-cited-segment suppression is the
   * no-fire signal. Turn metadata is gameable by unrelated calls — the
   * 2026-08-26 incident turn's unrelated WebSearches would have passed a
   * tool-presence check while both load-bearing claims went unverified.
   */
  readonly ruleAction: VerificationAction;
  /**
   * 999.63b additive — the claim classes DETECTED in the draft (figures
   * when the figure classifier fired, rules when the rule classifier
   * fired with the path enabled). Telemetry rider for shadow analysis.
   */
  readonly claimClasses: readonly ("figures" | "rules")[];
  /**
   * 999.63d additive — true when the rule classifier saw modal+domain
   * pairs suppressed by in-segment primary-source citations (inline
   * verification evidence; powers the ✅ verified-inline badge). Always
   * false when the rules path is disabled.
   */
  readonly citedRuleClaimsDetected: boolean;
}

/**
 * Returns true when `toolName` contains any verification-tool substring.
 * Case-insensitive (2026-07-31): `WebSearch`, `mcp__Finnhub__quote`, and
 * other casing variants all count.
 */
/**
 * 2026-08-27 — true when the draft's figure-shaped tokens (currency /
 * percentage) ALL appear verbatim in the turn's tool-result text. Whitespace
 * is collapsed on both sides; nothing else is normalised, deliberately — a
 * figure the model re-derived or rounded is exactly the case that should
 * still be checked. Returns false when there are no figure tokens or no
 * text, so it can never widen the "verified" set on its own.
 */
export function figuresVerbatimInToolResults(
  matchedTokens: readonly string[],
  toolResultText: string | undefined,
): boolean {
  if (typeof toolResultText !== "string" || toolResultText.length === 0) return false;
  const figures = matchedTokens.filter((t) => t.includes("$") || t.includes("%"));
  if (figures.length === 0) return false;
  const hay = toolResultText.replace(/\s+/g, " ");
  return figures.every((f) => hay.includes(f.replace(/\s+/g, " ")));
}

function isVerificationTool(toolName: string): boolean {
  const lowered = toolName.toLowerCase();
  return VERIFICATION_TOOL_SUBSTRINGS.some((sub) => lowered.includes(sub));
}

/**
 * Evaluate whether a draft agent response needs a corrective verification
 * re-prompt. Pure — deterministic, no I/O, no logging, no dispatch.
 *
 * Decision:
 *   1. Classify the draft via Plan 01's `classifyFinancialDraft`.
 *   2. Compute `verificationToolsCalled` = the subset of `toolCallNames`
 *      matching the verification-tool whitelist.
 *   3. `flagged` = financial AND no verification tool AND hop below MAX.
 *   4. `action`:
 *        - `none`          — not financial, OR a verification tool fired.
 *        - `re-prompt`     — financial + unverified + hop < MAX.
 *        - `hop-exhausted` — financial + unverified + hop >= MAX.
 */
export function evaluateVerification(input: {
  readonly response: string;
  readonly toolCallNames: readonly string[];
  readonly verifyHopCount: number;
  /**
   * 2026-07-31 adaptive budget — optional hop-bound override resolved
   * from `verification.maxVerifyHops` config. Defaults to the
   * `MAX_VERIFY_HOPS` module constant (1). `0` yields telemetry-only
   * mode: a financial+unverified draft classifies straight to
   * `hop-exhausted` (fail-open, no corrective dispatch ever).
   */
  readonly maxVerifyHops?: number;
  /**
   * 999.63b — resolved rule-claims knobs. ABSENT (or `enabled: false`)
   * = the rules path is disabled and the result is byte-identical to
   * legacy behavior (`ruleAction: "none"`, empty tokens) — the
   * regression shield for callers that have not opted in.
   */
  readonly ruleClaims?: {
    readonly enabled: boolean;
    readonly maxVerifyHops: number;
  };
  /**
   * 2026-08-27 — bounded tool_result text from this turn. When every
   * currency / percentage token in the draft appears verbatim in it, the
   * figures came out of a tool THIS turn (a statement, the CRM, a search
   * result) and are treated as verified — `figureProvenance:
   * "tool-results"`. Optional so every existing caller and test is
   * byte-identical.
   */
  readonly toolResultText?: string;
}): VerificationResult {
  const { response, toolCallNames, verifyHopCount } = input;
  const maxVerifyHops = input.maxVerifyHops ?? MAX_VERIFY_HOPS;

  const classification = classifyFinancialDraft(response);
  const verificationToolsCalled = Object.freeze(
    toolCallNames.filter(isVerificationTool),
  );

  // 999.63b — RULES class. Independent of the figures decision; tool
  // presence is never consulted (see the ruleAction field doc).
  const rulesEnabled = input.ruleClaims?.enabled === true;
  const ruleClassification = rulesEnabled
    ? classifyRuleClaims(response)
    : {
        hasRuleClaims: false,
        matchedRuleTokens: [] as readonly string[],
        citedRuleClaimsDetected: false,
      };
  const ruleAction: VerificationAction = !ruleClassification.hasRuleClaims
    ? "none"
    : verifyHopCount >= (input.ruleClaims?.maxVerifyHops ?? 0)
      ? "hop-exhausted"
      : "re-prompt";
  const rulesFlagged = ruleAction === "re-prompt";

  const claimClasses = Object.freeze([
    ...(classification.isFinancial ? (["figures"] as const) : []),
    ...(ruleClassification.hasRuleClaims ? (["rules"] as const) : []),
  ]);
  const ruleFields = {
    ruleTokensDetected: ruleClassification.matchedRuleTokens,
    ruleAction,
    claimClasses,
    citedRuleClaimsDetected: ruleClassification.citedRuleClaimsDetected,
  };

  // Not financial — nothing to enforce on the figures class.
  if (!classification.isFinancial) {
    return {
      flagged: rulesFlagged,
      financialTokensDetected: classification.matchedTokens,
      verificationToolsCalled,
      action: "none",
      ...ruleFields,
    };
  }

  // Financial, but a verification tool already fired — verified, no action.
  if (verificationToolsCalled.length > 0) {
    return {
      flagged: rulesFlagged,
      financialTokensDetected: classification.matchedTokens,
      verificationToolsCalled,
      action: "none",
      ...ruleFields,
    };
  }

  // 2026-08-27 — provenance: the figures are verbatim in this turn's tool
  // results. That is what "verified with a tool" means for the figures
  // class; the old name-only check called a number read off the client's
  // own statement "unverified" and re-prompted (40/day on fin-client,
  // ~all false). Only figure-shaped tokens count (currency / percentage);
  // keywords and tickers are not evidence either way.
  const provenance = figuresVerbatimInToolResults(
    classification.matchedTokens,
    input.toolResultText,
  );
  if (provenance) {
    return {
      flagged: rulesFlagged,
      financialTokensDetected: classification.matchedTokens,
      verificationToolsCalled,
      action: "none",
      figureProvenance: "tool-results",
      ...ruleFields,
    };
  }

  // Financial + unverified — but the hop bound is already reached. Fail
  // open: report the unverified figures in telemetry, issue no re-prompt.
  if (verifyHopCount >= maxVerifyHops) {
    return {
      flagged: rulesFlagged,
      financialTokensDetected: classification.matchedTokens,
      verificationToolsCalled,
      action: "hop-exhausted",
      ...ruleFields,
    };
  }

  // Financial + unverified + hop below MAX — flag for a corrective re-prompt.
  return {
    flagged: true,
    financialTokensDetected: classification.matchedTokens,
    verificationToolsCalled,
    action: "re-prompt",
    ...ruleFields,
  };
}
