/**
 * Phase 999.X — Subagent-thread session reaper.
 *
 * Catches the today-fire pattern (admin-clawdy 2026-05-04): auto-spawned
 * subagent threads (`fin-client-via-fin-research-57r__G`,
 * `…-4XZKL0`) sitting at status `running` for 8h+/13h+ after their work
 * completed. The existing `stale-binding-sweep` (Phase 999.14 MCP-09)
 * archives the Discord thread + prunes the binding, but does NOT stop
 * the underlying claude session — the subagent process keeps running
 * indefinitely. This reaper closes that gap by walking the session
 * registry on the 60s `onTickAfter`, identifying running subagent
 * sessions whose thread binding has gone idle (or is missing entirely),
 * and gracefully stopping them via `SessionManager.stopAgent` (the same
 * code path `clawcode stop` uses).
 *
 * Modes (rollback safety, hot-reload via ConfigReloader):
 *   - "off"   — module noop. Operator escape hatch.
 *   - "alert" — scan + emit one canonical pino warn per candidate. No
 *               stops.
 *   - "reap"  — scan + alert + call `stopAgent(name)` per candidate.
 *               Default per operator decision: the screenshot showed
 *               real leaks today, so we act on the first tick rather
 *               than running alert-only first.
 *
 * False-positive guards (non-negotiable):
 *   - Name regex (`isSubagentThreadName`) — operator-defined agent
 *     names (no `-{nanoid6}` suffix) are NEVER touched.
 *   - `status === "running"` — sessions in `starting`, `stopping`,
 *     `crashed`, `restarting`, `failed` are skipped (the 2026-04-30
 *     duplicate-proc incident referenced in CLAUDE.md was caused by
 *     reflexively running `start` on a `starting` agent).
 *   - `minAgeSeconds` (default 300 = 5 min) — never reap a session
 *     under 5 min old. Avoids racing the spawner.
 *   - Kill-switch env: `CLAWCODE_SUBAGENT_REAPER_DISABLE=1`.
 *
 * Canonical log shape (pinned by tests):
 *   { component: "subagent-session-reaper",
 *     action: "alert" | "reap",
 *     agent, sessionName, ageSec, lastActivityAgeSec | null, mode,
 *     msg: "subagent session candidate detected" |
 *          "reaping subagent session" }
 */

import type { Logger } from "pino";
import type { ThreadBinding } from "../discord/thread-types.js";
import { isSubagentThreadName } from "./subagent-name.js";

export type SubagentReaperMode = "off" | "alert" | "reap";

/**
 * Minimal slice of a registry entry the reaper reads. Defined as a
 * structural type so tests don't need a full RegistryEntry mock.
 */
export type RunningSessionInfo = {
  readonly name: string;
  readonly status: string;
  readonly startedAt: number | null;
};

export type SubagentReaperCandidate = {
  readonly name: string;
  readonly threadId: string | null;
  readonly ageSec: number;
  /**
   * Seconds since the binding's `lastActivity`, or null if the binding
   * is missing entirely (orphan — binding already pruned by stale-
   * binding-sweep but session still running).
   */
  readonly lastActivityAgeSec: number | null;
};

export type ScanArgs = {
  /** Snapshot of running sessions at tick start (typically registry.entries). */
  readonly sessions: readonly RunningSessionInfo[];
  /** Snapshot of thread bindings at tick start. */
  readonly bindings: readonly ThreadBinding[];
  readonly idleTimeoutMinutes: number;
  readonly minAgeSeconds: number;
  /** Test seam — defaults to Date.now(). */
  readonly now?: number;
};

/**
 * Pure scan — returns reap candidates. No side effects.
 *
 * Candidate criteria (ALL must hold):
 *   1. `name` matches `isSubagentThreadName`
 *   2. `status === "running"`
 *   3. `startedAt` set AND `(now - startedAt) / 1000 >= minAgeSeconds`
 *   4. Either:
 *      a. binding for this `sessionName` is missing → orphan (always prune
 *         once age guard passes), OR
 *      b. binding present AND `(now - binding.lastActivity) / 1000 >=
 *         idleTimeoutMinutes * 60`
 */
export function scanForSubagentSessions(
  args: ScanArgs,
): readonly SubagentReaperCandidate[] {
  const now = args.now ?? Date.now();
  const idleMs = args.idleTimeoutMinutes * 60 * 1000;
  const minAgeMs = args.minAgeSeconds * 1000;

  // Index bindings by sessionName for O(1) lookup.
  const bindingBySessionName = new Map<string, ThreadBinding>();
  for (const b of args.bindings) {
    bindingBySessionName.set(b.sessionName, b);
  }

  const candidates: SubagentReaperCandidate[] = [];
  for (const s of args.sessions) {
    if (!isSubagentThreadName(s.name)) continue;
    if (s.status !== "running") continue;
    if (s.startedAt === null) continue;
    const ageMs = now - s.startedAt;
    if (ageMs < minAgeMs) continue;

    const binding = bindingBySessionName.get(s.name);
    if (binding === undefined) {
      // Orphan: binding gone but session still running.
      candidates.push({
        name: s.name,
        threadId: null,
        ageSec: Math.round(ageMs / 1000),
        lastActivityAgeSec: null,
      });
      continue;
    }

    const idleMsActual = now - binding.lastActivity;
    if (idleMsActual < idleMs) continue;
    candidates.push({
      name: s.name,
      threadId: binding.threadId,
      ageSec: Math.round(ageMs / 1000),
      lastActivityAgeSec: Math.round(idleMsActual / 1000),
    });
  }
  return candidates;
}

export type TickArgs = ScanArgs & {
  readonly mode: SubagentReaperMode;
  readonly log: Logger;
  /**
   * Graceful stop callback. Wraps `SessionManager.stopAgent(name)` in
   * production. Tests pass a vi.fn().
   */
  readonly stopAgent: (name: string) => Promise<void>;
};

/**
 * One tick of the subagent-session reaper.
 *
 * In "off" mode: noop (returns immediately).
 * In "alert" mode: scan + emit one pino warn per candidate. No stops.
 * In "reap" mode: scan + alert + `stopAgent(name)` per candidate.
 *
 * Errors during stop (other than "agent not running" which we tolerate
 * silently — race with another stop path) are logged but never propagate
 * — callers wire this into setInterval and a thrown error would crash
 * the tick loop (matches Phase 109-B reaper invariant).
 */
export async function tickSubagentSessionReaper(
  args: TickArgs,
): Promise<void> {
  if (args.mode === "off") return;
  if (process.env.CLAWCODE_SUBAGENT_REAPER_DISABLE === "1") return;

  const candidates = scanForSubagentSessions(args);
  if (candidates.length === 0) return;

  // Alert phase — both modes log every candidate.
  for (const c of candidates) {
    args.log.warn(
      {
        component: "subagent-session-reaper",
        action: "alert",
        agent: c.name,
        sessionName: c.name,
        threadId: c.threadId,
        ageSec: c.ageSec,
        lastActivityAgeSec: c.lastActivityAgeSec,
        mode: args.mode,
      },
      "subagent session candidate detected",
    );
  }

  if (args.mode === "alert") return;

  for (const c of candidates) {
    args.log.warn(
      {
        component: "subagent-session-reaper",
        action: "reap",
        agent: c.name,
        sessionName: c.name,
        threadId: c.threadId,
        ageSec: c.ageSec,
        lastActivityAgeSec: c.lastActivityAgeSec,
        mode: args.mode,
      },
      "reaping subagent session",
    );
    try {
      await args.stopAgent(c.name);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // "Agent X is not running" is a tolerable race with another stop
      // path (e.g. the auto-archive in subagent-thread-spawner racing
      // this tick); log at info, not error.
      if (msg.includes("not running")) {
        args.log.info(
          {
            component: "subagent-session-reaper",
            action: "reap",
            agent: c.name,
            err: msg,
          },
          "subagent session already stopped (race tolerated)",
        );
        continue;
      }
      args.log.error(
        {
          component: "subagent-session-reaper",
          action: "reap",
          agent: c.name,
          err: msg,
        },
        "subagent stopAgent failed unexpectedly",
      );
    }
  }
}
