/**
 * Phase 999.173 — background research subagents: the session-start decision
 * and the SDK options it produces.
 *
 * Research is ON for a session only when ALL hold:
 *   - `uxFeatures.researchSubagents` resolves true (the `/clawcode-ux research`
 *     override wins over yaml — resolved HERE, at session build, because the
 *     `agents` option is sent once in the SDK initialize request);
 *   - `delivery.attributedStream` is on (the demux child lane, the orphan sink
 *     and the task tap that feed the research card only exist there);
 *   - the session is an operator-defined agent, never a thread / sub / pool /
 *     fork worker (`isManagedWorkerName`) — researchers are the MAIN agent's.
 *
 * When on, the session carries `agents.researcher` (background; INHERITS the
 * agent's tools minus everything with side effects — see
 * research-tool-policy.ts), `agentProgressSummaries` (the
 * ~30 s per-researcher summaries the card shows) and `perTaskStopAffordance`
 * (an interrupt no longer kills every background task — safe only because the
 * research card ships a per-task Stop; the SDK fails closed without it).
 */

import { resolveUxFeature } from "./ux-feature-state-store.js";
import { isManagedWorkerName } from "./subagent-name.js";
import { researcherDisallowedTools } from "./research-tool-policy.js";
import { DEFAULT_USAGE_GUARD } from "./research-usage-guard.js";

export const RESEARCHER_AGENT_TYPE = "researcher";

export const RESEARCH_DEFAULTS = Object.freeze({
  model: "opus" as const,
  effort: "medium" as const,
  maxTurns: 25,
  maxConcurrent: 4,
  holdTimeoutMinutes: 20,
  maxToolCalls: 60,
  maxSessionToolCalls: 180,
  maxMinutes: 15,
});

export type ResearchModel = "sonnet" | "opus" | "haiku" | "fable" | "inherit";
export type ResearchEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Frozen per-session research settings (defaults applied). */
export type ResearchSessionConfig = Readonly<{
  /** The definition's model: `research.model`, else the default (opus). */
  model: ResearchModel;
  /** `research.model` exactly as configured; undefined when the default applies. */
  configModel?: ResearchModel;
  /**
   * The agent's own model family (from its configured model), used when the
   * runtime research model is `inherit`. Undefined when it is not one of the
   * four families the Agent tool accepts.
   */
  parentModelFamily?: ResearcherLaunchModel;
  effort: ResearchEffort;
  maxTurns: number;
  maxConcurrent: number;
  holdTimeoutMs: number;
  /** Explicit tool list; undefined = inherit the agent's tools. */
  tools?: readonly string[];
  /** Extra denials on top of the built-in denylist. */
  deniedTools: readonly string[];
  allowBash: boolean;
  /** Usage-aware launch guard thresholds (defaults 0.70 / 0.85). */
  usageGuard: Readonly<{ reduceAt: number; blockAt: number }>;
  /** Tool-call budgets and the wall-clock cap. */
  budgets: Readonly<{ maxToolCalls: number; maxSessionToolCalls: number; maxMinutes: number }>;
  /** `research.autoRoute`: steer research asks to researchers, deny research-only workflows (research-route.ts). */
  autoRoute: boolean;
}>;

type ResearchKnobs = Readonly<{
  model?: ResearchModel;
  effort?: ResearchEffort;
  maxTurns?: number;
  maxConcurrent?: number;
  holdTimeoutMinutes?: number;
  tools?: readonly string[];
  deniedTools?: readonly string[];
  allowBash?: boolean;
  usageGuard?: Readonly<{ reduceAt?: number; blockAt?: number }>;
  maxToolCalls?: number;
  maxSessionToolCalls?: number;
  maxMinutes?: number;
  autoRoute?: boolean;
}>;

/** Models the Agent tool's `model` input accepts (SDK 0.3.282 AgentInput.model). */
export type ResearcherLaunchModel = "opus" | "sonnet" | "haiku" | "fable";

/** The family of a configured model alias ("opus-4-8", "sonnet@latest" …), or undefined. */
export function modelFamilyOf(model: string | undefined): ResearcherLaunchModel | undefined {
  if (typeof model !== "string") return undefined;
  const m = model.toLowerCase();
  for (const family of ["opus", "sonnet", "haiku", "fable"] as const) {
    if (m.includes(family)) return family;
  }
  return undefined;
}

export type ResearchResolveInput = Readonly<{
  name: string;
  /** The agent's configured model (for `inherit`). */
  model?: string;
  uxFeatures?: Readonly<{ researchSubagents?: boolean }>;
  research?: ResearchKnobs;
  deliveryAttributedStream?: boolean;
}>;

/** The session-start decision. Undefined = research off for this session. */
export function resolveResearchSession(config: ResearchResolveInput): ResearchSessionConfig | undefined {
  if (isManagedWorkerName(config.name)) return undefined;
  if (config.deliveryAttributedStream !== true) return undefined;
  const { enabled } = resolveUxFeature(config.name, "researchSubagents", config.uxFeatures);
  if (!enabled) return undefined;
  const k = config.research ?? {};
  const parentModelFamily = modelFamilyOf(config.model);
  return Object.freeze({
    model: k.model ?? RESEARCH_DEFAULTS.model,
    ...(k.model !== undefined ? { configModel: k.model } : {}),
    ...(parentModelFamily !== undefined ? { parentModelFamily } : {}),
    effort: k.effort ?? RESEARCH_DEFAULTS.effort,
    maxTurns: k.maxTurns ?? RESEARCH_DEFAULTS.maxTurns,
    maxConcurrent: Math.min(k.maxConcurrent ?? RESEARCH_DEFAULTS.maxConcurrent, RESEARCH_DEFAULTS.maxConcurrent),
    holdTimeoutMs: (k.holdTimeoutMinutes ?? RESEARCH_DEFAULTS.holdTimeoutMinutes) * 60_000,
    ...(k.tools !== undefined ? { tools: Object.freeze([...k.tools]) } : {}),
    deniedTools: Object.freeze([...(k.deniedTools ?? [])]),
    allowBash: k.allowBash === true,
    usageGuard: Object.freeze({
      reduceAt: k.usageGuard?.reduceAt ?? DEFAULT_USAGE_GUARD.reduceAt,
      blockAt: k.usageGuard?.blockAt ?? DEFAULT_USAGE_GUARD.blockAt,
    }),
    budgets: Object.freeze({
      maxToolCalls: k.maxToolCalls ?? RESEARCH_DEFAULTS.maxToolCalls,
      maxSessionToolCalls: k.maxSessionToolCalls ?? RESEARCH_DEFAULTS.maxSessionToolCalls,
      maxMinutes: k.maxMinutes ?? RESEARCH_DEFAULTS.maxMinutes,
    }),
    autoRoute: k.autoRoute === true,
  });
}

/** Drives the model's auto-selection (the parent reads this in its Agent tool list). */
export const RESEARCHER_DESCRIPTION =
  "Background researcher for research, deep dives, investigations, comparisons and \"look into X\" requests. " +
  "Launch 2-4 in parallel with the Agent tool (subagent_type \"researcher\"), one per distinct sub-question, " +
  "each with a self-contained prompt. They run in the background while a live research card shows the user " +
  "their progress; you are woken as each one finishes. When all are done, write ONE synthesis for the user. " +
  "Not for quick lookups you can answer directly.";

export const RESEARCHER_PROMPT = [
  "You are a focused research worker answering ONE sub-question for a lead agent.",
  "You have the lead agent's read tools: web search and fetch, its data servers (market data, databases,",
  "email and calendar search, a browser) and the workspace files. Prefer primary sources, confirm key",
  "numbers on the source page or in the data, and stop as soon as the sub-question is answered.",
  "After each concrete finding, write one line `FINDING: <claim> — <source>` so your work is saved as you go.",
  "You only READ. Never send, post, create, update, delete, share, schedule or buy anything, and never",
  "run a query that writes; those tools are blocked for you. If something should be done, say so in",
  "your brief instead.",
  "Your final message is read by the lead agent, not the user. Return a compact brief: the answer first,",
  "then the key findings as bullets with the source (URL, table, message) for each, then any conflicting",
  "evidence or open questions. No preamble and no status narration.",
].join("\n");

export type ResearcherAgentDefinition = Readonly<{
  description: string;
  prompt: string;
  /** Omitted = the SDK's native inheritance of the parent's tools. */
  tools?: string[];
  disallowedTools: string[];
  model: ResearchModel;
  effort: ResearchEffort;
  maxTurns: number;
  background: true;
}>;

export function buildResearcherAgentDefinition(r: ResearchSessionConfig): ResearcherAgentDefinition {
  return {
    description: RESEARCHER_DESCRIPTION,
    prompt: RESEARCHER_PROMPT,
    ...(r.tools !== undefined ? { tools: [...r.tools] } : {}),
    disallowedTools: researcherDisallowedTools(r),
    model: r.model,
    effort: r.effort,
    maxTurns: r.maxTurns,
    background: true,
  };
}

export type ResearchSdkOptions = Readonly<{
  agents?: Readonly<Record<string, ResearcherAgentDefinition>>;
  agentProgressSummaries?: true;
  perTaskStopAffordance?: true;
}>;

/**
 * The real SDK options for a research-enabled session; `{}` otherwise so the
 * rest of the fleet's options bag stays byte-identical. Used at BOTH the
 * create and resume sites (Rule 3 symmetry).
 */
export function buildResearchSdkOptions(r: ResearchSessionConfig | undefined): ResearchSdkOptions {
  if (r === undefined) return {};
  return {
    agents: { [RESEARCHER_AGENT_TYPE]: buildResearcherAgentDefinition(r) },
    agentProgressSummaries: true,
    perTaskStopAffordance: true,
  };
}

/** One line for `/clawcode-ux feature:research state:status`. */
export function researchBudgetStatusLine(k: Readonly<{ maxToolCalls?: number; maxSessionToolCalls?: number; maxMinutes?: number }> | undefined): string {
  const perResearcher = k?.maxToolCalls ?? RESEARCH_DEFAULTS.maxToolCalls;
  const perRequest = k?.maxSessionToolCalls ?? RESEARCH_DEFAULTS.maxSessionToolCalls;
  const minutes = k?.maxMinutes ?? RESEARCH_DEFAULTS.maxMinutes;
  return `Budgets: ${perResearcher} tool calls per researcher, ${perRequest} per request, ${minutes} min per researcher (nudge at 80%).`;
}
