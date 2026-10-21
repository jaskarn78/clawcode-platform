/**
 * Phase 83 Plan 01 Task 1 — Pure effort-to-token-budget mapping.
 *
 * Maps a v2.2 effort level to a thinking-token budget suitable for the SDK's
 * Query.setMaxThinkingTokens(maxThinkingTokens: number | null). Consumed by
 * persistent-session-handle.ts:setEffort to close the P0 silent no-op
 * (PITFALLS.md §Pitfall 1).
 *
 * Semantic contract:
 *   - "off"  → 0      — explicit disable. Mirrors OpenClaw's
 *                       `env.MAX_THINKING_TOKENS='0'` behavior
 *                       (openclaw-claude-bridge/src/claude.js:116-118).
 *                       MUST be literal zero, not null.
 *   - "auto" → null   — SDK / model default. Passes null to the SDK so the
 *                       model picks its own thinking budget.
 *                       MUST be null, not 0 — Plan 02 persistence depends
 *                       on the distinction.
 *   - levels → explicit integer budget, in thinking tokens.
 *
 * Budget shape mirrors the OpenClaw bridge's effort mapping
 * (openclaw-claude-bridge/src/claude.js:47-58) but with explicit token
 * counts because ClawCode drives the SDK in-process — there is no
 * `--effort` CLI flag to set. Values picked to span from tight-and-fast
 * (`low` = 1024) to Opus-4.6-max (`max` = 32768), with `xhigh` sitting
 * between `high` and `max` to give operators a finer-grained dial.
 */

import type { EffortLevel } from "../config/schema.js";

export function mapEffortToTokens(level: EffortLevel): number | null {
  switch (level) {
    case "off":
      return 0;
    case "auto":
      return null;
    case "low":
      return 1024;
    case "medium":
      return 4096;
    case "high":
      return 16384;
    case "xhigh":
      return 24576;
    // Quick 260715-j1j (D4) — ultracode runs at the xhigh budget (upstream
    // aliases ultracode→xhigh; budgets stay monotonic). The orchestration
    // mode itself is applied separately via q.applyFlagSettings at runtime —
    // this mapping only feeds setMaxThinkingTokens.
    case "ultracode":
      return 24576;
    case "max":
      return 32768;
  }
}
