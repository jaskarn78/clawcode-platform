/**
 * `verify-claim` IPC arm — the daemon side of the `verify_claim` MCP tool.
 *
 * Owns exactly: param validation (zod), routing to the agent's ACTIVE turn on
 * the trace collector (which validates the claim against the evidence ledger),
 * live fan-out to renderers (claim sink), and the reply the model reads —
 * including the hint when a claim was downgraded. Exported as a function with
 * injected deps so it is unit-testable without a daemon.
 */
import { z } from "zod/v4";
import type { Logger } from "pino";

import { emitClaim } from "./claim-sink.js";
import { hintFor, type ClaimEntry, type ValidateClaimOptions } from "./claim-ledger.js";
import type { EvidenceEntry } from "./evidence-ledger.js";

export const verifyClaimParamsSchema = z.object({
  agent: z.string().min(1).max(128),
  claim: z.string().min(3).max(300),
  verdict: z.enum(["verified", "corrected", "unverified", "not-a-claim"]),
  source: z.string().max(512).optional(),
  quote: z.string().max(300).optional(),
  correction: z.string().max(300).optional(),
  class: z.enum(["figure", "rule", "product-term"]).optional(),
  audience: z.enum(["internal", "client"]).optional(),
});
export type VerifyClaimIpcParams = z.infer<typeof verifyClaimParamsSchema>;

export interface VerifyClaimDeps {
  readonly recordClaimForActiveTurn: (
    agent: string,
    params: Omit<VerifyClaimIpcParams, "agent">,
    opts?: ValidateClaimOptions,
  ) => ClaimEntry | null;
  readonly getActiveTurnEvidence: (agent: string) => readonly EvidenceEntry[];
  readonly options?: ValidateClaimOptions;
  readonly log?: Pick<Logger, "info" | "warn">;
}

export type VerifyClaimResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly effectiveVerdict: ClaimEntry["effectiveVerdict"];
      readonly sourceStatus: ClaimEntry["sourceStatus"];
      readonly quoteStatus: ClaimEntry["quoteStatus"];
      readonly hint?: string;
    }
  | { readonly ok: false; readonly reason: "invalid-params" | "no-active-turn"; readonly detail?: string };

export function handleVerifyClaim(deps: VerifyClaimDeps, rawParams: unknown): VerifyClaimResult {
  const parsed = verifyClaimParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    return { ok: false, reason: "invalid-params", detail: parsed.error.issues.map((i) => i.message).join("; ").slice(0, 300) };
  }
  const { agent, ...params } = parsed.data;
  const entry = deps.recordClaimForActiveTurn(agent, params, deps.options);
  if (!entry) return { ok: false, reason: "no-active-turn" };
  emitClaim(entry.turnId, entry);
  const hint = hintFor(entry, deps.getActiveTurnEvidence(agent));
  deps.log?.info(
    {
      tag: "phase999.63-claim",
      agent,
      turnId: entry.turnId,
      claimId: entry.id,
      verdict: entry.verdict,
      effectiveVerdict: entry.effectiveVerdict,
      sourceStatus: entry.sourceStatus,
      sourceTier: entry.sourceTier,
      quoteStatus: entry.quoteStatus,
      class: entry.class,
      audience: entry.audience,
      origin: entry.origin,
    },
    "verify_claim recorded",
  );
  return {
    ok: true,
    id: entry.id,
    effectiveVerdict: entry.effectiveVerdict,
    sourceStatus: entry.sourceStatus,
    quoteStatus: entry.quoteStatus,
    ...(hint ? { hint } : {}),
  };
}

/** The text the model reads back from the tool. */
export function renderVerifyClaimReply(result: VerifyClaimResult): string {
  if (!result.ok) {
    if (result.reason === "no-active-turn") {
      return "verify_claim: no active turn to attach this claim to (recorded nowhere). Continue; state the claim as unverified if you could not confirm it.";
    }
    return `verify_claim: invalid parameters (${result.detail ?? "see schema"}). Continue.`;
  }
  const head = `verify_claim ${result.id}: recorded as ${result.effectiveVerdict} (source ${result.sourceStatus}${result.quoteStatus !== "none" ? `, quote ${result.quoteStatus}` : ""}).`;
  return result.hint ? `${head} ${result.hint}` : head;
}
