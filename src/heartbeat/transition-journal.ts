/**
 * Phase 999.122 — heartbeat status-transition journal.
 *
 * WHY. The runner keeps only the LATEST result per (agent, check) and logs
 * only `critical` results to the daemon journal. A check that went
 * `warning` at 03:00 and recovered by 08:00 left no trace anywhere an
 * operator reads: `/api/health` shows the current state, the systemd
 * journal never saw it, and the per-agent `heartbeat.log` (every result,
 * every tick) is too noisy to read. The daily fleet brief therefore
 * reported "all green" on days that had incidents.
 *
 * WHAT. Every status CHANGE (healthy→warning, warning→critical,
 * critical→healthy, first observation that is not healthy) is recorded in
 * a bounded ring, appended to a JSONL file so a daemon restart keeps the
 * last two days, and surfaced on the `heartbeat-status` payload as
 * `incidents` (which `/api/health` and `clawcode health` carry). Logging
 * to the daemon journal is rate-limited per (agent, check) so a flapping
 * check cannot spam it. Transition-only recording is what keeps the file
 * small: a check that stays `warning` for a week writes one line.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CheckResult, CheckStatus } from "./types.js";

export type HeartbeatTransition = Readonly<{
  /** ISO timestamp of the tick that observed the new status. */
  timestamp: string;
  agent: string;
  check: string;
  /** Previous status, or null when this is the first observation. */
  from: CheckStatus | null;
  to: CheckStatus;
  /** The check's message at the moment of the transition (truncated). */
  message: string;
}>;

export type HeartbeatIncidentAgentSummary = Readonly<{
  /** Transitions INTO `warning` inside the window. */
  warning: number;
  /** Transitions INTO `critical` inside the window. */
  critical: number;
  /** Transitions back to `healthy` inside the window. */
  recovered: number;
  /** Checks whose most recent journaled transition is still non-healthy. */
  open: readonly string[];
}>;

export type HeartbeatIncidentSummary = Readonly<{
  /** ISO start of the window the transitions were taken from. */
  since: string;
  /** Oldest first. */
  transitions: readonly HeartbeatTransition[];
  byAgent: Readonly<Record<string, HeartbeatIncidentAgentSummary>>;
}>;

export type HeartbeatTransitionJournalOptions = Readonly<{
  /** Ring bound; the oldest entries are dropped past it. Default 2000. */
  maxEntries?: number;
  /** Entries older than this are dropped on prune. Default 48 h. */
  retentionMs?: number;
  /** Minimum gap between journal-log emissions for one (agent, check). Default 10 min. */
  logCooldownMs?: number;
  /** JSONL file the ring is appended to and reloaded from. Optional. */
  persistPath?: string;
  /** Called when a persistence write/read fails (best-effort store). */
  onError?: (err: Error) => void;
  now?: () => number;
}>;

export const DEFAULT_TRANSITION_MAX_ENTRIES = 2000;
export const DEFAULT_TRANSITION_RETENTION_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_TRANSITION_LOG_COOLDOWN_MS = 10 * 60 * 1000;
export const DEFAULT_INCIDENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MESSAGE_MAX_CHARS = 300;
/** The file is rewritten from the ring once it holds this many stale lines. */
const REWRITE_SLACK_LINES = 1000;

const STATUSES: ReadonlySet<string> = new Set(["healthy", "warning", "critical"]);

function isTransition(value: unknown): value is HeartbeatTransition {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.timestamp === "string" &&
    typeof v.agent === "string" &&
    typeof v.check === "string" &&
    (v.from === null || (typeof v.from === "string" && STATUSES.has(v.from))) &&
    typeof v.to === "string" &&
    STATUSES.has(v.to) &&
    typeof v.message === "string"
  );
}

export class HeartbeatTransitionJournal {
  private readonly maxEntries: number;
  private readonly retentionMs: number;
  private readonly logCooldownMs: number;
  private readonly persistPath: string | undefined;
  private readonly onError: ((err: Error) => void) | undefined;
  private readonly now: () => number;
  private entries: HeartbeatTransition[] = [];
  private readonly lastLoggedAt: Map<string, number> = new Map();

  constructor(options: HeartbeatTransitionJournalOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_TRANSITION_MAX_ENTRIES;
    this.retentionMs = options.retentionMs ?? DEFAULT_TRANSITION_RETENTION_MS;
    this.logCooldownMs = options.logCooldownMs ?? DEFAULT_TRANSITION_LOG_COOLDOWN_MS;
    this.persistPath = options.persistPath;
    this.onError = options.onError;
    this.now = options.now ?? Date.now;
    this.load();
  }

  /**
   * Record the outcome of one check execution. Returns the transition when
   * the status changed (or when the first observation is not healthy),
   * else null. Same status as last time is never journaled.
   */
  record(
    agent: string,
    check: string,
    previous: CheckStatus | undefined,
    result: CheckResult,
    timestamp: string,
  ): HeartbeatTransition | null {
    // A restart empties the runner's latest-results map, so the first
    // observation after boot arrives with `previous` undefined. Fall back to
    // the journal's own last word for the check: a warning journaled before
    // the restart that now reads healthy is a RECOVERY (else it stays "open"
    // forever), and a warning that is still a warning is not a new incident.
    const prior = previous ?? this.latestStatus(agent, check);
    if (prior === result.status) return null;
    if (prior === undefined && result.status === "healthy") return null;
    const transition: HeartbeatTransition = Object.freeze({
      timestamp,
      agent,
      check,
      from: prior ?? null,
      to: result.status,
      message: result.message.slice(0, MESSAGE_MAX_CHARS),
    });
    this.entries = this.pruned([...this.entries, transition]);
    this.append(transition);
    return transition;
  }

  /** The status the journal last recorded for (agent, check), if any. */
  latestStatus(agent: string, check: string): CheckStatus | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const t = this.entries[i]!;
      if (t.agent === agent && t.check === check) return t.to;
    }
    return undefined;
  }

  /**
   * Rate limit for journal-log emission: true at most once per cooldown
   * for one (agent, check). The ring itself records every transition.
   */
  shouldLog(agent: string, check: string, nowMs: number = this.now()): boolean {
    const key = `${agent}:${check}`;
    const last = this.lastLoggedAt.get(key);
    if (last !== undefined && nowMs - last < this.logCooldownMs) return false;
    this.lastLoggedAt.set(key, nowMs);
    return true;
  }

  /** Transitions observed at or after `sinceMs`, oldest first. */
  recent(sinceMs: number): readonly HeartbeatTransition[] {
    return this.entries.filter((t) => Date.parse(t.timestamp) >= sinceMs);
  }

  /** Everything the ring holds, oldest first. */
  all(): readonly HeartbeatTransition[] {
    return this.entries;
  }

  /** The incident view the health payload carries. */
  summary(windowMs: number = DEFAULT_INCIDENT_WINDOW_MS): HeartbeatIncidentSummary {
    const sinceMs = this.now() - windowMs;
    const transitions = this.recent(sinceMs);
    const counts = new Map<string, { warning: number; critical: number; recovered: number }>();
    for (const t of transitions) {
      const c = counts.get(t.agent) ?? { warning: 0, critical: 0, recovered: 0 };
      const next =
        t.to === "warning"
          ? { ...c, warning: c.warning + 1 }
          : t.to === "critical"
            ? { ...c, critical: c.critical + 1 }
            : { ...c, recovered: c.recovered + 1 };
      counts.set(t.agent, next);
    }
    // Open = the latest journaled transition for the (agent, check) is not
    // healthy. Taken over the WHOLE ring so a warning that opened before the
    // window and never recovered still shows as open.
    const latest = new Map<string, HeartbeatTransition>();
    for (const t of this.entries) latest.set(`${t.agent}:${t.check}`, t);
    const open = new Map<string, string[]>();
    for (const t of latest.values()) {
      if (t.to === "healthy") continue;
      open.set(t.agent, [...(open.get(t.agent) ?? []), t.check]);
    }
    const agents = new Set([...counts.keys(), ...open.keys()]);
    const byAgent: Record<string, HeartbeatIncidentAgentSummary> = {};
    for (const agent of [...agents].sort()) {
      const c = counts.get(agent) ?? { warning: 0, critical: 0, recovered: 0 };
      byAgent[agent] = Object.freeze({ ...c, open: Object.freeze([...(open.get(agent) ?? [])].sort()) });
    }
    return Object.freeze({
      since: new Date(sinceMs).toISOString(),
      transitions,
      byAgent: Object.freeze(byAgent),
    });
  }

  private pruned(entries: readonly HeartbeatTransition[]): HeartbeatTransition[] {
    const cutoff = this.now() - this.retentionMs;
    const kept = entries.filter((t) => Date.parse(t.timestamp) >= cutoff);
    return kept.length > this.maxEntries ? kept.slice(kept.length - this.maxEntries) : kept;
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const lines = readFileSync(this.persistPath, "utf-8").split("\n").filter((l) => l.length > 0);
      const parsed: HeartbeatTransition[] = [];
      for (const line of lines) {
        try {
          const value: unknown = JSON.parse(line);
          if (isTransition(value)) parsed.push(Object.freeze({ ...value }));
        } catch {
          // A torn line (crash mid-append) is dropped; the rest still loads.
        }
      }
      this.entries = this.pruned(parsed);
      if (lines.length > this.entries.length + REWRITE_SLACK_LINES) {
        writeFileSync(
          this.persistPath,
          this.entries.map((t) => JSON.stringify(t)).join("\n") + (this.entries.length ? "\n" : ""),
        );
      }
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private append(transition: HeartbeatTransition): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      appendFileSync(this.persistPath, JSON.stringify(transition) + "\n");
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
