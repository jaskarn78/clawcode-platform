/**
 * Phase 999.173 — PreToolUse launch gate for research subagents.
 *
 * Researchers may start ONLY from a live Discord-user turn: a `sendAndStream`
 * whose turn id is `discord:<snowflake>` (a real message, or a reply-action
 * click on one). Everything else is denied with an "answer inline" reason:
 *   - cron / scheduler / IPC / ask-agent turns (`send`, `sendAndCollect`) —
 *     including the Event Dossier tick and collector wakes ("EVENT DROP DUE",
 *     "EVENT INGEST (collector)", "EVENT CURATOR SWEEP"), whose "audit / chase /
 *     search" wording reads like a research request;
 *   - self-fired turns (a researcher completion waking the parent must not fan
 *     out again);
 *   - voice turns (no message to reply to).
 *
 * It also caps concurrency (`maxConcurrent`, default 4): researchers running
 * plus launches approved but not yet started. The tracker is the backstop — it
 * stops a researcher that starts over the cap anyway.
 *
 * Scope: only a TOP-LEVEL `Agent`/`Task` call with `subagent_type:
 * "researcher"`. Any other tool and any other subagent type get `{}` — no
 * opinion, so the other PreToolUse hooks and the session's permission mode
 * decide as before.
 *
 * The same hook enforces the researcher TOOL POLICY for calls made BY a
 * researcher (`agent_id` present, `agent_type === "researcher"`): side-effect
 * tools are denied (research-tool-policy.ts). Other subagents are untouched.
 */

import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { RESEARCHER_AGENT_TYPE, type ResearcherLaunchModel, type ResearchModel } from "./research-subagents.js";
import { resolveResearchModel } from "./ux-feature-state-store.js";
import { getLiveDiscordTurn, getResearchTracker, type ResearchOrigin } from "./research-registry.js";
import { decideResearcherTool } from "./research-tool-policy.js";
import { RESEARCH_WORKFLOW_DENY, START_WORKFLOW_TOOL, isResearchOnlyWorkflow } from "./research-route.js";
import {
  DEFAULT_USAGE_GUARD,
  USAGE_REDUCED_DENY_TEXT,
  currentUsageSnapshots,
  evaluateUsageGuard,
  usageDenyText,
  type UsageGuardThresholds,
} from "./research-usage-guard.js";

/**
 * `research.allowBash` / `research.deniedTools` for the researcher tool policy,
 * plus what the launch needs to pick the model (999.173 polish).
 */
export type ResearcherToolOptions = Readonly<{
  allowBash: boolean;
  deniedTools?: readonly string[];
  /** `research.model` as configured (undefined = default). */
  configModel?: ResearchModel;
  /** The agent's own model family, for `inherit`. */
  parentModelFamily?: ResearcherLaunchModel;
  /** `research.usageGuard` thresholds (defaults 0.70 / 0.85). */
  usageGuard?: UsageGuardThresholds;
  /** Tool-call budgets (defaults 60 per researcher, 180 per request). */
  budgets?: Readonly<{ maxToolCalls: number; maxSessionToolCalls: number }>;
  /** `research.autoRoute` — deny research-only `start_workflow` from a live Discord turn (research-route.ts). */
  autoRoute?: boolean;
}>;

export const DEFAULT_TOOL_BUDGETS = Object.freeze({ maxToolCalls: 60, maxSessionToolCalls: 180 });
/** Fraction of a budget at which the researcher is nudged to write up. */
export const BUDGET_NUDGE_AT = 0.8;
export const BUDGET_NUDGE_TEXT =
  "Research budget nearly used: write up your findings now (FINDING lines, then your brief). A few more tool calls at most.";
export const BUDGET_STOP_TEXT =
  "Research budget reached: no more tool calls. Write your final summary from what you have.";

/** Tools that cost nothing worth budgeting (the deferred-tool loader). */
const UNBUDGETED_TOOLS: ReadonlySet<string> = new Set(["ToolSearch"]);

/**
 * 999.173 polish — per-researcher and per-request tool-call budgets for a call
 * made BY a researcher (hook `agent_id` = its task id; probed on 0.3.282).
 * ≥ 100 % → deny; the call that crosses 80 % → allowed with an
 * `additionalContext` nudge (reaches the subagent's model — probed).
 */
export function decideResearcherBudget(
  agentName: string,
  taskId: string,
  toolName: string,
  budgets: Readonly<{ maxToolCalls: number; maxSessionToolCalls: number }>,
): Readonly<{ kind: "deny"; reason: string } | { kind: "nudge"; context: string } | { kind: "allow" }> {
  if (UNBUDGETED_TOOLS.has(toolName)) return { kind: "allow" };
  const tracker = getResearchTracker(agentName);
  const current = tracker?.toolCallsFor?.(taskId);
  if (!tracker?.countToolCall || !current?.known) return { kind: "allow" };
  if (current.task >= budgets.maxToolCalls || current.session >= budgets.maxSessionToolCalls) {
    tracker.noteBudgetReached?.(taskId);
    return { kind: "deny", reason: BUDGET_STOP_TEXT };
  }
  const next = tracker.countToolCall(taskId);
  const taskNudge = Math.ceil(budgets.maxToolCalls * BUDGET_NUDGE_AT);
  const sessionNudge = Math.ceil(budgets.maxSessionToolCalls * BUDGET_NUDGE_AT);
  if (next.task === taskNudge || next.session === sessionNudge) return { kind: "nudge", context: BUDGET_NUDGE_TEXT };
  return { kind: "allow" };
}

/**
 * 999.173 polish — the model a researcher launched NOW gets, set on the Agent
 * tool's `model` input (which the SDK documents, and a live probe on 0.3.282
 * confirmed, takes precedence over the AgentDefinition's model). Resolved at
 * every launch, so a `/clawcode-ux feature:research model:<m>` swap applies to
 * the next launch without a restart. Undefined = leave the input without a
 * model (the definition's applies): `inherit` when the agent's own family is
 * not one the Agent tool accepts.
 */
export function researcherLaunchModel(
  agentName: string,
  tools: Pick<ResearcherToolOptions, "configModel" | "parentModelFamily">,
): ResearcherLaunchModel | undefined {
  const { model } = resolveResearchModel(agentName, tools.configModel);
  return model === "inherit" ? tools.parentModelFamily : model;
}

export const RESEARCH_DENY_NOT_USER_TURN =
  "Research subagents only start from a live user message in Discord. This turn is scheduled or " +
  "self-fired, so do the work inline instead: search and read yourself, then answer directly.";

export const researchDenyAtCap = (max: number): string =>
  `At most ${max} researchers run at once and that many are already running. Fold this sub-question ` +
  "into your synthesis when they finish, or answer it inline.";

export type ResearchGateDecision =
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{ kind: "allow"; origin?: ResearchOrigin }>
  | Readonly<{ kind: "deny"; reason: string }>;

function isResearcherLaunch(input: PreToolUseHookInput): boolean {
  if (input.tool_name !== "Agent" && input.tool_name !== "Task") return false;
  const ti = input.tool_input as { subagent_type?: unknown } | null | undefined;
  return ti?.subagent_type === RESEARCHER_AGENT_TYPE;
}

/** Pure decision (exported for tests). Records an approved launch as a side effect. */
export function decideResearchLaunch(
  agentName: string,
  maxConcurrent: number,
  input: PreToolUseHookInput,
  toolUseId: string | undefined,
  usageGuard: UsageGuardThresholds = DEFAULT_USAGE_GUARD,
  now: number = Date.now(),
): ResearchGateDecision {
  const agentId = (input as { agent_id?: unknown }).agent_id;
  if (typeof agentId === "string" && agentId.length > 0) return { kind: "not-applicable" };
  if (!isResearcherLaunch(input)) return { kind: "not-applicable" };
  const origin = getLiveDiscordTurn(agentName);
  if (origin === undefined) return { kind: "deny", reason: RESEARCH_DENY_NOT_USER_TURN };
  // 999.173 polish — usage-aware guard (the account hit its limit mid-research).
  const usage = evaluateUsageGuard(currentUsageSnapshots(), now, usageGuard);
  if (usage.band === "block") return { kind: "deny", reason: usageDenyText(usage, now) };
  if (usage.band === "unknown") {
    console.info(JSON.stringify({ component: "research", agent: agentName, msg: "research: usage guard has no usage data — failing open" }));
  }
  const tracker = getResearchTracker(agentName);
  const reduced = usage.band === "reduce";
  if (reduced && tracker !== undefined && tracker.occupiedSlotsFor(origin.turnId) >= 1) {
    return { kind: "deny", reason: USAGE_REDUCED_DENY_TEXT };
  }
  if (tracker !== undefined && tracker.occupiedSlots() >= maxConcurrent) {
    return { kind: "deny", reason: researchDenyAtCap(maxConcurrent) };
  }
  if (tracker !== undefined && typeof toolUseId === "string" && toolUseId.length > 0) {
    tracker.noteApprovedLaunch(toolUseId, origin, { usageLimited: reduced });
  }
  return { kind: "allow", origin };
}

/**
 * Research auto-routing (research-route.ts) — a research-only `start_workflow`
 * made by the agent itself during a live Discord-user turn is denied with a
 * pointer to researchers. Scheduled / self-fired turns are left alone
 * (researchers can't start there), as are templates and deliverable workflows.
 */
export function decideResearchWorkflow(
  agentName: string,
  input: PreToolUseHookInput,
  autoRoute: boolean,
): ResearchGateDecision {
  if (!autoRoute || input.tool_name !== START_WORKFLOW_TOOL) return { kind: "not-applicable" };
  const agentId = (input as { agent_id?: unknown }).agent_id;
  if (typeof agentId === "string" && agentId.length > 0) return { kind: "not-applicable" };
  if (getLiveDiscordTurn(agentName) === undefined) return { kind: "not-applicable" };
  if (!isResearchOnlyWorkflow(input.tool_input)) return { kind: "not-applicable" };
  return { kind: "deny", reason: RESEARCH_WORKFLOW_DENY };
}

/** Policy for a call made BY a researcher; not-applicable for anything else. */
export function decideResearcherCall(input: PreToolUseHookInput, tools: ResearcherToolOptions): ResearchGateDecision {
  const agentId = (input as { agent_id?: unknown }).agent_id;
  const agentType = (input as { agent_type?: unknown }).agent_type;
  if (typeof agentId !== "string" || agentId.length === 0 || agentType !== RESEARCHER_AGENT_TYPE) {
    return { kind: "not-applicable" };
  }
  const d = decideResearcherTool(input.tool_name, input.tool_input, {
    allowBash: tools.allowBash,
    ...(tools.deniedTools !== undefined ? { extraDenied: tools.deniedTools } : {}),
  });
  return d.deny ? { kind: "deny", reason: d.reason ?? "Denied to researchers." } : { kind: "not-applicable" };
}

export function makeResearchLaunchGateHook(
  agentName: string,
  maxConcurrent: number,
  tools: ResearcherToolOptions = { allowBash: false },
): HookCallback {
  return async (input, toolUseID) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    let decision: ResearchGateDecision;
    try {
      const pre = input as PreToolUseHookInput;
      const byResearcher = decideResearcherCall(pre, tools);
      // 999.173 polish — budgets for calls the tool policy allowed.
      const agentId = (pre as { agent_id?: unknown }).agent_id;
      if (
        byResearcher.kind === "not-applicable" &&
        (pre as { agent_type?: unknown }).agent_type === RESEARCHER_AGENT_TYPE &&
        typeof agentId === "string" &&
        agentId.length > 0
      ) {
        const budget = decideResearcherBudget(agentName, agentId, pre.tool_name, tools.budgets ?? DEFAULT_TOOL_BUDGETS);
        if (budget.kind === "nudge") {
          return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: budget.context } };
        }
        if (budget.kind === "deny") {
          console.info(JSON.stringify({ component: "research", agent: agentName, msg: "research: budget reached", taskId: agentId }));
          return {
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: budget.reason },
          };
        }
        return {};
      }
      const byWorkflow = byResearcher.kind === "not-applicable"
        ? decideResearchWorkflow(agentName, pre, tools.autoRoute === true)
        : byResearcher;
      decision = byResearcher.kind !== "not-applicable"
        ? byResearcher
        : byWorkflow.kind !== "not-applicable"
          ? byWorkflow
          : decideResearchLaunch(agentName, maxConcurrent, pre, toolUseID, tools.usageGuard);
    } catch {
      // A gate fault must never block the agent's other tool calls.
      return {};
    }
    if (decision.kind === "allow") {
      // 999.173 polish — pin the researcher's model at launch (runtime swap).
      const pre = input as PreToolUseHookInput;
      const current = (pre.tool_input ?? {}) as Record<string, unknown>;
      let model: ResearcherLaunchModel | undefined;
      try {
        model = researcherLaunchModel(agentName, tools);
      } catch {
        model = undefined;
      }
      const { model: _llmChoice, ...rest } = current;
      // 999.173 polish — continue from earlier notes (a rerun on the same
      // message, or "resume research") instead of starting over.
      let resume: string | null = null;
      try {
        resume = decision.origin ? (getResearchTracker(agentName)?.resumeContextFor?.(decision.origin) ?? null) : null;
      } catch {
        resume = null;
      }
      if (resume !== null && typeof rest.prompt === "string") rest.prompt = `${rest.prompt}\n\n${resume}`;
      const updatedInput = model !== undefined ? { ...rest, model } : rest;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput,
        },
      };
    }
    if (decision.kind !== "deny") return {};
    console.info(
      JSON.stringify({
        component: "research",
        agent: agentName,
        msg: (input as { agent_type?: unknown }).agent_type === RESEARCHER_AGENT_TYPE
          ? "research: researcher tool denied"
          : (input as { tool_name?: unknown }).tool_name === START_WORKFLOW_TOOL
            ? "research: research-only workflow routed to researchers"
            : "research: launch denied",
        tool: (input as { tool_name?: unknown }).tool_name,
        reason: decision.reason.slice(0, 80),
      }),
    );
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason,
      },
    };
  };
}
