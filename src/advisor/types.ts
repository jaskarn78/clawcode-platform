/**
 * Advisor types — provider-neutral interfaces for the advisor service.
 *
 * Phase 117: introduces the `AdvisorService` seam between IPC/MCP handlers
 * (`src/manager/daemon.ts:9805` `ask-advisor`, `src/mcp/server.ts:925`
 * `ask_advisor`) and the per-agent advisor backend (legacy fork / native
 * SDK / portable fork). The service owns budget enforcement, response
 * truncation, and backend dispatch. Backends are pluggable behind
 * `AdvisorBackend` (see `./backends/types.ts`).
 *
 * See:
 *   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-CONTEXT.md`
 *     (decisions.Architecture — LOCKED)
 *   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-RESEARCH.md`
 *     (§3 file map, §13.10 advisor event shapes)
 *   - `/home/example-user/.claude/plans/eventual-questing-tiger.md`
 *     (Interfaces §, lines 92–128)
 */

/**
 * Identifier for a registered advisor backend.
 *
 * - `"native"` — `AnthropicSdkAdvisor` using the Claude Agent SDK's
 *   `advisorModel` option (Plan 117-04; default backend).
 * - `"fork"`   — `LegacyForkAdvisor` wrapping the existing
 *   `forkSession` + `dispatchTurn` path (Plan 117-03; rollback gate).
 * - `"portable-fork"` — `PortableForkAdvisor` scaffold (Plan 117-05;
 *   NOT selectable in Phase 117, deferred to Phase 118).
 */
export type BackendId = "native" | "fork" | "portable-fork";

/**
 * One advisor consultation request. Issued by IPC/MCP handlers and
 * passed to `AdvisorService.ask()`.
 */
export interface AdvisorRequest {
  readonly agent: string;
  readonly question: string;
}

/**
 * Result returned from a single advisor consultation.
 *
 * `answer` is already truncated to `ADVISOR_RESPONSE_MAX_LENGTH`
 * (see `src/usage/advisor-budget.ts:11`). `budgetRemaining` reflects
 * the per-agent daily cap after the call has been recorded. `backend`
 * identifies which `AdvisorBackend` handled the call (for visibility
 * + telemetry, e.g. Discord footer in Plan 117-09).
 */
export interface AdvisorResponse {
  readonly answer: string;
  readonly budgetRemaining: number;
  readonly backend: BackendId;
}

/**
 * Provider-neutral advisor entry point. Call sites depend on this
 * interface only — never on a concrete backend or the Agent SDK.
 */
export interface AdvisorService {
  ask(req: AdvisorRequest): Promise<AdvisorResponse>;
}

/**
 * Event emitted when an advisor consultation begins. Per RESEARCH §13.10:
 * emitted by `src/manager/session-adapter.ts` in Plan 117-04 (native
 * backend) so the Discord bridge (Plan 117-09) can land the 💭 reaction
 * on the triggering user message BEFORE assistant delivery.
 */
export interface AdvisorInvokedEvent {
  readonly agent: string;
  readonly turnId: string;
  readonly toolUseId: string;
}

/**
 * Event emitted when an advisor consultation produces a terminal
 * result (success, redacted, or tool-use error). Consumed by the
 * Discord bridge (Plan 117-09) to render the
 * `Advisor consulted (Opus)` footer fact (999.151: merged into the single
 * grey subtext row rather than appended as italic prose) and, when
 * `/verbose` is on for the channel, the inline Q+A block (Plan 117-11).
 *
 * `kind` distinguishes the three terminal states the SDK surfaces:
 *   - `"advisor_result"` — normal success
 *   - `"advisor_redacted_result"` — model returned content scrubbed by
 *     safety filters
 *   - `"advisor_tool_result_error"` — backend reported an error
 *     (network, auth, parse). `errorCode` carries the SDK-reported code.
 */
export interface AdvisorResultedEvent {
  readonly agent: string;
  readonly turnId: string;
  readonly toolUseId: string;
  readonly kind:
    | "advisor_result"
    | "advisor_redacted_result"
    | "advisor_tool_result_error";
  readonly text?: string;
  readonly errorCode?: string;
}
