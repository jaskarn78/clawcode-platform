/**
 * Quick task 260419-mvh Task 2 — `clawcode openai-log tail` CLI subcommand.
 *
 * Reads the JSONL feed emitted by `src/openai/request-logger.ts` and prints
 * a filtered view — optional `--agent`, required `--since <duration>`, and
 * `--json` for raw-line output.
 *
 * Default log dir: `~/.clawcode/manager/`. Override for tests via the
 * `dir` field on the `OpenAiLogCommandDeps` bag.
 *
 * Format:
 *   - Default: padded-column table (mirrors `openai-key list` renderer) with
 *     a `-`-divider between header and data rows.
 *   - `--json`: one raw JSON line per matching record.
 *
 * Reader logic:
 *   - Compute the set of UTC dates the `--since` window covers (today + N
 *     prior days).
 *   - Read each JSONL file, parse each line, skip malformed lines with a
 *     best-effort warn on stderr.
 *   - Filter by `agent` (exact match) and `timestamp_iso >= now - since`.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";

import { cliLog, cliError } from "../output.js";
import type { RequestLogRecord } from "../../openai/request-logger.js";

const DEFAULT_MANAGER_DIR = join(homedir(), ".clawcode", "manager");

// ---------------------------------------------------------------------------
// Duration parsing — "30m" / "1h" / "48h" / "7d"
// ---------------------------------------------------------------------------

/**
 * Parse a human-friendly duration string into milliseconds.
 * Throws on invalid input.
 */
export function parseDurationMs(input: string): number {
  const trimmed = input.trim().toLowerCase();
  const match = /^(\d+)\s*([smhd])$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid --since value: '${input}'. Use '30m', '1h', '24h', or '7d'.`,
    );
  }
  const n = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2];
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid --since value: '${input}' (non-positive)`);
  }
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  const mult = multipliers[unit ?? ""];
  if (mult === undefined) {
    throw new Error(`Invalid --since unit in '${input}'`);
  }
  return n * mult;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Return the list of UTC ISO dates (YYYY-MM-DD) covered by `[now - sinceMs, now]`.
 * Inclusive of both endpoints — operator sees every file that could contain
 * a matching record.
 */
export function datesCoveringWindow(now: Date, sinceMs: number): string[] {
  const earliest = new Date(now.getTime() - sinceMs);
  const dates = new Set<string>();
  // Iterate day-by-day from earliest to now. Guard against runaway input by
  // capping to 366 days.
  let cursor = new Date(
    Date.UTC(
      earliest.getUTCFullYear(),
      earliest.getUTCMonth(),
      earliest.getUTCDate(),
    ),
  );
  const endDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  let hops = 0;
  while (cursor.getTime() <= endDay && hops < 366) {
    dates.add(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    hops++;
  }
  return [...dates];
}

function logFilePath(dir: string, date: string): string {
  return join(dir, `openai-requests-${date}.jsonl`);
}

// ---------------------------------------------------------------------------
// Default reader (deps-injectable)
// ---------------------------------------------------------------------------

/** Read + parse JSONL files. Returns all records (not filtered). */
export function readLogFiles(
  dir: string,
  dates: readonly string[],
): RequestLogRecord[] {
  const out: RequestLogRecord[] = [];
  for (const date of dates) {
    const path = logFilePath(dir, date);
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(JSON.parse(trimmed) as RequestLogRecord);
      } catch {
        // Skip malformed line silently — a partial write at daemon crash
        // can leave a half-written line. The rest of the file is still
        // parseable.
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Table renderer (mirrors openai-key's renderListTable)
// ---------------------------------------------------------------------------

const HEADER = [
  "date",
  "request_id",
  "agent",
  "status",
  "ttfb_ms",
  "total_ms",
  "finish_reason",
];

function renderCell(record: RequestLogRecord, col: string): string {
  switch (col) {
    case "date":
      return record.timestamp_iso.slice(0, 19).replace("T", " ");
    case "request_id":
      return record.request_id;
    case "agent":
      return record.agent ?? "—";
    case "status":
      return String(record.status_code);
    case "ttfb_ms":
      return record.ttfb_ms === null ? "—" : String(record.ttfb_ms);
    case "total_ms":
      return String(record.total_ms);
    case "finish_reason":
      return record.finish_reason ?? "—";
    default:
      return "";
  }
}

function renderTable(records: readonly RequestLogRecord[]): string {
  const data = records.map((r) => HEADER.map((col) => renderCell(r, col)));
  const allRows = [HEADER, ...data];
  const widths = HEADER.map((_, col) =>
    Math.max(...allRows.map((r) => (r[col] ?? "").length)),
  );
  const sep = "  ";
  const lines = allRows.map((r) =>
    r
      .map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0))
      .join(sep)
      .trimEnd(),
  );
  const divider = widths.map((w) => "-".repeat(w)).join(sep);
  return [lines[0], divider, ...lines.slice(1)].join("\n");
}

// ---------------------------------------------------------------------------
// Test-injectable dependency bag
// ---------------------------------------------------------------------------

export interface OpenAiLogCommandDeps {
  /** Where to emit stdout-equivalent lines (default: cliLog). */
  log: (message: string) => void;
  /** Where to emit stderr (default: cliError). */
  error: (message: string) => void;
  /** Called on fatal validation errors. Default: process.exit. */
  exit: (code: number) => void;
  /** Injected clock — defaults to new Date(). */
  now?: () => Date;
  /** Log dir override — defaults to ~/.clawcode/manager/. */
  dir?: string;
  /** Reader override — defaults to `readLogFiles`. */
  reader?: (dir: string, dates: readonly string[]) => RequestLogRecord[];
}

export function buildDefaultDeps(): OpenAiLogCommandDeps {
  return {
    log: cliLog,
    error: cliError,
    exit: (code) => process.exit(code),
  };
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerOpenAiLogCommand(
  program: Command,
  deps: OpenAiLogCommandDeps = buildDefaultDeps(),
): void {
  const root = program
    .command("openai-log")
    .description("Inspect OpenAI-endpoint request logs (JSONL feed)");

  root
    .command("tail")
    .description("Print recent requests from the JSONL log feed")
    .option("--agent <name>", "Filter by agent name (exact match)")
    .option(
      "--since <duration>",
      "How far back to read, e.g. '30m', '1h', '24h', '7d'",
      "1h",
    )
    .option("--json", "Emit raw JSON lines instead of a table")
    .action(
      async (opts: { agent?: string; since: string; json?: boolean }) => {
        try {
          const now = (deps.now ?? (() => new Date()))();
          const dir = deps.dir ?? DEFAULT_MANAGER_DIR;
          const reader = deps.reader ?? readLogFiles;

          const sinceMs = parseDurationMs(opts.since);
          const dates = datesCoveringWindow(now, sinceMs);
          const cutoff = now.getTime() - sinceMs;

          const all = reader(dir, dates);
          const filtered = all
            .filter((r) => {
              if (opts.agent !== undefined && r.agent !== opts.agent) return false;
              const ts = Date.parse(r.timestamp_iso);
              if (!Number.isFinite(ts)) return false;
              return ts >= cutoff;
            })
            // Oldest first — aligns with `tail -f` conventions.
            .sort((a, b) =>
              a.timestamp_iso.localeCompare(b.timestamp_iso),
            );

          if (filtered.length === 0) {
            deps.log("No requests logged.");
            return;
          }

          if (opts.json === true) {
            for (const r of filtered) {
              deps.log(JSON.stringify(r));
            }
            return;
          }

          deps.log(renderTable(filtered));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          deps.error(`Error: ${msg}`);
          deps.exit(1);
        }
      },
    );
}
