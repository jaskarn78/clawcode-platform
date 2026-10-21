/**
 * Phase 92 Plan 06 GAP CLOSURE — LIFO ledger rewind engine (CUT-10 + D-10).
 *
 * Pure-fn-with-DI rollback orchestrator consumed by the daemon's
 * `cutover-rollback` IPC handler. Reads `cutover-ledger.jsonl`, filters
 * rows that match (a) the requested agent, (b) timestamp newer than
 * `ledgerTo`, and (c) are not already rolled back via the
 * `rollback-of:<origTimestamp>` reason marker. Reverses each in LIFO
 * order — newest applied first — and appends a NEW rollback row per
 * successful revert (append-only invariant preserved).
 *
 * Reverse semantics per CutoverLedgerRow.kind:
 *
 *   ADDITIVE (action="apply-additive"):
 *     - missing-memory-file       → unlink target file at memoryRoot/<id>
 *     - missing-upload            → unlink target file at uploadsTargetDir/<id>
 *     - missing-skill             → remove from agents[*].skills via Phase 86
 *                                   atomic writer (skill dir intentionally
 *                                   left in place; operator can delete it)
 *     - model-not-in-allowlist    → remove from agents[*].allowedModels via
 *                                   Phase 86 atomic writer
 *     - missing-mcp               → audit-only (no auto-mutation on apply →
 *                                   no auto-mutation on rollback either)
 *     - mcp-credential-drift,
 *       tool-permission-gap,
 *       cron-session-not-mirrored → audit-only (same as apply path)
 *
 *   DESTRUCTIVE (action="apply-destructive"):
 *     - outdated-memory-file with preChangeSnapshot (≤64KB) → restore via
 *                                   gunzip+base64 decode, write file atomically
 *     - outdated-memory-file w/o snapshot (>64KB or pre-existing missing) →
 *                                   record rollback-skipped audit row
 *     - mcp-credential-drift,
 *       tool-permission-gap,
 *       cron-session-not-mirrored → audit-only revert row (apply was audit-only)
 *
 * The dryRun flag short-circuits BEFORE every mutation but still produces an
 * accurate `rewoundCount` (the count reflects rows that WOULD be rewound).
 *
 * Idempotency: each iteration checks `rolledBack: true` on the source row OR
 * any prior rollback row whose reason starts with
 * `ROLLBACK_OF_REASON_PREFIX + sourceRow.timestamp`. Re-running rollback over
 * already-reverted rows yields zero new reverts.
 */
import { gunzipSync } from "node:zlib";
import { unlink, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "pino";

import {
  type CutoverLedgerRow,
} from "./types.js";
import { appendCutoverRow, readCutoverRows } from "./ledger.js";

/**
 * Idempotency reason marker — every rollback row's `reason` field begins
 * with this literal string followed by the original row's timestamp.
 * Mirrors `ROLLBACK_OF_REASON_PREFIX` in cutover-rollback.ts (CLI scaffold).
 */
export const ROLLBACK_OF_REASON_PREFIX = "rollback-of:";

/** Single-row error surfaced to the operator when a revert fails mid-LIFO. */
export type RollbackErrorEntry = {
  readonly row: number;
  readonly originalTimestamp: string;
  readonly originalKind: string;
  readonly originalIdentifier: string;
  readonly error: string;
};

/** Result of one rollback invocation. */
export type RollbackEngineResult = {
  readonly rewoundCount: number;
  readonly skippedAlreadyRewound: number;
  readonly skippedIrreversible: number;
  readonly errors: readonly RollbackErrorEntry[];
};

/**
 * Result of a Phase 86 atomic YAML writer call. Re-declared here to keep
 * this module decoupled from additive-applier.ts (the rollback engine
 * imports the writer adapter via DI).
 */
export type YamlWriteOutcome = {
  readonly kind: "updated" | "no-op" | "not-found" | "file-not-found" | "refused";
  readonly reason?: string;
};

export type RollbackEngineDeps = {
  readonly agent: string;
  readonly ledgerTo: string; // ISO 8601
  readonly ledgerPath: string;
  readonly clawcodeYamlPath: string;
  readonly memoryRoot: string;
  readonly uploadsTargetDir: string;
  readonly skillsTargetDir: string;
  readonly dryRun: boolean;
  /**
   * Phase 86 atomic skill-array writer. Production wires the per-skill
   * add/remove adapter (see cutover-apply-additive.ts mapYamlOutcome).
   */
  readonly removeAgentSkill: (
    agent: string,
    skillName: string,
    opts: { clawcodeYamlPath: string },
  ) => Promise<YamlWriteOutcome>;
  /**
   * Remove ONE entry from agents[*].allowedModels. Production wires a
   * read-current + filter + updateAgentConfig({allowedModels: filtered})
   * adapter. Tests inject a vi.fn() returning the YamlWriteOutcome union.
   */
  readonly removeAgentAllowedModel: (
    agent: string,
    model: string,
    opts: { clawcodeYamlPath: string },
  ) => Promise<YamlWriteOutcome>;
  /** Filesystem unlink — DI'd for tests. Default: node:fs/promises unlink. */
  readonly unlinkFile?: (path: string) => Promise<void>;
  /** Filesystem write — DI'd for tests. Default: writeFile + mkdir. */
  readonly writeFileAtomic?: (path: string, data: Buffer) => Promise<void>;
  readonly now?: () => Date;
  readonly log: Logger;
};

/**
 * Default atomic writer — mkdir parents + writeFile. Used by destructive
 * snapshot restore. Not a temp+rename because the caller is itself the
 * authoritative writer (the original file is being OVERWRITTEN with the
 * pre-apply snapshot — a partial write would be the same kind of damage
 * the apply itself caused).
 */
async function defaultWriteFileAtomic(
  path: string,
  data: Buffer,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

/**
 * Build a rollback ledger row that audit-trails one revert.
 */
function makeRollbackRow(args: {
  agent: string;
  source: CutoverLedgerRow;
  now: Date;
  reversible: boolean;
  reason: string;
}): CutoverLedgerRow {
  return {
    timestamp: args.now.toISOString(),
    agent: args.agent,
    action: "rollback",
    kind: args.source.kind,
    identifier: args.source.identifier,
    sourceHash: args.source.sourceHash,
    targetHash: args.source.targetHash,
    reversible: args.reversible,
    rolledBack: false, // the rollback row itself isn't a candidate for further rollback
    preChangeSnapshot: null,
    reason: `${ROLLBACK_OF_REASON_PREFIX}${args.source.timestamp}; ${args.reason}`,
  };
}

/**
 * Check if the ledger already contains a rollback row pointing at `sourceRow`.
 * Idempotency check — re-running rollback yields zero new reverts.
 */
function isAlreadyRewound(
  rows: readonly CutoverLedgerRow[],
  sourceRow: CutoverLedgerRow,
): boolean {
  if (sourceRow.rolledBack) return true;
  const marker = `${ROLLBACK_OF_REASON_PREFIX}${sourceRow.timestamp}`;
  for (const r of rows) {
    if (r.action !== "rollback") continue;
    if (r.reason && r.reason.includes(marker)) return true;
  }
  return false;
}

/**
 * Reverse one ledger row. Returns the rollback row to append (caller writes
 * it via appendCutoverRow if !dryRun) plus any operator-visible error.
 *
 * The function is intentionally side-effect-light: it performs exactly the
 * filesystem / YAML mutation the row's kind requires, then returns the new
 * audit row for the caller to append.
 */
async function reverseOneRow(
  deps: RollbackEngineDeps,
  source: CutoverLedgerRow,
): Promise<{ row: CutoverLedgerRow; error: string | null }> {
  const now = (deps.now ?? (() => new Date()))();
  const unlinkFn = deps.unlinkFile ?? unlink;
  const writeFn = deps.writeFileAtomic ?? defaultWriteFileAtomic;

  // ----- Additive reverts -----------------------------------------------
  if (source.action === "apply-additive") {
    if (source.kind === "missing-memory-file") {
      const target = join(deps.memoryRoot, source.identifier);
      if (!deps.dryRun) {
        try {
          await unlinkFn(target);
        } catch (err) {
          return {
            row: makeRollbackRow({
              agent: deps.agent,
              source,
              now,
              reversible: false,
              reason: `unlink-failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            }),
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
      return {
        row: makeRollbackRow({
          agent: deps.agent,
          source,
          now,
          reversible: true,
          reason: `unlinked target file ${target}`,
        }),
        error: null,
      };
    }

    if (source.kind === "missing-upload") {
      const target = join(deps.uploadsTargetDir, source.identifier);
      if (!deps.dryRun) {
        try {
          await unlinkFn(target);
        } catch (err) {
          return {
            row: makeRollbackRow({
              agent: deps.agent,
              source,
              now,
              reversible: false,
              reason: `unlink-failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            }),
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
      return {
        row: makeRollbackRow({
          agent: deps.agent,
          source,
          now,
          reversible: true,
          reason: `unlinked upload ${target}`,
        }),
        error: null,
      };
    }

    if (source.kind === "missing-skill") {
      if (!deps.dryRun) {
        const r = await deps.removeAgentSkill(deps.agent, source.identifier, {
          clawcodeYamlPath: deps.clawcodeYamlPath,
        });
        if (r.kind !== "updated" && r.kind !== "no-op") {
          return {
            row: makeRollbackRow({
              agent: deps.agent,
              source,
              now,
              reversible: false,
              reason: `removeAgentSkill: ${r.kind}${
                r.reason ? `: ${r.reason}` : ""
              }`,
            }),
            error: `removeAgentSkill returned ${r.kind}`,
          };
        }
      }
      return {
        row: makeRollbackRow({
          agent: deps.agent,
          source,
          now,
          reversible: true,
          reason: `removed skill from agents[${deps.agent}].skills (skill dir left in place)`,
        }),
        error: null,
      };
    }

    if (source.kind === "model-not-in-allowlist") {
      if (!deps.dryRun) {
        const r = await deps.removeAgentAllowedModel(
          deps.agent,
          source.identifier,
          { clawcodeYamlPath: deps.clawcodeYamlPath },
        );
        if (r.kind !== "updated" && r.kind !== "no-op") {
          return {
            row: makeRollbackRow({
              agent: deps.agent,
              source,
              now,
              reversible: false,
              reason: `removeAgentAllowedModel: ${r.kind}${
                r.reason ? `: ${r.reason}` : ""
              }`,
            }),
            error: `removeAgentAllowedModel returned ${r.kind}`,
          };
        }
      }
      return {
        row: makeRollbackRow({
          agent: deps.agent,
          source,
          now,
          reversible: true,
          reason: `removed model from agents[${deps.agent}].allowedModels`,
        }),
        error: null,
      };
    }

    // missing-mcp / audit-only kinds — no apply mutation to reverse.
    return {
      row: makeRollbackRow({
        agent: deps.agent,
        source,
        now,
        reversible: false,
        reason: `audit-only: source apply was audit-only (kind=${source.kind})`,
      }),
      error: null,
    };
  }

  // ----- Destructive reverts --------------------------------------------
  if (source.action === "apply-destructive") {
    if (source.kind === "outdated-memory-file") {
      if (source.preChangeSnapshot === null || !source.reversible) {
        // Apply was an irreversible >64KB or the file did not exist pre-apply.
        // We cannot programmatically restore — emit audit row with
        // rollback-skipped reason so the operator sees it in the ledger.
        return {
          row: makeRollbackRow({
            agent: deps.agent,
            source,
            now,
            reversible: false,
            reason: "rollback-skipped-irreversible: no preChangeSnapshot",
          }),
          error: null,
        };
      }
      const target = join(deps.memoryRoot, source.identifier);
      if (!deps.dryRun) {
        try {
          const buf = gunzipSync(Buffer.from(source.preChangeSnapshot, "base64"));
          await writeFn(target, buf);
        } catch (err) {
          return {
            row: makeRollbackRow({
              agent: deps.agent,
              source,
              now,
              reversible: false,
              reason: `snapshot-restore-failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            }),
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
      return {
        row: makeRollbackRow({
          agent: deps.agent,
          source,
          now,
          reversible: true,
          reason: `restored pre-change snapshot to ${target}`,
        }),
        error: null,
      };
    }

    // mcp-credential-drift / tool-permission-gap / cron-session-not-mirrored
    // — apply was audit-only; emit a matching audit-only rollback row.
    return {
      row: makeRollbackRow({
        agent: deps.agent,
        source,
        now,
        reversible: false,
        reason: `audit-only: source destructive apply was audit-only (kind=${source.kind})`,
      }),
      error: null,
    };
  }

  // Other actions (reject-destructive, rollback, skip-verify) are not
  // candidates for rollback. The filter step above should never feed them
  // here, but be defensive: emit an audit row and surface no error.
  return {
    row: makeRollbackRow({
      agent: deps.agent,
      source,
      now,
      reversible: false,
      reason: `not-a-rollback-candidate: action=${source.action}`,
    }),
    error: null,
  };
}

/**
 * Run one full LIFO rewind. Reads the ledger once, filters by agent +
 * timestamp + already-rewound, sorts newest-first, and reverses each
 * row sequentially. Errors per row are accumulated; the loop continues
 * (a partial rewind still surfaces the partial-success count).
 */
export async function runRollbackEngine(
  deps: RollbackEngineDeps,
): Promise<RollbackEngineResult> {
  const allRows = await readCutoverRows(deps.ledgerPath, deps.log);
  const ledgerToMs = Date.parse(deps.ledgerTo);
  if (Number.isNaN(ledgerToMs)) {
    return {
      rewoundCount: 0,
      skippedAlreadyRewound: 0,
      skippedIrreversible: 0,
      errors: [
        {
          row: 0,
          originalTimestamp: deps.ledgerTo,
          originalKind: "(invalid-ledgerTo)",
          originalIdentifier: "",
          error: `ledgerTo is not a valid ISO 8601 timestamp: ${deps.ledgerTo}`,
        },
      ],
    };
  }

  // Filter to apply rows for this agent newer than ledgerTo.
  const applyKinds = new Set(["apply-additive", "apply-destructive"]);
  const candidates = allRows
    .map((r, idx) => ({ row: r, lineNumber: idx + 1 }))
    .filter(
      ({ row }) =>
        row.agent === deps.agent &&
        applyKinds.has(row.action) &&
        Date.parse(row.timestamp) > ledgerToMs,
    );

  // LIFO: reverse newest-first. Sort by timestamp DESC; preserve original
  // line number for error reporting.
  const sorted = [...candidates].sort(
    (a, b) => Date.parse(b.row.timestamp) - Date.parse(a.row.timestamp),
  );

  let rewoundCount = 0;
  let skippedAlreadyRewound = 0;
  let skippedIrreversible = 0;
  const errors: RollbackErrorEntry[] = [];

  for (const { row: source, lineNumber } of sorted) {
    if (isAlreadyRewound(allRows, source)) {
      skippedAlreadyRewound += 1;
      continue;
    }

    const { row: rollbackRow, error } = await reverseOneRow(deps, source);

    if (!deps.dryRun) {
      try {
        await appendCutoverRow(deps.ledgerPath, rollbackRow, deps.log);
      } catch (err) {
        errors.push({
          row: lineNumber,
          originalTimestamp: source.timestamp,
          originalKind: source.kind,
          originalIdentifier: source.identifier,
          error: `ledger-append-failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        continue;
      }
    }

    if (error !== null) {
      errors.push({
        row: lineNumber,
        originalTimestamp: source.timestamp,
        originalKind: source.kind,
        originalIdentifier: source.identifier,
        error,
      });
    } else if (rollbackRow.reversible) {
      rewoundCount += 1;
    } else {
      skippedIrreversible += 1;
    }
  }

  return {
    rewoundCount,
    skippedAlreadyRewound,
    skippedIrreversible,
    errors,
  };
}
