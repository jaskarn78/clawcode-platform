/**
 * Phase 88 Plan 01 MKT-03 — single-skill installer.
 *
 * Wraps the Phase 84 migration pipeline (discover → classify → secret-
 * scan → copier+transformer → ledger) against ONE skill at a time, then
 * persists the installation to `clawcode.yaml` via the Phase 86-mirrored
 * `updateAgentSkills` writer. Returns a discriminated `SkillInstallOutcome`
 * so Plan 02's Discord slash command can render an ephemeral explanation
 * for every failure mode without a silent skip (MKT-05).
 *
 * Reuses — verbatim, no duplication:
 *   - scanSkillSecrets (skills-secret-scan.ts)            — HARD GATE
 *   - copySkillDirectory + normalizeSkillFrontmatter      — copy/transform
 *   - canLinkSkillToAgent + SCOPE_TAGS + scopeForAgent    — SKILL-08 scope
 *   - appendSkillRow + latestStatusBySkill                — ledger + idempotency
 *   - computeSkillContentHash                             — source hash
 *   - updateAgentSkills (yaml-writer.ts)                  — atomic YAML persist
 *   - SKILL_DEPRECATION_REASONS                           — deprecated gate
 *
 * Non-rollback on YAML persist failure: copy is the irreversible downstream
 * effect (the skill dir now lives under skillsTargetDir). Persistence to
 * clawcode.yaml affects next-boot skill resolution only. Mirrors Phase 86
 * Plan 02 MODEL-04 contract.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { rm, stat } from "node:fs/promises";
import { nanoid } from "nanoid";
import { readSkillRows, appendSkillRow } from "../migration/skills-ledger.js";
import type { SkillsLedgerRow } from "../migration/skills-ledger.js";
import { scanSkillSecrets } from "../migration/skills-secret-scan.js";
import { copySkillDirectory } from "../migration/skills-copier.js";
import { normalizeSkillFrontmatter } from "../migration/skills-transformer.js";
import {
  SCOPE_TAGS,
  canLinkSkillToAgent,
  scopeForAgent,
} from "../migration/skills-scope-tags.js";
import {
  SKILL_DEPRECATION_REASONS,
  computeSkillContentHash,
} from "../migration/skills-discovery.js";
import { updateAgentSkills } from "../migration/yaml-writer.js";
import {
  ClawhubAuthRequiredError,
  ClawhubRateLimitedError,
  downloadClawhubSkill,
} from "./clawhub-client.js";
import type { MarketplaceEntry } from "./catalog.js";

/**
 * Discriminated union of every outcome `installSingleSkill` can return.
 * Plan 02's Discord renderer branches on `.kind` — each variant carries
 * the fields needed to build the ephemeral explanation.
 *
 * Non-silent-skip invariant (MKT-05): every failure mode has a distinct
 * `kind`. Callers must never collapse two variants into a single message.
 */
export type SkillInstallOutcome =
  | {
      readonly kind: "installed";
      readonly skill: string;
      readonly targetPath: string;
      readonly targetHash: string;
    }
  | {
      readonly kind: "installed-persist-failed";
      readonly skill: string;
      readonly targetPath: string;
      readonly targetHash: string;
      readonly persist_error: string;
    }
  | {
      readonly kind: "already-installed";
      readonly skill: string;
      readonly reason: string;
    }
  | {
      readonly kind: "blocked-secret-scan";
      readonly skill: string;
      readonly offender: string;
    }
  | {
      readonly kind: "rejected-scope";
      readonly skill: string;
      readonly agent: string;
      readonly skillScope: "acme" | "personal" | "fleet";
      readonly agentScope: "acme" | "personal" | "fleet";
    }
  | {
      readonly kind: "rejected-deprecated";
      readonly skill: string;
      readonly reason: string;
    }
  | {
      readonly kind: "not-in-catalog";
      readonly skill: string;
    }
  | {
      readonly kind: "copy-failed";
      readonly skill: string;
      readonly reason: string;
    }
  // Phase 90 Plan 04 HUB-06 — ClawHub-specific failure modes.
  // auth-required: ClawHub registry returned 401/403. Operator must
  // re-authenticate (Plan 90-06 adds the GitHub OAuth device-code flow).
  | {
      readonly kind: "auth-required";
      readonly skill: string;
      readonly reason: string;
    }
  // rate-limited: ClawHub registry returned 429. retryAfterMs propagates
  // the Retry-After header (parsed) so the caller can display a
  // countdown and cache the negative window.
  | {
      readonly kind: "rate-limited";
      readonly skill: string;
      readonly retryAfterMs: number;
    }
  // manifest-invalid: the downloaded tarball failed extraction OR did
  // not contain a SKILL.md at its root. Distinct from copy-failed so the
  // UI can tell the operator the registry payload is broken (not the
  // local filesystem).
  | {
      readonly kind: "manifest-invalid";
      readonly skill: string;
      readonly reason: string;
    };

export type InstallSingleSkillOpts = Readonly<{
  /** Name key into `catalog` — must match an entry for install to proceed. */
  skillName: string;
  /** Agent receiving the skill; its `skills:` list gets the append. */
  agentName: string;
  /** Pre-loaded marketplace catalog (product of `loadMarketplaceCatalog`). */
  catalog: readonly MarketplaceEntry[];
  /** Absolute target root (e.g. `~/.clawcode/skills` expanded). */
  skillsTargetDir: string;
  /** Absolute path to clawcode.yaml. */
  clawcodeYamlPath: string;
  /** Absolute path to the skills migration ledger (JSONL). */
  ledgerPath: string;
  /** When true, bypasses the SKILL-08 scope-tag gate. Default false. */
  force?: boolean;
}>;

/**
 * Install one skill end-to-end. See module docstring + SkillInstallOutcome
 * for the contract. Returns a typed outcome; never throws except for
 * truly unrecoverable fs failures outside any gated branch (e.g. the
 * atomic rename in updateAgentSkills bubbling up a non-EACCES error).
 * Copy errors and persist errors are captured as outcome variants.
 */
export async function installSingleSkill(
  opts: InstallSingleSkillOpts,
): Promise<SkillInstallOutcome> {
  // --- Step 1: Catalog lookup ---------------------------------------
  const entry = opts.catalog.find((e) => e.name === opts.skillName);
  if (!entry) {
    return Object.freeze({
      kind: "not-in-catalog" as const,
      skill: opts.skillName,
    });
  }

  // --- Phase 90 Plan 04 HUB-03 — dispatch on source.kind ------------
  // ClawHub entries need a pre-pipeline download + extract into a
  // staging dir; once the extracted skill is on disk the rest of the
  // flow (secret-scan → normalize → scope → copy → persist → ledger)
  // matches the Phase 84 + Phase 88 pipeline verbatim.
  if (
    typeof entry.source === "object" &&
    entry.source !== null &&
    "kind" in entry.source &&
    entry.source.kind === "clawhub"
  ) {
    return await installClawhubSkill({
      entry,
      agentName: opts.agentName,
      skillsTargetDir: opts.skillsTargetDir,
      clawcodeYamlPath: opts.clawcodeYamlPath,
      ledgerPath: opts.ledgerPath,
      force: opts.force ?? false,
    });
  }

  // --- Step 2: Deprecated gate (hard refuse) ------------------------
  const deprecationReason = SKILL_DEPRECATION_REASONS.get(entry.name);
  if (deprecationReason !== undefined || entry.classification === "deprecate") {
    return Object.freeze({
      kind: "rejected-deprecated" as const,
      skill: entry.name,
      reason:
        deprecationReason ??
        "deprecated per v2.2 verdict list; not allowed in marketplace install",
    });
  }

  // --- Step 3: Scope gate (SKILL-08) --------------------------------
  const force = opts.force === true;
  if (!canLinkSkillToAgent(entry.name, opts.agentName, { force })) {
    const skillScope = SCOPE_TAGS.get(entry.name) ?? "fleet";
    const agentScope = scopeForAgent(opts.agentName);
    // Ledger row — refused for audit parity with the Phase 84 CLI pipeline.
    await appendLedgerSafe(opts.ledgerPath, {
      ts: new Date().toISOString(),
      action: "apply",
      skill: entry.name,
      status: "refused",
      source_hash: "scope-gate",
      step: "scope-check",
      outcome: "refuse",
      notes: `scope: ${skillScope} vs ${agentScope}`,
    });
    return Object.freeze({
      kind: "rejected-scope" as const,
      skill: entry.name,
      agent: opts.agentName,
      skillScope,
      agentScope,
    });
  }

  // --- Step 4: Ledger idempotency gate ------------------------------
  // Compute the current source hash so we can compare against the latest
  // "migrated" ledger row for this skill. Matching hash → already-installed;
  // stale hash → re-install path proceeds.
  const currentHash = await computeSkillContentHash(entry.skillDir);
  const ledgerRows = await readSkillRowsSafe(opts.ledgerPath);
  // Last-write-wins semantics for the per-skill row. Scan in append order
  // and let later rows override earlier ones (matches Phase 84 latestStatus-
  // BySkill behavior without needing a second pass).
  let latestMigratedHash: string | null = null;
  for (const row of ledgerRows) {
    if (row.skill !== entry.name) continue;
    if (row.status === "migrated" && row.action === "apply") {
      latestMigratedHash = row.source_hash;
    }
  }
  if (latestMigratedHash === currentHash) {
    return Object.freeze({
      kind: "already-installed" as const,
      skill: entry.name,
      reason: `ledger shows migrated at source_hash ${currentHash.slice(0, 12)}...`,
    });
  }

  // --- Step 5: Secret-scan HARD GATE --------------------------------
  const scanResult = await scanSkillSecrets(entry.skillDir);
  if (!scanResult.pass) {
    const offender = scanResult.offender;
    const offenderDesc = offender
      ? `${offender.file}:${offender.line} (${offender.reason})`
      : "unknown offender";
    await appendLedgerSafe(opts.ledgerPath, {
      ts: new Date().toISOString(),
      action: "apply",
      skill: entry.name,
      status: "refused",
      source_hash: currentHash,
      step: "secret-scan",
      outcome: "refuse",
      notes: offender
        ? `${offender.reason}: ${offender.file}:${offender.line}`
        : "secret-scan refused",
    });
    return Object.freeze({
      kind: "blocked-secret-scan" as const,
      skill: entry.name,
      offender: offenderDesc,
    });
  }

  // --- Step 6: Copy + transform ------------------------------------
  // NOTE: fs-guard installFsGuard/uninstallFsGuard is a CLI-level concern
  // (the Phase 84 migrate-skills CLI wraps its top-level action body).
  // The marketplace install path is invoked from a running daemon where
  // writing to ~/.openclaw/ is NOT a risk — the installer only writes to
  // skillsTargetDir and clawcodeYamlPath. Keeping the guard here would
  // require the daemon to briefly surrender fs writes, which could
  // cascade into unrelated in-flight daemon tasks. Skipping the guard is
  // the correct choice; the source tree is read-only by the copier
  // contract (`cp` reads only).
  const targetPath = join(opts.skillsTargetDir, entry.name);
  const copyResult = await copySkillDirectory(entry.skillDir, targetPath, {
    transformSkillMd: (c) => normalizeSkillFrontmatter(c, entry.name),
  });
  if (!copyResult.pass) {
    const mmCount = copyResult.mismatches?.length ?? 0;
    const reason = `hash-witness mismatch: ${mmCount} file(s)`;
    await appendLedgerSafe(opts.ledgerPath, {
      ts: new Date().toISOString(),
      action: "apply",
      skill: entry.name,
      status: "refused",
      source_hash: currentHash,
      step: "copy",
      outcome: "refuse",
      notes: reason,
    });
    return Object.freeze({
      kind: "copy-failed" as const,
      skill: entry.name,
      reason,
    });
  }

  // --- Step 7: Persist to clawcode.yaml (non-rollback on failure) --
  let persisted = false;
  let persistError: string | null = null;
  try {
    const persistResult = await updateAgentSkills({
      existingConfigPath: opts.clawcodeYamlPath,
      agentName: opts.agentName,
      skillName: entry.name,
      op: "add",
    });
    if (
      persistResult.outcome === "updated" ||
      persistResult.outcome === "no-op"
    ) {
      persisted = true;
    } else {
      persistError = persistResult.reason;
    }
  } catch (err) {
    persistError = err instanceof Error ? err.message : String(err);
    // Deliberately do NOT re-throw — copy succeeded, persistence is
    // next-boot durability only. Mirrors Phase 86 Plan 02 MODEL-04.
  }

  // --- Step 8: Ledger success row -----------------------------------
  await appendLedgerSafe(opts.ledgerPath, {
    ts: new Date().toISOString(),
    action: "apply",
    skill: entry.name,
    status: "migrated",
    source_hash: currentHash,
    target_hash: copyResult.targetHash,
    step: "copy+persist",
    outcome: "allow",
    notes: `persisted=${persisted}${persistError ? `; ${persistError}` : ""}`,
  });

  // --- Step 9: Return typed outcome ---------------------------------
  if (persisted) {
    return Object.freeze({
      kind: "installed" as const,
      skill: entry.name,
      targetPath,
      targetHash: copyResult.targetHash,
    });
  }
  return Object.freeze({
    kind: "installed-persist-failed" as const,
    skill: entry.name,
    targetPath,
    targetHash: copyResult.targetHash,
    persist_error: persistError ?? "unknown persist failure",
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * `readSkillRows` throws when the ledger has malformed JSON. Installer
 * must not propagate that — a corrupt ledger is an operator issue, not a
 * reason to refuse every subsequent install. Fall back to `[]` on read
 * failure (caller gets the re-install path, and the append below will
 * still write the new row).
 */
async function readSkillRowsSafe(
  ledgerPath: string,
): Promise<readonly SkillsLedgerRow[]> {
  try {
    return await readSkillRows(ledgerPath);
  } catch {
    return [];
  }
}

/**
 * Ledger append with best-effort semantics — the installer should never
 * throw because the ledger file is temporarily write-locked. Log-and-
 * swallow keeps the install outcome truthful to the actual state (copy
 * + YAML persist have already happened when the success-row append
 * fires).
 */
async function appendLedgerSafe(
  ledgerPath: string,
  row: SkillsLedgerRow,
): Promise<void> {
  try {
    await appendSkillRow(ledgerPath, row);
  } catch {
    // Best effort — installer outcome is authoritative regardless of ledger.
  }
}

// ---------------------------------------------------------------------------
// Phase 90 Plan 04 HUB-03 — ClawHub installer
// ---------------------------------------------------------------------------

/**
 * Staging root for all ClawHub downloads. One nanoid'd subdir per install
 * attempt — cleaned in finally regardless of outcome (D-07). ~/.clawcode
 * keeps staging off the agent workspace root so a partial extraction can
 * never pollute an active agent.
 */
const CLAWHUB_STAGING_ROOT = join(homedir(), ".clawcode", "manager", "clawhub-staging");

/**
 * Install a ClawHub-sourced skill. Entry's `source.kind === "clawhub"`
 * is the caller's invariant.
 *
 * Pipeline (matches Phase 84 CLI flow + Phase 88 marketplace install):
 *   1. Stage — download + extract tarball into
 *      `~/.clawcode/manager/clawhub-staging/<nanoid>/extracted`.
 *   2. Manifest check — refuse if SKILL.md missing (manifest-invalid).
 *   3. Secret-scan — refuse if any high-entropy credential-context
 *      token detected (blocked-secret-scan).
 *   4. Scope gate — refuse if the skill's inferred scope ≠ agent scope
 *      (rejected-scope), honoring force override.
 *   5. Frontmatter normalize — ensure SKILL.md has name+description.
 *   6. Content hash — check ledger for matching prior migration
 *      (already-installed on hit).
 *   7. Copy — hash-witnessed transfer into skillsTargetDir/<name>/.
 *   8. YAML persist — atomic updateAgentSkills op:"add".
 *   9. Ledger success row.
 *  10. Cleanup — staging dir rm'd in try/finally (D-07).
 *
 * Error mapping (HUB-INS-2/3/4):
 *   - ClawhubRateLimitedError   → { kind:"rate-limited", retryAfterMs }
 *   - ClawhubAuthRequiredError  → { kind:"auth-required", reason }
 *   - missing SKILL.md          → { kind:"manifest-invalid", reason }
 *   - other download errors     → { kind:"copy-failed", reason } (caller
 *                                  renders as generic install failure)
 */
async function installClawhubSkill(
  args: Readonly<{
    entry: MarketplaceEntry;
    agentName: string;
    skillsTargetDir: string;
    clawcodeYamlPath: string;
    ledgerPath: string;
    force: boolean;
  }>,
): Promise<SkillInstallOutcome> {
  // Narrow to the ClawHub source variant — caller's responsibility but
  // we guard defensively so a misrouted call still returns a typed
  // outcome instead of a null-deref.
  const src = args.entry.source;
  if (
    typeof src !== "object" ||
    src === null ||
    !("kind" in src) ||
    src.kind !== "clawhub"
  ) {
    return Object.freeze({
      kind: "copy-failed" as const,
      skill: args.entry.name,
      reason: "installClawhubSkill called with non-ClawHub source",
    });
  }

  const stagingDir = join(CLAWHUB_STAGING_ROOT, nanoid());
  try {
    // --- Step 1: download + extract ---
    let extracted;
    try {
      extracted = await downloadClawhubSkill({
        downloadUrl: src.downloadUrl,
        stagingDir,
        ...(src.authToken !== undefined ? { authToken: src.authToken } : {}),
      });
    } catch (err) {
      if (err instanceof ClawhubRateLimitedError) {
        return Object.freeze({
          kind: "rate-limited" as const,
          skill: args.entry.name,
          retryAfterMs: err.retryAfterMs,
        });
      }
      if (err instanceof ClawhubAuthRequiredError) {
        return Object.freeze({
          kind: "auth-required" as const,
          skill: args.entry.name,
          reason: err.message,
        });
      }
      // Other errors surfaced via downloadClawhubSkill (malformed tar,
      // network failure) → copy-failed so the UI degrades gracefully.
      return Object.freeze({
        kind: "copy-failed" as const,
        skill: args.entry.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    // --- Step 2: manifest validation — SKILL.md MUST exist ---
    const skillMdPath = join(extracted.extractedDir, "SKILL.md");
    try {
      const s = await stat(skillMdPath);
      if (!s.isFile()) throw new Error("SKILL.md is not a regular file");
    } catch {
      return Object.freeze({
        kind: "manifest-invalid" as const,
        skill: args.entry.name,
        reason: "SKILL.md missing from archive root",
      });
    }

    // --- Step 3: secret-scan HARD GATE ---
    const scan = await scanSkillSecrets(extracted.extractedDir);
    if (!scan.pass) {
      const offender = scan.offender;
      const offenderDesc = offender
        ? `${offender.file}:${offender.line} (${offender.reason})`
        : "unknown offender";
      await appendLedgerSafe(args.ledgerPath, {
        ts: new Date().toISOString(),
        action: "apply",
        skill: args.entry.name,
        status: "refused",
        source_hash: "clawhub-staged",
        step: "secret-scan",
        outcome: "refuse",
        notes: offender
          ? `${offender.reason}: ${offender.file}:${offender.line}`
          : "secret-scan refused",
      });
      return Object.freeze({
        kind: "blocked-secret-scan" as const,
        skill: args.entry.name,
        offender: offenderDesc,
      });
    }

    // --- Step 4: scope gate --------------------------------------
    if (!canLinkSkillToAgent(args.entry.name, args.agentName, { force: args.force })) {
      const skillScope = SCOPE_TAGS.get(args.entry.name) ?? "fleet";
      const agentScope = scopeForAgent(args.agentName);
      await appendLedgerSafe(args.ledgerPath, {
        ts: new Date().toISOString(),
        action: "apply",
        skill: args.entry.name,
        status: "refused",
        source_hash: "scope-gate",
        step: "scope-check",
        outcome: "refuse",
        notes: `scope: ${skillScope} vs ${agentScope}`,
      });
      return Object.freeze({
        kind: "rejected-scope" as const,
        skill: args.entry.name,
        agent: args.agentName,
        skillScope,
        agentScope,
      });
    }

    // --- Step 5: frontmatter normalize ---------------------------
    // normalizeSkillFrontmatter operates on SKILL.md content, not a
    // path; the copier pipes content through transformSkillMd below,
    // which handles the same pathway. No action needed here — the
    // Phase 84 pipeline's copier already calls the transformer.

    // --- Step 6: ledger idempotency gate -------------------------
    const currentHash = await computeSkillContentHash(extracted.extractedDir);
    const ledgerRows = await readSkillRowsSafe(args.ledgerPath);
    let latestMigratedHash: string | null = null;
    for (const row of ledgerRows) {
      if (row.skill !== args.entry.name) continue;
      if (row.status === "migrated" && row.action === "apply") {
        latestMigratedHash = row.source_hash;
      }
    }
    if (latestMigratedHash === currentHash) {
      return Object.freeze({
        kind: "already-installed" as const,
        skill: args.entry.name,
        reason: `ledger shows migrated at source_hash ${currentHash.slice(0, 12)}...`,
      });
    }

    // --- Step 7: copy + transform --------------------------------
    const targetPath = join(args.skillsTargetDir, args.entry.name);
    const copyResult = await copySkillDirectory(
      extracted.extractedDir,
      targetPath,
      {
        transformSkillMd: (c) =>
          normalizeSkillFrontmatter(c, args.entry.name),
      },
    );
    if (!copyResult.pass) {
      const mmCount = copyResult.mismatches?.length ?? 0;
      const reason = `hash-witness mismatch: ${mmCount} file(s)`;
      await appendLedgerSafe(args.ledgerPath, {
        ts: new Date().toISOString(),
        action: "apply",
        skill: args.entry.name,
        status: "refused",
        source_hash: currentHash,
        step: "copy",
        outcome: "refuse",
        notes: reason,
      });
      return Object.freeze({
        kind: "copy-failed" as const,
        skill: args.entry.name,
        reason,
      });
    }

    // --- Step 8: YAML persist (non-rollback on failure) ----------
    let persisted = false;
    let persistError: string | null = null;
    try {
      const persistResult = await updateAgentSkills({
        existingConfigPath: args.clawcodeYamlPath,
        agentName: args.agentName,
        skillName: args.entry.name,
        op: "add",
      });
      if (
        persistResult.outcome === "updated" ||
        persistResult.outcome === "no-op"
      ) {
        persisted = true;
      } else {
        persistError = persistResult.reason;
      }
    } catch (err) {
      persistError = err instanceof Error ? err.message : String(err);
    }

    // --- Step 9: ledger success row ------------------------------
    await appendLedgerSafe(args.ledgerPath, {
      ts: new Date().toISOString(),
      action: "apply",
      skill: args.entry.name,
      status: "migrated",
      source_hash: currentHash,
      target_hash: copyResult.targetHash,
      step: "copy+persist",
      outcome: "allow",
      notes: `persisted=${persisted} (clawhub)${persistError ? `; ${persistError}` : ""}`,
    });

    if (persisted) {
      return Object.freeze({
        kind: "installed" as const,
        skill: args.entry.name,
        targetPath,
        targetHash: copyResult.targetHash,
      });
    }
    return Object.freeze({
      kind: "installed-persist-failed" as const,
      skill: args.entry.name,
      targetPath,
      targetHash: copyResult.targetHash,
      persist_error: persistError ?? "unknown persist failure",
    });
  } finally {
    // D-07 — cleanup staging regardless of outcome. Best effort; the
    // installer's return value is authoritative even if cleanup fails.
    try {
      await rm(stagingDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
