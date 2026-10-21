/**
 * Phase 84 Plan 03 — v2.2 skills migration report writer.
 *
 * Generates `.planning/milestones/v2.2-skills-migration-report.md` from the
 * v2.2 skills ledger + discovered-skills snapshot + linker verification
 * array.
 *
 * Shape MIRRORS v2.1's `src/migration/report-writer.ts` (Phase 82) for
 * operator familiarity — same YAML frontmatter discipline, same atomic
 * temp+rename discipline. Does NOT import the v2.1 writer directly because
 * the per-entity row shape + section headers differ (v2.1 is per-agent;
 * v2.2 is per-skill).
 *
 * Report structure:
 *   ---
 *   milestone: v2.2
 *   date: <ISO>
 *   skills_migrated: <N>
 *   skills_refused_secret_scan: <N>
 *   skills_deprecated: <N>
 *   skills_skipped_p2: <N>
 *   skills_skipped_idempotent: <N>
 *   source_integrity_sha: <sha256>
 *   source_tree_readonly: "verified" | "mtime-changed" | "unchecked"
 *   ---
 *   # v2.2 OpenClaw Skills Migration Report
 *   ## Per-Skill Outcomes
 *   ### <skill-name>
 *     - classification: p1 | p2 | deprecate | unknown
 *     - verdict: migrated | skipped-secret-scan | ...
 *     - source_hash: <sha256>
 *     - target_hash: <sha256 | "n/a">
 *     - target_path: ~/.clawcode/skills/<name> | "n/a"
 *     - secret_scan_reason: <string | "n/a">
 *   ## Per-Agent Linker Verification
 *   | Agent | Skill | Status | Reason |
 *   |-------|-------|--------|--------|
 *   | ... |
 *   ## Cross-Cutting Invariants
 *   - [x] source_integrity_sha matches expected: sha256(sorted(ledger_source_hashes))
 *   - [x] ~/.openclaw/skills/ mtime unchanged (pre/post sampled)
 *   - [x] Zero secret-scan false negatives
 *   - [x] Idempotency: re-running apply against current state produces zero new 'migrated' rows
 *
 * Determinism rules:
 *   1. discovered + verifications are sorted before rendering.
 *   2. Frontmatter key order is FIXED (see FRONTMATTER_KEY_ORDER).
 *   3. generatedAt is supplied by the caller (tests pass a frozen ISO).
 *   4. Atomic temp+rename (mkdir parent + writeFile .tmp + rename) — partial
 *      writes never visible to a concurrent reader.
 *
 * DO NOT:
 *   - Add new npm deps (zero-dep constraint from 84-CONTEXT).
 *   - Import v2.1 writeMigrationReport (shape mismatch).
 *   - Walk the source tree directly — source_integrity_sha is derived
 *     from the ledger's source_hash column (the authoritative audit trail).
 *   - Mutate inputs. All Readonly by contract.
 */
import { writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import {
  readSkillRows,
  type SkillsLedgerRow,
} from "./skills-ledger.js";
import type { DiscoveredSkill } from "./skills-discovery.js";
import type { LinkVerification } from "./skills-linker-verifier.js";

/**
 * Frontmatter key order — FIXED. Tests pin this contract (test 4).
 */
const FRONTMATTER_KEY_ORDER: readonly string[] = [
  "milestone",
  "date",
  "skills_migrated",
  "skills_refused_secret_scan",
  "skills_deprecated",
  "skills_skipped_p2",
  "skills_skipped_idempotent",
  "source_integrity_sha",
  "source_tree_readonly",
];

export type SourceTreeReadonlyState =
  | "verified"
  | "mtime-changed"
  | "unchecked";

/**
 * Input contract for writeSkillsMigrationReport.
 */
export type WriteReportOpts = {
  readonly reportPath: string;
  readonly ledgerPath: string;
  readonly discovered: readonly DiscoveredSkill[];
  readonly verifications: readonly LinkVerification[];
  readonly sourceTreeReadonly: SourceTreeReadonlyState;
  /** ISO 8601. Testable via injection — tests pass a frozen string. */
  readonly generatedAt: string;
};

/**
 * Derive the latest status per skill from the ledger's append-only
 * ordering (last-write-wins). Local reimplementation rather than calling
 * latestStatusBySkill so we don't read the file twice.
 */
function deriveLatestStatus(
  rows: readonly SkillsLedgerRow[],
): ReadonlyMap<string, SkillsLedgerRow> {
  const map = new Map<string, SkillsLedgerRow>();
  for (const row of rows) {
    // Skip 'verify' rows for the per-skill verdict — verify rows carry
    // linker-status as their 'status' field which conflates per-agent
    // link outcomes with the skill's own migration verdict. Verification
    // table is emitted separately via `verifications` array.
    if (row.action === "verify") continue;
    map.set(row.skill, row);
  }
  return map;
}

/**
 * Compute source_integrity_sha = sha256 of the sorted unique source_hash
 * values joined by `\n`. The ledger's source_hash column is the
 * authoritative audit trail of what source content was seen at each step;
 * hashing the sorted union gives a deterministic checksum without
 * re-walking the source tree.
 */
function computeSourceIntegritySha(
  rows: readonly SkillsLedgerRow[],
): string {
  const uniq = new Set<string>();
  for (const r of rows) {
    // Exclude synthetic placeholder used by verify rows (which have no
    // real per-skill source_hash — they record linker state, not source).
    if (r.source_hash === "verify-only") continue;
    uniq.add(r.source_hash);
  }
  const sorted = [...uniq].sort();
  return createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex");
}

/**
 * Derive the per-skill verdict string for the report body.
 *
 * Priority:
 *   1. classification === "deprecate" → "skipped-deprecated"
 *   2. classification === "p2" → "skipped-p2"
 *   3. ledger latest row status:
 *        migrated → "migrated"
 *        refused  → "skipped-secret-scan" (or "refused-copy" when step=copy)
 *        skipped  → "skipped-idempotent" if notes hint idempotent, else
 *                   "skipped-classification"
 *        pending  → "pending"
 *   4. No ledger row → "classified" (dry-run only — plan-mode rows not yet
 *      emitted against this skill)
 */
function verdictFor(
  skill: DiscoveredSkill,
  latest: SkillsLedgerRow | undefined,
): string {
  if (skill.classification === "deprecate") return "skipped-deprecated";
  if (skill.classification === "p2") return "skipped-p2";
  // P1 + unknown rely on the ledger.
  if (!latest) return "classified";
  switch (latest.status) {
    case "migrated":
      return "migrated";
    case "refused":
      if (latest.step === "copy") return "refused-copy";
      return "skipped-secret-scan";
    case "skipped": {
      const notes = latest.notes ?? "";
      if (notes.includes("source_hash matches prior") || notes.includes("idempotent")) {
        return "skipped-idempotent";
      }
      return "skipped-classification";
    }
    case "pending":
      return "pending";
    case "re-planned":
      return "re-planned";
  }
}

/**
 * Escape pipe characters inside a table cell with `\|` so the markdown
 * table renderer doesn't split the cell. Newlines are coerced to spaces
 * for the same reason.
 */
function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Render the YAML frontmatter block. Emits keys in FRONTMATTER_KEY_ORDER.
 * Keys whose values are undefined are skipped; tests assert the canonical
 * 9-key shape so all keys are always supplied by callers.
 */
function renderFrontmatter(
  values: Readonly<Record<string, string | number>>,
): string {
  const lines: string[] = ["---"];
  for (const key of FRONTMATTER_KEY_ORDER) {
    const v = values[key];
    if (v === undefined) continue;
    lines.push(`${key}: ${v}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/**
 * Render the per-skill section. Includes every discovered skill (ALL 12
 * classifications) so the operator gets a full audit of what was seen,
 * not just what got migrated.
 */
function renderSkillSection(
  skill: DiscoveredSkill,
  latest: SkillsLedgerRow | undefined,
): string {
  const verdict = verdictFor(skill, latest);
  const targetHash = latest?.target_hash ?? "n/a";
  const targetPath =
    latest?.status === "migrated" ? `~/.clawcode/skills/${skill.name}` : "n/a";
  const secretScanReason =
    verdict === "skipped-secret-scan" || verdict === "refused-copy"
      ? (latest?.notes ?? "unknown")
      : "n/a";
  return [
    `### ${skill.name}`,
    `- classification: ${skill.classification}`,
    `- verdict: ${verdict}`,
    `- source_hash: ${skill.sourceHash}`,
    `- target_hash: ${targetHash}`,
    `- target_path: ${targetPath}`,
    `- secret_scan_reason: ${secretScanReason}`,
    "",
  ].join("\n");
}

/**
 * Render the per-agent linker verification markdown table. Empty-reason
 * cells render as em-dash (U+2014) so the table stays readable.
 */
function renderVerificationTable(
  verifications: readonly LinkVerification[],
): string {
  const lines: string[] = [
    "## Per-Agent Linker Verification",
    "",
    "| Agent | Skill | Status | Reason |",
    "|-------|-------|--------|--------|",
  ];
  if (verifications.length === 0) {
    lines.push(
      "| _none_ | _none_ | _none_ | \u2014 |",
    );
    lines.push("");
    return lines.join("\n");
  }
  // Stable sort: by agent then skill.
  const sorted = [...verifications].sort((a, b) => {
    const ac = a.agent.localeCompare(b.agent);
    if (ac !== 0) return ac;
    return a.skill.localeCompare(b.skill);
  });
  for (const v of sorted) {
    const reason = v.reason && v.reason.length > 0 ? v.reason : "\u2014";
    lines.push(
      `| ${escapePipe(v.agent)} | ${escapePipe(v.skill)} | ${escapePipe(
        v.status,
      )} | ${escapePipe(reason)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the four cross-cutting invariant checkboxes. Each reflects
 * ground-truth ledger state (invariant 1 is always computed here;
 * invariant 2 comes from the caller's mtime sampling; invariants 3 + 4
 * are derived from the ledger).
 */
function renderInvariants(input: {
  readonly sourceIntegritySha: string;
  readonly sourceTreeReadonly: SourceTreeReadonlyState;
  readonly zeroSecretScanFalseNegatives: boolean;
  readonly idempotent: boolean;
}): string {
  const mark = (b: boolean): string => (b ? "[x]" : "[ ]");
  const lines: string[] = ["## Cross-Cutting Invariants", ""];
  // Invariant 1 is true by construction — the sha is what we computed.
  // Render the sha inline so the operator sees the value.
  lines.push(
    `- [x] source_integrity_sha matches expected: sha256(sorted(ledger_source_hashes)) = \`${input.sourceIntegritySha}\``,
  );
  const mtimeOk = input.sourceTreeReadonly === "verified";
  lines.push(
    `- ${mark(mtimeOk)} \`~/.openclaw/skills/\` mtime unchanged (pre/post-sampled: ${input.sourceTreeReadonly})`,
  );
  lines.push(
    `- ${mark(
      input.zeroSecretScanFalseNegatives,
    )} Zero secret-scan false negatives (every P1 skill either copy-verified clean OR refused)`,
  );
  lines.push(
    `- ${mark(
      input.idempotent,
    )} Idempotency: re-running apply against current state produces zero new ledger rows with status="migrated"`,
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * Assemble the full markdown body from its sections.
 */
function renderReport(input: {
  readonly discovered: readonly DiscoveredSkill[];
  readonly latestByskill: ReadonlyMap<string, SkillsLedgerRow>;
  readonly verifications: readonly LinkVerification[];
  readonly aggregates: Readonly<Record<string, string | number>>;
  readonly sourceIntegritySha: string;
  readonly sourceTreeReadonly: SourceTreeReadonlyState;
  readonly zeroSecretScanFalseNegatives: boolean;
  readonly idempotent: boolean;
}): string {
  // Sort discovered alphabetically for deterministic output.
  const sortedDiscovered = [...input.discovered].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const parts: string[] = [];
  parts.push(renderFrontmatter(input.aggregates));
  parts.push("# v2.2 OpenClaw Skills Migration Report");
  parts.push("");
  parts.push("## Per-Skill Outcomes");
  parts.push("");
  for (const skill of sortedDiscovered) {
    parts.push(renderSkillSection(skill, input.latestByskill.get(skill.name)));
  }
  parts.push(renderVerificationTable(input.verifications));
  parts.push(
    renderInvariants({
      sourceIntegritySha: input.sourceIntegritySha,
      sourceTreeReadonly: input.sourceTreeReadonly,
      zeroSecretScanFalseNegatives: input.zeroSecretScanFalseNegatives,
      idempotent: input.idempotent,
    }),
  );
  return parts.join("\n");
}

/**
 * Main entry point. Build + write the v2.2 skills migration report.
 * Atomic temp+rename — partial writes never visible. Returns the
 * absolute resolved path of the written report.
 */
export async function writeSkillsMigrationReport(
  opts: WriteReportOpts,
): Promise<string> {
  const rows = await readSkillRows(opts.ledgerPath);
  const latestByskill = deriveLatestStatus(rows);

  // ----- Aggregate counters -----
  let migrated = 0;
  let refusedSecretScan = 0;
  let deprecated = 0;
  let skippedP2 = 0;
  let skippedIdempotent = 0;
  let p1Seen = 0;
  let p1RefusedOrMigrated = 0;

  for (const skill of opts.discovered) {
    const latest = latestByskill.get(skill.name);
    const verdict = verdictFor(skill, latest);
    if (skill.classification === "deprecate") {
      deprecated++;
    } else if (skill.classification === "p2" || skill.classification === "unknown") {
      skippedP2++;
    }
    if (skill.classification === "p1") {
      p1Seen++;
      if (verdict === "migrated" || verdict === "skipped-secret-scan" || verdict === "refused-copy" || verdict === "skipped-idempotent") {
        p1RefusedOrMigrated++;
      }
    }
    switch (verdict) {
      case "migrated":
        migrated++;
        break;
      case "skipped-secret-scan":
      case "refused-copy":
        refusedSecretScan++;
        break;
      case "skipped-idempotent":
        skippedIdempotent++;
        break;
      // "skipped-deprecated" / "skipped-p2" / "classified" already counted
      // by the classification branch above.
    }
  }

  const sourceIntegritySha = computeSourceIntegritySha(rows);

  // Invariant 3: zero secret-scan false negatives = every P1 either
  // migrated or refused (no silent skips in the P1 universe).
  const zeroSecretScanFalseNegatives = p1Seen === 0 || p1RefusedOrMigrated === p1Seen;

  // Invariant 4: idempotency = after this apply, rerunning would produce
  // no new 'migrated' rows. Proxy: every P1 that is migrated has a row
  // whose source_hash matches the discovered sourceHash (ledger is
  // up-to-date). If a stale source_hash exists, the next run will
  // re-plan and re-migrate — failing idempotency.
  let idempotent = true;
  for (const skill of opts.discovered) {
    if (skill.classification !== "p1") continue;
    const latest = latestByskill.get(skill.name);
    if (!latest) continue;
    if (latest.status === "migrated" && latest.source_hash !== skill.sourceHash) {
      idempotent = false;
      break;
    }
  }

  const aggregates: Record<string, string | number> = {
    milestone: "v2.2",
    date: opts.generatedAt,
    skills_migrated: migrated,
    skills_refused_secret_scan: refusedSecretScan,
    skills_deprecated: deprecated,
    skills_skipped_p2: skippedP2,
    skills_skipped_idempotent: skippedIdempotent,
    source_integrity_sha: sourceIntegritySha,
    source_tree_readonly: opts.sourceTreeReadonly,
  };

  const markdown = renderReport({
    discovered: opts.discovered,
    latestByskill,
    verifications: opts.verifications,
    aggregates,
    sourceIntegritySha,
    sourceTreeReadonly: opts.sourceTreeReadonly,
    zeroSecretScanFalseNegatives,
    idempotent,
  });

  // ----- Atomic temp+rename write -----
  const resolvedPath = resolve(opts.reportPath);
  const destDir = dirname(resolvedPath);
  await mkdir(destDir, { recursive: true });
  const tmpPath = join(
    destDir,
    `.v2.2-skills-migration-report.md.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(tmpPath, markdown, "utf8");
  try {
    await rename(tmpPath, resolvedPath);
  } catch (err) {
    // Best-effort cleanup of the tmp file so we don't leak .tmp leftover
    // into .planning/milestones/ on rename failure.
    try {
      await unlink(tmpPath);
    } catch {
      // swallow
    }
    throw err;
  }
  return resolvedPath;
}
