/**
 * Phase 92 Plan 04 — Destructive-fix applier (D-06 + D-07 + D-10).
 *
 * Per-kind dispatcher invoked from the button-handler on Accept.
 * Captures preChangeSnapshot BEFORE any mutation (D-10 reversibility hook).
 *
 * Invariants:
 *   - Snapshot capture order: capture → apply → ledger row. Never capture
 *     after apply (would record post-mutation content).
 *   - Files ≤ 64KB: snapshot is gzip+base64; reversible: true.
 *   - Files > 64KB: snapshot is null; reversible: false; reason field
 *     marks "irreversible-without-backup" (D-10).
 *   - mcp-credential-drift: NEVER auto-rewrites credentials (per D-06,
 *     credential rotation is operator-driven via /clawcode-plugins-browse).
 *     The applier records the operator's accept decision in the ledger;
 *     the actual op:// rotation is out of scope.
 *   - tool-permission-gap: First-pass logs the operator decision; ACL
 *     writer wiring deferred to a future plan.
 *   - cron-session-not-mirrored: First-pass logs the operator decision;
 *     schedule/skill/tool wiring deferred to a future plan.
 *
 * Mirrors Plan 92-03's AdditiveApplierDeps DI shape (one structural
 * difference: the `apply` boolean is absent because admin-clawdy Accept
 * IS the gate).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import type { Logger } from "pino";
import { resolve as resolvePath } from "node:path";
import {
  type CutoverLedgerRow,
  type DestructiveCutoverGap,
  assertNever,
} from "./types.js";
import { appendCutoverRow } from "./ledger.js";

/**
 * Files larger than this skip snapshot capture (D-10) — gz+b64 of >64KB
 * files would balloon the ledger; reason field tagged "irreversible-without-
 * backup" so rollback CLI can warn.
 */
export const SNAPSHOT_MAX_BYTES = 64 * 1024;

/** Result of an rsync invocation, normalized for DI. */
export type RsyncResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

/**
 * DI surface for the destructive applier. Production wiring lives in the
 * slash-commands.ts inline handler (which constructs the deps from the
 * daemon's Phase 91 rsync runner + Plan 92-02 probe paths). Tests inject
 * vi.fn() stubs.
 */
export type DestructiveApplierDeps = {
  readonly agent: string;
  readonly clawcodeYamlPath: string;
  readonly memoryRoot: string;
  readonly openClawHost: string;
  readonly openClawWorkspace: string;
  readonly ledgerPath: string;
  readonly runRsync: (args: readonly string[]) => Promise<RsyncResult>;
  readonly now?: () => Date;
  readonly log: Logger;
};

/** Result of one applyDestructiveFix invocation. */
export type DestructiveApplyResult =
  | { kind: "applied"; row: CutoverLedgerRow }
  | { kind: "failed"; error: string };

/**
 * Apply ONE destructive cutover gap. Called by the button-handler on Accept.
 *
 * Snapshot-capture order is fixed: read existing target → apply mutation →
 * append ledger row. The snapshot is captured BEFORE the mutation so the
 * ledger row records the pre-apply content (D-10 reversibility hook).
 *
 * For non-file gaps (mcp-credential-drift, tool-permission-gap,
 * cron-session-not-mirrored), the applier emits an audit-only ledger row
 * recording the operator's accept decision (per D-06 propose-and-confirm).
 *
 * Exhaustive switch over the 4 destructive kinds (D-04 + D-11). Adding a
 * 5th destructive kind without a corresponding case fails the TypeScript
 * build via assertNever in the default branch.
 */
export async function applyDestructiveFix(
  deps: DestructiveApplierDeps,
  gap: DestructiveCutoverGap,
): Promise<DestructiveApplyResult> {
  const start = (deps.now ?? (() => new Date()))();

  try {
    switch (gap.kind) {
      case "outdated-memory-file":
        return await applyOutdatedMemoryFile(deps, gap, start);
      case "mcp-credential-drift":
        return await applyMcpCredentialDriftAudit(deps, gap, start);
      case "tool-permission-gap":
        return await applyToolPermissionGapAudit(deps, gap, start);
      case "cron-session-not-mirrored":
        return await applyCronSessionAudit(deps, gap, start);
      default:
        assertNever(gap);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "failed", error: msg };
  }
}

/**
 * outdated-memory-file: rsync OpenClaw → ClawCode with pre-change snapshot.
 *
 * Order:
 *   1. resolve absolute target path under deps.memoryRoot
 *   2. capture pre-change snapshot (gz+b64 if ≤64KB; null + irreversible flag otherwise)
 *   3. rsync via deps.runRsync
 *   4. compute post-apply targetHash
 *   5. append ledger row with action="apply-destructive"
 *
 * Snapshot capture HARD-FAILS-OPEN if the target file doesn't exist (the
 * apply will create it; nothing to snapshot). In that case snapshotB64 is
 * null and reversible is false (rollback would mean deleting the file —
 * future enhancement).
 */
async function applyOutdatedMemoryFile(
  deps: DestructiveApplierDeps,
  gap: Extract<DestructiveCutoverGap, { kind: "outdated-memory-file" }>,
  start: Date,
): Promise<DestructiveApplyResult> {
  // gap.targetRef.path is relative to memoryRoot — resolve to absolute.
  const targetAbsPath = resolvePath(deps.memoryRoot, gap.targetRef.path);

  // Step 1: Capture preChangeSnapshot BEFORE any mutation (D-10 invariant).
  let snapshotB64: string | null = null;
  let preChangeReason: string | null = null;
  let reversible = false;

  try {
    const buf = await readFile(targetAbsPath);
    if (buf.byteLength <= SNAPSHOT_MAX_BYTES) {
      snapshotB64 = gzipSync(buf).toString("base64");
      reversible = true;
    } else {
      preChangeReason = "irreversible-without-backup";
      reversible = false;
    }
  } catch (err) {
    // Target missing — apply will create it; nothing to snapshot.
    deps.log.debug(
      { path: targetAbsPath, err: err instanceof Error ? err.message : String(err) },
      "destructive-applier: target missing pre-apply (no snapshot to capture)",
    );
  }

  // Step 2: Apply via rsync.
  const sourcePath = `${deps.openClawHost}:${gap.sourceRef.path}`;
  const rsyncResult = await deps.runRsync([
    "-av",
    "-e",
    "ssh -o BatchMode=yes -o ConnectTimeout=10",
    sourcePath,
    targetAbsPath,
  ]);
  if (rsyncResult.exitCode !== 0) {
    return {
      kind: "failed",
      error: `rsync exit ${rsyncResult.exitCode}: ${rsyncResult.stderr.slice(0, 4000)}`,
    };
  }

  // Step 3: Compute post-apply targetHash for the ledger row.
  let targetHash: string | null = null;
  try {
    const newBuf = await readFile(targetAbsPath);
    targetHash = createHash("sha256").update(newBuf).digest("hex");
  } catch {
    // Could not read post-apply (unexpected — rsync just succeeded). Fall
    // through with null targetHash; the ledger row still records the
    // operator's accept + sourceHash for partial audit value.
  }

  const row: CutoverLedgerRow = {
    timestamp: start.toISOString(),
    agent: deps.agent,
    action: "apply-destructive",
    kind: gap.kind,
    identifier: gap.identifier,
    sourceHash: gap.sourceRef.sourceHash,
    targetHash,
    reversible,
    rolledBack: false,
    preChangeSnapshot: snapshotB64,
    reason: preChangeReason,
  };
  await appendCutoverRow(deps.ledgerPath, row, deps.log);
  return { kind: "applied", row };
}

/**
 * mcp-credential-drift: audit-only ledger row.
 *
 * Per D-06, credential rotation is operator-driven via /clawcode-plugins-browse.
 * The applier records the operator's accept decision so the audit trail captures
 * the intent; the actual op:// rotation happens through the existing plugin-install
 * flow.
 */
async function applyMcpCredentialDriftAudit(
  deps: DestructiveApplierDeps,
  gap: Extract<DestructiveCutoverGap, { kind: "mcp-credential-drift" }>,
  start: Date,
): Promise<DestructiveApplyResult> {
  const row: CutoverLedgerRow = {
    timestamp: start.toISOString(),
    agent: deps.agent,
    action: "apply-destructive",
    kind: gap.kind,
    identifier: gap.identifier,
    sourceHash: null,
    targetHash: null,
    reversible: false,
    rolledBack: false,
    preChangeSnapshot: null,
    reason:
      "operator-confirmed-credential-drift; manual op:// update required in clawcode.yaml",
  };
  await appendCutoverRow(deps.ledgerPath, row, deps.log);
  return { kind: "applied", row };
}

/**
 * tool-permission-gap: audit-only ledger row. ACL writer wiring deferred.
 */
async function applyToolPermissionGapAudit(
  deps: DestructiveApplierDeps,
  gap: Extract<DestructiveCutoverGap, { kind: "tool-permission-gap" }>,
  start: Date,
): Promise<DestructiveApplyResult> {
  const row: CutoverLedgerRow = {
    timestamp: start.toISOString(),
    agent: deps.agent,
    action: "apply-destructive",
    kind: gap.kind,
    identifier: gap.identifier,
    sourceHash: null,
    targetHash: null,
    reversible: false,
    rolledBack: false,
    preChangeSnapshot: null,
    reason: "operator-confirmed-tool-permission-gap; ACL writer wiring deferred",
  };
  await appendCutoverRow(deps.ledgerPath, row, deps.log);
  return { kind: "applied", row };
}

/**
 * cron-session-not-mirrored (D-11): audit-only ledger row. Schedule+skill+tool
 * wiring deferred.
 */
async function applyCronSessionAudit(
  deps: DestructiveApplierDeps,
  gap: Extract<DestructiveCutoverGap, { kind: "cron-session-not-mirrored" }>,
  start: Date,
): Promise<DestructiveApplyResult> {
  const row: CutoverLedgerRow = {
    timestamp: start.toISOString(),
    agent: deps.agent,
    action: "apply-destructive",
    kind: gap.kind,
    identifier: gap.identifier,
    sourceHash: null,
    targetHash: null,
    reversible: false,
    rolledBack: false,
    preChangeSnapshot: null,
    reason:
      "operator-confirmed-cron-session-not-mirrored; cron wiring deferred to future plan",
  };
  await appendCutoverRow(deps.ledgerPath, row, deps.log);
  return { kind: "applied", row };
}
