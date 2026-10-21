/**
 * Phase 999.173 — research card renderer (pure: no discord.js value import).
 *
 * A separate message in the status-trail style (hold-status `renderSubtext`):
 * a bold header over `-#` subtext lines, ✓ / → only, no emoji. Progress comes
 * only from stream events (task_progress summaries / last tool), never from
 * model narration — except the latest folded interim parent line, rendered as
 * a quotation (like a trail "speech" item) so it never reads as an action.
 *
 *   Researching · 3 running · 1:42
 *   ✓ Chicago weather history
 *   → Course elevation profile — Reading the race PDF
 *   → Hotel walking distance — using web_search
 *   “Mercury done, Venus still running”
 *
 * Controls (only while running): exactly two GREY buttons in one row, however
 * many researchers run — Status (ephemeral detail) and Stop… (an ephemeral
 * picker: a select menu of the running researchers plus "Stop all"). No
 * danger-red buttons on the card (operator, 2026-09-25: "all those buttons don't
 * look great"). Icons from the cc_* registry; text-only when missing.
 */

import { formatElapsed } from "./duration-format.js";
import type { IconRegistry } from "./icons.js";
import type { ResearchCardSnapshot } from "../manager/research-card-sink.js";
import type { ResearchCardTaskView } from "../manager/research-registry.js";

export const RESEARCH_BUTTON_PREFIX = "rsch:";
const LINE_MAX = 110;

export type ResearchButtonId =
  | Readonly<{ action: "status"; key: string }>
  | Readonly<{ action: "stop-menu"; key: string }>
  | Readonly<{ action: "stop-select"; key: string }>;

/** Value of the picker's "Stop all" option (task indexes are the other values). */
export const STOP_ALL_VALUE = "all";
/** Discord string-select limits. */
const SELECT_LABEL_MAX = 100;
const SELECT_DESCRIPTION_MAX = 100;

export function encodeResearchStatusId(key: string): string {
  return `${RESEARCH_BUTTON_PREFIX}s:${key}`;
}

/** The card's Stop… button (opens the ephemeral picker). */
export function encodeResearchStopId(key: string): string {
  return `${RESEARCH_BUTTON_PREFIX}x:${key}`;
}

/** The ephemeral picker's select menu. */
export function encodeResearchStopSelectId(key: string): string {
  return `${RESEARCH_BUTTON_PREFIX}k:${key}`;
}

export function parseResearchButtonId(customId: string): ResearchButtonId | null {
  const parts = customId.split(":");
  if (parts[0] !== "rsch" || !/^[0-9a-f]{8}$/.test(parts[2] ?? "")) return null;
  if (parts[1] === "s" && parts.length === 3) return { action: "status", key: parts[2]! };
  if (parts[1] === "k" && parts.length === 3) return { action: "stop-select", key: parts[2]! };
  // Legacy per-researcher Stop buttons (`rsch:x:<key>:<n>`, pre-polish cards)
  // open the same picker.
  if (parts[1] === "x" && (parts.length === 3 || (parts.length === 4 && /^\d{1,2}$/.test(parts[3]!)))) {
    return { action: "stop-menu", key: parts[2]! };
  }
  return null;
}

/** A picker value: a task index, or "all"; null when malformed. */
export function parseStopSelection(value: unknown): number | "all" | null {
  if (value === STOP_ALL_VALUE) return "all";
  if (typeof value === "string" && /^\d{1,2}$/.test(value)) return Number(value);
  return null;
}

function clip(text: string, max = LINE_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function withElapsed(head: string, elapsedMs: number): string {
  const e = formatElapsed(elapsedMs);
  return e.length > 0 ? `${head} · ${e}` : head;
}

export function researchCardHeader(snap: ResearchCardSnapshot): string {
  const tasks = snap.session.tasks;
  const done = tasks.filter((t) => t.status === "completed").length;
  const running = tasks.filter((t) => t.status === "running").length;
  const end = snap.settled?.at ?? snap.now;
  const elapsed = end - snap.session.startedAt;
  const n = tasks.length;
  if (snap.settled === null && snap.writingSince !== undefined && running === 0) {
    // Every researcher is done; the agent is writing the answer now.
    return withElapsed(`Writing up the findings · ${done} of ${n} researched`, elapsed);
  }
  if (snap.settled === null) {
    const notes = (snap.notes ?? []).filter((n) => n.length > 0);
    return withElapsed(["Researching", `${running} running`, ...notes].join(" · "), elapsed);
  }
  if (snap.settled.outcome === "timeout") return withElapsed(`Research timed out · ${done} of ${n}`, elapsed);
  if (snap.settled.outcome === "interrupted") return withElapsed(`Research interrupted · ${done} of ${n}`, elapsed);
  // Settled on any terminal mix: all done, some failed, or none finished.
  if (done === n) return withElapsed(`Researched · ${n} researcher${n === 1 ? "" : "s"}`, elapsed);
  if (done > 0) return withElapsed(`Researched · ${done} of ${n}`, elapsed);
  return withElapsed(`Research stopped · 0 of ${n}`, elapsed);
}

/** ✓ finished, → running, ✗ did not finish (failed / stopped / lost). */
function taskLine(t: ResearchCardTaskView): string {
  const desc = clip(t.description, 70);
  switch (t.status) {
    case "completed":
      return `✓ ${desc}`;
    case "running":
      return t.lastLine ? `→ ${clip(`${desc} — ${t.lastLine}`)}` : `→ ${desc}…`;
    default:
      return `✗ ${desc}`;
  }
}

export function renderResearchCardContent(snap: ResearchCardSnapshot): string {
  const lines = [`**${researchCardHeader(snap)}**`];
  for (const t of snap.session.tasks) lines.push(`-# ${taskLine(t)}`);
  // The interim filler ("two still running") is stale once the write-up starts.
  if (snap.interim !== null && snap.settled === null && snap.writingSince === undefined) lines.push(`-# “${clip(snap.interim)}”`);
  // Why some researchers did not finish — once, short, never the raw error.
  const unfinished = snap.session.tasks.some((t) => t.status !== "completed" && t.status !== "running");
  if (snap.settled !== null && unfinished && snap.reason) lines.push(`-# ${clip(snap.reason)}`);
  if (snap.settled !== null && unfinished && snap.savedTo) lines.push(`-# Notes saved in ${snap.savedTo}`);
  return lines.join("\n");
}

type ButtonJson = {
  type: 2;
  style: number;
  label: string;
  custom_id: string;
  emoji?: { id: string; name: string };
};

/** Discord button style 2 = secondary (grey). The card never uses danger (4). */
const SECONDARY = 2;

export function renderResearchCardComponents(
  snap: ResearchCardSnapshot,
  iconSet?: Pick<IconRegistry, "button">,
): { type: 1; components: ButtonJson[] }[] {
  if (snap.settled !== null) return [];
  const running = snap.session.tasks.filter((t) => t.status === "running");
  if (running.length === 0) return [];
  const withIcon = (b: ButtonJson, icon: "info" | "stop"): ButtonJson => {
    const ref = iconSet?.button(icon);
    return ref ? { ...b, emoji: { id: ref.id, name: ref.name } } : b;
  };
  return [
    {
      type: 1,
      components: [
        withIcon({ type: 2, style: SECONDARY, label: "Status", custom_id: encodeResearchStatusId(snap.session.key) }, "info"),
        withIcon({ type: 2, style: SECONDARY, label: "Stop…", custom_id: encodeResearchStopId(snap.session.key) }, "stop"),
      ],
    },
  ];
}

function trimTo(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

type SelectJson = {
  type: 3;
  custom_id: string;
  placeholder: string;
  min_values: 1;
  max_values: 1;
  options: { label: string; value: string; description?: string }[];
};

/**
 * The Stop… picker (sent ephemerally): one option per RUNNING researcher,
 * labelled by its description, then "Stop all". Empty when nothing runs.
 */
export function renderResearchStopPicker(
  session: ResearchCardSnapshot["session"],
): { type: 1; components: SelectJson[] }[] {
  const running = session.tasks.filter((t) => t.status === "running");
  if (running.length === 0) return [];
  const options = running.slice(0, 24).map((t) => ({
    label: trimTo(t.description, SELECT_LABEL_MAX) || `Researcher ${t.index + 1}`,
    value: String(t.index),
    ...(t.lastLine ? { description: trimTo(t.lastLine, SELECT_DESCRIPTION_MAX) } : {}),
  }));
  options.push({ label: "Stop all", value: STOP_ALL_VALUE });
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: encodeResearchStopSelectId(session.key),
          placeholder: "Choose a researcher to stop",
          min_values: 1,
          max_values: 1,
          options,
        },
      ],
    },
  ];
}

/** Ephemeral Status reply: one block per researcher. */
export function renderResearchStatus(
  session: ResearchCardSnapshot["session"],
  now: number,
): string {
  const lines = [`**Research · ${session.tasks.length} researcher${session.tasks.length === 1 ? "" : "s"}**`];
  for (const t of session.tasks) {
    const elapsed = formatElapsed((t.endedAt ?? now) - t.startedAt) || "just now";
    lines.push(`${t.index + 1}. ${clip(t.description, 90)} · ${t.status} · ${elapsed}`);
    if (t.lastLine) lines.push(`-# ${clip(t.lastLine)}`);
  }
  return lines.join("\n");
}
