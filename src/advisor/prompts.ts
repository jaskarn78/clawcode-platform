/**
 * Advisor system-prompt builder.
 *
 * Ported verbatim from `src/manager/daemon.ts:9836–9841` (current
 * fork-based `ask-advisor` IPC handler). The string this function
 * returns is byte-identical to what the inline construction in
 * `daemon.ts` would produce for the same inputs — a parity guarantee
 * verified by `__tests__/prompts.test.ts` BEFORE the extraction in
 * Plan 117-03 rewires `daemon.ts` to call this function.
 *
 * See:
 *   - `src/manager/daemon.ts:9836` (current inline definition — source of truth)
 *   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-RESEARCH.md`
 *     (§3 file map row for `src/advisor/prompts.ts`)
 */

/**
 * Build the advisor system prompt for one consultation.
 *
 * Matches `daemon.ts:9836` exactly:
 * ```
 * const systemPrompt = [
 *   `You are an advisor to agent "${agentName}". Provide concise, actionable guidance.`,
 *   ...(memoryContext
 *     ? ["\nRelevant context from agent's memory:", memoryContext]
 *     : []),
 * ].join("\n");
 * ```
 *
 * @param agent - Agent name (interpolated into the opening line).
 * @param memoryContext - Optional pre-formatted memory snippet block.
 *   When falsy (null / undefined / empty string), the memory section
 *   is omitted entirely — matching the existing inline behavior where
 *   an empty `memoryContext` string short-circuits the spread.
 * @returns The fully assembled system prompt string.
 */
export function buildAdvisorSystemPrompt(
  agent: string,
  memoryContext?: string | null,
): string {
  return [
    `You are an advisor to agent "${agent}". Provide concise, actionable guidance.`,
    ...(memoryContext
      ? ["\nRelevant context from agent's memory:", memoryContext]
      : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Plan 117-08 — Agent awareness block (timing-prompt for the advisor tool).
//
// Source of truth for the prose that the capability manifest injects into
// every ClawCode agent's system prompt. Keeping the text here (rather than
// inline in `src/manager/capability-manifest.ts`) means future copy tweaks
// are one-line edits in a file owned by the advisor subsystem.
//
// Canonical wording is lightly adapted from the docs-recommended Advisor
// Tool timing prompt (see `/home/example-user/.claude/CLAUDE.md` Advisor Tool
// section / Phase 117 CONTEXT.md `<decisions>.Claude's Discretion`). The
// adaptation adds the ClawCode-specific note that consultations are
// visible in the agent's Discord channel and clarifies that
// `spawn_subagent_thread` is a separate, operator-watchable mechanism.
//
// See:
//   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-RESEARCH.md`
//     §4.3 (capability manifest pattern), §4.4 (assembler is downstream)
//   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-CONTEXT.md`
//     `<scope>` (agent-awareness scope), `<decisions>.Claude's Discretion`
// ---------------------------------------------------------------------------

/** Options for {@link buildAgentAwarenessBlock}. */
export interface AwarenessBlockOptions {
  /**
   * Resolved advisor backend for the agent. Drives a small qualifier in
   * the bullet so operators on the fork rollback path can tell at a
   * glance which dispatch route is live for this agent.
   */
  readonly backend: "native" | "fork";
  /**
   * Per-agent-per-day advisor call budget. Surfaced in the bullet so the
   * agent knows roughly how many consultations remain before throttling.
   * Today this is a manifest-time hint (the live count lives in
   * `AdvisorBudget`); future work can flow the live count through.
   */
  readonly dailyBudget: number;
}

/**
 * Build the bullet + protocol prose block that teaches a ClawCode agent
 * about the advisor tool.
 *
 * Returned shape lets the capability manifest place the bullet inside
 * its existing markdown list and append the protocol prose alongside
 * other protocol sections (e.g. Memory protocol).
 *
 * @param opts - Resolved backend + budget hint.
 * @returns `{ bullet, protocol }` — the bullet is a single markdown list
 *   item; the protocol is a multi-paragraph section with its own `##`
 *   heading.
 */
export function buildAgentAwarenessBlock(opts: AwarenessBlockOptions): {
  readonly bullet: string;
  readonly protocol: string;
} {
  const legacyNote =
    opts.backend === "fork"
      ? " (legacy fork backend — operator rollback path)"
      : "";

  const bullet =
    "- **Advisor (Opus)**: `advisor()` server-tool available for hard decisions" +
    legacyNote +
    ". Budget: " +
    opts.dailyBudget +
    " calls/day per agent. " +
    "Consultations are visible in Discord (💭 reaction + footer).";

  const protocol =
    "\n## Advisor protocol\n\n" +
    "Call advisor BEFORE substantive work — before writing, before committing to an interpretation, " +
    "before building on an assumption. If a task requires orientation first (finding files, fetching a source, " +
    "seeing what's there), do that, then call advisor. Orientation is not substantive work. " +
    "Writing, editing, and declaring an answer are.\n\n" +
    "Also call advisor: when you believe the task is complete; when stuck (errors recurring, approach not converging); " +
    "when considering a change of approach. Give advice serious weight — but if an empirical step fails or " +
    "primary-source evidence contradicts a specific claim, adapt.\n\n" +
    "Advisor consultations are visible in your Discord channel: a 💭 reaction on the triggering message and a " +
    "`Advisor consulted (Opus)` line in the footer of your reply. " +
    "For tasks that need operator-watchable execution (multi-step exploration, code review, long research), " +
    "use the subagent-thread skill instead (when assigned) — that creates a visible sidebar thread.\n";

  return { bullet, protocol };
}
