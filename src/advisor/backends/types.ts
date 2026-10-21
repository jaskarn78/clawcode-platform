/**
 * AdvisorBackend interface — per-backend entry point for one consultation.
 *
 * Implementations:
 *   - `LegacyForkAdvisor` (Plan 117-03) — extracts `daemon.ts:9805`
 *     fork-based path into a function and wraps it. Real `consult()` body.
 *   - `AnthropicSdkAdvisor` (Plan 117-04) — the advisor runs in-request
 *     via the Claude Agent SDK's `advisorModel` option. There is no
 *     out-of-band call to make from the advisor service, so `consult()`
 *     THROWS a documented error (per RESEARCH §13.11). The service
 *     never dispatches to this backend via `consult()`; instead the
 *     advisor turn fires inside the agent's own SDK run, and the
 *     budget/observer pipeline records the call from the SDK stream.
 *   - `PortableForkAdvisor` (Plan 117-05) — scaffold stub that throws
 *     a Phase-118 deferred error. Not selectable in config (Plan 117-06).
 *
 * See:
 *   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-RESEARCH.md`
 *     (§3 file map, §13.11 native-backend dispatch semantics)
 *   - `/home/example-user/.claude/plans/eventual-questing-tiger.md` (Interfaces §, lines 106–115)
 */

import type { BackendId } from "../types.js";

/**
 * Pluggable advisor backend. Each backend handles one consultation
 * end-to-end and returns the raw answer text (untruncated). The
 * `AdvisorService` owns budget enforcement + truncation around it.
 */
export interface AdvisorBackend {
  readonly id: BackendId;

  /**
   * Perform one advisor consultation.
   *
   * - For `LegacyForkAdvisor`: forks the agent session under the
   *   advisor model, dispatches one turn, returns the assistant text.
   * - For `AnthropicSdkAdvisor`: THROWS — see file-level docs above.
   *   The advisor runs inside the agent's SDK call, not via this
   *   method. This backend exists in the registry so visibility
   *   plumbing (Discord footer, capability manifest) can resolve
   *   `id === "native"` uniformly.
   * - For `PortableForkAdvisor`: THROWS a Phase-118 deferred error.
   */
  consult(args: {
    agent: string;
    question: string;
    systemPrompt: string;
    advisorModel: string;
    /** Per-consult bound (ms); backends that cannot honour it ignore it. */
    timeoutMs?: number;
  }): Promise<{ answer: string }>;
}
