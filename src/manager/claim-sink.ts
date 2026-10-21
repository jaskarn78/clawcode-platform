/**
 * Claim sink — live fan-out of `verify_claim` records to whoever is rendering
 * the turn (the Discord bridge's activity trail).
 *
 * WHY A MODULE-LEVEL REGISTRY. The tool call reaches the daemon over IPC, not
 * through the session handle, so there is no `onToolUse`-style callback on
 * the dispatch path to ride. The bridge registers a sink for the turn it is
 * rendering; the daemon arm emits into it. Keyed by TURN id, not agent: the
 * post-hoc corrective hop fires after the bridge closure's `finally` and a
 * later turn for the same agent could otherwise receive a stale claim.
 *
 * Sinks are swept after CLAIM_SINK_TTL_MS in case an unregister is missed
 * (a throw between register and finally); every sink call is isolated so a
 * renderer fault never reaches the recorder.
 */

import type { ClaimEntry } from "./claim-ledger.js";

export type ClaimSink = (entry: ClaimEntry) => void;

export const CLAIM_SINK_TTL_MS = 10 * 60 * 1000;

interface SinkRecord {
  readonly sink: ClaimSink;
  readonly registeredAt: number;
}

const sinks = new Map<string, SinkRecord[]>();

function sweep(now: number): void {
  for (const [turnId, list] of sinks) {
    const live = list.filter((r) => now - r.registeredAt <= CLAIM_SINK_TTL_MS);
    if (live.length === 0) sinks.delete(turnId);
    else if (live.length !== list.length) sinks.set(turnId, live);
  }
}

/** Register a sink for `turnId`. Returns the unregister function. */
export function registerClaimSink(
  turnId: string,
  sink: ClaimSink,
  now: number = Date.now(),
): () => void {
  sweep(now);
  const rec: SinkRecord = { sink, registeredAt: now };
  const list = sinks.get(turnId) ?? [];
  sinks.set(turnId, [...list, rec]);
  return () => {
    const cur = sinks.get(turnId);
    if (!cur) return;
    const next = cur.filter((r) => r !== rec);
    if (next.length === 0) sinks.delete(turnId);
    else sinks.set(turnId, next);
  };
}

/** Deliver a claim to every live sink for its turn. Never throws. */
export function emitClaim(turnId: string, entry: ClaimEntry, now: number = Date.now()): number {
  sweep(now);
  const list = sinks.get(turnId);
  if (!list) return 0;
  let delivered = 0;
  for (const { sink } of list) {
    try {
      sink(entry);
      delivered++;
    } catch {
      // A renderer fault must never reach the recorder.
    }
  }
  return delivered;
}

/** True when at least one sink is registered for the turn (tests / diagnostics). */
export function hasClaimSink(turnId: string): boolean {
  return (sinks.get(turnId)?.length ?? 0) > 0;
}

/** Test helper — drop every sink. */
export function resetClaimSinksForTests(): void {
  sinks.clear();
}
