/**
 * PortableForkAdvisor — provider-neutral fork-style advisor SCAFFOLD ONLY.
 *
 * Phase 117 ships the interface seam; Phase 118 fills in the implementation.
 *
 * Intended Phase 118 implementation (DO NOT IMPLEMENT IN PHASE 117):
 *   1. Extract the agent's transcript from SDK-owned session state.
 *      The agent SDK does not currently expose a clean transcript-snapshot
 *      API; either (a) intercept via the existing tracing hooks, or (b) read
 *      from the SDK's session file on disk (~/.claude/projects/<slug>/...).
 *   2. Build an advisor system prompt (reuse `buildAdvisorSystemPrompt` from
 *      `src/advisor/prompts.ts`).
 *   3. Call a `CompletionProvider` (`src/llm/provider.ts`, interface seeded in
 *      Phase 117-01) with `model = advisorModel`; the first provider
 *      implementation lands in Phase 118 (likely `AnthropicDirectProvider`
 *      against `@anthropic-ai/sdk`, bypassing the agent SDK).
 *   4. Return `{ answer: string }` matching `LegacyForkAdvisor`'s external
 *      shape so `AdvisorService.ask()` truncation/budget plumbing is uniform
 *      across backends.
 *
 * Not registered in the config schema as a selectable value (Phase 117-06's
 * zod enum allows only `"native" | "fork"`). The registry defensively falls
 * back to `"native"` if the literal somehow appears (see
 * `src/advisor/registry.ts:60`). This file exists so the `AdvisorBackend`
 * abstraction has three concrete shapes from day one and Phase 118 doesn't
 * have to re-shape call sites.
 *
 * See:
 *   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-CONTEXT.md`
 *     (`<scope>` — scaffold only; `<deferred>` — Phase 118 follow-up)
 *   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-RESEARCH.md`
 *     (§3 file map row; §5 Plan 117-05 test pattern)
 *   - `/home/example-user/.claude/plans/eventual-questing-tiger.md`
 *     (`PortableForkAdvisor` § — scaffold only)
 */

import type { AdvisorBackend } from "./types.js";

export class PortableForkAdvisor implements AdvisorBackend {
  readonly id = "portable-fork" as const;

  async consult(_args: {
    agent: string;
    question: string;
    systemPrompt: string;
    advisorModel: string;
  }): Promise<{ answer: string }> {
    throw new Error("PortableForkAdvisor not implemented — see Phase 118");
  }
}
