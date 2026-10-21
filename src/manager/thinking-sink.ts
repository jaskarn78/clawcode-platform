/**
 * Thinking sink — live fan-out of `system/thinking_tokens` progress to whoever
 * is rendering the turn (the Discord bridge's status trail). Phase 999.171.
 *
 * WHY A MODULE-LEVEL REGISTRY. The frames are read by the attributed stream
 * demux, deep below the dispatch path; threading a new callback through the
 * turn dispatcher, session manager and handle would touch every layer. The
 * bridge registers a sink for the turn it is rendering; the demux-side
 * consumer emits into it. Same pattern as `claim-sink.ts`.
 *
 * WHY KEYED BY TURN ID, NOT AGENT (999.171 SC-4). A self-fired turn (cron,
 * poll, subagent relay) streams thinking frames on the same agent. Keyed by
 * agent, those frames would reach — and paint — the renderer of a later
 * daemon turn. Keyed by turn id, a frame only ever reaches the sink of the
 * turn it belongs to.
 *
 * Sinks are swept after THINKING_SINK_TTL_MS in case an unregister is missed
 * (a throw between register and finally); every sink call is isolated so a
 * renderer fault never reaches the stream pump that emits into it.
 *
 * The TTL is a leak backstop only (every normal exit unregisters), so it must
 * never reap a LIVE turn's sink: it is longer than the live-thinking
 * controller's absolute lifetime cap (60 min, the bridge typing heartbeat's
 * TYPING_ABSOLUTE_MAX_MS), whose stop unregisters first. The old 10 min
 * (from registration, swept globally by any register/emit) froze the thinking
 * line on any turn past minute 10 (999.171 REVIEW LO-01).
 */

export type ThinkingTokensEvent = Readonly<{ estimatedTokens: number; at: number }>;

export type ThinkingSink = (ev: ThinkingTokensEvent) => void;

export const THINKING_SINK_TTL_MS = 65 * 60 * 1000;

interface SinkRecord {
  readonly sink: ThinkingSink;
  readonly registeredAt: number;
}

const sinks = new Map<string, SinkRecord[]>();

function sweep(now: number): void {
  for (const [turnId, list] of sinks) {
    const live = list.filter((r) => now - r.registeredAt <= THINKING_SINK_TTL_MS);
    if (live.length === 0) sinks.delete(turnId);
    else if (live.length !== list.length) sinks.set(turnId, live);
  }
}

/** Register a sink for `turnId`. Returns the (idempotent) unregister function. */
export function registerThinkingSink(
  turnId: string,
  sink: ThinkingSink,
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

function isValidTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Deliver a thinking-progress event to every live sink for its turn.
 * Returns the number of sinks that received it. Never throws; an invalid
 * token count (NaN, negative, Infinity, non-number) delivers nothing.
 */
export function emitThinkingTokens(
  turnId: string,
  input: { readonly estimatedTokens: number },
  now: number = Date.now(),
): number {
  sweep(now);
  const estimatedTokens = (input as { estimatedTokens?: unknown } | null | undefined)?.estimatedTokens;
  if (!isValidTokenCount(estimatedTokens)) return 0;
  const list = sinks.get(turnId);
  if (!list) return 0;
  const ev: ThinkingTokensEvent = Object.freeze({ estimatedTokens, at: now });
  let delivered = 0;
  for (const { sink } of list) {
    try {
      sink(ev);
      delivered++;
    } catch {
      // A renderer fault must never reach the stream pump.
    }
  }
  return delivered;
}

/** True when at least one sink is registered for the turn (tests / diagnostics). */
export function hasThinkingSink(turnId: string): boolean {
  return (sinks.get(turnId)?.length ?? 0) > 0;
}

/** Test helper — drop every sink. */
export function resetThinkingSinksForTests(): void {
  sinks.clear();
}
