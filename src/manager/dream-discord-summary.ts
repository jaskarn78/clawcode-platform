/**
 * Phase 115 Plan 05 T02 — D-11 Discord summary builder for dream-pass.
 *
 * Builds the structured Discord post per CONTEXT.md D-11 verbatim:
 *
 *   [dream-pass priority] Tier 1 over cap — proposed compaction:
 *   - ADD: <new entry title> (priorityScore=<N>) [auto-apply in 30m]
 *   - EDIT: <existing entry> ← merge with <chunk> [veto-required]
 *   - MERGE: <file A> + <file B> → <file C> [veto-required]
 *
 *   Veto: react with ❌, or `clawcode-memory-veto <run_id>`. Approve all: ✅.
 *
 * Falls back to plain text when the Discord embed budget would exceed
 * 6000 chars (Discord's hard embed limit). The 6000-char cap is a
 * pre-truncation guard: if the rendered text exceeds 6000 chars, we
 * truncate the per-row enumeration with a "... +N more" tail.
 */

import type { DreamResult } from "./dream-pass.js";

/** Discord embed body hard cap per Discord's API. */
export const DISCORD_EMBED_BUDGET_CHARS = 6000;

export interface PromotionForSummary {
  readonly chunkId: string;
  readonly currentPath: string;
  readonly priorityScore: number;
  readonly action?: "add" | "edit" | "merge";
  readonly targetMode?: "append" | "overwrite";
}

export interface ConsolidationForSummary {
  readonly sources: readonly string[];
  readonly newPath: string;
}

export interface PromotionSummaryInput {
  readonly runId: string;
  readonly agentName: string;
  /** Auto-apply candidates (D-10 Row 2 + Row 5) — listed with [auto-apply in 30m]. */
  readonly autoApplyCandidates: readonly PromotionForSummary[];
  /** Operator-required candidates (D-10 Row 3) — listed with [veto-required]. */
  readonly operatorRequiredCandidates: readonly PromotionForSummary[];
  /** D-10 Row 4 — file merges always operator-required. */
  readonly consolidations: readonly ConsolidationForSummary[];
  readonly isPriorityPass: boolean;
}

/**
 * Build the D-11 Discord summary text. The output is a single string —
 * the daemon-edge wiring chooses whether to emit as embed body or plain
 * message based on Discord channel context.
 *
 * Truncation: when the assembled text exceeds DISCORD_EMBED_BUDGET_CHARS
 * we truncate the per-row enumeration (newest items kept) and append
 * "...\n+N more". The veto contract footer is ALWAYS preserved.
 */
export function buildPromotionSummary(input: PromotionSummaryInput): string {
  const header = input.isPriorityPass
    ? `[dream-pass priority] Tier 1 over cap — proposed compaction (agent ${input.agentName}, run ${input.runId}):`
    : `[dream-pass] Promotion candidates (agent ${input.agentName}, run ${input.runId}):`;

  // Phase 999.188 — name the controls that exist. The ❌ / ✅ reaction
  // contract was never wired; the slash command and the dashboard are.
  const footer =
    `\n\nVeto: \`/clawcode-dream action:veto run:${input.runId}\` · ` +
    `Approve now: \`/clawcode-dream action:approve run:${input.runId}\` · ` +
    `or the dashboard Memory view. Unvetoed rows apply when the window closes.`;

  // Render the per-row enumeration in three sections.
  const rows: string[] = [];

  for (const c of input.autoApplyCandidates) {
    const verb =
      c.action === "edit" ? "EDIT" :
      c.action === "merge" ? "MERGE" :
      "ADD";
    const target =
      c.targetMode === "overwrite" ? "→ overwrite" : "→ append";
    rows.push(
      `- ${verb}: ${c.currentPath} (priorityScore=${c.priorityScore}) ` +
        `${target} [auto-apply in 30m]`,
    );
  }

  for (const c of input.operatorRequiredCandidates) {
    const verb =
      c.action === "edit" ? "EDIT" :
      c.action === "merge" ? "MERGE" :
      "ADD";
    rows.push(
      `- ${verb}: ${c.currentPath} (priorityScore=${c.priorityScore}) [veto-required]`,
    );
  }

  for (const c of input.consolidations) {
    const sources = c.sources.join(" + ");
    rows.push(`- MERGE: ${sources} → ${c.newPath} [veto-required]`);
  }

  // Assemble + truncate to budget.
  const fullBody = header + "\n" + rows.join("\n") + footer;
  if (fullBody.length <= DISCORD_EMBED_BUDGET_CHARS) {
    return fullBody;
  }

  // Over budget — truncate rows. Reserve room for header + footer + ellipsis.
  const reservation = header.length + footer.length + 64;
  const rowBudget = DISCORD_EMBED_BUDGET_CHARS - reservation;
  let used = 0;
  const kept: string[] = [];
  for (const row of rows) {
    if (used + row.length + 1 > rowBudget) break;
    kept.push(row);
    used += row.length + 1;
  }
  const dropped = rows.length - kept.length;
  const tail = `\n... +${dropped} more`;
  return header + "\n" + kept.join("\n") + tail + footer;
}

/**
 * Convenience helper — extract the promotion summary inputs straight from
 * a DreamResult + a runId + an agent. Used by applyDreamResult to keep
 * the call site one-liner.
 */
export function buildPromotionSummaryFromDream(
  agentName: string,
  runId: string,
  result: DreamResult,
  autoApplyCandidates: readonly PromotionForSummary[],
  operatorRequiredCandidates: readonly PromotionForSummary[],
  isPriorityPass: boolean,
): string {
  return buildPromotionSummary({
    runId,
    agentName,
    autoApplyCandidates,
    operatorRequiredCandidates,
    consolidations: result.suggestedConsolidations.map((c) => ({
      sources: c.sources,
      newPath: c.newPath,
    })),
    isPriorityPass,
  });
}
