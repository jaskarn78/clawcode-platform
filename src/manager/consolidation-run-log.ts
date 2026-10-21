/**
 * Phase 115 sub-scope 13(b) — consolidation run-log writer.
 *
 * Appends a JSONL row to ~/.clawcode/manager/consolidation-runs.jsonl on
 * every weekly/monthly consolidation cycle. Operator-readable surface for
 * cross-agent transactionality (foundation for plan 115-09).
 *
 * Failure semantics: log writes MUST NEVER break the consolidation runner
 * — every callsite wraps the append in its own try/catch. Reads tolerate
 * a missing file (ENOENT → empty list).
 *
 * The 999.41 carve-out (rolling-summary fail-loud guard for
 * `summarize-with-haiku.ts`) reuses this same surface: when the Haiku call
 * fails, the runner appends a `failed` row here so the operator sees BOTH
 * the daemon log line AND the persistent run-log entry.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One row of the consolidation run-log.
 *
 * `started_at` is set when the runner enters the work; `completed_at` is
 * set on terminal status (`completed` | `failed` | `rolled-back`). The
 * runner appends ONE row per status transition — readers should reduce by
 * `run_id` to compute the latest state per run.
 */
export interface ConsolidationRunRow {
  /** nanoid (URL-safe) — stable across status transitions for the same run. */
  readonly run_id: string;
  /** Agent names targeted by this consolidation cycle. */
  readonly target_agents: readonly string[];
  /** Total memories added across all agents in this run. */
  readonly memories_added: number;
  /** Terminal or in-flight status. */
  readonly status: "started" | "completed" | "failed" | "rolled-back";
  /** Human-readable error strings. Truncated to 200 chars at the writer. */
  readonly errors: readonly string[];
  /** ISO 8601 — set when the runner enters the work. */
  readonly started_at: string;
  /** ISO 8601 — set on terminal status; undefined while `started`. */
  readonly completed_at?: string;
}

/**
 * Default log location: ~/.clawcode/manager/consolidation-runs.jsonl.
 * Tests may override via `dirOverride` (an absolute path that REPLACES
 * the homedir-derived parent — e.g. a tmpdir).
 */
function resolveLogPath(dirOverride?: string): { dir: string; file: string } {
  const dir = dirOverride ?? join(homedir(), ".clawcode", "manager");
  return { dir, file: join(dir, "consolidation-runs.jsonl") };
}

/**
 * Append one row to the consolidation run-log. Creates the directory tree
 * if missing. Errors are propagated — the caller is responsible for the
 * try/catch that prevents log failure from breaking consolidation.
 *
 * @param row Row to append. `errors` strings are truncated to 200 chars
 *   each (defense against accidental DB-row dumps that could leak secrets
 *   per the 115-02 threat model).
 * @param dirOverride Optional absolute dir override (test sandbox).
 */
export async function appendConsolidationRun(
  row: ConsolidationRunRow,
  dirOverride?: string,
): Promise<void> {
  const { dir, file } = resolveLogPath(dirOverride);
  await fs.mkdir(dir, { recursive: true });

  // Truncate error strings defensively — the 115-02 threat model rates
  // unbounded error strings as MEDIUM risk (could contain DB row content).
  const trimmedRow: ConsolidationRunRow = {
    ...row,
    errors: row.errors.map((e) =>
      typeof e === "string" && e.length > 200 ? e.slice(0, 200) : e,
    ),
  };
  const line = JSON.stringify(trimmedRow) + "\n";
  await fs.appendFile(file, line, { encoding: "utf8" });
}

/**
 * Read the most-recent N rows from the consolidation run-log. ENOENT
 * returns an empty array (file may not yet exist on a freshly-installed
 * daemon). Lines that fail to parse are skipped — defensive against
 * partial writes during a crash.
 *
 * @param limit Maximum rows to return. Defaults to 50 — operator-readable.
 * @param dirOverride Optional absolute dir override (test sandbox).
 */
export async function listRecentConsolidationRuns(
  limit = 50,
  dirOverride?: string,
): Promise<readonly ConsolidationRunRow[]> {
  const { file } = resolveLogPath(dirOverride);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "ENOENT") return [];
    throw err;
  }

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const out: ConsolidationRunRow[] = [];
  for (const l of lines) {
    try {
      const row = JSON.parse(l) as ConsolidationRunRow;
      out.push(row);
    } catch {
      /*
       * Skip malformed lines — could be a partial write from a crashed
       * daemon. Operator can still read every well-formed row before AND
       * after the broken line, which is the contract operators need.
       */
    }
  }

  // Most-recent N — slice from the end.
  return out.length <= limit ? out : out.slice(out.length - limit);
}
