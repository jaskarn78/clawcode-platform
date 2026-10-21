/**
 * Phase 138 Plan 03 T-01 — verbatim Discord credit-threshold alert
 * message constants + interpolation helpers.
 *
 * The four `ALERT_MSG_*` constants are the WIRE FORMAT for the Discord
 * alerts that fire when a provider crosses 75 / 90 / 95 / 99% of its
 * daily cost cap. They are pinned byte-for-byte by a static-grep
 * regression test (`__tests__/alert-messages-static-grep.test.ts`) so a
 * future edit that silently drifts the operator-visible format triggers
 * a CI failure — the operator must explicitly bump the regression test
 * to ratify a wire-format change. Mirrors the Phase 137-02 / 999.58
 * static-grep carve-out precedent.
 *
 * **Format (CONTEXT D5 lines 137-142):** emoji + provider + threshold +
 * `cost/cap` + UTC timestamp + agents-affected + an action sub-line.
 * `{token}` placeholders are replaced at fire time by {@link interpolate}.
 *
 * **String form.** The constants are written as double-quoted string
 * CONCATENATION (one quoted segment per wire line). The static-grep test
 * asserts each quoted segment verbatim — keep concatenation form (NOT
 * template literals) so the grep assertions stay a literal substring
 * match. Changing the form requires updating the grep test in lockstep.
 *
 * **No secrets.** These templates only ever interpolate provider names,
 * cost numbers, a timestamp, and agent names — all operator-public
 * (Threat T-138-03-02). No `apiKeyPath`, no message bodies.
 */

/** ⚠️ — 75% of daily cap. Action: manual review. */
export const ALERT_MSG_75 =
  "⚠️ {provider} usage at 75% (${cost_usd}/${cap_usd})\n" +
  "Triggered: {timestamp}\n" +
  "Agents affected: {agents}\n" +
  "Action: manual review";

/** ⚠️ — 90% of daily cap. Action: manual review. */
export const ALERT_MSG_90 =
  "⚠️ {provider} usage at 90% (${cost_usd}/${cap_usd})\n" +
  "Triggered: {timestamp}\n" +
  "Agents affected: {agents}\n" +
  "Action: manual review";

/** 🚨 — 95% of daily cap. Action: failover (Plan 04 is the failover actor). */
export const ALERT_MSG_95 =
  "🚨 {provider} usage at 95% (${cost_usd}/${cap_usd})\n" +
  "Triggered: {timestamp}\n" +
  "Agents affected: {agents}\n" +
  "Action: failover {failover_summary}";

/** 🛑 — 99% of daily cap. Action: hard cap imminent — operator action. */
export const ALERT_MSG_99 =
  "🛑 {provider} usage at 99% (${cost_usd}/${cap_usd})\n" +
  "Triggered: {timestamp}\n" +
  "Agents affected: {agents}\n" +
  "Action: hard cap soon — operator action required";

/**
 * The four alert thresholds (percent of daily cap). Readonly tuple —
 * Plan 04 imports the SAME constant so the alert + failover layers
 * never drift on what counts as a crossing.
 */
export const THRESHOLDS = [75, 90, 95, 99] as const;

/** One of the four alert thresholds. */
export type Threshold = (typeof THRESHOLDS)[number];

/**
 * Plan 03 ships with `{failover_summary}` (the ALERT_MSG_95 placeholder)
 * resolving to this literal. Plan 03 only ALERTS at 95%; the failover
 * DECISION + factory-dispatch override is Plan 04's responsibility
 * (strict layering — see 138-03-PLAN objective). Plan 04 overrides this
 * at integration time to enumerate the actually-failed-over agents.
 */
export const FAILOVER_SUMMARY_PLACEHOLDER = "triggered (see plan 04 deployment)";

/** Maximum agent names rendered inline before truncating with a suffix. */
const AGENT_LIST_CUTOFF = 5;

/**
 * Replace `{key}` placeholders in `template` with values from `vars`.
 *
 * - An UNRECOGNISED placeholder (no matching key in `vars`) is left
 *   verbatim — graceful: the operator sees the unfilled `{key}` in the
 *   delivered alert and knows exactly what the fire site failed to
 *   supply. Missing keys do NOT throw.
 * - `${cost_usd}` in the templates is a literal `$` followed by the
 *   `{cost_usd}` placeholder — the `$` is plain text, only `{cost_usd}`
 *   is substituted.
 */
export function interpolate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key)
      ? vars[key]!
      : match;
  });
}

/**
 * Render an agents-affected list for the `{agents}` placeholder.
 *
 * Up to {@link AGENT_LIST_CUTOFF} (5) names are joined with `, `. When
 * more agents are affected, the first 5 are shown followed by a
 * `(+N more)` suffix so the Discord message stays readable
 * (researcher_todo #3). An empty list renders as `"none"`.
 */
export function formatAgentsList(agents: readonly string[]): string {
  if (agents.length === 0) return "none";
  if (agents.length <= AGENT_LIST_CUTOFF) return agents.join(", ");
  const shown = agents.slice(0, AGENT_LIST_CUTOFF).join(", ");
  const remaining = agents.length - AGENT_LIST_CUTOFF;
  return `${shown} (+${remaining} more)`;
}

/** Resolve the verbatim message template for a threshold. */
export function messageForThreshold(threshold: Threshold): string {
  switch (threshold) {
    case 75:
      return ALERT_MSG_75;
    case 90:
      return ALERT_MSG_90;
    case 95:
      return ALERT_MSG_95;
    case 99:
      return ALERT_MSG_99;
  }
}
