/**
 * Memory consolidation pipeline.
 *
 * Transforms daily session logs into weekly and monthly digests,
 * storing them as both markdown files and SQLite memory entries.
 * Archives source files after successful consolidation.
 *
 * All functions are pure/functional where possible, with side effects
 * (file I/O, DB writes) isolated to write/archive functions.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, copyFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, basename } from "node:path";
import { logger } from "../shared/logger.js";
// Phase 115 sub-scope 13(b) — consolidation run-log writer.
// Cross-agent transactional integrity surface; foundation for plan 115-09.
import {
  appendConsolidationRun,
  type ConsolidationRunRow,
} from "../manager/consolidation-run-log.js";
// Phase 115 Plan 09 T02 — sub-scope 12 cross-agent consolidation
// transactionality. The coordinator wraps fleet-level multi-agent
// memory writes with `consolidation:<runId>` tagging + rollback. The
// per-agent `runConsolidation` below stays the primary surface for
// the cron handler in daemon.ts; the coordinator is the abstraction
// the daemon will compose with when a future caller needs the
// multi-agent atomic-batch semantic (e.g., a fleet-wide priority
// dream-pass per CONTEXT D-05). Re-exporting here keeps the cross-
// agent surface co-located with the per-agent surface so callers
// that want either path import from one module.
export {
  CrossAgentCoordinator,
  consolidationRunTag,
  type CrossAgentCoordinatorDeps,
} from "../manager/cross-agent-coordinator.js";
export {
  CONSOLIDATION_RUN_TAG_PREFIX,
  type CrossAgentBatch,
  type CrossAgentBatchStatus,
  type CrossAgentBatchWrite,
} from "../manager/cross-agent-coordinator.types.js";
import {
  getISOWeek,
  getISOWeekYear,
  startOfISOWeek,
  endOfISOWeek,
  parseISO,
  format,
  getMonth,
  getYear,
} from "date-fns";
import type { MemoryStore } from "./store.js";
import type { EmbeddingService } from "./embedder.js";
import type { ConsolidationConfig } from "./schema.js";
import type {
  WeeklyDigest,
  MonthlyDigest,
  ConsolidationResult,
} from "./consolidation.types.js";
import { isErrorSummary } from "./error-guard.js";

/**
 * 2026-08-28 (Phase 999.113 WS-5) — render an unusable summarize() result for
 * the run-log. The old message interpolated `llmContent.slice(0, 200)`, which
 * for the most common failure (an empty string from a failed bridge call) read
 * `... error response — ` and told the operator nothing.
 */
function describeUnusableSummary(text: string): string {
  if (typeof text !== "string" || text.length === 0) return "(empty — summarizer returned nothing)";
  if (text.trim().length === 0) return "(blank — whitespace only)";
  return text.slice(0, 200);
}

/** Maximum combined character length before truncation of daily logs. */
const MAX_PROMPT_CHARS = 30000;

/** A group of daily log files belonging to the same ISO week. */
export type WeekGroup = {
  readonly year: number;
  readonly week: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly files: readonly string[];
};

/** A group of weekly digest files belonging to the same month. */
export type MonthGroup = {
  readonly year: number;
  readonly month: number;
  readonly digestFiles: readonly string[];
};

/** Dependencies injected into consolidation functions for testability. */
export type ConsolidationDeps = {
  readonly memoryDir: string;
  readonly memoryStore: MemoryStore;
  readonly embedder: EmbeddingService;
  readonly summarize: (prompt: string) => Promise<string>;
  /**
   * Phase 115 sub-scope 13(b) — optional agent label threaded into the
   * consolidation run-log JSONL row's `target_agents` field. The daemon
   * passes `agentConfig.name`; tests may omit it (the runner emits an
   * empty `target_agents: []` array in that case so log readers can
   * still distinguish "ran for unknown agent" from "ran for X" via the
   * presence/contents of the array).
   */
  readonly runLabel?: string;
  /**
   * Phase 115 sub-scope 13(b) — optional override for the consolidation
   * run-log directory. Tests can redirect away from `~/.clawcode/manager/`.
   */
  readonly runLogDirOverride?: string;
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Scan memoryDir for daily log files matching YYYY-MM-DD.md, group by
 * ISO week, and return groups with >= threshold files that have no
 * existing weekly digest.
 *
 * CRITICAL: Uses getISOWeekYear() (not getFullYear()) so that dates like
 * Dec 29-31 are correctly attributed to the next year's week 1.
 */
export function detectUnconsolidatedWeeks(
  memoryDir: string,
  threshold: number,
  now: Date = new Date(),
): readonly WeekGroup[] {
  // Current (in-progress) ISO week — NEVER consolidate it: writing a digest
  // archives (moves) that week's daily logs, which would relocate the agent's
  // ACTIVE memory mid-week. Only completed past weeks are eligible. `now` is
  // injectable for tests.
  const currentWeekKey = `${getISOWeekYear(now)}-W${String(getISOWeek(now)).padStart(2, "0")}`;
  const datePattern = /^\d{4}-\d{2}-\d{2}\.md$/;
  const entries = existsSync(memoryDir) ? readdirSync(memoryDir) : [];
  const dailyFiles = entries.filter((f) => datePattern.test(f));

  // Group by ISO week year + week number
  const groups = new Map<string, { year: number; week: number; files: string[] }>();

  for (const file of dailyFiles) {
    const dateStr = file.replace(".md", "");
    const date = parseISO(dateStr);
    const isoYear = getISOWeekYear(date);
    const isoWeek = getISOWeek(date);
    const key = `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;

    const existing = groups.get(key);
    if (existing) {
      existing.files.push(file);
    } else {
      groups.set(key, { year: isoYear, week: isoWeek, files: [file] });
    }
  }

  // Filter by threshold and existing digest
  const digestDir = join(memoryDir, "digests");
  const result: WeekGroup[] = [];

  for (const [key, group] of groups) {
    // Skip the in-progress week (guard above) — its logs are still being written.
    if (key === currentWeekKey) continue;
    if (group.files.length < threshold) continue;

    const digestFile = join(digestDir, `weekly-${key}.md`);
    if (existsSync(digestFile)) continue;

    // Compute start/end dates from the ISO week
    const sampleDate = parseISO(group.files[0].replace(".md", ""));
    const weekStart = startOfISOWeek(sampleDate);
    const weekEnd = endOfISOWeek(sampleDate);

    result.push(Object.freeze({
      year: group.year,
      week: group.week,
      startDate: format(weekStart, "yyyy-MM-dd"),
      endDate: format(weekEnd, "yyyy-MM-dd"),
      files: Object.freeze([...group.files].sort()),
    }));
  }

  return Object.freeze(result);
}

/**
 * Scan memoryDir/digests/ for weekly digest files, group by the month
 * that each ISO week's start date falls in, and return months with
 * >= threshold digests that have no existing monthly digest.
 */
export function detectUnconsolidatedMonths(
  memoryDir: string,
  threshold: number,
): readonly MonthGroup[] {
  const digestDir = join(memoryDir, "digests");
  if (!existsSync(digestDir)) return Object.freeze([]);

  const weeklyPattern = /^weekly-(\d{4})-W(\d{2})\.md$/;
  const entries = readdirSync(digestDir);
  const weeklyFiles = entries.filter((f) => weeklyPattern.test(f));

  // Group by month of the week's start date
  const groups = new Map<string, { year: number; month: number; digestFiles: string[] }>();

  for (const file of weeklyFiles) {
    const match = file.match(weeklyPattern);
    if (!match) continue;

    const isoYear = parseInt(match[1], 10);
    const isoWeek = parseInt(match[2], 10);

    // Reconstruct the start date of this ISO week to determine its month
    // Use Jan 4 of the ISO year as a reference (always in week 1)
    const jan4 = new Date(isoYear, 0, 4);
    const jan4ISOWeekStart = startOfISOWeek(jan4);
    // Offset to the target week
    const weekStartDate = new Date(jan4ISOWeekStart.getTime() + (isoWeek - 1) * 7 * 24 * 60 * 60 * 1000);

    const monthNum = getMonth(weekStartDate) + 1; // 1-based
    const yearNum = getYear(weekStartDate);
    const key = `${yearNum}-${String(monthNum).padStart(2, "0")}`;

    const existing = groups.get(key);
    if (existing) {
      existing.digestFiles.push(file);
    } else {
      groups.set(key, { year: yearNum, month: monthNum, digestFiles: [file] });
    }
  }

  // Filter by threshold and existing monthly digest
  const result: MonthGroup[] = [];

  for (const [key, group] of groups) {
    if (group.digestFiles.length < threshold) continue;

    const monthlyFile = join(digestDir, `monthly-${key}.md`);
    if (existsSync(monthlyFile)) continue;

    result.push(Object.freeze({
      year: group.year,
      month: group.month,
      digestFiles: Object.freeze([...group.digestFiles].sort()),
    }));
  }

  return Object.freeze(result);
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/**
 * Build a summarization prompt from daily log content.
 * Concatenates logs with date headers and requests structured extraction.
 * Truncates proportionally if total content exceeds MAX_PROMPT_CHARS.
 */
export function buildWeeklySummarizationPrompt(
  dailyLogs: ReadonlyArray<{ readonly date: string; readonly content: string }>,
): string {
  const totalChars = dailyLogs.reduce((sum, log) => sum + log.content.length, 0);
  const needsTruncation = totalChars > MAX_PROMPT_CHARS;

  const sections: string[] = [];

  for (const log of dailyLogs) {
    let content = log.content;
    if (needsTruncation) {
      const maxPerDay = Math.floor(MAX_PROMPT_CHARS / dailyLogs.length);
      if (content.length > maxPerDay) {
        content = content.slice(0, maxPerDay) + "\n\n[...truncated due to length]";
      }
    }
    sections.push(`### ${log.date}\n\n${content}`);
  }

  const instructions = `You are summarizing a week of session logs into a structured weekly digest.
Extract and organize the following from the daily logs below:

## Key Facts
List the most important factual information learned or established.

## Decisions Made
List decisions that were made, with brief rationale where available.

## Topics Discussed
List the main topics and themes covered during the week.

## Important Context
List context that would be valuable for future conversations.

Format your response as clean markdown with the exact section headers above.
Be concise but comprehensive. Preserve specific names, values, and technical details.
${needsTruncation ? "\nNote: Some daily logs were truncated due to length. Summarize what is available." : ""}

---

# Daily Logs

`;

  return instructions + sections.join("\n\n");
}

/**
 * Build a monthly summarization prompt from weekly digest content.
 * Synthesizes weekly digests into monthly themes.
 */
export function buildMonthlySummarizationPrompt(
  weeklyDigests: ReadonlyArray<{ readonly week: string; readonly content: string }>,
): string {
  const sections = weeklyDigests.map(
    (d) => `### Week ${d.week}\n\n${d.content}`,
  );

  const instructions = `You are synthesizing weekly digests into a monthly summary.
Identify recurring themes, track progress on ongoing topics, and highlight the most significant developments.

## Monthly Themes
Identify the dominant themes and ongoing threads.

## Key Developments
List the most significant events, decisions, or progress made.

## Recurring Topics
Topics that appeared across multiple weeks.

## Summary
A brief narrative summary of the month.

Format your response as clean markdown with the exact section headers above.

---

# Weekly Digests

`;

  return instructions + sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Write digests
// ---------------------------------------------------------------------------

/**
 * Write a weekly digest markdown file and insert a corresponding
 * SQLite memory entry with source="consolidation" and importance=0.7.
 */
export async function writeWeeklyDigest(
  deps: ConsolidationDeps,
  weekGroup: WeekGroup,
  llmContent: string,
): Promise<WeeklyDigest> {
  const digestDir = join(deps.memoryDir, "digests");
  mkdirSync(digestDir, { recursive: true });

  const weekStr = `${weekGroup.year}-W${String(weekGroup.week).padStart(2, "0")}`;
  const filePath = join(digestDir, `weekly-${weekStr}.md`);

  // Build markdown with metadata header
  const markdown = `---
type: weekly-digest
year: ${weekGroup.year}
week: ${weekGroup.week}
period: ${weekGroup.startDate} to ${weekGroup.endDate}
sources: ${weekGroup.files.join(", ")}
created: ${new Date().toISOString()}
---

# Weekly Digest: ${weekStr}

${llmContent}
`;

  writeFileSync(filePath, markdown, "utf-8");

  // Create embedding and store in SQLite
  const embedding = await deps.embedder.embed(llmContent);
  deps.memoryStore.insert(
    {
      content: llmContent,
      source: "consolidation",
      importance: 0.7,
      tags: ["weekly-digest", weekStr],
    },
    embedding,
  );

  const now = new Date().toISOString();
  return Object.freeze({
    year: weekGroup.year,
    week: weekGroup.week,
    period: "weekly" as const,
    startDate: weekGroup.startDate,
    endDate: weekGroup.endDate,
    sourceFiles: weekGroup.files,
    content: llmContent,
    createdAt: now,
  });
}

/**
 * Write a monthly digest markdown file and insert a corresponding
 * SQLite memory entry with source="consolidation" and importance=0.8.
 */
export async function writeMonthlyDigest(
  deps: ConsolidationDeps,
  monthGroup: MonthGroup,
  llmContent: string,
): Promise<MonthlyDigest> {
  const digestDir = join(deps.memoryDir, "digests");
  mkdirSync(digestDir, { recursive: true });

  const monthStr = `${monthGroup.year}-${String(monthGroup.month).padStart(2, "0")}`;
  const filePath = join(digestDir, `monthly-${monthStr}.md`);

  const markdown = `---
type: monthly-digest
year: ${monthGroup.year}
month: ${monthGroup.month}
sources: ${monthGroup.digestFiles.join(", ")}
created: ${new Date().toISOString()}
---

# Monthly Digest: ${monthStr}

${llmContent}
`;

  writeFileSync(filePath, markdown, "utf-8");

  // Create embedding and store in SQLite
  const embedding = await deps.embedder.embed(llmContent);
  deps.memoryStore.insert(
    {
      content: llmContent,
      source: "consolidation",
      importance: 0.8,
      tags: ["monthly-digest", monthStr],
    },
    embedding,
  );

  const now = new Date().toISOString();
  return Object.freeze({
    year: monthGroup.year,
    month: monthGroup.month,
    period: "monthly" as const,
    sourceDigests: monthGroup.digestFiles,
    content: llmContent,
    createdAt: now,
  });
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

/**
 * Archive daily log files by moving them to memoryDir/archive/YYYY/
 * and removing their entries from the session_logs table.
 *
 * Uses rename() for same-filesystem atomic move, falls back to
 * copy + unlink if rename fails (cross-filesystem).
 */
export async function archiveDailyLogs(
  memoryDir: string,
  memoryStore: MemoryStore,
  files: readonly string[],
): Promise<number> {
  let archived = 0;

  for (const filePath of files) {
    const fileName = basename(filePath);
    const dateStr = fileName.replace(".md", "");
    const year = dateStr.slice(0, 4);

    const archiveDir = join(memoryDir, "archive", year);
    mkdirSync(archiveDir, { recursive: true });

    const destPath = join(archiveDir, fileName);

    try {
      // Try atomic rename first
      try {
        renameSync(filePath, destPath);
      } catch {
        // Fall back to copy + unlink for cross-filesystem moves
        copyFileSync(filePath, destPath);
        unlinkSync(filePath);
      }

      // Remove from session_logs table
      memoryStore.deleteSessionLog(dateStr);
      archived += 1;
    } catch (error) {
      // Log but don't throw -- partial archive is acceptable
      const msg = error instanceof Error ? error.message : "Unknown error";
      logger.error({ fileName, error: msg }, "failed to archive daily log");
    }
  }

  return archived;
}

/**
 * Archive weekly digest files by moving them to memoryDir/archive/digests/.
 * Called after monthly consolidation to clean up source digests.
 */
export async function archiveWeeklyDigests(
  memoryDir: string,
  files: readonly string[],
): Promise<number> {
  let archived = 0;
  const archiveDir = join(memoryDir, "archive", "digests");
  mkdirSync(archiveDir, { recursive: true });

  for (const filePath of files) {
    const fileName = basename(filePath);
    const destPath = join(archiveDir, fileName);

    try {
      try {
        renameSync(filePath, destPath);
      } catch {
        copyFileSync(filePath, destPath);
        unlinkSync(filePath);
      }
      archived += 1;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      logger.error({ fileName, error: msg }, "failed to archive weekly digest");
    }
  }

  return archived;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the full consolidation pipeline (PER-AGENT — single-agent surface):
 * 1. Detect unconsolidated weeks -> summarize -> write weekly digests -> archive dailies
 * 2. Detect unconsolidated months -> summarize -> write monthly digests -> archive weeklies
 *
 * Order matters: weekly BEFORE monthly (weekly digests are input to monthly).
 * Archive LAST after confirming digest write + SQLite insert succeeded.
 * Collects errors without stopping -- partial consolidation is better than none.
 *
 * Cross-agent fleet-level invocation (Phase 115 Plan 09 T02 / sub-scope 12):
 * the daemon's cron handler (src/manager/daemon.ts) calls this function
 * once PER agent — there is no fleet-level loop here. For multi-agent
 * atomic-batch semantics (e.g., a future fleet-wide priority dream-pass
 * per CONTEXT D-05), wrap with `CrossAgentCoordinator` exported above —
 * the coordinator's `coordinator.runBatch(batch)` provides
 * `consolidation:<runId>` tagging + rollback semantics across multiple
 * per-agent stores. See src/manager/cross-agent-coordinator.ts.
 */
export async function runConsolidation(
  deps: ConsolidationDeps,
  config: ConsolidationConfig,
): Promise<ConsolidationResult> {
  const errors: string[] = [];
  let weeklyDigestsCreated = 0;
  let monthlyDigestsCreated = 0;
  let filesArchived = 0;

  if (!config.enabled) {
    return Object.freeze({
      weeklyDigestsCreated: 0,
      monthlyDigestsCreated: 0,
      filesArchived: 0,
      errors: Object.freeze([]),
    });
  }

  // Skip if a concurrent agent stop/restart closed the store. Consolidation is
  // cron-driven, independent of the lifecycle lock, so it can race
  // cleanupMemory's store.close() — avoid "db not open" on the digest reads/
  // writes below; the next scheduled run picks it up.
  if (!deps.memoryStore.isOpen()) {
    return Object.freeze({
      weeklyDigestsCreated: 0,
      monthlyDigestsCreated: 0,
      filesArchived: 0,
      errors: Object.freeze([]),
    });
  }

  // Phase 115 sub-scope 13(b) — consolidation run-log started row.
  // run_id is stable across the started → completed/failed transitions so
  // reducers can compute the latest state per run. Wrapped in try/catch so
  // a log-write failure NEVER aborts the consolidation runner.
  const runId = randomBytes(8).toString("hex"); // 16-char URL-safe-ish id
  const startedAt = new Date().toISOString();
  const targetAgents: readonly string[] = deps.runLabel ? [deps.runLabel] : [];
  try {
    await appendConsolidationRun(
      {
        run_id: runId,
        target_agents: targetAgents,
        memories_added: 0,
        status: "started",
        errors: [],
        started_at: startedAt,
      },
      deps.runLogDirOverride,
    );
  } catch (err) {
    // Log write failure must NEVER break consolidation. The daemon log
    // surfaces the issue; the runner still proceeds.
    logger.warn(
      {
        action: "consolidation-run-log-append-failed",
        runId,
        error: err instanceof Error ? err.message : String(err),
      },
      "[diag] consolidation-run-log unwriteable (non-fatal)",
    );
  }

  // --- Phase 1: Weekly consolidation ---
  const weekGroups = detectUnconsolidatedWeeks(
    deps.memoryDir,
    config.weeklyThreshold,
  );

  for (const weekGroup of weekGroups) {
    try {
      // Read daily log content
      const dailyLogs = weekGroup.files.map((file) => {
        const filePath = join(deps.memoryDir, file);
        const content = readFileSync(filePath, "utf-8");
        return { date: file.replace(".md", ""), content };
      });

      // Build prompt and summarize
      const prompt = buildWeeklySummarizationPrompt(dailyLogs);
      const llmContent = await deps.summarize(prompt);

      if (isErrorSummary(llmContent)) {
        errors.push(
          `Weekly consolidation skipped for ${weekGroup.year}-W${weekGroup.week}: summarize returned no usable content — ${describeUnusableSummary(llmContent)}`,
        );
        continue;
      }

      // Write digest (markdown + SQLite)
      await writeWeeklyDigest(deps, weekGroup, llmContent);
      weeklyDigestsCreated += 1;

      // Archive daily logs AFTER successful digest write
      const fullPaths = weekGroup.files.map((f) => join(deps.memoryDir, f));
      const count = await archiveDailyLogs(deps.memoryDir, deps.memoryStore, fullPaths);
      filesArchived += count;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      errors.push(`Weekly consolidation failed for ${weekGroup.year}-W${weekGroup.week}: ${msg}`);
    }
  }

  // --- Phase 2: Monthly consolidation ---
  const monthGroups = detectUnconsolidatedMonths(
    deps.memoryDir,
    config.monthlyThreshold,
  );

  for (const monthGroup of monthGroups) {
    try {
      // Read weekly digest content
      const digestDir = join(deps.memoryDir, "digests");
      const weeklyDigests = monthGroup.digestFiles.map((file) => {
        const filePath = join(digestDir, file);
        const content = readFileSync(filePath, "utf-8");
        const weekMatch = file.match(/W(\d{2})/);
        return { week: weekMatch ? `W${weekMatch[1]}` : file, content };
      });

      // Build prompt and summarize
      const prompt = buildMonthlySummarizationPrompt(weeklyDigests);
      const llmContent = await deps.summarize(prompt);

      if (isErrorSummary(llmContent)) {
        errors.push(
          `Monthly consolidation skipped for ${monthGroup.year}-${String(monthGroup.month).padStart(2, "0")}: summarize returned no usable content — ${describeUnusableSummary(llmContent)}`,
        );
        continue;
      }

      // Write digest (markdown + SQLite)
      await writeMonthlyDigest(deps, monthGroup, llmContent);
      monthlyDigestsCreated += 1;

      // Archive weekly digests AFTER successful monthly digest write
      const fullPaths = monthGroup.digestFiles.map((f) => join(digestDir, f));
      const count = await archiveWeeklyDigests(deps.memoryDir, fullPaths);
      filesArchived += count;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      errors.push(`Monthly consolidation failed for ${monthGroup.year}-${monthGroup.month}: ${msg}`);
    }
  }

  // Phase 115 sub-scope 13(b) — consolidation run-log terminal row.
  // Status: `completed` when the runner reached this point with no
  // collected errors; `failed` when at least one weekly/monthly cycle
  // accumulated an error in the `errors[]` array. Wrapped in its own
  // try/catch so log failure NEVER mutates the returned ConsolidationResult.
  const memoriesAdded = weeklyDigestsCreated + monthlyDigestsCreated;
  const terminalStatus: ConsolidationRunRow["status"] =
    errors.length > 0 ? "failed" : "completed";
  try {
    await appendConsolidationRun(
      {
        run_id: runId,
        target_agents: targetAgents,
        memories_added: memoriesAdded,
        status: terminalStatus,
        errors: errors.map((e) => (e.length > 200 ? e.slice(0, 200) : e)),
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      },
      deps.runLogDirOverride,
    );
  } catch (err) {
    logger.warn(
      {
        action: "consolidation-run-log-append-failed",
        runId,
        error: err instanceof Error ? err.message : String(err),
      },
      "[diag] consolidation-run-log unwriteable on terminal (non-fatal)",
    );
  }

  return Object.freeze({
    weeklyDigestsCreated,
    monthlyDigestsCreated,
    filesArchived,
    errors: Object.freeze([...errors]),
  });
}
