/**
 * `PortableForkBackend` — provider-neutral fork-style runtime SCAFFOLD ONLY.
 *
 * Phase 136 ships the seam shape; a future phase (Phase 14X — exact
 * number TBD when the use case stabilises) fills in the
 * implementation. The class exists so the runtime-backend abstraction
 * has more than one concrete shape from day one, which prevents the
 * `LlmRuntimeService` interface from accidentally specialising to
 * the Anthropic SDK over the next few phases.
 *
 * **Not selectable in config.** The Zod enum at
 * `src/config/schema.ts` accepts ONLY `"anthropic-agent-sdk"` at this
 * wave. Operators cannot route any agent to this backend until the
 * future phase widens the enum AND implements `loadSdkModule()`.
 *
 * **Calling `loadSdkModule()` throws** with a documented deferred-
 * error message that points at the future phase. This is the
 * Phase 117 precedent — `PortableForkAdvisor` at
 * `src/advisor/backends/portable-fork.ts:49` does the same.
 *
 * See:
 *   - `.planning/phases/136-llm-runtime-multi-backend/136-CONTEXT.md`
 *     §`<decisions>` D-01a — scaffold mirrors Phase 117
 *   - `src/advisor/backends/portable-fork.ts` — the exact pattern
 *     this file mirrors
 */

import type { ResolvedAgentConfig } from "../../shared/types.js";
import type {
  LlmRuntimeDeps,
  LlmRuntimeService,
  LlmRuntimeSdkModule,
} from "../types.js";

export class PortableForkBackend implements LlmRuntimeService {
  readonly backendId = "portable-fork" as const;

  constructor(
    private readonly config: ResolvedAgentConfig,
    private readonly deps: LlmRuntimeDeps,
  ) {
    void this.config;
    void this.deps;
  }

  async loadSdkModule(): Promise<LlmRuntimeSdkModule> {
    throw new Error(
      "portable-fork backend deferred — see Phase 14X scaffold",
    );
  }
}
