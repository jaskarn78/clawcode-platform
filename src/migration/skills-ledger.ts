/**
 * Phase 84 Plan 01 — Skills migration ledger (v2.2).
 *
 * Append-only JSONL ledger tracking per-skill state transitions across the
 * OpenClaw → ClawCode skills migration pipeline. Separate file from the
 * v2.1 agent ledger (`ledger.jsonl`) so that v2.1 status queries remain
 * byte-stable and the two pipelines can be audited independently.
 *
 * Mirrors the shape of `src/migration/ledger.ts` (v2.1 / Phase 76) deliberately
 * — same zod / mkdir / appendFile discipline, same append-only invariant, same
 * per-entity last-write-wins status derivation.
 *
 * Distinctions from v2.1 ledger:
 *   - `skill` (not `agent`) as the per-row entity name
 *   - status enum extended with `skipped` / `refused` (skills are either
 *     migrated, deprecated, P2-skipped, or secret-scan-refused — plan 02
 *     adds `verified` when linker wiring lands)
 *   - action enum trimmed to `plan` / `apply` / `verify` (no rollback or
 *     cutover — plan 03 handles completion reporting, not state rewind)
 *
 * File lives at `.planning/migration/v2.2-skills-ledger.jsonl`.
 *
 * Invariants:
 *   1. Append-only — no delete / rewrite / truncate helpers.
 *   2. Validated on WRITE (not just read) — bad row can't even create the dir.
 *   3. `appendFile` (not `writeFile`) — concurrent writers would lose rows.
 */
import { z } from "zod/v4";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Canonical skills-ledger action enum.
 *   plan   — dry-run classification emits `plan` rows (Plan 01 --dry-run)
 *   apply  — actual copy + linking produces `apply` rows (Plan 02)
 *   verify — per-agent linker verification (Plan 02)
 */
export const SKILLS_LEDGER_ACTIONS = ["plan", "apply", "verify"] as const;
export type SkillsLedgerAction = (typeof SKILLS_LEDGER_ACTIONS)[number];

/**
 * Canonical skills-ledger status enum.
 *   pending    — first-run or awaiting apply
 *   migrated   — skill successfully copied+linked
 *   skipped    — deprecated / P2-out-of-scope / idempotent no-op
 *   refused    — secret-scan refusal (hard gate for SKILL-02)
 *   re-planned — source_hash changed between plan runs
 */
export const SKILLS_LEDGER_STATUSES = [
  "pending",
  "migrated",
  "skipped",
  "refused",
  "re-planned",
] as const;
export type SkillsLedgerStatus = (typeof SKILLS_LEDGER_STATUSES)[number];

/**
 * Narrower outcome for per-gate rows — allow (guard passed) vs refuse
 * (guard blocked). Mirrors v2.1 LEDGER_OUTCOMES.
 */
export const SKILLS_LEDGER_OUTCOMES = ["allow", "refuse"] as const;
export type SkillsLedgerOutcome = (typeof SKILLS_LEDGER_OUTCOMES)[number];

/**
 * Zod validator for a single skills-ledger row. `ts` must parse via Date.parse
 * AND contain a "T" separator (rules out ambiguous date-only strings).
 */
export const skillsLedgerRowSchema = z.object({
  ts: z
    .string()
    .refine(
      (v) => !Number.isNaN(Date.parse(v)) && v.includes("T"),
      "ts must be ISO 8601 with time component",
    ),
  action: z.enum(SKILLS_LEDGER_ACTIONS),
  skill: z.string().min(1),
  status: z.enum(SKILLS_LEDGER_STATUSES),
  source_hash: z.string().min(1),
  target_hash: z.string().optional(),
  step: z.string().min(1).optional(),
  outcome: z.enum(SKILLS_LEDGER_OUTCOMES).optional(),
  notes: z.string().optional(),
});
export type SkillsLedgerRow = z.infer<typeof skillsLedgerRowSchema>;

/** Repo-tracked skills-ledger location. */
export const DEFAULT_SKILLS_LEDGER_PATH =
  ".planning/migration/v2.2-skills-ledger.jsonl";

/**
 * Append one validated row. Creates parent dir on first write. Throws
 * pre-mkdir on validation failure so a bad row never creates the dir
 * or the file.
 */
export async function appendSkillRow(
  ledgerPath: string,
  row: SkillsLedgerRow,
): Promise<void> {
  const parsed = skillsLedgerRowSchema.safeParse(row);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid SkillsLedgerRow: ${issues}`);
  }
  await mkdir(dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(parsed.data)}\n`, "utf8");
}

/**
 * Read + validate every row. Returns `[]` on missing file (first-run case).
 * Blank lines are tolerated; malformed JSON throws with line-number context.
 */
export async function readSkillRows(
  ledgerPath: string,
): Promise<readonly SkillsLedgerRow[]> {
  if (!existsSync(ledgerPath)) return [];
  const text = await readFile(ledgerPath, "utf8");
  const lines = text.split("\n");
  const rows: SkillsLedgerRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Malformed JSON in ${ledgerPath} at line ${i + 1}: ${msg}`,
      );
    }
    const result = skillsLedgerRowSchema.safeParse(parsedJson);
    if (!result.success) {
      const issues = result.error.issues
        .map((s) => `${s.path.join(".") || "(root)"}: ${s.message}`)
        .join("; ");
      throw new Error(
        `Invalid SkillsLedgerRow in ${ledgerPath} at line ${i + 1}: ${issues}`,
      );
    }
    rows.push(result.data);
  }
  return rows;
}

/**
 * Derive `Map<skill, SkillsLedgerStatus>` with only the most recent status
 * per skill. Last-write-wins in insert order (append-only ordering is the
 * truth source; do not re-sort by ts).
 */
export async function latestStatusBySkill(
  ledgerPath: string,
): Promise<ReadonlyMap<string, SkillsLedgerStatus>> {
  const rows = await readSkillRows(ledgerPath);
  const map = new Map<string, SkillsLedgerStatus>();
  for (const r of rows) {
    map.set(r.skill, r.status);
  }
  return map;
}
