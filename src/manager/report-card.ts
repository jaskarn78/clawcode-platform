/**
 * Phase 999.130 — weekly agent report card.
 *
 * WHY. The fleet's health signals live in six places (traces, usage,
 * memory census, heartbeat incidents, verification, workflows) and the
 * operator sees each only when it misbehaves. Once a week the daemon
 * grades every agent on the same rubric and posts one fleet card to the
 * admin channel: a traffic light per agent, the numbers behind it, and
 * the week-over-week deltas. Deterministic, no model turn.
 *
 * Pure: `gradeAgent` and `renderReportCard` take the collected numbers;
 * the cron (report-card-cron.ts) collects them from the live stores.
 */

export interface AgentWeekMetrics {
  readonly agent: string;
  /** Turns in the window and in the window before it. */
  readonly turns: number;
  readonly turnsPrev: number;
  readonly costUsd: number;
  readonly costUsdPrev: number;
  /** First-token latency percentiles (ms); null when no data. */
  readonly firstTokenP50Ms: number | null;
  readonly firstTokenP95Ms: number | null;
  /** Prompt-cache hit rate 0..1 over the window; null when no turns. */
  readonly cacheHitRate: number | null;
  /** Memories created in the window / the window before. */
  readonly memoriesNew: number;
  readonly memoriesNewPrev: number;
  /** Memory-census problems (empty = clean). */
  readonly memoryProblems: readonly string[];
  /** Heartbeat status transitions in the window. */
  readonly incidentsWarning: number;
  readonly incidentsCritical: number;
  /** Checks still non-healthy at report time. */
  readonly openChecks: readonly string[];
  /** Verification: unverified figures flagged by workflows (null = no data). */
  readonly unverifiedFigures: number | null;
  readonly workflowsRun: number;
  readonly workflowsFailed: number;
}

export type Grade = "green" | "yellow" | "red";

export interface AgentGrade {
  readonly agent: string;
  readonly grade: Grade;
  /** Why it is not green, in order of severity. */
  readonly reasons: readonly string[];
}

/** Rubric thresholds (one place, easy to argue about). */
export const REPORT_CARD_RUBRIC = {
  firstTokenP50WarnMs: 45_000,
  firstTokenP95RedMs: 180_000,
  cacheHitWarnRate: 0.3,
  cacheHitMinTurns: 20,
  incidentsWarnCount: 3,
  memoriesGrowthWarnFactor: 3,
  memoriesGrowthWarnMin: 40,
} as const;

export function gradeAgent(m: AgentWeekMetrics): AgentGrade {
  const red: string[] = [];
  const yellow: string[] = [];
  const r = REPORT_CARD_RUBRIC;
  if (m.incidentsCritical > 0) red.push(`${m.incidentsCritical} critical incident(s)`);
  if (m.firstTokenP95Ms !== null && m.firstTokenP95Ms > r.firstTokenP95RedMs) {
    red.push(`first token p95 ${fmtSec(m.firstTokenP95Ms)}`);
  }
  if (m.workflowsFailed > 0 && m.workflowsFailed >= m.workflowsRun) {
    red.push(`every workflow failed (${m.workflowsFailed})`);
  }
  if (m.openChecks.length > 0) yellow.push(`open: ${m.openChecks.join(", ")}`);
  if (m.incidentsWarning > r.incidentsWarnCount) yellow.push(`${m.incidentsWarning} warning transitions`);
  if (m.firstTokenP50Ms !== null && m.firstTokenP50Ms > r.firstTokenP50WarnMs) {
    yellow.push(`first token p50 ${fmtSec(m.firstTokenP50Ms)}`);
  }
  if (m.cacheHitRate !== null && m.turns >= r.cacheHitMinTurns && m.cacheHitRate < r.cacheHitWarnRate) {
    yellow.push(`cache hit ${Math.round(m.cacheHitRate * 100)}%`);
  }
  if (m.memoryProblems.length > 0) yellow.push(`memory: ${m.memoryProblems[0]}`);
  if (
    m.memoriesNew >= r.memoriesGrowthWarnMin &&
    m.memoriesNewPrev > 0 &&
    m.memoriesNew > m.memoriesNewPrev * r.memoriesGrowthWarnFactor
  ) {
    yellow.push(`memory growth ${m.memoriesNew} vs ${m.memoriesNewPrev} last week`);
  }
  if (m.unverifiedFigures !== null && m.unverifiedFigures > 0) {
    yellow.push(`${m.unverifiedFigures} unverified figure(s) in reports`);
  }
  if (m.workflowsFailed > 0 && m.workflowsFailed < m.workflowsRun) {
    yellow.push(`${m.workflowsFailed}/${m.workflowsRun} workflows failed`);
  }
  const grade: Grade = red.length > 0 ? "red" : yellow.length > 0 ? "yellow" : "green";
  return Object.freeze({ agent: m.agent, grade, reasons: Object.freeze([...red, ...yellow]) });
}

const LIGHT: Record<Grade, string> = { green: "🟢", yellow: "🟡", red: "🔴" };

function fmtSec(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

function delta(now: number, prev: number, unit: "count" | "usd"): string {
  if (prev === 0) return now === 0 ? "" : " (new)";
  const pct = Math.round(((now - prev) / prev) * 100);
  if (Math.abs(pct) < 5) return " (flat)";
  const arrow = pct > 0 ? "▲" : "▼";
  return unit === "usd" ? ` (${arrow}${Math.abs(pct)}%)` : ` (${arrow}${Math.abs(pct)}%)`;
}

/** One agent's two lines. */
export function renderAgentLine(m: AgentWeekMetrics, g: AgradeLike): string {
  const head =
    `${LIGHT[g.grade]} **${m.agent}** · ${m.turns} turn${m.turns === 1 ? "" : "s"}${delta(m.turns, m.turnsPrev, "count")}` +
    ` · $${m.costUsd.toFixed(2)}${delta(m.costUsd, m.costUsdPrev, "usd")}` +
    (m.firstTokenP50Ms !== null ? ` · first token p50 ${fmtSec(m.firstTokenP50Ms)}` : "") +
    (m.cacheHitRate !== null && m.turns > 0 ? ` · cache ${Math.round(m.cacheHitRate * 100)}%` : "");
  const facts = [
    `memory +${m.memoriesNew}${delta(m.memoriesNew, m.memoriesNewPrev, "count")}`,
    m.incidentsWarning + m.incidentsCritical > 0
      ? `incidents ${m.incidentsWarning} warn / ${m.incidentsCritical} crit`
      : "incidents 0",
    ...(m.workflowsRun > 0 ? [`workflows ${m.workflowsRun - m.workflowsFailed}/${m.workflowsRun} ok`] : []),
    ...(m.unverifiedFigures !== null ? [`unverified figures ${m.unverifiedFigures}`] : []),
  ];
  const why = g.reasons.length > 0 ? `\n-# why: ${g.reasons.join("; ")}` : "";
  return `${head}\n-# ${facts.join(" · ")}${why}`;
}

type AgradeLike = { readonly grade: Grade; readonly reasons: readonly string[] };

export interface ReportCard {
  readonly since: string;
  readonly until: string;
  readonly agents: ReadonlyArray<{ metrics: AgentWeekMetrics; grade: AgentGrade }>;
}

/** The fleet card. Empty string when there are no agents. */
export function renderReportCard(card: ReportCard): string {
  if (card.agents.length === 0) return "";
  const sorted = [...card.agents].sort((a, b) => {
    const order: Record<Grade, number> = { red: 0, yellow: 1, green: 2 };
    return order[a.grade.grade] - order[b.grade.grade] || b.metrics.turns - a.metrics.turns;
  });
  const counts = { red: 0, yellow: 0, green: 0 } as Record<Grade, number>;
  for (const a of sorted) counts[a.grade.grade] += 1;
  const totalTurns = sorted.reduce((n, a) => n + a.metrics.turns, 0);
  const totalCost = sorted.reduce((n, a) => n + a.metrics.costUsd, 0);
  const lines = [
    "📋 **Agent report card**",
    `-# ${card.since.slice(0, 10)} to ${card.until.slice(0, 10)} · ${sorted.length} agents · ${totalTurns} turns · $${totalCost.toFixed(2)} · 🟢 ${counts.green} 🟡 ${counts.yellow} 🔴 ${counts.red}`,
    "",
    ...sorted.map((a) => renderAgentLine(a.metrics, a.grade)),
  ];
  return lines.join("\n");
}
