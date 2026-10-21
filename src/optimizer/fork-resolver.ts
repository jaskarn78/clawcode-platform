/**
 * Phase 142 follow-up — per-eval-fork LlmRuntime resolver registration.
 *
 * The measured optimizer forks a throwaway, isolated agent per eval sample via
 * `SessionManager.startAgent(forkName, evalConfig)` (see agent-runner.ts). The
 * daemon's `getLlmRuntime` closure throws for any name absent from the
 * boot-populated `llmRuntimeRegistry` and has **no fork-name fallback** — by
 * design: a fallback that stripped the `-fork-…-opt` suffix and reused the
 * PARENT's resolver would resolve the fork against the parent's skills, silently
 * defeating candidate-skill isolation (every eval would measure the parent).
 *
 * So the fork's resolver MUST be registered from the FORK config before
 * `startAgent` and removed after `stopAgent`. This mirrors the subagent-spawner
 * callback (daemon.ts ~9256) — but, because each optimizer eval fork is a
 * fully-awaited one-shot (start → dispatch → stop, all in one call), it is safe
 * to unregister afterward (no late-turn race; cf. the spawner's deliberate leak).
 *
 * This factory is extracted (rather than inlined at the daemon edge) so the
 * registration logic is unit-testable against the REAL code path — the same
 * blind spot that let the original 0%-score integration bug ship was an
 * un-exercised daemon-edge wiring.
 */
import type { ResolvedAgentConfig } from "../shared/types.js";
import type {
  AgentLlmRuntimeResolver,
  LlmRuntimeDeps,
} from "../llm-runtime/index.js";

export type OptimizerForkResolverDeps = {
  /** The daemon's per-agent resolver registry (keyed by agent / fork name). */
  readonly registry: Map<string, AgentLlmRuntimeResolver>;
  /** The real resolver factory — the daemon injects `createAgentLlmRuntimeResolver`. */
  readonly createResolver: (
    config: ResolvedAgentConfig,
    deps: LlmRuntimeDeps,
  ) => AgentLlmRuntimeResolver;
  readonly logger: LlmRuntimeDeps["logger"];
  /** The fork inherits the PARENT agent's OpenAI credentials (may be undefined). */
  readonly openaiCredentialsFor: (
    parentName: string,
  ) => LlmRuntimeDeps["openaiCredentials"];
  readonly failoverStateReader: LlmRuntimeDeps["failoverStateReader"];
  readonly mcpTracker: LlmRuntimeDeps["mcpTracker"];
  /**
   * Phase 142 follow-up — the op:// MCP-env resolver. Used ONLY when the eval
   * fork has a scoped tool surface (`evalMcpServers` granted servers), so the
   * allowlisted MCP servers get their op:// credentials resolved. Omitted for the
   * default tool-free fork (no mcpServers → no op:// envs to resolve). Optional so
   * tool-free callers/tests need not wire it.
   */
  readonly opEnvResolver?: LlmRuntimeDeps["opEnvResolver"];
};

export type OptimizerForkResolverCallbacks = {
  /** Register a resolver for `forkName`, built from the FORK config. Call BEFORE startAgent. */
  readonly registerLlmRuntime: (
    forkName: string,
    evalConfig: ResolvedAgentConfig,
    parentName: string,
  ) => void;
  /** Remove the fork's resolver. Call AFTER stopAgent. */
  readonly unregisterLlmRuntime: (forkName: string) => void;
};

export function makeOptimizerForkResolver(
  deps: OptimizerForkResolverDeps,
): OptimizerForkResolverCallbacks {
  return {
    registerLlmRuntime: (forkName, evalConfig, parentName) => {
      // Build the resolver from the FORK config (candidate skills, headless),
      // NEVER from the parent — candidate-skill isolation depends on it.
      //
      // `opEnvResolver` is wired ONLY when the fork was granted a scoped tool
      // surface (evalConfig.mcpServers non-empty) so those allowlisted servers
      // get their op:// creds resolved. For the default tool-free fork it stays
      // omitted (no mcpServers → no op:// envs to resolve).
      const hasTools = (evalConfig.mcpServers?.length ?? 0) > 0;
      deps.registry.set(
        forkName,
        deps.createResolver(evalConfig, {
          logger: deps.logger,
          openaiCredentials: deps.openaiCredentialsFor(parentName),
          failoverStateReader: deps.failoverStateReader,
          mcpTracker: deps.mcpTracker,
          ...(hasTools && deps.opEnvResolver
            ? { opEnvResolver: deps.opEnvResolver }
            : {}),
        }),
      );
    },
    unregisterLlmRuntime: (forkName) => {
      deps.registry.delete(forkName);
    },
  };
}
