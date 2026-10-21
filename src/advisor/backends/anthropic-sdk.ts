/**
 * AnthropicSdkAdvisor — native-backend marker class.
 *
 * The native advisor pattern does NOT run via a synchronous `consult()`
 * call from `AdvisorService`. Instead, the Claude Agent SDK injects the
 * `advisor_20260301` server tool into the agent's own turn when
 * `Options.advisorModel` is set; the executor (the agent's own model)
 * decides WHEN to fire `advisor()` and the result lands inside the same
 * assistant message's `content[]` as `server_tool_use{name:"advisor"}`
 * followed by `advisor_tool_result`. The session-adapter observer
 * (Plan 117-04 T03/T04) emits `advisor:invoked` / `advisor:resulted`
 * events and records calls to `AdvisorBudget` from
 * `usage.iterations[].type === "advisor_message"`.
 *
 * This class exists so the `BackendRegistry` can resolve
 * `id === "native"` uniformly with the other backends (fork,
 * portable-fork). Its `consult()` THROWS a documented error per
 * RESEARCH §13.11 — Option A locked.
 *
 * ─────────────────────────────────────────────────────────────────
 * T01 SPIKE FINDING (Plan 117-04 T01, recorded 2026-05-13)
 * ─────────────────────────────────────────────────────────────────
 *
 * QUESTION: Does the Claude Agent SDK 0.2.132 Options surface expose a
 * per-request `max_uses` cap for the advisor tool alongside the
 * `advisorModel?: string` field?
 *
 * METHOD: grepped `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
 * for the `advisorModel` declaration and every occurrence of
 * `advisor`/`Advisor`/`max_uses`/`MaxUses`.
 *
 *   $ grep -n 'advisorModel' sdk.d.ts
 *   4930:    advisorModel?: string;
 *   $ grep -c 'advisor\|Advisor' sdk.d.ts
 *   2
 *   $ grep -c 'max_uses\|MaxUses' sdk.d.ts
 *   0
 *
 * RESULT: **Outcome B (per the plan's two outcomes).** The SDK exposes
 * ONLY `advisorModel?: string` at `sdk.d.ts:4930`. There is no sibling
 * field for `advisorMaxUses`, no nested `advisor` / `advisorTool`
 * object, and zero occurrences of `max_uses` anywhere in the SDK
 * declarations. The bundled `claude` CLI binary handles tool-definition
 * fields opaquely — they are not configurable from ClawCode through
 * the typed Options surface.
 *
 * MITIGATION CHOSEN: rely on `AdvisorBudget` per-agent-per-day cap
 * (already implemented in `src/usage/advisor-budget.ts`, unchanged in
 * Phase 117). When the budget is exhausted, the spread-conditional
 * pattern in `session-config.ts` OMITS `advisorModel` from the SDK
 * Options entirely on the next session reload (see Plan 117-04 T05
 * + RESEARCH §6 Pitfall 3 for byte-stability rationale).
 *
 * SOFT-CAP RISK (accepted): the per-day cap is best-effort. Inside a
 * single in-flight turn that started before budget exhaustion, the SDK
 * may invoke the advisor up to the server-side default `max_uses` cap
 * (currently 3 per Anthropic docs) — so the daily count can be exceeded
 * by ≤3 calls per turn beyond the 10/day target. This is the explicit
 * soft-cap acceptance documented in RESEARCH §13.5 fallback and §7 Q4.
 *
 * HISTORY-SCRUB MITIGATION (deferred): RESEARCH §13.5 mitigation B
 * (intercept SDK outbound requests, strip `advisor_tool_result` blocks
 * from history when re-entering with `advisorModel` omitted) requires
 * SDK internals ClawCode does not currently access. Deferred — if the
 * API begins returning `400 invalid_request_error` on prior
 * advisor-tool-result rows after budget exhaustion + reload, escalate
 * to a follow-up phase.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * See:
 *   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-RESEARCH.md`
 *     §2.1 (SDK stream surface), §6 Pitfall 3 (spread-conditional),
 *     §13.5 (budget-exhaustion mitigations), §13.11 (Option A locked).
 *   - `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:4928–4930`
 *     (the sole `advisorModel?: string` Options declaration).
 *
 * Class implementation lives below (filled in by Plan 117-04 T06).
 */

import type { AdvisorBackend } from "./types.js";

/**
 * Native advisor backend — `BackendId === "native"`. The class is a
 * code-aware MARKER ONLY; its `consult()` throws a documented error
 * per RESEARCH §13.11 Option A. See the spike-finding header above
 * for the full rationale + the soft-cap mitigation in force.
 *
 * The actual native advisor flow:
 *   1. `session-config.ts:shouldEnableAdvisor` decides if the agent's
 *      next session reload should carry `advisorModel` (gate: backend
 *      === "native" AND AdvisorBudget.canCall).
 *   2. `session-adapter.ts:SdkSessionAdapter.createSession/resumeSession`
 *      spread-conditionally injects `advisorModel` into the SDK Options.
 *   3. The bundled `claude` CLI binary injects the
 *      `advisor-tool-2026-03-01` beta header server-side and offers the
 *      `advisor_20260301` server tool to the executor (the agent's own
 *      model) inside its own turn.
 *   4. When the executor decides to consult, it emits
 *      `server_tool_use{name:"advisor"}` and the matching
 *      `advisor_tool_result` block lands in the SAME assistant message.
 *   5. `persistent-session-handle.ts` (and the test-only mirror in
 *      `session-adapter.ts:iterateWithTracing`) scan the content[] for
 *      these blocks and emit `advisor:invoked` / `advisor:resulted` on
 *      `SessionManager.advisorEvents`. At the terminal `result` event,
 *      `usage.iterations[].type === "advisor_message"` is counted and
 *      `AdvisorBudget.recordCall` is called once per iteration.
 *
 * No synchronous "consult me now" surface exists in this flow — the
 * executor owns timing. AdvisorService.ask() for native-backend
 * agents is therefore a misuse case; callers that need a synchronous
 * advisor call must flip `agent.advisor.backend: fork` to get the
 * `LegacyForkAdvisor` instead.
 */
export class AnthropicSdkAdvisor implements AdvisorBackend {
  readonly id = "native" as const;

  async consult(_args: {
    agent: string;
    question: string;
    systemPrompt: string;
    advisorModel: string;
  }): Promise<{ answer: string }> {
    throw new Error(
      "AnthropicSdkAdvisor.consult() not callable — advisor runs in-request " +
        "via Options.advisorModel; the executor decides timing autonomously. " +
        "To force a synchronous fork-based call, set agent.advisor.backend: fork.",
    );
  }
}
