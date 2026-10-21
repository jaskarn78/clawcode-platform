/**
 * Phase 138 Plan 01 T-04 — `phase138-usage` per-turn cost-telemetry hook.
 *
 * **Seam (silent-path-bifurcation safe):** the hook is installed at the
 * SINGLE unified per-turn usage callback in `session-manager.ts`. Both
 * backends — `AnthropicAgentSdkBackend` and `CodexAgentCli` — route
 * their turn-terminating `result`-message usage through the same
 * `UsageCallback` (built once per agent at session start). Wrapping
 * that one callback fires the tracker for BOTH providers from ONE
 * consumer — there is no per-backend duplication and no risk of one
 * production path silently skipping telemetry.
 *
 * The plan's T-04 `<action>` prescribed wiring the hook into the two
 * backend files (`anthropic-agent-sdk.ts` / `codex-agent-cli.ts`), but
 * those files only implement `loadSdkModule()` — they never iterate an
 * `SdkQuery` or observe a `result` message. The plan's own
 * `researcher_todo #2` anticipated this ("adapt rather than duplicate").
 * Relocating the hook to the unified callback is a Rule 3 fix; see
 * `138-01-SUMMARY.md` Deviations.
 *
 * **Threat T-138-01-01 (Info Disclosure):** the `phase138-usage` log
 * payload is a statically-fixed allow-list — `{agent, provider, model,
 * tokens_in, tokens_out, cost_usd, turn_count, date}`. NO api key path,
 * NO message bodies, NO system prompt, NO tool definitions. The T-04c
 * unit test asserts the exact key set.
 *
 * See:
 *   - `src/usage/provider-usage-tracker.ts` — the SQLite tracker.
 *   - `src/manager/session-manager.ts` — the install site.
 *   - `.planning/phases/138-.../138-01-PLAN.md` T-04.
 */

import type { ProviderUsageTracker } from "./provider-usage-tracker.js";
import { estimateCost } from "./pricing.js";

/** Operator-greppable structured-log key for the per-turn usage line. */
export const PHASE138_USAGE_LOG_KEY = "phase138-usage";

/**
 * Shape of the per-turn usage data delivered by the unified
 * `UsageCallback` (`src/manager/session-adapter.ts:UsageCallback`).
 * Re-declared here (not imported) to keep `src/usage/` free of a
 * `src/manager/` dependency edge.
 */
export interface TurnUsageData {
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cost_usd: number;
  readonly turns: number;
  readonly model: string;
  readonly duration_ms: number;
}

/** Minimal pino-compatible logger surface. */
interface HookLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/** Construction args for {@link buildProviderUsageHook}. */
export interface ProviderUsageHookArgs {
  /**
   * Per-agent tracker. Optional: absent in tests / pre-138 deploys —
   * the hook then still emits the `phase138-usage` log line (operator-
   * side visibility) but skips the SQLite write.
   */
  readonly tracker: ProviderUsageTracker | undefined;
  /** Agent name — recorded + logged. */
  readonly agent: string;
  /**
   * The agent's resolved `llmRuntime.backend` id. Mapped to a provider
   * via {@link backendToProvider}. `undefined` → Phase 136 baseline →
   * `'anthropic'`.
   */
  readonly backend: string | undefined;
  /** Optional structured logger. */
  readonly logger?: HookLogger;
  /** Wall clock (unix millis) — defaults to `Date.now`; injected in tests. */
  readonly clock?: () => number;
}

/**
 * Map an `llmRuntime.backend` id to the LLM PROVIDER name the
 * `provider_usage` table keys on.
 *
 * `codex-cli` → `'openai'`; everything else (including the Phase 136
 * baseline `anthropic-agent-sdk`, `undefined`, and any unrecognised
 * future id) → `'anthropic'`. Backend-id-driven, NOT model-name
 * inference — model-name regex would misattribute during the Plan 04
 * failover window when a codex-cli agent's result message can briefly
 * report a Claude model (or vice versa).
 */
export function backendToProvider(backend: string | undefined): string {
  return backend === "codex-cli" ? "openai" : "anthropic";
}

/**
 * Build the per-turn usage hook. The returned function is invoked once
 * per completed turn (from inside the unified `UsageCallback`). It:
 *   1. derives the provider from the backend id,
 *   2. calls `tracker.recordTurn(...)` (when a tracker is present),
 *   3. emits the `phase138-usage` structured log line.
 *
 * Fail-silent: any error inside the hook is swallowed (optionally
 * `logger.warn`-ed) — telemetry MUST NEVER break the turn flow. This
 * mirrors the observational-only contract of the existing
 * `extractUsage` callback path.
 */
export function buildProviderUsageHook(
  args: ProviderUsageHookArgs,
): (data: TurnUsageData) => void {
  const { tracker, agent, backend, logger } = args;
  const clock = args.clock ?? Date.now;
  const provider = backendToProvider(backend);

  return (data: TurnUsageData): void => {
    try {
      const now = clock();
      const date = new Date(now).toISOString().slice(0, 10);

      // THIS turn's cost — locally derived from token counts × the
      // `pricing.ts` rates. This is the value the Plan 03 / 04 cap
      // thresholds compare against; `data.cost_usd` from the SDK result
      // message may be absent or provider-formatted differently, so we
      // recompute rather than trust it.
      const turnCostUsd = estimateCost(
        data.model,
        data.tokens_in,
        data.tokens_out,
      );

      // recordTurn returns the upserted row — `turn_count` is the
      // accumulated day total. When no tracker is wired (tests /
      // pre-138 deploy), fall back to 0 so the log line still emits.
      let turnCount = 0;
      if (tracker) {
        const row = tracker.recordTurn({
          agent,
          provider,
          model: data.model,
          tokensIn: data.tokens_in,
          tokensOut: data.tokens_out,
        });
        turnCount = row.turn_count;
      }

      // STATIC ALLOW-LIST — Threat T-138-01-01. Only these 8 keys.
      // NO apiKeyPath, NO message bodies, NO system prompt, NO tools.
      if (logger) {
        logger.info(
          {
            agent,
            provider,
            model: data.model,
            tokens_in: data.tokens_in,
            tokens_out: data.tokens_out,
            cost_usd: turnCostUsd,
            turn_count: turnCount,
            date,
          },
          PHASE138_USAGE_LOG_KEY,
        );
      }
    } catch (err) {
      // Observational only — never break the turn flow.
      try {
        logger?.warn(
          { agent, err: err instanceof Error ? err.message : String(err) },
          "phase138-usage hook failed (non-fatal)",
        );
      } catch {
        // logger itself threw — give up silently.
      }
    }
  };
}
