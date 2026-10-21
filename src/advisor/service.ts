/**
 * DefaultAdvisorService — the provider-neutral entry point for
 * advisor consultations. Owns:
 *   1. Per-agent daily budget enforcement (via `AdvisorBudget`).
 *   2. Backend resolution + dispatch (via injected resolver).
 *   3. Response truncation at `ADVISOR_RESPONSE_MAX_LENGTH`.
 *   4. Recording the call AFTER successful backend return
 *      (matches `daemon.ts:9862` ordering — never charge a failed call).
 *
 * Layered budget semantics (per RESEARCH §6 Pitfall 4):
 *   - Native backend's `max_uses` is **per-request** (caps how many times
 *     the executor invokes `advisor` inside one turn). It does NOT cap
 *     per-conversation or per-day usage.
 *   - `AdvisorBudget` is **per-agent-per-day**.
 * Both layers apply: SDK enforces the per-request cap inside the turn;
 * `AdvisorService` enforces the daily cap around the turn.
 *
 * See:
 *   - `src/usage/advisor-budget.ts` (`ADVISOR_RESPONSE_MAX_LENGTH = 2000`,
 *     `AdvisorBudget.canCall / recordCall / getRemaining`)
 *   - `src/manager/daemon.ts:9805–9866` (current inline pattern this
 *     service generalises)
 *   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-RESEARCH.md`
 *     §6 (budget pitfall), §3 file map row for `src/advisor/service.ts`
 */

import {
  ADVISOR_RESPONSE_MAX_LENGTH,
  type AdvisorBudget,
} from "../usage/advisor-budget.js";
import type {
  AdvisorService,
  AdvisorRequest,
  AdvisorResponse,
  BackendId,
} from "./types.js";
import type { AdvisorBackend } from "./backends/types.js";

/**
 * Constructor-injected dependencies for `DefaultAdvisorService`.
 * Everything the service needs is passed in — no global lookups, no
 * direct SDK access — so the service is fully testable with mocks
 * (`__tests__/service.test.ts`).
 */
export interface AdvisorServiceDeps {
  readonly budget: AdvisorBudget;
  readonly resolveBackend: (
    agent: string,
  ) => { backend: AdvisorBackend; id: BackendId };
  readonly resolveSystemPrompt: (agent: string) => string;
  readonly resolveAdvisorModel: (agent: string) => string;
  /** 2026-08-27 — per-agent fork consult bound (ms); undefined = backend default. */
  readonly resolveConsultTimeoutMs?: (agent: string) => number | undefined;
}

/**
 * Default `AdvisorService` implementation. See file-level docs for
 * the order-of-operations guarantees.
 */
export class DefaultAdvisorService implements AdvisorService {
  constructor(private readonly deps: AdvisorServiceDeps) {}

  async ask(req: AdvisorRequest): Promise<AdvisorResponse> {
    const { budget } = this.deps;

    // 1. Budget gate — short-circuit BEFORE any backend work or
    //    prompt assembly so the cap is respected even when backend
    //    dispatch would have side effects (cost, SDK calls, fork
    //    spawns). Resolve the backend id only for the response shape.
    if (!budget.canCall(req.agent)) {
      const { id } = this.deps.resolveBackend(req.agent);
      return {
        answer:
          "Advisor daily budget exhausted for this agent (cap resets at midnight UTC).",
        budgetRemaining: 0,
        backend: id,
      };
    }

    // 2. Backend dispatch — resolve backend + per-agent settings.
    const { backend, id } = this.deps.resolveBackend(req.agent);
    const systemPrompt = this.deps.resolveSystemPrompt(req.agent);
    const advisorModel = this.deps.resolveAdvisorModel(req.agent);
    const timeoutMs = this.deps.resolveConsultTimeoutMs?.(req.agent);
    const { answer } = await backend.consult({
      agent: req.agent,
      question: req.question,
      systemPrompt,
      advisorModel,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

    // 3. Truncate to `ADVISOR_RESPONSE_MAX_LENGTH` (reuse the
    //    canonical constant — never redefine).
    const truncated =
      answer.length > ADVISOR_RESPONSE_MAX_LENGTH
        ? answer.slice(0, ADVISOR_RESPONSE_MAX_LENGTH)
        : answer;

    // 4. Record the call ONLY after successful backend return — same
    //    ordering as `daemon.ts:9862`. Failed calls do not charge the
    //    daily budget.
    budget.recordCall(req.agent);

    return {
      answer: truncated,
      budgetRemaining: budget.getRemaining(req.agent),
      backend: id,
    };
  }
}
