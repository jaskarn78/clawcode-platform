/**
 * Phase 999.130 — weekly report-card collector + cron.
 *
 * Collects one `AgentWeekMetrics` per running agent from the live stores
 * (traces, usage, memory census, heartbeat transition journal, persisted
 * workflow summaries), grades them with the shared rubric and posts ONE
 * fleet card to the admin channel. Mirrors memory-digest-cron.ts: croner
 * behind a factory, per-agent failure isolation, the collector exported so
 * the `report-card` IPC (CLI, dashboard) serves the same numbers.
 */

import { Cron } from "croner";
import type { Logger } from "pino";
import type { MemoryStore } from "../memory/store.js";
import type { TraceStore } from "../performance/trace-store.js";
import type { UsageTracker } from "../usage/tracker.js";
import type { HeartbeatIncidentSummary } from "../heartbeat/transition-journal.js";
import { spawnKindOf } from "./subagent-name.js";
import {
  collectMemoryCensus,
  memoryCensusProblems,
  type MemoryCensusSource,
} from "./memory-census.js";
import {
  gradeAgent,
  renderReportCard,
  type AgentGrade,
  type AgentWeekMetrics,
  type ReportCard,
} from "./report-card.js";

export const DEFAULT_REPORT_CARD_CRON = "10 9 * * 1"; // Mondays 09:10, after the digests
export const DEFAULT_REPORT_CARD_TIMEZONE = "America/Los_Angeles";
export const REPORT_CARD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ReportCardCronHandle = { readonly stop: () => void };
export type ReportCardCronFactory = (
  pattern: string,
  opts: { readonly name: string; readonly timezone?: string },
  callback: () => unknown | Promise<unknown>,
) => ReportCardCronHandle;

const DEFAULT_FACTORY: ReportCardCronFactory = (pattern, opts, callback) => {
  const cron = new Cron(
    pattern,
    { name: opts.name, ...(opts.timezone ? { timezone: opts.timezone } : {}) },
    async () => {
      await callback();
    },
  );
  return { stop: () => cron.stop() };
};

export interface WorkflowWeekStats {
  readonly run: number;
  readonly failed: number;
}

export interface ReportCardDeps {
  readonly manager: MemoryCensusSource & {
    getRunningAgents(): readonly string[];
    getTraceStore(agent: string): TraceStore | undefined;
    getUsageTracker(agent: string): UsageTracker | undefined;
    getMemoryStore(agent: string): MemoryStore | undefined;
  };
  /** Heartbeat transitions over a window (the runner's journal). */
  readonly incidents: (windowMs: number) => HeartbeatIncidentSummary;
  /** Workflow runs finished inside [sinceMs, untilMs] for the agent (persisted summaries). */
  readonly workflowStats?: (agent: string, sinceMs: number, untilMs: number) => Promise<WorkflowWeekStats>;
  readonly log: Logger;
  readonly now?: () => number;
}

/** Collect + grade every running top-level agent. Never throws; a failing agent is logged and skipped. */
export async function collectFleetReportCard(deps: ReportCardDeps): Promise<ReportCard> {
  const now = deps.now?.() ?? Date.now();
  const since = now - REPORT_CARD_WINDOW_MS;
  const prevSince = since - REPORT_CARD_WINDOW_MS;
  const iso = (ms: number): string => new Date(ms).toISOString();
  const incidents = deps.incidents(REPORT_CARD_WINDOW_MS);
  const agents: Array<{ metrics: AgentWeekMetrics; grade: AgentGrade }> = [];

  for (const agent of deps.manager.getRunningAgents()) {
    if (spawnKindOf(agent) !== "agent") continue;
    try {
      const trace = deps.manager.getTraceStore(agent);
      const usage = deps.manager.getUsageTracker(agent);
      const store = deps.manager.getMemoryStore(agent);

      const turns = trace ? trace.getTurnSummarySince(agent, iso(since)).n : 0;
      const turnsPrevAll = trace ? trace.getTurnSummarySince(agent, iso(prevSince)).n : 0;
      const firstToken = trace ? trace.getFirstTokenPercentiles(agent, iso(since)) : null;
      const cache = trace ? trace.getCacheTelemetry(agent, iso(since)) : null;
      const cost = usage ? usage.getUsageInRange(iso(since), iso(now)).cost_usd : 0;
      const costPrev = usage ? usage.getUsageInRange(iso(prevSince), iso(since)).cost_usd : 0;
      const memoriesNew = store ? store.countInRange(iso(since), iso(now)) : 0;
      const memoriesNewPrev = store ? store.countInRange(iso(prevSince), iso(since)) : 0;
      const census = store ? collectMemoryCensus(deps.manager, agent, now) : null;
      const byAgent = incidents.byAgent[agent];
      const workflows = deps.workflowStats
        ? await deps.workflowStats(agent, since, now)
        : { run: 0, failed: 0 };

      const metrics: AgentWeekMetrics = Object.freeze({
        agent,
        turns,
        turnsPrev: Math.max(0, turnsPrevAll - turns),
        costUsd: cost,
        costUsdPrev: costPrev,
        firstTokenP50Ms: firstToken && firstToken.count > 0 ? firstToken.p50 : null,
        firstTokenP95Ms: firstToken && firstToken.count > 0 ? firstToken.p95 : null,
        cacheHitRate: cache && cache.totalTurns > 0 ? cache.avgHitRate : null,
        memoriesNew,
        memoriesNewPrev,
        memoryProblems: census ? memoryCensusProblems(census) : [],
        incidentsWarning: byAgent?.warning ?? 0,
        incidentsCritical: byAgent?.critical ?? 0,
        openChecks: byAgent?.open ?? [],
        unverifiedFigures: null,
        workflowsRun: workflows.run,
        workflowsFailed: workflows.failed,
      });
      agents.push({ metrics, grade: gradeAgent(metrics) });
    } catch (err) {
      deps.log.warn(
        { agent, error: err instanceof Error ? err.message : String(err) },
        "report card: agent skipped (collection failed)",
      );
    }
  }
  return Object.freeze({ since: iso(since), until: iso(now), agents: Object.freeze(agents) });
}

export interface ScheduleReportCardCronArgs extends ReportCardDeps {
  /** Posts the card to the admin channel. */
  readonly postToAdmin: (text: string) => Promise<void>;
  readonly cronFactory?: ReportCardCronFactory;
  readonly pattern?: string;
  readonly timezone?: string;
}

/** One tick: collect, render, post. Exported for tests and the IPC. */
export async function runReportCardTick(args: ScheduleReportCardCronArgs): Promise<{ posted: boolean; agents: number }> {
  const card = await collectFleetReportCard(args);
  const text = renderReportCard(card);
  if (text.length === 0) {
    args.log.info("report card: no agents to grade — nothing posted");
    return { posted: false, agents: 0 };
  }
  try {
    await args.postToAdmin(text);
    args.log.info({ agents: card.agents.length }, "report card posted");
    return { posted: true, agents: card.agents.length };
  } catch (err) {
    args.log.warn({ error: err instanceof Error ? err.message : String(err) }, "report card post failed");
    return { posted: false, agents: card.agents.length };
  }
}

export function scheduleReportCardCron(args: ScheduleReportCardCronArgs): ReportCardCronHandle {
  const factory = args.cronFactory ?? DEFAULT_FACTORY;
  const pattern = args.pattern ?? DEFAULT_REPORT_CARD_CRON;
  const timezone = args.timezone ?? DEFAULT_REPORT_CARD_TIMEZONE;
  return factory(pattern, { name: "report-card", timezone }, async () => {
    args.log.info({ pattern, timezone }, "report-card cron tick");
    await runReportCardTick(args);
  });
}
