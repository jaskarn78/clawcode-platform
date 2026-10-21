/**
 * Phase 140 Plan 07 — v3 resume-session-id tracker (closes 140-04 Deferred #2).
 *
 * `PtySupervisor.buildRestartArgv()` appends `--resume <id>` when its injected
 * `getResumeSessionId()` returns a session id — but that getter is SYNCHRONOUS
 * and the only discovery API (`listSessions`, async) reads the `claude` JSONL
 * transcript store. This module bridges that: it keeps a cached "latest session
 * id for this agent's project dir", refreshed asynchronously, and exposes a
 * synchronous `get()` for the supervisor.
 *
 * **Fail-safe.** Discovery failure / empty store / a never-refreshed tracker all
 * yield `null` → the supervisor spawns FRESH (the pre-seam behavior, never a
 * crash). A stale-but-present id is also safe: `claude --resume <id>` on a
 * vanished session id falls back to a fresh session itself. So the worst case is
 * "no continuity," never "broken spawn."
 *
 * **Why latest-by-mtime.** A long-lived `claude --channels` agent has one active
 * session; `--resume` keeps the same id, so its transcript file stays the
 * most-recently-modified one in the project dir. `pickLatestSessionId` selects
 * it. (If the agent ever rotated to a new session, the newest file is still the
 * right one to resume.)
 *
 * Pure core (`pickLatestSessionId`) + a thin stateful cache (`SessionIdTracker`);
 * all I/O is the injected `listSessions`, so both are unit-testable without the
 * SDK or filesystem.
 */

/** Minimal session-metadata shape consumed here (subset of SDKSessionInfo). */
export interface SessionInfoLike {
  readonly sessionId: string;
  /** Last-modified time, ms since epoch. */
  readonly lastModified: number;
}

/** The session-listing dependency (subset of the SDK's `listSessions`). */
export type ListSessionsFn = (
  options?: { readonly dir?: string },
) => Promise<readonly SessionInfoLike[]>;

export interface SessionIdTrackerDeps {
  /** Project dir whose sessions are listed (the agent's resolved SDK cwd). */
  readonly cwd: string;
  /** Session-listing function — production wires the SDK's `listSessions`. */
  readonly listSessions: ListSessionsFn;
  /** Structured logger for the fail-open sentinel (optional). */
  readonly log?: { readonly warn: (obj: unknown, msg?: string) => void };
}

/**
 * Pick the most-recently-modified session id, or `null` for an empty list.
 * Pure — ties broken by first-seen (stable for the supervisor's purposes).
 */
export function pickLatestSessionId(
  sessions: readonly SessionInfoLike[],
): string | null {
  let best: SessionInfoLike | null = null;
  for (const s of sessions) {
    if (best === null || s.lastModified > best.lastModified) {
      best = s;
    }
  }
  return best?.sessionId ?? null;
}

/**
 * Caches the latest session id for one agent's project dir. `refresh()` updates
 * the cache from `listSessions` (errors are swallowed → last-known retained);
 * `get()` returns the cached id synchronously for `PtySupervisor`.
 */
export class SessionIdTracker {
  private current: string | null = null;

  constructor(private readonly deps: SessionIdTrackerDeps) {}

  /** Synchronous accessor wired into `PtySupervisor.getResumeSessionId`. */
  get(): string | null {
    return this.current;
  }

  /**
   * Refresh the cache from the session store. On any failure the prior value is
   * kept (fail-open) and a single warn is logged. A successful list with no
   * sessions leaves the cache unchanged (don't clobber a known id with null on
   * a transient empty read).
   */
  async refresh(): Promise<void> {
    try {
      const sessions = await this.deps.listSessions({ dir: this.deps.cwd });
      const latest = pickLatestSessionId(sessions);
      if (latest !== null) {
        this.current = latest;
      }
    } catch (err) {
      this.deps.log?.warn(
        { error: (err as Error)?.message, cwd: this.deps.cwd },
        "resume session-id refresh failed (resume stays last-known / fresh)",
      );
    }
  }
}
