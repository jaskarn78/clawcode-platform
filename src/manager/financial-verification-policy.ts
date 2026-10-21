/**
 * Phase 999.63 Plan 04 — financial-verification per-agent enforcement policy.
 *
 * Decides WHICH agents the Phase 999.63 enforcement gate applies to. The gate
 * itself (Plan 03, `financial-verification-gate.ts` + `turn-dispatcher.ts`)
 * runs the classifier, the tool-call check, the corrective re-prompt, and the
 * telemetry; this module answers the orthogonal question: "should the gate
 * fire for THIS agent at all?"
 *
 * Per-agent opt-in, prefix-matched by default:
 *   - Enforcement applies by DEFAULT to any agent whose name prefix-matches
 *     `fin-` (e.g. `fin-research`, `fin-tax`) with ZERO per-agent YAML.
 *   - An explicit per-agent `verification.enforced` config override
 *     wins over the prefix default in BOTH directions: `true` opts a non-fin
 *     agent IN, `false` opts a fin agent OUT.
 *   - Every other agent inherits only the Phase 999.1 advisory `freshness`
 *     directive — no behavior change.
 *
 * Pure module: no I/O, no `Date`, no global mutation. The override value is
 * supplied by the caller (resolved from config upstream) — this module never
 * reaches into config itself.
 */

/**
 * Agent-name prefixes that receive financial-verification enforcement by
 * default. PREFIX match WITH the trailing hyphen — NOT a bare substring:
 * `finance-bot` (starts with `fin` but not `fin-`) is intentionally NOT
 * enforced. Frozen so a runtime edit cannot drift the policy.
 */
export const FINANCIAL_AGENT_PREFIXES: readonly string[] = Object.freeze([
  "fin-",
]);

/**
 * Resolve whether financial-verification enforcement applies to an agent.
 *
 * @param agentName - the agent's name (e.g. `fin-client`,
 *   `admin-clawdy`).
 * @param perAgentOverride - the resolved `verification.enforced`
 *   config value for the agent, or `undefined` when the agent has no
 *   override (the common case — `fin-*` agents need no YAML).
 * @returns `true` when the gate should fire for this agent.
 *
 * Resolution:
 *   - `perAgentOverride === true`  → `true`  (explicit opt-in, any name).
 *   - `perAgentOverride === false` → `false` (explicit opt-out, any name).
 *   - `perAgentOverride === undefined` → `true` iff `agentName` starts with
 *     any `FINANCIAL_AGENT_PREFIXES` entry (the prefix-rule default).
 */
export function isVerificationEnforced(
  agentName: string,
  perAgentOverride?: boolean | undefined,
): boolean {
  // Explicit per-agent override wins in both directions, regardless of the
  // name prefix.
  if (perAgentOverride !== undefined) {
    return perAgentOverride;
  }
  // No override — fall back to the prefix-rule default.
  return FINANCIAL_AGENT_PREFIXES.some((prefix) =>
    agentName.startsWith(prefix),
  );
}

/**
 * 2026-07-31 — silently-inert-gate guard (the failure mode behind the
 * fin-client incident: the gate demanded verification tools the turn could
 * never report, so it re-prompted 100% of financial turns for 5 days).
 *
 * Answers: "could ANY tool this agent can reach ever satisfy the
 * verification whitelist?" Two approximated signals:
 *   - an MCP *server name* case-insensitively containing a whitelist
 *     substring (server-level approximation of `mcp__<server>__*` tool
 *     names — a server named `finnhub` yields `mcp__finnhub__*` tools),
 *   - the SDK-native `WebSearch` tool, unless explicitly disallowed
 *     (matches the `websearch` whitelist entry).
 *
 * Pure — the loader calls this at boot AND on every reload (it re-resolves
 * all agents) and emits a `phase999.63-coverage-resolver` warn when an
 * ENFORCED agent has zero coverage.
 */
export function checkVerificationToolCoverage(input: {
  readonly mcpServerNames: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly verificationSubstrings: readonly string[];
}): { readonly covered: boolean; readonly matchedBy: readonly string[] } {
  const matched: string[] = [];
  for (const server of input.mcpServerNames) {
    const lowered = server.toLowerCase();
    if (input.verificationSubstrings.some((sub) => lowered.includes(sub))) {
      matched.push(`server:${server}`);
    }
  }
  const webSearchDisallowed = input.disallowedTools.some(
    (tool) => tool.toLowerCase() === "websearch",
  );
  if (!webSearchDisallowed) {
    matched.push("native:WebSearch");
  }
  return {
    covered: matched.length > 0,
    matchedBy: Object.freeze([...new Set(matched)]),
  };
}
