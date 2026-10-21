/**
 * Phase 96 Plan 06 — deprecation ledger row appender.
 *
 * Mirrors Phase 91 plan 04's ledger pattern (one JSONL line per state
 * transition). Ledger lives at `~/.clawcode/manager/deprecation-ledger.jsonl`
 * — separate from Phase 91's sync.jsonl + Phase 92's cutover-ledger.jsonl
 * to keep audit trails siloed by concern.
 *
 * Used by:
 *   - `clawcode sync disable-timer` (Phase 96 D-11) — appends "disable-timer" row
 *   - `clawcode sync re-enable-timer` (Phase 96 D-11) — appends "re-enable-timer" row
 *
 * Atomic-by-design: appendFile is a single syscall on POSIX; concurrent
 * writers may interleave but never produce torn lines (writes are smaller
 * than PIPE_BUF). Mirrors Phase 91 sync.jsonl appender.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";

/** Canonical ledger path (operator audit trail for Phase 96 D-11 transitions). */
export const DEFAULT_DEPRECATION_LEDGER_PATH = join(
  homedir(),
  ".clawcode",
  "manager",
  "deprecation-ledger.jsonl",
);

/**
 * One ledger row — flat JSON shape, jq-friendly.
 *
 * `action` is the operator command surface that produced the row.
 * `deprecatedAt` is set on disable-timer rows; `windowDaysRemaining`
 * is set on re-enable-timer rows for forensic reconstruction.
 */
export type DeprecationLedgerEntry = Readonly<{
  action: "disable-timer" | "re-enable-timer";
  timestamp: string;
  deprecatedAt?: string;
  windowDaysRemaining?: number;
}>;

/**
 * Appender signature — DI'd into CLI subcommands so tests can capture rows.
 *
 * Takes the entry as the FIRST positional argument (test-friendly: tests
 * assert on `ledgerWriter.mock.calls[0]?.[0]` to inspect the appended row);
 * filePath + log are passed via closure-bound options so callers don't
 * have to thread them through. This is the inverse of the Phase 91
 * sync.jsonl appender shape, but is the right ergonomics for testability.
 */
export type DeprecationLedgerAppender = (
  entry: DeprecationLedgerEntry,
  options?: { filePath?: string; log?: Logger },
) => Promise<void>;

/**
 * Default appender: mkdir parent + appendFile JSONL line. Errors warn-and-
 * swallow at the caller level (a missing audit row never blocks state ops).
 */
export const defaultLedgerAppender: DeprecationLedgerAppender = async (
  entry,
  options,
) => {
  const filePath = options?.filePath ?? DEFAULT_DEPRECATION_LEDGER_PATH;
  const { appendFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
  options?.log?.debug(
    { filePath, action: entry.action },
    "deprecation-ledger row appended",
  );
};
