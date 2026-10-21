/**
 * Phase 53 Plan 01 — context-audit aggregator.
 *
 * Reads per-turn `section_tokens` from `traces.db` `metadata_json` on the
 * `context_assemble` span. Filesystem-direct (readonly SQLite handle) —
 * no IPC, no daemon dependency. Pure function modulo SQLite reads + git.
 *
 * metadata_json shape (emitted by context-assembler in Wave 2):
 *   { section_tokens: { identity, soul, skills_header, hot_tier,
 *                       recent_history, per_turn_summary, resume_summary,
 *                       conversation_context } }  // Phase 67 added last
 *
 * Percentile math uses in-JS nearest-rank, matching the pattern established
 * by `TraceStore.getCacheTelemetry` (Phase 52 Plan 01) — N-small at agent
 * scale makes a single JS sort cheaper than a ROW_NUMBER window expression
 * and avoids SQLite expression-ordering quirks on the aggregated floats.
 */

import Database from "better-sqlite3";
import { execSync } from "node:child_process";
import { sinceToIso } from "./percentiles.js";

/**
 * Canonical per-section names. VERBATIM from CONTEXT D-01 — do NOT invent
 * or rename. Consumed by the config schema (`memoryAssemblyBudgetsSchema`),
 * the assembler (Wave 2), and the CLI formatter.
 */
export const SECTION_NAMES = Object.freeze([
  "identity",
  "soul",
  "skills_header",
  "hot_tier",
  "recent_history",
  "per_turn_summary",
  "resume_summary",
  "conversation_context", // Phase 67 — SESS-02 dedicated brief budget
  // Context-bloat fix #2 measurement — the per-turn <memory-context>
  // retrieval block. Emitted by the turn dispatcher onto the
  // `context_assemble` span's `section_tokens` so `clawcode context-audit`
  // can measure the cadence-gated retrieval. Rows from before this section
  // existed simply have no `memory_context` key and are skipped per-section.
  "memory_context",
] as const);

/** Individual section name (inferred from SECTION_NAMES). */
export type SectionName = (typeof SECTION_NAMES)[number];

/** Per-section aggregate row in the audit report. */
export type SectionRow = {
  readonly sectionName: SectionName;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly count: number;
};

/**
 * Frozen report shape returned by `buildContextAuditReport`. Symmetric
 * with `CacheTelemetryReport` / `LatencyReport` in the sense that the
 * CLI/dashboard consume it verbatim. `sampledTurns` counts only rows that
 * carried a valid `section_tokens` object; malformed or legacy rows are
 * skipped silently.
 */
export type ContextAuditReport = {
  readonly agent: string;
  readonly since: string; // input duration string, e.g. "24h"
  readonly sinceIso: string; // resolved ISO cutoff
  readonly sampledTurns: number;
  readonly sections: readonly SectionRow[];
  readonly recommendations: {
    readonly new_defaults: Readonly<Partial<Record<SectionName, number>>>;
  };
  readonly resume_summary_over_budget_count: number;
  readonly git_sha: string;
  readonly generated_at: string;
  readonly warnings: readonly string[];
};

/** Options for `buildContextAuditReport`. */
export type BuildContextAuditReportOpts = {
  readonly traceStorePath: string;
  readonly agent: string;
  /** Time window as a duration string (e.g. "24h", "7d"). Default "24h". */
  readonly since?: string;
  /**
   * Sample the most recent N turns. When set, overrides `since` for row
   * count purposes (applies a SQL LIMIT on top of the since filter).
   */
  readonly turns?: number;
  /** Warn (do not fail) when sampled turns < this count. Default 20. */
  readonly minTurns?: number;
  /**
   * Budget against which `resume_summary_over_budget_count` is computed.
   * Default 1500 tokens (CONTEXT D-04).
   */
  readonly resumeSummaryBudget?: number;
};

const DEFAULT_SINCE = "24h";
const DEFAULT_MIN_TURNS = 20;
const DEFAULT_RESUME_BUDGET = 1500;

function getGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Nearest-rank percentile over a pre-sorted (ascending) array of finite
 * numbers. Mirrors the convention used by TraceStore.getCacheTelemetry.
 */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx] ?? null;
}

/** Row shape returned by the per-turn metadata_json query. */
type MetadataRow = { readonly metadata_json: string | null };

/**
 * Build a frozen ContextAuditReport by reading `trace_spans.metadata_json`
 * for `name = 'context_assemble'` on the target agent within the `since`
 * window (or most recent `turns` rows if set). Filesystem-direct.
 */
export function buildContextAuditReport(
  opts: BuildContextAuditReportOpts,
): ContextAuditReport {
  const since = opts.since ?? DEFAULT_SINCE;
  const minTurns = opts.minTurns ?? DEFAULT_MIN_TURNS;
  const resumeBudget = opts.resumeSummaryBudget ?? DEFAULT_RESUME_BUDGET;
  const sinceIso = sinceToIso(since);

  const db = new Database(opts.traceStorePath, { readonly: true });
  try {
    let query = `
      SELECT s.metadata_json
      FROM trace_spans s
      JOIN traces t ON t.id = s.turn_id
      WHERE t.agent = @agent
        AND s.name = 'context_assemble'
        AND t.started_at >= @since
      ORDER BY t.started_at DESC
    `;
    const hasTurns = typeof opts.turns === "number" && opts.turns > 0;
    if (hasTurns) query += ` LIMIT @turns`;
    const stmt = db.prepare(query);
    const rawRows = (
      hasTurns
        ? stmt.all({ agent: opts.agent, since: sinceIso, turns: opts.turns })
        : stmt.all({ agent: opts.agent, since: sinceIso })
    ) as ReadonlyArray<MetadataRow>;

    const buckets: Record<SectionName, number[]> = {
      identity: [],
      soul: [],
      skills_header: [],
      hot_tier: [],
      recent_history: [],
      per_turn_summary: [],
      resume_summary: [],
      conversation_context: [], // Phase 67 — SESS-02 dedicated brief budget
      memory_context: [], // Context-bloat fix #2 — per-turn retrieval block
    };
    let sampled = 0;
    let overBudget = 0;

    for (const r of rawRows) {
      if (!r.metadata_json) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.metadata_json);
      } catch {
        continue; // malformed — skip silently (observational invariant)
      }
      const st = (parsed as { readonly section_tokens?: unknown } | null)
        ?.section_tokens;
      if (!st || typeof st !== "object") continue;
      const stObj = st as Record<string, unknown>;
      let counted = false;
      for (const section of SECTION_NAMES) {
        const v = stObj[section];
        if (typeof v === "number" && Number.isFinite(v)) {
          buckets[section].push(v);
          counted = true;
        }
      }
      if (counted) {
        sampled++;
        const rs = stObj.resume_summary;
        if (typeof rs === "number" && rs > resumeBudget) overBudget++;
      }
    }

    const sections: readonly SectionRow[] = SECTION_NAMES.map((name) => {
      const values = [...buckets[name]].sort((a, b) => a - b);
      return Object.freeze({
        sectionName: name,
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        count: values.length,
      });
    });

    const new_defaults: Partial<Record<SectionName, number>> = {};
    for (const row of sections) {
      if (row.p95 !== null) {
        new_defaults[row.sectionName] = Math.ceil(row.p95 * 1.2);
      }
    }

    const warnings: string[] = [];
    if (sampled > 0 && sampled < minTurns) {
      warnings.push(
        `minimum sampled turns not met (sampled=${sampled}, required>=${minTurns})`,
      );
    }

    return Object.freeze<ContextAuditReport>({
      agent: opts.agent,
      since,
      sinceIso,
      sampledTurns: sampled,
      sections: Object.freeze(sections),
      recommendations: Object.freeze({
        new_defaults: Object.freeze(new_defaults),
      }),
      resume_summary_over_budget_count: overBudget,
      git_sha: getGitSha(),
      generated_at: new Date().toISOString(),
      warnings: Object.freeze(warnings),
    });
  } finally {
    db.close();
  }
}
