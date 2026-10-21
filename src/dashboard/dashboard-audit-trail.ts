/**
 * Phase 116-06 T04 — Dashboard action audit trail.
 *
 * Append-only JSONL writer for every operator-initiated mutation that
 * flows through the dashboard server (HTTP layer), plus the SPA-emitted
 * telemetry events (T07 — `dashboard_v2_page_view` + `dashboard_v2_error`).
 *
 * Why a SEPARATE class from src/config/audit-trail.ts?
 *
 *   - That class records `{timestamp, fieldPath, oldValue, newValue}` for
 *     ConfigWatcher-detected diffs. Dashboard actions are richer:
 *     `{timestamp, action, target?, metadata?}` — the action discriminator
 *     covers config edits, migration pauses, MCP reconnects, task
 *     transitions, dream vetoes, AND SPA telemetry events. Shoehorning
 *     into the config schema would force every dashboard action to fake
 *     a `fieldPath`.
 *   - Distinct file path (`dashboard-audit.jsonl` vs. `config-audit.jsonl`)
 *     so the F23 viewer reads ONE file without filter logic to skip
 *     unrelated config-change rows.
 *
 * The dashboard `GET /api/audit` route reads from this file (via the
 * `list-dashboard-audit` IPC handler) and the F23 viewer renders the
 * tail. The T07 telemetry POST appends through the same writer so the
 * summary badge counts both events from a single file scan.
 *
 * File location: `MANAGER_DIR/dashboard-audit.jsonl`. Same persistence
 * dir as the daemon's other state (socket, pid, config-audit). Path is
 * injected at construct time so tests can use a temp file without
 * monkey-patching MANAGER_DIR.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type pino from "pino";

/**
 * One line in dashboard-audit.jsonl. Every field except `timestamp` and
 * `action` is optional so the same writer covers config edits (carry a
 * `target` + before/after `metadata`) AND SPA telemetry events (carry
 * only `metadata: {path, message?, stack?}`).
 */
export type DashboardAuditEntry = {
  /** ISO 8601 UTC. */
  readonly timestamp: string;
  /**
   * Discriminator. Conventions:
   *   - `update-agent-config` — F26 config editor PUT
   *   - `migration-pause` / `migration-resume` / `migration-rollback`
   *   - `mcp-reconnect`
   *   - `create-task` / `transition-task` — F28 Kanban
   *   - `veto-dream-run` — F15 drawer veto
   *   - `agent-start` / `agent-stop` / `agent-restart` — POST /api/agents/:n/:action
   *   - `dashboard_v2_page_view` / `dashboard_v2_error` — T07 telemetry
   *
   * Free-form string at the schema level; callers MUST pick values from
   * the conventions above (or document new ones in this docstring).
   */
  readonly action: string;
  /** Subject of the action (agent name, task id, etc.) — `null` when none. */
  readonly target: string | null;
  /** Optional structured context (request body, before/after diff, etc.). */
  readonly metadata?: Record<string, unknown>;
};

export type DashboardAuditTrailOptions = {
  readonly filePath: string;
  readonly log: pino.Logger;
};

/**
 * Input to `recordAction` — every field optional except `action`.
 */
export type RecordActionInput = {
  readonly action: string;
  readonly target?: string | null;
  readonly metadata?: Record<string, unknown>;
};

export class DashboardAuditTrail {
  private readonly filePath: string;
  private readonly log: pino.Logger;
  private dirEnsured = false;

  constructor(opts: DashboardAuditTrailOptions) {
    this.filePath = opts.filePath;
    this.log = opts.log;
  }

  /**
   * Append one dashboard action entry as a single JSON line. NEVER throws
   * — audit-write failures must not break the user's mutation. We log
   * the error and continue. (The mutation already succeeded by the time
   * the route handler reaches `.recordAction()`; failing the response
   * because the audit write missed would be worse than the missed audit.)
   */
  async recordAction(input: RecordActionInput): Promise<void> {
    try {
      await this.ensureDirectory();
      const entry: DashboardAuditEntry = {
        timestamp: new Date().toISOString(),
        action: input.action,
        target: input.target ?? null,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      };
      await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      this.log.warn(
        { err: message, file: this.filePath, action: input.action },
        "dashboard audit append failed (mutation already succeeded; loss is observability-only)",
      );
    }
  }

  /**
   * Tail-and-filter helper for the F23 audit log viewer.
   *
   * `since` is an ISO 8601 string; entries with `timestamp >= since` pass
   * (lexicographic compare is correct for ISO 8601 UTC). `action` and
   * `target` are exact-match filters; both optional. `limit` (default
   * 500, max 5000) caps the response so a 100MB JSONL doesn't ship over
   * IPC in one read.
   *
   * Read strategy: load the whole file (it's append-only JSONL — operator-
   * facing rate, not high-frequency telemetry — so even a year of writes
   * stays well under a few MB), parse line-by-line, filter, take the LAST
   * `limit` matching entries (most recent surface first).
   *
   * Missing file → empty array. Malformed lines are skipped silently
   * with a warn log; corruption from a partial write shouldn't kill the
   * viewer.
   */
  async listActions(opts: {
    readonly since?: string;
    readonly action?: string;
    readonly target?: string;
    readonly limit?: number;
  } = {}): Promise<readonly DashboardAuditEntry[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch (err) {
      // ENOENT (no audit file yet) is the expected "fresh install" state.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const matches: DashboardAuditEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      let parsed: DashboardAuditEntry;
      try {
        parsed = JSON.parse(line) as DashboardAuditEntry;
      } catch {
        this.log.warn(
          { file: this.filePath, preview: line.slice(0, 80) },
          "dashboard audit malformed line — skipped",
        );
        continue;
      }
      if (opts.since && parsed.timestamp < opts.since) continue;
      if (opts.action && parsed.action !== opts.action) continue;
      if (opts.target && parsed.target !== opts.target) continue;
      matches.push(parsed);
    }
    // Most-recent-first; take the last `limit` matches (newest end of
    // the file), then reverse so the response is descending by timestamp.
    const tail = matches.slice(-limit);
    return tail.reverse();
  }

  /**
   * T07 — count `dashboard_v2_page_view` + `dashboard_v2_error` entries
   * in the last 24h. The small badge in the dashboard header consumes
   * this. Single pass over the file; never throws on missing file.
   */
  async telemetrySummary24h(): Promise<{
    readonly pageViews24h: number;
    readonly errors24h: number;
    readonly since: string;
  }> {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { pageViews24h: 0, errors24h: 0, since };
      }
      throw err;
    }
    let pageViews24h = 0;
    let errors24h = 0;
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      let parsed: DashboardAuditEntry;
      try {
        parsed = JSON.parse(line) as DashboardAuditEntry;
      } catch {
        continue;
      }
      if (parsed.timestamp < since) continue;
      if (parsed.action === "dashboard_v2_page_view") pageViews24h += 1;
      else if (parsed.action === "dashboard_v2_error") errors24h += 1;
    }
    return { pageViews24h, errors24h, since };
  }

  /** Test-only: file path for assertions. */
  getFilePath(): string {
    return this.filePath;
  }

  private async ensureDirectory(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    this.dirEnsured = true;
  }
}
