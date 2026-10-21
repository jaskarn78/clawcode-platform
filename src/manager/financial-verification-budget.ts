/**
 * 2026-07-31 — adaptive verify-budget decision core (pure).
 *
 * Decides whether the financial-verification corrective hop should run at
 * all, run shrunk (low effort), or be skipped, based on how heavy the
 * just-completed parent turn was. Extracted from the fin-client incident:
 * stacking a 30-120 s corrective hop on an already-multi-minute turn is
 * what produced the phantom-typing / interrupt-deadline / wedge cascades.
 *
 * PURE — no I/O, no logging, no `Date`. The caller (the runner) supplies
 * the snapshot numbers; threshold defaults are single-sourced in
 * `VERIFICATION_BUDGET_DEFAULTS` (financial-verification-gate.ts)
 * and resolved through config before they reach this function.
 */

/** The budget verdict for one prospective corrective hop. */
export interface VerifyBudgetDecision {
  /**
   * - `full`   — dispatch the hop at the agent's current effort.
   * - `shrink` — dispatch the hop at `low` effort (moderately heavy turn).
   * - `skip`   — do not dispatch; emit telemetry with `skippedReason`.
   */
  readonly mode: "full" | "shrink" | "skip";
  /** Set ONLY when mode is `skip`. */
  readonly skippedReason?: "hops-disabled" | "turn-cost";
}

/**
 * Decide the corrective-hop budget for a just-completed turn.
 *
 *   - `maxVerifyHops === 0`  → skip (`hops-disabled`, telemetry-only mode).
 *   - `turnCostMs >= skipIfTurnMsOver`   → skip (`turn-cost`).
 *   - `turnCostMs >= shrinkIfTurnMsOver` → shrink.
 *   - otherwise (including `turnCostMs === null`, i.e. no Turn was wired
 *     so the cost is unknowable) → full. Unknown cost fails OPEN to the
 *     historical behavior — the yield mechanism (defer + abort) still
 *     bounds the damage.
 */
export function decideVerifyBudget(input: {
  readonly turnCostMs: number | null;
  readonly maxVerifyHops: number;
  readonly skipIfTurnMsOver: number;
  readonly shrinkIfTurnMsOver: number;
}): VerifyBudgetDecision {
  const { turnCostMs, maxVerifyHops, skipIfTurnMsOver, shrinkIfTurnMsOver } =
    input;

  if (maxVerifyHops <= 0) {
    return { mode: "skip", skippedReason: "hops-disabled" };
  }
  if (turnCostMs !== null && turnCostMs >= skipIfTurnMsOver) {
    return { mode: "skip", skippedReason: "turn-cost" };
  }
  if (turnCostMs !== null && turnCostMs >= shrinkIfTurnMsOver) {
    return { mode: "shrink" };
  }
  return { mode: "full" };
}
