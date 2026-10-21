/**
 * Phase 92 Plan 03 — `~/.clawcode/manager/cutover-ledger.jsonl` writer/reader.
 *
 * Mirrors src/migration/ledger.ts (Phase 82) invariants verbatim:
 *   1. Append-only — NO truncate / clear / rewrite / removeRow helpers.
 *   2. Validate on WRITE (zod parse before mkdir + appendFile).
 *   3. appendFile (NOT writeFile) — concurrent writers cannot lose rows
 *      under writeFile's read-modify-write pattern.
 *
 * Audit trail format: one JSON object per line, terminated by \n. Any line
 * that fails to parse or fails the schema is skipped on read with a logger
 * warning (so the ledger is forward-compatible with future Plan 92-04/06
 * row shapes that add fields). Writes never tolerate invalid rows.
 *
 * DO NOT add:
 *   - clearLedger / truncate / removeRow / rewriteRow — append-only invariant
 *   - fs.writeFile-based append — race with concurrent invocations
 *   - rewrite-with-pos seeks — the ledger is forward-only
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "pino";
import {
  cutoverLedgerRowSchema,
  type CutoverLedgerRow,
} from "./types.js";

/**
 * Canonical path for the cutover ledger. Single file, all agents — per-row
 * `agent` field is the discriminator (queryCutoverRowsByAgent filters).
 */
export const DEFAULT_CUTOVER_LEDGER_PATH = join(
  homedir(),
  ".clawcode",
  "manager",
  "cutover-ledger.jsonl",
);

/**
 * Append a single validated row. Validates BEFORE mkdir + appendFile so a
 * malformed row never reaches the filesystem (load-bearing for determinism).
 *
 * Throws if the row fails schema validation. Caller is responsible for
 * propagating the error or wrapping in a typed outcome.
 */
export async function appendCutoverRow(
  filePath: string,
  row: CutoverLedgerRow,
  log?: Logger,
): Promise<void> {
  // Validate FIRST — invalid row never reaches the filesystem.
  const parsed = cutoverLedgerRowSchema.safeParse(row);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid CutoverLedgerRow: ${issues}`);
  }
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(parsed.data) + "\n", "utf8");
  log?.debug(
    { agent: parsed.data.agent, action: parsed.data.action, kind: parsed.data.kind },
    "cutover ledger: row appended",
  );
}

/**
 * Read every parseable, schema-valid row in the ledger. Returns `[]` (no
 * throw) when the file does not exist — fresh-checkout case.
 *
 * Malformed JSON or schema-invalid rows are SKIPPED (with logger warn when
 * provided). This is deliberate forward-compatibility: future plans may
 * extend the row shape, and a strict throw would freeze the ledger format.
 */
export async function readCutoverRows(
  filePath: string,
  log?: Logger,
): Promise<readonly CutoverLedgerRow[]> {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const rows: CutoverLedgerRow[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      log?.warn(
        { line: line.slice(0, 200), err },
        `cutover ledger: malformed JSON skipped (line ${i + 1})`,
      );
      continue;
    }
    const parsed = cutoverLedgerRowSchema.safeParse(json);
    if (!parsed.success) {
      log?.warn(
        { line: line.slice(0, 200), issues: parsed.error.issues },
        `cutover ledger: schema-invalid row skipped (line ${i + 1})`,
      );
      continue;
    }
    rows.push(parsed.data);
  }
  return rows;
}

/**
 * Filter the ledger to rows for a single agent. Append-order preserved
 * (no re-sort by ts — wall-clock skew between apply/rollback rows would
 * reshuffle a legitimate sequence; mirrors Phase 82 latestStatusByAgent).
 */
export async function queryCutoverRowsByAgent(
  filePath: string,
  agent: string,
  log?: Logger,
): Promise<readonly CutoverLedgerRow[]> {
  const all = await readCutoverRows(filePath, log);
  return all.filter((r) => r.agent === agent);
}
