/**
 * Phase 999.113 WS-6 — dream-pass run-log writer.
 *
 * Mirrors src/manager/consolidation-run-log.ts: same
 * ~/.clawcode/manager location, same `dirOverride` test seam, same JSONL
 * append, same failure semantics (log writes MUST NEVER break the dream
 * machinery — every callsite wraps the append in its own try/catch; reads
 * tolerate a missing file, ENOENT → empty list).
 *
 * WHY THIS LOG EXISTS: /clawcode-status derived "Dreamt:" purely from the
 * newest mtime under {memoryPath}/dreams — an artifact that only a
 * SUCCESSFUL dream pass writes. An agent whose dream pass had failed
 * hundreds of times in a row still read "Dreamt: 14 days ago" with no hint
 * of failure. This log records every ATTEMPT + outcome so the panel can
 * report failures honestly (see status-render.ts annotation fields).
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One row of the dream run-log — exactly one row per dream pass, appended
 * on EVERY outcome (success, no-op, failure) by the shared dream machinery
 * (`buildDreamMachinery` in dream-machinery.ts — the single choke point
 * both the manual IPC trigger and the idle cron flow through).
 */
export interface DreamRunRow {
  /** nanoid (URL-safe) — unique per dream-pass attempt. */
  readonly run_id: string;
  /** Agent the pass ran for. */
  readonly agent: string;
  /**
   * Outcome of the attempt:
   *   - "applied": pass completed AND the auto-applier persisted the result
   *     (wikilinks + dream log written).
   *   - "noop":    pass was skipped upstream (no completed result to apply).
   *   - "failed":  pass failed (LLM error / non-JSON / schema mismatch) OR
   *     the apply step failed.
   */
  readonly status: "applied" | "noop" | "failed";
  /** ISO 8601 — when the dream pass attempt started. */
  readonly started_at: string;
  /** Wall-clock ms for the whole attempt (pass + apply). */
  readonly duration_ms: number;
  /** Wikilinks persisted — present on "applied" rows only. */
  readonly wikilinks_added?: number;
  /**
   * Bounded (<=300 chars) diagnostic string on non-applied rows — the
   * pass/apply error surface (e.g. "parse-failed: ..."). NEVER model
   * output; truncated defensively at the writer.
   */
  readonly reason?: string;
}

/** Writer-side cap for the `reason` diagnostic string. */
export const DREAM_RUN_REASON_MAX_LENGTH = 300;

/**
 * Tail window for `listRecentDreamRuns`. The log grows forever (~9 rows/day
 * fleet-wide, each ~150-400 bytes) — 64 KiB of tail covers weeks of history
 * for every agent while keeping the read O(1) in file size.
 */
const LIST_TAIL_READ_BYTES = 64 * 1024;

/**
 * Default log location: ~/.clawcode/manager/dream-runs.jsonl.
 * Tests may override via `dirOverride` (an absolute path that REPLACES the
 * homedir-derived parent — e.g. a tmpdir). Same seam as
 * consolidation-run-log.ts.
 */
function resolveLogPath(dirOverride?: string): { dir: string; file: string } {
  const dir = dirOverride ?? join(homedir(), ".clawcode", "manager");
  return { dir, file: join(dir, "dream-runs.jsonl") };
}

/**
 * Append one row to the dream run-log. Creates the directory tree if
 * missing.
 *
 * DIVERGENCE from appendConsolidationRun: that writer propagates errors
 * and relies on every call site remembering its own try/catch. Here the
 * "log write failure must never break the caller" discipline is enforced
 * AT THE MODULE BOUNDARY — any fs error (unwritable dir, ENOSPC, …) is
 * caught and swallowed so dreaming can never be affected by its own
 * diagnostic log, even from a future call site that forgets the wrap.
 * (The dream-machinery call site still wraps defensively — covering the
 * dynamic-import path — and warns on failure there.)
 *
 * `reason` is truncated to {@link DREAM_RUN_REASON_MAX_LENGTH} chars —
 * defense against unbounded error strings (mirrors the 115-02 threat-model
 * trim in consolidation-run-log.ts).
 */
export async function appendDreamRun(
  row: DreamRunRow,
  dirOverride?: string,
): Promise<void> {
  try {
    const { dir, file } = resolveLogPath(dirOverride);
    await fs.mkdir(dir, { recursive: true });

    const trimmedRow: DreamRunRow =
      typeof row.reason === "string" &&
      row.reason.length > DREAM_RUN_REASON_MAX_LENGTH
        ? { ...row, reason: row.reason.slice(0, DREAM_RUN_REASON_MAX_LENGTH) }
        : row;
    const line = JSON.stringify(trimmedRow) + "\n";
    await fs.appendFile(file, line, { encoding: "utf8" });
  } catch {
    // Deliberate swallow — see docblock. A dropped diagnostic row is
    // strictly better than a dream pass broken by its own run-log.
  }
}

/**
 * Read the most-recent N rows from the dream run-log. ENOENT returns an
 * empty array (file may not yet exist). Lines that fail to parse are
 * skipped — defensive against partial writes during a crash.
 *
 * DIVERGENCE from listRecentConsolidationRuns: that helper reads the WHOLE
 * file into memory. This log grows ~9 rows/day forever, so this reader is
 * TAIL-BOUNDED — it reads only the last {@link LIST_TAIL_READ_BYTES} of the
 * file and parses complete lines. When the read starts mid-file, the first
 * (partial) line is discarded; every complete line inside the window still
 * parses. The panel only needs the newest rows, so the bound is safe.
 *
 * @param limit Maximum rows to return (most-recent N). Defaults to 50.
 * @param dirOverride Optional absolute dir override (test sandbox).
 */
export async function listRecentDreamRuns(
  limit = 50,
  dirOverride?: string,
): Promise<readonly DreamRunRow[]> {
  const { file } = resolveLogPath(dirOverride);

  let text: string;
  let startedMidFile = false;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const readLength = Math.min(size, LIST_TAIL_READ_BYTES);
    const position = size - readLength;
    startedMidFile = position > 0;
    const buf = Buffer.alloc(readLength);
    await handle.read(buf, 0, readLength, position);
    text = buf.toString("utf8");
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "ENOENT") return [];
    throw err;
  } finally {
    await handle?.close().catch(() => {
      /* close failure is non-actionable for a read path */
    });
  }

  let lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (startedMidFile && lines.length > 0) {
    // The window almost certainly begins mid-line — drop the first
    // (possibly partial) line. If it happened to be complete we lose one
    // old row at the very edge of the window, which is fine for a
    // most-recent-N reader.
    lines = lines.slice(1);
  }

  const out: DreamRunRow[] = [];
  for (const l of lines) {
    try {
      const row = JSON.parse(l) as DreamRunRow;
      out.push(row);
    } catch {
      // Skip malformed lines — partial write from a crashed daemon.
    }
  }

  return out.length <= limit ? out : out.slice(out.length - limit);
}
