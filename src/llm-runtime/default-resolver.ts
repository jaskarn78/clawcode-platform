/**
 * Phase 138 Plan 04 T-02 — seam-side default runtime resolver.
 *
 * `defaultAgentLlmRuntimeResolver()` returns an
 * `AgentLlmRuntimeResolver` whose `loadSdkModule()` delegates straight
 * to `loadAnthropicAgentSdkModule()` — the default `anthropic-agent-
 * sdk` backend, byte-identical to the pre-138-04 `loadSdk()` free
 * function that lived in `session-adapter.ts`.
 *
 * **Why this lives inside `src/llm-runtime/`.** The 138-04 T-08
 * static-grep sentinel asserts `loadAnthropicAgentSdkModule` has ZERO
 * callers outside `src/llm-runtime/`. `SdkSessionAdapter` still needs
 * a no-arg construction path (`new SdkSessionAdapter()` —
 * `src/cli/commands/run.ts:68` + the test suite) that resolves the
 * SDK without an injected per-agent resolver. Putting the default
 * resolver here keeps the only reference to `loadAnthropicAgentSdk-
 * Module` inside the seam: `session-adapter.ts` imports
 * `defaultAgentLlmRuntimeResolver` and never touches the free
 * function directly.
 *
 * The default resolver is agent-agnostic — the `anthropic-agent-sdk`
 * backend has no per-agent identity, so the no-arg adapter's
 * `getLlmRuntime` closure ignores the agent name. Failover (138-05)
 * does NOT apply to the default resolver — only the daemon's
 * per-agent `createAgentLlmRuntimeResolver` registry is failover-aware.
 *
 * See:
 *   - `.planning/phases/138-.../138-04-PLAN.md` T-02
 *   - `src/llm-runtime/backends/anthropic-agent-sdk.ts` — the only
 *     `@anthropic-ai/claude-agent-sdk` import site
 */

import type {
  AgentLlmRuntimeResolver,
} from "./llm-runtime-service.js";
import type { LlmRuntimeService, LlmRuntimeSdkModule } from "./types.js";
import { loadAnthropicAgentSdkModule } from "./backends/anthropic-agent-sdk.js";

/**
 * An `LlmRuntimeService` that loads the default `anthropic-agent-sdk`
 * backend. Delegates `loadSdkModule()` to the shared free-function
 * chokepoint — same `cachedModule` singleton, same not-installed
 * error string, same `SdkModule` shape as every other call path.
 */
function createDefaultLlmRuntimeService(): LlmRuntimeService {
  return {
    loadSdkModule(): Promise<LlmRuntimeSdkModule> {
      return loadAnthropicAgentSdkModule();
    },
  };
}

/**
 * Return a default per-agent runtime resolver — the seam-side fallback
 * used when no per-agent resolver is injected (`new SdkSessionAdapter()`
 * with no args). Behaviour is byte-identical to the pre-138-04
 * `loadSdk()` for the default backend.
 */
export function defaultAgentLlmRuntimeResolver(): AgentLlmRuntimeResolver {
  return (): LlmRuntimeService => createDefaultLlmRuntimeService();
}
