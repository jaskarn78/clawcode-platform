import type { CheckModule, CheckResult } from "../types.js";
import { classifyZone, DEFAULT_ZONE_THRESHOLDS } from "../context-zones.js";

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Built-in context fill percentage check.
 *
 * Reports healthy/warning/critical based on the agent's context fill
 * classified into 4 zones (green/yellow/orange/red).
 * Uses CharacterCountFillProvider from the SessionManager for live fill state.
 *
 * Zone-to-status mapping:
 * - green -> healthy
 * - yellow -> warning
 * - orange -> warning
 * - red -> critical (includes compaction recommendation)
 *
 * Phase 124 Plan 04 T-02 — auto-trigger side effect:
 *   When `context.compactSessionTrigger` is wired AND the agent's
 *   resolved `autoCompactAt` ratio is > 0 AND the live fill ratio meets
 *   or exceeds it AND no compaction has fired within the cooldown
 *   window, this check fires the trigger fire-and-forget. The check's
 *   primary return value (status/message/metadata) is unchanged by the
 *   trigger; auto-compaction is observability-orthogonal.
 *
 *   The `[124-04-auto-trigger]` sentinel is logged at dispatch so
 *   operators can verify the wiring runs end-to-end on production via
 *   `journalctl -u clawcode -g '124-04-auto-trigger'`
 *   (feedback_silent_path_bifurcation prevention).
 */
const contextFillCheck: CheckModule = {
  name: "context-fill",

  async execute(context): Promise<CheckResult> {
    const { agentName, sessionManager, config } = context;

    const provider = sessionManager.getContextFillProvider(agentName);
    if (!provider) {
      return {
        status: "healthy",
        message: "No memory system configured",
      };
    }

    const fillPercentage = provider.getContextFillPercentage();
    const pct = Math.round(fillPercentage * 100);
    const thresholds = config.contextFill.zoneThresholds ?? DEFAULT_ZONE_THRESHOLDS;
    const zone = classifyZone(fillPercentage, thresholds);

    // Phase 124 Plan 04 T-02 — auto-trigger side effect. Evaluated AFTER
    // the result is computed so a trigger throw / log can never poison
    // the operator-visible status. Fire-and-forget.
    maybeFireAutoTrigger(context, agentName, fillPercentage);

    if (zone === "red") {
      return {
        status: "critical",
        message: `Context fill: ${pct}% [${zone}] -- recommend compaction`,
        metadata: { fillPercentage, zone },
      };
    }

    if (zone === "orange" || zone === "yellow") {
      return {
        status: "warning",
        message: `Context fill: ${pct}% [${zone}]`,
        metadata: { fillPercentage, zone },
      };
    }

    return {
      status: "healthy",
      message: `Context fill: ${pct}% [${zone}]`,
      metadata: { fillPercentage, zone },
    };
  },
};

/**
 * Evaluate the auto-trigger gates and fire (fire-and-forget) when met.
 * Extracted so the gate logic is straightforward to read; the
 * `getAgentConfig` accessor on SessionManager (session-manager.ts:2257)
 * is the source for `autoCompactAt` (Phase 124 Plan 02 schema field).
 *
 * Gates (ALL must pass):
 *   1. Trigger is wired into the CheckContext.
 *   2. Agent's `autoCompactAt > 0` (per-agent opt-out).
 *   3. Live `fillPercentage >= autoCompactAt`.
 *   4. No prior compaction within `cooldownMs` (default 5 min).
 */
function maybeFireAutoTrigger(
  context: Parameters<NonNullable<CheckModule["execute"]>>[0],
  agentName: string,
  fillPercentage: number,
): void {
  const trigger = context.compactSessionTrigger;
  if (!trigger) return;

  const agentConfig = context.sessionManager.getAgentConfig?.(agentName);
  const autoCompactAt = agentConfig?.autoCompactAt ?? 0;
  if (autoCompactAt <= 0) return; // opt-out
  if (fillPercentage < autoCompactAt) return; // below threshold

  // Cooldown gate — read last-compaction via the injected lookup.
  const lookup = context.getLastCompactionAt;
  const lastIso = lookup ? lookup(agentName) : null;
  if (lastIso !== null) {
    const now = (context.now ?? Date.now)();
    const cooldownMs = context.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const elapsed = now - Date.parse(lastIso);
    if (elapsed < cooldownMs) return; // within cooldown
  }

  // Silent-path-bifurcation sentinel — operators grep journalctl for
  // this exact keyword to verify the wiring fires in production.
  // eslint-disable-next-line no-console
  console.info(
    `[124-04-auto-trigger] agent=${agentName} fill=${Math.round(fillPercentage * 100)}% threshold=${Math.round(autoCompactAt * 100)}%`,
  );

  // Fire-and-forget; never block the heartbeat tick on compaction.
  // Errors are swallowed so a failed compaction does not poison the
  // status surface.
  trigger(agentName).catch(() => undefined);
}

export default contextFillCheck;
