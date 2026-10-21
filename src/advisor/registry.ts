/**
 * Advisor backend registry + per-agent backend resolution.
 *
 * Two surfaces:
 *   1. `resolveBackend(agent, agentConfig, defaults)` — pure config
 *      lookup that maps `advisor.backend` from per-agent or defaults
 *      blocks to a `BackendId`. Defaults to `"native"` when neither
 *      side specifies. Defensively rejects `"portable-fork"` (Plan
 *      117-06's schema also rejects it; this is belt-and-braces).
 *   2. `BackendRegistry` — runtime map of registered backend
 *      implementations, looked up by id when `AdvisorService.ask()`
 *      dispatches a consultation.
 *
 * The model alias resolver re-exported from `src/manager/model-resolver.ts`
 * (added in Plan 117-02 T04) lives there alongside the existing
 * executor-model resolver to keep all alias maps in one file.
 *
 * See:
 *   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-RESEARCH.md`
 *     (§3 file map row for `src/advisor/registry.ts`, §13.7 model alias)
 *   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-CONTEXT.md`
 *     (decisions.Architecture — `"portable-fork"` not selectable in Phase 117)
 */

import type { BackendId } from "./types.js";
import type { AdvisorBackend } from "./backends/types.js";

// Re-export the alias resolver so call sites can import everything
// advisor-related from `src/advisor/` (per `index.ts` re-export contract).
export { resolveAdvisorModel, ADVISOR_MODEL_ALIASES } from "../manager/model-resolver.js";

/** Minimal shape of the `advisor` config block consulted by `resolveBackend`. */
type AdvisorConfigSlice = { advisor?: { backend?: BackendId } } | undefined;

/**
 * Resolve which backend should handle advisor calls for an agent.
 *
 * Precedence (highest to lowest):
 *   1. Per-agent `advisor.backend` (when set)
 *   2. `defaults.advisor.backend` (when set)
 *   3. `"native"` (hard-coded fallback — Phase 117's default backend)
 *
 * `"portable-fork"` is intentionally NOT selectable in Phase 117 —
 * Plan 117-05 ships only an interface-conformant stub. Plan 117-06's
 * config schema rejects it at parse time; this function adds a
 * defensive coercion to `"native"` in case anything sneaks through
 * (e.g. an old config loaded by an older parser).
 *
 * @param _agentName - Reserved for future per-agent overrides
 *   (logging, fine-grained routing). Currently unused by the resolver
 *   itself but kept in the signature for stability.
 */
export function resolveBackend(
  _agentName: string,
  agentConfig: AdvisorConfigSlice,
  defaults: AdvisorConfigSlice,
): BackendId {
  const requested =
    agentConfig?.advisor?.backend ?? defaults?.advisor?.backend ?? "native";
  if (requested === "portable-fork") {
    // Defensive: schema (Plan 117-06) rejects this, but the registry
    // must not select it under any circumstances in Phase 117.
    return "native";
  }
  return requested;
}

/**
 * In-memory registry of advisor backend implementations. The
 * `DefaultAdvisorService` looks up a backend by id at dispatch time
 * via `get(id)`. Implementations are registered at process boot once
 * Plans 117-03 / 117-04 / 117-05 land.
 */
export class BackendRegistry {
  private readonly backends = new Map<BackendId, AdvisorBackend>();

  /** Register or replace a backend by its `id`. */
  register(b: AdvisorBackend): void {
    this.backends.set(b.id, b);
  }

  /**
   * Look up a registered backend. Throws if not registered — surfacing
   * a config/boot bug loudly rather than silently falling back to
   * another backend (which would mask drift between config and runtime).
   */
  get(id: BackendId): AdvisorBackend {
    const b = this.backends.get(id);
    if (!b) {
      throw new Error(`AdvisorBackend "${id}" not registered`);
    }
    return b;
  }

  /** Whether an id is currently registered (for capability probes). */
  has(id: BackendId): boolean {
    return this.backends.has(id);
  }
}
