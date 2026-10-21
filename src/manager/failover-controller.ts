/**
 * Phase 138 Plan 05 T-04 — failover controller.
 *
 * Two pieces, deliberately split:
 *
 *   1. `evaluateFailoverDecisions` — a PURE function. Zero I/O, zero
 *      SQL, zero imports of `Database` / `Cron` / `WebhookManager`. It
 *      is the failover STATE MACHINE: given the saturated providers,
 *      the per-agent resolved configs, the current `failover_state`
 *      rows, and a clock, it returns the set of `FailoverDecision`s to
 *      apply plus the list of expired agents to clear. State-machine
 *      code is exactly what TDD was designed for — extracting it as a
 *      pure transform lets the unit tests cover the FULL state space
 *      without SQLite or cron.
 *
 *   2. `FailoverController` — the I/O wrapper. Reads SQL state via
 *      injected callbacks, calls the pure function, applies the
 *      decisions via `failoverStateStore.set(...)` / `.clear(...)`, and
 *      fires a fire-and-forget Discord alert per decision. ALL the
 *      effectful concerns live here.
 *
 * **The Plan 03 → Plan 05 contract.** `ThresholdAlerter` (Plan 03)
 * ALERTS at 95% and records a `provider_alert_state` row. This
 * controller's cron tick reads those rows (today's `threshold=95`
 * entries) to know which providers are saturated, then decides + applies
 * the failover. Strict layering: Plan 03 never decides; Plan 05 never
 * alerts at threshold (it only confirms the FAILOVER fired).
 *
 * **Auto-expiry (CONTEXT D8).** A `threshold-95` failover row's
 * `expires_at` is the next UTC midnight after the trigger — when the
 * provider's daily cap rolls over the failover lifts. Manual operator
 * overrides (`clawcode failover set`) have `expires_at = NULL` and
 * persist until cleared.
 *
 * See:
 *   - `.planning/phases/138-.../138-CONTEXT.md` D3 / D8
 *   - `.planning/phases/138-.../138-03-SUMMARY.md` — the contract
 *   - `src/usage/failover-state.ts` — FailoverStateStore
 */

import type { LlmRuntimeBackend } from "../llm-runtime/types.js";

/**
 * Provider-name → backend-ID mapping. The `provider_usage` /
 * `provider_alert_state` tables key on a provider name (`anthropic` |
 * `openai`); an agent's `llmRuntime.backend` is a backend ID. An agent
 * is "on" a saturated provider when its backend maps to that provider.
 */
const PROVIDER_BACKEND: Readonly<Record<string, LlmRuntimeBackend>> = {
  anthropic: "anthropic-agent-sdk",
  openai: "codex-cli",
};

/** Inverse of {@link PROVIDER_BACKEND} — backend ID → provider name. */
const BACKEND_PROVIDER: Readonly<Record<LlmRuntimeBackend, string>> = {
  "anthropic-agent-sdk": "anthropic",
  "codex-cli": "openai",
  // Phase 140 — v3 native channels drives the `claude` binary via subscription
  // OAuth, so it maps to the Anthropic provider for saturation accounting.
  "claude-code-interactive": "anthropic",
};

/** Why a failover row exists. `threshold-95` auto-expires; `manual` does not. */
export type FailoverReason = "threshold-95" | "manual";

/** One agent's resolved runtime config — the subset the state machine needs. */
export interface FailoverAgentConfig {
  readonly name: string;
  /** The CONFIGURED backend (clawcode.yaml). NOT the override backend. */
  readonly backend: LlmRuntimeBackend;
  /** The ordered failover chain. Empty → no failover (warn-only). */
  readonly failoverChain: readonly LlmRuntimeBackend[];
}

/** A current `failover_state` row, as the state machine sees it. */
export interface CurrentFailoverRow {
  readonly active_backend: LlmRuntimeBackend;
  /** `null` → manual (never expires); else unix-millis instant. */
  readonly expires_at: number | null;
}

/** Pure-function input. */
export interface EvaluateInput {
  /**
   * Provider names that have crossed 95% of their daily cap this UTC
   * day (derived from `provider_alert_state` `threshold=95` rows).
   */
  readonly saturatedProviders: ReadonlySet<string>;
  /** Per-agent resolved configs (for `backend` + `failoverChain`). */
  readonly agents: readonly FailoverAgentConfig[];
  /** Current `failover_state` rows, keyed by agent. */
  readonly currentFailoverState: ReadonlyMap<string, CurrentFailoverRow>;
  /** Wall-clock instant the evaluation runs at (unix millis). */
  readonly now: number;
}

/** One failover to apply. */
export interface FailoverDecision {
  readonly agent: string;
  readonly fromBackend: LlmRuntimeBackend;
  readonly toBackend: LlmRuntimeBackend;
  readonly reason: "threshold-95";
  /** Next UTC midnight — when the auto-failover lifts. */
  readonly expiresAt: number;
}

/** Pure-function output. */
export interface EvaluateOutput {
  /** Failovers to apply (`failoverStateStore.set`). */
  readonly decisions: readonly FailoverDecision[];
  /** Agents whose override has expired (`failoverStateStore.clear`). */
  readonly expiredAgents: readonly string[];
}

/**
 * Next UTC midnight strictly after `now` (unix millis). A
 * `threshold-95` failover row expires here so it lifts when the
 * provider's daily cap rolls over.
 */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
}

/**
 * The failover STATE MACHINE — pure, zero-I/O.
 *
 * Decision rules (CONTEXT D3, lines 106-121):
 *   - For each agent whose CONFIGURED backend maps to a SATURATED
 *     provider:
 *       - SKIP if the agent already has a non-expired `failover_state`
 *         row (no duplicate decision — covers both prior threshold-95
 *         failovers AND manual operator overrides).
 *       - SKIP if `failoverChain` is empty (warn-only — the I/O wrapper
 *         logs it; no row written).
 *       - SKIP if `failoverChain[0]` equals the configured backend (a
 *         misconfigured chain pointing back at the saturated backend).
 *       - Otherwise emit a decision to flip to `failoverChain[0]` with
 *         `reason='threshold-95'` and `expiresAt = nextUtcMidnight(now)`.
 *   - For each current row with a non-null `expires_at <= now` → emit
 *     the agent in `expiredAgents` (the wrapper clears it).
 *
 * v1 scope (deliberate narrowing, documented in the SUMMARY): no
 * chain-of-chain — if A→B already happened and B then saturates, the
 * agent is NOT re-flipped to `chain[1]`; it is already covered by its
 * non-expired row and `skip`s. The manual `clawcode failover set` escape
 * hatch handles that rare case.
 */
export function evaluateFailoverDecisions(
  input: EvaluateInput,
): EvaluateOutput {
  const decisions: FailoverDecision[] = [];
  const expiredAgents: string[] = [];

  // --- Expiry sweep ---------------------------------------------------
  for (const [agent, row] of input.currentFailoverState) {
    if (row.expires_at !== null && row.expires_at <= input.now) {
      expiredAgents.push(agent);
    }
  }

  // --- Threshold-95 failover decisions --------------------------------
  for (const agent of input.agents) {
    const provider = BACKEND_PROVIDER[agent.backend];
    // Agent is not on a saturated provider → nothing to do.
    if (!provider || !input.saturatedProviders.has(provider)) continue;

    // Already covered by a non-expired override (threshold-95 OR manual)
    // → no duplicate decision. An expired row is treated as absent so a
    // re-crossing the next UTC day can re-trigger.
    const existing = input.currentFailoverState.get(agent.name);
    if (
      existing &&
      (existing.expires_at === null || existing.expires_at > input.now)
    ) {
      continue;
    }

    // No chain → warn-only (the I/O wrapper logs; no row written here).
    const target = agent.failoverChain[0];
    if (!target) continue;
    // Chain pointing back at the saturated backend → no-op.
    if (target === agent.backend) continue;

    decisions.push({
      agent: agent.name,
      fromBackend: agent.backend,
      toBackend: target,
      reason: "threshold-95",
      expiresAt: nextUtcMidnight(input.now),
    });
  }

  return { decisions, expiredAgents };
}

// ────────────────────────────────────────────────────────────────────
// FailoverController — the I/O wrapper.
// ────────────────────────────────────────────────────────────────────

/** Minimal logger surface — daemon passes a pino child; tests a stub. */
export interface FailoverLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

/**
 * The read+write surface the controller needs from `FailoverStateStore`.
 * `listAll` returns every row INCLUDING expired ones — the controller's
 * tick needs the expired rows for the expiry sweep, and the non-expired
 * ones for duplicate-decision suppression.
 */
export interface FailoverStateWriter {
  set(
    agent: string,
    backend: LlmRuntimeBackend,
    reason: string,
    expiresAt?: number | null,
  ): void;
  clear(agent: string): void;
  listAll(): readonly RawFailoverRow[];
}

/** Discord delivery surface — subset of `WebhookManager`. */
export interface FailoverWebhookManager {
  send(agentName: string, content: string): Promise<unknown>;
}

/** Discord channel the failover-fired alert is posted to. */
/**
 * INC-2026-08-08 — KNOWN DEAD LEG, not yet fixed here. Same failure as
 * `ALERT_CHANNEL` in usage/threshold-alerter.ts: this is a WEBHOOK identity
 * name, no `admin-clawdy` webhook exists on the production fleet, and
 * `WebhookManager.send` throws on a missing identity — so failover alerts
 * never reach Discord. `postToAdminClawdy` (daemon.ts) now falls back to a
 * bot-direct send via `resolveAdminAlertTarget`; this surface needs the same
 * treatment (requires injecting a BotDirectSender here).
 */
export const FAILOVER_ALERT_CHANNEL = "admin-clawdy";

/** A raw failover row, including potentially-expired ones. */
export interface RawFailoverRow {
  readonly agent: string;
  readonly active_backend: LlmRuntimeBackend;
  readonly expires_at: number | null;
}

/** Constructor dependencies for {@link FailoverController}. */
export interface FailoverControllerDeps {
  /** Write surface — `FailoverStateStore` in production. */
  readonly failoverStateStore: FailoverStateWriter;
  /**
   * Resolve which providers are saturated (≥95% of cap) this UTC day —
   * production reads `provider_alert_state` for today's `threshold=95`
   * rows. Returns provider NAMES (`anthropic` | `openai`).
   */
  readonly readSaturatedProviders: () => ReadonlySet<string>;
  /** Resolve the per-agent runtime configs (registry of agents). */
  readonly resolveAgents: () => readonly FailoverAgentConfig[];
  /**
   * Read ALL failover rows (including expired) — used for BOTH the
   * expiry sweep AND duplicate-decision suppression. When omitted the
   * controller defaults to `failoverStateStore.listAll()` (the
   * production path). Tests inject a stub to drive specific scenarios.
   */
  readonly readAllRows?: () => readonly RawFailoverRow[];
  /** Wall-clock source. Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Discord webhook surface — optional (fire-and-forget). */
  readonly webhookManager?: FailoverWebhookManager;
  /** Logger. Defaults to a no-op. */
  readonly logger?: FailoverLogger;
}

const NOOP_LOGGER: FailoverLogger = { info: () => {}, warn: () => {} };

/**
 * FailoverController — wraps the pure state machine with I/O. The cron
 * tick (T-05) calls `tick()` every minute.
 */
export class FailoverController {
  private readonly store: FailoverStateWriter;
  private readonly readSaturatedProviders: () => ReadonlySet<string>;
  private readonly resolveAgents: () => readonly FailoverAgentConfig[];
  private readonly readAllRows?: () => readonly RawFailoverRow[];
  private readonly clock: () => number;
  private readonly webhookManager?: FailoverWebhookManager;
  private readonly logger: FailoverLogger;

  constructor(deps: FailoverControllerDeps) {
    this.store = deps.failoverStateStore;
    this.readSaturatedProviders = deps.readSaturatedProviders;
    this.resolveAgents = deps.resolveAgents;
    this.readAllRows = deps.readAllRows;
    this.clock = deps.clock ?? Date.now;
    this.webhookManager = deps.webhookManager;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  /**
   * One failover evaluation cycle. Reads SQL state, runs the pure state
   * machine, applies decisions, fires alerts. Never throws — a tick
   * error must not crash the cron (the cron wrapper also catches, but
   * defence in depth).
   */
  async tick(): Promise<void> {
    const now = this.clock();
    const saturatedProviders = this.readSaturatedProviders();
    const agents = this.resolveAgents();

    // Build the currentFailoverState map from EVERY failover row
    // (including expired ones). The pure state machine needs both: the
    // non-expired rows suppress duplicate decisions, the expired rows
    // drive the cleanup sweep. Defaults to `store.listAll()` — the
    // production path; tests inject `readAllRows` to drive scenarios.
    const currentFailoverState = new Map<string, CurrentFailoverRow>();
    const allRows = this.readAllRows
      ? this.readAllRows()
      : this.store.listAll();
    for (const row of allRows) {
      currentFailoverState.set(row.agent, {
        active_backend: row.active_backend,
        expires_at: row.expires_at,
      });
    }

    const { decisions, expiredAgents } = evaluateFailoverDecisions({
      saturatedProviders,
      agents,
      currentFailoverState,
      now,
    });

    // --- Warn-only: saturated agents with no chain --------------------
    for (const agent of agents) {
      const provider = BACKEND_PROVIDER[agent.backend];
      if (!provider || !saturatedProviders.has(provider)) continue;
      if (agent.failoverChain.length === 0) {
        this.logger.warn(
          {
            tag: "phase138-failover-no-chain",
            agent: agent.name,
            provider,
            backend: agent.backend,
          },
          "phase138-failover-no-chain",
        );
      }
    }

    // --- Apply expiry-cleanup decisions -------------------------------
    for (const agent of expiredAgents) {
      this.store.clear(agent);
      this.logger.info(
        { tag: "phase138-failover-cleared", agent },
        "phase138-failover-cleared",
      );
    }

    // --- Apply failover decisions -------------------------------------
    for (const decision of decisions) {
      this.store.set(
        decision.agent,
        decision.toBackend,
        decision.reason,
        decision.expiresAt,
      );
      this.logger.info(
        {
          tag: "phase138-failover-triggered",
          agent: decision.agent,
          from: decision.fromBackend,
          to: decision.toBackend,
          reason: decision.reason,
          expires_at: decision.expiresAt,
        },
        "phase138-failover-triggered",
      );
      // Fire-and-forget Discord alert confirming the failover fired.
      // Distinct from Plan 03's threshold alert — this one says the
      // FAILOVER itself happened. A delivery error is caught + logged.
      this.fireFailoverAlert(decision);
    }
  }

  /**
   * Fire-and-forget Discord alert for a single applied failover.
   * Resolves before the Discord round-trip completes; a delivery error
   * is caught + logged, never rethrown into `tick`.
   */
  private fireFailoverAlert(decision: FailoverDecision): void {
    if (!this.webhookManager) return;
    const message =
      `⚠️ **Failover triggered** — agent \`${decision.agent}\` ` +
      `flipped \`${decision.fromBackend}\` → \`${decision.toBackend}\` ` +
      `(${decision.reason}). Reverts at the next UTC midnight, or run ` +
      `\`clawcode failover reset ${decision.agent}\`.`;
    void this.webhookManager
      .send(FAILOVER_ALERT_CHANNEL, message)
      .catch((err: unknown) => {
        this.logger.warn(
          {
            tag: "phase138-failover-alert-failure",
            agent: decision.agent,
            error: err instanceof Error ? err.message : String(err),
          },
          "phase138-failover-alert-failure",
        );
      });
  }
}

/** Re-export the provider/backend maps for the daemon wiring layer. */
export { PROVIDER_BACKEND, BACKEND_PROVIDER };
