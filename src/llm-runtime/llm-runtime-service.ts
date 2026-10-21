/**
 * `createLlmRuntimeService` — factory that returns the configured
 * backend per agent.
 *
 * Phase 136 ships ONE backend (`anthropic-agent-sdk`, current
 * behaviour). The factory dispatches on `config.llmRuntime.backend`;
 * Phase 137 widens the switch to add `anthropic-api-key`, Phase 138+
 * add the rest.
 *
 * **Construction-site invariant** (per CONTEXT.md D-03a +
 * `feedback_silent_path_bifurcation`): exactly ONE call to
 * `createLlmRuntimeService` per agent per session in the daemon.
 * The resulting `LlmRuntimeService` is threaded into every
 * downstream consumer (`session-adapter`, `persistent-session-
 * handle`, compaction triggers, template driver) via dependency
 * injection. There must be NO direct
 * `await import("@anthropic-ai/claude-agent-sdk")` outside
 * `src/llm-runtime/backends/anthropic-agent-sdk.ts` — enforced by
 * the static-grep CI test (T-06).
 *
 * **Telemetry** (D-07): one `phase136-llm-runtime` structured log
 * line per agent at factory time. Operators grep
 * `journalctl -u clawcode -g phase136-llm-runtime` to confirm
 * migration coverage across the fleet.
 *
 * See:
 *   - `./types.ts` — interface + backend enum + deps shape
 *   - `./backends/anthropic-agent-sdk.ts` — the ONLY runtime
 *     `@anthropic-ai/claude-agent-sdk` import site
 *   - `./backends/portable-fork.ts` — Phase 14X scaffold; throws on
 *     load; not selectable in Zod enum
 *   - `.planning/phases/136-llm-runtime-multi-backend/136-01-PLAN.md`
 *     T-02 spec
 *   - `src/advisor/registry.ts` — Phase 117 template for backend
 *     resolution (this file is the LlmRuntime parallel)
 */

import type { ResolvedAgentConfig } from "../shared/types.js";
import type { LlmRuntimeDeps, LlmRuntimeService } from "./types.js";
import { AnthropicAgentSdkBackend } from "./backends/anthropic-agent-sdk.js";
import { CodexAgentCli } from "./backends/codex-agent-cli.js";
import { ClaudeCodeInteractiveBackend } from "./backends/claude-code-interactive.js";

/**
 * Construct an `LlmRuntimeService` for the given agent.
 *
 * Phase 136 dispatches on `config.llmRuntime.backend`. The default
 * (set by the Zod resolver in `src/config/loader.ts`) is
 * `"anthropic-agent-sdk"` so agents without an `llmRuntime` block
 * in clawcode.yaml continue to use the current production behaviour
 * with zero change.
 *
 * Emits one structured log line at construction (key
 * `phase136-llm-runtime`) so operators can audit migration coverage
 * via journalctl. The log goes through `deps.logger` when supplied
 * (production path — the daemon's pino logger); when omitted (unit
 * tests), falls back to `console.info` to keep the telemetry path
 * single-source.
 *
 * @param config Resolved per-agent config (post-defaults merge).
 *               Must carry `config.llmRuntime.backend`.
 * @param deps   Constructor-injected dependencies. Optional logger
 *               is the only field today; Phase 137 widens.
 * @returns      An `LlmRuntimeService` for this agent's session
 *               lifetime. Cached at backend level for ESM module
 *               reuse (Node's dynamic-import cache is shared per
 *               process anyway).
 */
export function createLlmRuntimeService(
  config: ResolvedAgentConfig,
  deps: LlmRuntimeDeps = {},
): LlmRuntimeService {
  // Default to the Phase 136 baseline backend when the resolver
  // (T-05 in `src/config/loader.ts`) hasn't populated the field
  // yet. After Phase 136 fully lands, the loader ALWAYS sets this
  // — the `?? { backend: "anthropic-agent-sdk" }` is back-compat
  // for unit-test ResolvedAgentConfig factories that don't go
  // through the resolver.
  const configuredBackend =
    config.llmRuntime?.backend ?? "anthropic-agent-sdk";

  // Phase 138 Plan 05 T-03 — runtime-state failover override. Read the
  // `failover_state` row for this agent BEFORE the dispatch switch
  // (CONTEXT D3 — override > config). When an unexpired override row
  // exists, the agent's NEXT turn dispatches to the override backend
  // with NO daemon restart and clawcode.yaml UNTOUCHED. The override
  // value is one of the valid backend IDs by FailoverStateStore's write
  // invariant (T-01 only writes `LlmRuntimeBackend` values) — the
  // factory does no defensive re-validation.
  const overrideBackend = deps.failoverStateReader?.getActiveBackend(
    config.name,
    Date.now(),
  );
  const backend = overrideBackend ?? configuredBackend;

  // phase136-llm-runtime ALWAYS reports the CONFIGURED backend — it is
  // the migration-coverage signal and must not drift when a failover is
  // active. phase138-failover-active is ADDITIVE: it fires only when an
  // override is in effect AND actually changes the effective backend.
  const telemetry = {
    agent: config.name,
    backend: configuredBackend,
    model: config.model,
  };
  if (deps.logger) {
    deps.logger.info(telemetry, "phase136-llm-runtime");
    if (overrideBackend && overrideBackend !== configuredBackend) {
      deps.logger.info(
        {
          agent: config.name,
          configured: configuredBackend,
          active: overrideBackend,
        },
        "phase138-failover-active",
      );
    }
  } else {
    // eslint-disable-next-line no-console
    console.info("phase136-llm-runtime", JSON.stringify(telemetry));
    if (overrideBackend && overrideBackend !== configuredBackend) {
      // eslint-disable-next-line no-console
      console.info(
        "phase138-failover-active",
        JSON.stringify({
          agent: config.name,
          configured: configuredBackend,
          active: overrideBackend,
        }),
      );
    }
  }

  switch (backend) {
    case "anthropic-agent-sdk":
      return new AnthropicAgentSdkBackend(config, deps);
    case "codex-cli":
      // Phase 137 Plan 01 T-03 — dispatch to the SHELL backend.
      // Construction emits `phase137-codex-backend` + kicks off
      // discovery; `loadSdkModule()` throws the documented Plan-03
      // deferral error until Plans 02–05 fill in the wire shape.
      return new CodexAgentCli(config, deps);
    case "claude-code-interactive":
      // Phase 140 Plan 01 — dispatch to the v3 native-channels SHELL backend.
      // Construction emits `phase140-claude-channels` + kicks off `claude`
      // binary discovery; `loadSdkModule()` returns an inert
      // FakeChannelsSdkModule (mutators throw). The PTY supervisor + live
      // channel socket land in Stage 2.
      //
      // Phase 999.83-02 (Fix A) — forward `deps.firstTurnInput` (the spawning
      // subagent's task) into the backend's seams so the warm-nudge fire loop
      // delivers it as the agent's first real PTY turn-trigger. The constructor
      // takes seams as its 4th arg (`discoveryDeps` is the 3rd — production
      // leaves it undefined). For a non-subagent / no-task session the daemon
      // path leaves `firstTurnInput` undefined → default warm-nudge, unchanged.
      // Phase 999.84 Plan 04 — thread `llmRuntime.includeDiscordPlugin`
      // through the existing InteractiveBackendSeams.includeDiscordPlugin
      // path so the per-agent config field (Model A opt-in) reaches the
      // buildChannelsArgv call at claude-code-interactive.ts:1067.
      // `undefined` (default) → seam reads `?? false` → Model B
      // (server:clawcode-channel only). `true` → Model A
      // (server:clawcode-channel + plugin:discord@claude-plugins-official).
      return new ClaudeCodeInteractiveBackend(config, deps, undefined, {
        firstTurnInput: deps.firstTurnInput,
        includeDiscordPlugin: config.llmRuntime?.includeDiscordPlugin,
        // Phase 141 (#4) — thread the per-agent v3 permission mode into the
        // backend seam → buildChannelsArgv's `--permission-mode` flag.
        permissionMode: config.llmRuntime?.permissionMode,
        // Phase 999.86 — pool-driven workers stay parked on the menu prompt;
        // the warm-nudge + firstTurnInput schedules are both suppressed so
        // the pool's later `\r<msg>\n` PTY write is the FIRST input claude
        // sees. The dispatcher delivers it when a Discord message arrives.
        deferFirstTurn: deps.deferFirstTurn,
      });
    default: {
      // The Zod enum should prevent us from reaching this branch,
      // but TypeScript's exhaustiveness check is paranoia-cheap.
      const unreachable: never = backend;
      throw new Error(
        `Unknown llmRuntime.backend: ${String(unreachable)} (agent=${config.name})`,
      );
    }
  }
}

/**
 * A per-agent runtime resolver — a function that returns an
 * `LlmRuntimeService` for the agent it was bound to.
 *
 * Phase 138 Plan 04 makes the per-turn dispatch path consume this
 * type instead of a boot-cached `LlmRuntimeService` instance.
 */
export type AgentLlmRuntimeResolver = () => LlmRuntimeService;

/**
 * The structured-log key the factory emits once per construction.
 * The resolver memoizes on the effective backend so this line fires
 * on a backend CHANGE only — not on every per-turn invocation.
 */
const PHASE136_LLM_RUNTIME_LOG = "phase136-llm-runtime";

/**
 * Phase 138 Plan 04 T-01 — per-agent **lazy** runtime resolver.
 *
 * Returns a function that RE-INVOKES `createLlmRuntimeService(config,
 * deps)` on every call. This is the keystone construct that keeps the
 * per-turn dispatch path lazy enough for 138-05's failover override.
 *
 * **Why design (a) — factory re-invoked per turn — is REQUIRED, not a
 * preference.** 138-05's failover check (138-05 T3) lives INSIDE
 * `createLlmRuntimeService`: it reads `deps.failoverStateReader?.
 * getActiveBackend(...)` BEFORE the backend `switch`. CONTEXT D3 locks
 * the dispatch contract — "factory dispatch reads `failover_state.
 * active_backend` BEFORE falling through to `config.llmRuntime.
 * backend`". A boot-cached `LlmRuntimeService` instance would freeze
 * the backend selection at boot and never see a runtime
 * `failover_state` override. Re-invoking the factory per turn means a
 * 138-05 `failoverStateReader` injected via `deps` is consulted every
 * turn — so 138-05's T3 lands with ZERO changes to the dispatch path.
 *
 * **The memoized-telemetry contract.** Re-invoking the factory per
 * turn would otherwise fire its `phase136-llm-runtime` telemetry line
 * on every turn (7 agents × N turns/day), flooding journald and
 * breaking operator greps that COUNT the line for migration coverage.
 * The resolver suppresses that: it owns a closure-local
 * `lastEmittedBackend` and wraps `deps.logger` so the
 * `phase136-llm-runtime` message is forwarded ONLY when the effective
 * backend (`config.llmRuntime?.backend ?? "anthropic-agent-sdk"`)
 * differs from `lastEmittedBackend`. First call always emits
 * (`lastEmittedBackend` is `undefined`); subsequent same-backend
 * calls suppress; a backend change re-emits. Every OTHER log line the
 * factory or backends emit — including 138-05's future
 * `phase138-failover-active` — passes through untouched (the wrapper
 * gates ONLY the exact `phase136-llm-runtime` message string).
 *
 * **Boot-priming dependency (T-03 / T-05).** Under design (a) the
 * first `phase136-llm-runtime` emission would otherwise slip from
 * boot to first-turn-after-boot (minutes/hours later for an idle
 * agent), breaking operator greps in a fixed post-restart window. The
 * daemon (138-04 T-03) PRIMES each resolver once in the per-agent
 * boot loop (`resolver()`, returned instance discarded) so the
 * boot-time emission timing is preserved. The priming call warms this
 * resolver's `lastEmittedBackend` memo.
 *
 * `createLlmRuntimeService` itself is UNCHANGED — same signature,
 * same body. 138-05 T3 extends the factory; 138-04 must not pre-empt
 * that. This resolver is a thin NEW wrapper over the existing factory.
 *
 * @param config Resolved per-agent config (post-defaults merge).
 * @param deps   Constructor-injected dependencies (logger, OpenAI
 *               credentials today; 138-05 widens with
 *               `failoverStateReader`).
 * @returns      An `AgentLlmRuntimeResolver` — call it per turn.
 */
export function createAgentLlmRuntimeResolver(
  config: ResolvedAgentConfig,
  deps: LlmRuntimeDeps = {},
): AgentLlmRuntimeResolver {
  // Closure-local memo of the last effective backend whose
  // `phase136-llm-runtime` line was forwarded. `undefined` until the
  // first invocation, so the first call always emits.
  let lastEmittedBackend: string | undefined;

  // The real logger sink. When `deps.logger` is absent we still want
  // the factory to take the `deps.logger` branch (deterministic
  // suppression) — so we synthesize a console-backed shim that mirrors
  // the factory's no-logger `console.info` fallback.
  const realInfo: (obj: unknown, msg?: string) => void = deps.logger
    ? deps.logger.info.bind(deps.logger)
    : (obj: unknown, msg?: string): void => {
        // eslint-disable-next-line no-console
        if (msg !== undefined) console.info(msg, JSON.stringify(obj));
        else console.info(JSON.stringify(obj));
      };
  const realWarn: (obj: unknown, msg?: string) => void = deps.logger
    ? deps.logger.warn.bind(deps.logger)
    : (obj: unknown, msg?: string): void => {
        // eslint-disable-next-line no-console
        if (msg !== undefined) console.warn(msg, JSON.stringify(obj));
        else console.warn(JSON.stringify(obj));
      };

  return (): LlmRuntimeService => {
    // Compute the effective backend BEFORE calling the factory so the
    // suppression decision keys on the same value the factory uses.
    const effectiveBackend =
      config.llmRuntime?.backend ?? "anthropic-agent-sdk";
    const suppressPhase136 = effectiveBackend === lastEmittedBackend;
    lastEmittedBackend = effectiveBackend;

    // Wrap the logger so ONLY the `phase136-llm-runtime` message is
    // gated. Every other line passes through verbatim — including any
    // future `phase138-failover-active` 138-05 emits.
    const wrappedDeps: LlmRuntimeDeps = {
      ...deps,
      logger: {
        info: (obj: unknown, msg?: string): void => {
          if (msg === PHASE136_LLM_RUNTIME_LOG && suppressPhase136) {
            return;
          }
          realInfo(obj, msg);
        },
        warn: realWarn,
      },
    };

    return createLlmRuntimeService(config, wrappedDeps);
  };
}
