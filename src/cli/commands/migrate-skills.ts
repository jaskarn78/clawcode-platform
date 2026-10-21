/**
 * Phase 84 Plan 01 Task 2 — `clawcode migrate openclaw skills` CLI.
 *
 * Nested under the existing `migrate openclaw` subcommand tree (Phase 76)
 * as a sibling to `list` / `plan` / `apply` / `verify` / `rollback` /
 * `cutover` / `complete`. Does NOT create a top-level `clawcode
 * skills-migrate` — keeps the migrate namespace coherent.
 *
 * Usage:
 *   clawcode migrate openclaw skills              (alias for --dry-run)
 *   clawcode migrate openclaw skills --dry-run    (default; safe)
 *   clawcode migrate openclaw skills apply        (writes ledger; Plan 02 adds copy)
 *
 * Pipeline per skill (ALPHABETICAL order, deterministic output):
 *   discovery → classification (P1/P2/DEPRECATE/unknown)
 *     P1  → ledger-idempotency check (matching source_hash)
 *             yes → skipped (idempotent)
 *             no  → secret-scan
 *                     refuse → skipped (secret-scan)
 *                     allow  → migrated / would-migrate
 *     P2  → skipped (p2-out-of-scope)
 *     DEP → skipped (deprecated)
 *     UNK → skipped (p2-out-of-scope) unless --include-unknown
 *
 * Exit codes:
 *   0 — dry-run (informational) OR apply with no secret-scan refusals
 *   1 — apply with one or more secret-scan refusals
 *
 * Zero-write contract (inherited from Phase 76):
 *   - NO writes to ~/.openclaw/ EVER (enforced by fs-guard runtime patch)
 *   - NO writes to the ledger during --dry-run
 *   - Ledger at opts.ledgerPath is the ONLY permitted write
 *
 * DO NOT:
 *   - Log through console.* — always cliLog/cliError
 *   - Add chalk/picocolors/cli-table3 (zero new deps constraint)
 *   - Write anywhere except the ledger in the apply branch
 *   - Perform the actual copy — Plan 02 lands that on top of this scaffold
 */
import type { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import {
  installFsGuard,
  uninstallFsGuard,
} from "../../migration/fs-guard.js";
import { cliLog, cliError, green, yellow, red, dim } from "../output.js";
import {
  discoverOpenclawSkills,
  SKILL_DEPRECATION_REASONS,
  type DiscoveredSkill,
} from "../../migration/skills-discovery.js";
import { scanSkillSecrets } from "../../migration/skills-secret-scan.js";
import {
  DEFAULT_SKILLS_LEDGER_PATH,
  appendSkillRow,
  readSkillRows,
  type SkillsLedgerRow,
  type SkillsLedgerStatus,
} from "../../migration/skills-ledger.js";
import {
  copySkillDirectory,
  type CopyResult,
} from "../../migration/skills-copier.js";
import { normalizeSkillFrontmatter } from "../../migration/skills-transformer.js";
import {
  verifySkillLinkages,
  type LinkVerification,
} from "../../migration/skills-linker-verifier.js";
import {
  readLearningsDir,
  dedupeLearnings,
} from "../../migration/skills-learnings-dedup.js";
import { writeSkillsMigrationReport } from "../../migration/skills-report-writer.js";
import { scanSkillsDirectory } from "../../skills/scanner.js";
import { loadConfig, resolveAllAgents } from "../../config/loader.js";
import { MemoryStore } from "../../memory/store.js";

/**
 * Default report path. Mirrors `.planning/milestones/v2.1-migration-report.md`
 * (Phase 82) — operator familiarity matters more than a custom path.
 */
export const DEFAULT_SKILLS_REPORT_PATH =
  ".planning/milestones/v2.2-skills-migration-report.md";

/**
 * Options for `runMigrateSkillsAction`. Exported for unit-test invocation
 * without going through Commander.
 */
export type MigrateSkillsOptions = {
  readonly sourceDir: string;
  readonly ledgerPath: string;
  readonly dryRun: boolean;
  readonly includeUnknown?: boolean;
  /**
   * Plan 02 — target directory for the actual copy on apply. Defaults to
   * `~/.clawcode/skills` when omitted. Tests supply a tmpdir.
   */
  readonly skillsTargetDir?: string;
  /**
   * Plan 02 — optional path to `clawcode.yaml`. When supplied AND apply
   * mode is active, the CLI runs a per-agent linker verification against
   * the freshly-migrated catalog and emits a `=== linker verification ===`
   * section.
   */
  readonly clawcodeYamlPath?: string;
  /**
   * Plan 02 — SKILL-08 scope gate: when true, bypass acme/personal
   * scope rules during linker verification. Default false.
   */
  readonly forceScope?: boolean;
  /**
   * Plan 02 — path to a MemoryStore SQLite database for
   * self-improving-agent `.learnings/*.md` import + dedup. When omitted,
   * learnings import is skipped (report still shows the skill as migrated).
   * Tests supply an ephemeral tmpdir path.
   */
  readonly memoryDbPath?: string;
  /**
   * Plan 03 — override the migration-report output path. Defaults to
   * `.planning/milestones/v2.2-skills-migration-report.md`. Dry-run
   * never writes a report (informational only). Tests override this to
   * a tmpdir location.
   */
  readonly reportPath?: string;
};

type Bucket =
  | "migrated"
  | "skipped (secret-scan)"
  | "skipped (deprecated)"
  | "skipped (idempotent)"
  | "skipped (copy-failed)"
  | "skipped (p2-out-of-scope)";

type BucketedEntry = {
  readonly skill: DiscoveredSkill;
  readonly bucket: Bucket;
  readonly line: string;
};

/**
 * Expand a `~/...` or `~` path to the user's home directory. Plain
 * implementation — no glob / alias support; skill discovery is not a
 * shell command line.
 */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Locked section order + header literal. Used by both the emitter and the
 * self-test. Tests grep for these exact strings.
 */
const SECTION_ORDER: readonly Bucket[] = [
  "migrated",
  "skipped (secret-scan)",
  "skipped (deprecated)",
  "skipped (idempotent)",
  "skipped (copy-failed)",
  "skipped (p2-out-of-scope)",
];

function headerFor(bucket: Bucket): string {
  return `=== ${bucket} ===`;
}

/**
 * Map a bucket to the `status` field on a ledger row. Mirrors the behavior
 * spec — secret-scan failures write "refused", deprecated/p2/idempotent
 * write "skipped", would-migrate writes "pending" (plan mode; apply is
 * Plan 02's territory and will upgrade to "migrated").
 */
function bucketToStatus(bucket: Bucket): SkillsLedgerStatus {
  switch (bucket) {
    case "migrated":
      return "pending";
    case "skipped (secret-scan)":
      return "refused";
    case "skipped (copy-failed)":
      return "refused";
    case "skipped (deprecated)":
    case "skipped (idempotent)":
    case "skipped (p2-out-of-scope)":
      return "skipped";
  }
}

/**
 * Map a bucket to the narrow `outcome` field (allow/refuse). Only
 * secret-scan refusals are `refuse`; everything else is `allow` (including
 * skips — they are a valid flow, not a rejection).
 */
function bucketToOutcome(bucket: Bucket): "allow" | "refuse" {
  if (bucket === "skipped (secret-scan)") return "refuse";
  if (bucket === "skipped (copy-failed)") return "refuse";
  return "allow";
}

/**
 * End-to-end action for `clawcode migrate openclaw skills`.
 *
 * Pure w.r.t. opts — no env-var reads. CLI Commander wiring is in
 * registerMigrateSkillsCommand below; it translates commander opts +
 * env vars into a MigrateSkillsOptions.
 */
export async function runMigrateSkillsAction(
  opts: MigrateSkillsOptions,
): Promise<number> {
  const sourceDir = expandHome(opts.sourceDir);
  const skillsTargetDir = opts.skillsTargetDir
    ? expandHome(opts.skillsTargetDir)
    : join(homedir(), ".clawcode", "skills");
  const reportPath = opts.reportPath
    ? expandHome(opts.reportPath)
    : DEFAULT_SKILLS_REPORT_PATH;

  // Plan 03 — capture the source-tree mtime BEFORE any read/classify work
  // begins so the invariant check at the end has a meaningful baseline. The
  // discovery layer doesn't modify the source (everything is read-only)
  // but fs-guard only throws on write — sampling BEFORE discovery catches
  // any hypothetical mtime drift caused by other actors during the run.
  const sourceMtimeBefore = await lstat(sourceDir)
    .then((st) => st.mtimeMs)
    .catch(() => null);

  // Wrap the entire action body in the fs-guard so any write attempt under
  // ~/.openclaw/ throws ReadOnlySourceError. uninstall in finally so a
  // subsequent CLI subcommand can legitimately write elsewhere.
  installFsGuard();
  try {
    const skills = await discoverOpenclawSkills(sourceDir);

    // Build the ledger index ONCE before the loop — capture the latest
    // "migrated" row per skill with its source_hash so idempotency is
    // snapshotted and the per-skill classify loop never re-reads the file.
    const ledgerRows = await readSkillRows(opts.ledgerPath).catch(() => []);
    const migratedHashBySkill = new Map<string, string>();
    for (const row of ledgerRows) {
      if (row.status === "migrated") {
        // Last-write-wins — later rows override earlier ones (append-only
        // ordering is the truth source).
        migratedHashBySkill.set(row.skill, row.source_hash);
      }
    }

    const entries: BucketedEntry[] = [];
    // Plan 02 — track successfully-migrated (or idempotent-skipped) skills
    // so the linker verification and the report know which names to expect
    // in the target catalog.
    const migratedSkillNames: string[] = [];

    // Lazily construct the MemoryStore the first time a learning-import
    // is attempted. Single handle for the entire apply run.
    let learningsMemoryStore: MemoryStore | null = null;

    for (const skill of skills) {
      let bucket: Bucket;
      let lineDetail = "";
      // Track apply-mode artifacts (copy result) for the ledger row.
      let copyResult: CopyResult | null = null;

      switch (skill.classification) {
        case "deprecate": {
          bucket = "skipped (deprecated)";
          const reason =
            SKILL_DEPRECATION_REASONS.get(skill.name) ??
            "deprecated per v2.2 verdict list";
          lineDetail = reason;
          break;
        }
        case "p2": {
          bucket = "skipped (p2-out-of-scope)";
          lineDetail = "P2 — out of v2.2 scope";
          break;
        }
        case "unknown": {
          if (opts.includeUnknown === true) {
            const result = await classifyP1(skill, migratedHashBySkill);
            bucket = result.bucket;
            lineDetail = result.detail;
          } else {
            bucket = "skipped (p2-out-of-scope)";
            lineDetail = "unknown classification";
          }
          break;
        }
        case "p1": {
          const result = await classifyP1(skill, migratedHashBySkill);
          bucket = result.bucket;
          lineDetail = result.detail;
          break;
        }
      }

      // Plan 02 apply path — when we're actually migrating (not dry-run)
      // AND classification put us in the "migrated" bucket, perform the
      // copy. Mismatches downgrade the bucket to "skipped (copy-failed)"
      // and write a refused ledger row.
      if (!opts.dryRun && bucket === "migrated") {
        const targetDir = join(skillsTargetDir, skill.name);
        copyResult = await copySkillDirectory(skill.path, targetDir, {
          transformSkillMd: (c) =>
            normalizeSkillFrontmatter(c, skill.name),
        });
        if (!copyResult.pass) {
          const mmCount = copyResult.mismatches?.length ?? 0;
          bucket = "skipped (copy-failed)";
          lineDetail = `hash-witness mismatch: ${mmCount} file(s)`;
        } else {
          // Decorate the line detail with the new target hash prefix.
          lineDetail =
            lineDetail === "ready to migrate"
              ? `copied → target_hash ${copyResult.targetHash.slice(0, 12)}…`
              : `${lineDetail}; target_hash ${copyResult.targetHash.slice(0, 12)}…`;
          migratedSkillNames.push(skill.name);
        }
      }

      // For idempotent-skipped P1 skills, still include them in the
      // linker-verification universe — they WERE previously migrated.
      if (bucket === "skipped (idempotent)") {
        migratedSkillNames.push(skill.name);
      }

      entries.push({
        skill,
        bucket,
        line: formatEntryLine(skill, bucket, lineDetail, opts.dryRun),
      });

      // Apply-mode ledger row. Dry-run writes nothing.
      if (!opts.dryRun) {
        const action: "plan" | "apply" =
          bucket === "migrated" || bucket === "skipped (copy-failed)"
            ? "apply"
            : "plan";
        const status: SkillsLedgerStatus =
          bucket === "migrated" ? "migrated" : bucketToStatus(bucket);
        const row: SkillsLedgerRow = {
          ts: new Date().toISOString(),
          action,
          skill: skill.name,
          status,
          source_hash: skill.sourceHash,
          ...(copyResult?.pass && copyResult.targetHash
            ? { target_hash: copyResult.targetHash }
            : {}),
          step: bucket === "migrated" ? "copy" : "classify",
          outcome: bucketToOutcome(bucket),
          notes: lineDetail || undefined,
        };
        await appendSkillRow(opts.ledgerPath, row);
      }

      // Plan 02 — learnings import hook (self-improving-agent only).
      if (
        !opts.dryRun &&
        bucket === "migrated" &&
        skill.name === "self-improving-agent" &&
        opts.memoryDbPath
      ) {
        if (learningsMemoryStore === null) {
          learningsMemoryStore = new MemoryStore(opts.memoryDbPath);
        }
        const learningsDir = join(skill.path, ".learnings");
        const learnings = await readLearningsDir(learningsDir);
        const { toImport, skipped } = await dedupeLearnings(
          learnings,
          learningsMemoryStore,
        );
        // Import each new entry with origin_id — hard idempotency via
        // Phase 80 MEM-02 UNIQUE(origin_id) partial index.
        const zeroEmbed = new Float32Array(384);
        for (const entry of toImport) {
          try {
            learningsMemoryStore.insert(
              {
                content: entry.content.trim(),
                source: "manual",
                importance: 0.5,
                tags: ["learning", "migrated-from-openclaw"],
                origin_id: `openclaw-learning-${entry.hash.slice(0, 16)}`,
              },
              zeroEmbed,
            );
          } catch {
            // origin_id collision or similar — non-fatal, continue.
          }
        }
        cliLog(
          dim(
            `  [learnings] imported=${toImport.length} skipped=${skipped.length} (${learningsDir})`,
          ),
        );
      }
    }

    // Group by bucket, preserve alphabetical order within each.
    const byBucket = new Map<Bucket, BucketedEntry[]>();
    for (const b of SECTION_ORDER) byBucket.set(b, []);
    for (const e of entries) byBucket.get(e.bucket)!.push(e);

    // Emit sections in locked order.
    for (const bucket of SECTION_ORDER) {
      cliLog(headerFor(bucket));
      const inBucket = byBucket.get(bucket)!;
      if (inBucket.length === 0) {
        cliLog(dim("(none)"));
      } else {
        for (const e of inBucket) cliLog(e.line);
      }
    }

    // Plan 02 — per-agent linker verification (apply mode only, when
    // clawcodeYamlPath is supplied). `allVerifications` captures the full
    // result set for Plan 03's report writer; `verificationFailures` is
    // the exit-code subset (missing-from-catalog / scope-refused).
    const verificationFailures: LinkVerification[] = [];
    let allVerifications: readonly LinkVerification[] = [];
    if (
      !opts.dryRun &&
      opts.clawcodeYamlPath &&
      existsSync(opts.clawcodeYamlPath)
    ) {
      try {
        const config = await loadConfig(opts.clawcodeYamlPath);
        const resolvedAgents = resolveAllAgents(config);
        const catalog = await scanSkillsDirectory(skillsTargetDir);
        const verifications = verifySkillLinkages({
          catalog,
          resolvedAgents,
          migratedSkillNames,
          force: opts.forceScope === true,
        });
        allVerifications = verifications;
        cliLog(headerFor("linker verification" as Bucket));
        if (verifications.length === 0) {
          cliLog(dim("(none)"));
        } else {
          for (const v of verifications) {
            const statusTxt =
              v.status === "linked"
                ? green(v.status)
                : v.status === "not-assigned"
                  ? dim(v.status)
                  : yellow(v.status);
            const reason = v.reason ? ` — ${v.reason}` : "";
            cliLog(`  ${v.agent}  ${v.skill}  ${statusTxt}${reason}`);
            if (
              v.status === "missing-from-catalog" ||
              v.status === "scope-refused"
            ) {
              verificationFailures.push(v);
            }
            // Append a ledger row per verification (verify step).
            await appendSkillRow(opts.ledgerPath, {
              ts: new Date().toISOString(),
              action: "verify",
              skill: v.skill,
              status: v.status === "linked" ? "migrated" : "refused",
              source_hash: "verify-only",
              step: "linker-verify",
              outcome: v.status === "linked" ? "allow" : "refuse",
              notes: `${v.agent}: ${v.status}${v.reason ? ` — ${v.reason}` : ""}`,
            });
          }
        }
      } catch (err) {
        cliError(
          `  linker verification failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Plan 03 — write the operator report. Dry-run is informational only
    // and MUST NOT write the report (test 20). Sample source mtime AFTER
    // everything else is done so the invariant reflects the end state.
    if (!opts.dryRun) {
      const sourceMtimeAfter = await lstat(sourceDir)
        .then((st) => st.mtimeMs)
        .catch(() => null);
      const sourceTreeReadonly =
        sourceMtimeBefore === null || sourceMtimeAfter === null
          ? "unchecked"
          : sourceMtimeBefore === sourceMtimeAfter
            ? "verified"
            : "mtime-changed";
      try {
        const written = await writeSkillsMigrationReport({
          reportPath,
          ledgerPath: opts.ledgerPath,
          discovered: skills,
          verifications: allVerifications,
          sourceTreeReadonly,
          generatedAt: new Date().toISOString(),
        });
        cliLog(green(`Report written: ${written}`));
      } catch (err) {
        cliError(
          `  report write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Exit code logic: dry-run always 0 (informational).
    // Apply mode: 1 if any secret-scan refusal OR copy-failed OR
    // missing-from-catalog verification failure, 0 otherwise.
    if (opts.dryRun) return 0;
    const refusals = byBucket.get("skipped (secret-scan)")!;
    const copyFails = byBucket.get("skipped (copy-failed)")!;
    const verifyMisses = verificationFailures.filter(
      (v) => v.status === "missing-from-catalog",
    );
    return refusals.length > 0 || copyFails.length > 0 || verifyMisses.length > 0
      ? 1
      : 0;
  } finally {
    uninstallFsGuard();
  }
}

/**
 * P1 classification flow — idempotency check first, then secret scan.
 * Returns the bucket + detail string for display.
 */
async function classifyP1(
  skill: DiscoveredSkill,
  migratedHashBySkill: ReadonlyMap<string, string>,
): Promise<{ bucket: Bucket; detail: string }> {
  // Idempotency: prior 'migrated' row + matching source_hash.
  const priorHash = migratedHashBySkill.get(skill.name);
  if (priorHash !== undefined && priorHash === skill.sourceHash) {
    return {
      bucket: "skipped (idempotent)",
      detail: `source_hash matches prior 'migrated' row (${priorHash.slice(0, 12)}…)`,
    };
  }

  const scan = await scanSkillSecrets(skill.path);
  if (!scan.pass) {
    const off = scan.offender!;
    // Format the file as repo-relative if we can — strip the skill path
    // prefix so the output is `SKILL.md:20` rather than
    // `/home/.../skills/acme-crm/SKILL.md:20`.
    const relFile = off.file.startsWith(skill.path + "/")
      ? off.file.slice(skill.path.length + 1)
      : off.file;
    return {
      bucket: "skipped (secret-scan)",
      detail: `${relFile}:${off.line} (${off.reason})`,
    };
  }

  return {
    bucket: "migrated",
    detail: priorHash === undefined ? "ready to migrate" : "source_hash changed — re-planned",
  };
}

/**
 * Format a single entry line. Color hints use the existing output.ts
 * helpers so NO_COLOR=1 gives plain text (load-bearing for deterministic
 * test output).
 */
function formatEntryLine(
  skill: DiscoveredSkill,
  bucket: Bucket,
  detail: string,
  _dryRun: boolean,
): string {
  void _dryRun;
  const name = skill.name;
  switch (bucket) {
    case "migrated":
      return `  ${green(name)} — ${detail}`;
    case "skipped (secret-scan)":
      return `  ${red(name)} — ${detail}`;
    case "skipped (copy-failed)":
      return `  ${red(name)} — ${detail}`;
    case "skipped (deprecated)":
      return `  ${dim(name)} — ${detail}`;
    case "skipped (idempotent)":
      return `  ${dim(name)} — ${detail}`;
    case "skipped (p2-out-of-scope)":
      return `  ${yellow(name)} — ${detail}`;
  }
}

/**
 * Commander wiring — attaches a `skills` subcommand to the existing
 * `migrate openclaw` parent tree. The parent is passed in by
 * migrate-openclaw.ts's registerMigrateOpenclawCommand.
 */
export function registerMigrateSkillsCommand(
  parentOpenclawCmd: Command,
): void {
  parentOpenclawCmd
    .command("skills")
    .description(
      "Migrate OpenClaw skills to ClawCode (dry-run default; use --no-dry-run to apply)",
    )
    .option(
      "--source-dir <path>",
      "OpenClaw skills source dir",
      "~/.openclaw/skills",
    )
    .option(
      "--ledger-path <path>",
      "Skills ledger JSONL path",
      DEFAULT_SKILLS_LEDGER_PATH,
    )
    .option("--dry-run", "Classify without writing the ledger (default)", true)
    .option(
      "--no-dry-run",
      "Apply — write ledger rows; refuse on secret-scan",
    )
    .option(
      "--include-unknown",
      "Treat unknown skills as P1 candidates (default: skip)",
    )
    .option(
      "--skills-target <path>",
      "Target directory for the copy on apply",
      "~/.clawcode/skills",
    )
    .option(
      "--clawcode-yaml <path>",
      "Path to clawcode.yaml (enables per-agent linker verification)",
      "clawcode.yaml",
    )
    .option(
      "--force-scope",
      "Bypass acme/personal scope gates during linker verification",
    )
    .option(
      "--memory-db <path>",
      "MemoryStore DB path for self-improving-agent .learnings import",
    )
    .option(
      "--report-path <path>",
      "Output path for the v2.2 skills migration report",
      DEFAULT_SKILLS_REPORT_PATH,
    )
    .action(
      async (opts: {
        sourceDir: string;
        ledgerPath: string;
        dryRun: boolean;
        includeUnknown?: boolean;
        skillsTarget?: string;
        clawcodeYaml?: string;
        forceScope?: boolean;
        memoryDb?: string;
        reportPath?: string;
      }) => {
        try {
          const ledgerPath =
            process.env.CLAWCODE_SKILLS_LEDGER_PATH ?? opts.ledgerPath;
          const code = await runMigrateSkillsAction({
            sourceDir: opts.sourceDir,
            ledgerPath,
            dryRun: opts.dryRun,
            includeUnknown: opts.includeUnknown,
            skillsTargetDir: opts.skillsTarget,
            clawcodeYamlPath: opts.clawcodeYaml,
            forceScope: opts.forceScope,
            memoryDbPath: opts.memoryDb,
            reportPath: opts.reportPath,
          });
          if (code !== 0) process.exit(code);
        } catch (err) {
          cliError(
            `Error: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }
      },
    );
}
