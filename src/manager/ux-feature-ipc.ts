/**
 * Phase 999.171 — pure handler for the `set-ux-feature` IPC method
 * (`/clawcode-ux <thinking|suggestions|research> on|off|status|reset [agent]`).
 *
 * Kept out of daemon.ts so it is testable without a manager: the daemon
 * adapts its own agent-config lookup into `getConfigFeatures`, which returns
 * the agent's configured `uxFeatures` (undefined when unset) or null when the
 * agent is not configured at all.
 *
 * on/off persist an override (file + in-memory registry, written together,
 * as set-fast-lane does); reset drops that one feature's override so config
 * governs it again (operator 2026-09-24); status reports the effective
 * state. Every input is
 * checked against a fixed allowlist BEFORE anything is written, and error
 * messages never echo the raw input back.
 */

import type { Logger } from "pino";
import { ManagerError } from "../shared/errors.js";
import { isSubagentOrThreadSession } from "./subagent-name.js";
import {
  RESEARCH_MODEL_CHOICES,
  UX_FEATURES,
  UX_FEATURE_META,
  UX_FEATURE_SLASH_NAMES,
  clearResearchModelState,
  clearUxFeatureState,
  getUxFeatureOverrides,
  resolveResearchModel,
  resolveUxFeature,
  setUxFeatureOverride,
  writeResearchModelState,
  writeUxFeatureState,
  type ResearchModelChoice,
  type UxFeature,
  type UxFeatureApplies,
  type UxFeatureOverrides,
} from "./ux-feature-state-store.js";

export type UxFeatureState = "on" | "off" | "status" | "reset";

const UX_FEATURE_STATES: readonly UxFeatureState[] = ["on", "off", "status", "reset"];

export interface SetUxFeatureDeps {
  readonly params: Record<string, unknown>;
  readonly getConfigFeatures: (agent: string) => UxFeatureOverrides | undefined | null;
  /**
   * The name is an agent in the yaml config (REVIEW MD-01). A thread or
   * subagent session also has a config (a snapshot of its parent's), so a
   * manager lookup alone would accept it and persist an override that nothing
   * reads, for a session that goes away.
   */
  readonly isConfiguredAgent: (agent: string) => boolean;
  /**
   * Phase 999.172 — the session-start options the agent's RUNNING session was
   * built with (undefined when it is not running, or the handle cannot say).
   * Lets the reply say "restart pending" for a restart-applied feature.
   */
  readonly getStartedFeatures?: (agent: string) => UxFeatureOverrides | undefined;
  /** 999.173 polish — the agent's `research.model` (undefined when unset). */
  readonly getConfigResearchModel?: (agent: string) => ResearchModelChoice | undefined;
  /** 999.173 polish — one line describing the usage-aware launch guard's state. */
  readonly getResearchUsageStatus?: (agent: string) => string | undefined;
  /** 999.173 polish — the researcher budgets line. */
  readonly getResearchBudgetStatus?: (agent: string) => string | undefined;
  readonly filePath: string;
  readonly log?: Logger;
}

export interface SetUxFeatureResult {
  readonly agent: string;
  readonly feature: UxFeature;
  readonly state: UxFeatureState;
  readonly enabled: boolean;
  readonly source: "override" | "config";
  readonly configEnabled: boolean;
  readonly applies: UxFeatureApplies;
  /**
   * Phase 999.172 — for a restart-applied feature: true when the effective
   * setting differs from what the running session started with, false when
   * they match. Omitted when unknown (agent not running) or not applicable.
   */
  readonly restartPending?: boolean;
  /**
   * 999.173 polish — research only: the effective research model and where it
   * comes from. Applied at every researcher launch, so a change takes effect on
   * the next launch without a restart.
   */
  readonly researchModel?: Readonly<{
    model: ResearchModelChoice;
    source: "override" | "config" | "default";
    applies: "next-launch";
  }>;
  /** 999.173 polish — research only: the usage guard line. */
  readonly usageGuard?: string;
  /** 999.173 polish — research only: the budgets line. */
  readonly budgets?: string;
}

const ALLOWED_FEATURES_TEXT = `${Object.keys(UX_FEATURE_SLASH_NAMES).join(" | ")} (or ${UX_FEATURES.join(" | ")})`;

function parseAgent(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ManagerError("missing agent — expected a configured agent name");
  }
  return value;
}

function parseFeature(value: unknown): UxFeature {
  if (typeof value === "string") {
    // hasOwn, not `in` / bare index: "constructor" must not resolve to a
    // prototype member.
    if (Object.hasOwn(UX_FEATURE_SLASH_NAMES, value)) return UX_FEATURE_SLASH_NAMES[value] as UxFeature;
    if ((UX_FEATURES as readonly string[]).includes(value)) return value as UxFeature;
  }
  throw new ManagerError(`invalid feature — expected ${ALLOWED_FEATURES_TEXT}`);
}

function parseState(value: unknown): UxFeatureState {
  // JSON has no undefined; an explicit null is the same "not given".
  if (value === undefined || value === null) return "status";
  if (typeof value === "string" && (UX_FEATURE_STATES as readonly string[]).includes(value)) {
    return value as UxFeatureState;
  }
  throw new ManagerError("invalid state — expected on | off | status | reset");
}

type ModelParam = ResearchModelChoice | "reset" | undefined;

function parseModel(value: unknown, feature: UxFeature): ModelParam {
  if (value === undefined || value === null) return undefined;
  if (feature !== "researchSubagents") {
    throw new ManagerError("model applies only to feature research");
  }
  if (value === "reset") return "reset";
  if (typeof value === "string" && (RESEARCH_MODEL_CHOICES as readonly string[]).includes(value)) {
    return value as ResearchModelChoice;
  }
  throw new ManagerError(`invalid model — expected ${RESEARCH_MODEL_CHOICES.join(" | ")} | reset`);
}

/** The overrides minus one key (a new frozen object), or null when none are left. */
function withoutFeature(
  overrides: UxFeatureOverrides | undefined,
  feature: UxFeature | "researchModel",
): UxFeatureOverrides | null {
  const rest = Object.fromEntries(Object.entries(overrides ?? {}).filter(([key]) => key !== feature));
  return Object.keys(rest).length > 0 ? Object.freeze(rest as UxFeatureOverrides) : null;
}

/** Validate, apply (on/off/reset), and report the effective state for one feature. */
export async function handleSetUxFeature(deps: SetUxFeatureDeps): Promise<SetUxFeatureResult> {
  const agent = parseAgent(deps.params?.agent);
  const feature = parseFeature(deps.params?.feature);
  const state = parseState(deps.params?.state);
  const model = parseModel(deps.params?.model, feature);
  if (!deps.isConfiguredAgent(agent)) {
    throw new ManagerError(
      isSubagentOrThreadSession(agent)
        ? "thread and subagent sessions follow their parent agent's setting — name the parent agent"
        : "unknown agent (not in config)",
    );
  }
  const configFeatures = deps.getConfigFeatures(agent);
  if (configFeatures === null) throw new ManagerError("unknown agent (not in config)");

  if (state === "on" || state === "off") {
    const merged = await writeUxFeatureState(deps.filePath, agent, feature, state === "on", deps.log);
    // File is the durable record; the registry is what the bridge's
    // per-message hot path reads. Written together, always.
    setUxFeatureOverride(agent, merged);
  } else if (state === "reset") {
    await clearUxFeatureState(deps.filePath, agent, feature, deps.log);
    // Drop exactly this feature from what the hot path reads, from the
    // registry's own copy: if the file lost the agent (moved aside after
    // boot), rebuilding from the file would wipe its OTHER features too.
    setUxFeatureOverride(agent, withoutFeature(getUxFeatureOverrides(agent), feature));
  }

  // 999.173 polish — the research model override (validated above, before any write).
  if (model === "reset") {
    await clearResearchModelState(deps.filePath, agent, deps.log);
    setUxFeatureOverride(agent, withoutFeature(getUxFeatureOverrides(agent), "researchModel"));
  } else if (model !== undefined) {
    const merged = await writeResearchModelState(deps.filePath, agent, model, deps.log);
    setUxFeatureOverride(agent, { ...(getUxFeatureOverrides(agent) ?? {}), researchModel: merged.researchModel ?? model });
  }

  const effective = resolveUxFeature(agent, feature, configFeatures);
  const applies = UX_FEATURE_META[feature].applies;
  const started = applies === "restart" ? deps.getStartedFeatures?.(agent) : undefined;
  const startedValue = started?.[feature];
  return {
    agent,
    feature,
    state,
    enabled: effective.enabled,
    source: effective.source,
    configEnabled: configFeatures?.[feature] === true,
    applies,
    ...(typeof startedValue === "boolean" ? { restartPending: startedValue !== effective.enabled } : {}),
    ...(feature === "researchSubagents"
      ? {
          researchModel: {
            ...resolveResearchModel(agent, deps.getConfigResearchModel?.(agent)),
            applies: "next-launch" as const,
          },
          ...(() => {
            const line = deps.getResearchUsageStatus?.(agent);
            return typeof line === "string" ? { usageGuard: line } : {};
          })(),
          ...(() => {
            const line = deps.getResearchBudgetStatus?.(agent);
            return typeof line === "string" ? { budgets: line } : {};
          })(),
        }
      : {}),
  };
}
