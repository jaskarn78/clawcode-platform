/**
 * Phase 142 — production forked agent runner (the eval harness's integration
 * adapter).
 *
 * Each call forks a throwaway, headless, isolated session pinned to a
 * candidate-skills workspace, runs ONE turn, and tears the session down in a
 * finally — mirroring the proven escalation.ts fork→dispatch→stop pattern.
 *
 * Isolation wiring (OUR half — confirmed in session-adapter.ts:1481-1529 +
 * resolveSessionCwd):
 *   - workspace = candidate dir, gsd = undefined  ⇒ session cwd = workspace
 *   - settingSources = ["project"]                ⇒ SDK loads .claude/skills from cwd
 *
 * ⚠️ Whether a forked SDK session then loads ONLY that dir (and not also
 * ~/.claude) is the load-bearing assumption this phase rides on. It is NOT
 * proven by this module's unit tests (they mock SessionManager and only verify
 * the orchestration contract). It is verified by scripts/isolation-spike.ts,
 * which MUST be run live before the optimize→keep loop (P3) is trusted.
 */
import { buildForkName, buildForkConfig } from "../manager/fork.js";
import type { ResolvedAgentConfig } from "../shared/types.js";
import type { AgentRunner, AgentRunResult } from "./types.js";

/**
 * Minimal SessionManager surface the runner needs — keeps the optimizer
 * decoupled from the full daemon class and makes the contract mockable.
 */
export type EvalSessionManager = {
  startAgent(name: string, config: ResolvedAgentConfig): Promise<void>;
  dispatchTurn(name: string, message: string): Promise<string>;
  stopAgent(name: string): Promise<void>;
};

export type ForkedRunnerDeps = {
  readonly sessionManager: EvalSessionManager;
  /** The live agent whose config the eval fork inherits. */
  readonly parentConfig: ResolvedAgentConfig;
  /** Candidate-skills dir (becomes the fork's cwd). */
  readonly workspace: string;
  /** Skill names to expose (matches the staged candidate set). */
  readonly skillNames: readonly string[];
  /** Throwaway memory dir — isolated from the live agent's memory. */
  readonly memoryPath: string;
  /**
   * Phase 142 follow-up — fail-closed allowlist of MCP server NAMES the eval
   * fork may use. Default/unset/`[]` = TOOL-FREE (original behavior). Only servers
   * that are BOTH listed here AND attached to the parent are granted to the fork;
   * everything else is dropped. The operator must list ONLY whole-server read-only
   * servers (the fork runs the full agent and may auto-invoke tools). Pairs with a
   * restored `opEnvResolver` in the fork resolver (see fork-resolver.ts).
   */
  readonly evalMcpServers?: readonly string[];
  /**
   * Phase 142 fix — register a per-fork LlmRuntime resolver (built from the
   * FORK config) BEFORE startAgent. The daemon's `getLlmRuntime` has no
   * fork-name fallback, so an unregistered fork throws in the SdkSessionAdapter
   * constructor ("No LlmRuntime resolver registered") → fail-closed 0% score.
   * Optional so the unit tests (which mock SessionManager) need not wire it.
   */
  readonly registerLlmRuntime?: (
    forkName: string,
    evalConfig: ResolvedAgentConfig,
    parentName: string,
  ) => void;
  /** Remove the fork's resolver AFTER stopAgent (one-shot fork → safe to unregister). */
  readonly unregisterLlmRuntime?: (forkName: string) => void;
  readonly log?: (obj: Record<string, unknown>, msg: string) => void;
};

/**
 * Build a production {@link AgentRunner} bound to a candidate-skills workspace.
 */
export function makeForkedAgentRunner(deps: ForkedRunnerDeps): AgentRunner {
  return async (prompt: string): Promise<AgentRunResult> => {
    const forkName = `${buildForkName(deps.parentConfig.name)}-opt`;
    const base = buildForkConfig(deps.parentConfig, forkName);
    // Phase 142 follow-up — fail-closed scoped tool surface. buildForkConfig
    // inherits the parent's mcpServers; we keep ONLY those the operator
    // explicitly allowlisted via `evalMcpServers` AND that are attached to the
    // parent. Unset/empty allowlist → `[]` (TOOL-FREE, the original behavior:
    // a throwaway fork must not spin up the parent's full MCP fleet per sample).
    // Tools are granted per-server, so the allowlist must contain only
    // whole-server read-only servers.
    const allow = new Set(deps.evalMcpServers ?? []);
    const scopedMcpServers =
      allow.size === 0
        ? []
        : (base.mcpServers ?? []).filter((s) => allow.has(s.name));
    const evalConfig: ResolvedAgentConfig = {
      ...base,
      workspace: deps.workspace,
      gsd: undefined,
      memoryPath: deps.memoryPath,
      settingSources: ["project"],
      skills: [...deps.skillNames],
      mcpServers: scopedMcpServers,
    };

    // Phase 142 fix — register the fork's LlmRuntime resolver (from the FORK
    // config) BEFORE startAgent. Without it the daemon's getLlmRuntime throws in
    // the SdkSessionAdapter constructor and the eval fail-closes to 0%.
    deps.registerLlmRuntime?.(forkName, evalConfig, deps.parentConfig.name);

    let started = false;
    try {
      await deps.sessionManager.startAgent(forkName, evalConfig);
      started = true;
      const response = await deps.sessionManager.dispatchTurn(forkName, prompt);
      return { response };
    } finally {
      // Teardown discipline (escalation precedent): ALWAYS stop the throwaway
      // session if it started, even when the turn threw, or it leaks a PID +
      // memory scanner. (Skip stopAgent when startAgent itself threw — there is
      // no session to stop.)
      if (started) {
        try {
          await deps.sessionManager.stopAgent(forkName);
        } catch (err) {
          deps.log?.(
            {
              fork: forkName,
              error: err instanceof Error ? err.message : String(err),
            },
            "optimizer: stopAgent failed during eval teardown (best-effort)",
          );
        }
      }
      // Phase 142 fix — always remove the fork's resolver (registered above),
      // even if startAgent threw. Safe: this fork is a fully-awaited one-shot,
      // so no later turn needs the resolver (cf. the subagent spawner's
      // deliberate leak, which CAN race a late turn).
      deps.unregisterLlmRuntime?.(forkName);
    }
  };
}
