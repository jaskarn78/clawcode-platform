/**
 * Phase 92 Plan 04 — Button-handler dispatcher (D-06 + D-07).
 *
 * Routes admin-clawdy ButtonInteraction → outcome:
 *   - Accept: invoke applyDestructiveFix → on success return accepted-applied;
 *             on failure append audit row + return accepted-apply-failed
 *   - Reject: append reject-destructive ledger row → return rejected
 *   - Defer:  no-op (no ledger row, no mutation) → return deferred
 *
 * This is a PURE dispatcher — it does NOT call interaction.reply/editReply/
 * deferUpdate. The caller (slash-commands.ts inline handler OR daemon IPC
 * handler) is responsible for the Discord-side acknowledgement; this module
 * stays interaction-shape-agnostic so it can be invoked from BOTH the
 * Discord collector path AND the daemon IPC path.
 *
 * Customer-id parsing is collision-safe (D2 regression test): non-cutover-
 * prefix customIds return outcome.kind === "invalid-customId" with no side
 * effects.
 */
import {
  parseCutoverButtonCustomId,
  type CutoverLedgerRow,
  type DestructiveButtonOutcome,
  type DestructiveCutoverGap,
} from "./types.js";
import { appendCutoverRow } from "./ledger.js";
import {
  applyDestructiveFix,
  type DestructiveApplierDeps,
} from "./destructive-applier.js";
import type { Logger } from "pino";

/**
 * DI surface for handleCutoverButtonInteraction. The slash-commands.ts inline
 * handler / daemon IPC handler both wire this from production primitives;
 * tests inject vi.fn() stubs for gapById.
 */
export type ButtonHandlerDeps = {
  /**
   * Mirror of DestructiveApplierDeps; passed through to applyDestructiveFix
   * on Accept. The handler does NOT mutate this object.
   */
  readonly applierDeps: DestructiveApplierDeps;
  /**
   * Resolves a (agent, gapId) tuple back to the typed DestructiveCutoverGap.
   * Production uses an in-memory cache populated at embed-render time, OR
   * re-derives from the latest CUTOVER-GAPS.json. Returns null when the gap
   * is not found (unknown gapId, stale interaction after verify rerun, etc.).
   */
  readonly gapById: (
    agent: string,
    gapId: string,
  ) => Promise<DestructiveCutoverGap | null>;
  readonly log: Logger;
};

/**
 * Minimal ButtonInteraction shape this handler depends on. Structural type so
 * tests can inject `{customId, user}` without a full discord.js mock.
 */
export type ButtonInteractionLike = {
  readonly customId: string;
  readonly user: { readonly id: string };
};

/**
 * Dispatch a destructive-fix button interaction. See module docstring for
 * the full semantics. Pure async; throws only if the ledger write throws on
 * Reject (which validates the row before fs touch — schema-invalid throw).
 */
export async function handleCutoverButtonInteraction(
  interaction: ButtonInteractionLike,
  deps: ButtonHandlerDeps,
): Promise<DestructiveButtonOutcome> {
  const parsed = parseCutoverButtonCustomId(interaction.customId);
  if (!parsed) {
    return { kind: "invalid-customId", customId: interaction.customId };
  }

  const gap = await deps.gapById(parsed.agent, parsed.gapId);
  if (!gap) {
    deps.log.warn(
      { agent: parsed.agent, gapId: parsed.gapId },
      "cutover button-handler: gap not found for customId; treating as invalid",
    );
    return { kind: "invalid-customId", customId: interaction.customId };
  }

  const start = new Date();

  switch (parsed.action) {
    case "accept": {
      const result = await applyDestructiveFix(deps.applierDeps, gap);
      if (result.kind === "failed") {
        // Audit failed apply: log a destructive-attempt row with the reason
        // so operators can see the attempt in the audit trail.
        const failRow: CutoverLedgerRow = {
          timestamp: start.toISOString(),
          agent: parsed.agent,
          action: "apply-destructive",
          kind: gap.kind,
          identifier: gap.identifier,
          sourceHash: null,
          targetHash: null,
          reversible: false,
          rolledBack: false,
          preChangeSnapshot: null,
          reason: `failed: ${result.error.slice(0, 200)}`,
        };
        try {
          await appendCutoverRow(
            deps.applierDeps.ledgerPath,
            failRow,
            deps.log,
          );
        } catch (err) {
          deps.log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "cutover button-handler: failed-apply audit row could not be appended",
          );
        }
        return {
          kind: "accepted-apply-failed",
          agent: parsed.agent,
          gapKind: gap.kind,
          identifier: gap.identifier,
          error: result.error,
        };
      }
      return {
        kind: "accepted-applied",
        agent: parsed.agent,
        gapKind: gap.kind,
        identifier: gap.identifier,
        ledgerRow: result.row,
      };
    }
    case "reject": {
      const row: CutoverLedgerRow = {
        timestamp: start.toISOString(),
        agent: parsed.agent,
        action: "reject-destructive",
        kind: gap.kind,
        identifier: gap.identifier,
        sourceHash: null,
        targetHash: null,
        reversible: true,
        rolledBack: false,
        preChangeSnapshot: null,
        reason: "operator-rejected",
      };
      await appendCutoverRow(deps.applierDeps.ledgerPath, row, deps.log);
      return {
        kind: "rejected",
        agent: parsed.agent,
        gapKind: gap.kind,
        identifier: gap.identifier,
        ledgerRow: row,
      };
    }
    case "defer":
      // No-op: re-running verify re-surfaces the gap. Log for visibility.
      deps.log.info(
        { agent: parsed.agent, gapKind: gap.kind, identifier: gap.identifier },
        "cutover button-handler: deferred (no ledger row)",
      );
      return {
        kind: "deferred",
        agent: parsed.agent,
        gapKind: gap.kind,
        identifier: gap.identifier,
      };
  }
}
