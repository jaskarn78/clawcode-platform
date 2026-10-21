/**
 * Phase 92 Plan 03 — Additive cutover-fix auto-applier (D-05 + D-07).
 *
 * Routes the 4 additive CutoverGap kinds to the appropriate primitive:
 *   - missing-skill         → secret-scan + normalize + rsync + Phase 86 updateAgentSkills
 *   - missing-memory-file   → Phase 91 rsync (workspace markdown copy)
 *   - missing-upload        → Phase 91 rsync (uploads/discord copy)
 *   - model-not-in-allowlist → Phase 86 updateAgentConfig({allowedModels: ...})
 *
 * `missing-mcp` (the 5th additive kind from Plan 92-02's union) is treated
 * as a deferred ledger entry: applying an MCP server requires operator-set
 * 1Password op:// refs which the auto-applier cannot synthesize. Plan 92-04
 * (or operator action via /clawcode-plugins-browse) handles credential
 * setup; this applier records the fact for the Plan 92-06 report.
 *
 * Per D-07, dry-run is the DEFAULT (apply: false → no writes, no ledger).
 * Destructive gaps are NEVER applied here — the union filter
 * `gap.severity === "additive"` is the safety floor; destructive count is
 * surfaced in the outcome for the operator (admin-clawdy embed handles
 * those in Plan 92-04).
 *
 * Idempotency via check-then-act: before applying each gap, re-read the
 * target state (clawcode.yaml or filesystem) and skip if the gap is
 * already fixed. Re-running apply after the first successful run produces
 * zero new ledger rows.
 *
 * All I/O primitives are dependency-injected via AdditiveApplierDeps so
 * tests pass vi.fn() stubs and production wires:
 *   - updateAgentSkills / updateAgentConfig from src/migration/yaml-writer.ts
 *   - scanSkillForSecrets from src/migration/skills-secret-scan.ts
 *   - normalizeSkillFrontmatter from src/migration/skills-transformer.ts
 *   - runRsync from src/sync/sync-runner.ts (RsyncRunner)
 *
 * Pinned invariants (see plan rules):
 *   - gap.severity === "additive" filter (destructive deferral)
 *   - scanSkillForSecrets called BEFORE runRsync for missing-skill
 *   - Phase 86 atomic YAML writers only (NEVER raw fs.writeFile clawcode.yaml)
 *   - Append-only ledger writes (one row per applied fix; idempotency-skipped
 *     gaps emit zero rows)
 *   - Immutability: nextSkills / nextAllowedModels are spread+sort copies
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import type { Logger } from "pino";

import {
  type CutoverGap,
  type CutoverLedgerRow,
  type AdditiveApplyOutcome,
} from "./types.js";
import { appendCutoverRow } from "./ledger.js";

// ---------------------------------------------------------------------------
// DI surface — production wires real Phase 84/86/91 primitives;
// tests pass vi.fn() stubs.
// ---------------------------------------------------------------------------

/** Result shape returned by Phase 86 atomic YAML writers (DI normalized). */
export type YamlWriteResult = {
  readonly kind: "updated" | "no-op" | "not-found" | "file-not-found" | "refused";
  readonly persisted?: boolean;
  readonly reason?: string;
};

/** Result shape returned by Phase 84 secret-scan (DI normalized). */
export type SecretScanResult = {
  readonly refused: boolean;
  readonly reason?: string;
};

/** Result shape returned by node:child_process.execFile rsync (DI normalized). */
export type RsyncResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export type AdditiveApplierDeps = {
  readonly agent: string;
  /** Already-parsed CUTOVER-GAPS.json contents. */
  readonly gaps: readonly CutoverGap[];
  /** false → dry-run (no writes, no ledger). */
  readonly apply: boolean;
  readonly clawcodeYamlPath: string;
  /** ~/.clawcode/skills/ — target of missing-skill rsync. */
  readonly skillsTargetDir: string;
  /** ~/.clawcode/agents/<agent>/ — target memory root. */
  readonly memoryRoot: string;
  /** <memoryRoot>/uploads/discord/ — target of missing-upload rsync. */
  readonly uploadsTargetDir: string;
  /** "example-user@10.0.0.3" — Phase 91 SSH host. */
  readonly openClawHost: string;
  /** "/home/example-user/.openclaw/workspace-acme" — Phase 91 source root. */
  readonly openClawWorkspace: string;
  /** "/home/example-user/.openclaw/skills" — Phase 84 skills source root. */
  readonly openClawSkillsRoot: string;
  /** Cutover ledger JSONL absolute path. */
  readonly ledgerPath: string;

  // DI hooks — Phase 86 / Phase 84 / Phase 91 primitives passed in for testability.
  readonly updateAgentSkills: (
    agent: string,
    nextSkills: readonly string[],
    opts: { clawcodeYamlPath: string },
  ) => Promise<YamlWriteResult>;
  readonly updateAgentConfig: (
    agent: string,
    patch: Readonly<Record<string, unknown>>,
    opts: { clawcodeYamlPath: string },
  ) => Promise<YamlWriteResult>;
  readonly scanSkillForSecrets: (skillDir: string) => Promise<SecretScanResult>;
  readonly normalizeSkillFrontmatter: (skillDir: string) => Promise<void>;
  readonly runRsync: (args: readonly string[]) => Promise<RsyncResult>;

  /** DI clock for deterministic ledger timestamps in tests. */
  readonly now?: () => Date;
  readonly log: Logger;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse the agent's current skills + allowedModels arrays out of the YAML
 * for idempotency check-then-act.
 *
 * Returns empty arrays on any read/parse failure — caller still attempts
 * the update via the Phase 86 atomic writer which has its own gates.
 */
async function readAgentArraysFromYaml(
  yamlPath: string,
  agent: string,
): Promise<{ skills: readonly string[]; allowedModels: readonly string[] }> {
  let text: string;
  try {
    text = await readFile(yamlPath, "utf8");
  } catch {
    return { skills: [], allowedModels: [] };
  }
  let js: unknown;
  try {
    const doc = parseDocument(text);
    js = doc.toJS();
  } catch {
    return { skills: [], allowedModels: [] };
  }
  const root = js as { agents?: unknown };
  if (!Array.isArray(root.agents)) return { skills: [], allowedModels: [] };
  const entry = (root.agents as Array<{ name?: string }>).find(
    (a) => typeof a === "object" && a !== null && a.name === agent,
  );
  if (!entry) return { skills: [], allowedModels: [] };
  const e = entry as { skills?: unknown; allowedModels?: unknown };
  const skills = Array.isArray(e.skills) ? (e.skills as unknown[]).map(String) : [];
  const allowedModels = Array.isArray(e.allowedModels)
    ? (e.allowedModels as unknown[]).map(String)
    : [];
  return { skills, allowedModels };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Build a normalized apply-additive ledger row. */
function makeAdditiveRow(args: {
  agent: string;
  kind: string;
  identifier: string;
  sourceHash: string | null;
  targetHash: string | null;
  now: Date;
  reason?: string | null;
}): CutoverLedgerRow {
  return {
    timestamp: args.now.toISOString(),
    agent: args.agent,
    action: "apply-additive",
    kind: args.kind,
    identifier: args.identifier,
    sourceHash: args.sourceHash,
    targetHash: args.targetHash,
    reversible: true,
    rolledBack: false,
    preChangeSnapshot: null,
    reason: args.reason ?? null,
  };
}

async function sha256OfFile(p: string): Promise<string | null> {
  try {
    const buf = await readFile(p);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Apply the 4 additive CutoverGap kinds. Destructive gaps are deferred to
 * Plan 92-04. Returns one terminal AdditiveApplyOutcome per invocation;
 * the ledger captures per-gap rows.
 */
export async function applyAdditiveFixes(
  deps: AdditiveApplierDeps,
): Promise<AdditiveApplyOutcome> {
  const start = (deps.now ?? (() => new Date()))();
  const startMs = start.getTime();

  // gap.severity === "additive" filter — destructive gaps NEVER applied here.
  const additive = deps.gaps.filter((g) => g.severity === "additive");
  const destructiveCount = deps.gaps.length - additive.length;

  // D-07 dry-run default: apply: false → zero side effects.
  if (!deps.apply) {
    return {
      kind: "dry-run",
      agent: deps.agent,
      plannedAdditive: additive.length,
      destructiveDeferred: destructiveCount,
    };
  }

  // Idempotency: read current YAML state once for check-then-act.
  const currentArrays = await readAgentArraysFromYaml(
    deps.clawcodeYamlPath,
    deps.agent,
  );
  // Local copies so we can update them as we apply gaps in this loop
  // (so two consecutive missing-skill gaps for different skills both succeed).
  let currentSkills: readonly string[] = currentArrays.skills;
  let currentAllowedModels: readonly string[] = currentArrays.allowedModels;

  let gapsApplied = 0;
  let gapsSkipped = 0;

  for (const gap of additive) {
    try {
      if (gap.kind === "missing-skill") {
        // Idempotency: skill already in YAML?
        if (currentSkills.includes(gap.identifier)) {
          gapsSkipped += 1;
          continue;
        }
        // Phase 84 secret-scan gate — BEFORE any copy.
        const sourceSkillDir = join(deps.openClawSkillsRoot, gap.identifier);
        const scan = await deps.scanSkillForSecrets(sourceSkillDir);
        if (scan.refused) {
          return {
            kind: "secret-scan-refused",
            agent: deps.agent,
            identifier: gap.identifier,
            reason: scan.reason ?? "secret detected",
          };
        }
        await deps.normalizeSkillFrontmatter(sourceSkillDir);

        // Phase 91 rsync — copy skill dir.
        const targetSkillDir = join(deps.skillsTargetDir, gap.identifier);
        const rsyncResult = await deps.runRsync([
          "-av",
          "--delete",
          "-e",
          "ssh -o BatchMode=yes -o ConnectTimeout=10",
          `${deps.openClawHost}:${sourceSkillDir}/`,
          `${targetSkillDir}/`,
        ]);
        if (rsyncResult.exitCode !== 0) {
          return {
            kind: "rsync-failed",
            agent: deps.agent,
            identifier: gap.identifier,
            error: rsyncResult.stderr.slice(0, 4000),
          };
        }

        // Phase 86 atomic YAML writer.
        const nextSkills = [...currentSkills, gap.identifier].sort();
        const updateRes = await deps.updateAgentSkills(deps.agent, nextSkills, {
          clawcodeYamlPath: deps.clawcodeYamlPath,
        });
        if (updateRes.kind !== "updated" && updateRes.kind !== "no-op") {
          return {
            kind: "yaml-write-failed",
            agent: deps.agent,
            identifier: gap.identifier,
            error: `updateAgentSkills returned ${updateRes.kind}${
              updateRes.reason ? ": " + updateRes.reason : ""
            }`,
          };
        }
        currentSkills = nextSkills;

        await appendCutoverRow(
          deps.ledgerPath,
          makeAdditiveRow({
            agent: deps.agent,
            kind: gap.kind,
            identifier: gap.identifier,
            sourceHash: null,
            targetHash: null,
            now: new Date(startMs),
          }),
          deps.log,
        );
        gapsApplied += 1;
      } else if (gap.kind === "missing-mcp") {
        // missing-mcp is additive but requires operator-set 1Password op:// refs.
        // Record a deferred-with-reason ledger row so Plan 92-06 report can
        // surface it; do NOT auto-mutate clawcode.yaml here.
        await appendCutoverRow(
          deps.ledgerPath,
          makeAdditiveRow({
            agent: deps.agent,
            kind: gap.kind,
            identifier: gap.identifier,
            sourceHash: null,
            targetHash: null,
            now: new Date(startMs),
            reason:
              "missing-mcp-needs-credentials — operator must add op:// refs in clawcode.yaml",
          }),
          deps.log,
        );
        gapsApplied += 1;
      } else if (gap.kind === "missing-memory-file") {
        const targetPath = join(deps.memoryRoot, gap.identifier);
        if (await pathExists(targetPath)) {
          gapsSkipped += 1;
          continue;
        }
        const sourcePath = join(deps.openClawWorkspace, gap.identifier);
        // Ensure parent dir exists locally for rsync target.
        const { mkdir } = await import("node:fs/promises");
        await mkdir(dirname(targetPath), { recursive: true });

        const rsyncResult = await deps.runRsync([
          "-av",
          "-e",
          "ssh -o BatchMode=yes -o ConnectTimeout=10",
          `${deps.openClawHost}:${sourcePath}`,
          targetPath,
        ]);
        if (rsyncResult.exitCode !== 0) {
          return {
            kind: "rsync-failed",
            agent: deps.agent,
            identifier: gap.identifier,
            error: rsyncResult.stderr.slice(0, 4000),
          };
        }
        const targetHash = await sha256OfFile(targetPath);
        await appendCutoverRow(
          deps.ledgerPath,
          makeAdditiveRow({
            agent: deps.agent,
            kind: gap.kind,
            identifier: gap.identifier,
            sourceHash: gap.sourceRef.sourceHash || null,
            targetHash,
            now: new Date(startMs),
          }),
          deps.log,
        );
        gapsApplied += 1;
      } else if (gap.kind === "missing-upload") {
        const targetPath = join(deps.uploadsTargetDir, gap.identifier);
        if (await pathExists(targetPath)) {
          gapsSkipped += 1;
          continue;
        }
        const sourcePath = join(
          deps.openClawWorkspace,
          "uploads",
          "discord",
          gap.identifier,
        );
        const { mkdir } = await import("node:fs/promises");
        await mkdir(dirname(targetPath), { recursive: true });

        const rsyncResult = await deps.runRsync([
          "-av",
          "-e",
          "ssh -o BatchMode=yes -o ConnectTimeout=10",
          `${deps.openClawHost}:${sourcePath}`,
          targetPath,
        ]);
        if (rsyncResult.exitCode !== 0) {
          return {
            kind: "rsync-failed",
            agent: deps.agent,
            identifier: gap.identifier,
            error: rsyncResult.stderr.slice(0, 4000),
          };
        }
        await appendCutoverRow(
          deps.ledgerPath,
          makeAdditiveRow({
            agent: deps.agent,
            kind: gap.kind,
            identifier: gap.identifier,
            sourceHash: null,
            targetHash: null,
            now: new Date(startMs),
          }),
          deps.log,
        );
        gapsApplied += 1;
      } else if (gap.kind === "model-not-in-allowlist") {
        if (currentAllowedModels.includes(gap.identifier)) {
          gapsSkipped += 1;
          continue;
        }
        // Immutability: spread + sort returns a new sorted array.
        const nextAllowed = [...currentAllowedModels, gap.identifier].sort();
        const updateRes = await deps.updateAgentConfig(
          deps.agent,
          { allowedModels: nextAllowed },
          { clawcodeYamlPath: deps.clawcodeYamlPath },
        );
        if (updateRes.kind !== "updated" && updateRes.kind !== "no-op") {
          return {
            kind: "yaml-write-failed",
            agent: deps.agent,
            identifier: gap.identifier,
            error: `updateAgentConfig returned ${updateRes.kind}${
              updateRes.reason ? ": " + updateRes.reason : ""
            }`,
          };
        }
        currentAllowedModels = nextAllowed;
        await appendCutoverRow(
          deps.ledgerPath,
          makeAdditiveRow({
            agent: deps.agent,
            kind: gap.kind,
            identifier: gap.identifier,
            sourceHash: null,
            targetHash: null,
            now: new Date(startMs),
          }),
          deps.log,
        );
        gapsApplied += 1;
      } else {
        // Unreachable for additive gaps — the destructive variants are filtered
        // out above. The cast preserves compile-time exhaustiveness without
        // assertNever (which would also fire for missing-mcp and the other
        // additive kinds because TS narrows after each `if`).
        const _exhaustive: never = gap as never;
        void _exhaustive;
      }
    } catch (err) {
      // Per plan rules: log + continue on per-gap errors. The exception is
      // secret-scan-refused, which short-circuits via the explicit return
      // inside the missing-skill branch above. yaml-write-failed and
      // rsync-failed also short-circuit via explicit returns.
      const message = err instanceof Error ? err.message : String(err);
      deps.log.warn(
        { gap: { kind: gap.kind, identifier: gap.identifier }, err: message },
        "cutover additive applier: per-gap error (continuing)",
      );
    }
  }

  return {
    kind: "applied",
    agent: deps.agent,
    gapsApplied,
    gapsSkipped,
    destructiveDeferred: destructiveCount,
    ledgerPath: deps.ledgerPath,
    durationMs: Date.now() - startMs,
  };
}
