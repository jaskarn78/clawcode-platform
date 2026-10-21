/**
 * `list_schedules` output — config crons AND runtime recurring schedules.
 *
 * 999.174 WS-0 (2026-09-24): client-a-personal reported two "phantom" schedules
 * (wBjToBxI 07:15 daily, Pq_nZU9t Nov 20-30) missing from `list_schedules`. They
 * were live all along — created 9/23 15:08 via `schedule_recurring`, restored on
 * every restart, and wBjToBxI fired 9/24 07:15. The daemon's `schedules` IPC has
 * returned `{ schedules, recurring }` since 999.99 SC-4, but this tool only
 * rendered `schedules`, so every agent-created recurring schedule was invisible
 * to the agent that created it. Pure, so it is unit-testable.
 */

export type ConfigScheduleStatus = {
  readonly agentName: string;
  readonly name: string;
  readonly cron: string;
  readonly enabled: boolean;
  readonly nextRun: string | null;
};

export type RecurringScheduleSummary = {
  readonly scheduleId: string;
  readonly agentName: string;
  readonly cron: string;
  readonly prompt: string;
};

export type SchedulesIpcResult = {
  readonly schedules: readonly ConfigScheduleStatus[];
  /** Absent from daemons older than 999.99 SC-4. */
  readonly recurring?: readonly RecurringScheduleSummary[];
};

const PROMPT_PREVIEW_CHARS = 60;

function preview(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > PROMPT_PREVIEW_CHARS ? `${flat.slice(0, PROMPT_PREVIEW_CHARS - 1)}…` : flat;
}

export function renderScheduleList(result: SchedulesIpcResult): string {
  const recurring = result.recurring ?? [];
  if (result.schedules.length === 0 && recurring.length === 0) return "No scheduled tasks";
  const lines = result.schedules.map(
    (s) => `${s.agentName}/${s.name}: ${s.cron} (${s.enabled ? "enabled" : "disabled"})${s.nextRun ? ` next: ${s.nextRun}` : ""}`,
  );
  if (recurring.length > 0) {
    lines.push("", "Recurring (created with schedule_recurring):");
    for (const r of recurring) lines.push(`${r.agentName}/recurring:${r.scheduleId}: ${r.cron} — ${preview(r.prompt)}`);
  }
  return lines.join("\n");
}
